import type { Hooks, HookName, HookContext, PreToolUseOutput, CompactionPlan, ToolCallInfo } from '../types/hooks';
import type { ChatRequest, LlmMessage } from '../types/provider';
import type { AssistantMessage, ContentBlock, Message } from '../types/messages';
import type { ToolResult } from '../types/tools';
import type { PermissionRequest, RunResult } from '../types/events';
import { toBlocks } from '../types/messages';

export class HookRunner {
  private hooks: Hooks = {};

  constructor(hooks: Hooks = {}) {
    this.hooks = hooks;
  }

  register<K extends HookName>(name: K, fn: NonNullable<Hooks[K]>[number]): () => void {
    const list = ((this.hooks[name] as unknown[]) ??= []) as unknown[];
    list.push(fn);
    return () => {
      const l = this.hooks[name] as unknown[] | undefined;
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    };
  }

  has(name: HookName): boolean {
    return (this.hooks[name] as unknown[] | undefined)?.length ? true : false;
  }

  private async fire<K extends HookName>(name: K, ctx: HookContext, run: (fn: NonNullable<Hooks[K]>[number]) => Promise<void>): Promise<void> {
    const list = (this.hooks[name] as unknown[] | undefined) as NonNullable<Hooks[K]> | undefined;
    if (!list?.length) return;
    for (const fn of [...list]) {
      if (ctx.signal.aborted) return;
      await run(fn);
    }
  }

  sessionStart(ctx: HookContext) {
    return this.fire('SessionStart', ctx, async (fn) => void (fn as (c: HookContext) => unknown)(ctx));
  }

  sessionEnd(ctx: HookContext) {
    return this.fire('SessionEnd', ctx, async (fn) => void (fn as (c: HookContext) => unknown)(ctx));
  }

  async userPromptSubmit(input: ContentBlock[], ctx: HookContext): Promise<ContentBlock[]> {
    let blocks = input;
    await this.fire('UserPromptSubmit', ctx, async (fn) => {
      const out = await (fn as (i: ContentBlock[], c: HookContext) => unknown)(blocks, ctx);
      if (typeof out === 'string') blocks = toBlocks(out);
      else if (Array.isArray(out)) blocks = out as ContentBlock[];
    });
    return blocks;
  }

  async preModelCall(request: ChatRequest, ctx: HookContext): Promise<ChatRequest> {
    let req = request;
    await this.fire('PreModelCall', ctx, async (fn) => {
      const out = await (fn as (r: ChatRequest, c: HookContext) => unknown)(req, ctx);
      if (out && typeof out === 'object') req = out as ChatRequest;
    });
    return req;
  }

  postModelCall(message: AssistantMessage, ctx: HookContext) {
    return this.fire('PostModelCall', ctx, async (fn) => void (fn as (m: AssistantMessage, c: HookContext) => unknown)(message, ctx));
  }

  async preToolUse(call: ToolCallInfo, ctx: HookContext): Promise<PreToolUseOutput> {
    const merged: PreToolUseOutput = {};
    await this.fire('PreToolUse', ctx, async (fn) => {
      const out = (await (fn as (c: ToolCallInfo, x: HookContext) => unknown)(call, ctx)) as PreToolUseOutput | void;
      if (!out) return;
      if (out.permissionDecision) merged.permissionDecision = out.permissionDecision;
      if (out.updatedInput) merged.updatedInput = { ...(merged.updatedInput ?? {}), ...out.updatedInput };
      if (out.additionalContext) merged.additionalContext = [merged.additionalContext, out.additionalContext].filter(Boolean).join('\n');
    });
    return merged;
  }

  async postToolUse(call: ToolCallInfo, result: ToolResult, ctx: HookContext): Promise<ToolResult> {
    let res = result;
    await this.fire('PostToolUse', ctx, async (fn) => {
      const out = await (fn as (c: ToolCallInfo, r: ToolResult, x: HookContext) => unknown)(call, res, ctx);
      if (out && typeof out === 'object') res = out as ToolResult;
    });
    return res;
  }

  postToolUseFailure(call: ToolCallInfo, error: unknown, ctx: HookContext) {
    return this.fire('PostToolUseFailure', ctx, async (fn) => void (fn as (c: ToolCallInfo, e: unknown, x: HookContext) => unknown)(call, error, ctx));
  }

  permissionRequest(request: PermissionRequest, ctx: HookContext) {
    return this.fire('PermissionRequest', ctx, async (fn) => void (fn as (r: PermissionRequest, c: HookContext) => unknown)(request, ctx));
  }

  permissionDenied(call: ToolCallInfo, reason: string, ctx: HookContext) {
    return this.fire('PermissionDenied', ctx, async (fn) => void (fn as (c: ToolCallInfo, r: string, x: HookContext) => unknown)(call, reason, ctx));
  }

  async preCompact(plan: CompactionPlan, ctx: HookContext): Promise<CompactionPlan | false> {
    let current: CompactionPlan | false = plan;
    await this.fire('PreCompact', ctx, async (fn) => {
      const out = await (fn as (p: CompactionPlan, c: HookContext) => unknown)(current as CompactionPlan, ctx);
      if (out === false) current = false;
      else if (out && typeof out === 'object') current = out as CompactionPlan;
    });
    return current;
  }

  postCompact(entry: import('../types/messages').CompactionEntry, ctx: HookContext) {
    return this.fire('PostCompact', ctx, async (fn) => void (fn as (e: unknown, c: HookContext) => unknown)(entry, ctx));
  }

  stop(result: RunResult, ctx: HookContext) {
    return this.fire('Stop', ctx, async (fn) => void (fn as (r: RunResult, c: HookContext) => unknown)(result, ctx));
  }

  async transformContext(messages: LlmMessage[], ctx: HookContext): Promise<LlmMessage[]> {
    let msgs = messages;
    await this.fire('transformContext', ctx, async (fn) => {
      const out = await (fn as (m: LlmMessage[], c: HookContext) => unknown)(msgs, ctx);
      if (Array.isArray(out)) msgs = out as LlmMessage[];
    });
    return msgs;
  }
}

export function messagesForHook(list: Message[]): Message[] {
  return list;
}
