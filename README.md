# QuitWriteRead

读写**真实 md 文件**并与 GitHub 双向同步的客户端。目标形态：一份 Tauri 2 代码出 Windows exe + Android apk。
**当前阶段**：桌面端 web demo + 移动端（手机浏览器直接可用，带 PWA 外壳）。还没打包。

> 本仓库 = 程序源码。**它同步的那个仓库是另一个**（默认 `baicaibucai1/ramblings`，见下「凭据」），
> 两者别搞混。

## 跑起来

```bash
node node_modules/vite/bin/vite.js            # dev  → http://localhost:5183
node scripts/build.mjs                        # 构建（别直接 vite build，见下）
node node_modules/vite/bin/vite.js preview    # 产物 → http://localhost:5184
```

（受限终端里 `npm run dev` 不可用，直接跑 vite 的 JS 入口更稳。）

### 桌面端（Tauri）

```bash
npx tauri dev          # 桌面开发窗口
npx tauri build        # 出 exe / 安装包
```

⚠️ 本机的 rustc 是 `x86_64-pc-windows-gnu`，链接器 / ar / **dlltool** 都在
`C:\Users\Sogap\msys64\mingw64\bin`。前两个已经在 `src-tauri/.cargo/config.toml` 里写死成绝对路径，
**dlltool 却是以裸命令名调用的**（rustc 的 windows-link 生成导入库用）——
它只认 PATH。所以跑之前要先把那个目录挂上 PATH，否则报
`error calling dlltool 'dlltool.exe': program not found`：

```bash
PATH="/c/Users/Sogap/msys64/mingw64/bin:$PATH" npx tauri dev
```

⚠️ `schemars 0.8 → indexmap 1.9` 那条依赖线也有个坑：indexmap 1.9 **没有 default feature**，
有没有 std 全靠它 build.rs 现场探测，这台机器上探测失败 → `IndexMap` 少一个默认泛型参数，
schemars 编译不过（`error[E0107]`）。已在 `src-tauri/Cargo.toml` 里显式声明
`indexmap = { version = "1.9.3", features = ["std"] }` 把它顶回来（[dependencies] 和
[build-dependencies] **各一条**——两个依赖图是分开解析的，少一边都不行）。

**构建走 `scripts/build.mjs`，不要直接 `vite build`。** 它先把产物建到暂存目录、自检通过后再换掉
`dist` —— 因为本机有两个 Windows 怪脾气，直接构建会在**把上一份产物删到一半时失败**：
目录级 `rename` 被拒（EPERM），递归删 180+ 文件的目录会**永不返回**（不是报错，是卡住）。
脚本两条都绕开了，并在最后报出首屏引用了哪些文件、各 chunk 多大。

两个服务都配了 `host: true`，所以**手机连同一个 WiFi 也能打开**（用电脑的局域网 IP，端口不变）。
手机上的用法和 apk 的打包步骤见 [`ANDROID.md`](./ANDROID.md)。

> Service Worker 只在构建产物上验，所以 `:5184` 那个（preview）才带离线能力；`:5183` 是内存模块图，没有可缓存的文件。

### 在电脑上看手机效果：手机壳预览页

```
http://localhost:5184/mobile.html        # dev（:5183）上也有同一份
```

把应用塞进**真机尺寸的 iframe**。关键在：iframe 有自己的视口，所以里面的
`@media (width < 48rem)` 是按**壳的宽度**求值的 —— 渲染出来的是真手机布局，
不是把桌面版缩小（e2e 直接断言 iframe 内 `window.innerWidth === 412`）。

顶部可切机型（Pixel 7 / iPhone 15 Pro / SE / Galaxy A54 / iPad mini / 临界 767 / 临界 768 / 桌面 1280）、
旋转、缩放，另有「清缓存重载」（注销 SW + 清 Cache Storage，改完产物看的是旧的时用它）。
脚注实时报出当前视口尺寸、DPR 和**落在断点哪一侧**。

⚠️ **iframe 没有触摸模拟** —— 布局能验，真触摸手势和软键盘还得用手机。
地址栏支持 `?url=…&w=…&h=…`，可以直接指向别的地址或尺寸。

## 凭据

`.env.local`（已在 .gitignore 里，不进版本库）：

```
VITE_GH_TOKEN=...
VITE_GH_OWNER=baicaibucai1
VITE_GH_REPO=ramblings
VITE_GH_BRANCH=main
```

凭据在**设置对话框的「同步」一节**里配（设置入口在左下角 dock 的齿轮上，弹开的是
**遮罩 + 居中大卡**：左列「常规 / 同步 / 阅读 / 关于」四节导航，右边是那一节的内容；
没配凭据时齿轮顶一颗红点）。demo 存 localStorage，正式版进系统凭据库。
⚠️ 凭据按「地址 + 端口」隔离 —— 电脑上填过不代表手机上填过，换设备要重填一次。

## 已实现

- **仓库 = 本机的一个文件夹**：笔记就是磁盘上真的一堆 `.md`，程序只是这个文件夹的一个视图 ——
  可以拿别的编辑器直接改、拿网盘同步、随时换一个。第一次打开会**挡一道让人选**（这是全应用
  唯一一处"选错了要搬家"的决定）：桌面端给「程序自带的目录」并把它写明白是哪个路径，
  也可以自己挑一个；浏览器那一路走 File System Access，**Safari / Firefox 拿不到目录句柄**
  就老实说"不支持"，并退回「先存在浏览器里」（那一档不粉饰成"已保存"，设置页明说它不在磁盘上）。
  ⚠️ 五条实现上的讲究：① 仓库里**顶层那个 `books/` 目录留给书**，别拿它当笔记目录
  （这一条在三套驱动里都被当作隐藏目录滤掉，是刻意保留的名字）；
  ② **localStorage 里不再存 `files`** —— 仓库是唯一真相，
  存第二份就会出现"刷新前后不一致"这种没人能解释的现象（老版本那份会在第一次打开仓库时搬进去）；
  ③ 存盘是**订阅 `files` 的差异**（不是在每个 action 里各写一遍），新增动作不会漏，
  改一个字也只写那一个文件；
  ④ **仓库没读完不许比对** —— 那时 `files` 是空的，
  拿空表去比对的结论是"远端那一堆本地全删了"，一步同步就把远端清空了；
  ⑤ `.folder`（空目录的标识文件）**不能**按"点开头就是隐藏文件"滤掉，否则刷新后自建的空目录全没了。
  另：换仓库**不会**搬旧文件夹里的东西，新仓库里有什么、左边就列什么 —— 换之前先在旧仓库同步一次。
- **两侧边栏可以拖宽**：左栏右边缘、右栏左边缘各有一条分隔条（悬停才显形），
  按住拖就能调那一列多宽，范围 200–520px，**双击复位到出厂宽度**（272 / 250）。
  宽度跟着人走（persist），刷新后还是你拖出来的那份。
  ⚠️ 两条实现上的讲究：① 拖的时候**只改显示、松手才落盘** —— 每动一像素就写一次 persist
  会把整个 files（笔记正文）序列化上百遍，手感当场变糊；
  ② 宽度走 CSS 变量而不是内联 `width` —— 内联会压过手机抽屉那条媒体查询，
  抽屉要么撑爆屏幕要么窄成一条缝。手机上两侧没有分隔条（那一侧是浮上来的抽屉，宽度由视口定）。
- **GitHub Git Data API 直连**：api.github.com 放行 CORS，纯浏览器调用，不需要任何后端
- **三路比对**：本地 blob sha1 × 上次同步快照 × 远端 sha → 新增 / 修改 / 删除 / 冲突
- **一次同步一个 commit**：blobs → trees → commits → refs，四步走完
- **删除可推**：tree 条目 `sha: null`
- **创建笔记**：左栏顶部的 **+** 一点即建 —— **不问路径，也不打断你输标题**。
  落点 = **你点选的那个文件夹**（目录行高亮 + 左侧一条竖条），没点过就跟着当前打开的那篇走，
  再没有才落到 `thoughts`；列表底部常驻一行小字写着会落在哪。
  标题先叫「未命名」，进正文改就行。
  路径 `thoughts/2026-09-21-雨天.md` 由 `note.ts` 生成（中文原样进文件名、挡非法字符、超长按码点截断、
  重名加 `-2` 绝不覆盖）。建完自动展开目录、打开编辑器、**把光标放到正文末尾**
- **导入 md**：文件树工具条上那颗向下的箭头（或把文件拖进列表）把本机的 md 收进库里，
  可多选，认 `.md / .markdown / .mdown / .txt`。落点跟「新建笔记」同一个目录（底下那行小字写着是哪个）。
  **编码先按 utf-8 严格解，解不通就换 gb18030** —— Windows 上大量老 md 是 GBK，
  不兜底就是一篇满屏问号的笔记（这条不报错，只会静默写坏，所以 `tests/mdimport.test.mjs` 钉死了）。
  **撞名加 `-2`，绝不覆盖**：原来那篇一个字都不动。不是 md 的、或者超过 8MB 的直接跳过，
  并且**说完就报账**：「导入 2 篇，1 篇因重名改了名，1 个不是 md，跳过」。
  导入完切到第一篇，接着就能读能改。
  ⚠️ **不加日期前缀**（跟新建不一样）：导入的文件名字就是它的身份，按今天的日期改一次名
  人就对不上号了；也正因为不加日期，重复导入才会撞到同一条路径上，「-2」这条策略才成立。
- **改名 · 拖动 · 右键菜单**：文件树按文件管理器那套走 —— **右键**打开菜单（重命名 / 新建笔记 /
  新建（子）文件夹 / 复制路径 / 复制双链 / 属性 / 删除），**就地改名**（右键 → 重命名，
  或 F2、或双击那行，回车确认、Esc 取消），**拖到别的目录换位置**（拖目录连里面的一起走，
  拖到列表空白处 = 挪到根目录）。拖动时有一张跟着指针走的小纸写着"拖的是谁、会落到哪儿"，
  目标目录实时高亮：能放=墨色圈、放不下=红圈、**拖回原处不画圈**（那是空操作，不是错误）。
  ⚠️ 改名是这个应用里**唯一会动到别的文件**的本地操作，所以它连带做三件事：
  全库指向它的 `[[双链]]` 改成新名（`#小节` 和 `|显示文字` 原样留着）、它自己正文第一行的标题
  跟着改（**只在逐字等于旧名时才动**，你自起的小标题不碰）、编辑器里打开的还是同一篇。
  重名和"拖进自己里面"**当场拦下并说清原因**，不静默失败、也不自动加 `-2`
