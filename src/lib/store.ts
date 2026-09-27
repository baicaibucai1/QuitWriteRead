import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Change } from './decide';
import type { FileMap, Snapshot } from './sync';
import { planSync, pushOnce, pullOnce, resolveConflict } from './sync';
import type { ConflictSide } from './sync';
import { DEFAULT_SCOPE, normalizeScope } from './scope';
import type { PushScope } from './scope';
import { dedupePath, importBase, noteBody, notePath } from './note';
import { stripExt } from './mdimport';
import type { ImportReport } from './mdimport';
import { bytesToBase64, dataUrl, isBinaryPath } from './binary';
import type { GhConfig } from './gh';
import {
  createFolder as makeFolder,
  dirName,
  isFolderFile,
  moveEntry as movePath,
  parentOf,
  removeDir as dropDir,
  renameEntry as renamePath,
} from './folders';
import {
  canPickDir,
  defaultRepo,
  isTauri,
  openRepo,
  pickRepo,
  readInto,
  writeFrom,
} from './repo';
import type { Repo, RepoRef } from './repo';
import type { PathMove, RefactorResult } from './folders';
import {
  dirOf,
  noteNameOf,
  resolveWiki,
  retargetLinksMap,
  retargetMap,
  retitleBody,
  titleOf,
} from './links';
import {
  dropNote,
  getPrefs,
  listBooks,
  listNotes,
  newBookId,
  newNoteId,
  putBook,
  putNote,
  putPrefs,
  removeBook,
  sortNotes,
} from './bookdb';
import type { BookMeta, BookNote, ReaderPrefs } from './bookdb';
import type { ParsedBook } from './epub';
import { DEFAULT_PREFS, clampPrefs } from './readerstyle';
import { makeRemote } from './providers';
import type { ProviderId, Remote } from './providers';
import type { DavConfig } from './providers/webdav';
import type { OneDriveConfig } from './providers/onedrive';

const ENV_TOKEN = (import.meta.env.VITE_GH_TOKEN as string | undefined) ?? '';

export const OWNER = (import.meta.env.VITE_GH_OWNER as string | undefined) ?? 'baicaibucai1';
export const REPO = (import.meta.env.VITE_GH_REPO as string | undefined) ?? 'ramblings';
export const BRANCH = (import.meta.env.VITE_GH_BRANCH as string | undefined) ?? 'main';

type Busy = null | 'plan' | 'sync';

/**
 * 工作区的两边：**书写**（笔记库，同步）和 **阅读**（本地书架，不同步）。
 * 左栏顶上那条分段控件就是它，也决定了主区现在是编辑器还是阅读器。
 */
export type Side = 'write' | 'read';

/*
 * 两侧边栏宽度的上下限。
 * 下限 200：文件树再窄，目录名就开始被截断到看不出是哪个。
 * 上限 520：再宽就是"侧栏抢了正文" —— 这一列的内容（文件名、大纲）本来就该窄，
 * 而正文是主角；且屏窄的时候它会被挤到几乎一整屏。
 */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 520;
/** 出厂宽度。双击把手复位到这两个数 */
export const SIDEBAR_DEFAULT = { L: 272, R: 250 } as const;

/** 设置对话框里的四个分节。**每一项都得对应一节真内容**，空节不如不分 */
export type SettingsTab = 'general' | 'sync' | 'reading' | 'about';

/**
 * 每次「比对 / 同步」领一个号。异步回来时号被顶掉就说明有更新的操作在跑，
 * 这时**不能再写状态** —— 否则启动时的自动比对会把手动同步的 busy 清掉，
 * 界面显示「不忙」而请求还在飞，按钮也能再点一次。（踩过：端到端假绿）
 */
let opSeq = 0;

/** 改名 / 搬家完了给界面的一句话材料 —— 改了几处链接、标题动没动 */
export type EditOk = {
  ok: true;
  /** 新的路径 */
  to: string;
  /** 逐条映射（目录搬家时是一整个子树）。界面靠它重映射折叠集合和选中目录 */
  moved: PathMove[];
  /** 哪些篇里有链接被改写了，各几处 */
  links: { path: string; count: number }[];
  /** 这篇自己的正文标题有没有跟着改 */
  retitled: boolean;
};
export type EditResult = EditOk | { ok: false; error: string };

/** 当前打开的那篇在不在搬家的名单里 —— 在就跟着换路径，不然界面停在打不开的旧路径上 */
/** 异常 → 一句人话。IDB 抛的 DOMException 有 message，但有些只带 name */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/** 封面 → data URL。太大就不存 —— 书架是列表，不是相册 */
const COVER_LIMIT = 500 * 1024;
function coverUrlOf(parsed: ParsedBook): string | null {
  const path = parsed.cover;
  if (!path) return null;
  const bytes = parsed.files[path];
  if (!bytes || bytes.length > COVER_LIMIT) return null;
  try {
    return dataUrl(path, bytesToBase64(bytes));
  } catch {
    return null;
  }
}

function remapCurrent(cur: string | null, moved: PathMove[]): string | null {
  if (!cur) return cur;
  return moved.find((m) => m.from === cur)?.to ?? cur;
}

/*
 * 改名 / 搬家之后要跟着动的东西，一次性算完。
 *
 * 三件事，都是"只动该动的那一小片"：
 *   ① 全库扫一遍，把指向旧路径的双链改成新路径。
 *      改写表按 `r.moved` **每一条**分别建 —— 改目录名时整棵子树都在搬家名单上，
 *      只认顶层那一篇的话，`[[读书/2026/笔记]]` 这种带路径的链接就会漏掉。
 *      保形替换（全路径→全路径、裸名→裸名）见 retargetMap。
 *      base64 的图片 / PDF 不会命中 —— base64 字符表里没有 `[`。
 *   ② 这篇自己正文第一行的标题（只有 md 这么干）。
 *   ③ 目录改名时，那个 `.folder` 标识文件里的标题也跟着改 —— 那行本来就是我们生成的。
 *
 * 改完把「哪几篇动了、动了几处」带回去：界面要说"3 处引用跟着改了"，
 * 不说的话用户只能自己去翻有没有改错。
 */
