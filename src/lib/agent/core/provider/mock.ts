import type { ChatRequest, Provider, ProviderCapabilities, ProviderEvent } from '../types/provider';
import type { Usage } from '../types/messages';
import { AbortedError } from '../types/errors';

export interface MockToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown> | string;
}

export type MockTurnSpec = {
  text?: string;
  reasoning?: string;
  toolCalls?: MockToolCall[];
  usage?: Partial<Usage>;
  finish?: 'stop' | 'length' | 'tool_calls';
  error?: Error;
  delayMs?: number;
  chunkSize?: number;
};

export type MockTurn = string | MockTurnSpec | ((req: ChatRequest, turn: number) => MockTurn | Promise<MockTurn>);

function normalizeUsage(u: Partial<Usage> | undefined, fallback: { promptTokens: number; completionTokens: number }): Usage {
  const promptTokens = u?.promptTokens ?? fallback.promptTokens;
  const completionTokens = u?.completionTokens ?? fallback.completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: u?.totalTokens ?? promptTokens + completionTokens,
    reasoningTokens: u?.reasoningTokens,
    cachedPromptTokens: u?.cachedPromptTokens,
  };
}

export class MockProvider implements Provider {
  readonly id = 'mock';
  readonly capabilities: ProviderCapabilities = {
    toolChoice: true,
    parallelToolCalls: true,
    reasoning: true,
    echoReasoning: false,
    imageInput: true,
    streamUsage: true,
  };
  readonly defaultModel = 'mock-model';
  readonly requests: ChatRequest[] = [];
  private turns: MockTurn[];
  private turn = 0;
  private window: number;

  constructor(turns: MockTurn[] = [], opts: { contextWindow?: number } = {}) {
    this.turns = [...turns];
    this.window = opts.contextWindow ?? 128_000;
  }

  contextWindow(): number {
    return this.window;
  }

  enqueue(...turns: MockTurn[]): void {
    this.turns.push(...turns);
  }

  reset(): void {
    this.turn = 0;
    this.requests.length = 0;
  }

  async *stream(req: ChatRequest, { signal }: { signal: AbortSignal }): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    let raw: MockTurn | undefined = this.turns[this.turn];
    if (raw === undefined) raw = { text: '(mock: no more scripted turns)' };
    const turnIndex = this.turn++;
    while (typeof raw === 'function') raw = await raw(req, turnIndex);
    const spec: MockTurnSpec = typeof raw === 'string' ? { text: raw } : raw;

    if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
    if (signal.aborted) throw new AbortedError();
    if (spec.error) throw spec.error;

    const size = Math.max(1, spec.chunkSize ?? 8);
    if (spec.reasoning) {
      for (let i = 0; i < spec.reasoning.length; i += size) yield { type: 'reasoning_delta', delta: spec.reasoning.slice(i, i + size) };
    }
    if (spec.text) {
      for (let i = 0; i < spec.text.length; i += size) {
        if (signal.aborted) throw new AbortedError();
        yield { type: 'text_delta', delta: spec.text.slice(i, i + size) };
      }
    }

    const calls = spec.toolCalls ?? [];
    let argsLength = 0;
    calls.forEach((c, index) => {
      void index;
      void c.id;
      argsLength += typeof c.args === 'string' ? c.args.length : JSON.stringify(c.args ?? {}).length;
    });

    const promptTokens = Math.ceil(JSON.stringify(req.messages).length / 4);
    const completionTokens = Math.ceil(((spec.text ?? '').length + (spec.reasoning ?? '').length + argsLength) / 4);

    const pending: ProviderEvent[] = [];
    calls.forEach((c, index) => {
      const id = c.id ?? `call_mock_${turnIndex}_${index}`;
      const args = typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {});
      pending.push({ type: 'tool_call_start', index, id, name: c.name });
      for (let i = 0; i < args.length; i += size) pending.push({ type: 'tool_call_delta', index, argsDelta: args.slice(i, i + size), id, name: c.name });
      if (!args.length) pending.push({ type: 'tool_call_delta', index, argsDelta: '', id, name: c.name });
    });
    for (const ev of pending) yield ev;

    yield { type: 'usage', usage: normalizeUsage(spec.usage, { promptTokens, completionTokens }) };
    yield { type: 'finish', reason: spec.finish ?? (calls.length ? 'tool_calls' : 'stop') };
  }
}
