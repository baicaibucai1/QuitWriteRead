import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { PermissionMode } from '../types/permission';

/**
 * One record per call the permission pipeline was asked about.
 *
 * A kernel whose selling point is "nothing writes without a decision" has to be
 * able to answer *who allowed this* weeks later, from disk, after the transcript
 * has been compacted twice. That is what this is for: an append-only trail of
 * decisions, deliberately carrying a digest of the arguments rather than the
 * arguments — the evidence that `shell(rm -rf …)` was approved should not require
 * storing every command line in a second file.
 */
export interface AuditEntry {
  at: number;
  /** The session that made the call — a subagent's own id, so tree depth shows. */
  sessionId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  title: string;
  /** First 16 hex of sha256 over canonically-ordered arguments. */
  argsDigest: string;
  mode: PermissionMode;
  decision: 'allow' | 'deny';
  /** True when a human (or a host handler) was asked; false when policy allowed it. */
  asked: boolean;
  optionId?: string;
  reason?: string;
}

export interface AuditConfig {
  /** JSONL file, appended in arrival order. Created if missing. */
  file?: string;
  onEntry?: (entry: AuditEntry) => void;
  /**
   * Record auto-approved calls too. On by default: "why was this allowed without
   * asking" is the question an audit log exists to answer, and a log that only
   * contains escalations cannot answer it.
   */
  includeAutoApproved?: boolean;
}

export type AuditSink = ((entry: AuditEntry) => void) & {
  /** Resolve once every queued line has reached the file. */
  flush(): Promise<void>;
  /** Flush and release the file handle. Only the owner of the sink may do this. */
  close(): Promise<void>;
};

/** Stable digest: key order must not change the fingerprint of equal arguments. */
export function digestArgs(values: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const entries = Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  };
  return createHash('sha256').update(canonical(values)).digest('hex').slice(0, 16);
}

/**
 * Builds the sink, or `undefined` when auditing is off — so the loop pays nothing
 * until a host asks for a trail. File writes are chained on one promise to keep
 * the log in decision order even when two sessions approve at the same moment.
 */
export function createAuditSink(config: AuditConfig | undefined, redact?: (text: string) => string): AuditSink | undefined {
  if (!config || (!config.file && !config.onEntry)) return undefined;
  const includeAuto = config.includeAutoApproved !== false;
  let chain: Promise<void> = Promise.resolve();
  const stream = config.file ? fs.createWriteStream(config.file, { flags: 'a' }) : undefined;
  if (stream) stream.on('error', () => undefined);

  const sink = ((raw: AuditEntry) => {
    if (!includeAuto && !raw.asked) return;
    const entry: AuditEntry = {
      ...raw,
      title: redact ? redact(raw.title) : raw.title,
      ...(raw.reason ? { reason: redact ? redact(raw.reason) : raw.reason } : {}),
    };
    try {
      config.onEntry?.(entry);
    } catch {
      /* a broken host callback must not stall the run */
    }
    if (stream) {
      const line = `${JSON.stringify(entry)}\n`;
      chain = chain.then(() => new Promise<void>((resolve) => stream.write(line, () => resolve())));
    }
  }) as AuditSink;
  sink.flush = () => chain;
  sink.close = async () => {
    await chain;
    if (stream) await new Promise<void>((resolve) => stream.end(() => resolve()));
  };
  return sink;
}