- **书籍（本地书架，看 epub）**：左栏顶上那条**「书写 / 阅读」分段控件**切到阅读进书架，
  点「导入 epub」或把书拖进来就行。
  读某本时**右栏换成这本书的「目录」+「笔记」**：目录点哪章跳哪章、当前章高亮；
  笔记就是**批注** —— 在正文里划一段字浮出工具条，可以只划重点（标一道底色），
  也可以写想法（留下一句话，跟划的那句绑在一起）；右栏按正文顺序列出全书批注，
  点一条滚回那一句并把那段点亮两秒，就地能改能删。
  **左栏不跟着让位**：读书时它仍然是书架，正在读那本写着「正在读」，可以直接翻下一本。
   正文连续滚动，另有**书内搜索**（列出命中章节 + 上下文，点一下跳过去并高亮）、
   **排版四项**（字体 黑体/宋体/楷体/等宽 · 字号 13~28 · 行距 1.4~2.4 · 纸色 纯白/米黄/夜间/豆绿/淡青）、
   以及**记住读到哪**（书架上直接标「读到 46%」）。
   排版有两个入口：抬头那个「Aa」面板（读的时候随手调）和设置对话框的「阅读」一节
   （一次调齐，带一块跟正文走同一套 CSS 的实时预览）—— **两处读写同一份偏好**
   （`ReaderPrefs`，存 IndexedDB 的 prefs 表，经 `clampPrefs` 归一），改哪儿都算数。
   字体四档全是**系统字体栈**（打包一个中文字体要十几 MB，不值当），纸色每档自带
   墨色 / 链接线色（`--book-*` 一组变量，`data-book-theme` / `data-book-font` 两个属性换档）。
  抬头那个「←」是**合上这本书**（回到书架上什么都没打开的状态），
  因为目录搬走之后，"不读了"这个动作没有一个自然的位置。
  切换是**两边各记各的**：`side`（在哪一边）持久化 —— 刷新后还在上回待的那边；
  `lastBookId`（上次读的那本）也持久化 —— 书架顶上有一张「继续读《X》· 读到 32%」的卡，
  点一下接着读。但**不会自作主张把书翻开**：重开一律先回书架，哪本在读交给那张卡说。
  两边来回切时「在读哪本」不丢 —— 切去写笔记再切回来，还是刚才那一页。
  ⚠️ 书**不进 `files`、不参与同步**：存在 IndexedDB 里（一本书几 MB，localStorage 装不下），
  所以它们不会出现在待同步里，也不会被推到远端 —— 这是刻意的。
  解析自己写（`lib/epub.ts`，解压用 8KB 的 fflate，容器 / OPF / nav / ncx 全用正则，
  跟 `davxml.ts` 一个路子，Node 里能单测）；**书里的脚本 / 样式 / 外链 / `on*` 事件一律剥掉**，
  图片换成 blob URL。⚠️ **不用书自带的 CSS** —— 那些样式常写死字号和颜色，照搬的话
  字号调节和夜间模式就都失效了，所以只保留结构，排版归我们（见坑 18）
- **推送不是同步（2026-09-27 改的）**：**推什么是你定的，拉什么也是你挑的**。
  以前一轮同步里既拉又推、走全量；现在拆成两件事：
  · **推送** = 把**推送范围**里的本地改动推上去（可定时），自动动作只有这一个；
  · **拉取** = 打开「远端文件」面板（dock 上「拉取」那颗），勾哪几篇拉哪几篇。
  ⚠️ 远端有更新**不会自动拉**，只在清单抬头上报个数 —— 拉是人对远端的选择，不能替他做。
- **推送范围**（`lib/scope.ts`）：设置 → 推送里配规则，`thoughts/`（目录）、`*.md`（后缀）、
  `notes/a.md`（单篇）、`**`（全推）；另有「但不推这些」的单篇排除（优先级更高）。
  ⚠️ **范围外的文件同步这一层完全看不见**：不比对、不进清单、不写快照，
  因此**绝不会**因为"没勾它"而被当成删除推上去 —— 这是整套设计里最容易误会的地方。
  范围配空了清单会自己说明「推送范围是空的」，不会假装"已经推干净了"。
- **定时推送**：设置里开关 + 间隔（5/15/30/60/120 分钟），**只在应用开着时跑**
  （关了窗口就是普通网页，没有后台；真要常驻得进 Tauri 起定时器 + 托盘）。
  到点先比对再推，没有要推的就不打远端；设置面板开着时不动手。
- **两边都改过 → 选边，不做自动合并**（`lib/diff.ts` + `ConflictPane`）：
  点清单里那条冲突打开面板，git 那种 unified 视图（+ 是云端有、− 是本机有，没动的长段折叠），
  三个按钮「用本机这版 / 用云端那版 / 两版都留」。
  ⚠️ 为什么不合：markdown 没有可靠的合并单位，按行合会把「删了第 3 段」和「在第 3 段后加了一句」
  合成一坨，而**猜错一次就是丢字**。以前是"远端版本另存副本"自动处理，那是替用户做决定。
- **删远端要点确认**：见下面「坑 4」——删除是不可逆的，默认只推不删
- **不假装推送好了**：本地一改，抬头立刻切成「还没比对」。
  原先它会继续显示上一次比对的结果 —— 刚建完笔记却写着「一致」，是误导
- **「待推送」只给结论，不给清单**：抬头那行写着「↑ 3 待推送 / ↓ 1 远端更新 / ⚠ 冲突」和总项数，
  **具体是哪几个文件默认收着，点抬头那一行才展开**（再点收回）。改动一多那片清单会把文件树
  挤掉半屏，而多数时候人只想知道"该不该推"。
  ⚠️ 收起的是**清单**，不是状态：抬头那三个计数、以及「没有要推的 / 还没比对」那两条提示
  照旧显示 —— 那两条回答的是"现在要不要推"，跟着收起来就等于把状态藏了。
  ⚠️ dock 上两颗角标**各数各的**：推送数 push-*、拉取数 pull-*，冲突两边都不算
  （它不是"待会儿自动做的事"）—— 合成一个数字就是撒谎
- **左侧只列文字文件**：`.gitignore`、`update.bat`、`scripts/*`、根目录 README 这类程序文件默认不展示，
  搜索框下面那行小字右半的「隐藏 N」小钮可切换「显示全部」。
  ⚠️ 这个「隐藏」**仍然是展示层的事**，跟推送范围是两码事：
  左边看不见的文件，只要在推送范围里，照样比对、照样推（清单里会写「另有 N 项程序文件变更」）
- **格式工具栏**（常驻一行，14 个）：正文 / H1 / H2 / H3 ｜ 加粗 / 斜体 / 删除线 / 行内代码 / 链接 ｜
  无序列表 / 有序列表 / 引用 / 代码块 / 分割线。**按钮跟着光标实时高亮**（H2 里光标一落，H2 就亮）。
  两种模式共用一套按钮，但实现不同：所见即所得调 Milkdown 命令，源码模式走 `mdkit.ts` 的字符串改写
  （这样源码框里的操作也完全可单测）。再点一次相同的块级工具会**取消**（列表/引用走 `lift`，标题走 `paragraph`）
- **所见即所得编辑**（Milkdown / Crepe）＋ 源码模式切换
- **文本纪律**：统一 LF + 无 BOM，否则每次保存 sha 都变，同步永远"脏"
- **格式只有一种：markdown。** 只有一套编辑器和一套工具栏 —— 第二种格式（自带 CSS 的那种）
  换来的是一半精力在维护没人写的东西，2026-09-26 整块删掉了。
  现在 `createNote` 只有 `.md` 一条路，文件树里除 md 以外的条目都是附件（图片 / PDF）。
- **编辑器按需加载**：编辑器带着 Milkdown / Crepe / KaTeX，压缩后 **1.1MB**，而首屏真正需要的
  只有顶栏和文件列表。所以 `App.tsx` 里 `lazy(() => import('./components/EditorPane'))`，
  没选文件时渲染轻量的空态（`components/EmptyState.tsx`，**不能把它写回 EditorPane**）。
  首屏 JS 从 **1.72MB 降到 260KB**。加载中给路径栏 + 三条骨架（手机上那 1.1MB 是能感觉到的，
  不给骨架就像"点了没反应"）。`tests/lazy-e2e.mjs` 拿断言钉住这件事 —— 改回静态 import 功能全对，
  只有包体悄悄涨回去，不测根本看不出来
- **移动端（< 48rem）**：侧栏收进抽屉（左上角 ☰ 拉开，**选完文件自动收起**，点空白或按 Esc 关掉）；
  两个工具栏**横向滚动而不是换行**（换行会把正文挤下去）；触摸目标放大到 36px；
  弹层改成贴边（桌面上居中的浮层在手机上会有一半在屏外）；`100dvh` + `interactive-widget=resizes-content`
  让软键盘压缩视口而不是盖住光标；底部加安全区内边距。**桌面端一行都没改** —— 布局级规则集中在
  `styles.css` 的一个 `@media (width < 48rem)` 块里，其余是就地 `max-md:` 变体
- **附件（图片 / PDF）**：图片直接看图，PDF 用 **pdf.js 画在 canvas 上**（不是 iframe ——
  Tauri 的 WebView2 不带内置 PDF 查看器，嵌 iframe 在桌面端是白屏）。
  正文里写 `![[图.png]]` 就把图嵌进正文（存进文件的还是那几个字），`![](./图.png)`
  这种标准写法也能显示。左侧「添加附件」选本地文件即可，单个上限 8MB。
  同步时附件走 **base64 + 字节指纹**（见下面「附件的三条规矩」）
- **PWA 外壳**：`manifest.webmanifest` + 四种尺寸图标 + 手写 Service Worker。
  导航请求 network-first（**用 cache-first 的话发新版后永远升不了级**），静态资源 stale-while-revalidate，
  `api.github.com` 一律放行到网络（缓存住实时数据等于把用户锁在旧快照上）。
  实测断网后照样打开、本地笔记还在

