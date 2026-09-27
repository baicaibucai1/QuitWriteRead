import type { AgentEvent } from './events';
import type { Hooks } from './hooks';
import type { PermissionConfig, PermissionMode } from './permission';
import type { OpenAICompatibleOptions, Provider } from './provider';
import type { Logger, Tool } from './tools';
import type { MemoryStore } from '../memory/store';
import type { SkillRegistry } from '../skills/loader';
import type { SessionStore } from '../session/store';
import type { StopCondition } from '../runtime/stop';
import type { BudgetLedger, BudgetLimits } from '../runtime/budget';
import type { RedactionPolicy } from '../runtime/redact';
import type { AuditConfig, AuditSink } from '../runtime/audit';

export type BuiltinToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_dir'
  | 'glob'
  | 'grep'
  | 'shell'
  | 'memory_save'
  | 'memory_search'
  | 'memory_forget'
  | 'skill'
  | 'task';

export interface SkillsConfig {
  enabled?: boolean;
  dirs?: string[];
  compat?: boolean;
  /** Use a registry the host built itself; skips the on-disk scan. */
  registry?: SkillRegistry;
}

export interface MemoryConfig {
  enabled?: boolean;
  userDir?: string;
  projectDir?: string;
  stores?: { user?: MemoryStore; project?: MemoryStore };
  instructionFiles?: string[];
  instructionMaxBytes?: number;
}

export interface SessionConfig {
  store?: SessionStore;
  id?: string;
  dir?: string;
  persist?: boolean;
}

export interface CompactionConfig {
  enabled?: boolean;
  contextWindow?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  keepRecentToolResults?: number;
  summaryModel?: string;
}

/**
 * A specialist the model may delegate a self-contained subtask to. The child
 * runs its own loop in the same sandbox with its own transcript; the parent only
 * sees the task text it handed over and the answer that came back.
 */
export interface SubagentDefinition {
  name: string;
  /** Goes into the delegating tool's description: say when to use this one. */
  description: string;
  /** The child's system prompt. The child never sees the parent's conversation. */
  prompt: string;
  /** Built-in tools the child may call. Defaults to the read-only set. */
  tools?: BuiltinToolName[];
  /** Inherits the parent's model when omitted. */
  model?: string;
  /** Permission mode for the child; approvals still surface to the parent's host. */
  permissionMode?: PermissionMode;
  maxSteps?: number;
}

export interface ShellToolConfig {
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputChars?: number;
  shell?: string;
  env?: Record<string, string>;
}

/**
 * A prompt the kernel puts in front of the model on *every* request — not
 * remembered in the transcript, so nothing can lose it: not compaction, not a
 * context hook, not the model's own drift.
 *
 * This is the channel for policy that must hold for the whole session
 * ("answers must cite a file", "you are in read-only mode"), which the system
 * prompt is too blunt for and `transformContext` too fragile for — a hook that
 * rewrites the message list can drop a reminder by accident, and this one cannot
 * be dropped by anything except `withdraw()`.
 */
export interface InjectedPrompt {
  /**
   * Dedup key. Re-adding an id replaces the earlier text instead of stacking a
   * second copy, so a host that re-declares its policy every turn does not pay
   * for it twice per step. Auto-generated when omitted.
   */
  id?: string;
  /**
   * The text, or a function evaluated per provider step — which is what makes
   * live state injectable (clock, budget left, mode) without ever writing it to
   * the transcript. Return `undefined` to skip this prompt for that step.
   */
  text: string | ((ctx: InjectionContext) => string | undefined | Promise<string | undefined>);
  /** Defaults to `'system'`: a forced prompt is a rule, not something the model may answer. */
  role?: 'system' | 'user';
  /**
   * `'head'` (default) goes directly after the system prompt, before the
   * conversation. `'tail'` goes after the last message, which is where a
   * reminder that must not be skimmed over belongs.
   */
  position?: 'head' | 'tail';
}

export interface InjectionContext {
  sessionId: string;
  /** 1-based provider step within the current run. */
  step: number;
  model: string;
  permissionMode: PermissionMode;
}

export interface AgentConfig {
  provider: Provider | OpenAICompatibleOptions;
  model?: string;
  workspaceRoot?: string;
  additionalRoots?: string[];
  systemPrompt?: string | ((env: PromptEnv) => string | Promise<string>);
  includeBasePrompt?: boolean;
  /** Set false to skip the AGENTS.md / NOSIE.md instruction chain. */
  includeInstructions?: boolean;
  /**
   * Prompts re-sent with every request, outside the transcript, so compaction and
   * context hooks cannot lose them. Mutate them mid-session with
   * `agent.inject()` / `agent.withdrawInjection()`.
   */
  injectedPrompts?: InjectedPrompt[];
  tools?: Tool[];
  builtinTools?: boolean | BuiltinToolName[];
  shell?: ShellToolConfig;
  permission?: PermissionConfig;
  hooks?: Hooks;
  skills?: SkillsConfig;
  memory?: MemoryConfig;
  session?: SessionConfig;
  compaction?: CompactionConfig;
  stopWhen?: StopCondition | StopCondition[];
  maxSteps?: number;
  /**
   * Specialists the model can delegate to through the built-in `task` tool.
   * Registering the tool also needs `'task'` in `builtinTools`, which the
   * default selection already has.
   */
  subagents?: SubagentDefinition[];
  /** How deep a subagent may delegate again. 1 = children cannot spawn. */
  subagentMaxDepth?: number;
  /**
   * Ceiling for the whole agent tree: this run, every subagent it delegates to,
   * and their children. `maxSteps` bounds a single loop and says nothing about a
   * model that fans out into parallel `task` calls — each branch behaves, and
   * the total does not. This is the knob that stops the bill, checked before
   * every provider step and before every delegation.
   */
  budget?: BudgetLimits;
  /**
   * Share one purse across agents that should spend together — several sessions
   * in one process, a worker pool, or a parent handing its ledger to a child it
   * built itself. Omit it and each agent tree accounts on its own.
   */
  budgetLedger?: BudgetLedger;
  toolExecution?: 'parallel' | 'sequential';
  temperature?: number;
  maxTokens?: number;
  logger?: Logger;
  homeDir?: string;
  /**
   * Mask secrets on the way *out*: into the session store and the audit log. The
   * live transcript keeps what the model sent (rewriting it mid-run would change
   * what the model believes it did); the files that outlive the process do not.
   */
  redact?: RedactionPolicy;
  /** Append-only record of permission decisions. Off unless configured. */
  audit?: AuditConfig;
  /**
   * Share one audit sink (file handle, ordering chain) across agents that should
   * write to the same trail. `createAgent` opens it and closes it; an agent handed
   * a sink leaves it open for its owner. Subagents inherit theirs automatically.
   */
  auditSink?: AuditSink;
  /**
   * Sees every event, including the ones `createAgent` emits before it returns
   * (skill/MCP load warnings). `agent.on()` cannot report those.
   */
  onEvent?: (event: AgentEvent) => void;
}

export interface PromptEnv {
  cwd: string;
  platform: string;
  date: string;
  model: string;
  home?: string;
}
