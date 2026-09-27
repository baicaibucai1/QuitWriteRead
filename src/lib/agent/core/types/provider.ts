import type { FinishReason, Usage } from './messages';
import type { JSONSchema } from './tools';

export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | LlmContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: LlmToolCall[];
      reasoning_content?: string;
      [extra: string]: unknown;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface LlmToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: JSONSchema };
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface ChatRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  toolChoice?: ToolChoice;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  parallelToolCalls?: boolean;
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

export type ProviderEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id?: string; name?: string }
  | { type: 'tool_call_delta'; index: number; argsDelta: string; id?: string; name?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason; raw?: unknown }
  /**
   * The stream died after content had already been delivered, and the provider
   * is re-issuing the request. Everything accumulated so far for this message is
   * void — a consumer that rendered it must clear it, or the retry appears twice.
   */
  | { type: 'reset'; attempt: number };

export interface ProviderCapabilities {
  toolChoice: boolean;
  parallelToolCalls: boolean;
  reasoning: boolean;
  echoReasoning: boolean;
  imageInput: boolean;
  streamUsage: boolean;
}

export interface Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly defaultModel?: string;
  stream(req: ChatRequest, opts: { signal: AbortSignal }): AsyncIterable<ProviderEvent>;
  /**
   * Model ids the endpoint advertises, for a picker. Optional because it is a
   * convenience: a provider that cannot list still runs, and an unlisted model
   * is not necessarily wrong.
   */
  listModels?(signal?: AbortSignal): Promise<string[]>;
  estimateTokens?(messages: LlmMessage[]): number;
  contextWindow?(model: string): number | undefined;
}

export interface OpenAICompatibleOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  organization?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * How many times a stream that already started may be re-issued after dying
   * mid-body. Separate from `maxRetries` because each of those costs a full
   * completion of whatever the model already produced. 0 turns the recovery off;
   * the default of 2 keeps a flaky link usable without an unbounded spend.
   */
  streamResets?: number;
  capabilities?: Partial<ProviderCapabilities>;
  contextWindow?: number;
  fetch?: typeof fetch;
  defaultBody?: Record<string, unknown>;
}
