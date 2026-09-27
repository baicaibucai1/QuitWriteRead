import type { ChatRequest, LlmMessage } from './provider';
import type { CompactionEntry, ContentBlock, Message, ToolMessage, UserMessage, AssistantMessage } from './messages';
import type { PermissionDecision } from './permission';
import type { PermissionRequest, RunResult } from './events';
import type { Tool, ToolResult } from './tools';

export interface HookContext {
  sessionId: string;
  runId: string;
  signal: AbortSignal;
}

export interface ToolCallInfo {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  tool: Tool;
}

export interface PreToolUseOutput {
  permissionDecision?: PermissionDecision;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}

export interface CompactionPlan {
  strategy: 'clear_tool_results' | 'summarize';
  tokensBefore: number;
  messagesToSummarize: Message[];
  summaryPrompt: string;
}

export interface Hooks {
  SessionStart?: Array<(ctx: HookContext) => void | Promise<void>>;
  SessionEnd?: Array<(ctx: HookContext) => void | Promise<void>>;
  UserPromptSubmit?: Array<(input: ContentBlock[], ctx: HookContext) => ContentBlock[] | void | Promise<ContentBlock[] | void>>;
  PreModelCall?: Array<(request: ChatRequest, ctx: HookContext) => ChatRequest | void | Promise<ChatRequest | void>>;
  PostModelCall?: Array<(message: AssistantMessage, ctx: HookContext) => void | Promise<void>>;
  PreToolUse?: Array<(call: ToolCallInfo, ctx: HookContext) => PreToolUseOutput | void | Promise<PreToolUseOutput | void>>;
  PostToolUse?: Array<(call: ToolCallInfo, result: ToolResult, ctx: HookContext) => ToolResult | void | Promise<ToolResult | void>>;
  PostToolUseFailure?: Array<(call: ToolCallInfo, error: unknown, ctx: HookContext) => void | Promise<void>>;
  PermissionRequest?: Array<(request: PermissionRequest, ctx: HookContext) => void | Promise<void>>;
  PermissionDenied?: Array<(call: ToolCallInfo, reason: string, ctx: HookContext) => void | Promise<void>>;
  PreCompact?: Array<(plan: CompactionPlan, ctx: HookContext) => CompactionPlan | false | void | Promise<CompactionPlan | false | void>>;
  PostCompact?: Array<(entry: CompactionEntry, ctx: HookContext) => void | Promise<void>>;
  Stop?: Array<(result: RunResult, ctx: HookContext) => void | Promise<void>>;
  transformContext?: Array<(messages: LlmMessage[], ctx: HookContext) => LlmMessage[] | Promise<LlmMessage[]>>;
}

export type HookName = keyof Hooks;

export type { UserMessage, ToolMessage };
