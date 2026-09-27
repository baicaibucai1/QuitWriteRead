import path from 'node:path';
import type { AgentConfig, InjectedPrompt, PromptEnv, SubagentDefinition } from '../types/config';
import type { AgentEvent, AgentEventType, PermissionRequest, RunResult } from '../types/events';
import type { CompactionEntry, ContentBlock, Message, SessionMeta } from '../types/messages';
import { toBlocks } from '../types/messages';
import type { Logger, Tool } from '../types/tools';
import type { PermissionConfig, PermissionMode, PermissionOptionId, PermissionResponse, PermissionRule } from '../types/permission';
import { ToolRegistry } from '../tools/registry';
import { PathSandbox } from '../tools/sandbox';
import { createBuiltinTools, defaultHomeDir, resolveBuiltinSelection, READ_ONLY_BUILTINS } from '../tools/builtin';
import { createTaskTool, type DelegationResult } from '../tools/subagent';
import { createProvider } from '../provider/openai-compatible';
import { createMemoryStores, type MemoryStores } from '../memory/index';
import { loadSkills, SkillRegistry, type SkillIssue } from '../skills/loader';
import { InMemorySessionStore, assembleContext, type SessionStore, type SessionSummary } from '../session/index';
import { HookRunner } from './hooks';
import { PermissionEngine, normalizeRules } from './permission';
import { ContextManager } from './compaction';
import { Runner } from './loop';
import { buildSystemPrompt } from './system-prompt';
import { stepCountIs, type StopCondition } from './stop';
import { BudgetLedger, type BudgetLimits } from './budget';
import { PromptInjector } from './inject';
import { createRedactor, type Redactor } from './redact';
import { createAuditSink, type AuditSink } from './audit';
import { ToolExecutionError } from '../types/errors';
import { newId, noopLogger, AsyncQueue } from '../utils';
import { ConfigError } from '../types/errors';

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface RunHandle extends AsyncIterable<AgentEvent> {
  readonly runId: string;
  readonly result: Promise<RunResult>;
  abort(): void;
}

export type AgentListener<T extends AgentEvent['type'] = AgentEvent['type']> = (event: Extract<AgentEvent, { type: T }>) => void;

export interface AgentInfo {
  sessionId: string;
  model: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  tools: string[];
  skills: string[];
  /** Declared subagent names; `task` is in `tools` only when these are usable. */
  subagents: string[];
  mcpServers: string[];
  /** Directories the user/project memory stores read from, empty when disabled. */
  memoryDirs: string[];
  /** Ids of the forced prompts; `agent.injections()` for their text and cost. */
  injections: string[];
  skillIssues: SkillIssue[];
}

export class Agent {
  readonly sessionId: string;
  readonly tools: ToolRegistry;
  private readonly cfg: ResolvedConfig;
  private readonly registry: HookRunner;
  private readonly permission: PermissionEngine;
  private readonly context: ContextManager;
  /** Forced prompts. Read-only handle on the object; mutate through inject/withdraw. */
  private readonly injector: PromptInjector;
  private readonly runner: Runner;
  private readonly sessionStore: SessionStore;
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private readonly sinks = new Set<(event: AgentEvent) => void>();
  private readonly pending = new Map<string, PendingPermission>();
  private hostHandlesPermissions = false;
  private hostPermissionHandler?: PermissionConfig['onRequest'];
  private messages: Message[] = [];
  private clearedIds = new Set<string>();
  private promptCache: { text: string; key: string } | undefined;
  private activeRun: { controller: AbortController } | undefined;
  private activeRunDone: Promise<unknown> | undefined;
  private steerQueue: ContentBlock[][] = [];
  private followUpQueue: ContentBlock[][] = [];
  private disposed = false;

