import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function newId(prefix = ''): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

export function nowMs(): number {
  return Date.now();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function truncateMiddle(text: string, maxChars: number, marker = '\n\n... [output truncated: {n} chars omitted] ...\n\n'): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  const head = Math.ceil(maxChars / 2);
  const tail = maxChars - head;
  return text.slice(0, head) + marker.replace('{n}', String(omitted)) + text.slice(text.length - tail);
}

export function safeJsonParse<T = unknown>(text: string): { ok: true; value: T } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}

export function globToRegExp(glob: string, opts: { matchBase?: boolean } = {}): RegExp {
  let re = '';
  let i = 0;
  const g = glob.replace(/\\/g, '/');
  while (i < g.length) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 3 : 2;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        const alts = g
          .slice(i + 1, end)
          .split(',')
          .map((a) => globToRegExp(a).source.replace(/^\^|\$$/g, ''));
        re += `(?:${alts.join('|')})`;
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const end = g.indexOf(']', i);
      if (end > i) {
        re += g.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    i++;
  }
  const prefix = opts.matchBase && !g.includes('/') ? '(?:^|/)' : '^';
  return new RegExp(`${prefix}${re}$`);
}

export function matchGlob(pattern: string, value: string, opts?: { matchBase?: boolean }): boolean {
  return globToRegExp(pattern, opts).test(value.replace(/\\/g, '/'));
}

export class Deferred<T> {
  promise: Promise<T>;
  resolve!: (v: T | PromiseLike<T>) => void;
  reject!: (e: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<Deferred<IteratorResult<T>>> = [];
  private closed = false;
  private failure: unknown = undefined;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) w.resolve({ value: undefined as never, done: true });
    this.waiters = [];
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.failure = err;
    this.closed = true;
    for (const w of this.waiters) w.reject(err);
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        const d = new Deferred<IteratorResult<T>>();
        this.waiters.push(d);
        return d.promise;
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function consoleLogger(prefix = '[nosie]') {
  const fmt = (level: string, message: string, data?: unknown) =>
    data === undefined ? `${prefix} ${level} ${message}` : `${prefix} ${level} ${message} ${safeStringify(data)}`;
  return {
    debug(message: string, data?: unknown) {
      if (process.env.NOSIE_DEBUG) process.stderr.write(fmt('debug', message, data) + '\n');
    },
    info(message: string, data?: unknown) {
      process.stderr.write(fmt('info', message, data) + '\n');
    },
    warn(message: string, data?: unknown) {
      process.stderr.write(fmt('warn', message, data) + '\n');
    },
    error(message: string, data?: unknown) {
      process.stderr.write(fmt('error', message, data) + '\n');
    },
  };
}

export function safeStringify(v: unknown, space?: number): string {
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val), space) ?? String(v);
  } catch {
    return String(v);
  }
}