function rewriteRefs(
  r: Extract<RefactorResult, { ok: true }>,
  oldPath: string,
  before: FileMap,
): { files: FileMap; links: { path: string; count: number }[]; retitled: boolean } {
  const oldTitle = titleOf(oldPath);
  const newTitle = titleOf(r.to) || noteNameOf(r.to);
  const files: FileMap = { ...r.files };
  const links: { path: string; count: number }[] = [];
  let retitled = false;

  /*
   * 改写表：搬家名单里每一条都贡献自己的四种写法。
   * `.folder` 标识文件不参与 —— 它不是笔记，没人会链它。
   * 多条撞同一个键时后写的覆盖先写的：真撞了说明两个同名文件一起搬，
   * 那种情况下 `[[名字]]` 本来就指不清是哪篇（resolveWiki 也只会挑一篇）。
   */
  const map = new Map<string, string>();
  for (const m of r.moved) {
    if (isFolderFile(m.from)) continue;
    for (const [k, v] of retargetMap(m.from, m.to)) map.set(k, v);
  }

  for (const [p, v] of Object.entries(files)) {
    if (typeof v !== 'string') continue;
    let next = v;
    const hit = retargetLinksMap(next, map);
    if (hit.count > 0) {
      next = hit.text;
      links.push({ path: p, count: hit.count });
    }
    // 正文标题：只认正在改的那一篇，且只认 md
    if (p === r.to && p.toLowerCase().endsWith('.md')) {
      const t = retitleBody(next, oldTitle, newTitle);
      if (t.changed) {
        next = t.text;
        retitled = true;
      }
    }
    if (next !== v) files[p] = next;
  }

  // 目录改名：标识文件（`.folder`）里那行标题跟着目录名走 —— 那行本来就是我们生成的。
  // 判"改的是不是目录"必须拿**改之前**的树判：改完老路径已经不存在了。
  if (looksLikeDir(before, oldPath)) {
    for (const m of r.moved) {
      if (!isFolderFile(m.to) || typeof files[m.to] !== 'string') continue;
      const t = retitleBody(files[m.to], dirName(parentOf(m.from)), dirName(parentOf(m.to)));
      if (t.changed) files[m.to] = t.text;
    }
  }

  return { files, links, retitled };
}

/** 这个路径底下有没有东西 —— 有就是目录。改名前用它判"改的是目录还是文件" */
function looksLikeDir(files: FileMap, path: string): boolean {
  const prefix = `${path}/`;
  return Object.keys(files).some((p) => p.startsWith(prefix));
}

/*
 * ── 仓库 ──
 * 笔记的真身是**本机文件夹里的一堆 .md**（见 lib/repo.ts），`files` 只是它在内存里的
 * 一份影子：启动时从仓库读进来，改完异步写回去。**仓库才是真相** ——
 * 所以 `files` 不再进 localStorage（那儿再存一份就是第二个真相，
 * 两边不一致时没人知道该信谁）。
 */
