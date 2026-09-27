import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { isPush, kindLabel } from '../lib/decide';
import { isProgramArtifact } from '../lib/visible';
import type { ChangeKind } from '../lib/decide';
import { Alert, ArrowDown, ArrowUp, Check, Chevron, EyeOff } from './icons';

/*
 * 「待同步」这一块 = 抬头 + 清单。
 *
 * 抬头那行本来只有「待同步」四个字和一条横杠，剩下的地方空着 ——
 * 差异状况（↑待推送 / ↓待拉取 / ⚠冲突）就摆在那儿：它说的是**下面这份清单**
 * 的构成，跟清单在同一个抬头里，不用在底下另起一条横幅再说一遍。
 * dock 因此退回一行，只管动手（同步 / 刷新 / 设置）。
 *
 * **具体文件默认收着**：大部分时候人只想知道"有几项待推 / 待拉"，一条条文件名是噪音 ——
 * 而且改动一多那一片会把文件树挤得只剩半屏。要看的时候点抬头那一行展开（再点收回）。
 * ⚠️ 收起的是**清单**，不是"有没有差异"：抬头上的计数照旧在，空态那两条提示照旧显示 ——
 * 那两条说的是"现在到底要不要同步"，收起来就等于把状态藏了。
 *
 * ⚠️ 空态不能只看 changes：本地改完还没比对时 changes 是上一轮的（可能是空的），
 * 这时候说「本地和远端一致」是在撒谎 —— 得先看 planStale。
 */

function kindIcon(kind: ChangeKind) {
  if (kind === 'conflict') return <Alert size={12} strokeWidth={2} />;
  return isPush(kind) ? <ArrowUp size={12} strokeWidth={2} /> : <ArrowDown size={12} strokeWidth={2} />;
}

function kindColor(kind: ChangeKind) {
  if (kind === 'conflict') return 'text-danger';
  return isPush(kind) ? 'text-ok' : 'text-accent';
}

/** 左侧那枚小方片：把"上/下/冲突"做成三种浅色底，比一个裸图标好认 */
function kindTile(kind: ChangeKind) {
  if (kind === 'conflict') return 'bg-danger-soft';
  return isPush(kind) ? 'bg-ok-soft' : 'bg-accent-soft';
}

/** 抬头上一段「↑ 3 待推送」 */
function Seg({ tone, children }: { tone: 'push' | 'pull' | 'conflict'; children: React.ReactNode }) {
  const skin = {
    push: 'text-ok',
    pull: 'text-accent',
    conflict: 'text-danger',
  }[tone];
  return (
    <span
      className={`flex shrink-0 items-center gap-1 text-[10.5px] font-medium ${skin}`}
    >
      {children}
    </span>
  );
}

