import { useStore } from '../lib/store';
import { titleOf } from '../lib/links';
import ModeSwitch from './ModeSwitch';
import { PanelRight, Sparkle } from './icons';

/*
 * 顶栏：**这一屏的坐标轴**。
 *
 * ## 为什么要有这一条
 *
 * 之前界面是"左栏 + 主区"两条竖列，没有横着的一条把整屏框住 ——
 * 于是「我现在在书写还是阅读」「打开的是哪一篇」「左右两栏收在哪儿」
 * 这三件事各自散在不同的角落里：切换在左栏最顶上、路径只在编辑器抬头里、
 * 收右栏的按钮长在右栏自己头上（栏一收连按钮一起没了）。
 * 看的人得先把视线扫一圈才能拼出"我在哪儿"，这就是"丑"的来源 ——
 * 不是配色，是**没有骨架**。
 *
 * ## 三段，各管一件事
 *
 *   ① **左：书写 / 阅读**。它回答"我在哪一半"。放最左是因为它是这一屏的
 *      **身份**，不是某一个动作 —— 动作都该往右靠。
 *   ② **中：当前文件路径（面包屑）**。它回答"我打开的是谁"。
 *      目录段**可以点**：点了就选中那个目录，新建笔记的落点跟着走
 *      （跟左栏点目录行是同一件事 —— 落点只有一份，在 store 的 pickedDir）。
 *   ③ **右：两栏的收起 / 展开**。它回答"这一屏摊开到什么程度"。
 *      ⚠️ **必须长在这儿**：收起一栏的按钮要是长在那一栏自己身上，
 *      栏一收起按钮就跟着消失了 —— 人只能靠猜把它叫回来。
 *
 * ## 两条不能破的
 *
 *   ① 顶栏只有**一条**，且永远是这一屏最上面那条（`header` 就是它）。
 *      已经有测试钉着"页面里 `header` 只有一个"。
 *   ② 手机上**不出现收栏的箭头**：手机上左栏是浮上来的抽屉（归状态栏那颗 ☰ 管），
 *      右栏压根不渲染。给了就是一颗按了没反应的按钮。
 *   ③ **助手的入口只有这一颗**。左栏那条 dock 是 272px 里匀四颗，
 *      再塞第五颗就是"把字挤没了"；而助手不是"某一栏的事"，它读的是整个仓库 ——
 *      跟"我在哪一半 / 打开的是谁 / 摊开到什么程度"一样，是这一屏级的坐标。
 */

/*
 * 右侧那两颗收栏按钮。
 * 图标说的是**哪一栏**（PanelRight = 面板在右；转 180° = 面板在左），
 * 不是"往哪收" —— 图标跟着开合转来转去的话，人每次都得重新认一遍它是什么意思。
 * 开合看**底色**：开着 = 按下去了（灰底）；收着 = 没按下去（透底），
 * 但按钮一直在，收起之后照样点得到 —— 这正是它必须长在顶栏的原因。
 */
const TOGGLE_BTN =
  'grid h-7 w-7 shrink-0 place-items-center rounded-[8px] border transition-colors';

