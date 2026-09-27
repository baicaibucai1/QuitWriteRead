export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; text?: string; mimeType?: string };

export type ToolCallStatus =
  | 'pending'
  | 'awaiting_permission'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'cancelled';

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'aborted'
  | 'unknown';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedPromptTokens?: number;
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  raw?: unknown;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
  rawArgs: string;
  status: ToolCallStatus;
}

export type AssistantPart = TextPart | ReasoningPart | ToolCallPart;

interface BaseMessage {
  id: string;
  role: Role;
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface SystemMessage extends BaseMessage {
  role: 'system';
  content: string;
}

export interface UserMessage extends BaseMessage {
  role: 'user';
  content: ContentBlock[];
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  parts: AssistantPart[];
  finishReason?: FinishReason;
  usage?: Usage;
  model?: string;
}

export interface ToolMessage extends BaseMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  isError: boolean;
  durationMs?: number;
  /**
   * Whatever the tool reported alongside its content (`ToolResult.meta`). Kept
   * in the transcript because that metadata is often the only record of what a
   * tool actually cost or spawned - a delegation's steps and tokens live here,
   * and a host reading history later would otherwise lose them.
   */
  meta?: Record<string, unknown>;
  cleared?: boolean;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface CompactionEntry {
  kind: 'compaction';
  id: string;
  summary: string;
  coversMessageIds: string[];
  createdAt: number;
  tokensBefore: number;
  tokensAfter: number;
  strategy: 'clear_tool_results' | 'summarize';
}

export interface SessionMeta {
  kind: 'meta';
  sessionId: string;
  createdAt: number;
  cwd: string;
  title?: string;
  meta?: Record<string, unknown>;
}

export type SessionEntry = { kind: 'message'; message: Message } | CompactionEntry | SessionMeta;

export function textOf(blocks: ContentBlock[] | string): string {
  if (typeof blocks === 'string') return blocks;
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'resource') return b.text ?? `[resource ${b.uri}]`;
      return `[image ${b.mimeType}]`;
    })
    .join('\n');
}

export function toBlocks(input: string | ContentBlock[]): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input;
}

/**
 * How a compaction summary is announced to the model.
 *
 * The run loop and the session assembler each build this message — one for the
 * rest of the live run, one for every later reload — and they share the string so
 * the two cannot drift. A summary that only appeared after a reload would mean a
 * model that forgot the first half of its own run while still in it.
 */
export const SUMMARY_PREAMBLE = 'This conversation was compacted. Summary of the earlier portion:\n\n';