  private constructor(cfg: ResolvedConfig, sessionStore: SessionStore, meta: SessionMeta) {
    this.cfg = cfg;
    this.sessionStore = sessionStore;
    this.sessionId = meta.sessionId;
    this.registry = new HookRunner(cfg.hooks);
    this.permission = cfg.permission;
    this.installPermissionHandler(cfg.hostPermissionHandler);
    this.tools = cfg.registry;
    this.injector = new PromptInjector(cfg.injectedPrompts);
    this.context = new ContextManager({
      enabled: cfg.compactionEnabled,
      contextWindow: cfg.contextWindow,
      reserveTokens: cfg.reserveTokens,
      keepRecentTokens: cfg.keepRecentTokens,
      keepRecentToolResults: cfg.keepRecentToolResults,
      ...(cfg.summaryModel ? { summaryModel: cfg.summaryModel } : {}),
    });
    this.runner = new Runner({
      provider: cfg.provider,
      // Read live so agent.setModel() takes effect on the next step.
      get model() {
        return cfg.model;
      },
      registry: cfg.registry,
      permission: this.permission,
      hooks: this.registry,
      context: this.context,
      systemPrompt: () => this.systemPromptText(),
      sandbox: cfg.sandbox,
      workspaceRoot: cfg.workspaceRoot,
      sessionId: this.sessionId,
      services: { memory: cfg.memory, skills: cfg.skills },
      logger: cfg.logger,
      maxSteps: cfg.maxSteps,
      budget: cfg.budgetLedger,
      injector: this.injector,
      ...(cfg.auditSink ? { audit: cfg.auditSink } : {}),
      stopWhen: cfg.stopWhen,
      toolExecution: cfg.toolExecution,
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
      echoReasoning: cfg.provider.capabilities.echoReasoning,
      queues: { steer: this.steerQueue, followUp: this.followUpQueue },
      hooksCtxSignal: () => new AbortController().signal,
      emit: (event) => this.emit(event),
      appendMessages: async (messages) => {
        this.messages.push(...messages);
        // The live transcript keeps what the model sent; the durable copy is
        // masked, because a session file outlives the run and gets read by
        // people who were not in the conversation.
        const persisted = cfg.redactor.active ? messages.map((message) => cfg.redactor.message(message)) : messages;
        await sessionStore.append(this.sessionId, persisted.map((message) => ({ kind: 'message' as const, message })));
      },
      appendCompaction: async (entry) => {
        // A summary is the most durable text in the transcript — it survives
        // every later compaction — so it is exactly what must not carry a secret
        // forward onto disk.
        await sessionStore.append(this.sessionId, cfg.redactor.active && entry.summary ? { ...entry, summary: cfg.redactor.text(entry.summary) } : entry);
      },
      markCleared: async (ids) => {
        for (const id of ids) this.clearedIds.add(id);
        for (const m of this.messages) if (m.role === 'tool' && ids.has(m.id)) m.cleared = true;
        await sessionStore.setMeta(this.sessionId, { meta: { clearedIds: [...this.clearedIds] } });
      },
      history: () => this.messages,
      replaceHistory: async (messages) => {
        this.messages = [...messages];
      },
    });
  }

  static async create(config: AgentConfig): Promise<Agent> {
    const cfg = await resolveConfig(config);
    const sessionStore = cfg.sessionStore;
    const existing = cfg.sessionId ? await sessionStore.load(cfg.sessionId) : [];
    const meta = existing.length
      ? ((existing.find((e) => e.kind === 'meta') as SessionMeta | undefined) ?? (await sessionStore.create({ sessionId: cfg.sessionId!, cwd: cfg.workspaceRoot })))
      : await sessionStore.create({ sessionId: cfg.sessionId ?? newId('sess'), cwd: cfg.workspaceRoot });

    const agent = new Agent(cfg, sessionStore, meta);
    const { messages } = assembleContext(existing.length ? existing : await sessionStore.load(meta.sessionId));
    agent.messages = messages;
    const metaEntry = existing.find((e) => e.kind === 'meta') as SessionMeta | undefined;
    const cleared = (metaEntry?.meta as { clearedIds?: string[] } | undefined)?.clearedIds;
    if (cleared) agent.clearedIds = new Set(cleared);
    for (const m of agent.messages) if (m.role === 'tool' && agent.clearedIds.has(m.id)) m.cleared = true;
    agent.installSubagents(config, 0);

    for (const warning of cfg.promptWarnings) agent.emit({ type: 'warning', ...warning });
    // Skills and MCP servers both report through one list, so a host that only
    // listens for events still learns that a server never came up.
    for (const issue of cfg.skillIssues) {
      const code = issue.dir.startsWith('mcp:')
        ? 'mcp_issue'
        : issue.level === 'error'
          ? 'skill_invalid'
          : 'skill_warning';
      agent.emit({ type: 'warning', code, message: `${issue.dir}: ${issue.message}`, details: issue.dir });
    }
    try {
      await agent.registry.sessionStart({ sessionId: agent.sessionId, runId: 'boot', signal: new AbortController().signal });
    } catch (err) {
      cfg.logger.warn(`SessionStart hook failed: ${(err as Error).message}`);
    }
    return agent;
  }