## 双链与标签

正文里写 `[[笔记名]]` 就是一条链接，`#标签` 就是一个标签。**落盘的还是这几个字**
（markdown 里 `[[ ]]` 没有任何语法含义），所以别的软件打开照样读得懂，同步到 GitHub 也不脏。

| 写法 | 意思 |
|---|---|
| `[[开张]]` | 链到「开张」那篇 |
| `[[开张#第二段]]` | 链到那篇的「第二段」小节，跳过去并滚到那儿闪一下 |
| `[[开张|去看]]` | 显示成「去看」，仍指向开张（`|` 只影响显示，不影响指向） |
| `![[图.png]]` | 把这张图**嵌进正文**里显示（PDF 则是一张能点的卡片） |
| `#灵感` / `#读书/笔记` | 标签，可点（侧栏只留带它的篇） |

- **怎么点**：桌面是 **Ctrl / ⌘ + 单击**（单击是"把光标放进去改字"，这是编辑器不是阅读器）；
  手机上没有修饰键，退化成单击就跳。
- **指到了没有一眼看得出来**：有那篇是实线，没有是**虚线 + 灰字**。点虚线的会当场把那篇建出来
  （建在引用它的那篇所在目录），建完链接自动变实线。
- **打 `[[` 弹补全**（↑↓ 选、回车确认、Esc 收起），最后一项永远是「创建《你打的字》」。
- **反向链接面板**：正文下面那条，显示这篇的标签、**谁引用了这篇**（带那一句的上下文，可点回去）、
  以及这篇指向但还没建的篇。三样都空时整块不渲染 —— 一个空面板占着正文的位置是浪费。
- **标签筛选**：点 `#标签`，侧栏顶部出现 `#标签 × N 篇`，列表切成**一列平铺的篇**
  （同一个标签下的几篇往往散在不同目录，套回树里反而找不到）。再点一次或按 × 退出。
- **名字解析放宽四档**：全路径 → 路径去后缀 → 文件名 → **标题**（文件名是 `2026-09-21-开张`，
  但人写链接只会写 `[[开张]]`）。同名多篇时优先**同目录**的那篇。

⚠️ **保存前必须把 `[[` 的转义吃回去**（`lib/links.ts` 的 `unescapeWiki`）：
markdown 序列化器会把 `[[` 写成 `\[\[`，不还原的话磁盘上那串字就不再是链接了 ——
反向链接会整片失效，别的软件打开只看到一串反斜杠。这是踩过的，不是理论风险。

源码模式（textarea）里没有高亮也没有补全 —— 它是纯文本框，没法给一段字套 span。
反链面板不受影响，两种模式都在。

### 附件的三条规矩（`lib/binary.ts`）

附件的**内容也是存在 `files` 里的**，只不过存的是 base64（没有 `data:` 前缀、没有换行）。
判断"这条是文字还是附件"只看路径后缀，所以 `FileMap` / 快照的格式一个字段都没变。

1. **绝不过 `normalizeText`。** 它现在只动 BOM 和 CR，看着无害，但一旦以后有人往里加 trim，
   附件就悄悄坏了 —— 所以同步链路对附件压根不调它（按路径分派）。
2. **指纹按解码后的字节算。** 远端（GitHub）算的是文件字节的 blob sha；
   要是按 base64 字符串算，两边永远不等，每次同步都判成"本地改了"，附件会被无限来回推。
3. **必须按字节读，不能走 `res.text()`。** 浏览器拿 UTF-8 解二进制，解不出的字节变成
   U+FFFD —— 那不是"有点脏"，是文件彻底毁了，而且不可逆（推上去会把远端那份也覆盖成坏的）。
   所以 `Remote` 接口专门有 `readBytes()`，`RemoteChange` 有 `encoding: 'base64'`。

附件名字的解析（**`resolveFile`，不是 `resolveWiki`**）：笔记那套会先把后缀剥掉
（`[[开张]]` 要能指到 `2026-09-21-开张.md`），而附件恰恰是**带着后缀**被引用的
（`![[dot.png]]`），两套规矩不能混。

## 同步后端：GitHub / 坚果云 / OneDrive

比对引擎（`lib/sync.ts`）**只认一个接口** `Remote`（`lib/providers/types.ts`）：

```ts
list(): Promise<{ path, sha }[]>      // 列全部文件
read(path): Promise<string>           // 读原文
write(changes, message): Promise<void>// 落一批改动（content = null 是删除）
```

三家的差别只在实现里：

| 后端 | 协议 | 状态 |
| --- | --- | --- |
| GitHub | Git Data API（一个仓库当库，一次同步一个 commit） | 可用（一直是它） |
| 坚果云 | WebDAV（`dav.jianguoyun.com/dav/`） | **要在桌面端跑** —— 见下 |
| OneDrive | Microsoft Graph | 读写就位，**授权待接入**（要 Azure 应用的 client_id） |

两条绕不开的限制，都是查证过的，不是猜想：

- **坚果云的 WebDAV 不返回 CORS 头**，浏览器的 PROPFIND 预检连鉴权都过不去，官方对此的答复是
  "我们实现的是标准 WebDAV 服务端协议"（即不打算支持）。所以这条路的请求**走注入的 transport**：
  桌面端（Tauri）在 Rust 侧发（`src-tauri/src/main.rs` 的 `dav_request`），没有同源策略这一说。
  网页版没有 transport，界面上照实标「要用桌面端」。
- **OneDrive 的 Graph 放 CORS**，浏览器直连没问题，缺的是授权：OAuth 需要一个 Azure 应用的
  client_id 走 PKCE 换 token，注册应用得账号主人去做。所以 `onedrive.ts` 只接 token，
  留空就是「待接入」，界面上 disabled + 标出来（不放假按钮）。

### 一个不那么显然的取舍：`list()` 的 sha 必须是**内容指纹**

三路比对（`decide.ts`）比的是「本地 sha × 上次快照 × 远端 sha」，三个值必须**同一种算法**，
同步完两边内容相同 → 指纹相同，才能用一个值代表"基线"。

GitHub 的 blob sha 正好就是 git 的 blob 哈希，本地算得出来。网盘没有这个：WebDAV 给 ETag、
OneDrive 给 quickXorHash，算法跟本地不同 —— 直接拿来当基线，"本地没动"会被判成"本地改了"
（两边永远不相等）。所以**非 Git 后端在 `list()` 时把内容取回来现算指纹**，内容顺手缓存住给
`read()` 用。代价是列目录要下载全部内容；换来的好处是判定表、快照格式、冲突处理一家都不用改。

## 文件夹

文件夹**不是"一个空壳"**：git 里空目录根本不存在，而网盘里空目录又确实存在 —— 同一个工作副本
要在几种后端之间换来换去，行为必须一致。所以统一成：目录里放一个隐藏的标识文件 `.folder`
（和 Obsidian 在每个库里放 `.obsidian` 是同一个思路）。它点开头，左侧列表本来就隐藏这类路径段，
用户看不见它，而它在任何后端上都是一个真实的文件 —— 目录因此"真的存在"了。

规则都在 `lib/folders.ts`：目录名清洗（`..` 不许跳出库、Windows 非法字符、每段截断 60 字）、
建/删目录、嵌套建树。文件树是真正的多级树（原来只有一层分组），空目录也显示，
点一下目录行就能把它设成新笔记的落点 —— 自己建的目录也照样能落。

**改名和搬家也在同一个文件里**（`renameEntry` / `moveEntry`），因为两者底下是同一件事：
**把一个路径前缀换成另一个**（`remap`）。所以目录改名时整棵子树跟着换前缀、标识文件名始终是
`.folder`（它是协议的一部分，不能被当成普通文件名一起换）；拖动搬家则是"父路径换了、名字没动"。
⚠️ `moveEntry` 里那条"不许挪进自己里面"不是洁癖：把目录挂到它自己的后代下，
前缀替换会当场把整棵子树绕成一个环。拖动的手感（6px 阈值、只认鼠标和笔、
手指在 Android 上会把长按让给系统菜单）在 `components/FileTree.tsx` 里。

## AI 助手

顶栏那颗星打开它。**笔记能读能写，书架上的书能读** —— 一共九个工具，设置里那一张清单
就是从代码里那份名字表来的，界面上说它能干什么，它就是真能干那些。

| | 工具 | 干什么 |
| --- | --- | --- |
| 笔记 | `list_notes` / `read_note` / `search_notes` | 列出、读一篇、全文搜一段 |
| 笔记 | `write_note` / `append_note` | **写**：整篇改写 / 末尾追加（**都要先问一句**） |
| 书 | `list_books` / `read_book` / `search_book` / `list_book_notes` | 列书架、读某一章、书内搜、读你的批注 |

**书的那一半是另一处数据源**：笔记是磁盘上真的一堆 `.md`（走 `Repo`），书是 IndexedDB 里的
zip 字节（走 `bookdb`）—— 当初就是刻意分开的，一本书 2~20MB 进笔记那条链路只会把每次同步拖死。
所以读一本书要**解压一遍**（`readEpub` → `chapterText`），结果按"最近用"缓存三本。

### 为什么要 vendored 一个内核，而不是自己写个循环

自己写一个 `while (模型还没说 stop) { 调工具; 拼回去 }` 看着是两百行的事，真正的开销在后面：
并行工具调用、参数校验、权限、上下文压缩、预算（步数 / token / 墙钟三重）、流式断在半句上要重发、
子代理。这些**每一条都是踩过才知道的**，而且它们互相咬着（压缩会动 transcript，权限要跟着工具走）。
内核把这些做完了，我们要写的是**工具层 + 渲染层**：

- **工具层**只有 `note-tools.ts` 一个文件，底下是早就存在的 `Repo`；
- **渲染层**只有 `ChatPane.tsx` 一个文件，抄的是 `docs/events.md` 里那份现成 reducer。

### 三条把"它不该干什么"钉死在代码里的规矩

1. **不给文件系统**：`builtinTools: false`，记忆 / 技能 / MCP 全关。
   内核那套自带 `read_file` / `write_file` 靠 `node:fs`，浏览器端**不存在**（已经连文件一起删掉了）。
   就算存在也不该给 —— 那等于把整个家目录交给模型。