export default function TopBar() {
  const side = useStore((s) => s.side);
  const current = useStore((s) => s.current);
  const currentBook = useStore((s) => s.currentBook);
  const books = useStore((s) => s.books);
  const bookChapter = useStore((s) => s.bookChapter);
  const leftOpen = useStore((s) => s.leftOpen);
  const setLeftOpen = useStore((s) => s.setLeftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const setRightOpen = useStore((s) => s.setRightOpen);
  const setPickedDir = useStore((s) => s.setPickedDir);
  const rightTab = useStore((s) => s.rightTab);
  const setRightTab = useStore((s) => s.setRightTab);

  const reading = side === 'read';

  /*
   * 助手不再是浮层，是**右栏的一页**（`RightPane` 那排签）。
   * 所以这颗星翻的就是那个签：
   *   · 右栏收着 / 停在大纲页 → 展开右栏并翻到助手；
   *   · 已经停在助手页     → 收起右栏（这颗星把它叫出来的，就由它送回去）。
   * ⛔ 不另外开一扇门 —— 两个入口会出现"点了星、签没动"这种对不上的状态。
   */
  const onAgent = rightOpen && rightTab === 'agent';
  const toggleAgent = () => {
    if (onAgent) {
      setRightOpen(false);
      return;
    }
    setRightTab('agent');
    setRightOpen(true);
  };

  /*
   * 正读着一本书时右栏整条换成那本书的目录 + 批注（没有那排签），
   * 这时候这颗星按下去不会有任何事发生 —— 那就别给它。
   */
  const bookAside = reading && !!currentBook;

  /*
   * 面包屑：目录一段一段，最后一段是文件名。
   * 目录段做成按钮 —— 点它 = 选中这个目录（跟左栏点目录行同义）。
   * 只有一段（笔记直接躺在根目录）时就没有可点的目录段。
   */
  const segs = current ? current.split('/').filter(Boolean) : [];
  const dirs = segs.slice(0, -1);
  const leaf = segs[segs.length - 1] ?? '';

  /** 读到哪一章：目录里记的是 href，显示要的是标题 */
  const book = books.find((b) => b.id === currentBook);
  const chapterLabel = (() => {
    if (!book || !bookChapter) return null;
    const hit = book.toc.find((t) => t.href === bookChapter);
    return (hit?.label ?? titleOf(bookChapter)).trim();
  })();

  return (
    <header
      data-topbar
      className="flex h-[42px] shrink-0 items-center gap-2 border-b border-line bg-surface px-2 md:h-[44px] md:gap-3 md:px-3"
    >
      {/* ── 左：我在哪一半 ── */}
      <ModeSwitch />

      {/* ── 中：我打开的是谁 ── */}
      <div
        data-topbar-path
        className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-hidden text-[12px]"
      >
        {reading ? (
          book ? (
            <>
              <span className="min-w-0 truncate font-medium text-ink">{book.title}</span>
              {chapterLabel && (
                <>
                  <span className="shrink-0 px-0.5 text-ink-3">/</span>
                  <span className="min-w-0 truncate text-ink-3">{chapterLabel}</span>
                </>
              )}
            </>
          ) : (
            <span className="text-ink-3">书架上还没打开书</span>
          )
        ) : current ? (
          <>
            {dirs.length > 0 && (
              <span className="flex min-w-0 items-center">
                {dirs.map((d, i) => (
                  <span key={i} className="flex min-w-0 items-center">
                    {i > 0 && <span className="shrink-0 px-0.5 text-ink-3">/</span>}
                    <button
                      type="button"
                      data-crumb={dirs.slice(0, i + 1).join('/')}
                      onClick={() => setPickedDir(dirs.slice(0, i + 1).join('/'))}
                      title={`选中目录 ${dirs.slice(0, i + 1).join('/')}（新笔记落在那儿）`}
                      className="min-w-0 max-w-[9rem] truncate rounded-[5px] px-1 py-px text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      {d}
                    </button>
                  </span>
                ))}
                <span className="shrink-0 px-0.5 text-ink-3">/</span>
              </span>
            )}
            <span className="min-w-0 truncate font-medium text-ink" title={current}>
              {leaf}
            </span>
          </>
        ) : (
          <span className="text-ink-3">还没打开笔记</span>
        )}
      </div>

      {/* ── 右：这一屏摊开到什么程度 + 助手 ── */}
      <div className="flex shrink-0 items-center gap-1">
        {/*
          两颗收栏箭头跟助手那颗星**同生同灭**：都只在桌面（≥768px）出现。
          手机上右栏整条不渲染，助手也就没有地方长 —— 那颗星给了就是一颗
          按了没反应的按钮。读着一本书时同理（右栏换成了书的目录）。
        */}
        <div className="hidden shrink-0 items-center gap-1 md:flex">
        {!bookAside && (
          <button
            type="button"
            data-agent-toggle
            data-on={onAgent ? '1' : '0'}
            onClick={toggleAgent}
            aria-pressed={onAgent}
            title={onAgent ? '收起右栏（助手）' : 'AI 助手：右栏翻到助手那一页'}
            aria-label="AI 助手"
            className={`${TOGGLE_BTN} ${
              onAgent
                ? 'border-accent-line bg-accent-soft text-accent'
                : 'border-transparent text-ink-3 hover:bg-surface-2 hover:text-ink'
            }`}
          >
            <Sparkle size={14} />
          </button>
        )}
        <button
          type="button"
          data-left-toggle
          data-on={leftOpen ? '1' : '0'}
          onClick={() => setLeftOpen(!leftOpen)}
          aria-pressed={leftOpen}
          title={leftOpen ? '收起左栏（文件列表）' : '展开左栏（文件列表）'}
          aria-label={leftOpen ? '收起左栏' : '展开左栏'}
          className={`${TOGGLE_BTN} ${
            leftOpen
              ? 'border-line bg-surface-2 text-ink hover:bg-surface-3'
              : 'border-transparent text-ink-3 hover:bg-surface-2 hover:text-ink'
          }`}
        >
          <PanelRight size={14} className="rotate-180" />
        </button>
        <button
          type="button"
          data-right-toggle
          data-on={rightOpen ? '1' : '0'}
          onClick={() => setRightOpen(!rightOpen)}
          aria-pressed={rightOpen}
          title={rightOpen ? '收起右栏（大纲 / 关系）' : '展开右栏（大纲 / 关系）'}
          aria-label={rightOpen ? '收起右栏' : '展开右栏'}
          className={`${TOGGLE_BTN} ${
            rightOpen
              ? 'border-line bg-surface-2 text-ink hover:bg-surface-3'
              : 'border-transparent text-ink-3 hover:bg-surface-2 hover:text-ink'
          }`}
        >
          <PanelRight size={14} />
        </button>
        </div>
      </div>
    </header>
  );
}
