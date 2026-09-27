import type { AgentEvent, CumulativeUsage, PermissionRequest, RunResult, StopReason } from '../types/events';
import type { AssistantMessage, ContentBlock, Message, ToolCallPart, ToolMessage, Usage } from '../types/messages';
import { SUMMARY_PREAMBLE, toBlocks } from '../types/messages';
import type { ChatRequest, Provider } from '../types/provider';
import type { Tool, ToolContext } from '../types/tools';
import { ToolRegistry, parseToolArgs, validateArgs } from '../tools/registry';
import { PermissionEngine, applyResponseToRules, type PermissionSubject } from './permission';
import { HookRunner } from './hooks';
import { ContextManager } from './compaction';
import { toLlmMessages } from './convert';
import { shouldStop, type StopCondition } from './stop';
import type { BudgetLedger } from './budget';
import type { PromptInjector, ResolvedInjection } from './inject';
import { digestArgs, type AuditSink } from './audit';
import type { Sandbox } from '../types/tools';
import type { Logger } from '../types/tools';
import {
  AbortedError,
  ContextOverflowError,
  InvalidToolArgsError,
  NosieError,
  OutputLengthError,
  PermissionDeniedError,
  ToolExecutionError,
  ToolNotFoundError,
  serializeError,
  isAbortError,
} from '../types/errors';
import { newId } from '../utils';

export interface LoopHooks {
  emit(event: AgentEvent): void;
  appendMessages(messages: Message[]): Promise<void>;
  appendCompaction(entry: import('../types/messages').CompactionEntry): Promise<void>;
  markCleared(ids: Set<string>): Promise<void>;
  history(): Message[];
  replaceHistory(messages: Message[]): Promise<void>;
}

export interface LoopDeps {
  provider: Provider;
  model: string;
  registry: ToolRegistry;
  permission: PermissionEngine;
  hooks: HookRunner;
  context: ContextManager;
  systemPrompt: () => string | Promise<string>;
  sandbox: Sandbox;
  workspaceRoot: string;
  sessionId: string;
  services: ToolContext['services'];
  logger: Logger;
  maxSteps: number;
  /** Shared with every subagent of this tree; absent means unlimited. */
  budget?: BudgetLedger;
  stopWhen?: StopCondition | StopCondition[];
  toolExecution: 'parallel' | 'sequential';
  temperature?: number;
  maxTokens?: number;
  echoReasoning: boolean;
  queues: { steer: ContentBlock[][]; followUp: ContentBlock[][] };
  hooksCtxSignal: () => AbortSignal;
  onPermissionResolved?: (request: PermissionRequest, optionId: string) => void;
  /** Receives one record per call the permission pipeline ruled on. */
  audit?: AuditSink;
  /** Forced prompts, spliced into every request after the context hooks run. */
  injector?: PromptInjector;
}

const MAX_STEPS_PROMPT =
  'You have reached the step limit for this run. Do not call any more tools. Summarize what you accomplished, what is still pending, and the exact next step.';

/**
 * The wrap-up allowance for the *tree* budget. Worded as a stop, not a nudge:
 * the model must understand that delegating further is not available, or it
 * spends the one call it was given asking for another subagent.
 */
const BUDGET_WRAP_UP_PROMPT =
  'The budget for this agent tree is exhausted: no further tool calls or subagents will be granted. Do not call any tools. Give your best final answer from what you already have, and name anything you could not complete.';

interface PendingCall {
  index: number;
  id: string;
  name: string;
  rawArgs: string;
  part?: ToolCallPart;
}

interface StepOutcome {
  message: AssistantMessage;
  calls: PendingCall[];
  usage?: Usage;
  finish: import('../types/messages').FinishReason;
}

export class Runner {
  private cumulative: CumulativeUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
  private aborted = false;
  /** One `image_dropped` warning per run, not per step. */
  private imageWarned = false;

  constructor(private deps: LoopHooks & LoopDeps) {}

  resetUsage(): void {
    this.cumulative = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
  }