2. **路径天然出不去**：工具走 `Repo`，而 `lib/repo.ts` 的硬规矩①就是
   「绝对路径不许进这个接口」。所以沙箱不用再兜一层正则。
3. **规则走 `injectedPrompts` 而不是 system prompt**：这条通道**不进 transcript**，
   压缩 / 裁剪 / 模型跑偏都动不了它 —— 是内核里唯一能保证"每一步都看见"的路子。

### 写这件事：三条规矩

1. **写走的是界面上那一份**，不是另开一条写盘的路。工具调的是 `store.setContent`，
   所以写完文件树和编辑器**立刻**跟着变。绕过它直接写磁盘 = 两条写路径，
   下一次 flush 按内存那份为准，助手写的东西会被悄悄盖回去。
2. **写之前必然弹卡**，而且卡上写清「要把 1200 字换成 900 字」—— 只报个文件名等于让人盲签。
   这不是提示词里的恳求：`write_note` / `append_note` 没标 `readOnly`，内核在 default 模式下
   走到 `PermissionEngine` 最后一句 "No rule allows …"，所以**必定**来问。
3. **关掉写权限时，写工具根本不注册** —— 不是注册了再拦。模型连"有个 `write_note`"都不知道，
   不会白花一轮去调一个必定被拒的东西。设置里那句「7 / 9 个工具」就是这么算出来的。

被拒的时候它也不许撒谎：`injectedPrompts` 里钉了一条「调用被拒就说没写成」。

### 演示模式

不连模型、不用 Key，走 `MockProvider` 的脚本 —— **三个档位，设置里选**：

- **演示：读** —— 真的去读你的仓库（列出 → 读第一篇），最后一句是写死的。工具是真的，假的只有"那句话是谁说的"。
- **演示：写** —— 往 `agent/演示-<今天>.md` 追加一段，**中途一定先问你一句**。
  这一档存在的全部理由就是让你亲眼确认「点了允许 → 文件真的变了」；点拒绝它就没动，也不许说"写好了"。
- **不演示** —— 填接口地址 / Key / 模型接真模型（OpenAI 兼容那套 `/chat/completions`，换国内几家改地址就行）。

⚠️ 浏览器直连要端点放行 CORS；不放行的得用桌面端（那边的请求可以走本地代理 —— 内核留了
`fetch` 注入口，就是为这个）。

## 还没做

- **打真正的包**：Android apk 和 Windows exe 都还没出。缺 JDK / Android SDK+NDK / MSVC 工具链，
  清单和步骤写在 [`ANDROID.md`](./ANDROID.md) 里。
  桌面端骨架（`src-tauri/`）已经搭起来，目前只提供一个 `dav_request` 命令给坚果云用
- 真实文件系统（现在工作副本在 localStorage；桌面版要落到 `C:\AI_Production\QuitWriteRead`）
- 系统凭据库（现在 token / 坚果云应用密码都在 localStorage）
- OneDrive 的 OAuth 授权（要 Azure 应用的 client_id 走 PKCE）
- 安卓端的坚果云（同样卡在 CORS，需要原生插件走 Kotlin 发 WebDAV）
- 冲突的三路自动合并（现在只留副本）
- 附件的**增量同步**：现在改一个字节也要整个文件重传（附件走的是全量 base64）
- 双链还差一件事：**源码模式下的链接高亮与补全**（textarea 做不到）
- 手机上不能用拖动换层级（手指长按要留给系统的右键菜单），目前只能改文件名和新建
- **书籍**：书的同步（现在是纯本地，见上面「已实现」那条）、书签 / 划线摘录导出成笔记、
  换正文字体、分页翻页（现在只有连续滚动）、从书里复制文字时带出处

> 双链这一摊已经补完的四件：**标签全局视图**（左栏「标签」按钮 → 全库标签按用量排序，
> 点一个进筛）、**未建链接批量建**（右栏「待建」扫全库悬空链接，多选一键建，
> 落点按"引用最多的目录"投票）、**`![[某篇]]` 嵌正文**（真把那篇渲染进来，
> 带黄铜竖线 + 抬头 + 「打开原文」；防环、深度上限、标题降级都做在 `lib/embed.ts`）、
> **改名 / 搬家不断链**。
>
> 改名联动是**保形**的：全库 `[[旧名]]` 跟着改成新名，`#小节` / `|显示文字` 都留着，
> 而且带路径的写法也是各归各位 —— `[[读书/2026/书评]]` 改完是 `[[读书/2027/书评]]`
> （不是被压成裸名 `[[]]`）。改写表按**整棵搬家子树**逐条建（见 `retargetMap` +
> `rewriteRefs`），所以改目录名、拖整棵目录走都不会漏。
> 名字没变的搬家只改全路径那档，裸名链接新旧相同会被跳掉 —— 那个"几处引用跟着改了"
> 的数字是给人看的，不能虚报。
>
> 拖到折叠的目录上**压住不动 0.6 秒会自动展开**（`HOVER_EXPAND_MS`），
> 划过不停留的不算 —— 否则一路划过去会把沿途目录全展开一遍，那不是帮忙是添乱。

## 测试

```bash
node tests/decide.test.mjs        # 三路判定 14 例（Node 24 直接跑 .ts）
node tests/note.test.mjs          # 笔记命名规则 31 例（非法字符 / 超长 / 重名 / 本地日期）
node tests/mdimport.test.mjs      # 导入 md 32 例（utf-8 / BOM / **GBK 兜底** / 后缀判定 / 落库路径 / 重名 -2）
node tests/visible.test.mjs       # 左侧「哪些不该显示」25 例
node tests/mdkit.test.mjs         # md 工具栏源码模式 67 例（标题 / 列表 / 行内包裹 / 选区映射）
node tests/folder.test.mjs        # 文件夹 58 例（目录名清洗 / 标识文件 / 空目录推导 / 嵌套建树）
node tests/davxml.test.mjs        # WebDAV 的 PROPFIND 解析 15 例（编码 / 库根剥离 / 各家写法差异）
node tests/links.test.mjs         # 双链与标签 97 例（解析 / 代码块不算 / 标题去日期前缀 / 转义还原）
node tests/rename.test.mjs        # 改名与搬家 89 例（名字净化 / 子树换前缀 / 重名与"拖进自己"拦截 / 双链改写 / 保形改写 / 标题联动）
node tests/binary.test.mjs        # 附件 54 例（后缀判定 / base64 往返 / 大块不爆栈 / 字节指纹 / ![[嵌入]] 解析）
node tests/embed.test.mjs         # 嵌正文 25 例（防环 / 自嵌 / 深度上限 / 标题降级 / 转义 / 只读链接）
node tests/scope.test.mjs         # 推送范围 42 例（`**` / `*.md` / `thoughts/` / 单篇；**排除先看**；空 = 什么都不推）
node tests/diff.test.mjs          # 行级 diff 25 例（LCS / 摘要 / 长段折叠；超 2000 行退化成整块替换）
node tests/readerstyle.test.mjs   # 阅读排版守卫 35 例（选项表自洽 / 脏值归一 / 字号夹边界 / 坏 id 退第一档）
node tests/epub.test.mjs          # epub 解析 44 例（真造 zip：container→opf→spine 三套坐标系 / nav / ncx / 兜底目录 / 坏书 / 去标签 / 书内搜索）
node tests/repo-e2e.mjs           # 浏览器：仓库落在哪 → 建了就进仓库 → 刷新还在 → **localStorage 里没有第二份 files** → 改名后旧路径消失 → 删了就没 → 设置页照实说 21 例（DEV-only）
node tests/book-e2e.mjs           # 浏览器：切换 → 导入 epub → 书架 → 连续滚动 → 目录跳转 → 书内搜索 → **字体·字号·纸色** → 记住读到哪 → **批注（划词 / 写想法 / 改 / 删 / 跨重建还在 / 底色对齐）** → 继续读 → 刷新还在 → 删 109 例
node tests/link-e2e.mjs           # 浏览器：高亮 → Ctrl+点跳转 → 点没有的就建 → 补全 → 标签筛选 → 反链面板
node tests/wiki-e2e.mjs           # 浏览器：标签全局视图 → 待建批量建（落点）→ ![[某篇]] 嵌正文 → 防自嵌
node tests/attach-e2e.mjs         # 浏览器：添加图片 → 看图 → PDF 画在 canvas 上翻页 → 正文嵌图 → 超限被拦
node tests/folder-e2e.mjs         # 浏览器：建多层文件夹 → 空目录看得见 → 往里写笔记 → 删（含确认）
node tests/import-e2e.mjs         # 浏览器：选文件导入 → **GBK 解出来是中文** → 撞名变 -2 且原篇不动 → 非 md 被挡并报账 → 拖入 22 例（DEV-only，靠 __suisui 喂库）
node tests/rename-e2e.mjs         # 浏览器：右键菜单 → 就地改名（双链 + 正文标题跟着改）→ 拖动换层级（含悬停展开折叠目录）→ 属性 → 复制 78 例
node tests/layout-e2e.mjs         # 浏览器：右栏常驻 → 大纲 → 关系面板 → 左栏搜索 → 待同步清单收起 / 展开 → 右栏收起 / 展开走**顶栏**那颗（收起 = 整列消失）→ 左栏同理 → 同步在状态栏 + A± 调编辑器字号 → **两侧边栏拖宽度（含上限 / 双击复位 / 刷新记住 / 手机上没有）** → 手机视口 64 例
node tests/smoke.mjs              # 浏览器：拉取 → 打开文章 → 创建笔记 → md 工具栏 → 截图
node tests/settings-e2e.mjs       # 设置对话框 60 例（入口在左下角 / 居中大卡 + 左列分节 / 凭据跟着后端走 / 后端不放假按钮 / **AI 助手节默认演示、不放假输入框** / 阅读节改一处读处跟着变 / Esc 与点遮罩 / 手机铺满 / 壁纸已移除）
node tests/agent-e2e.mjs          # 浏览器：**AI 助手真跑一遍内核** 29 例（入口唯一 / 事件流 / `list_notes`→`read_note` 读的是仓库里那一篇的正文 / **写之前必弹卡 → 拒绝就没写 → 允许才真落盘且左栏立刻看得到** / Esc / 零报错）
node tests/agent-books-e2e.mjs    # 浏览器：**书籍工具** 21 例（造一本真 epub 导入 → 四个工具都是只读 / 读的是第一章真的字 / `<script>` 没混进正文 / 章节超范围与书名对不上都说得明明白白 / 找不到就直说）
node tests/mobile-e2e.mjs         # 手机视口 58 例（抽屉 / 工具栏横滚 / 触摸尺寸 / 顶栏精简 / 同步钮在状态栏 / 手机壳页 / 桌面不回归）
node tests/pwa-e2e.mjs            # 产物上的 PWA 15 例（SW 注册 → 断开网络仍能打开）
node tests/lazy-e2e.mjs           # 编辑器按需加载 21 例（入口包里没有编辑器 / 首屏不拉 / 加载中给骨架）
node tests/push-e2e.mjs           # 浏览器：推送范围能配能删能回读 → 范围空了自己说话 → 定时是真控件 → **拉取是人选的**（能搜 / 不勾不给拉）→ 冲突给得出差异且三个按钮写清谁覆盖谁 → **设置里「远端仓库」那一块**（坐标 / 状态灯 / 结论 / 去 GitHub 打开 / 试一下）42 例（DEV-only）
node tests/push-roundtrip.mjs     # 端到端：新建 → 推送 → 删除 → 确认 → 再推送（会真的动仓库）
node scripts/gen-icons.mjs        # 重新生成主屏图标（用本机 Edge 渲染，不引原生依赖）
```

