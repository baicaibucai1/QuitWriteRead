import type { Message, SessionEntry, SessionMeta } from '../types/messages';
import { SUMMARY_PREAMBLE } from '../types/messages';
import { newId } from '../utils';

export interface SessionSummary {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  title?: string;
  messageCount: number;
}

export interface SessionStore {
  readonly kind: string;
  create(meta: Omit<SessionMeta, 'kind' | 'createdAt'> & { createdAt?: number }): Promise<SessionMeta>;
  append(sessionId: string, entry: SessionEntry | SessionEntry[]): Promise<void>;
  load(sessionId: string): Promise<SessionEntry[]>;
  list(): Promise<SessionSummary[]>;
  remove(sessionId: string): Promise<boolean>;
  exists(sessionId: string): Promise<boolean>;
  setMeta(sessionId: string, patch: Partial<Pick<SessionMeta, 'title' | 'meta'>>): Promise<void>;
}

export function newSessionId(): string {
  return newId('sess');
}

export function messagesOf(entries: SessionEntry[]): Message[] {
  return entries.filter((e): e is { kind: 'message'; message: Message } => e.kind === 'message').map((e) => e.message);
}

/**
 * How a compaction entry shows up in a live context: one system message carrying
 * the summary, ahead of whatever survived. Both paths that rebuild history — the
 * session assembler and the run loop, mid-flight — go through here, because a
 * summary that only exists after a reload is a model that forgot the first half
 * of its own run.
 */
export function summaryMessage(summary: string): Message {
  return {
    id: newId('summary'),
    role: 'system',
    createdAt: 0,
    content: `${SUMMARY_PREAMBLE}${summary}`,
  };
}

/**
 * A compaction entry replaces the messages it covers. Original rows stay in the
 * log so the transcript remains auditable and re-compaction stays possible.
 */
export function assembleContext(entries: SessionEntry[]): { messages: Message[]; compacted: boolean; summary?: string } {
  const compactedIds = new Set<string>();
  let latestSummary: string | undefined;
  let compacted = false;
  for (const e of entries) {
    if (e.kind === 'compaction') {
      compacted = true;
      for (const id of e.coversMessageIds) compactedIds.add(id);
      latestSummary = e.summary;
    }
  }
  const messages: Message[] = [];
  for (const e of entries) {
    if (e.kind !== 'message') continue;
    if (compactedIds.has(e.message.id)) continue;
    messages.push(e.message);
  }
  if (compacted && latestSummary) {
    messages.unshift(summaryMessage(latestSummary));
  }
  return { messages, compacted, summary: latestSummary };
}