  get model(): string {
    return this.cfg.model;
  }

  get logger(): Logger {
    return this.cfg.logger;
  }

  info(): AgentInfo {
    return {
      sessionId: this.sessionId,
      model: this.cfg.model,
      workspaceRoot: this.cfg.workspaceRoot,
      permissionMode: this.permission.currentMode,
      tools: this.tools.names(),
      skills: (this.cfg.skills?.all ?? []).map((s) => s.name),
      subagents: (this.cfg.subagents ?? []).map((s) => s.name),
      mcpServers: [],
      memoryDirs: (this.cfg.memory?.all() ?? []).map((s) => s.dir),
      injections: this.injector.list().map((p) => p.id!),
      skillIssues: this.cfg.skillIssues ?? [],
    };
  }

  /**
   * Put a prompt in front of the model on *every* remaining request, without
   * putting it in the transcript. Returns the id to withdraw it with.
   *
   * This is the channel for rules that must not be losable. Compaction rewrites
   * the history, `transformContext` may return anything it likes, and neither can
   * take away what the kernel appends after them — which is the whole point, and
   * also why these should stay short: the model reads them again each step.
   */
  inject(prompt: InjectedPrompt): string {
    return this.injector.add(prompt);
  }

  withdrawInjection(id: string): boolean {
    return this.injector.withdraw(id);
  }

  /**
   * The forced prompts as they would resolve right now, each with its token cost.
   * A policy that quietly eats a tenth of the window is worth being able to see,
   * so this is the read side of `inject()` — `info().injections` only lists ids.
   * Dynamic prompts are evaluated with `step: 0`, there being no run to count.
   */
  async injections(): Promise<Array<{ id: string; text: string; role: 'system' | 'user'; position: 'head' | 'tail'; tokens: number }>> {
    const ctx = { sessionId: this.sessionId, step: 0, model: this.cfg.model, permissionMode: this.permission.currentMode };
    return (await this.injector.priced(ctx)).map((r) => ({
      id: r.id,
      text: String(r.message.content ?? ''),
      role: r.message.role === 'user' ? ('user' as const) : ('system' as const),
      position: r.position,
      tokens: r.tokens,
    }));
  }

  history(): Message[] {
    return [...this.messages];
  }

  setMode(mode: PermissionMode): void {
    this.permission.setMode(mode);
  }

  /** Switches the model for subsequent steps; history and tools are untouched. */
  setModel(model: string): void {
    if (!model.trim()) throw new ConfigError('setModel requires a non-empty model id');
    this.cfg.model = model;
    // A different model usually means a different window. Unless the host pinned
    // one, follow the model — otherwise compaction stays armed for a window the
    // new model never had, and the provider returns a context error instead.
    if (!this.cfg.pinnedContextWindow) {
      const window = this.cfg.provider.contextWindow?.(model);
      if (window) this.context.setWindow(window);
    }
    this.refreshSystemPrompt();
  }

  /** Adds a session-scoped rule such as `shell(git *)` to the allow or deny bucket. */
  addRule(bucket: 'allow' | 'deny', rule: string | PermissionRule): void {
    const [normalized] = normalizeRules([rule]);
    if (!normalized) throw new ConfigError(`Could not parse permission rule ${JSON.stringify(rule)}`);
    this.permission.addSessionRule(bucket, normalized);
  }

  get mode(): PermissionMode {
    return this.permission.currentMode;
  }

