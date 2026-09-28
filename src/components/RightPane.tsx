import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useStore } from '../lib/store';
import type { RightTab } from '../lib/store';
import { useMedia, WIDE } from '../lib/media';
import { outlineOf } from '../lib/links';
import BacklinkPane from './BacklinkPane';
import MissingPane from './MissingPane';
import BookAside from './BookAside';
import { ListBullet, Sparkle } from './icons';

/*
 * 右侧边栏 —— 布局对齐 Obsidian 的第三条柱子：
 *
 *   左栏回答「库 里有什么」，正文回答「这一篇写了什么」，
 *   右栏回答「这一篇在书架的哪一层、跟别的篇有什么来往」。
 *
 * ## 现在这一栏有**两页**
 *
 *   大纲页 —— 大纲 / 关系 / 待建，就是原来那三节；
 *   助手页 —— AI 助手（那个会读你笔记的东西）。
 *
 * 助手为什么要长在这一栏里、而不是另一个浮层：
 * 它读的就是**你正在写的这一篇**，隔着一层遮罩问「这篇讲了什么」是自找别扭 ——
 * 人要能一边看着正文一边问。而且浮层一开就把主区挡掉一半，
 * 而这一栏本来就在那儿，宽度还是可调的（200~520）。
 *
 * ## 两条不能破的
 *
 *   ① **收起按钮不在这一栏里**，它在顶栏（`TopBar` 的 `data-right-toggle`）——
 *      开关长在栏自己身上，栏一收按钮就跟着没了，人只能靠猜把它叫回来。
 *   ② **手机上整条不渲染**（≤768px），关系面板回正文底部。所以手机上也没有助手 ——
 *      那颗星在手机上同样不出现（见 TopBar）：给了就是一颗按了没反应的按钮。
 *
 * ## 翻页不销毁助手
 *
 *   翻回大纲那一页时助手**留着不拆**（只是藏起来）。拆了的话：
 *   ① 聊到一半的内容没了；② agent 实例被 dispose，回来要重新起一遍。
 *   ⚠️ 代价是内核那包一旦加载就不卸载 —— 但那是"翻开过助手"的人，付得起。
 *   ⛔ 反过来也成立：**没翻开过就别加载**（`armed`），不然每个只想看文件列表的
 *      人开局就得下那一百多 kB。
 */

/*
 * AI 助手**按需加载** —— 它拖着整个 vendored 内核（一百多 kB），
 * 只有真翻到助手那一页的人需要它。⚠️ 别改成静态 import。
 */
const ChatPane = lazy(() => import('./ChatPane'));

/** 这一栏顶上那一排签。两颗，一眼看得出翻到哪页了 */
const TAB_BTN =
  'flex h-[30px] min-w-0 flex-1 items-center justify-center gap-1 rounded-[8px] px-1 text-[11.5px] transition-colors';

const TABS: { id: RightTab; label: string; icon: ReactNode }[] = [
  { id: 'outline', label: '大纲', icon: <ListBullet size={12} /> },
  { id: 'agent', label: '助手', icon: <Sparkle size={12} /> },
];

