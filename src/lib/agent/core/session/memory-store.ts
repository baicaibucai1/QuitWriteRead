/*
 * 会话只放在内存里 —— **持久化由宿主决定**（QuitWriteRead 这边打算落 IndexedDB）。
 *
 * 从上游 session/jsonl-store.ts 搬出来的那一份：上游默认落 JSONL 文件，浏览器里
 * 没有"文件"这个位置可落，而内核的 SessionStore 本来就是接口，换实现是它设计好的
 * 那条缝。上游那份还依赖 node:fs / node:readline，跟着它一起删了。
 */
import { newSessionId } from './store';
import type { SessionStore } from './store';
import type { SessionEntry, SessionMeta } from '../types/messages';
import type { SessionSummary } from './store';

export class InMemorySessionStore implements SessionStore {
  readonly kind = 'memory';
  private data = new Map<string, SessionEntry[]>();

  async create(meta: Omit<SessionMeta, 'kind' | 'createdAt'> & { createdAt?: number }): Promise<SessionMeta> {
    const entry: SessionMeta = {
      kind: 'meta',
      sessionId: meta.sessionId || newSessionId(),
      createdAt: meta.createdAt ?? Date.now(),
      cwd: meta.cwd,
      ...(meta.title ? { title: meta.title } : {}),
    };
    this.data.set(entry.sessionId, [entry]);
    return entry;
  }

  async append(sessionId: string, entries: SessionEntry | SessionEntry[]): Promise<void> {
    const list = Array.isArray(entries) ? entries : [entries];
    const rows = this.data.get(sessionId) ?? (await this.load(sessionId));
    this.data.set(sessionId, [...rows, ...list]);
  }

  async load(sessionId: string): Promise<SessionEntry[]> {
    return this.data.get(sessionId) ?? [];
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.data.has(sessionId);
  }

  async list(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for (const [sessionId, rows] of this.data) {
      const meta = rows.find((r) => r.kind === 'meta') as SessionMeta | undefined;
      out.push({
        sessionId,
        createdAt: meta?.createdAt ?? 0,
        updatedAt: meta?.createdAt ?? 0,
        cwd: meta?.cwd ?? '',
        ...(meta?.title ? { title: meta.title } : {}),
        messageCount: rows.filter((r) => r.kind === 'message').length,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async remove(sessionId: string): Promise<boolean> {
    return this.data.delete(sessionId);
  }

  async setMeta(sessionId: string, patch: Partial<Pick<SessionMeta, 'title' | 'meta'>>): Promise<void> {
    const rows = this.data.get(sessionId) ?? [];
    const idx = rows.findIndex((r) => r.kind === 'meta');
    const meta = rows[idx] as SessionMeta | undefined;
    const updated: SessionMeta = {
      kind: 'meta',
      sessionId,
      createdAt: meta?.createdAt ?? Date.now(),
      cwd: meta?.cwd ?? '/',
      ...(patch.title ?? meta?.title ? { title: patch.title ?? meta?.title } : {}),
      ...(patch.meta ?? meta?.meta ? { meta: { ...(meta?.meta ?? {}), ...(patch.meta ?? {}) } } : {}),
    };
    if (idx >= 0) rows[idx] = updated;
    else rows.unshift(updated);
    this.data.set(sessionId, rows);
  }
}
