import type { ChatRequest, LlmMessage, OpenAICompatibleOptions, Provider, ProviderCapabilities, ProviderEvent } from '../types/provider';
import type { FinishReason, Usage } from '../types/messages';
import { AuthError, ContextOverflowError, ProviderError } from '../types/errors';
import { parseSse } from './sse';
import { isRetryable, parseRetryAfter, RETRYABLE_STATUS, withRetry } from './retry';
import { sleep } from '../utils';
import { estimateTokensForLlmMessages } from '../runtime/tokens';

const DEFAULT_CAPS: ProviderCapabilities = {
  toolChoice: true,
  parallelToolCalls: true,
  reasoning: true,
  echoReasoning: false,
  imageInput: true,
  streamUsage: true,
};

const KNOWN_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/gpt-4\.1|gpt-4o|o[134](-|$)|gpt-5/i, 128_000],
  [/deepseek/i, 128_000],
  [/qwen.*(max|plus|turbo)/i, 128_000],
  [/claude/i, 200_000],
  [/gemini/i, 1_000_000],
  [/llama-?3/i, 128_000],
  [/mistral|mixtral/i, 32_000],
];

function inferCapabilities(baseURL: string, model: string): Partial<ProviderCapabilities> {
  const u = baseURL.toLowerCase();
  const m = model.toLowerCase();
  const caps: Partial<ProviderCapabilities> = {};
  if (/localhost:11434|127\.0\.0\.1:11434|ollama/.test(u)) {
    caps.toolChoice = false;
    caps.parallelToolCalls = false;
  }
  if (/deepseek|moonshot|kimi|dashscope|aliyuncs|qwen|zhipu|bigmodel|minimax/.test(u) || /deepseek|kimi|qwen|glm|minimax/.test(m)) {
    caps.echoReasoning = true;
  }
  if (/api\.openai\.com/.test(u)) caps.echoReasoning = false;
  return caps;
}

interface ToolCallSlot {
  id?: string;
  name?: string;
  started: boolean;
}

/**
 * Bounds how long a response may stay silent *after* its headers arrived.
 *
 * The fetch-level timer only covers the wait for headers; a proxy that opens an
 * SSE stream and then stops forwarding would otherwise hang the run forever,
 * with no event and no abort. Each streamed chunk re-arms this timer, so a slow
 * but living stream is never cut off.
 */
interface Watchdog {
  readonly signal: AbortSignal;
  touch(): void;
  readonly expired: boolean;
  dispose(): void;
}

