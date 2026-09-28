import { Suspense, lazy, useEffect, useState } from 'react';
import FileTree from './components/FileTree';
import Resizer from './components/Resizer';
import ChangeList from './components/ChangeList';
import SideDock from './components/SideDock';
import RemotePane from './components/RemotePane';
import ConflictPane from './components/ConflictPane';
import RightPane from './components/RightPane';
import DeleteBanner from './components/DeleteBanner';
import { EditorLoading, EmptyState, BookEmptyState } from './components/EmptyState';
import StatusBar from './components/StatusBar';
import RepoGate from './components/RepoGate';
import TopBar from './components/TopBar';
import { useStore } from './lib/store';
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './lib/store';
import { isBinaryPath } from './lib/binary';

/*
 * 编辑器**按需加载**。它带着 Milkdown / Crepe / KaTeX，压缩后 1.4MB ——
 * 而首屏真正需要的只有文件列表和顶栏。静态 import 的话，主包里就会多出这 1.4MB，
 * 手机在局域网/4G 上打开要白等好几秒，只为了看一个文件列表。
 * 拆开之后：主包只有几百 KB，点开第一篇笔记时才去下编辑器。
 * ⚠️ 别把 EditorPane 改成静态 import —— 首屏包体会当场涨回 1.7MB。
 */
const EditorPane = lazy(() => import('./components/EditorPane'));
// 附件预览（图片 / PDF）。它自己很轻，里面的 pdf.js 是三级懒加载 ——
// 打开一张图不该为"也许以后要看 PDF"付 1MB
const PreviewPane = lazy(() => import('./components/PreviewPane'));
// 设置同理：它是「另一处地方」，不是顺手蘸一下的抽屉 —— 只有点开齿轮的人才需要它，
// 而那一次拆出来的包里有完整的分节内容（尤其阅读那一节的预览）
const SettingsDialog = lazy(() => import('./components/SettingsDialog'));
// 阅读器同编辑器：只有真去看书的人才需要它（它带着 epub 解压那一摊）
const BookPane = lazy(() => import('./components/BookPane'));
/*
 * AI 助手的懒加载在 `RightPane` 里 —— 它是右栏的一页，
 * 只有翻到那一页的人才需要内核那一坨（40 多个模块）。
 */