工具栏那节**不是在 DOM 上点按钮看它变不变色**，而是点完真的敲字进去、再从 store 读回 markdown 断言
（`点加粗后敲的字被 ** 包住`）—— 只有这样才同时证明「命令跑通了」和「焦点还给编辑器了」。

`mobile-e2e.mjs` 用 Pixel 7 的视口并带 `isMobile` + `hasTouch` —— 少了这两个，浏览器不按移动端处理，
媒体查询和触摸行为都验不到。它最后还会把视口切回 1500px，断言**桌面端没被改动**（侧栏仍是常驻 272px、
汉堡按钮隐藏、按钮文字回来、工具栏仍可换行）。

同一个脚本还守 `public/mobile.html` 那个壳页（它是**会随包发布的文件**，没有断言就会烂掉）：
断言 iframe 内视口真是 412×915、里面渲染的真是手机布局、切到「桌面 1280」后侧栏变回常驻 272px，
并在断点两侧各测一档。⚠️ 断点是 `width < 48rem`，**768 本身算桌面** —— 按「768 算手机」的直觉
写期望会假红（我第一版就是这么红的）。

`pwa-e2e.mjs` 必须跑在构建产物上（`:5184`）：开发期是 Vite 的内存模块图，没有可缓存的静态文件，
在 dev 上测 Service Worker 等于什么都没测。

`push-roundtrip.mjs` **每一步都有断言，不符预期就 exit 1**（它原来只 `console.log`，
网络一抖就"假绿"：顶栏写着「与远端一致」、远端文件还在，脚本照样退出 0）。
它开头先探一次 `api.github.com`，网络不通就直接告诉你"这是环境问题，别在这条线索上查 bug"。

### 「零报错」到底数谁：应用自己的，还是网络替它记的

浏览器会把**任何一次失败的网络请求**自动记成 console error
（`Failed to load resource: the server responded with a status of 404 ()`）——
这跟页面代码写没写错**无关**：只要真去问了远端（启动那次比对、设置里探测），
而那个仓库此刻不存在 / 没权限 / 网络不通，就必然有一条。于是这条断言会变成抽签。

所以判法收在 **`tests/remote-noise.mjs`**（所有套件共用，别一个套件一个写法）：

- **算失败**：`pageerror`，以及来自开发服务器自己的 console error（本地 js / css 加载不出来、自己的接口 500）
- **不算失败**：第三方域（api.github.com）的资源加载失败 —— 结尾单独打一行「远端网络噪声 N 条」
- 位置 URL 拿不到时**一律算失败**：宁可红一条让人来看，也不放过一个说不清来源的报错

仓库通不通由**界面**去说（设置 → 推送 → 「远端仓库」那一块：状态灯 + 一句结论 + 「试一下」），
不由这条断言说。⚠️ 别用「文本里含不含 404 / 401」来判 —— 那会连**应用自己的**接口错误一起赦免。

配套的一条：`lib/gh.ts` 把 `404 Not Found` 这种话翻成能指导下一步的说法
（401 token 失效 / 403 没权限 / 404 仓库或分支不存在或 token 看不见 / 409 远端还是空的 / 5xx 等一会）。

几个脚本在 `chromium.launch` 之前会**清掉 `http_proxy` 等环境变量**并带 `--no-proxy-server`（坑 3）。
`smoke.mjs` 在左侧没有 md 时会跳过「打开 / 源码」两节，好让**纯本地的「创建笔记」在断网时也测得到**。

## 踩过的坑（都不报错，是测试抓出来的）

**1. GitHub `/git/ref/heads/{branch}` 有 CDN 缓存（约 60 秒）。**
推完立刻再比对，会拿回**推送前**的 HEAD → 远端 tree 里看不到刚推上去的文件 →
`decide()` 判成"无变化"，界面显示「与远端一致」，可文件其实已经推成功了。
手动点两次同步撞不见它（中间隔了几十秒缓存就过期了），只在"推完马上比对"时复现。
修法：`gh.ts` 的 `doFetch` 统一带 `cache: 'no-store'`。

**2. e2e 的「等空闲」不能等 DOM。**
原来等 `[data-sync]` 变成不 disabled，可 React 还没把 `busy` 渲染成 disabled 它就返回了 ——
断言全跑在任务**开始之前**，表现成随机假红/假绿。改成先等 `store.busy !== null`、
再等 `store.busy === null`。这也是为什么值得留一个 DEV 专用的 `window.__suisui`：
测试读真实状态，不靠猜 DOM。

**3. Playwright 会把 `http_proxy` / `https_proxy` 透传给浏览器。**
本机有这么一组环境变量，端口还会变（见过 56154 和 50606）。于是同一个
`api.github.com`，node 的 `fetch` 一路 200，浏览器却间歇性
`net::ERR_CONNECTION_CLOSED` / `ERR_TIMED_OUT` —— 这两件事看起来像玄学，其实是代理。
之前把一堆问题误判成"网络抖动"，就栽在这。
修法：测试里 `delete process.env.http_proxy`（含大小写各变体）+ `--no-proxy-server`。
⚠️ 改完这一条，之前"时红时绿"的用例全都稳定通过 —— **以后再遇到"浏览器连不上、某个进程连得上"，
先查代理透传，别急着怪网络。**

**4. 「本地没有 + 上次快照有 + 远端没动」= 本地删除 —— 这条判定会成片删远端文件。**
只要本地工作副本对某个文件"不知情"（拉取半途失败、状态被清过、脚本动过手），
三路判定就会认为你删了它，下次同步把远端对应文件一起删掉。**远端删除不可逆，且它只写进
一次 commit，很容易没注意。**（真实发生过：`notes/2026-09-21-随手.md`、`thoughts/2026-09-21-开张.md`
被这样删掉，已从历史提交恢复。）
修法：`pushOnce` 默认**只推不删** —— 把要删的路径放进 `pendingDeletes`，顶上弹一条红色确认条
（「这轮推送要从远端删掉 N 个文件：…」+「先不删 / 确认删除」），点过确认才真的删。
同时给 store 的异步操作加了序号（旧操作回来时发现号被顶掉就直接不写状态），
否则启动时那次自动比对会把手动推送的 `busy` 清成 null —— 界面显示"不忙"、请求还在飞，按钮还能再点一次。

⚠️ **2026-09-27 起多了一道更靠前的闸门：推送范围。** 不在范围里的路径连 `decide()` 都进不去，
所以「取消勾选一篇」永远不等于「删了它」。
⛔ 反过来，千万别把"范围外"实现成"判定时假装本地没这个文件" ——
那正是这条坑的原样复刻：一篇篇被判成本地删除，推一次远端就空了。

**5. 所见即所得有 700ms 防抖窗口，切模式/切文件会在这段窗口里丢字。**
实测：在所即所得里敲完字**立刻**切「源码」，源码框显示的还是旧稿，在那儿改一下就把刚写的整个顶掉。
两个成因叠在一起：① `draft` 只在 `[current, lastSyncAt]` 变化时从 store 同步，**切模式不在依赖里**；
② store 的更新被 700ms 防抖压着，`content` 本身就是旧的。
修法：切模式前先 `flushEditor()`（把编辑器缓冲立刻写回 store）+ 编辑器卸载时兜底冲一次。
⚠️ 兜底那一次要跳过两种情形，否则修一个坏一个：**同步拉完那次重建**（缓冲区是拉取前的旧文本，
冲回去等于把刚拉下来的顶掉）、**文件已被删除**（不然"删除当前文件"会当场把它救回来 —— 这个是我
第一版改完立刻在 `smoke.mjs` 的清理步骤上撞到的）。

**6. `# 标题\n\n` 里的末尾空段落会被 markdown 解析吃掉。**
「创建笔记」的初始正文模板是 `# 标题\n\n`，但 remark 不会为结尾的 `\n\n` 生成空段落 —— 文档只剩一个 `<h1>`。
于是"把光标送进正文"实际落在标题里，一打字就接在标题后面（标题变成 `# 雨天 散步粗体测试`）。
修法：聚焦前先看一眼文档末尾，若是标题就补一个空 `paragraph`（`EditorPane.ensureTrailingParagraph`）。

**7. `@scope` 里的选择器不加特异性 —— 默认排版会反过来压死用户样式。**
按 CSS Cascade 6，**`@scope` 不给里面的选择器加特异性**：用户写 `h1 { color: … }` 是 `(0,0,1)`，
而默认排版若写成 `.scope-root h1` 就是 `(0,1,1)` —— 用户不写 `!important` 永远改不动。
而这件事**不报错、不警告**，界面上只是"我写的怎么没反应"。修法：默认排版整块塞进 `@layer base`
（未分层样式一律压过分层样式）；也别改成 `.scope-root h1` 那种前缀，那等于把用户锁死。