export default function ChangeList() {
  const changes = useStore((s) => s.changes);
  const planStale = useStore((s) => s.planStale);
  const showAll = useStore((s) => s.showAll);
  const setShowAll = useStore((s) => s.setShowAll);
  const setCurrent = useStore((s) => s.setCurrent);
  const scope = useStore((s) => s.scope);
  const openConflict = useStore((s) => s.openConflict);

  const { visible, hidden } = useMemo(() => {
    if (showAll) return { visible: changes, hidden: 0 };
    const visible = changes.filter((c) => !isProgramArtifact(c.path));
    return { visible, hidden: changes.length - visible.length };
  }, [changes, showAll]);

  const push = changes.filter((c) => c.kind.startsWith('push')).length;
  const pull = changes.filter((c) => c.kind.startsWith('pull')).length;
  const conflict = changes.filter((c) => c.kind === 'conflict').length;
  /** 范围空了 = 什么都推不上去。这时候说「一致」是撒谎，得单独说 */
  const emptyScope = scope.include.length === 0;

  // 清单默认收着，点抬头那一行才展开。这是**界面**状态，不进 store：
  // 换篇笔记、刷新一次都不该替他改主意。
  const [open, setOpen] = useState(false);
  const hasList = changes.length > 0;

  const status = planStale ? (
    <Seg tone="conflict">
      <Alert size={10} strokeWidth={2} />
      还没比对
    </Seg>
  ) : (
    <>
      {push > 0 && (
        <Seg tone="push">
          <ArrowUp size={10} strokeWidth={2} />
          {push} 待推送
        </Seg>
      )}
      {pull > 0 && (
        <Seg tone="pull">
          <ArrowDown size={10} strokeWidth={2} />
          {pull} 待拉取
        </Seg>
      )}
      {conflict > 0 && (
        <Seg tone="conflict">
          <Alert size={10} strokeWidth={2} />
          {conflict} 冲突
        </Seg>
      )}
    </>
  );

  return (
    <div
      data-changes
      className="flex max-h-[38%] min-h-0 shrink-0 flex-col border-t border-line"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 overflow-hidden pl-4 pr-2.5">
        {hasList ? (
          <button
            type="button"
            data-changes-toggle
            aria-expanded={open}
            title={open ? '收起文件清单' : '展开看具体文件'}
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-[5px] text-left"
          >
            <Chevron
              size={11}
              strokeWidth={2}
              className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`}
            />
            <span className="eyebrow shrink-0">待推送</span>
            {status}
            {!open && <span className="shrink-0 text-[10.5px] text-ink-3">{changes.length} 项</span>}
          </button>
        ) : (
          <>
            <span className="eyebrow shrink-0">待推送</span>
            {status}
          </>
        )}
        <span className="h-px min-w-2 flex-1 bg-line" />
      </div>

      {/* 收起时这块整个不渲染 —— 留个空壳会白占十几像素的内边距 */}
      {(!hasList || open) && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
          {changes.length === 0 ? (
            emptyScope ? (
              /*
               * ⚠️ 空范围必须自己说话：这时候"没有待推送"是**配置的结果**，
               * 不是"已经推干净了"。混在一起说，用户会以为同步坏了。
               */
              <div
                data-scope-empty
                className="flex items-start gap-2 rounded-[7px] bg-warn-soft px-2 py-[6px] text-[12px] leading-snug text-warn"
              >
                <Alert size={13} strokeWidth={2} className="mt-[1px] shrink-0" />
                <span>
                  <span className="font-medium">推送范围是空的</span>，什么都推不上去。
                  去「设置 → 推送」里加一条规则（比如 <span className="font-mono">thoughts/</span>）。
                </span>
              </div>
            ) : planStale ? (
              <div className="flex items-center gap-2 rounded-[7px] bg-warn-soft px-2 py-[6px] text-[12px] text-warn">
                <Alert size={13} strokeWidth={2} className="shrink-0" />
                <span className="font-medium">本地改过了，推送时会先比对</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-[7px] bg-ok-soft px-2 py-[6px] text-[12px] text-ok">
                <Check size={13} strokeWidth={2} className="shrink-0" />
                <span className="font-medium">范围里没有要推的</span>
              </div>
            )
          ) : (
            <>
              {visible.length === 0 ? (
                <p className="px-1.5 pb-1 text-[12px] leading-relaxed text-ink-3">
                  变更都在程序文件里，已隐藏。
                </p>
              ) : (
                <div className="space-y-[1px]">
                  {visible.map((c) => (
                    <button
                      key={`${c.kind}:${c.path}`}
                      data-change-row={c.path}
                      /*
                       * 冲突行点开的是**选边面板**，不是这篇笔记本身：
                       * 它的待办不是"去写它"，而是"决定用哪一侧"，
                       * 打开编辑器只会让人看着一份不知道该信谁的内容发呆。
                       */
                      onClick={() => (c.kind === 'conflict' ? void openConflict(c.path) : setCurrent(c.path))}
                      title={c.kind === 'conflict' ? '两边都改过 —— 点开选一边' : c.path}
                      className="flex w-full items-center gap-2 overflow-hidden rounded-[7px] px-1.5 py-[5px] text-left transition-colors hover:bg-surface-2"
                    >
                      <span
                        className={`grid h-[19px] w-[19px] shrink-0 place-items-center rounded-[5px] ${kindTile(c.kind)} ${kindColor(c.kind)}`}
                      >
                        {kindIcon(c.kind)}
                      </span>
                      <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-[11px] text-ink-2">
                        {c.path}
                      </span>
                      <span className={`shrink-0 text-[10.5px] ${kindColor(c.kind)}`}>
                        {kindLabel(c.kind)}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {hidden > 0 && (
                <button
                  data-hidden-changes
                  onClick={() => setShowAll(true)}
                  className="mt-1 flex w-full items-center gap-1.5 rounded-[7px] px-1.5 py-[5px] text-left text-[11px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
                  title="程序文件的变更同样会同步，只是这里不显示"
                >
                  <EyeOff size={12} className="shrink-0" />
                  另有 {hidden} 项程序文件变更（照常推送）
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
