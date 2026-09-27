import { useStore } from '../lib/store';
import { Alert } from './icons';

/*
 * 「这轮要删远端」的确认条。
 *
 * 删远端不可逆：默认只拉不删，把清单摆出来等人点头。
 *
 * 位置在状态栏上方、横跨整屏 —— 不能跟着左栏走：手机上左栏是个抽屉，
 * 收起来的时候抽屉里的东西一概看不见，而触发它的同步按钮就在抽屉里，
 * 关上抽屉就成了一笔没人点头的删除。
 */

export default function DeleteBanner() {
  const busy = useStore((s) => s.busy);
  const pendingDeletes = useStore((s) => s.pendingDeletes);
  const cancelDeletes = useStore((s) => s.cancelDeletes);
  const doPush = useStore((s) => s.doPush);

  if (!pendingDeletes) return null;

  return (
    <div
      data-delete-confirm
      className="flex shrink-0 items-center gap-3 border-t border-danger-line bg-danger-soft px-4 py-2.5 max-md:gap-2 max-md:px-3"
    >
      <Alert size={14} className="shrink-0 text-danger" />
      <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-danger max-md:text-[12px]">
        这轮同步要从远端删掉 {pendingDeletes.length} 个文件：
        <span className="font-mono">{pendingDeletes.join('、')}</span>
      </span>
      <button
        data-delete-cancel
        onClick={cancelDeletes}
        className="shrink-0 rounded-[8px] border border-danger-line bg-surface px-2.5 py-[4px] text-[12px] text-ink-2 transition-colors hover:text-ink max-md:h-8 max-md:px-3"
      >
        先不删
      </button>
      <button
        data-delete-ok
        onClick={() => void doPush(true)}
        disabled={busy !== null}
        className="shrink-0 rounded-[8px] bg-danger px-3 py-[4px] text-[12px] font-medium text-white shadow-xs transition-opacity hover:opacity-90 disabled:opacity-40 max-md:h-8 max-md:px-3"
      >
        确认删除
      </button>
    </div>
  );
}