/** 一节的小标题：eyebrow 字 + 一条 hairline，跟左栏的 Section 一套。 */
function PaneSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="flex h-8 items-center gap-2 pl-1 pr-0.5">
        <span className="eyebrow">{label}</span>
        <span className="h-px min-w-2 flex-1 bg-line" />
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function OutlinePage() {
  const current = useStore((s) => s.current);
  const files = useStore((s) => s.files);
  const setPendingHeading = useStore((s) => s.setPendingHeading);

  const text = current ? (files[current] ?? '') : '';
  const isMd = current ? current.toLowerCase().endsWith('.md') : false;
  const outline = useMemo(() => (isMd ? outlineOf(text) : []), [text, isMd]);

  // 没开任何一篇：这一页照常在（布局不跳），给一句说明为什么是空的
  if (!current) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <PaneSection label="本页">
          <p className="px-1 py-1.5 text-[11.5px] leading-relaxed text-ink-3">
            打开一篇笔记，这里会列出它的小标题和它跟别的篇的关系。
          </p>
        </PaneSection>
      </div>
    );
  }

  const jump = (heading: string) => setPendingHeading(heading);

  return (
    <div data-rightpane-body className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
      {/*
        大纲。缩进 = (level-1) × 10px，和左栏目录树一个节奏；
        一二级标题是"这一页的骨架"，给足字重，三往下自然退后。
      */}
      <PaneSection label="大纲">
        {outline.length === 0 ? (
          <p className="px-1 py-1.5 text-[11.5px] leading-relaxed text-ink-3">
            {isMd ? '还没有小标题 —— 在正文里写 # 开头的一行就有了。' : '这篇不是 markdown，没有大纲。'}
          </p>
        ) : (
          <nav data-outline className="space-y-px pb-1">
            {outline.map((h, i) => (
              <button
                key={`${i}-${h.text}`}
                type="button"
                data-outline-item={h.text}
                onClick={() => jump(h.text)}
                title={`跳到「${h.text}」`}
                style={{ paddingLeft: 4 + (h.level - 1) * 10 }}
                className={`block w-full max-w-full truncate rounded-[6px] py-[4px] pr-1.5 text-left text-[12px] transition-colors hover:bg-surface-2 hover:text-ink ${
                  h.level <= 2 ? 'font-medium text-ink' : 'text-ink-2'
                }`}
              >
                {h.text}
              </button>
            ))}
          </nav>
        )}
      </PaneSection>

      <PaneSection label="关系">
        {isMd ? (
          <BacklinkPane path={current} text={text} variant="side" />
        ) : (
          <p className="px-1 py-1.5 text-[11.5px] leading-relaxed text-ink-3">这篇不是 markdown，没有链接关系。</p>
        )}
      </PaneSection>

      {/*
        全库的「待建笔记」。跟上面那节的区别：上面是**这一篇**的出链，
        这里是**所有篇**攒下来的悬空链接 —— 写的时候顺手写下打算以后补的那些。
      */}
      <PaneSection label="待建">
        <MissingPane />
      </PaneSection>

      {/* 底部收个尾：大纲很长时上面滚，这行字提醒下面还有一节 */}
      <div className="mt-auto flex items-center gap-1.5 pl-1 pt-2 text-[10.5px] text-ink-3">
        <ListBullet size={11} />
        大纲点一下就能跳过去
      </div>
    </div>
  );
}

const PANE_LOADING = <div className="px-3 py-3 text-[11.5px] text-ink-3">正在把助手叫出来…</div>;

export default function RightPane() {
  const wide = useMedia(WIDE);
  const side = useStore((s) => s.side);
  const currentBook = useStore((s) => s.currentBook);
  const tab = useStore((s) => s.rightTab);
  const setTab = useStore((s) => s.setRightTab);

  /*
   * 助手"开过没有"。第一次翻到那一页才 `lazy` 去加载内核；
   * 之后翻走也不收回 —— 见文件头「翻页不销毁助手」。
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (tab === 'agent') setArmed(true);
  }, [tab]);

  if (!wide) return null;

  /*
   * 读着书的时候右栏换成那本书的**目录 + 批注**。
   * 这时候两页签也收掉 —— 书的那一栏有它自己的内容，
   * 再挂一个「助手」页会让人以为助手也能读这本书（现在还不能）。
   *
   * ⚠️ 代价：读一本书再回来，助手那一页是**重新起的一次**（这一栏整条被换掉了，
   *    藏不住）。聊到一半的留不下 —— 那是"记住对话"那一摊还没做的事，
   *    不是把数据弄丢了：笔记该在的都还在。
   */
  if (side === 'read' && currentBook) return <BookAside />;

  return (
    <div data-rightpane-tabs className="flex min-h-0 flex-1 flex-col">
      {/*
        两页签。⛔ 助手没有第二个入口 —— 顶栏那颗星翻的也是这个 `rightTab`，
        跟这里的签是同一个状态，不会出现"点了星、签没跟着动"。
      */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-2">
        {TABS.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              data-right-tab={t.id}
              data-on={on ? '1' : '0'}
              aria-pressed={on}
              onClick={() => setTab(t.id)}
              className={`${TAB_BTN} ${
                on ? 'bg-surface-2 font-medium text-ink shadow-xs' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'
              }`}
            >
              {t.icon}
              <span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/*
        助手那一页：翻走时**只藏不拆**（换 `hidden` 这个类，不是不渲染）。
        ⚠️ 藏起来的那个外层不能带 `flex` 之类的显示类 —— `.flex` 会盖掉
        `.hidden` 的 `display:none`，那它就还在那儿占位。
      */}
      {armed && (
        <div className={tab === 'agent' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <Suspense fallback={PANE_LOADING}>
            <ChatPane />
          </Suspense>
        </div>
      )}

      {/* 第一次翻过来、内核那包还在路上时给一句交代 */}
      {tab === 'agent' && !armed && PANE_LOADING}

      {tab !== 'agent' && <OutlinePage />}
    </div>
  );
}
