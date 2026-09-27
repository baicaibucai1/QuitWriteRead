import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { kindLabel } from '../lib/decide';
import type { ChangeKind } from '../lib/decide';
import { isProgramArtifact } from '../lib/visible';
import { inScope } from '../lib/scope';
import { Alert, ArrowDown, Check, Close, Refresh, Search } from './icons';

/*
 * 远端浏览：**拉什么是人选的**，所以先把那头有什么摊开给他看。
 *
 * 为什么非得是一个独立的面板、而不是塞进左栏底下那块：
 * 那边是「待推送」（最多 38% 高、还默认收着），而这里要列的是**整个远端** ——
 * 几十上百篇，要能滚、能搜、能勾，塞进一条缝里就只能"闭着眼睛全拉"。
 *
 * 三条规矩：
 *   ① **只勾不选就拉不了**：按钮上写着几篇，拉的是勾住的那些，不是整个远端。
 *   ② **两边都改过的不拉**（`doPull` 里挡着）—— 覆盖本地等于丢字，得先去选边。
 *      这里提前标出来，免得用户勾了半天发现没反应。
 *   ③ **范围外的文件也列出来**，但标「不在推送范围」：
 *      它是**远端的**东西，拉不拉跟推不推是两件事 —— 藏起来反而让人以为远端没有。
 */

export default function RemotePane() {
  const open = useStore((s) => s.remotePane);
  const setOpen = useStore((s) => s.setRemotePane);
  const remoteFiles = useStore((s) => s.remoteFiles);
  const changes = useStore((s) => s.changes);
  const files = useStore((s) => s.files);
  const scope = useStore((s) => s.scope);
  const busy = useStore((s) => s.busy);
  const doPull = useStore((s) => s.doPull);
  const refreshPlan = useStore((s) => s.refreshPlan);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  /** 远端那篇相对本地是什么状态。取自这一轮的比对结果，不另打一次远端 */
  const stateOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of changes) m.set(c.path, c.kind);
    return m;
  }, [changes]);

  const rows = useMemo(() => {
    const all = Object.keys(remoteFiles).sort((a, b) => a.localeCompare(b, 'zh'));
    const kw = q.trim().toLowerCase();
    return all.filter((p) => (kw ? p.toLowerCase().includes(kw) : true) && !isProgramArtifact(p));
  }, [remoteFiles, q]);

  if (!open) return null;

  const toggle = (p: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const pickPullable = () => {
    // 「全选」只选**能拉的**：两边都改过的选了也没用（doPull 会跳过）
    setPicked(new Set(rows.filter((p) => {
      const k = stateOf.get(p);
      return !k || k.startsWith('pull');
    })));
  };

  const pullable = [...picked].filter((p) => {
    const k = stateOf.get(p);
    return !k || k.startsWith('pull');
  });

  return (
    <>
      <div
        data-remote-mask
        onClick={() => setOpen(false)}
        className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[2px]"
      />
      <div
        data-remote-panel
        role="dialog"
        aria-label="远端文件"
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="eyebrow shrink-0">远端文件</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
            共 {Object.keys(remoteFiles).length} 篇 · 勾上再拉，一次只拉勾住的
          </span>
          <button
            type="button"
            data-remote-refresh
            title="重新列一遍远端"
            onClick={() => void refreshPlan()}
            disabled={busy !== null}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
          >
            <Refresh size={13} className={busy === 'plan' ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            data-remote-close
            title="关闭（Esc）"
            onClick={() => setOpen(false)}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Close size={14} />
          </button>
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[8px] border border-line bg-surface-2 px-2 py-[5px]">
            <Search size={12} className="shrink-0 text-ink-3" />
            <input
              data-remote-search
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜路径"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-3"
            />
          </div>
          <button
            type="button"
            data-remote-all
            onClick={pickPullable}
            className="shrink-0 rounded-[8px] border border-line bg-surface-2 px-2 py-[5px] text-[11.5px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            全选可拉的
          </button>
        </div>

        <div data-remote-list className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-ink-3">
              {Object.keys(remoteFiles).length === 0
                ? '还没列过远端 —— 点上面那个转圈先比对一次'
                : '没有匹配的路径'}
            </p>
          ) : (
            <div className="space-y-[1px]">
              {rows.map((p) => {
                const kind = stateOf.get(p);
                const conflicted = kind === 'conflict';
                const on = picked.has(p);
                const outOfScope = !inScope(p, scope);
                return (
                  <button
                    key={p}
                    type="button"
                    data-remote-row={p}
                    data-remote-state={kind ?? 'same'}
                    onClick={() => toggle(p)}
                    className={`flex w-full items-center gap-2 overflow-hidden rounded-[7px] px-1.5 py-[5px] text-left transition-colors ${
                      on ? 'bg-accent-soft' : 'hover:bg-surface-2'
                    }`}
                  >
                    <span
                      className={`grid h-[15px] w-[15px] shrink-0 place-items-center rounded-[4px] border ${
                        on ? 'border-accent bg-accent text-white' : 'border-line-2 bg-surface'
                      }`}
                    >
                      {on && <Check size={9} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-[11px] text-ink-2">
                      {p}
                    </span>
                    {conflicted ? (
                      <span
                        data-remote-conflict
                        title="两边都改过 —— 要先选一边才能拉（不然会盖掉本地的改动）"
                        className="flex shrink-0 items-center gap-1 text-[10.5px] text-danger"
                      >
                        <Alert size={10} strokeWidth={2} />
                        两边都改过
                      </span>
                    ) : kind?.startsWith('pull') ? (
                      <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-accent">
                        <ArrowDown size={10} strokeWidth={2} />
                        {kindLabel(kind as ChangeKind)}
                      </span>
                    ) : outOfScope ? (
                      <span className="shrink-0 text-[10.5px] text-ink-3" title="不在推送范围，但它是远端的东西，要拉照样能拉">
                        范围外
                      </span>
                    ) : (
                      <span className="shrink-0 text-[10.5px] text-ink-3">
                        {p in files ? '一致' : '本地没有'}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2.5">
          <span data-remote-count className="min-w-0 flex-1 text-[11px] text-ink-3">
            {picked.size === 0
              ? '还没勾'
              : pullable.length < picked.size
                ? `勾了 ${picked.size} 篇，其中 ${picked.size - pullable.length} 篇两边都改过（先去选边）`
                : `勾了 ${picked.size} 篇`}
          </span>
          <button
            type="button"
            data-remote-pull
            disabled={pullable.length === 0 || busy !== null}
            onClick={async () => {
              await doPull(pullable);
              setPicked(new Set());
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-[9px] border border-accent-line bg-accent-soft px-3 py-[6px] text-[12px] font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-40 disabled:pointer-events-none"
          >
            <ArrowDown size={12} strokeWidth={2} />
            {busy === 'sync' ? '拉取中' : `拉取${pullable.length ? ` ${pullable.length} 篇` : ''}`}
          </button>
        </footer>
      </div>
    </>
  );
}
