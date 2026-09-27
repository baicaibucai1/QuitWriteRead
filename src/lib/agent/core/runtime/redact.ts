import type { Message } from '../types/messages';

/**
 * Redaction of what the kernel persists, not of what it thinks.
 *
 * The distinction matters. A secret that passed through a tool call this turn is
 * in the live transcript because the model put it there, and rewriting it mid-run
 * would change what the model believes it sent. What the kernel must not do is
 * write it onto disk, into a session file that outlives the process and gets
 * shared, backed up and grepped by people who were never in the room.
 *
 * So this runs on the copy that goes to the session store and to the audit log:
 * the in-memory conversation stays as it was, the durable record is masked.
 */

export interface RedactionPolicy {
  /**
   * Strings are matched literally (escaped, global); regexes keep their flags but
   * are forced global so every hit on a line is replaced, not just the first.
   */
  patterns?: Array<string | RegExp>;
  /** Argument names whose value must never be persisted, e.g. `api_key`, `token`. */
  toolArgs?: string[];
  replacement?: string;
}

export interface Redactor {
  readonly active: boolean;
  text(value: string): string;
  args(values: Record<string, unknown>): Record<string, unknown>;
  /** A masked copy of a transcript message; the original stays untouched. */
  message<M extends Message>(message: M): M;
}

const DEFAULT_REPLACEMENT = '«redacted»';

/** A pattern that cannot match the empty string, or every character redacts. */
function usable(source: string, flags: string): RegExp | undefined {
  const body = source.replace(/^\^|\$$/g, '');
  return body.length ? new RegExp(body, flags.includes('g') ? flags : `${flags}g`) : undefined;
}

export function createRedactor(policy?: RedactionPolicy): Redactor {
  const replacement = policy?.replacement ?? DEFAULT_REPLACEMENT;
  const regexes: RegExp[] = [];
  for (const pattern of policy?.patterns ?? []) {
    if (typeof pattern === 'string') {
      if (!pattern) continue;
      regexes.push(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
      continue;
    }
    const built = usable(pattern.source, pattern.flags);
    if (built) regexes.push(built);
  }
  const keys = new Set(policy?.toolArgs ?? []);
  const active = regexes.length > 0 || keys.size > 0;

  return {
    active,
    text(value: string): string {
      if (!active) return value;
      let out = value;
      for (const re of regexes) out = out.replace(re, replacement);
      return out;
    },
    args(values: Record<string, unknown>): Record<string, unknown> {
      if (!active || !keys.size) return values;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        out[key] = keys.has(key.toLowerCase())
          ? replacement
          : typeof value === 'string'
            ? this.text(value)
            : value && typeof value === 'object'
              ? this.args(value as Record<string, unknown>)
              : value;
      }
      return out;
    },
    message<M extends Message>(message: M): M {
      if (!active) return message;
      const red = this;
      const blocks = (value?: string | Array<{ type: string; text?: string }>) =>
        typeof value === 'string' ? red.text(value) : (value ?? []).map((block) => ({ ...block, ...(typeof block.text === 'string' ? { text: red.text(block.text) } : {}) }));
      const copy = { ...message } as Message;
      if ('content' in copy) copy.content = blocks(copy.content as string | Array<{ type: string; text?: string }>) as never;
      if (copy.role === 'assistant' && copy.parts) {
        copy.parts = copy.parts.map((part) => {
          if (part.type === 'tool_call') {
            return { ...part, rawArgs: red.text(part.rawArgs), args: red.args(part.args as Record<string, unknown>) as never };
          }
          return { ...part, ...(typeof (part as { text?: string }).text === 'string' ? { text: red.text((part as { text: string }).text) } : {}) };
        }) as typeof copy.parts;
      }
      return copy as M;
    },
  };
}