  on<T extends AgentEventType>(type: T, listener: AgentListener<T>): () => void;
  on(type: '*', listener: (event: AgentEvent) => void): () => void;
  on(type: AgentEventType | '*', listener: (event: AgentEvent) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, set);
    const wrapped = (event: AgentEvent) => {
      listener(event);
    };
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  off(type: AgentEventType | '*', listener: (event: AgentEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(event: AgentEvent): void {
    // The injected index is now stale; rebuild the prompt on next use.
    if (event.type === 'memory_update') this.promptCache = undefined;
    // Register before listeners run: an inline host (or CLI) may answer
    // synchronously from the permission_request event itself.
    if (event.type === 'permission_request' && !this.hostHandlesPermissions) this.registerPermissionRequest(event.request);
    const set = this.listeners.get(event.type);
    if (set) for (const fn of [...set]) fn(event);
    const all = this.listeners.get('*');
    if (all) for (const fn of [...all]) fn(event);
    for (const sink of [...this.sinks]) sink(event);
    this.cfg.onEvent?.(event);
  }

  private async systemPromptText(): Promise<string> {
    const key = `${this.cfg.workspaceRoot}|${this.cfg.skills?.count ?? 0}`;
    if (this.promptCache && this.promptCache.key === key) return this.promptCache.text;
    const built = await buildSystemPrompt({
      workspaceRoot: this.cfg.workspaceRoot,
      homeDir: this.cfg.homeDir,
      model: this.cfg.model,
      ...(this.cfg.systemPrompt === undefined ? {} : { systemPrompt: this.cfg.systemPrompt }),
      includeBase: this.cfg.includeBasePrompt,
      instructions: this.cfg.includeInstructions,
      ...(this.cfg.skills && this.cfg.skills.count ? { skills: this.cfg.skills } : {}),
      ...(this.cfg.memory ? { memory: this.cfg.memory } : {}),
      instructionFileNames: this.cfg.instructionFileNames,
      instructionMaxBytes: this.cfg.instructionMaxBytes,
    });
    for (const w of built.warnings) this.emit({ type: 'warning', ...w });
    this.promptCache = { text: built.text, key };
    return built.text;
  }

  refreshSystemPrompt(): void {
    this.promptCache = undefined;
  }

  private installPermissionHandler(host: PermissionConfig['onRequest'] | undefined): void {
    this.hostHandlesPermissions = host !== undefined;
    this.hostPermissionHandler = host;
    this.permission.setRequestHandler(async (request, signal) => {
      if (host) return host(request, signal);
      // The entry is registered when the permission_request event is emitted,
      // so an event-driven host (the CLI, a sidecar) can answer before the loop
      // reaches this await. It therefore has to survive settling until it is
      // consumed here; deleting it on settle would make this call register a
      // brand-new request that nobody is going to answer any more.
      const entry = this.pending.get(request.requestId) ?? this.registerPermissionRequest(request);
      const cancel = () => entry.settle({ optionId: 'cancelled', message: 'The run ended before an answer arrived.' });
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
      const response = await entry.promise;
      this.pending.delete(request.requestId);
      return response;
    });
  }

  private registerPermissionRequest(request: PermissionRequest): PendingPermission {
    let resolve!: (response: PermissionResponse) => void;
    const promise = new Promise<PermissionResponse>((res) => {
      resolve = res;
    });
    const entry: PendingPermission = {
      request,
      promise,
      settle: (response) => {
        if (entry.answered) return;
        entry.answered = true;
        resolve(response);
      },
    };
    this.pending.set(request.requestId, entry);
    return entry;
  }

  run(input: string | ContentBlock[], options: RunOptions = {}): RunHandle {
    if (this.disposed) throw new ConfigError('Agent has been disposed');
    const blocks = toBlocks(input);
    const queue = new AsyncQueue<AgentEvent>();
    const runId = newId('run');
    const controller = new AbortController();
    const previous = this.activeRunDone;
    const sink = (event: AgentEvent) => queue.push(event);
    this.sinks.add(sink);
    if (options.onEvent) this.on('*', options.onEvent);

    const result = (async (): Promise<RunResult> => {
      if (previous) await previous.catch(() => undefined);
      this.activeRun = { controller };
      try {
        return await this.runner.run(blocks, options.signal ?? controller.signal);
      } finally {
        this.sinks.delete(sink);
        this.activeRun = undefined;
        queue.close();
      }
    })();
    this.activeRunDone = result;

    return {
      runId,
      result,
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      abort: () => controller.abort(),
    };
  }

  async say(text: string): Promise<RunResult> {
    return this.run(text).result;
  }

  steer(text: string | ContentBlock[]): void {
    this.steerQueue.push(toBlocks(text));
  }

  followUp(text: string | ContentBlock[]): void {
    this.followUpQueue.push(toBlocks(text));
  }

  pendingPermissions(): PermissionRequest[] {
    return [...this.pending.values()].filter((p) => !p.answered).map((p) => p.request);
  }

  /**
   * Answers a permission_request the host has not handled itself. Only usable
   * when no permission.onRequest was configured; the host handler owns the
   * decision otherwise. False means the id is unknown or already answered.
   */
  respondPermission(requestId: string, optionId: PermissionOptionId | 'cancelled'): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.answered) return false;
    pending.settle({ optionId });
    return true;
  }

