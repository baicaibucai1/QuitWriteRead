import type { InjectedPrompt, InjectionContext } from '../types/config';
import type { LlmMessage } from '../types/provider';
import { estimateTokensForLlmMessages } from './tokens';

/** One injection after its dynamic text has been evaluated for this step. */
export interface ResolvedInjection {
  id: string;
  message: LlmMessage;
  position: 'head' | 'tail';
}

/**
 * The kernel's forced-prompt channel.
 *
 * Everything else that reaches the model is remembered in the transcript and can
 * therefore be lost to compaction, trimmed by a context hook, or simply outrun by
 * a long conversation. These prompts are not in the transcript: they are added to
 * the request after the hooks have had their say, which makes this the one place
 * a host can state a rule that is guaranteed to be in front of the model on every
 * single step.
 *
 * The cost of that guarantee is repetition — the model may see the same text
 * dozens of times — so this channel is for short, load-bearing instructions.
 * Background material still belongs in the system prompt or in memory.
 */
export class PromptInjector {
  private readonly prompts = new Map<string, InjectedPrompt>();
  private seq = 0;

  constructor(prompts: InjectedPrompt[] = []) {
    for (const prompt of prompts) this.add(prompt);
  }

  /**
   * Add, or replace by `id`. Returns the id it landed under, which is the handle
   * a host needs to withdraw a prompt whose id was generated here.
   */
  add(prompt: InjectedPrompt): string {
    const id = prompt.id ?? `injected_${++this.seq}`;
    // A Map keeps the original insertion position when a key is re-set, so
    // re-declaring a policy mid-session updates its text without moving it from
    // the head of the request to the end.
    this.prompts.set(id, { ...prompt, id });
    return id;
  }

  withdraw(id: string): boolean {
    return this.prompts.delete(id);
  }

  clear(): void {
    this.prompts.clear();
  }

  get size(): number {
    return this.prompts.size;
  }

  list(): InjectedPrompt[] {
    return [...this.prompts.values()];
  }

  /**
   * Resolve the dynamic ones for one step. Call this once and reuse the result for
   * both the token accounting and the request: a `text` function that reads a
   * clock or a counter must not be evaluated twice per step, or the budget and the
   * payload disagree about what was sent.
   */
  async resolve(ctx: InjectionContext): Promise<ResolvedInjection[]> {
    const out: ResolvedInjection[] = [];
    for (const prompt of this.prompts.values()) {
      const text = typeof prompt.text === 'function' ? await prompt.text(ctx) : prompt.text;
      if (!text) continue;
      out.push({
        id: prompt.id!,
        message: prompt.role === 'user' ? { role: 'user', content: text } : { role: 'system', content: text },
        position: prompt.position ?? 'head',
      });
    }
    return out;
  }

  /** Splice resolved injections into an assembled request. */
  apply(messages: LlmMessage[], resolved: ResolvedInjection[]): LlmMessage[] {
    if (!resolved.length) return messages;
    const head = resolved.filter((r) => r.position === 'head').map((r) => r.message);
    const tail = resolved.filter((r) => r.position === 'tail').map((r) => r.message);
    // Head prompts land after the leading system message so the model's persona
    // still comes first; a request with no system message gets them at the front.
    const at = messages[0]?.role === 'system' ? 1 : 0;
    return [...messages.slice(0, at), ...head, ...messages.slice(at), ...tail];
  }

  /** What a resolved set costs the context budget, in compaction's units. */
  cost(resolved: ResolvedInjection[]): number {
    return resolved.length ? estimateTokensForLlmMessages(resolved.map((r) => r.message)) : 0;
  }

  /**
   * Per-prompt cost, for a host that wants to see what its policy is paying for.
   * Estimated against the prompt's own text rather than the whole set, so the
   * numbers add up to `cost()` without one long prompt hiding another.
   */
  async priced(ctx: InjectionContext): Promise<Array<ResolvedInjection & { tokens: number }>> {
    const resolved = await this.resolve(ctx);
    return resolved.map((r) => ({ ...r, tokens: estimateTokensForLlmMessages([r.message]) }));
  }
}
