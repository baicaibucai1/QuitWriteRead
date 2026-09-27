import type { CompactionEntry, Message } from '../types/messages';
import type { Provider } from '../types/provider';
import type { CompactionPlan } from '../types/hooks';
import { newId } from '../utils';
import { estimateTokensForMessages } from './tokens';
import { TokenCalibrator } from './tokens';

export interface CompactionOptions {
  enabled?: boolean;
  contextWindow: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  keepRecentToolResults?: number;
  summaryModel?: string;
}

const DEFAULT_RESERVE = 16_384;
const DEFAULT_KEEP_RECENT = 20_000;
const DEFAULT_KEEP_TOOL_RESULTS = 5;

export const SUMMARY_PROMPT = `You are compressing an agent transcript so another instance of the agent can continue the task with full fidelity. Write a summary that preserves signal and drops noise.

Use exactly these sections, omitting any that would be empty:

1. Primary Request and Intent — everything the user asked for, in their terms.
2. Key Technical Concepts — technologies, APIs, patterns that matter going forward.
3. Files and Code Sections — every file read, created or modified, with why it mattered and the essential code shape.
4. Errors and Fixes — what broke, what the fix was, and what the user said about it.
5. Problem Solving — decisions taken and their reasoning, including options rejected.
6. All User Messages — every user message in chronological order, quoted or near-quoted. Never paraphrase away an instruction.
7. Pending Tasks — explicitly requested work that is not finished.
8. Current Work — the exact state at the cut point: files open, command running, last tool result.
9. Optional Next Step — the single most useful action, with the evidence that justifies it.

Be dense. Do not narrate your process. Keep identifiers, paths, numbers and flags verbatim.`;

interface AssembledView {
  messages: Message[];
  clearedIds: Set<string>;
}

export class ContextManager {
  private opts: Required<Omit<CompactionOptions, 'summaryModel'>> & { summaryModel?: string };
  readonly calibrator = new TokenCalibrator();

  constructor(opts: CompactionOptions) {
    this.opts = {
      enabled: opts.enabled !== false,
      contextWindow: Math.max(4096, opts.contextWindow),
      reserveTokens: opts.reserveTokens ?? DEFAULT_RESERVE,
      keepRecentTokens: opts.keepRecentTokens ?? DEFAULT_KEEP_RECENT,
      keepRecentToolResults: opts.keepRecentToolResults ?? DEFAULT_KEEP_TOOL_RESULTS,
      summaryModel: opts.summaryModel,
    };
  }

  /**
   * What the model may actually be sent, and the two halves that decide it.
   *
   * The reserve is clamped against the window only when it genuinely cannot fit:
   * a host (or a model switch) that leaves an 8k window with the default 16k
   * reserve would get a negative budget, `isOverflow()` would answer true for any
   * transcript, and compaction would run every step without ever catching up. A
   * reservation that cannot fit inside its own window is a mistake the kernel has
   * to survive — but a reserve that merely *fills* a window is a legitimate
   * choice, so ordinary configurations keep their exact arithmetic.
   */
  private get minBudget(): number {
    return Math.max(1_024, Math.floor(this.opts.contextWindow / 4));
  }

  private get reserve(): number {
    return Math.min(this.opts.reserveTokens, this.opts.contextWindow - this.minBudget);
  }

  get budget(): number {
    return this.opts.contextWindow - this.reserve;
  }

  /** Never keep more recent history than the conversation can hold alongside it. */
  private get keepRecent(): number {
    return Math.min(this.opts.keepRecentTokens, Math.max(512, Math.floor(this.budget / 2)));
  }

  /**
   * Re-derive the window when the conversation moves to another model.
   *
   * The window is a property of the model, not of the session: switching from a
   * 128k model to an 8k one without this leaves compaction asleep until 128k, so
   * the provider answers with a context error instead of the kernel trimming.
   */
  setWindow(contextWindow: number): void {
    this.opts.contextWindow = Math.max(4096, Math.floor(contextWindow));
  }

  get window(): number {
    return this.opts.contextWindow;
  }

  estimate(messages: Message[]): number {
    return this.calibrator.scale(estimateTokensForMessages(messages));
  }

  /**
   * `extra` is what the request will carry *besides* the transcript — the forced
   * injections — because those go out with every call and no amount of trimming
   * the history will make room for them.
   */
  isOverflow(messages: Message[], extra = 0): boolean {
    if (!this.opts.enabled) return false;
    return this.estimate(messages) + extra > this.budget;
  }