function createWatchdog(caller: AbortSignal, idleMs: number): Watchdog {
  const inner = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  const arm = () => {
    if (idleMs <= 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      expired = true;
      // A stalled stream is the archetypal "the network is having a bad day":
      // retryable by definition, and worth saying so, because the classifier
      // looks at this flag and nothing else about the status.
      inner.abort(new ProviderError(`No data from the model for ${idleMs}ms`, { status: 408, retryable: true }));
    }, idleMs);
  };
  const onCallerAbort = () => inner.abort(caller.reason);
  caller.addEventListener('abort', onCallerAbort, { once: true });
  arm();
  return {
    signal: inner.signal,
    touch: arm,
    get expired() {
      return expired;
    },
    dispose() {
      clearTimeout(timer);
      caller.removeEventListener('abort', onCallerAbort);
    },
  };
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly defaultModel: string;
  private readonly opts: OpenAICompatibleOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.defaultModel = opts.model;
    this.id = `openai-compatible:${new URL(opts.baseURL).host}`;
    this.capabilities = { ...DEFAULT_CAPS, ...inferCapabilities(opts.baseURL, opts.model), ...opts.capabilities };
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  contextWindow(model: string): number | undefined {
    if (this.opts.contextWindow) return this.opts.contextWindow;
    for (const [re, n] of KNOWN_CONTEXT_WINDOWS) if (re.test(model)) return n;
    return undefined;
  }

  estimateTokens(messages: LlmMessage[]): number {
    return estimateTokensForLlmMessages(messages);
  }

  /**
   * `GET {baseURL}/models`. Most OpenAI-compatible servers implement it; ones
   * that do not simply fail, and it is up to the caller whether that matters -
   * a model list is a convenience for a picker, never a precondition for
   * running, because plenty of servers accept model ids they do not advertise.
   */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const url = `${this.opts.baseURL.replace(/\/+$/, '')}/models`;
    const headers: Record<string, string> = { accept: 'application/json', ...this.opts.headers };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    if (this.opts.organization) headers['openai-organization'] = this.opts.organization;
    const timeout = AbortSignal.timeout(15_000);
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((err: Error) => {
      throw new ProviderError(`Cannot reach ${url}: ${err.message}`, { retryable: true });
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError(`Model list failed: HTTP ${res.status} ${detail.slice(0, 200)}`.trim(), { status: res.status });
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model || this.defaultModel,
      messages: req.messages,
      stream: true,
      ...this.opts.defaultBody,
      ...req.extraBody,
    };
    if (this.capabilities.streamUsage) body.stream_options = { include_usage: true };
    if (req.tools?.length) {
      body.tools = req.tools;
      if (req.toolChoice && this.capabilities.toolChoice) {
        body.tool_choice = typeof req.toolChoice === 'string' ? req.toolChoice : { type: 'function', function: { name: req.toolChoice.name } };
      }
      if (req.parallelToolCalls !== undefined && this.capabilities.parallelToolCalls) body.parallel_tool_calls = req.parallelToolCalls;
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.stop?.length) body.stop = req.stop;
    return body;
  }

  private headers(req: ChatRequest): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...this.opts.headers,
      ...req.extraHeaders,
    };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    if (this.opts.organization) h['openai-organization'] = this.opts.organization;
    return h;
  }

  async *stream(req: ChatRequest, { signal }: { signal: AbortSignal }): AsyncIterable<ProviderEvent> {
    const url = `${this.opts.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const body = JSON.stringify(this.buildBody(req));
    const headers = this.headers(req);
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    // Two different failures wear the same coat. A refused connection is cheap to
    // retry and invisible to the caller. A stream that dies after the first delta
    // has already been handed over is neither: the caller has rendered text that
    // is about to be re-generated. That case gets an explicit `reset` event so
    // partial output is discarded rather than duplicated.
    const maxResets = this.opts.streamResets ?? 2;
    let resets = 0;

    while (true) {
      const response = await withRetry(
        async () => {
          const ctrl = new AbortController();
          const onAbort = () => ctrl.abort(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          // timeoutMs <= 0 means "no bound"; setTimeout(fn, 0) would abort at once.
          const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(new ProviderError('Request timed out', { retryable: true })), timeoutMs) : undefined;
          try {
            const res = await this.fetchImpl(url, { method: 'POST', headers, body, signal: ctrl.signal });
            if (!res.ok) throw await this.toError(res);
            if (!res.body) throw new ProviderError('Empty response body', { status: res.status });
            clearTimeout(timer);
            return { res, cleanup: () => signal.removeEventListener('abort', onAbort) };
          } catch (e) {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            if (signal.aborted) throw signal.reason ?? e;
            throw e;
          }
        },
        { maxRetries: this.opts.maxRetries ?? 3, signal },
      );

      const watchdog = createWatchdog(signal, timeoutMs);
      let delivered = false;
      try {
        for await (const ev of this.parseStream(response.res, watchdog)) {
          delivered = true;
          yield ev;
        }
        return;
      } catch (err) {
        if (signal.aborted || resets >= maxResets || !isRetryable(err)) throw err;
        resets++;
        // Nothing rendered yet, so nothing to roll back: re-issue quietly.
        if (delivered) yield { type: 'reset', attempt: resets };
        await sleep(Math.min(2_000, 200 * 2 ** (resets - 1)), signal);
      } finally {
        watchdog.dispose();
        response.cleanup();
      }
    }
  }

  private async toError(res: Response): Promise<ProviderError> {
    let text = '';
    let json: unknown;
    try {
      text = await res.text();
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    const errObj = (json as { error?: { message?: string; code?: string; type?: string } } | undefined)?.error;
    const message = errObj?.message ?? (text || res.statusText || `HTTP ${res.status}`);
    const retryAfterMs = parseRetryAfter(res.headers);
    if (res.status === 401 || res.status === 403) return new AuthError(message, res.status, json);
    if (res.status === 400 || res.status === 413) {
      if (/context.?length|maximum context|too many tokens|token limit|context window|prompt is too long|exceeds the limit/i.test(message) || errObj?.code === 'context_length_exceeded') {
        return new ContextOverflowError(message, json);
      }
    }
    return new ProviderError(message, {
      status: res.status,
      retryable: RETRYABLE_STATUS.has(res.status),
      details: { body: json ?? text, retryAfterMs, code: errObj?.code, type: errObj?.type },
    });
  }

  private async *parseStream(res: Response, watchdog: Watchdog): AsyncGenerator<ProviderEvent> {
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const json = (await res.json()) as Record<string, unknown>;
      yield* this.fromNonStreaming(json);
      return;
    }
    const slots = new Map<number, ToolCallSlot>();
    let finish: FinishReason | undefined;
    let usage: Usage | undefined;

    for await (const ev of parseSse(res.body!, watchdog.signal, watchdog.touch)) {
      const data = ev.data.trim();
      if (!data || data === '[DONE]') continue;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) {
        const e = chunk.error as { message?: string };
        throw new ProviderError(e.message ?? 'Stream error', { details: chunk.error });
      }
      if (chunk.usage) usage = normalizeUsage(chunk.usage as Record<string, unknown>);
      const choices = (chunk.choices as Array<Record<string, unknown>> | undefined) ?? [];
      for (const choice of choices) {
        const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
        const reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
        if (typeof reasoning === 'string' && reasoning.length) yield { type: 'reasoning_delta', delta: reasoning };
        if (typeof delta.content === 'string' && delta.content.length) yield { type: 'text_delta', delta: delta.content };
        const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            const index = typeof tc.index === 'number' ? tc.index : slots.size;
            const fn = (tc.function as { name?: string; arguments?: string } | undefined) ?? {};
            let slot = slots.get(index);
            if (!slot) {
              slot = { started: false };
              slots.set(index, slot);
            }
            if (typeof tc.id === 'string' && tc.id) slot.id = tc.id;
            if (typeof fn.name === 'string' && fn.name) slot.name = slot.name ? slot.name : fn.name;
            if (!slot.started) {
              slot.started = true;
              yield { type: 'tool_call_start', index, id: slot.id, name: slot.name };
            }
            if (typeof fn.arguments === 'string' && fn.arguments.length) {
              yield { type: 'tool_call_delta', index, argsDelta: fn.arguments, id: slot.id, name: slot.name };
            } else if ((tc.id || fn.name) && !fn.arguments) {
              yield { type: 'tool_call_delta', index, argsDelta: '', id: slot.id, name: slot.name };
            }
          }
        }
        const fr = choice.finish_reason as string | null | undefined;
        if (fr) finish = normalizeFinish(fr, slots.size > 0);
      }
    }
    if (watchdog.expired) throw watchdog.signal.reason;
    if (usage) yield { type: 'usage', usage };
    yield { type: 'finish', reason: finish ?? (slots.size ? 'tool_calls' : 'stop') };
  }

  private *fromNonStreaming(json: Record<string, unknown>): Generator<ProviderEvent> {
    const choice = ((json.choices as Array<Record<string, unknown>> | undefined) ?? [])[0];
    const msg = (choice?.message as Record<string, unknown> | undefined) ?? {};
    const reasoning = (msg.reasoning_content ?? msg.reasoning) as string | undefined;
    if (reasoning) yield { type: 'reasoning_delta', delta: reasoning };
    if (typeof msg.content === 'string' && msg.content) yield { type: 'text_delta', delta: msg.content };
    const toolCalls = (msg.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
    for (const [index, tc] of toolCalls.entries()) {
      const fn = (tc.function as { name?: string; arguments?: string }) ?? {};
      const id = tc.id as string | undefined;
      yield { type: 'tool_call_start', index, id, name: fn.name };
      yield { type: 'tool_call_delta', index, argsDelta: fn.arguments ?? '', id, name: fn.name };
    }
    if (json.usage) yield { type: 'usage', usage: normalizeUsage(json.usage as Record<string, unknown>) };
    yield { type: 'finish', reason: normalizeFinish((choice?.finish_reason as string) ?? 'stop', toolCalls.length > 0) };
  }
}

function normalizeUsage(u: Record<string, unknown>): Usage {
  const prompt = Number(u.prompt_tokens ?? 0);
  const completion = Number(u.completion_tokens ?? 0);
  const details = (u.completion_tokens_details as { reasoning_tokens?: number } | undefined) ?? undefined;
  const pDetails = (u.prompt_tokens_details as { cached_tokens?: number } | undefined) ?? undefined;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Number(u.total_tokens ?? prompt + completion),
    reasoningTokens: details?.reasoning_tokens,
    cachedPromptTokens: pDetails?.cached_tokens ?? (u.prompt_cache_hit_tokens as number | undefined),
  };
}

function normalizeFinish(fr: string, hasToolCalls: boolean): FinishReason {
  switch (fr) {
    case 'stop':
      return hasToolCalls ? 'tool_calls' : 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return hasToolCalls ? 'tool_calls' : 'unknown';
  }
}

export function createProvider(input: Provider | OpenAICompatibleOptions): Provider {
  if (typeof (input as Provider).stream === 'function') return input as Provider;
  return new OpenAICompatibleProvider(input as OpenAICompatibleOptions);
}