  /**
   * Presents a subagent's approval request as this agent's own.
   *
   * A child runs its own loop, but the human at the other end has one
   * conversation - the parent's. Re-labelled with the parent's session id, the
   * request goes through the same two host paths as any other: the event stream
   * for a REPL that polls `respondPermission`, or the configured handler. Both
   * the id and the answer live in this agent's pending map, so nothing has to
   * know a child exists to say no.
   */
  async hostChildPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionResponse> {
    const mine: PermissionRequest = { ...request, sessionId: this.sessionId };
    const resolved = (optionId: PermissionOptionId | 'cancelled'): void => {
      this.emit({ type: 'permission_resolved', requestId: mine.requestId, toolCallId: mine.toolCallId, optionId });
    };
    this.emit({ type: 'permission_request', request: mine });

    if (this.hostPermissionHandler) {
      const response = await this.hostPermissionHandler(mine, signal);
      resolved(response.optionId);
      return response;
    }

    // Emitting the event already registered the entry (see `emit`); reuse it so
    // a host answering by id reaches this exact promise.
    const entry = this.pending.get(mine.requestId) ?? this.registerPermissionRequest(mine);
    const cancel = () => entry.settle({ optionId: 'cancelled', message: 'The run ended before an answer arrived.' });
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    const response = await entry.promise;
    this.pending.delete(mine.requestId);
    resolved(response.optionId);
    return response;
  }

  addTool(tool: Tool): () => void {
    const off = this.tools.register(tool);
    this.refreshSystemPrompt();
    return off;
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.sessionStore.list();
  }

  async sessionEntries(): Promise<Array<SessionMeta | CompactionEntry | { kind: 'message'; message: Message }>> {
    return this.sessionStore.load(this.sessionId);
  }

  /** Drops a persisted transcript. Anything still running keeps its own in-memory copy. */
  async removeSession(sessionId: string): Promise<boolean> {
    return this.sessionStore.remove(sessionId);
  }

  /** The endpoint's advertised models, or undefined when it cannot list them. */
  async listModels(): Promise<string[] | undefined> {
    return this.cfg.provider.listModels?.();
  }

  /**
   * Spend against the tree budget: what has been used, what remains, and which
   * limits exist. Nothing here is per-agent — a host deciding "can I start
   * another subagent" needs the whole tree's number.
   */
  budgetStatus(): { limits: BudgetLimits; spent: { tokens: number; steps: number; elapsedMs: number }; remainingTokens?: number; remainingMs?: number; exhausted: boolean } {
    const ledger = this.cfg.budgetLedger;
    const status = { limits: ledger.limits, spent: ledger.spent } as ReturnType<Agent['budgetStatus']>;
    const tokens = ledger.remainingTokens();
    const ms = ledger.remainingMs();
    if (tokens !== undefined) status.remainingTokens = tokens;
    if (ms !== undefined) status.remainingMs = ms;
    status.exhausted = Boolean(ledger.check());
    return status;
  }

  async memoryIndex(): Promise<string> {
    if (!this.cfg.memory) return '';
    return (await Promise.all(this.cfg.memory.all().map((s) => s.renderIndex()))).filter(Boolean).join('\n\n');
  }

  estimatedTokens(): number {
    return this.context.estimate(this.messages);
  }

  tokenBudget(): { used: number; budget: number; ratio: number } {
    const used = this.estimatedTokens();
    return { used, budget: this.context.budget, ratio: used / this.context.budget };
  }

