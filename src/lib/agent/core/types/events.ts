import type { ContentBlock, FinishReason, Message, Usage } from './messages';
import type { PermissionOption, PermissionOptionId, ToolKind } from './permission';

export type StopReason =
  | 'end_turn'
  | 'max_steps'
  /** The whole agent tree hit its `budget` ceiling — a run's own `maxSteps` is not this. */
  | 'budget'
  | 'cancelled'
  | 'error'
  | 'stop_condition'
  | 'max_tokens';

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  details?: unknown;
}

export interface CumulativeUsage extends Usage {
  requests: number;
}

export type AgentEvent =
  | { type: 'run_start'; runId: string; sessionId: string }
  | { type: 'step_start'; runId: string; step: number }
  | { type: 'text_start'; messageId: string }
  | { type: 'text_delta'; messageId: string; delta: string }
  /**
   * The stream carrying this message died and is being re-issued: drop anything
   * rendered under `messageId`. Another `text_start` follows if the retry
   * produces output; `text_end` is not emitted for a discarded attempt, because
   * the message is not finished — it is being started over.
   */
  | { type: 'text_reset'; messageId: string }
  | { type: 'text_end'; messageId: string; text: string }
  | { type: 'reasoning_start'; messageId: string }
  | { type: 'reasoning_delta'; messageId: string; delta: string }
  | { type: 'reasoning_reset'; messageId: string }
  | { type: 'reasoning_end'; messageId: string; text: string }
  | { type: 'tool_call_start'; messageId: string; toolCallId: string; name: string }
  | { type: 'tool_call_delta'; messageId: string; toolCallId: string; argsDelta: string }
  | { type: 'tool_call_ready'; messageId: string; toolCallId: string; name: string; args: Record<string, unknown>; kind: ToolKind; title: string }
  | { type: 'tool_status'; toolCallId: string; name: string; status: import('./messages').ToolCallStatus }
  | { type: 'tool_progress'; toolCallId: string; name: string; text: string }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_resolved'; requestId: string; toolCallId: string; optionId: PermissionOptionId | 'cancelled' }
  | { type: 'tool_result'; toolCallId: string; name: string; content: ContentBlock[]; isError: boolean; durationMs: number; meta?: Record<string, unknown> }
  | { type: 'message'; message: Message }
  | { type: 'step_end'; runId: string; step: number; finishReason: FinishReason; usage?: Usage }
  | { type: 'compaction_start'; tokensBefore: number; strategy: 'clear_tool_results' | 'summarize' }
  | { type: 'compaction_end'; tokensBefore: number; tokensAfter: number; strategy: 'clear_tool_results' | 'summarize'; summary?: string }
  | { type: 'memory_update'; op: 'save' | 'forget'; name: string; scope: 'user' | 'project' }
  | { type: 'usage'; usage: Usage; cumulative: CumulativeUsage }
  | { type: 'warning'; code: string; message: string; details?: unknown }
  | { type: 'error'; error: SerializedError; fatal: boolean }
  | { type: 'run_end'; runId: string; stopReason: StopReason; usage: CumulativeUsage; error?: SerializedError };

export type AgentEventType = AgentEvent['type'];

export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  kind: ToolKind;
  title: string;
  options: PermissionOption[];
  reason?: string;
}

export interface RunResult {
  runId: string;
  stopReason: StopReason;
  text: string;
  messages: Message[];
  usage: CumulativeUsage;
  steps: number;
  error?: SerializedError;
}