  async run(input: ContentBlock[], externalSignal?: AbortSignal): Promise<RunResult> {
    const runId = newId('run');
    const controller = new AbortController();
    const onExternalAbort = () => {
      this.aborted = true;
      controller.abort(new AbortedError('Run cancelled'));
    };
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const signal = controller.signal;
    this.imageWarned = false;
    const hookCtx = { sessionId: this.deps.sessionId, runId, signal };
    const steps: AssistantMessage[] = [];
    let stopReason: StopReason = 'end_turn';
    let fatal: unknown;

    this.deps.emit({ type: 'run_start', runId, sessionId: this.deps.sessionId });

    try {
      const blocks = await this.deps.hooks.userPromptSubmit(input, hookCtx);
      await this.deps.appendMessages([mkUserMessage(blocks)]);

      let step = 0;
      let wrapUpInjected = false;
      let budgetWrapUpInjected = false;

      while (true) {
        step++;

        // The tree budget is checked before anything is spent, and it is the
        // shared ledger that speaks here: a single loop staying inside its
        // `maxSteps` means nothing if four subagents each burned a million
        // tokens. Stop the tree, not just this branch.
        const overBudget = this.deps.budget?.check();
        if (overBudget) {
          const ledger = this.deps.budget!;
          // Nothing spent yet means nothing to wrap up — a request just to
          // explain the empty purse is the one thing a budget should prevent.
          // Otherwise take the same one-call allowance `maxSteps` gives, so the
          // host receives an answer built from what already ran instead of ''.
          if (step === 1 || budgetWrapUpInjected) {
            this.deps.logger.warn(`agent tree budget exhausted (${overBudget.dimension})`);
            this.deps.emit({ type: 'warning', code: 'budget_exhausted', message: `Stopping the run: ${ledger.describe(overBudget)}.`, details: overBudget });
            stopReason = 'budget';
            break;
          }
          budgetWrapUpInjected = true;
          this.deps.emit({ type: 'warning', code: 'budget_exhausted', message: `Tree budget reached (${ledger.describe(overBudget)}); asking for a final answer without tools.`, details: overBudget });
          await this.deps.appendMessages([mkSystemMessage(BUDGET_WRAP_UP_PROMPT)]);
        }

        // Drain first so input typed during a long tool call still reaches the
        // model on the next step instead of being dropped.
        const earlySteer = this.deps.queues.steer.splice(0);
        for (const blocks of earlySteer) await this.deps.appendMessages([mkUserMessage(blocks)]);

        if (step > this.deps.maxSteps) {
          step = this.deps.maxSteps;
          if (wrapUpInjected) {
            // The model kept calling tools after the wrap-up request.
            stopReason = 'max_steps';
            break;
          }
          wrapUpInjected = true;
          await this.deps.appendMessages([mkSystemMessage(MAX_STEPS_PROMPT)]);
          this.deps.logger.warn(`maxSteps reached; injecting wrap-up prompt (run ${runId})`);
        }

        this.deps.emit({ type: 'step_start', runId, step });

        if (await shouldStop(this.deps.stopWhen, { step: step - 1, steps, totalTokens: this.cumulative.totalTokens })) {
          stopReason = 'stop_condition';
          break;
        }

        let history = this.deps.history();
        // Resolved once per step and reused below: the budget and the payload have
        // to agree about what is going out, and a dynamic prompt read twice could
        // disagree.
        const injections = await this.resolveInjections(step);
        const injectionCost = this.deps.injector?.cost(injections) ?? 0;
        // Injection cost belongs in the overflow test: these messages are going out
        // with the transcript whether or not the transcript was just trimmed, so a
        // budget that ignores them underestimates every request by their size.
        if (this.deps.context.isOverflow(history, injectionCost)) {
          const compacted = await this.compact(history, signal, false, injectionCost);
          if (compacted) {
            history = this.deps.history();
            this.deps.emit({ type: 'warning', code: 'compacted', message: 'Context compacted before the model call.' });
          }
        }

        let outcome: StepOutcome;
        try {
          outcome = await this.streamStep(history, runId, step, signal, injections);
        } catch (err) {
          if (err instanceof ContextOverflowError) {
            const compacted = await this.compact(this.deps.history(), signal, true, injectionCost);
            if (!compacted) throw err;
            step--;
            continue;
          }
          throw err;
        }

        steps.push(outcome.message);
        this.deps.emit({ type: 'step_end', runId, step, finishReason: outcome.finish, usage: outcome.usage });

        const unanswered = outcome.calls.filter((c) => c.name);
        if (!unanswered.length) {
          const queued = this.deps.queues.followUp.shift();
          if (queued) {
            await this.deps.appendMessages([mkUserMessage(queued)]);
            continue;
          }
          stopReason = outcome.finish === 'length' ? 'max_tokens' : 'end_turn';
          break;
        }

        const steer = this.deps.queues.steer.splice(0);
        if (steer.length) {
          for (const call of unanswered) {
            if (call.part && call.part.status === 'pending') {
              call.part.status = 'cancelled';
              this.deps.emit({ type: 'tool_status', toolCallId: call.id, name: call.name, status: 'cancelled' });
              await this.deps.appendMessages([mkToolMessage(call, 'Cancelled: the user sent a new message before this tool ran.', true, Date.now())]);
            }
          }
          for (const blocks of steer) await this.deps.appendMessages([mkUserMessage(blocks)]);
          continue;
        }

        await this.executeCalls(unanswered, runId, signal);
      }
    } catch (err) {
      if (isAbortError(err) || this.aborted) stopReason = 'cancelled';
      else {
        stopReason = 'error';
        fatal = err;
        this.deps.emit({ type: 'error', error: serializeError(err), fatal: true });
      }
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }

    const lastAssistant = steps[steps.length - 1];
    const result: RunResult = {
      runId,
      stopReason,
      text: (lastAssistant?.parts ?? []).filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : '')).join(''),
      messages: this.deps.history(),
      usage: { ...this.cumulative },
      steps: steps.length,
      ...(fatal ? { error: serializeError(fatal) } : {}),
    };
    try {
      await this.deps.hooks.stop(result, hookCtx);
    } catch (err) {
      this.deps.logger.warn(`Stop hook failed: ${(err as Error).message}`);
    }
    this.deps.emit({ type: 'run_end', runId, stopReason, usage: result.usage, ...(fatal ? { error: serializeError(fatal) } : {}) });
    return result;
  }

  /**
   * A host whose injection function throws gets a failed run, not a run that
   * quietly dropped the policy prompt — silently losing the guarantee is the one
   * outcome this channel cannot produce.
   */
  private async resolveInjections(step: number): Promise<ResolvedInjection[]> {
    if (!this.deps.injector?.size) return [];
    return this.deps.injector.resolve({
      sessionId: this.deps.sessionId,
      step,
      model: this.deps.model,
      permissionMode: this.deps.permission.currentMode,
    });
  }

  private async streamStep(history: Message[], runId: string, step: number, signal: AbortSignal, injections: ResolvedInjection[] = []): Promise<StepOutcome> {
    const messageId = newId('msg');
    const system = await this.deps.systemPrompt();
    const messages: Message[] = [{ id: newId('sys'), role: 'system', createdAt: Date.now(), content: system }, ...history];
    const imageInput = this.deps.provider.capabilities.imageInput;
    const llmMessages = toLlmMessages(messages, { echoReasoning: this.deps.echoReasoning, imageInput });
    // Say it out loud once per run: a model that cannot see images otherwise
    // receives "[image not sent]" and answers as though the attachment were
    // nonsense, which reads to the user like the kernel dropped it for no reason.
    if (!imageInput && !this.imageWarned) {
      const dropped = history.some((m) => (m.role === 'user' || m.role === 'tool') && m.content.some((b) => b.type === 'image'));
      if (dropped) {
        this.imageWarned = true;
        this.deps.emit({ type: 'warning', code: 'image_dropped', message: `This model takes no image input; ${this.deps.model} received a text placeholder instead of the attached picture.` });
      }
    }
    const hookCtx = { sessionId: this.deps.sessionId, runId, signal };
    const transformed = await this.deps.hooks.transformContext(llmMessages, hookCtx);

    let request: ChatRequest = {
      model: this.deps.model,
      messages: transformed,
      tools: this.deps.registry.toLlmTools(),
      toolChoice: 'auto',
      ...(this.deps.temperature !== undefined ? { temperature: this.deps.temperature } : {}),
      ...(this.deps.maxTokens !== undefined ? { maxTokens: this.deps.maxTokens } : {}),
    };
    request = await this.deps.hooks.preModelCall(request, hookCtx);
    // Last write on the message list, on purpose. `transformContext` and
    // `preModelCall` may rewrite, reorder or drop anything they like — an injected
    // policy prompt is the one thing they must not be able to lose, so it goes in
    // after them rather than being handed over for them to keep.
    if (injections.length && this.deps.injector) request = { ...request, messages: this.deps.injector.apply(request.messages, injections) };

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const calls = new Map<number, PendingCall>();
    let usage: Usage | undefined;
    let finish: import('../types/messages').FinishReason = 'stop';
    let textOpen = false;
    let reasoningOpen = false;
    let lastDeltaAt = 0;

    const closeReasoning = () => {
      if (!reasoningOpen) return;
      this.deps.emit({ type: 'reasoning_end', messageId, text: reasoningParts.join('') });
      reasoningOpen = false;
    };
    const closeText = () => {
      if (!textOpen) return;
      this.deps.emit({ type: 'text_end', messageId, text: textParts.join('') });
      textOpen = false;
    };

    // Counted here, not at the top of the step: a step that never reaches the
    // model — stopped by a hook, cancelled while a tool ran — should not be
    // charged to the tree.
    this.deps.budget?.addStep();

    for await (const ev of this.deps.provider.stream(request, { signal })) {
      if (signal.aborted) throw signal.reason ?? new AbortedError();
      switch (ev.type) {
        case 'reset': {
          // Roll back the dead attempt: what this message "said" is not evidence,
          // and a half-stitched tool call must not be executed by the retry.
          if (textOpen) this.deps.emit({ type: 'text_reset', messageId });
          if (reasoningOpen) this.deps.emit({ type: 'reasoning_reset', messageId });
          textParts.length = 0;
          reasoningParts.length = 0;
          calls.clear();
          textOpen = false;
          reasoningOpen = false;
          this.deps.logger.warn(`provider stream reset (attempt ${ev.attempt})`);
          this.deps.emit({ type: 'warning', code: 'stream_reset', message: `Model stream dropped mid-response; re-issuing the request (attempt ${ev.attempt}). Anything streamed for this message was discarded.`, details: { attempt: ev.attempt } });
          break;
        }
        case 'reasoning_delta': {
          if (!reasoningOpen) {
            this.deps.emit({ type: 'reasoning_start', messageId });
            reasoningOpen = true;
          }
          reasoningParts.push(ev.delta);
          if (Date.now() - lastDeltaAt > 50) await tick();
          this.deps.emit({ type: 'reasoning_delta', messageId, delta: ev.delta });
          break;
        }
        case 'text_delta': {
          closeReasoning();
          if (!textOpen) {
            this.deps.emit({ type: 'text_start', messageId });
            textOpen = true;
          }
          textParts.push(ev.delta);
          if (Date.now() - lastDeltaAt > 50) await tick();
          lastDeltaAt = Date.now();
          this.deps.emit({ type: 'text_delta', messageId, delta: ev.delta });
          break;
        }
        case 'tool_call_start': {
          closeReasoning();
          closeText();
          const existing = calls.get(ev.index);
          const call: PendingCall = existing ?? { index: ev.index, id: ev.id ?? newId('call'), name: '', rawArgs: '' };
          if (ev.id) call.id = ev.id;
          if (ev.name) call.name = ev.name;
          calls.set(ev.index, call);
          if (ev.name) {
            this.deps.emit({ type: 'tool_call_start', messageId, toolCallId: call.id, name: call.name });
            call.part = { type: 'tool_call', id: call.id, name: call.name, args: {}, rawArgs: '', status: 'pending' };
          }
          break;
        }
        case 'tool_call_delta': {
          const call = calls.get(ev.index) ?? { index: ev.index, id: ev.id ?? newId('call'), name: ev.name ?? '', rawArgs: '', part: undefined };
          calls.set(ev.index, call);
          if (ev.name && !call.name) {
            call.name = ev.name;
            this.deps.emit({ type: 'tool_call_start', messageId, toolCallId: call.id, name: call.name });
            call.part = { type: 'tool_call', id: call.id, name: call.name, args: {}, rawArgs: '', status: 'pending' };
          }
          if (ev.id && !call.id) call.id = ev.id;
          if (ev.argsDelta) {
            call.rawArgs += ev.argsDelta;
            this.deps.emit({ type: 'tool_call_delta', messageId, toolCallId: call.id, argsDelta: ev.argsDelta });
          }
          break;
        }
        case 'usage':
          usage = ev.usage;
          break;
        case 'finish':
          finish = ev.reason;
          break;
      }
    }
    closeReasoning();
    closeText();
    if (reasoningParts.length === 0 && textParts.length === 0 && calls.size === 0) {
      this.deps.logger.debug(`empty completion at step ${step} of ${runId}`);
    }

    if (usage) {
      this.cumulative = {
        promptTokens: this.cumulative.promptTokens + usage.promptTokens,
        completionTokens: this.cumulative.completionTokens + usage.completionTokens,
        totalTokens: this.cumulative.totalTokens + usage.totalTokens,
        requests: this.cumulative.requests + 1,
      };
      const estimated = this.deps.context.estimate(messages);
      if (usage.promptTokens) this.deps.context.calibrator.observe(estimated, usage.promptTokens);
      this.deps.emit({ type: 'usage', usage, cumulative: { ...this.cumulative } });
      this.deps.budget?.addUsage(usage);
    } else if (this.deps.budget) {
      // An endpoint that never reports usage must still count against the tree,
      // or the ceiling only bounds the polite providers. The prompt is
      // re-estimated every step on purpose: that is what re-sending the history
      // actually costs.
      const promptTokens = this.deps.context.estimate(messages);
      const produced: Message[] = [{ id: messageId, role: 'assistant', createdAt: Date.now(), parts: [{ type: 'text', text: `${textParts.join('')}${reasoningParts.join('')}` }] }];
      const completionTokens = this.deps.context.estimate(produced);
      this.deps.budget.addUsage({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
    }

    const parts: AssistantMessage['parts'] = [];
    if (reasoningParts.length) parts.push({ type: 'reasoning', text: reasoningParts.join('') });
    if (textParts.length) parts.push({ type: 'text', text: textParts.join('') });
    for (const call of [...calls.values()].sort((a, b) => a.index - b.index)) {
      if (!call.name) continue;
      const part: ToolCallPart = { type: 'tool_call', id: call.id, name: call.name, args: {}, rawArgs: call.rawArgs, status: 'pending' };
      try {
        part.args = parseToolArgs(call.rawArgs, call.name);
      } catch (err) {
        part.status = 'failed';
      }
      parts.push(part);
      call.part = part;
      this.deps.emit({ type: 'tool_call_ready', messageId, toolCallId: call.id, name: call.name, args: part.args, kind: this.deps.registry.get(call.name)?.kind ?? 'other', title: titleFor(this.deps.registry.get(call.name), call.name, part.args) });
    }

    const message: AssistantMessage = {
      id: messageId,
      role: 'assistant',
      createdAt: Date.now(),
      parts,
      finishReason: finish,
      model: this.deps.model,
      ...(usage ? { usage } : {}),
    };
    await this.deps.appendMessages([message]);
    this.deps.emit({ type: 'message', message });
    await this.deps.hooks.postModelCall(message, { sessionId: this.deps.sessionId, runId, signal });
    if (finish === 'length') this.deps.emit({ type: 'warning', code: 'output_length', message: 'Model output hit max_tokens and may be incomplete.' });
    return { message, calls: [...calls.values()].sort((a, b) => a.index - b.index), usage, finish };
  }

  private async executeCalls(calls: PendingCall[], runId: string, signal: AbortSignal): Promise<void> {
    const sequential = this.deps.toolExecution === 'sequential' || calls.some((c) => this.deps.registry.get(c.name)?.concurrency === 'sequential');
    const results: Array<{ call: PendingCall; message: ToolMessage }> = [];

    // Every call must produce a result message even if a tool throws on the
    // way in or out: an unanswered tool_call makes the next request invalid.
    const runOne = async (call: PendingCall): Promise<{ call: PendingCall; message: ToolMessage }> => {
      try {
        return { call, message: await this.executeOne(call, runId, signal) };
      } catch (err) {
        if (call.part) call.part.status = 'failed';
        this.deps.emit({ type: 'tool_status', toolCallId: call.id, name: call.name, status: 'failed' });
        return { call, message: mkToolMessage(call, `${(err as Error).name}: ${(err as Error).message}`, true, Date.now()) };
      }
    };

    if (sequential) {
      for (const call of calls) results.push(await runOne(call));
    } else {
      results.push(...(await Promise.all(calls.map(runOne))));
    }

    const messages = results.map((r) => r.message);
    await this.deps.appendMessages(messages);
    for (const m of messages) this.deps.emit({ type: 'message', message: m });
  }

  /**
   * A skill's `allowed-tools` are granted only once the model actually loads
   * that skill: an installed-but-unused skill must not widen permissions.
   */
  private grantSkillTools(name: string): void {
    for (const rule of this.deps.services.skills?.allowedToolsFor([name]) ?? []) {
      this.deps.permission.addSessionRule('allow', rule);
      this.deps.logger.debug(`skill ${name} granted ${rule.tool}${rule.argPattern ? `(${rule.argPattern})` : ''}`);
    }
  }

  private async executeOne(call: PendingCall, runId: string, signal: AbortSignal): Promise<ToolMessage> {
    const hookCtx = { sessionId: this.deps.sessionId, runId, signal };
    const started = Date.now();
    const tool = this.deps.registry.get(call.name);
    const setStatus = (status: ToolCallPart['status']) => {
      if (call.part) call.part.status = status;
      this.deps.emit({ type: 'tool_status', toolCallId: call.id, name: call.name, status });
    };

    if (!tool) {
      setStatus('failed');
      const message = mkToolMessage(call, `ToolNotFoundError: no tool named "${call.name}". Available: ${this.deps.registry.names().join(', ')}`, true, started);
      await this.deps.hooks.postToolUseFailure({ toolCallId: call.id, name: call.name, args: call.part?.args ?? {}, tool: syntheticTool(call.name) }, new ToolNotFoundError(call.name), hookCtx);
      this.deps.emit({ type: 'tool_result', toolCallId: call.id, name: call.name, content: message.content, isError: true, durationMs: Date.now() - started });
      return message;
    }

    let args = call.part?.args ?? {};

    try {
      validateArgs(tool.parameters, args, tool.name);
    } catch (err) {
      setStatus('failed');
      const message = mkToolMessage(call, `${(err as Error).name}: ${(err as Error).message}\nFix the arguments and call ${tool.name} again. Schema: ${JSON.stringify(tool.parameters)}`, true, started);
      await this.deps.hooks.postToolUseFailure({ toolCallId: call.id, name: tool.name, args, tool }, err, hookCtx);
      this.deps.emit({ type: 'tool_result', toolCallId: call.id, name: tool.name, content: message.content, isError: true, durationMs: Date.now() - started });
      return message;
    }

    const subject: PermissionSubject = { tool, args, toolCallId: call.id, title: titleFor(tool, call.name, args) };

    /**
     * A rewritten input is what actually runs, so it has to satisfy the schema
     * on its own terms instead of riding on the original call's verdict.
     * Returns a refusal reason, or undefined when the rewrite is well-formed.
     */
    const applyRewrite = (updated: Record<string, unknown> | undefined): string | undefined => {
      if (!updated) return undefined;
      args = { ...args, ...updated };
      subject.args = args;
      if (call.part) call.part.args = args;
      try {
        validateArgs(tool.parameters, args, tool.name);
      } catch (err) {
        return (err as Error).message;
      }
      return undefined;
    };

    let decision: import('../types/permission').PermissionDecision;
    try {
      const pre = await this.deps.hooks.preToolUse({ toolCallId: call.id, name: tool.name, args, tool }, hookCtx);
      const rewriteProblem = applyRewrite(pre.updatedInput);
      if (rewriteProblem) throw new Error(rewriteProblem);
      if (pre.additionalContext) {
        this.deps.logger.debug(`PreToolUse context for ${tool.name}: ${pre.additionalContext.slice(0, 200)}`);
      }
      decision = await this.deps.permission.evaluate(subject, pre.permissionDecision);
    } catch (err) {
      decision = { behavior: 'deny', message: `PreToolUse hook failed: ${(err as Error).message}` };
    }

    let askedOption: string | undefined;
    if (decision.behavior === 'ask') {
      const request = this.deps.permission.buildRequest(this.deps.sessionId, { ...subject, args }, decision.reason);
      this.deps.emit({ type: 'permission_request', request });
      await this.deps.hooks.permissionRequest(request, hookCtx);
      setStatus('awaiting_permission');
      let response;
      try {
        response = await this.deps.permission.requestUserDecision(request, signal);
      } catch (err) {
        response = { optionId: 'cancelled' as const, message: (err as Error).message };
      }
      askedOption = response.optionId;
      this.deps.emit({ type: 'permission_resolved', requestId: request.requestId, toolCallId: call.id, optionId: response.optionId });
      this.deps.onPermissionResolved?.(request, response.optionId);
      applyResponseToRules(this.deps.permission, request, response);
      if (response.optionId === 'allow_once' || response.optionId === 'allow_always') {
        const rewriteProblem = applyRewrite(response.updatedInput) ?? this.deps.permission.checkDeny(tool, args);
        decision = rewriteProblem
          ? { behavior: 'deny', message: `Approved input was rejected: ${rewriteProblem}` }
          : { behavior: 'allow' };
      } else {
        decision = { behavior: 'deny', message: response.message ?? `The user chose ${response.optionId} for ${tool.name}.` };
      }
    }

    // One line per ruled call. Auto-approvals are recorded too — "who let this
    // through" is answerable only if the log contains the cases where nobody was
    // asked. Arguments go out as a digest: evidence, not a second copy of secrets.
    this.deps.audit?.({
      at: Date.now(),
      sessionId: this.deps.sessionId,
      runId,
      toolCallId: call.id,
      tool: tool.name,
      title: titleFor(tool, tool.name, args),
      argsDigest: digestArgs(args),
      mode: this.deps.permission.currentMode,
      decision: decision.behavior === 'deny' ? 'deny' : 'allow',
      asked: askedOption !== undefined,
      ...(askedOption ? { optionId: askedOption } : {}),
      ...(decision.behavior === 'deny'
        ? { reason: decision.message ?? (decision as { reason?: string }).reason ?? `Permission denied for ${tool.name}` }
        : {}),
    });

    if (decision.behavior === 'deny') {
      const reason = decision.message ?? `Permission denied for ${tool.name}`;
      setStatus(reason.includes('cancelled') ? 'cancelled' : 'denied');
      await this.deps.hooks.permissionDenied({ toolCallId: call.id, name: tool.name, args, tool }, reason, hookCtx);
      const message = mkToolMessage(call, `Permission denied: ${reason}`, true, started);
      this.deps.emit({ type: 'tool_result', toolCallId: call.id, name: tool.name, content: message.content, isError: true, durationMs: Date.now() - started });
      return message;
    }

    // Only once the call is actually about to execute: a call that is still
    // waiting on the host for approval must not look like a running one.
    setStatus('running');

    const ctx: ToolContext = {
      signal,
      workspaceRoot: this.deps.workspaceRoot,
      sessionId: this.deps.sessionId,
      runId,
      toolCallId: call.id,
      sandbox: this.deps.sandbox,
      logger: this.deps.logger,
      progress: (text) => this.deps.emit({ type: 'tool_progress', toolCallId: call.id, name: tool.name, text }),
      services: {
        ...this.deps.services,
        emit: (event) => this.deps.emit(event),
      },
    };

    try {
      let result = await tool.execute(args as Record<string, unknown>, ctx);
      result = await this.deps.hooks.postToolUse({ toolCallId: call.id, name: tool.name, args, tool }, result, hookCtx);
      const activated = result.meta?.['skill'];
      if (typeof activated === 'string') this.grantSkillTools(activated);
      setStatus(result.isError ? 'failed' : 'completed');
      const blocks = toBlocks(result.content);
      const message = mkToolMessage(call, blocks, result.isError === true, started, result.meta);
      this.deps.emit({ type: 'tool_result', toolCallId: call.id, name: tool.name, content: blocks, isError: !!result.isError, durationMs: Date.now() - started, ...(result.meta ? { meta: result.meta } : {}) });
      return message;
    } catch (err) {
      if (isAbortError(err)) {
        setStatus('cancelled');
        return mkToolMessage(call, 'The tool call was cancelled before it finished.', true, started);
      }
      const wrapped =
        err instanceof NosieError
          ? err
          : new ToolExecutionError(tool.name, err instanceof Error ? err.message : String(err), { cause: err?.constructor?.name });
      setStatus('failed');
      await this.deps.hooks.postToolUseFailure({ toolCallId: call.id, name: tool.name, args, tool }, wrapped, hookCtx);
      const message = mkToolMessage(call, `${wrapped.name}: ${wrapped.message}`, true, started);
      this.deps.emit({ type: 'tool_result', toolCallId: call.id, name: tool.name, content: message.content, isError: true, durationMs: Date.now() - started });
      this.deps.logger.warn(`tool ${tool.name} failed: ${wrapped.message}`);
      return message;
    }
  }

  private async compact(history: Message[], signal: AbortSignal, forced = false, extra = 0): Promise<boolean> {
    const tokensBefore = this.deps.context.estimate(history);

    // Stage 1 is free and removes the bulk of a coding transcript's noise.
    const stageOne = this.deps.context.clearOldToolResults(history);
    if (stageOne.clearedIds.size) {
      this.deps.emit({ type: 'compaction_start', tokensBefore, strategy: 'clear_tool_results' });
      await this.deps.markCleared(stageOne.clearedIds);
      this.deps.emit({
        type: 'compaction_end',
        tokensBefore,
        tokensAfter: this.deps.context.estimate(stageOne.messages),
        strategy: 'clear_tool_results',
      });
      if (!this.deps.context.isOverflow(stageOne.messages, extra) && !forced) return true;
    }

    // Stage 2 needs a model call, so only take it when clearing was not enough.
    const plan = this.deps.context.buildPlan(this.deps.history(), 'summarize');
    if (!plan) return !!stageOne.clearedIds.size;
    const decided = await this.deps.hooks.preCompact(plan, { sessionId: this.deps.sessionId, runId: newId('run'), signal });
    if (decided === false) return !!stageOne.clearedIds.size;

    this.deps.emit({ type: 'compaction_start', tokensBefore: plan.tokensBefore, strategy: 'summarize' });
    try {
      const summary = await this.deps.context.summarize(decided, this.deps.provider, this.deps.model, signal);
      const entry = this.deps.context.makeEntry(summary, plan.head, plan.tokensBefore);
      // The summary has to go into the *live* history, not just the log: these
      // messages are what the next step sends. Persisting the entry alone leaves
      // the model continuing the run with the summarized half missing until the
      // session is reloaded and `assembleContext` puts it back.
      await this.deps.replaceHistory([mkSystemMessage(`${SUMMARY_PREAMBLE}${summary}`), ...plan.tail]);
      await this.deps.appendCompaction(entry);
      await this.deps.hooks.postCompact(entry, { sessionId: this.deps.sessionId, runId: newId('run'), signal });
      this.deps.emit({ type: 'compaction_end', tokensBefore: plan.tokensBefore, tokensAfter: entry.tokensAfter, strategy: 'summarize', summary });
      this.deps.logger.info(`compacted ${plan.head.length} messages into a summary`);
      return true;
    } catch (err) {
      this.deps.emit({ type: 'warning', code: 'compaction_failed', message: `Summarization failed: ${(err as Error).message}` });
      return !!stageOne.clearedIds.size;
    }
  }
}

function mkUserMessage(content: ContentBlock[]): Message {
  return { id: newId('msg'), role: 'user', createdAt: Date.now(), content };
}

function mkSystemMessage(content: string): Message {
  return { id: newId('msg'), role: 'system', createdAt: Date.now(), content };
}

function mkToolMessage(
  call: PendingCall,
  content: ContentBlock[] | string,
  isError: boolean,
  started: number,
  meta?: Record<string, unknown>,
): ToolMessage {
  return {
    id: newId('msg'),
    role: 'tool',
    createdAt: Date.now(),
    toolCallId: call.id,
    toolName: call.name || 'unknown',
    content: toBlocks(content),
    isError,
    durationMs: Date.now() - started,
    ...(meta ? { meta } : {}),
  };
}

function titleFor(tool: Tool | undefined, fallbackName: string, args: Record<string, unknown>): string {
  if (tool?.title) {
    try {
      return tool.title(args);
    } catch {
      /* fall through */
    }
  }
  const primary = tool?.primaryArg ? args[tool.primaryArg] : Object.values(args)[0];
  return typeof primary === 'string' ? `${fallbackName}: ${primary.slice(0, 200)}` : fallbackName;
}

function syntheticTool(name: string): Tool {
  return { name, description: '', parameters: { type: 'object' }, execute: async () => ({ content: [] }) };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export { OutputLengthError, PermissionDeniedError, InvalidToolArgsError };
export type { StepOutcome };