  /**
   * Registers the delegating tool for `config.subagents`. Called on the parent
   * and, with the next depth level, on each child - which is what decides
   * whether a subagent may delegate again.
   */
  private installSubagents(config: AgentConfig, depth: number): void {
    const definitions = config.subagents ?? [];
    if (!definitions.length) return;
    if (depth >= (config.subagentMaxDepth ?? 1)) return;
    if (!resolveBuiltinSelection(config.builtinTools).has('task')) {
      // Declaring specialists you then refuse to hand the model a way to reach
      // them is a configuration mistake, and a silent one is the worst kind.
      this.emit({ type: 'warning', code: 'subagents_unreachable', message: `Declared ${definitions.length} subagent(s) but 'task' is not in builtinTools, so the model cannot delegate. Add 'task' to builtinTools or drop subagents.` });
      return;
    }

    const names = new Set<string>();
    for (const definition of definitions) {
      if (!definition.name?.trim()) throw new ConfigError('Every subagent needs a non-empty name');
      if (names.has(definition.name)) throw new ConfigError(`Duplicate subagent name "${definition.name}"`);
      if (!definition.prompt?.trim()) throw new ConfigError(`Subagent "${definition.name}" needs a system prompt`);
      names.add(definition.name);
    }
    if (names.has('task')) throw new ConfigError('A subagent cannot be named "task"');

    this.addTool(
      createTaskTool(definitions, {
        run: (definition, task, report, signal) => this.delegate(config, definition, depth + 1, task, report, signal),
      }),
    );
  }

  /**
   * One delegated run. The child is a full agent with its own transcript, but it
   * is deliberately narrowed: a read-only tool set unless the definition says
   * otherwise, no memory, skills or MCP inheritance, no persisted transcript, and
   * approvals routed back through this agent so the human sees one conversation.
   */
  private async delegate(
    config: AgentConfig,
    definition: SubagentDefinition,
    depth: number,
    task: string,
    report: (line: string) => void,
    signal: AbortSignal,
  ): Promise<DelegationResult> {
    // Ask the shared ledger before spending, not after: a fresh child is exactly
    // how a tree that already blew its budget would keep growing. The model gets
    // this back as a failed tool result, so it can summarise what it has instead
    // of being cut off mid-sentence.
    const over = this.cfg.budgetLedger.check();
    if (over) throw new ToolExecutionError('task', `Refusing to spawn the "${definition.name}" subagent: ${this.cfg.budgetLedger.describe(over)}. Answer with what you already have.`);
    const child = await Agent.create({
      provider: config.provider,
      budgetLedger: this.cfg.budgetLedger,
      // Same masking policy and the same audit trail: a delegation must not
      // become a way to write unredacted text to disk under a different session id.
      ...(config.redact ? { redact: config.redact } : {}),
      ...(config.audit ? { audit: config.audit } : {}),
      ...(this.cfg.auditSink ? { auditSink: this.cfg.auditSink } : {}),
      // Policy prompts are inherited, and deliberately so: a rule that holds for
      // the tree is worth nothing if delegating one step escapes it. The child
      // still gets its own transcript and its own system prompt.
      injectedPrompts: this.injector.list(),
      model: definition.model ?? config.model,
      workspaceRoot: config.workspaceRoot,
      homeDir: config.homeDir,
      ...(config.additionalRoots ? { additionalRoots: config.additionalRoots } : {}),
      systemPrompt: definition.prompt,
      // AGENTS.md is the parent's brief. The subagent gets the one this
      // definition wrote for it, plus the base tool-use rules.
      includeInstructions: false,
      builtinTools: definition.tools ?? READ_ONLY_BUILTINS,
      tools: [],
      skills: { enabled: false },
      memory: { enabled: false },
      session: { persist: false },
      permission: {
        ...(config.permission ?? {}),
        mode: definition.permissionMode ?? config.permission?.mode ?? 'default',
        onRequest: (request, childSignal) => this.hostChildPermission(request, childSignal),
      },
      maxSteps: definition.maxSteps ?? 12,
      logger: config.logger ?? noopLogger,
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      ...(config.subagentMaxDepth !== undefined ? { subagentMaxDepth: config.subagentMaxDepth } : {}),
    });
    child.installSubagents(config, depth);

    let lines = 0;
    const unsubscribe = child.on('*', (event) => {
      // A delegation that produced 5,000 progress lines is noise; the answer is
      // the result. Stop narrating and say that we stopped.
      if (lines === 60) report('… 子代理继续执行,后续活动不再逐条上报');
      if (lines > 60) return;
      const line = describeChildEvent(event);
      if (!line) return;
      lines++;
      report(line);
    });

    try {
      const result = await child.run(task, { signal }).result;
      return { text: result.text, stopReason: result.stopReason, steps: result.steps, usage: result.usage, sessionId: child.sessionId };
    } finally {
      unsubscribe();
      await child.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.activeRun?.controller.abort();
    try {
      await this.registry.sessionEnd({ sessionId: this.sessionId, runId: 'teardown', signal: new AbortController().signal });
    } catch {
      /* best effort */
    }
    if (this.cfg.ownsAuditSink) await this.cfg.auditSink?.close().catch(() => undefined);
    this.listeners.clear();
  }
}

interface PendingPermission {
  request: PermissionRequest;
  promise: Promise<PermissionResponse>;
  settle(response: PermissionResponse): void;
  answered?: boolean;
}

/**
 * One line of narration for a host watching a delegation through
 * `tool_progress`. Text deltas are left out on purpose - the child's prose
 * arrives as the delegation's result, and repeating it here would double the
 * token cost of every screen that shows both.
 */
function describeChildEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'tool_call_ready':
      return `子代理调用 ${event.title || event.name}`;
    case 'tool_result':
      return `${event.name} ${event.isError ? '失败' : '完成'}(${event.durationMs} ms)`;
    case 'permission_request':
      return `等待审批：${event.request.title}`;
    case 'compaction_end':
      return `压缩上下文：${event.tokensBefore} → ${event.tokensAfter} tokens`;
    case 'warning':
      return `警告：${event.message}`;
    case 'error':
      return `错误：${event.error.message}`;
    case 'run_end':
      return `子代理结束：${event.stopReason},${event.usage.totalTokens} tokens`;
    default:
      return undefined;
  }
}