**8. 回车提交时，这个回车的"默认动作"会漏进刚打开的编辑器。**
新建笔记是回车提交 → 提交里同步改 store → 新文件当场打开、正文编辑器挂载并抢到焦点；
（**注**：创建入口后来改成「一键建、零输入」，这条回车路径已不存在；但把光标送进正文的
`focusTick` 那段还没变，别顺手删。）
可**按键的默认动作是在事件处理完之后才执行的**，此时焦点已经不在那个输入框上了，
于是这个回车落进正文，在文首插了一个空块。表现：新建的笔记凭空多出 `<h1><br></h1>`，
而且它还会触发一次 `input`，把污染过的内容写回 store —— 看起来像"初始正文模板写错了"。
点「创建」按钮不会复现，只有回车会，所以特别容易漏。
修法：`FileTree` 里两个输入框的 Enter 分支都先 `e.preventDefault()` 再执行提交。
**"用键盘提交 + 提交后焦点会转移"这个组合，默认动作一律要掐掉。**

**9. Tailwind v4 的 `-translate-x-1/2` 走的是 `translate` 属性，不是 `transform`。**
手机上要让桌面居中弹层改成贴边，写了 `transform: none` —— **没生效，而且不报错**。
Tailwind v4 生成的是 `--tw-translate-x: -50%` + `translate: var(--tw-translate-x) …`，
它作用在 CSS 的独立变换属性上，`transform: none` 跟它压根不是同一个属性。
表现：弹层 `left/right` 都对了，却仍然往左偏了半个屏（量出来 `x = -182`，正好是 `12 - 194`）。
修法：媒体查询里 `translate: none` 和 `transform: none` 一起写。
⚠️ 同理，`scale` / `rotate` 也是独立属性 —— 覆盖 Tailwind v4 的变换时别只写 `transform`。

**10. 直接 `vite build` 会失败，而且失败得很脏 —— 本机有两个 Windows 怪脾气。**
构建第一步是清空 `dist/`，于是先撞上 `EPERM, Permission denied`（`vite:prepare-out-dir`）。
要命的是它**删到一半才失败**：`dist/assets/` 已经被删掉，`dist/index.html` 却还是旧的 ——
于是**正在跑的 preview 立刻变成一个白屏应用**（旧 html 指向已被删掉的新 hash 文件），
而构建日志只报一句权限错误，看的人容易以为没事。

两个独立的脾气（都不是"权限不足"四个字能解释的）：
- **目录级 `rename` 会被拒**：EPERM，换成别的目标名也一样；可同一个名字 `mkdir` / `rmdir`
  却是好的。所以"先建到暂存目录再整体换名"这种最常见的写法，在这台机器上直接不可用。
- **递归删目录（180+ 文件）会永不返回**：不是报错，是**卡住**（`rmSync` 挂在那儿几个小时都不会回来）。
  表现最迷惑：构建日志已经打完"改用拷贝"，进程就再也没动静了。逐个 `unlink` 反而一切正常。

修法：`scripts/build.mjs` 把这两条都绕开 —— 先建到暂存目录、自检引用的 `/assets/...` 都在、
再「删旧的 + 整目录拷贝」；暂存目录用逐个 unlink 清，且全程 best-effort（清不掉就留着，
它已 gitignore），绝不让"上一轮的残留"或"清理失败"拖住构建。
⚠️ **别把 `rename` 或 `rmSync(dir, {recursive:true})` 加回来。**

**11. 附件那条路，任何一步"按文本处理"都是静默损坏。**
它不报错、不警告，界面上只是"图裂了 / 打不开"，而且**推上去就把远端那份也覆盖成坏的**。
三个具体的点：① `res.text()` 解二进制 → 解不出的字节变 U+FFFD；
② 指纹按 base64 字符串算 → 和远端的字节 sha 永远不等 → 每次同步都判成"本地改了"；
③ `resolveWiki`（笔记那套）去解析 `![[dot.png]]` → 它会先把后缀剥掉，于是永远找不到。
所以附件单独有一套：`readBytes()` / `encoding: 'base64'` / `storedSha()` / `resolveFile()`。
⚠️ 反过来也一样：`[[开张]]` 那种**不带后缀**的引用不能走 `resolveFile`，两套别混着用。

**12. 嵌正文的 HTML 不能直接塞回 markdown —— 渲染器会把它转义成源码。**
`![[某篇]]` 要渲染成 `<span class="su-note">…</span>`，最直觉的写法是在渲染前把这些
片段拼进正文再交给 md 渲染器。**这条路是坏的**：micromark 默认把"原样 HTML"转义
（这是它的安全默认，正是我们要的），于是你拼的 `<img src=...>` 被输出成
`&lt;img ...&gt;` —— 嵌进来的图和整块结构当场变成一行源码，而且**不报错**。
修法：先把嵌入换成纯字母数字的**占位符**（`%%SUEMBED0%%`，不会被转义）→ 交给渲染器 →
再把占位符换回 HTML。独成一段的连外面那层 `<p>` 一起换掉，免得块级内容塞在段落里。
单测那条「尖括号不变标签」就是抓这个的 —— 它同时钉住"我们转义了"和"没有二次解码"。

**13. 解析顺序错了，一条路会永远走不到（而且看起来像"功能没做"）。**
`![[某篇]]`（笔记，**不带后缀**）和 `![[dot.png]]`（附件，**带后缀**）共用一个入口。
先调 `resolveFile` 的话，它按"全名含后缀"匹配，`某篇` 永远找不到 → 返回 null →
笔记那条渲染路**根本走不到**，画出来一张「还没上传」的虚线卡片。
不报错、不警告，表现为"我明明实现了嵌正文，怎么还是卡片"。
修法：**先按笔记名 `resolveWiki`，命中且不是二进制再走附件**。探针里
`noteEmbeds 0 / missCards 1` 就是这个顺序栽的。

**14. 嵌入区不在 `.ProseMirror` 的排版体系里，全局样式会整个透进来。**
Crepe 给 `.ProseMirror p` 带了 margin **和 `padding: 4px 0`**。`![[某篇]]` 是
**widget**（contenteditable=false，PM 不排版它），但它是 `.ProseMirror` 的后代，
于是嵌进来的每个段落都吃一份 padding：实高从 19.5px 涨到 27.5px（实测），
一行字占成一行半，整块看起来"空得不像引文"。
修法：`.su-note-body > *` 上把 margin **和 padding** 都压掉（要 `!important`，
对方是 `p` 类型选择器 + 我们在更深的层级）。
⚠️ 只压 margin 不够 —— 我第一次就是这么改的，量出来还是 28px。

**15. 预览没变，先怀疑"页面没真重载"，别急着改代码。**
本会话踩了两次：① dev server 死了，页面成了僵尸（还挂着旧模块）；
② 换了构建产物，但预览面板复用了旧页面，没做一次真正的新导航。
判断方法：**开一个全新端口**（或 Playwright 无痕 context）打同一个服务 ——
SW 和 HTTP 缓存的隔离边界都是 origin，换端口就等于换了一整套缓存。

**16. 用它自己的手势拖行时，浏览器会把文字选中，然后下一次拖动会被"原生拖拽"掐死。**
症状很有欺骗性：**第一次拖动完全正常，第二次拖动毫无反应**（`pointermove` 也不来了）。
真因是行里的文字在按下拖动时开始被选中，第二次按下的位置落在这段选中文本里，
浏览器把它理解成"要拖动这段文字"→ 发起原生 drag → 对我们正在跑的手势发 `pointercancel`。
这条只在**连着拖两次**时出现，单次拖动、或者换一行再拖都测不到 —— 所以它躲过了所有手写验证。
修法两条一起上：行上 `select-none`（行不是给人选文字的地方，Obsidian / VS Code 也这样）
＋ `onDragStart={e => e.preventDefault()}`（把任何原生拖拽掐死在源头）。
`tests/rename-e2e.mjs` 里「连拖两次都要能拖」那节就是钉这条的。

> 顺带一条测法上的教训：拖动的落点坐标**必须在按下之前现量**。刚做完操作时顶上会多一条
> "已改名 / 已移到"的通知条，它把列表整体往下挤 —— 事先量好的坐标到时候指的就是别的东西了，
> 表现为"拖动有时管用有时不管用"。所以那个测试里等通知条走掉再量。

**17. `vite preview` 开着的时候打包必失败，而且报错全不指向真凶。**
`npx vite build` 会先 `emptyDir` 清 `dist/`，而 preview 正在服务那个目录 —— Windows 上
文件被占着删不掉，抛出来的是一长串 rolldown 内部栈（`at emptyDir … at prepareOutDir …`），
从头到尾不提"端口 5184 还开着"。**打包之前先把 preview 停掉**，打完再拉起来。

**18. 读电子书时，DOM 已经卸载 ≠ 还能读它的滚动位置。**
「退出书之前最后记一次进度」写在 effect 的清理函数里，但 React 跑清理时节点**已经摘出文档**了，
此时 `scrollTop` 与 `clientHeight` **都返回 0** —— 照算会得到"在第 0 像素、窗口高 0"，
于是判定成"读到了最后一章、进度 0%"，把真进度盖掉。症状很怪：**退出一本书，再打开跳到最后一章**。
修法：存之前先 `if (!box.isConnected || box.clientHeight === 0) return;`。
（顺带一条同类：章节的 `offsetTop` 要跟 `scrollTop` 同坐标系，滚动容器**必须** `position: relative`，
否则 offsetParent 跑到外层去，"跳到第三章"会跳错。）

**19. 阅读器不用书自带的 CSS。** epub 里的样式常写死字号、写死白底黑字、写死宽度，
照搬的结果是"字号调了没反应""夜间模式一半字看不见" —— 而字号 / 行距 / 背景正是阅读器要给的。
所以只保留**结构**（标题 / 段落 / 引用 / 列表 / 图片 / 表格 / 加粗斜体），排版归 `.book-body`。
代价是些讲究排版的书会变得朴素一点，这个亏吃得起。