type State = {
  /**
   * 仓库的引用。**持久化** —— 下次打开还该是同一个文件夹。
   * `null` = 还没选（要出引导页）。
   */
  repo: RepoRef | null;
  /** 挡在界面前面的选仓库引导页。**不持久化** —— 每次启动重新判一次 */
  repoGate: boolean;
  /** 仓库读完了吗。没读完就显示"库是空的"是撒谎 */
  repoReady: boolean;
  repoBusy: boolean;
  /**
   * 仓库这边的岔子。跟同步的 `error` **分开**：
   * 「仓库都打不开」和「同步失败」是两件事，混在一个字段里会互相盖掉。
   */
  repoError: string | null;
  /** 一次性交代（「把浏览器里原有的 12 篇笔记搬进仓库了」）。空了就不显示 */
  repoNotice: string | null;
  token: string;
  files: FileMap;
  snapshot: Snapshot;
  current: string | null;
  changes: Change[];
  log: string[];
  error: string | null;
  busy: Busy;
  lastSyncAt: string | null;
  dirty: boolean;
  /** 左侧是否连程序文件（脚本、配置、README…）一起显示。只影响展示，不影响同步。 */
  showAll: boolean;
  /** 「创建笔记」后自增，编辑器据此把光标放进正文（不持久化）。 */
  focusTick: number;
  /** 待确认的远端删除（本轮比对要删但还没点头）。非空时界面必须问一次。 */
  pendingDeletes: string[] | null;
  /**
   * 本地改过、但还没重新比对 —— 这时的 `changes` 是上一次比对的结果，已经过期。
   * 界面必须说「还没比对」，不能说「与远端一致」（刚建完笔记却显示一致，是会误导人的）。
   */
  planStale: boolean;
  /**
   * 移动端（≤768px）侧栏抽屉是否展开。桌面端侧栏常驻，这个值不起作用。
   * **不持久化** —— 每次打开都该是收起的，不能让人一进来就被抽屉糊住整屏。
   */
  drawer: boolean;
  /** 台面壁纸。**持久化**（换台机器也该是同一张桌子）。 */
  /** 设置面板是否打开。不持久化 —— 每次进来被面板糊住半屏是打扰。 */
  settings: boolean;
  /**
   * 设置打开后停在哪个分节。之所以提到 store：阅读器的「更多排版」要能
   * 直接把人带到「阅读」那一节 —— 那个按钮在另一个组件里，隔着一层没法用局部状态传话。
   * **不持久化**：每次开设置都该从第一节看起，而不是停在别人上次走的地方。
   */
  settingsTab: SettingsTab;
  /** 同步到哪家。三种后端的凭据各自存一份，切来切去不用重填。 */
  provider: ProviderId;
  dav: DavConfig;
  od: OneDriveConfig;
  /**
   * 侧栏按标签筛选（点正文里的 `#tag` 进来的）。`null` = 不筛，照常按目录显示。
   * **不持久化** —— 下次打开看见列表只露出几个文件会以为文件丢了。
   */
  tagFilter: string | null;
  /**
   * 右侧边栏（大纲 + 关系）开不开。**不持久化** —— 跟 tagFilter 一条理由：
   * 下次打开若右栏莫名其妙没了，第一反应是坏了而不是"我上次收起的"。
   * 开关长在**顶栏**上（见 TopBar），不再长在右栏自己头上 ——
   * 收起之后那一列连按钮一起没了，人就没法把它叫回来了。
   */
  rightOpen: boolean;
  /**
   * 左栏（文件树那一列）开不开。同 `rightOpen`：**不持久化**，开关在顶栏上。
   * 收起时这一列**整列消失**（不留窄轨）—— 主区要的是那点宽度，
   * 边上永远留一条缝又占地方又没人认得出那是按钮。
   */
  leftOpen: boolean;
  /**
   * 左栏里**点选的那个目录** —— 「新笔记建在哪儿」。
   *
   * ⚠️ 提到 store 是因为**两个组件都要读写它**：左栏（点目录行）和顶栏（点面包屑里
   * 的目录段）。各存一份就会出现"顶栏点了目录、左栏的高亮没动"。
   * **不持久化**：下次打开看到上次点选的目录会莫名其妙。
   */
  pickedDir: string | null;
  /**
   * 点链接跳过去后要滚到哪个小节。配合 `jumpTick` 用：
   * 同一篇里点 `[[这篇#小节]]` 时 current 没变，光靠它触发不了滚动。
   */
  pendingHeading: string | null;
  jumpTick: number;

  /*
   * ── 书架 ──
   * ⚠️ 书目**不在** zustand 里持久化：书本身（几 MB 的字节）在 IndexedDB，
   * 这里只是启动时从那儿读出来的一份索引。
   */
  books: BookMeta[];
  /**
   * 正在读的那本。非空时主区换成阅读器、右栏换成这本书的目录与批注。
   * 左栏**不再让位** —— 读书时它仍然是书架，方便直接换书。
   */
  currentBook: string | null;
  /** 正在读那本书的全部批注（打开时从 IndexedDB 读一趟，之后本地维护） */
  bookNotes: BookNote[];
  /*
   * 整个工作区现在在哪一边：**书写**（笔记）/ **阅读**（书架）。
   *
   * 为什么要把它提成显式的一等状态，而不是寄存在一个「左栏显不显示书架」的布尔里：
   * 布尔值表达不了这两个层次，于是"打开一本书"反倒要把那个布尔置 false ——
   * 能跑，但读代码的人得先在脑子里把它翻译一遍。
   * 现在：side 持久化、currentBook 不持久化，各管一层。
   */
  side: Side;
  /**
   * 上次在读的那本。只为书架上那张「继续读」的卡片存在 ——
   * 持久化的 reason 同上：刷新之后我们不该直接把阅读器打开（重，且抢戏），
   * 但把"你上次读到哪本了"忘掉就很烦。
   */
  lastBookId: string | null;
  /** 导入 / 打开出的岔子说在这儿。书架上的失败一定要出声 —— 不然书"没进来"人不知道为什么 */
  bookError: string | null;
  /** 正在导入（epub 解压那一下是同步的，大书会卡住一小会儿） */
  bookBusy: boolean;
  /**
   * 让阅读器跳到某处。目录和搜索结果都走这儿 —— 它们在左栏，阅读器在主区，
   * 中间没有父子关系，只能靠 store 传话。`tick` 是为了"连续点同一个位置也要再跳一次"。
   * `at` 是纯文本里的第几个字（书内搜索定位用），只跳章节时为 null。
   */
  bookJump: { href: string; at: number | null; tick: number } | null;
  /** 阅读器正在显示哪一章 —— 目录靠它高亮"你在这儿" */
  bookChapter: string | null;
  /*
   * 右栏点了一条批注 → 阅读器滚过去，并把那一段短暂强调一下。
   * 跟 bookJump 分开是因为它要带 `id`（标记高亮哪一条），而且是**有别于搜索命中**的
   * 另一种跳法：批注的落点是它自己，命中才需要 <mark>。
   */
  noteJump: { id: string; tick: number } | null;

  /** 启动时调一次：把仓库打开、把里面的笔记读进来。读不出来就出引导页 */
  initRepo: () => Promise<void>;
  /** 换一个仓库（引导页 / 设置页「更换」都走这儿）。传进来的必须是已经打开的 */
  adoptRepo: (repo: Repo) => Promise<void>;
  /** 弹系统对话框让用户挑文件夹。取消什么都不做 */
  pickRepoDir: () => Promise<void>;
  /** 用出厂目录（程序自己的数据目录下的 repo）。只有桌面端有这个概念 */
  useDefaultRepo: () => Promise<void>;
  /** 把内存里还没落盘的那点改动立刻写回去。换仓库 / 关窗口前必须来一次 */
  flushRepo: () => Promise<void>;
  setRepoNotice: (s: string | null) => void;
  /** 这个环境能不能真的挑一个文件夹（不能的话只能暂存） */
  canPick: () => boolean;

  cfg: () => GhConfig;
  /** 当前后端造出来的 Remote（比对引擎只认这个接口）。 */
  remote: () => Remote;
  setProvider: (id: ProviderId) => void;
  setDav: (patch: Partial<DavConfig>) => void;
  setOd: (patch: Partial<OneDriveConfig>) => void;
  setToken: (t: string) => void;
  setShowAll: (v: boolean) => void;
  setDrawer: (v: boolean) => void;
  setSettings: (v: boolean) => void;
  /** 打开设置并停在某一节。阅读器那里的「更多排版」用它 */
  openSettings: (tab?: SettingsTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setCurrent: (path: string | null) => void;
  setContent: (path: string, text: string) => void;
  createFile: (path: string) => void;
  removeFile: (path: string) => void;
  /** 按「目录 + 标题」造一篇新笔记，返回最终路径（重名会自动加 -2）。 */
  createNote: (dir: string, title: string) => string;
  /**
   * 一次建多篇（「未建链接」那块的批量创建）。返回真正建出来的路径。
   * **不切 current、不抢焦点** —— 见实现处的注释。
   */
  createNotes: (items: { dir: string; title: string }[]) => string[];
  /**
   * 从本机导入一批 md（`name` 是**原文件名**，不是标题 —— 标题由文件名推出来）。
   * 一篇篇写盘，撞名加 -2，**绝不覆盖**已有笔记。返回建出来的路径和其中被改过名的。
   */
  importMarkdown: (items: { dir: string; name: string; text: string }[]) => ImportReport;
  /** 建文件夹（= 在目录里放一个隐藏标识文件）。返回最终目录名，非法输入返回 null。 */
  createFolder: (dir: string) => string | null;
  /**
   * 放一个附件进去（内容是 **base64**，不是原文）。返回最终路径（重名自动加 -2）。
   * 二进制不走 `setContent` —— 那条路会被当成文字，且两者都叫"设置内容"时
   * 很容易有人误把 base64 当正文存进来。
   */
  putAttachment: (dir: string, name: string, base64: string) => string;
  /** 删文件夹 = 删掉这个前缀下的所有文件。**不可逆**（远端要等同步确认）。 */
  removeFolder: (dir: string) => void;
  /**
   * 改名。文件就改文件名，目录就连里面所有东西一起换前缀。
   * **连带把全库指向它的双链和它自己的正文标题改掉**（见 rewriteRefs）——
   * 链接不断是这个功能存在的前提，只换个文件名等于把库里的链接留成一片悬空。
   */
  renameEntry: (path: string, newName: string) => EditResult;
  /**
   * 搬家：把某个文件 / 目录挪到另一个目录下（`''` = 根目录）。
   * 名字没变，所以正文和链接都不用动 —— `[[某篇]]` 是按名字找的，换了目录照样找得到。
   */
  moveEntry: (path: string, destDir: string) => EditResult;
  refreshPlan: () => Promise<void>;
  /** 推送：把**范围内**的本地改动推上去。`allowDelete` = 已确认过「就删这些」 */
  doPush: (allowDelete?: boolean) => Promise<void>;
  /** 拉取：把这几篇从远端拿回来。**人选的动作**，不是自动的 */
  doPull: (paths: string[]) => Promise<void>;
  /**
   * 推送范围。**持久化** —— 它是"我这个库打算推什么"的长期决定，不该每次重配。
   * 详见 lib/scope.ts 头上那段：范围外的文件同步层完全看不见，因此绝不会误删远端。
   */
  scope: PushScope;
  setScope: (next: PushScope) => void;
  /** 定时推送的开关与间隔（分钟）。只在应用开着时跑 */
  autoPush: boolean;
  autoPushMin: number;
  setAutoPush: (on: boolean, min?: number) => void;
  /**
   * 远端**全部**文件的指纹（含范围外的）。「浏览远端、挑几篇拉」靠它 ——
   * 不存下来的话，那个面板得自己再打一次远端，而它展示的还得跟清单里那份是同一份。
   */
  remoteFiles: Record<string, string>;
  /** 远端浏览面板开不开。**不持久化** —— 每次进来被它糊住半屏是打扰 */
  remotePane: boolean;
  setRemotePane: (v: boolean) => void;
  /**
   * 正在选边的那篇（两边都改过的）。**不持久化**。
   * 连同它一起存的是**云端那一版的正文** —— 差异要拿着两版才画得出来，
   * 而远端内容不该常驻在内存里（改一次就过期了）。
   */
  conflictOf: string | null;
  conflictRemote: string | null;
  conflictBusy: boolean;
  openConflict: (path: string) => Promise<void>;
  closeConflict: () => void;
  /** 选边：`local` 用本机 / `remote` 用云端 / `both` 两版都留 */
  resolve: (path: string, side: ConflictSide) => Promise<void>;
  cancelDeletes: () => void;
  /**
   * 点 `[[笔记]]` 要去的那一篇。**没有就当场建一篇**（Obsidian 的规矩）：
   * 链接写着呢，那这篇就该存在。建在哪儿 = 当前文件所在目录。
   */
  openWiki: (target: string, heading?: string) => { path: string; created: boolean } | null;
  setTagFilter: (tag: string | null) => void;
  setRightOpen: (v: boolean) => void;
  setLeftOpen: (v: boolean) => void;
  setPickedDir: (dir: string | null) => void;
  setPendingHeading: (h: string | null) => void;

  /**
   * 阅读器的排版（字体 / 字号 / 行距 / 纸色）。
   *
   * ⚠️ **IndexedDB 才是它的家**（bookdb 的 prefs 表），这里只是一份镜像 ——
   * 因为阅读器和设置对话框是两个互不相干的组件，各自读一遍 IDB 就是两份真理：
   * 在设置里把纸调成豆绿，读的时候会是白的（它那边的状态还没更新）。
   * 所以统一由 store 持有，改了先动内存再写盘，两个入口看见的永远是同一份。
   * 也因此它**不进 persist** —— localStorage 里再存一份就是第三个真理。
   */
  readerPrefs: ReaderPrefs;
  /** 启动时把那份偏好捡回来。失败就留在默认值，不该让设置页打不开 */
  loadReaderPrefs: () => Promise<void>;
  /** 左栏（文件树）宽度 px。拖动它的右边缘调，跟着人走（persist） */
  sidebarL: number;
  /** 右栏（大纲 / 关系 / 书的目录）宽度 px。同上，拖它的左边缘 */
  sidebarR: number;
  /** 改一侧的宽度（夹紧在 SIDEBAR_MIN ~ SIDEBAR_MAX）。拖动松手时才调它 —— 见 App 的说明 */
  setSidebar: (side: 'L' | 'R', px: number) => void;
  /**
   * 写笔记界面的正文字号（px）。**只管 md 编辑器这一块** —— 阅读器另有一份
   * （跟着书走的 ReaderPrefs），两者别混。状态栏那对 A− / A+ 调的就是它，
   * 落 localStorage（跟「显示全部」一个性质：界面偏好，轻）。
   */
  editorFont: number;
  /** 夹紧在 12–24 再写。±1 一档，滑出去的值（手改 localStorage）也会被夹回来 */
  setEditorFont: (px: number) => void;
  /** 改一项排版。落的盘的活在这儿做，调用方只管给 patch */
  setReaderPrefs: (patch: Partial<ReaderPrefs>) => Promise<void>;

  loadBooks: () => Promise<void>;
  /** 导入一本 epub（文件选择器 / 拖进来的那个 File） */
  importBook: (file: { name: string; arrayBuffer: () => Promise<ArrayBuffer> }) => Promise<void>;
  dropBook: (id: string) => Promise<void>;
  openBook: (id: string) => void;
  /** 不读了，回书架。**仍是阅读这一边** —— 这一层是 side 的事，不是这儿的 */
  closeBook: () => void;
  /** 换到书写 / 阅读那一边。`currentBook` 原样留着 —— 两边来回切不该把读到的地方丢了 */
  setSide: (v: Side) => void;
  setBookError: (e: string | null) => void;
  jumpBook: (href: string, at?: number | null) => void;
  setBookChapter: (href: string | null) => void;

  /** 打开一本书时把它攒下的批注读出来 */
  loadBookNotes: (bookId: string) => Promise<void>;
  /** 划了一段 —— `quote` 是那段原文，`text` 是写在旁边的想法（可以为空，那就只是划了重点） */
  addBookNote: (n: Omit<BookNote, 'id' | 'at'>) => Promise<void>;
  /** 改想法（划的范围不能改 —— 挪了位的批注已经不是原来那条了） */
  editBookNote: (id: string, text: string) => Promise<void>;
  dropBookNote: (id: string) => Promise<void>;
  /** 右栏点了一条批注 */
  jumpNote: (id: string) => void;
};

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      repo: null,
      repoGate: false,
      repoReady: false,
      repoBusy: false,
      repoError: null,
      repoNotice: null,
      token: ENV_TOKEN,
      files: {},
      snapshot: {},
      current: null,
      changes: [],
      log: [],
      error: null,
      busy: null,
      lastSyncAt: null,
      dirty: false,
      showAll: false,
      focusTick: 0,
      pendingDeletes: null,
      planStale: false,
      scope: DEFAULT_SCOPE,
      autoPush: false,
      autoPushMin: 30,
      remoteFiles: {},
      remotePane: false,
      conflictOf: null,
      conflictRemote: null,
      conflictBusy: false,
      drawer: false,
      settings: false,
      settingsTab: 'general',
      provider: 'github',
      // 坚果云的地址留着默认那个（就是它家的 WebDAV 入口），账号和应用密码要用户填
      dav: { url: 'https://dav.jianguoyun.com/dav/QuitWriteRead', user: '', pass: '' },
      od: { token: '', basePath: 'QuitWriteRead' },
      tagFilter: null,
      rightOpen: true,
      leftOpen: true,
      pickedDir: null,
      editorFont: 15.5,
      sidebarL: 272,
      sidebarR: 250,
      pendingHeading: null,
      jumpTick: 0,
      books: [],
      currentBook: null,
      bookNotes: [],
      readerPrefs: DEFAULT_PREFS,
      side: 'write',
      lastBookId: null,
      bookError: null,
      bookBusy: false,
      bookJump: null,
      bookChapter: null,
      noteJump: null,

      /*
       * ── 仓库 ──
       * 这几步的共同前提：**仓库没打开就不能装作库是空的**。
       * 打开失败一律出引导页并带上原因，绝不悄悄退回一个空库 ——
       * 那跟丢数据在人看来没有区别。
       */

      canPick: () => canPickDir(),

      initRepo: async () => {
        // 已经读完了就别再来一遍：React 的 StrictMode 会把挂载 effect 跑两次
        if (get().repoBusy || get().repoReady) return;
        set({ repoBusy: true, repoError: null });
        const ref = get().repo;
        if (ref) {
          try {
            await get().adoptRepo(await openRepo(ref));
          } catch (e) {
            // 上次那个仓库打不开了（文件夹被删 / 挪走 / 授权过期）→ 让人重新选，
            // **不要**自动降级 —— 自动降级之后人看见的是"笔记全没了"。
            set({ repoBusy: false, repoGate: true, repoError: errText(e) });
          }
          return;
        }
        if (isTauri()) {
          // 桌面端首次：挡在这儿选一次。出厂目录由引导页去准备
          set({ repoBusy: false, repoGate: true });
          return;
        }
        // 浏览器里没有"程序目录"这一说，而选文件夹的弹窗**必须在用户手势里才让开** ——
        // 启动时偷偷弹是不行的。所以先落在暂存上，想换真文件夹去设置页点一下。
        await get().adoptRepo(await openRepo({ kind: 'memory' }));
      },

      adoptRepo: async (repo) => {
        set({ repoBusy: true, repoError: null });
        try {
          const files = await loadFromRepo(repo);
          /*
           * 迁移：老版本把笔记存在 localStorage 里。第一次打开仓库时把它们搬进去 ——
           * 只在**仓库是空的**时候搬，否则换仓库会把两个库的内容混成一锅。
           */
          let notice: string | null = null;
          const legacy = legacyFiles();
          const n = Object.keys(legacy).length;
          if (n > 0 && Object.keys(files).length === 0) {
            Object.assign(files, legacy);
            notice = `把浏览器里原有的 ${n} 篇笔记搬进仓库了`;
          }
          repoHandle = repo;
          /*
           * 读进来的这份就是"已经落在仓库里"的状态 —— 之后每一次存盘都拿它当基准。
           * ⚠️ 别留成空表：那会让下一次 diff 以为"仓库里本来什么都没有"，
           * 于是只管写新的、**永远不删**（改名之后旧路径会一直躺在磁盘上）。
           */
          lastFiles = files;
          const cur = get().current;
          set({
            repo: repo.ref,
            files,
            /*
             * 上次打开到哪篇就回到哪篇；那篇没了（被删 / 换了仓库）就回到空态 ——
             * **不要**自作主张替人翻开第一篇：首屏本该是安静的空态，
             * 突然挂出一篇不知道是谁的笔记，比空着更让人疑惑。
             */
            current: cur && cur in files ? cur : null,
            repoGate: false,
            repoReady: true,
            repoBusy: false,
            repoNotice: notice,
          });
          /*
           * 迁移来的那批是**凭空多出来的**（它们不在刚读到的仓库里），
           * 而 diff 只写"跟基准不一样的东西"—— 它们跟基准一模一样，一个都不会被写。
           * 所以把基准清空，强制整批落一次盘。
           */
          if (notice) {
            lastFiles = {};
            await flush(files);
          }
        } catch (e) {
          set({ repoBusy: false, repoError: errText(e), repoGate: true });
        }
      },

      pickRepoDir: async () => {
        set({ repoError: null });
        try {
          const repo = await pickRepo();
          if (!repo) return; // 用户点了取消 —— 不是错误
          await get().flushRepo(); // 老仓库里还没落盘的那点先写完
          await get().adoptRepo(repo);
        } catch (e) {
          set({ repoError: errText(e) });
        }
      },

      useDefaultRepo: async () => {
        set({ repoError: null });
        try {
          const repo = await defaultRepo();
          if (!repo) {
            set({ repoError: '这个环境没有出厂目录 —— 要用桌面端' });
            return;
          }
          await get().flushRepo();
          await get().adoptRepo(repo);
        } catch (e) {
          set({ repoError: errText(e) });
        }
      },

      flushRepo: async () => {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        saving = saving.then(() => flush(get().files));
        await saving;
      },

      setRepoNotice: (s) => set({ repoNotice: s }),

      cfg: () => ({ owner: OWNER, repo: REPO, branch: BRANCH, token: get().token }),

      remote: () => {
        const s = get();
        return makeRemote(s.provider, {
          github: { owner: OWNER, repo: REPO, branch: BRANCH, token: s.token },
          nutstore: s.dav,
          onedrive: s.od,
        });
      },

      setProvider: (id) => set({ provider: id }),
      setDav: (patch) => set({ dav: { ...get().dav, ...patch } }),
      setOd: (patch) => set({ od: { ...get().od, ...patch } }),

      setToken: (t) => set({ token: t }),
      setShowAll: (v) => set({ showAll: v }),
      setDrawer: (v) => set({ drawer: v }),
      // 过一遍 normalize：localStorage 里那份可能是旧版本写的、也可能被人手改过，
      // 脏值最多让壁纸不显示，不能在渲染时炸出来
      setSettings: (v) => set({ settings: v }),
      openSettings: (tab = 'general') => set({ settings: true, settingsTab: tab, drawer: false }),
      setSettingsTab: (tab) => set({ settingsTab: tab }),

      // 顺手收抽屉：手机上的侧栏是浮层，选完还盖着正文就等于白选了。
      // 桌面端抽屉本来就不可见，多带这一个字段没有任何影响。
      setCurrent: (path) => set({ current: path, drawer: false }),

      setContent: (path, text) => {
        const files = { ...get().files, [path]: text };
        set({ files, dirty: true, planStale: true });
      },

      createFile: (path) => {
        const p = path.trim().replace(/^\/+/, '');
        if (!p) return;
        const files = { ...get().files };
        if (!(p in files)) files[p] = `# ${p.replace(/\.md$/, '').split('/').pop()}\n\n`;
        set({ files, current: p, dirty: true, planStale: true, drawer: false });
      },

      removeFile: (path) => {
        const files = { ...get().files };
        delete files[path];
        set({
          files,
          current: get().current === path ? null : get().current,
          dirty: true,
          planStale: true,
        });
      },

      createNote: (dir, title) => {
        const files = { ...get().files };
        // 重名不覆盖：撞了就加 -2 / -3
        const p = dedupePath(notePath(dir, title, undefined, 'md'), (x) => x in files);
        if (!(p in files)) files[p] = noteBody(title);
        set({
          files,
          current: p,
          dirty: true,
          planStale: true,
          drawer: false,
          focusTick: get().focusTick + 1,
        });
        return p;
      },

      /*
       * 批量把「引用过但还没建」的笔记一次性建出来。
       *
       * 与一篇篇调 `createNote` 的区别有两处，都是刻意的：
       *   ① **不切 current、不抢焦点** —— 一口气建十篇，界面最后停在哪篇纯属随机，
       *      还要弹十次焦点。建完留在原地，人自己决定看哪篇。
       *   ② `dirty` / `planStale` 照旧要置 —— 这些新文件是要同步上去的，
       *      不说"有本地改动"的话状态栏会撒谎。
       */
      createNotes: (items) => {
        const files = { ...get().files };
        const made: string[] = [];
        for (const it of items) {
          const title = it.title.trim();
          if (!title) continue;
          // 重名不覆盖，且这批里前面建过的也算已存在（同一目标不会建出两篇）
          const p = dedupePath(notePath(it.dir, title), (x) => x in files);
          if (p in files) continue;
          files[p] = noteBody(title);
          made.push(p);
        }
        if (made.length === 0) return [];
        set({ files, dirty: true, planStale: true });
        return made;
      },

      /*
       * 导入一批本机 md。
       *
       * 跟 `createNotes` 的两处不同，都是有理由的：
       *   ① **正文是文件里读来的**，不是 `noteBody(title)` 那个空壳 —— 这是"导入"
       *      和"新建"唯一的真正区别，其余（去重、落点、不覆盖）完全同规；
       *   ② **导入完切到第一篇**：这是一次用户主动发起的动作，他接着要的就是
       *      看这篇（或改它）。批量建链接那种被动场景才该留在原地。
       * 但**不抢焦点**（不动 focusTick）：一次进来十几篇，光标跳进正文反而碍事。
       */
      importMarkdown: (items) => {
        const files = { ...get().files };
        const made: string[] = [];
        const renamed: string[] = [];
        for (const it of items) {
          // 后缀在这儿剥：文件选择器给的是「随手.md」，落库要的是「随手」
          const raw = importBase(it.dir, stripExt(it.name));
          // 这一批里前面建过的也算已存在 —— 同一批里两个同名文件不会互相覆盖
          const p = dedupePath(raw, (x) => x in files);
          files[p] = it.text;
          made.push(p);
          if (p !== raw) renamed.push(p);
        }
        if (made.length === 0) return { made, renamed };
        set({
          files,
          current: made[0],
          dirty: true,
          planStale: true,
          // 手机上左栏是抽屉，不收起来的话新导入的这篇被自己的列表挡着
          drawer: false,
        });
        return { made, renamed };
      },

      // 目录不是"一个空壳"：要建就在里面放一个隐藏的标识文件（理由见 lib/folders.ts）。
      // 目录已经存在时它不会覆盖原文件 —— 重复建不该把别人改过的说明冲掉。
      createFolder: (dir) => {
        const r = makeFolder(get().files, dir);
        if (!r) return null;
        set({ files: r.files, dirty: true, planStale: true, drawer: false });
        return r.dir;
      },

      putAttachment: (dir, name, base64) => {
        const files = { ...get().files };
        const clean = name.trim().replace(/^\/+/, '');
        const d = dir.trim().replace(/^\/+|\/+$/g, '');
        const rel = d ? `${d}/${clean}` : clean;
        const p = dedupePath(rel, (x) => x in files);
        files[p] = base64;
        set({ files, current: p, dirty: true, planStale: true, drawer: false });
        return p;
      },

      removeFolder: (dir) => {
        const r = dropDir(get().files, dir);
        if (r.removed.length === 0) return;
        const gone = new Set(r.removed);
        const cur = get().current;
        set({
          files: r.files,
          // 当前打开的那篇被一起删了就回到空态，别停在"打不开的文件"上
          current: cur && gone.has(cur) ? null : cur,
          dirty: true,
          planStale: true,
        });
      },

      /*
       * 改名。改动面比看起来大：除了路径本身，还要动
       *   ① 全库指向它的双链（不然链接成片断掉，右栏反链也没了）
       *   ② 它自己正文第一行的标题
       *   ③ 界面里那个"当前打开的是哪篇"（新路径）
       * 失败（重名 / 空名 / 名字带斜杠）时不写任何状态，原样把错误交回界面显示。
       */
      renameEntry: (path, newName) => {
        const s = get();
        const r = renamePath(s.files, path, newName);
        if (!r.ok) return r;
        const { files, links, retitled } = rewriteRefs(r, path, s.files);
        set({
          files,
          current: remapCurrent(s.current, r.moved),
          dirty: true,
          planStale: true,
        });
        return { ok: true, to: r.to, moved: r.moved, links, retitled };
      },

      /*
       * 搬家。名字没变，所以**裸名**链接（`[[随手]]`）照旧指向它 ——
       * 但写成全路径的那些（`[[notes/随手]]`）会因为换目录而悬空，得跟着改。
       * 所以这里同样走 rewriteRefs（改写表里裸名那档新旧相同，会被跳掉，不会虚报数字）。
       * 拖整棵目录时也一样：子树里每一篇的全路径写法都要跟着搬。
       */
      moveEntry: (path, destDir) => {
        const s = get();
        const r = movePath(s.files, path, destDir);
        if (!r.ok) return r;
        const { files, links, retitled } = rewriteRefs(r, path, s.files);
        set({
          files,
          current: remapCurrent(s.current, r.moved),
          dirty: true,
          planStale: true,
        });
        return { ok: true, to: r.to, moved: r.moved, links, retitled };
      },

      refreshPlan: async () => {
        /*
         * ⚠️ 仓库没读完不许比对。
         * 笔记的真身是磁盘上那一堆 .md（异步读进来的），没读完时 `files` 是空的 ——
         * 拿空表去比对的结论是「远端那几十篇本地全删了」，界面会问要不要删，
         * 手快一点就把远端清空了。宁可这一步什么都不做。
         */
        if (!get().repoReady) return;
        const seq = ++opSeq;
        const { remote, files, snapshot } = get();
        set({ busy: 'plan', error: null });
        try {
          const plan = await planSync(remote(), files, snapshot, get().scope);
          if (seq !== opSeq) return;
          set({ changes: plan.changes, remoteFiles: plan.remote, busy: null, planStale: false });
        } catch (e) {
          if (seq !== opSeq) return;
          set({ busy: null, error: (e as Error).message });
        }
      },

      doPush: async (allowDelete = false) => {
        // 同上：仓库还没读进来时的"推送"是**删远端**，不是推送
        if (!get().repoReady) {
          set({ error: '仓库还没打开 —— 等它读完再推送' });
          return;
        }
        const seq = ++opSeq;
        const { remote, files, snapshot, scope } = get();
        set({ busy: 'sync', error: null, log: [], pendingDeletes: null });
        try {
          const res = await pushOnce(remote(), files, snapshot, scope, { allowDelete });
          if (seq !== opSeq) return;
          const blocked = new Set(res.pendingDeletes);
          const conflicted = new Set(res.conflicts);
          set({
            files: res.files,
            snapshot: res.snapshot,
            remoteFiles: res.remote,
            // 这轮推完的就消掉，只留等确认的删除和待选边的冲突 ——
            // 否则界面会一边显示「没有要推送的」一边问你要不要删文件，自相矛盾
            changes: get().changes.filter((c) => blocked.has(c.path) || conflicted.has(c.path)),
            log: res.log,
            busy: null,
            dirty: blocked.size > 0 || conflicted.size > 0,
            lastSyncAt: new Date().toLocaleTimeString('zh-CN'),
            pendingDeletes: blocked.size ? res.pendingDeletes : null,
            planStale: false,
          });
          const cur = get().current;
          if (cur && !(cur in res.files)) set({ current: Object.keys(res.files)[0] ?? null });
        } catch (e) {
          if (seq !== opSeq) return;
          set({ busy: null, error: (e as Error).message });
        }
      },

      doPull: async (paths) => {
        if (!get().repoReady) {
          set({ error: '仓库还没打开 —— 等它读完再拉取' });
          return;
        }
        if (paths.length === 0) return;
        const seq = ++opSeq;
        const { remote, files, snapshot, scope } = get();
        set({ busy: 'sync', error: null, log: [] });
        try {
          const res = await pullOnce(remote(), files, snapshot, paths, scope);
          if (seq !== opSeq) return;
          const conflicted = new Set(res.conflicts);
          set({
            files: res.files,
            snapshot: res.snapshot,
            remoteFiles: res.remote,
            changes: get().changes.filter((c) => conflicted.has(c.path)),
            log: res.log,
            busy: null,
            dirty: conflicted.size > 0,
            lastSyncAt: new Date().toLocaleTimeString('zh-CN'),
            planStale: false,
          });
        } catch (e) {
          if (seq !== opSeq) return;
          set({ busy: null, error: (e as Error).message });
        }
      },

      setScope: (next) => {
        /*
         * 改范围要**立刻重新比对**：清单里现在列着的可能是范围外的文件，
         * 不刷新的话用户会以为"我改了范围，怎么那篇还在待推送里"。
         * 落盘由 persist 负责（scope 在 partialize 里）。
         */
        set({ scope: normalizeScope(next), planStale: true });
      },

      setRemotePane: (v) => set({ remotePane: v }),

      openConflict: async (path) => {
        const { remote } = get();
        set({ conflictOf: path, conflictRemote: null, conflictBusy: true, error: null });
        try {
          // 附件没有"逐行"这回事，取回来也只是为了能原样覆盖 —— 面板里会说明
          const text = isBinaryPath(path)
            ? bytesToBase64(await remote().readBytes(path))
            : await remote().read(path);
          set({ conflictRemote: text, conflictBusy: false });
        } catch (e) {
          set({ conflictBusy: false, error: (e as Error).message });
        }
      },

      closeConflict: () => set({ conflictOf: null, conflictRemote: null, conflictBusy: false }),

      resolve: async (path, side) => {
        const seq = ++opSeq;
        const { remote, files, scope } = get();
        set({ conflictBusy: true, error: null, log: [] });
        try {
          const res = await resolveConflict(remote(), files, path, side, scope);
          if (seq !== opSeq) return;
          set({
            files: res.files,
            snapshot: res.snapshot,
            remoteFiles: res.remote,
            // 这篇已经处理完，从清单里摘掉
            changes: get().changes.filter((c) => c.path !== path),
            log: res.log,
            conflictOf: null,
            conflictRemote: null,
            conflictBusy: false,
            lastSyncAt: new Date().toLocaleTimeString('zh-CN'),
            planStale: false,
          });
        } catch (e) {
          if (seq !== opSeq) return;
          set({ conflictBusy: false, error: (e as Error).message });
        }
      },

      setAutoPush: (on, min) =>
        set((s) => ({
          autoPush: on,
          autoPushMin: min ? Math.min(240, Math.max(5, Math.round(min))) : s.autoPushMin,
        })),

      cancelDeletes: () => set({ pendingDeletes: null }),

      openWiki: (target, heading = '') => {
        const s = get();
        const name = target.trim();
        if (!name) return null;
        const paths = Object.keys(s.files);
        const dir = dirOf(s.current ?? '');
        const hit = resolveWiki(name, paths, dir);
        const jump = { pendingHeading: heading || null, jumpTick: s.jumpTick + 1 };
        if (hit) {
          set({ current: hit, drawer: false, ...jump });
          return { path: hit, created: false };
        }
        // 没有这篇就建 —— 链接指向的笔记理应存在。落在当前目录，没有就 thoughts
        const p = get().createNote(dir || 'thoughts', name);
        set({ pendingHeading: null, jumpTick: s.jumpTick + 1 });
        return { path: p, created: true };
      },

  setTagFilter: (tag) => set({ tagFilter: tag }),
  setRightOpen: (v) => set({ rightOpen: v }),
  setLeftOpen: (v) => set({ leftOpen: v }),
  setPickedDir: (dir) => set({ pickedDir: dir }),
  setEditorFont: (px) => set({ editorFont: Math.min(24, Math.max(12, Math.round(px * 2) / 2)) }),
  setSidebar: (side, px) =>
    set(
      side === 'L'
        ? { sidebarL: Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px))) }
        : { sidebarR: Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px))) },
    ),
  setPendingHeading: (h) => set({ pendingHeading: h, jumpTick: get().jumpTick + 1 }),

      /*
       * ── 书架 ──
       * 书不进 `files`、不参与同步（见 bookdb.ts 头上的说明）。这里只管
       * 「有哪些书」和「现在在读哪本」，字节的读写都在 bookdb 那一层。
       */

      /** 启动时把书目从 IndexedDB 读进来。失败要出声 —— 静默失败会表现为"书架永远是空的" */
      loadBooks: async () => {
        try {
          set({ books: await listBooks() });
        } catch (e) {
          set({ bookError: errText(e) });
        }
      },

      /**
       * 导入一本 epub。解压和解析是**同步**的（fflate 的 unzipSync），
       * 大书会占住主线程几百毫秒 —— 所以先置 busy 让界面把按钮变灰，不然看着像卡死了。
       */
      importBook: async (file) => {
        set({ bookBusy: true, bookError: null });
        try {
          /*
           * 解析那一摊（含 8KB 的 fflate）**按需拉**：不看书的人不该为它付流量。
           * 跟编辑器的取舍是同一条 —— 首屏只要列表和抬头。
           */
          const { readEpub } = await import('./epub');
          const buf = await file.arrayBuffer();
          const parsed = readEpub(new Uint8Array(buf));
          if (!parsed) {
            set({
              bookBusy: false,
              bookError: `《${file.name}》读不出来 —— 它可能不是 epub，或者已经损坏`,
            });
            return;
          }
          const meta: BookMeta = {
            id: newBookId(),
            title: parsed.title,
            author: parsed.author,
            size: buf.byteLength,
            addedAt: new Date().toISOString(),
            toc: parsed.toc,
            spine: parsed.spine,
            cover: parsed.cover,
            coverUrl: coverUrlOf(parsed),
            opfDir: parsed.opfDir,
          };
          await putBook(meta, buf);
          // 导进来直接带到书架上：这一步什么都不做的话，人会怀疑"到底有没有导进去"
          set({ books: await listBooks(), bookBusy: false, side: 'read' });
        } catch (e) {
          set({ bookBusy: false, bookError: `导入失败：${errText(e)}` });
        }
      },

      /** 删书。正在读的那本被删了要把阅读器一起关掉，否则阅读器会停在一个空 id 上 */
      dropBook: async (id) => {
        await removeBook(id);
        const s = get();
        set({
          books: await listBooks(),
          currentBook: s.currentBook === id ? null : s.currentBook,
          lastBookId: s.lastBookId === id ? null : s.lastBookId,
          bookNotes: s.currentBook === id ? [] : s.bookNotes,
        });
      },

      openBook: (id) => set({ currentBook: id, side: 'read', lastBookId: id, drawer: false }),
      /** 不读了回书架 —— 留在阅读这一边，只是手上没书了 */
      closeBook: () => set({ currentBook: null, bookNotes: [] }),
      setSide: (v) => set({ side: v, drawer: false }),
      setBookError: (e) => set({ bookError: e }),
      jumpBook: (href, at = null) =>
        set((s) => ({ bookJump: { href, at, tick: (s.bookJump?.tick ?? 0) + 1 } })),
      setBookChapter: (href) => set({ bookChapter: href }),

      loadReaderPrefs: async () => {
        try {
          set({ readerPrefs: await getPrefs() });
        } catch {
          // 读不出来就用默认值撑住：**排版读失败不该连书都读不了**，
          // 它只是"按出厂的样子看"而已，没到要报错的程度。
        }
      },

      /*
       * 改排版。顺序是刻意的：**先动内存里的那份，再去写盘**。
       * 反过来写（await putPrefs 之后再 set）的话，慢盘上一按字号就得等一下才变，
       * 手指连点两下会像没反应。而写盘真失败了也最多是"下次打开回到原样"，
       * 界面当下的反应必须立刻看得见。
       */
      setReaderPrefs: async (patch) => {
        const next = clampPrefs({ ...get().readerPrefs, ...patch });
        set({ readerPrefs: next });
        try {
          await putPrefs(next);
        } catch (e) {
          // 但要出声：安静失败的表现是"调了半天，一刷新全回去了"
          set({ bookError: `排版没记住：${errText(e)}` });
        }
      },

      loadBookNotes: async (bookId) => {
        const all = await listNotes(bookId);
        const spine = get().books.find((b) => b.id === bookId)?.spine ?? [];
        set({ bookNotes: sortNotes(all, spine) });
      },

      addBookNote: async (n) => {
        const s = get();
        const made: BookNote = { ...n, id: newNoteId(), at: new Date().toISOString() };
        await putNote(made);
        const spine = s.books.find((b) => b.id === n.bookId)?.spine ?? [];
        set({ bookNotes: sortNotes([...s.bookNotes, made], spine) });
      },

      editBookNote: async (id, text) => {
        const hit = get().bookNotes.find((n) => n.id === id);
        if (!hit) return;
        const next = { ...hit, text };
        await putNote(next);
        set((s) => ({ bookNotes: s.bookNotes.map((n) => (n.id === id ? next : n)) }));
      },

      dropBookNote: async (id) => {
        await dropNote(id);
        set((s) => ({ bookNotes: s.bookNotes.filter((n) => n.id !== id) }));
      },

      jumpNote: (id) => set((s) => ({ noteJump: { id, tick: (s.noteJump?.tick ?? 0) + 1 } })),
    }),
    {
      name: 'suisui.demo.v1',
      /*
       * ⚠️ `files` **故意不在这儿**：仓库才是笔记的家，localStorage 里再存一份就是
       * 第二个真相，两边不一致时没人知道该信谁（见 adoptRepo 里那段迁移 ——
       * 老版本那份会被搬进仓库，之后这里就再也不写了）。
       * `snapshot` 留下：它是**远端的**指纹账本，不是笔记内容，跟着这台机器走就够了。
       */
      partialize: (s) => ({
        token: s.token,
        repo: s.repo,
        snapshot: s.snapshot,
        current: s.current,
        lastSyncAt: s.lastSyncAt,
        showAll: s.showAll,
        scope: s.scope,
        autoPush: s.autoPush,
        autoPushMin: s.autoPushMin,
        provider: s.provider,
        dav: s.dav,
        od: s.od,
        side: s.side,
        lastBookId: s.lastBookId,
        editorFont: s.editorFont,
        sidebarL: s.sidebarL,
        sidebarR: s.sidebarR,
      }),
    },
  ),
);