interface ResolvedConfig {
  provider: ReturnType<typeof createProvider>;
  model: string;
  workspaceRoot: string;
  homeDir: string;
  sandbox: PathSandbox;
  registry: ToolRegistry;
  permission: PermissionEngine;
  sessionStore: SessionStore;
  sessionId?: string;
  skills?: SkillRegistry;
  memory?: MemoryStores;
  logger: Logger;
  maxSteps: number;
  budgetLedger: BudgetLedger;
  redactor: Redactor;
  auditSink?: AuditSink;
  /** False when the sink came in from a host or a parent, who then closes it. */
  ownsAuditSink: boolean;
  toolExecution: 'parallel' | 'sequential';
  contextWindow: number;
  /** True when the host fixed `compaction.contextWindow`, so a model change must not move it. */
  pinnedContextWindow: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  keepRecentToolResults: number;
  compactionEnabled: boolean;
  summaryModel?: string;
  includeBasePrompt: boolean;
  includeInstructions: boolean;
  injectedPrompts: InjectedPrompt[];
  instructionFileNames?: string[];
  instructionMaxBytes?: number;
  skillIssues: SkillIssue[];
  promptWarnings: Array<{ code: string; message: string }>;
  subagents?: SubagentDefinition[];
  temperature?: number;
  maxTokens?: number;
  stopWhen?: StopCondition | StopCondition[];
  systemPrompt?: string | ((env: PromptEnv) => string | Promise<string>);
  hooks?: AgentConfig['hooks'];
  onEvent?: (event: AgentEvent) => void;
  hostPermissionHandler?: PermissionConfig['onRequest'];
}