三步排查顺序：先看服务端吐的 asset 是不是磁盘上那份 → 再开无痕看渲染结果 →
再看 SW 策略。三次都排除了，才轮到"代码有问题"。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/lib/gh.ts` | GitHub API 封装、git blob sha 计算、LF 归一 |
| `src/lib/decide.ts` | 三路判定纯函数（零依赖，可单测） |
| `src/lib/scope.ts` | **推送范围**：规则匹配（目录 / 后缀 / 单篇 / 全推）+ 单篇排除 + 清洗与一句话描述（零依赖，可单测）。范围外的文件同步层完全看不见 |
| `src/lib/diff.ts` | 冲突选边用的行级 diff（LCS，unified 视图 + 折叠没动过的长段；超 2000 行退化为整块替换）（零依赖，可单测） |
| `src/lib/note.ts` | 笔记命名规则：`notePath` / `slugifyNoteTitle` / `dedupePath`（零依赖，可单测） |
| `src/lib/visible.ts` | 「哪些文件不该显示在左侧」的展示层规则（零依赖，可单测） |
| `src/lib/mdkit.ts` | md 工具栏**源码模式**的 md 语法改写（零依赖，可单测）＋ 两种模式共用的 `ToolId` / `Active` |
| `src/lib/folders.ts` | 文件夹与路径层：目录名清洗、标识文件、目录推导、嵌套建树、**改名 / 搬家**（`renameEntry` / `moveEntry`，共用"前缀替换"）（零依赖，可单测） |
| `src/lib/links.ts` | 双链与标签：解析、名字→路径、反向链接 / 标签索引、补全候选、`unescapeWiki`、`aliasesOf`、**改名联动** `retargetLinks` / `retitleBody`、本页大纲（零依赖，可单测） |
| `src/lib/binary.ts` | 附件：后缀判定、MIME、`base64 ↔ 字节`、**字节指纹**、体积上限（零依赖，可单测） |
| `src/lib/pm-links.ts` | ProseMirror 插件：`[[ ]]` / `#tag` 的装饰（**不动 schema，只加 span**）、`[[` 补全的触发与插入、`![[ ]]` 的嵌入 widget |
| `src/lib/providers/types.ts` | 同步后端的统一接口 `Remote` + 各家元数据（含"浏览器能不能直连 / 做完没有"） |
| `src/lib/providers/github.ts` | GitHub 实现（Git Data API，一个 commit） |
| `src/lib/providers/webdav.ts` | 坚果云实现（WebDAV）。请求走注入的 transport —— 浏览器没有，桌面端才有 |
| `src/lib/providers/onedrive.ts` | OneDrive 实现（Microsoft Graph）。只接 token，授权留位 |
| `src/lib/providers/davxml.ts` | PROPFIND 响应解析（零依赖，可单测 —— 用正则而非 DOMParser） |
| `src/lib/epub.ts` | epub 解析：解压（fflate）→ container → OPF → spine / 目录（nav.xhtml → toc.ncx → 正文标题兜底）、章节→纯文本、书内搜索（零 DOM，可单测） |
| `src/lib/bookdb.ts` | 书架的 IndexedDB：书目 / 字节 / 进度 / 排版偏好 / **批注**（按 `bookId` 建索引；删书连批注一起清）。**书不进 `files`、不参与同步** |
| `src/lib/anchors.ts` | 批注的位置：**记纯文本偏移，不记 DOM 节点**（DOM 会被搜索高亮拆了又合，节点序号靠不住）。两端换算都在这儿 |
| `src-tauri/` | 桌面端骨架。目前只提供 `dav_request`：让坚果云绕开 CORS |
| `src/lib/agent/core/` | **vendored 的 agent 内核**（`nosie-agent-core`，MIT，v0.2.0）。原样搬进来后再做浏览器化：删掉 cli / sidecar / MCP / 文件记忆 / JSONL 会话 / fs+shell 工具，剩下循环、权限、压缩、预算那半（纯逻辑）。⚠️ 它是**第三方代码**，改之前先看 `src/lib/agent/index.ts` 文件头那三条装配原则 |
| `src/lib/agent/shims/` | 内核要的 Node 内置在浏览器里的替身。`path` / `os` / `crypto` / `url` 是**真实现**；`fs` / `child_process` / `readline` / `stream` **调到就抛**（静默返回空数据会让"内核以为自己写了文件"这种事故查不出来） |
| `src/lib/agent/note-tools.ts` | 笔记工具：读的三个 + **写的两个**（`write_note` / `append_note`，都走 `store.setContent`，不另开写盘的路）。底下是 `Repo` —— 仓库内相对路径，出不去，所以"沙箱"在这儿是天然的 |
| `src/lib/agent/book-tools.ts` | 书籍工具：四个，**全只读**。数据源是 `bookdb`（IndexedDB）而不是 `Repo`；模型只知道书名不知道 uuid，所以按标题匹配，对不上就把候选列出来。解压结果缓存三本 |
| `src/lib/agent/tool-list.ts` | **零依赖**的工具名表 + `canWriteFiles()`。设置页列它，装配处也用它 —— 两边同一个来源，界面上那句"N 个工具"才不会是谎话。⚠️ 别从 `lib/agent` 引它（会把内核拖进设置那个 chunk） |
| `src/lib/agent/index.ts` | 装配处：polyfill 必须最前、不给文件系统、模型请求走可注入的 `fetch`（桌面端可换 Rust 代理绕 CORS + 护 Key） |
| `src/lib/agent/demo.ts` | 演示模式的 `MockProvider`：读 / 写两套脚本。**验的是链路通不通，不是模型聪不聪明**。`DemoProvider` 覆写了 `stream` —— 基类的回合游标不随 run 归零，不认「新一轮」的话问第二句就演完了 |
| `src/components/ChatPane.tsx` | 助手面板（懒加载，内核那 104 kB 不进首屏）。把事件流画出来：`text_reset` 是**清空**不是出错；工具卡按 `toolCallId` 记 |
| `src/lib/sync.ts` | 对外动作的编排：**只推**（`pushOnce`）/ **只拉指定的几篇**（`pullOnce`）/ **选边**（`resolveConflict`）；比对先按推送范围收窄，删远端一律要人点头 |
| `src/lib/store.ts` | Zustand 状态（本地工作副本 + 快照）。**异步操作带序号，防止旧操作覆盖新状态**；`side`（书写 / 阅读在哪边）与 `lastBookId`（上次读的那本）持久化，`currentBook` 不持久化 —— 重开先回书架 |
| `src/components/EditorShell.tsx` | 编辑器外壳（台面 → 纸面 → 路径栏 / 模式开关 / 面包屑）。**必须留在主包里** |
| `src/components/EmptyState.tsx` | 编辑区的两种"还没有编辑器"状态（空态 / 加载骨架）。**必须在主包里** —— 见「已实现」里的按需加载 |
| `src/components/WikiHints.tsx` | `[[` 补全浮层（跟着 `[[` 那个字符定位，mousedown 掐默认动作以保住编辑器焦点） |
| `src/components/BacklinkPane.tsx` | 正文下方的反向链接 / 标签 / 待建笔记面板（有关系才出现） |
| `src/components/PreviewPane.tsx` | 附件预览：图片 + 体积 / 缩放 / 下载。**必须轻** —— 里面的 pdf.js 是二级懒加载 |
| `src/components/PdfView.tsx` | PDF：pdf.js 渲到 canvas（翻页 / 缩放 / 适应宽度）。只在真打开 PDF 时才下载 |
| `src/components/ContextMenu.tsx` | 右键菜单：贴光标定位 + 贴边翻转、Esc / 点外面 / 滚动 / 失焦都关、方向键能走 |
| `src/components/EntryInfo.tsx` | 「属性」面板：路径 / 类型 / 大小 / 字数 / 标签 / 关系 / 同步状态（目录显示里面有几个） |
| `src/components/ModeSwitch.tsx` | 左栏顶上的**「书写 / 阅读」分段控件** —— 两边共占同一块主区，得有一眼能看出"现在在哪儿"的东西；选中态跟 store 的 `side` 走 |
| `src/components/BooksPane.tsx` | 左栏的**书架**。读书时也一直是书架（不再换成目录）—— 当前在读那本写着「正在读」，读着就能翻下一本 |
| `src/components/BookAside.tsx` | 阅读时**右栏**那一份：**目录** + **笔记（这本书的批注）**。读书时整个换掉笔记那套（大纲 / 关系 / 待建），因为它们跟眼前这本书没关系 |
| `src/components/BookPane.tsx` | 阅读器（懒加载）：连续滚动、目录跳转、书内搜索 + 高亮、字号 / 行距 / 三种背景、记住读到哪、**划词工具条与批注底色**。章节**消毒后**进自己的容器（不用 iframe，见它头上注释） |
| `src/components/` | 顶栏（含移动端抽屉开关） / **左下角 dock（刷新 / 推送 / 拉取 / 设置 四颗）** / 文件树（一键建笔记 + 目录选中、右键菜单、就地改名、拖动搬家、导入 md、标签筛选） / 编辑器 / **格式工具栏** / **待推送清单（`ChangeList`）** / **远端浏览与拉取（`RemotePane`）** / **冲突选边（`ConflictPane`）** / **状态栏（只报状况，不给同步按钮）** / 图标集 |
| `src/main.tsx` | 入口。DEV 下把 store 挂到 `window.__suisui`；**只在 PROD 注册 Service Worker** |
| `public/manifest.webmanifest` | PWA 清单（standalone / 图标 / 语言） |
| `public/sw.js` | 离线外壳：导航 network-first，静态资源 SWR，跨域一律放行 |
| `public/mobile.html` | 手机壳预览页（真机尺寸 iframe，纯演示，不参与应用逻辑） |
| `public/icons/` | 主屏图标（`scripts/gen-icons.mjs` 生成，别手改） |
| `scripts/build.mjs` | 生产构建（暂存目录 + 自检 + 换目录）＋ 报首屏引用与 chunk 体积 |
| `scripts/gen-icons.mjs` | 生成 PWA 主屏图标（用本机 Edge 渲染，不引原生依赖） |

## 界面约定

一套**纯黑白灰**的视觉 —— 配色只走明度，不走色相。台面（`desk`）是一块纯灰，
正文是摊在台面上的一张纯白纸（`sheet`，圆角 + 落影，手机上退化为满屏）。
层次靠**灰色阴影**和明度差，不靠边框、不靠颜色。
令牌全在 `src/styles.css` 的 `@theme` / `:root` 里，组件里**只用语义名**
（`bg-surface` / `text-ink-2` / `border-line` / `shadow-pop`…），不写裸 hex、不写裸阴影。