  /**
   * Stage 1 costs no API call: old tool outputs are the lowest-signal, highest-
   * volume content in a coding transcript. Only marks locally; the caller
   * decides whether to persist.
   */
  clearOldToolResults(messages: Message[]): AssembledView {
    const toolIndexes: number[] = [];
    messages.forEach((m, i) => {
      if (m.role === 'tool') toolIndexes.push(i);
    });
    const keepFrom = Math.max(0, toolIndexes.length - this.opts.keepRecentToolResults);
    const clearedIds = new Set<string>();
    const out = messages.map((m, i) => {
      if (m.role !== 'tool') return m;
      const position = toolIndexes.indexOf(i);
      if (position >= keepFrom) return m;
      clearedIds.add(m.id);
      return { ...m, cleared: true };
    });
    return { messages: out, clearedIds };
  }

  /**
   * Stage 2: pick a cut point that keeps the recent tail, never splitting an
   * assistant tool_call from its tool result, never splitting a summary request
   * mid-conversation.
   */
  findCut(messages: Message[]): number {
    let acc = 0;
    let cut = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      acc += this.estimate([messages[i]!]);
      if (acc > this.keepRecent) {
        cut = i + 1;
        break;
      }
    }
    cut = this.advancePastToolPair(messages, cut);
    if (cut <= 0) cut = this.advancePastToolPair(messages, Math.floor(messages.length / 2));
    return Math.min(cut, messages.length);
  }

  private advancePastToolPair(messages: Message[], cut: number): number {
    let c = cut;
    while (c > 0 && c < messages.length) {
      const first = messages[c]!;
      if (first.role === 'tool') {
        c++;
        continue;
      }
      const prev = messages[c - 1]!;
      if (prev.role === 'assistant' && prev.parts.some((p) => p.type === 'tool_call' && !hasResult(messages, c, p.id))) {
        c++;
        continue;
      }
      break;
    }
    return c;
  }

  buildPlan(messages: Message[], strategy: 'clear_tool_results' | 'summarize' = 'summarize'): (CompactionPlan & { head: Message[]; tail: Message[] }) | undefined {
    if (!this.opts.enabled) return undefined;
    if (strategy === 'clear_tool_results') {
      return {
        strategy,
        tokensBefore: this.estimate(messages),
        messagesToSummarize: messages,
        summaryPrompt: SUMMARY_PROMPT,
        head: [],
        tail: messages,
      };
    }
    const cut = this.findCut(messages);
    if (cut <= 0) return undefined;
    const head = messages.slice(0, cut);
    const tail = messages.slice(cut);
    if (!head.length) return undefined;
    return {
      strategy: 'summarize',
      tokensBefore: this.estimate(messages),
      messagesToSummarize: [...head],
      summaryPrompt: SUMMARY_PROMPT,
      head,
      tail,
    };
  }

  makeEntry(summary: string, covered: Message[], tokensBefore: number): CompactionEntry {
    return {
      kind: 'compaction',
      id: newId('cmp'),
      summary: summary.trim(),
      coversMessageIds: covered.map((m) => m.id),
      createdAt: Date.now(),
      tokensBefore,
      tokensAfter: this.estimate([{ id: 's', role: 'system', createdAt: 0, content: summary } as Message]),
      strategy: 'summarize',
    };
  }

  async summarize(plan: CompactionPlan, provider: Provider, model: string, signal: AbortSignal): Promise<string> {
    const transcript = plan.messagesToSummarize.map(renderForSummary).join('\n\n');
    const request = {
      model: this.opts.summaryModel ?? model,
      messages: [
        { role: 'system' as const, content: plan.summaryPrompt },
        {
          role: 'user' as const,
          content: `Compress the following transcript.\n\n${transcript}`,
        },
      ],
      temperature: 0.2,
    };
    let text = '';
    for await (const ev of provider.stream(request, { signal })) {
      if (ev.type === 'text_delta') text += ev.delta;
    }
    return text.trim() || '(compaction produced no summary)';
  }
}

function hasResult(messages: Message[], from: number, toolCallId: string): boolean {
  for (let i = from; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'tool' && m.toolCallId === toolCallId) return true;
  }
  return false;
}

function renderForSummary(m: Message): string {
  switch (m.role) {
    case 'system':
      return `[system] ${m.content.slice(0, 2000)}`;
    case 'user':
      return `[user] ${m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ').slice(0, 8000)}`;
    case 'assistant':
      return `[assistant] ${m.parts
        .map((p) => (p.type === 'text' ? p.text : p.type === 'reasoning' ? `<thinking>${p.text.slice(0, 500)}</thinking>` : `<tool_call name="${p.name}" args="${p.rawArgs.slice(0, 1500)}" status="${p.status}"/>`))
        .join('\n')
        .slice(0, 12000)}`;
    case 'tool':
      return `[tool ${m.toolName}${m.isError ? ' ERROR' : ''}] ${m.content.map((b) => (b.type === 'text' ? b.text : '')).join('').slice(0, 2000)}`;
  }
}