async function resolveConfig(config: AgentConfig): Promise<ResolvedConfig> {
  if (!config.provider) throw new ConfigError('createAgent requires a provider');
  const provider = createProvider(config.provider);
  const model = config.model ?? (provider as { defaultModel?: string }).defaultModel ?? '';
  if (!model) throw new ConfigError('No model configured: pass config.model or provider.model');
  const logger = config.logger ?? noopLogger;
  const workspaceRoot = path.resolve(config.workspaceRoot ?? process.cwd());
  const homeDir = path.resolve(config.homeDir ?? defaultHomeDir());

  const sandbox = new PathSandbox({ root: workspaceRoot, ...(config.additionalRoots ? { additionalRoots: config.additionalRoots } : {}) });
  const registry = new ToolRegistry();

  const memoryEnabled = config.memory?.enabled !== false;
  /*
   * 记忆默认落文件，浏览器端没有那个位置。要开记忆就**必须**宿主给 stores
   * （IndexedDB / localStorage 都行）—— 不给就直说，而不是悄悄建一个假的。
   */
  if (memoryEnabled && !(config.memory?.stores?.user && config.memory?.stores?.project)) {
    throw new ConfigError('浏览器端没有默认的文件记忆：请传 memory.stores，或 memory: { enabled: false }');
  }
  const stores: MemoryStores | undefined = memoryEnabled
    ? createMemoryStores({ user: config.memory!.stores!.user!, project: config.memory!.stores!.project! })
    : undefined;

  let skills: SkillRegistry | undefined;
  const skillIssues: SkillIssue[] = [];
  if (config.skills?.registry) {
    skills = config.skills.registry;
    skillIssues.push(...skills.errors);
  } else if (config.skills?.enabled !== false) {
    // Relative dirs are relative to the workspace, not to process.cwd(): a
    // host library must get the same skills whoever embedded it.
    const dirs = (config.skills?.dirs ?? [path.join(workspaceRoot, '.nosie', 'skills'), path.join(homeDir, '.nosie', 'skills')]).map((d) =>
      path.resolve(workspaceRoot, d),
    );
    skills = await loadSkills({ dirs, compat: config.skills?.compat, workspaceRoot, homeDir, logger });
    skillIssues.push(...skills.errors);
  }

  for (const tool of createBuiltinTools({ config, ...(skills ? { skills } : {}), ...(stores ? { memory: stores } : {}) })) {
    registry.register(tool);
  }
  for (const tool of config.tools ?? []) registry.register(tool);

  const permission = new PermissionEngine({ ...(config.permission ?? {}), onRequest: undefined });

  /*
   * MCP 不接：它要拉子进程 / 外部服务，浏览器端做不到，也没有那个信任边界。
   * 需要外部能力时请宿主自己把它们做成 Tool 传进来。
   */
  // （MCP 不接，见上）

  /*
   * 会话默认只放内存（落盘由宿主注入 `session.store`）。
   * 上游默认写 JSONL —— 那是文件，浏览器端没有；静默降级会让人以为聊过的内容留住了。
   */
  const sessionStore = config.session?.store ?? new InMemorySessionStore();

  const contextWindow =
    config.compaction?.contextWindow ??
    provider.contextWindow?.(model) ??
    128_000;

  // One redactor for the agent and everything it delegates to: a subagent that
  // writes its own transcript must not be the hole in the host's masking policy.
  const redactor = createRedactor(config.redact);
  const ownSink = config.auditSink === undefined;
  const auditSink = config.auditSink ?? createAuditSink(config.audit, redactor.active ? (text) => redactor.text(text) : undefined);
  void ownSink;

  return {
    ...config,
    provider,
    model,
    workspaceRoot,
    homeDir,
    sandbox,
    registry,
    permission,
    sessionStore,
    ...(config.session?.id ? { sessionId: config.session.id } : {}),
    // Assigned unconditionally: `...config` above carries the raw SkillsConfig /
    // MemoryConfig shapes, which must not survive as the resolved stores.
    skills,
    memory: stores,
    logger,
    maxSteps: config.maxSteps ?? 50,
    // Inherited wholesale when a host shares one purse across agents; otherwise
    // this tree's own. Subagents get this exact object, never a copy.
    budgetLedger: config.budgetLedger ?? new BudgetLedger(config.budget),
    redactor,
    ...(auditSink ? { auditSink } : {}),
    ownsAuditSink: ownSink,
    toolExecution: config.toolExecution ?? 'parallel',
    contextWindow,
    pinnedContextWindow: config.compaction?.contextWindow !== undefined,
    reserveTokens: config.compaction?.reserveTokens ?? 16_384,
    keepRecentTokens: config.compaction?.keepRecentTokens ?? 20_000,
    keepRecentToolResults: config.compaction?.keepRecentToolResults ?? 5,
    compactionEnabled: config.compaction?.enabled !== false,
    ...(config.compaction?.summaryModel ? { summaryModel: config.compaction.summaryModel } : {}),
    includeBasePrompt: config.includeBasePrompt !== false,
    includeInstructions: config.includeInstructions !== false,
    injectedPrompts: config.injectedPrompts ?? [],
    ...(config.memory?.instructionFiles ? { instructionFileNames: config.memory.instructionFiles } : {}),
    ...(config.memory?.instructionMaxBytes ? { instructionMaxBytes: config.memory.instructionMaxBytes } : {}),
    skillIssues,
    promptWarnings: [],
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    ...(config.stopWhen ? { stopWhen: config.stopWhen } : {}),
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
    hostPermissionHandler: config.permission?.onRequest,
  } as ResolvedConfig;
}

export async function createAgent(config: AgentConfig): Promise<Agent> {
  return Agent.create(config);
}

export { stepCountIs };
