import type { LlmMessage } from '../types/provider';
import type { Message } from '../types/messages';
import { textOf } from '../types/messages';

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u3040-\u30ff]/g;

export interface TokenWeights {
  ascii: number;
  cjk: number;
  other: number;
}

export const DEFAULT_WEIGHTS: TokenWeights = { ascii: 0.25, cjk: 1.0, other: 0.34 };

export function estimateTokensForText(text: string, weights: TokenWeights = DEFAULT_WEIGHTS): number {
  if (!text) return 0;
  const cjkChars = text.match(CJK)?.length ?? 0;
  const asciiChars = text.match(/[\x00-\x7f]/g)?.length ?? 0;
  const otherChars = Math.max(0, text.length - cjkChars - asciiChars);
  return Math.ceil(cjkChars * weights.cjk + asciiChars * weights.ascii + otherChars * weights.other);
}

/**
 * An image is charged as an image, never as its base64.
 *
 * The two numbers are not remotely close: a 200 KB screenshot is ~50 000
 * characters of base64 but a few hundred to ~1 500 visual tokens on the models
 * that accept it. Counting the string made a session with one attached picture
 * look nearly full, which sends compaction off every step and drops the history
 * the images were attached to in the first place. 1 000 sits between OpenAI's
 * high-detail ceiling (~765) and a 1-megapixel Claude image (~1 300); the
 * calibrator corrects the aggregate against real `usage.promptTokens` anyway.
 */
export const IMAGE_TOKENS = 1_000;

function llmMessageText(m: LlmMessage): string {
  const content = m.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  if (m.role === 'assistant' && m.tool_calls) return m.tool_calls.map((c) => `${c.function.name}${c.function.arguments}`).join('');
  return '';
}

function countImages(content: LlmMessage['content']): number {
  return Array.isArray(content) ? content.filter((part) => part.type === 'image_url').length : 0;
}

function sessionMessageText(m: Message): string {
  switch (m.role) {
    case 'system':
      return m.content;
    case 'user':
      return textOf(m.content);
    case 'assistant':
      return m.parts
        .map((p) => (p.type === 'text' || p.type === 'reasoning' ? p.text : `${p.name}${p.rawArgs}`))
        .join('');
    case 'tool':
      return textOf(m.content);
  }
}

const PER_MESSAGE_OVERHEAD = 4;

export function estimateTokensForLlmMessages(messages: LlmMessage[], weights: TokenWeights = DEFAULT_WEIGHTS): number {
  let total = 0;
  for (const m of messages) total += estimateTokensForText(llmMessageText(m), weights) + countImages(m.content) * IMAGE_TOKENS + PER_MESSAGE_OVERHEAD;
  return total + 8;
}

export function estimateTokensForMessages(messages: Message[], weights: TokenWeights = DEFAULT_WEIGHTS): number {
  let total = 0;
  for (const m of messages) {
    // The session side has to charge images the same way the wire side does:
    // `ContextManager` decides compaction from these numbers, and a mismatch
    // here means an attached picture either triggers compaction forever or
    // never triggers it.
    const images = m.role === 'user' || m.role === 'tool' ? m.content.filter((b) => b.type === 'image').length : 0;
    total += estimateTokensForText(sessionMessageText(m), weights) + images * IMAGE_TOKENS + PER_MESSAGE_OVERHEAD;
    if (m.role === 'tool' && m.isError) total += 4;
  }
  return total + 8;
}

/**
 * Adapts estimates to real usage: EMA of the observed / estimated ratio, so a
 * model with an unusual tokenizer converges after a few requests.
 */
export class TokenCalibrator {
  private ratio = 1;
  private samples = 0;
  constructor(private alpha = 0.4) {}

  observe(estimated: number, actual: number): void {
    if (estimated <= 0 || actual <= 0) return;
    const observed = actual / estimated;
    this.ratio = this.samples === 0 ? observed : this.alpha * observed + (1 - this.alpha) * this.ratio;
    this.samples++;
  }

  scale(estimated: number): number {
    return Math.ceil(estimated * this.ratio);
  }

  get confidence(): number {
    return this.samples;
  }
}
