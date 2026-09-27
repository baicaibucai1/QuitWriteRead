import { useMemo } from 'react';
import { useStore } from '../lib/store';
import { diffLines, diffSummary, collapseUnchanged } from '../lib/diff';
import { isBinaryPath } from '../lib/binary';
import { Alert, Close } from './icons';

/*
 * 选边：这一篇两边都改过，用哪一侧？
 *
 * ## 为什么不做自动合并
 *
 * markdown 没有可靠的"合并单位"。按行合会把「把第 3 段删了」和「在第 3 段后面加了一句」
 * 合成一坨谁都读不懂的东西 —— 而**猜错一次就是丢字**。所以这里只做"选"，不做"合"。
 *
 * ## 为什么是 unified 视图（一串带 +/− 的行），不是左右并排
 *
 * 这一屏最窄只有 92vw（手机上 400px 出头），并排两栏每栏不到 200px，
 * 中文一行只能放十来个字，比并排更看不清。unified 是 git 的默认，也是这个宽度下的唯一解。
 *
 * ⚠️ 三个按钮的措辞必须说清**后果**（谁覆盖谁），不能只写"用我的"：
 * 选错一侧就是丢一片字，而按钮点上去了没有撤销。
 */

const SIDE_TONE = {
  local: { box: 'border-accent-line bg-accent-soft', text: 'text-accent' },
  remote: { box: 'border-accent-line bg-accent-soft', text: 'text-accent' },
  both: { box: 'border-line bg-surface-2', text: 'text-ink-2' },
};

export default function ConflictPane() {
  const path = useStore((s) => s.conflictOf);
  const remoteText = useStore((s) => s.conflictRemote);
  const busy = useStore((s) => s.conflictBusy);
  const files = useStore((s) => s.files);
  const close = useStore((s) => s.closeConflict);
  const resolve = useStore((s) => s.resolve);

  const localText = path ? (files[path] ?? '') : '';
  const binary = path ? isBinaryPath(path) : false;

  const lines = useMemo(() => {
    if (!path || binary || remoteText === null) return [];
    return collapseUnchanged(diffLines(localText, remoteText), 2);
  }, [path, binary, remoteText, localText]);

  const summary = useMemo(
    () => (remoteText === null ? { added: 0, removed: 0 } : diffSummary(diffLines(localText, remoteText))),
    [localText, remoteText],
  );

  if (!path) return null;

  return (
    <>
      <div
        data-conflict-mask
        onClick={() => close()}
        className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[2px]"
      />
      <div
        data-conflict-panel
        role="dialog"
        aria-label="两边都改过，选一边"
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[84vh] w-[min(720px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop"
      >
        <header className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-2.5">
          <Alert size={14} className="mt-[2px] shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-ink">两边都改过这一篇</div>
            <div className="mt-[1px] truncate font-mono text-[11px] text-ink-3">{path}</div>
          </div>
          <button
            type="button"
            data-conflict-close
            title="先不处理（Esc）"
            onClick={() => close()}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Close size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
          {busy || remoteText === null ? (
            <p className="px-2 py-8 text-center text-[12px] text-ink-3">正在取云端那一版…</p>
          ) : binary ? (
            /*
             * 附件没有"行"这回事。给它三行说明就够了 ——
             * 硬把 base64 摊开是一屏谁也读不了的乱码。
             */
            <div className="rounded-[9px] border border-warn-line bg-warn-soft px-3 py-2.5 text-[12px] leading-relaxed text-warn">
              这是个附件，没法逐行比对。选「用本机这版」就把它推上去，选「用云端那版」就用远端那个覆盖本地。
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2 text-[11px]">
                <span className="text-ink-3">跟云端那一版比：</span>
                <span className="text-ok">+{summary.added}</span>
                <span className="text-danger">−{summary.removed}</span>
                <span className="text-ink-3">
                  （<span className="text-danger">红色 −</span> 是本机有、云端没有；
                  <span className="text-ok"> 绿色 +</span> 是云端有、本机没有）
                </span>
              </div>
              <div
                data-conflict-diff
                className="overflow-x-auto rounded-[9px] border border-line bg-surface-2 py-1 font-mono text-[11.5px] leading-[1.6]"
              >
                {lines.length === 0 ? (
                  <div className="px-3 py-2 text-ink-3">两版内容一样（只有指纹不同 —— 大概是换行或 BOM 的差异）</div>
                ) : (
                  lines.map((l, i) =>
                    l.kind === 'skip' ? (
                      <div key={i} className="px-3 py-[1px] text-[10.5px] text-ink-3">
                        ⋯ 中间 {l.count} 行两边一样
                      </div>
                    ) : (
                      <div
                        key={i}
                        data-diff-line={l.kind}
                        className={`whitespace-pre px-3 py-[1px] ${
                          l.kind === 'add'
                            ? 'bg-ok-soft text-ink'
                            : l.kind === 'del'
                              ? 'bg-danger-soft text-ink'
                              : 'text-ink-3'
                        }`}
                      >
                        <span className="mr-1.5 select-none text-ink-3">
                          {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                        </span>
                        {l.text || ' '}
                      </div>
                    ),
                  )
                )}
              </div>
            </>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
          {(
            [
              { side: 'local', label: '用本机这版', hint: '推上去，覆盖云端' },
              { side: 'remote', label: '用云端那版', hint: '拉下来，覆盖本机' },
              { side: 'both', label: '两版都留', hint: '云端那版另存副本，本机这版推上去' },
            ] as const
          ).map((o) => (
            <button
              key={o.side}
              type="button"
              data-conflict-side={o.side}
              disabled={busy || remoteText === null}
              title={o.hint}
              onClick={() => void resolve(path, o.side)}
              className={`flex min-w-0 flex-1 flex-col items-start gap-[1px] rounded-[9px] border px-2.5 py-[6px] transition-colors disabled:opacity-40 disabled:pointer-events-none ${SIDE_TONE[o.side].box} hover:brightness-[0.98]`}
            >
              <span className={`text-[12px] font-medium ${SIDE_TONE[o.side].text}`}>{o.label}</span>
              <span className="text-[10.5px] leading-snug text-ink-3">{o.hint}</span>
            </button>
          ))}
        </footer>
      </div>
    </>
  );
}