/* ═══════════════════ 仓库与内存之间的那座桥 ═══════════════════ */

/** 当前打开的仓库。null = 还没选好（界面该出引导页） */
let repoHandle: Repo | null = null;

/** 上次**已经落到仓库里**的那份文件表。每次存完跟 `files` 比一次，只写差异 */
let lastFiles: FileMap = {};

/** 存盘的闸门。所有写操作排队过它 —— 并发写同一个文件会互相覆盖 */
let saving: Promise<void> = Promise.resolve();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/*
 * 落盘延迟。打字时每敲一下都会改 `files`，一次键击写一次盘是浪费；
 * 但也不能太长 —— 用户合上电脑可不会等你。400ms 是"手感上够快、又不会刷盘"。
 */
const SAVE_DEBOUNCE = 400;

/** 单个文件的上限。仓库里躺着一个 200MB 的 zip 时不该把它读进内存 */
const FILE_LIMIT = 8 * 1024 * 1024;

/** 把仓库里的东西读成一张 FileMap。读不出来的那篇**跳过**（一个坏文件不该让整个库打不开） */
async function loadFromRepo(repo: Repo): Promise<FileMap> {
  const entries = await repo.list();
  const files: FileMap = {};
  await Promise.all(
    entries.map(async (e) => {
      if (e.size > FILE_LIMIT) return;
      try {
        files[e.path] = await readInto(repo, e.path);
      } catch {
        /* 跳过：读不了的就当它不在，但**不删**它 —— 磁盘上那一份还在 */
      }
    }),
  );
  return files;
}