export default function App() {
  const token = useStore((s) => s.token);
  const refreshPlan = useStore((s) => s.refreshPlan);
  const drawer = useStore((s) => s.drawer);
  const setDrawer = useStore((s) => s.setDrawer);
  const current = useStore((s) => s.current);
  const settings = useStore((s) => s.settings);
  const rightOpen = useStore((s) => s.rightOpen);
  const leftOpen = useStore((s) => s.leftOpen);
  const currentBook = useStore((s) => s.currentBook);
  const side = useStore((s) => s.side);
  const loadBooks = useStore((s) => s.loadBooks);
  const loadReaderPrefs = useStore((s) => s.loadReaderPrefs);
  const editorFont = useStore((s) => s.editorFont);
  const sidebarL = useStore((s) => s.sidebarL);
  const sidebarR = useStore((s) => s.sidebarR);
  const setSidebar = useStore((s) => s.setSidebar);
  const initRepo = useStore((s) => s.initRepo);
  const repoReady = useStore((s) => s.repoReady);
  const repoNotice = useStore((s) => s.repoNotice);
  const setRepoNotice = useStore((s) => s.setRepoNotice);
  const autoPush = useStore((s) => s.autoPush);
  const autoPushMin = useStore((s) => s.autoPushMin);
  const remotePane = useStore((s) => s.remotePane);
  const setRemotePane = useStore((s) => s.setRemotePane);
  const conflictOf = useStore((s) => s.conflictOf);
  const closeConflict = useStore((s) => s.closeConflict);
  /*
   * 拖动中的临时宽度。**它只在按住的那一刻存在**：
   * 拖一次会跑出上百次 onResize，而每次写 store 都会触发 persist
   * （那份里装着整个 files，序列化一遍是 MB 级的）；
   * 所以拖的时候只改这里，松手才 `setSidebar` 落库一次。
   */
  const [dragW, setDragW] = useState<{ side: 'L' | 'R'; px: number } | null>(null);
  const wL = dragW?.side === 'L' ? dragW.px : sidebarL;
  const wR = dragW?.side === 'R' ? dragW.px : sidebarR;

  /*
   * 启动第一件事是**把仓库打开**（笔记是磁盘上真的一堆 .md）。
   * 它没打开之前 `files` 是空的，而这时候去比对是危险的 ——
   * 见下面那条 `repoReady` 的闸门。
   */
  useEffect(() => {
    void initRepo();
    // 书目在 IndexedDB，启动时读一次 —— 书架要是空的，得让人知道是真的还没导入
    void loadBooks();
    // 排版偏好也在 IndexedDB。趁启动时读一趟：两个入口（阅读器 / 设置）共用这一份
    void loadReaderPrefs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * 启动时的那次自动比对 —— **只跑一次**，且要等仓库读完。
   *
   * ⚠️ 等仓库读完不是"讲卫生"，是**防事故**：笔记的真身是磁盘上那一堆 .md
   * （异步读进来的），没读完时 `files` 是空的，这时拿空表去比对的结论会是
   * 「远端那一堆文件本地全删了」—— 一步同步就把远端清空了。
   *
   * ⚠️ 依赖里**不能有 token**：凭据框是逐字写入 store 的，带上它之后
   * 每敲一个字符都会打一次 GitHub（而且是用半截的 token，必吃 401）。
   * 改完凭据要重新比对，左下角那颗「刷新差异」就在那儿。
   */
  useEffect(() => {
    if (!token || !repoReady) return;
    void refreshPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoReady]);

  /*
   * 定时推送。**只在应用开着时** —— 关了窗口就是一个普通网页，没有后台这一说
   * （真要后台常驻得进 Tauri 起定时器 + 托盘，那是另一件事，所以设置里写明了）。
   *
   * 三个闸门，缺一个都不推：
   *   ① 仓库读完了（没读完时 `files` 是空的，推＝删远端）
   *   ② 这一轮没有别的动作在跑（busy）
   *   ③ **先比对再推** —— 直接用上一轮的 `changes` 会推到过期结论
   *      （本地刚改过但没比对时，那份清单是旧的）
   *
   * ⚠️ 依赖里**不写 changes / busy**：它们每敲一下键盘都在变，带上它们定时器
   * 会被反复重建，等于永远走不到点。所以里头用 `useStore.getState()` 现取。
   */
  useEffect(() => {
    if (!autoPush || !token || !repoReady) return;
    const timer = setInterval(() => {
      void (async () => {
        const s = useStore.getState();
        if (s.busy || s.settings) return; // 设置面板开着时不动手 —— 别在人家改配置的当口推
        await s.refreshPlan();
        const now = useStore.getState();
        if (now.busy) return;
        if (!now.changes.some((c) => c.kind.startsWith('push'))) return; // 没有要推的就别打远端
        await now.doPush();
      })();
    }, autoPushMin * 60 * 1000);
    return () => clearInterval(timer);
  }, [autoPush, autoPushMin, token, repoReady]);

  // 仓库那边的一次性交代（迁移 / 暂存提醒）：几秒后自己收掉，不用人去点
  useEffect(() => {
    if (!repoNotice) return;
    const t = setTimeout(() => setRepoNotice(null), 6000);
    return () => clearTimeout(t);
  }, [repoNotice, setRepoNotice]);

  // Esc 收抽屉。手机上没键盘，但桌面缩窄窗口时它就是个正常的浮层，
  // 而且「按 Esc 关掉浮层」是用户的第一直觉。
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer, setDrawer]);

  // 两个浮层同理：Esc 收掉是第一直觉（设置面板自己管自己的 Esc）
  useEffect(() => {
    if (!remotePane) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRemotePane(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [remotePane, setRemotePane]);

  useEffect(() => {
    if (!conflictOf) return;
    const onKey = (e: KeyboardEvent) => {
      // ⚠️ 选边这个面板 Esc 关掉是**不处理**，不是取消 —— 冲突还留在清单里，没有危险动作
      if (e.key === 'Escape') closeConflict();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [conflictOf, closeConflict]);

  return (
    <div
      className="desk flex h-full flex-col"
      /*
       * 编辑器字号走这条根上的 CSS 变量：状态栏 A− / A+ 改 store 的 editorFont，
       * 这里内联注进去，.milkdown-wrap 消费（正文 + 全部 em 排版一起缩放）。
       * 放根节点而不是编辑器组件里 —— 变量从上往下流，中途谁要用谁取。
       * React.CSSProperties 不认自定义属性，只能这样绕一下类型。
       */
      style={
        {
          '--editor-font': `${editorFont}px`,
          '--sidebar-l': `${wL}px`,
          '--sidebar-r': `${wR}px`,
        } as React.CSSProperties
      }
    >
      {/*
        顶栏：这一屏的坐标轴（我在哪一半 / 打开的是谁 / 两栏摊开到什么程度）。
        ⚠️ 它是**全应用唯一的一条 header**，且永远在最上面 —— 有测试钉着这一点。
      */}
      <TopBar />

      <div className="relative flex min-h-0 flex-1">
        {/*
          手机上侧栏是浮层，得有一层能点的东西把它收回去。
          桌面端这层是 display:none，等于不存在。
        */}
        {drawer && (
          <div
            data-drawer-mask
            onClick={() => setDrawer(false)}
            className="absolute inset-0 z-30 hidden bg-ink/25 backdrop-blur-[1px] max-md:block"
          />
        )}
        {/*
          侧栏本体两种形态共用同一个节点：桌面端是常驻的 272px 列，
          ≤768px 时由 styles.css 把它变成从左侧推入的抽屉（data-open 控制位置）。
          这样切窗口宽度不会重建文件树，滚动位置和折叠状态都留着。

          桌面端这列是**透明的**：文件列表直接坐在台面上，只有"当前打开的那篇"
          才是一张白纸 —— 一边是散着的纸，一边是摊开的那张，层次就出来了。

          ⚠️ `leftOpen` 收起时这一列**整个不渲染**：主区要的是那点宽度，
          边上留一条窄轨又占地方又没人认得出那是按钮（右栏那条轨的教训）。
          叫回它的入口只有顶栏左端那颗箭头 —— 那颗永远在。
        */}
        {leftOpen && (
          <aside
            data-drawer
            data-open={drawer ? '1' : '0'}
            /*
             * 宽度走 CSS 变量而不是内联：`width` 一旦内联，就会压过 styles.css 里
             * 手机抽屉那条媒体查询（`width: min(80vw, 292px)`）—— 抽屉要么撑爆屏幕、
             * 要么窄得只剩一条。变量则会被媒体查询正常覆盖。
             */
            className="flex w-[var(--sidebar-l,272px)] shrink-0 flex-col border-r border-line bg-paper md:bg-transparent"
          >
            <FileTree />
            <ChangeList />
            {/*
              左栏底上那条 dock：刷新差异 + 设置（同步那颗在底部状态栏）。
              放在这一列的最后一层 = 永远贴在左下角；手机上这一列是抽屉，
              dock 跟着抽屉一起滑进来，就在手指够得着的地方。
            */}
            <SideDock />
          </aside>
        )}
        {/*
          左栏的分隔条：拖它调这一列多宽。
          放在 aside **外面**（跟 main 平级）而不是 aside 里面 ——
          它是"两栏之间那条缝"，不属于任何一栏；塞进栏里就得靠绝对定位，
          而绝对定位一碰上手机那条抽屉（position: absolute）就会长错地方。
          ⚠️ 左栏收起时也一并收掉：没有那一列就没有缝可拖。
        */}
        {leftOpen && (
          <Resizer
            side="left"
            width={wL}
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            onResize={(px) => setDragW({ side: 'L', px })}
            onCommit={(px) => {
              setSidebar('L', px);
              setDragW(null);
            }}
            onReset={() => {
              setSidebar('L', SIDEBAR_DEFAULT.L);
              setDragW(null);
            }}
          />
        )}
        <main className="min-w-0 flex-1">
          {/*
            没选文件时不挂编辑器 —— 空态是个纯静态的提示，让它去拉编辑器那 1.4MB 是纯浪费。
            Suspense 的 fallback 只在「第一次点开文件、包还在路上」时出现，
            之后再切文件都是瞬间的（模块已经载入了）。
          */}
          {/*
            两边共用同一块主区，所以"现在该显示什么"先问**在哪一边**（side），
            再问手上有没有东西（currentBook / current）：
            切到书写去改笔记的时候，《某本书》仍然是 currentBook —— 它得留着，
            因为翻回阅读这一边要立刻回到刚才读到的那一页（这是它存在的全部理由）。
            但如果只按 currentBook 判定，人就永远写不了笔记了。
          */}
          {side === 'read' ? (
            /*
             * 阅读这一边，主区就只说阅读的事：有书开阅读器，没书摆这边的空态。
             * **不把笔记编辑器留在原地** —— 人切过来是要读书的，身后挂着半篇
             * 没写完的笔记只会让人分神；切回书写那一边它原样回来（编辑器模块
             * 已在内存里，不存在重载的代价）。
             */
            currentBook ? (
              <Suspense fallback={<EditorLoading path="" />}>
                <BookPane />
              </Suspense>
            ) : (
              <BookEmptyState />
            )
          ) : current ? (
            <Suspense fallback={<EditorLoading path={current} />}>
              {isBinaryPath(current) ? <PreviewPane /> : <EditorPane />}
            </Suspense>
          ) : (
            <EmptyState />
          )}
        </main>
        {/*
          右栏：大纲 + 关系（布局对齐 Obsidian 的第三条柱子）。
          手机上整条不渲染（组件内部用同一条媒体查询自己摘自己，
          关系面板那会儿回正文底部）；桌面可用顶栏的按钮收起。
        */}
        {rightOpen ? (
          <>
            <Resizer
              side="right"
              width={wR}
              min={SIDEBAR_MIN}
              max={SIDEBAR_MAX}
              onResize={(px) => setDragW({ side: 'R', px })}
              onCommit={(px) => {
                setSidebar('R', px);
                setDragW(null);
              }}
              onReset={() => {
                setSidebar('R', SIDEBAR_DEFAULT.R);
                setDragW(null);
              }}
            />
            <aside
              data-rightpane
              className="hidden w-[var(--sidebar-r,250px)] shrink-0 flex-col border-l border-line bg-paper-2/30 md:flex"
            >
              <RightPane />
            </aside>
          </>
        ) : null /*
           ⚠️ 收起之后**不再留窄轨**。
           那条 18px 的轨当初是"把右栏叫回来的第二个入口"，但它的前提是错的：
           开关已经长在顶栏上了（栏收起它照样在），轨就成了纯粹的装饰 ——
           白占 18px，且没人认得出那是按钮（早先 12px 时更是如此）。
           现在收起 = 整列消失，要回来点顶栏那颗。
         */
        }
      </div>
      {/*
        删除确认横跨整屏、压在状态栏上面：它不能被收进左栏 ——
        手机上左栏是抽屉，关上就再也点不到「确认」了。
      */}
      <DeleteBanner />
      <StatusBar />
      {settings && (
        <Suspense fallback={null}>
          <SettingsDialog />
        </Suspense>
      )}
      {remotePane && <RemotePane />}
      {conflictOf && <ConflictPane />}
      {/*
        ⛔ 助手**不挂在这儿** —— 它是右栏的一页（`RightPane` 里那排签），
        挂在这儿就又变回浮层了，而且会跟那一页同时存在两个实例。
      */}
      {/*
        仓库那边的交代（「把 N 篇老笔记搬进来了」/「现在只是暂存」）。
        压在状态栏上面一点点，几秒后自己消失 —— 它是个交代，不是个需要处理的任务。
      */}
      {repoNotice && (
        <div
          data-repo-notice
          className="pointer-events-none fixed bottom-9 left-1/2 z-[55] max-w-[min(440px,92vw)] -translate-x-1/2 rounded-[9px] border border-line bg-surface px-3 py-2 text-[11.5px] leading-snug text-ink-2 shadow-pop"
        >
          {repoNotice}
        </div>
      )}
      {/* 仓库没定下来时挡在最前面 —— 它是唯一一处"选错了要搬家"的决定 */}
      <RepoGate />
    </div>
  );
}
