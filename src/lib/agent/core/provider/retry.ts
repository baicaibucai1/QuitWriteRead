import { ProviderError } from '../types/errors';
import { sleep } from '../utils';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function parseRetryAfter(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return secs * 1000;
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const reset = headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset-tokens');
  if (reset) {
    const parsed = parseDuration(reset);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseDuration(s: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    switch (m[2]) {
      case 'ms':
        total += n;
        break;
      case 's':
        total += n * 1000;
        break;
      case 'm':
        total += n * 60_000;
        break;
      case 'h':
        total += n * 3_600_000;
        break;
    }
  }
  return matched ? total : undefined;
}

/**
 * What a transport failure actually looks like depends on who reports it, and
 * undici is the loudest liar: a connection that dies mid-body is thrown as
 * `TypeError: terminated`, with `ECONNRESET` / `UND_ERR_SOCKET` buried on the
 * cause. Reading only the top error would classify the single most common bad-
 * network case as a permanent failure — so the whole chain gets walked.
 */
const RETRYABLE_CODE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR|PREMATURE/i;
const RETRYABLE_MESSAGE = /fetch failed|network|terminated|other side closed|socket hang up|premature close|ECONN|ETIMEDOUT|EAI_AGAIN/i;

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  let node: (Error & { code?: string }) | undefined = err as Error & { code?: string };
  // A provider error nested in a wrapper still decides for itself; the bound
  // keeps a self-referential cause chain from spinning.
  for (let depth = 0; node && depth < 5; depth++) {
    if (node instanceof ProviderError) return node.retryable;
    if (node.code && RETRYABLE_CODE.test(node.code)) return true;
    if (node.message && RETRYABLE_MESSAGE.test(node.message)) return true;
    node = node.cause as (Error & { code?: string }) | undefined;
  }
  return false;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 30_000;
  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (attempt >= opts.maxRetries || !isRetryable(err)) throw err;
      const hinted = err instanceof ProviderError ? (err.details as { retryAfterMs?: number } | undefined)?.retryAfterMs : undefined;
      const backoff = Math.min(max, base * 2 ** attempt);
      const jitter = backoff * (0.5 + Math.random() * 0.5);
      const delay = Math.min(max, hinted ?? jitter);
      attempt++;
      opts.onRetry?.(attempt, delay, err);
      await sleep(delay, opts.signal);
    }
  }
}