| 令牌 | 用途 |
| --- | --- |
| `paper` → `surface` → `surface-2` → `surface-3` | 台面 → 纸面 → 工具架/次级块 → 目录选中 |
| `ink` / `ink-2` / `ink-3` | 三级文字（近黑 `#121212` / 中灰 / 浅灰） |
| `accent`（**纯黑**） | 主按钮、链接、焦点环、当前选中、待拉取 —— 靠「比正文更黑」强调，不靠有色 |
| `craft`（中灰） | 标签那一套：正文里的 `#tag` 装饰、反向链接的标签块、标签筛选条、PDF 徽标 —— 「这一类东西」的记号 |
| `ok` / `warn` / `danger` | 灰阶化的三级状态：深灰 / 中灰 / 最黑。语义改由**明度阶梯 + 图标**承担 |
| `shadow-xs/sm/md/lg/pop/sheet` | 五级阴影，各对应一种语义（贴面控件 / 手里按钮 / 浮纸 / 压正文卡片 / 弹层 / 摊开的纸），**别跳级用** |
| `font-serif` | 只给"名字"：应用名、正文 h1/h2、空态主句。小字号（<14px）一律不用衬线 —— 中文衬线小字会点阵化发虚 |

两条由「纯黑白」直接逼出来的规矩，动样式时别踩：

- **链接必须自带下划线。** `accent` 是纯黑、正文是 `#121212`，两者几乎同色 ——
  颜色不再是链接的分辨记号，下划线才是。所以 `a` 的 `text-decoration` 是显式写死的，
  不是继承来的（正文里 `.milkdown-wrap … a` 那一份，预览 / 阅读器各有一份同款）。
- **黑底按钮的 hover 不能用 `brightness()`。** 近黑乘 1.06 还是近黑，等于没有反馈；
  统一改成 `hover:opacity-90`（黑底透出后面的浅灰），`.btn-primary:hover` 再叠一圈灰光晕。

- 编辑器外壳统一走 `src/components/EditorShell.tsx`（抬头条：图标 + 徽标 + 模式开关 + 纸面）。
  **别再在各自的 Pane 里手写抬头栏** —— 那正是之前两边漂移的原因。
  它必须留在主包里（EmptyState 的骨架也用它），所以它一个编辑器依赖都不能 import。
  ⚠️ 路径**不画在这里** —— 顶栏中间的面包屑是路径的唯一显示位，画第二遍就是两处要一起维护。
- 图标统一走 `src/components/icons.tsx`（16 格、`currentColor`、1.5 描边），不用 `●`、`×` 这类字符当图标。
- **正文测量宽度 = 46rem 居中**（`.editor-sheet`）。改这个宽度时，工具栏和提示条的
  `max-w-[46rem] px-6` 要一起改，否则左边界会错开。
- Milkdown 通过 `--crepe-color-*` / `--crepe-font-*` 映射到上面这套令牌（见 `.milkdown-wrap`），换主题只改一处。
- 关键控件保留 `data-*` 钩子（`data-sync` / `data-refresh` / `data-file` / `data-toggle-all`
  / `data-new-note` / `data-more`（「⋯」菜单，菜单项 `data-ctx-item="tools-attach|tools-import"`）
  / `data-new-note-target` / `data-dir-selected` / `data-delete-confirm`
  / `data-delete-ok` / `data-mode` / `data-md-toolbar` / `data-md="<工具id>"` / `data-md-link-pop`
  / `data-md-link-input` / `data-md-link-apply` / `data-source`
  / `data-drawer` / `data-drawer-toggle` / `data-drawer-mask`
  / `data-pull` / `data-pull-count`（dock 上「拉取」那颗，角标只数远端更新）
  / `data-scope-box` / `data-rules="include|exclude"` / `data-rule="<规则>"` / `data-rule-del`
  / `data-rule-input` / `data-rule-preset`（设置 → 推送 里的推送范围编辑器）
  / `data-autopush-box` / `data-toggle="autopush"` / `data-autopush-min="<分钟>"`
  / `data-remote-panel` / `data-remote-mask` / `data-remote-close` / `data-remote-refresh`
  / `data-remote-search` / `data-remote-all` / `data-remote-list` / `data-remote-row="<路径>"`
  / `data-remote-state` / `data-remote-conflict` / `data-remote-count` / `data-remote-pull`
  / `data-conflict-panel` / `data-conflict-mask` / `data-conflict-close` / `data-conflict-diff`
  / `data-diff-line="same|add|del"` / `data-conflict-side="local|remote|both"`
  / `data-dock` / `data-sync`（**在底部状态栏上**） / `data-sync-count` / `data-cred-dot` / `data-sync-now` / `data-token`
  / `data-editor-font-minus` / `data-editor-font-plus`（状态栏调编辑器字号的一对）
  / `data-resizer="left|right"`（两侧边栏的分隔条，拖动中带 `data-dragging`）
  / `data-settings` / `data-settings-panel` / `data-settings-mask` / `data-settings-close`
  / `data-settings-nav` / `data-settings-nav-item="<节>"` / `data-settings-body`
  / `data-reader-fonts` / `data-reader-themes` / `data-reader-preview`
  / `data-book-skin` / `data-book-skin-panel` / `data-book-skin-close` / `data-book-skin-more`
  / `data-book-font-plus` / `data-book-font-minus` / `data-book-line`
  / `data-book-font-btn="<字体>"` / `data-book-theme-btn="<纸色>"` / `data-set-*`（设置里那份排版控件，同名）
  / `data-toggle="showall"`
  / `data-provider="<后端>"` / `data-dav-url` / `data-dav-user` / `data-dav-pass` / `data-dav-warn` / `data-od-token` / `data-od-base`
  / `data-new-folder` / `data-folder-name` / `data-folder-submit` / `data-dir="<目录>"` / `data-dir-del="<目录>"`
  / `data-folder-del-confirm` / `data-folder-del-ok` / `data-folder-del-cancel`
  / `data-wiki`（装饰 span，带 `data-heading`） / `data-tag` / `data-wiki-hints` / `data-wiki-hint="<序号>"` / `data-wiki-kind`
  / `data-backlinks` / `data-backlink-tag` / `data-backlink-from` / `data-backlink-create`
  / `data-tag-filter` / `data-tag-clear` / `data-tag-empty`
  / `data-attach-input` / `data-attach-error`（附件入口的按钮在「⋯」菜单里，input 仍在 DOM）
  / `data-import-input` / `data-import-dropzone`（带 `data-import-dragover`；导入入口的按钮同上）
  / `data-topbar`（全应用唯一的顶栏）/ `data-topbar-path`（中间的面包屑，目录段 `data-crumb` 可点）
  / `data-left-toggle` / `data-right-toggle`（顶栏右侧两颗收栏开关，带 `data-on`；手机上不渲染）
  / `data-preview`（值为 image / pdf）/ `data-preview-img` / `data-preview-size` / `data-download`
  / `data-zoom-in` / `data-zoom-out` / `data-zoom-fit` / `data-zoom`
  / `data-pdf` / `data-pdf-canvas` / `data-page` / `data-page-prev` / `data-page-next`
  / `data-editor-empty` / `data-editor-loading`），e2e 依赖它们。
- ⚠️ **点正文里的链接必须带 Ctrl / ⌘**（`click({ modifiers: ['Control'] })`），
  单击是"把光标放进去改字"；只有窄屏（≤768px）是单击就跳。测试里漏了 modifiers 会一直点不动。
- ⚠️ **文件树选中行的 `bg-surface` 不能换**：`tests/mobile-e2e.mjs` 靠
  `className.includes('bg-surface ')` 把当前行挑出来，再断言其余行没有常显删除按钮。
  换成别的底色（比如 bg-accent-soft）那条断言会当场假红。
- **工具栏按钮统一 `onMouseDown` preventDefault**：不放行的话按钮会抢走焦点，编辑器一失焦，
  两种模式的光标位置都得费劲找回来。
- **输入框里的回车要挡输入法组字**：中文输入法用回车"选词"时也会冒泡出 Enter，
  不挡的话打拼音一选字就把笔记建了（`FileTree.tsx` 的 `isComposing()`，判 `isComposing || keyCode === 229`）。
- 左侧过滤规则全在 `src/lib/visible.ts`：点开头的任意路径段、程序类后缀、`scripts`/`src`/`tests`/`assets`
  等目录、根目录的 README/License。想放开某个目录，改那个文件的 `PROGRAM_DIR` 集合即可。
  它**不是安全边界**，只是「眼不见为净」；被藏起来的文件在本地照常持有、照常同步。
- 判断「看起来没对齐」这类视觉问题时，用 `getBoundingClientRect()` 量，别靠看截图 —— 截图缩放会骗眼睛。
- **移动端断点只有 `48rem` 一个**（对齐 Tailwind 的 `md`，别另外写 `768px`）。
  分界线是：**会改变定位 / 滚动行为的规则写进 `styles.css` 那个 `@media (width < 48rem)` 块**
  （抽屉、工具栏横滚、触摸尺寸、弹层贴边、安全区），**间距字号这类微调就地写 `max-md:` 变体**。
  理由是前者散在 JSX 里就看不出整体布局怎么变，后者贴着用它的地方更好改。
  那个块里用的是 `[data-*]` 钩子，和 e2e 同一批，不额外发明类名。
- **做旧式响应式时先量 `getBoundingClientRect()`，别信截图。** 这轮的两个真 bug 都是这么抓到的：
  遮罩"点不着"（其实点在了盖住屏幕中央的抽屉上）、弹层偏出半屏（Tailwind v4 的 `translate` 属性，坑 9）。
- **绝对定位的浮层，坐标系一定要对着它自己那一层的容器量。** 批注底色第一版就偏了 57px：
  量的时候拿的是滚动容器的 `getBoundingClientRect()`，而浮层长在正文外面那层
  `relative` 容器里 —— 两者左上角不是同一个点。修法很土但是对的：**谁装它就量谁**
  （`measureNotes(notes, frameRef.current)`）。测试里有一条"底色压住了字，不多不少"盯着它。
- **`dist/assets` 攒到 50 个以上文件时 `vite build` 会直接失败**：批量删除保护把 vite 的
  `emptyDir` 也拦了，而报出来的是一长串 rolldown 内部栈，完全不提"目录删不掉"。
  构建前手动把 `dist` 递归清一遍（见上一节「打包」）。