/** 老版本把笔记存在 localStorage 里 —— 迁移时用一次 */
function legacyFiles(): FileMap {
  try {
    const raw = localStorage.getItem('suisui.demo.v1');
    if (!raw) return {};
    const st = (JSON.parse(raw) as { state?: { files?: FileMap } })?.state ?? {};
    return st.files && typeof st.files === 'object' ? st.files : {};
  } catch {
    return {};
  }
}

/** 出岔子时说一句。用 setState 直接写：这一层在 store 外面，只能从外面推 */
function noteRepoError(e: unknown): void {
  const msg = e instanceof Error ? e.message || e.name : String(e);
  useStore.setState({ repoError: msg });
}

/**
 * 把 `files` 与 `lastFiles` 的差异写回仓库。
 *
 * **只写差异**：全库重写一遍的话，改一个字也要把几百个文件重新落盘，
 * 慢盘上会卡，且白白把文件的修改时间全刷一遍（用 git 看仓库时会以为全改了）。
 */
async function flush(next: FileMap): Promise<void> {
  const repo = repoHandle;
  if (!repo) return;
  const before = lastFiles;
  const failed: string[] = [];
  const undo: string[] = [];
  const jobs: Promise<void>[] = [];

  for (const [p, v] of Object.entries(next)) {
    if (before[p] === v) continue;
    jobs.push(writeFrom(repo, p, v).catch((e) => (failed.push(p), noteRepoError(e))));
  }
  for (const p of Object.keys(before)) {
    if (p in next) continue;
    jobs.push(repo.remove(p).catch((e) => (undo.push(p), noteRepoError(e))));
  }

  lastFiles = { ...next };
  await Promise.all(jobs);

  /*
   * 记账要诚实：
   *   · 没写成的从"已存"里摘掉 —— 下次改动还会再试一次；
   *   · 没删成的放回去 —— 否则下次 diff 会以为它已经不在盘上，永远不再删。
   */
  for (const p of failed) delete lastFiles[p];
  for (const p of undo) lastFiles[p] = before[p];
}

/*
 * 订阅 `files`：改了就排一次存盘。
 *
 * 为什么不把写盘塞进每一个 action（setContent / createNote / rename…）：
 * 那样有二三十处要改，漏一处就是"这一步的改动没落盘" —— 而这种 bug 要等
 * 用户关掉程序再打开才发现。订阅是**一处覆盖全部**，新增 action 也不会漏。
 */
useStore.subscribe((s, prev) => {
  if (s.files === prev.files) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saving = saving.then(() => flush(useStore.getState().files));
  }, SAVE_DEBOUNCE);
});

/** 关窗口 / 切页面前把最后那点改动推出去（best effort，异步不一定来得及） */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saving = saving.then(() => flush(useStore.getState().files));
  });
}
