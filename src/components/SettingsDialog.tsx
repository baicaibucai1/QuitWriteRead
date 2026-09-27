import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { BRANCH, OWNER, REPO, useStore } from '../lib/store';
import type { SettingsTab } from '../lib/store';
import { PROVIDERS } from '../lib/providers';
import type { ProviderId } from '../lib/providers';
import { hasDavTransport } from '../lib/providers';
import { describeRef, isTauri } from '../lib/repo';
import { describeScope } from '../lib/scope';
import ReaderStyleFields from './ReaderStyleFields';
import { Alert, BookOpen, Close, Cloud, FileText, FolderPlus, Info, Refresh } from './icons';

/*
 * 设置对话框：**一张居中浮起的大卡**，左边一列分节，右边一节的内容。
 *
 * 它以前是「从左边缘推出的一张纸」，那条形状当时的理由是充分的 ——
 * 入口（齿轮）在左下角 dock 上，面板跟着入口走，从右边飞来的像另一个地方。
 * 现在改形状不是因为那条理由失效了，而是**内容撑破了容器**：阅读排版这一节
 * 要能横着铺开「字体 / 字号 / 行距 / 纸色」四行，400px 的窄抽屉里它们只能叠成一摞，
 * "一次调齐"做不到。
 *
 * 随之而来三条规矩：
 *   ① **独占一屏**：遮罩盖住整个工作区，没有"边看笔记边改设置"这回事；
 *      要对照读书的效果，"预览"那一块就在眼前（同一套 CSS 渲染的，不是插图）。
 *   ② **Esc 与点空白处都收得掉**：浮层就得能被这两个动作关掉，这是一贯的。
 *   ③ **同一份设置不在两处各摆一次开关**：阅读排版虽然有一个随手调的入口
 *      （阅读器抬头那个「Aa」），但两个入口读写同一个 store 状态（见 ReaderStyleFields）。
 */

const TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: 'general', label: '常规', hint: '仓库在哪、文件列表怎么列' },
  { id: 'sync', label: '推送', hint: '东西存在哪、推哪些、多久推一次' },
  { id: 'reading', label: '阅读', hint: '书的字体、字号、纸色' },
  { id: 'about', label: '关于', hint: '这个软件是什么' },
];

function IconOf({ id }: { id: SettingsTab }) {
  if (id === 'general') return <FileText size={13} />;
  if (id === 'sync') return <Cloud size={13} />;
  if (id === 'reading') return <BookOpen size={13} />;
  return <Info size={13} />;
}

export default function SettingsDialog() {
  const open = useStore((s) => s.settings);
  const setOpen = useStore((s) => s.setSettings);
  const tab = useStore((s) => s.settingsTab);
  const setTab = useStore((s) => s.setSettingsTab);

  const cardRef = useRef<HTMLDivElement>(null);

  // Esc 关面板。跟抽屉那条一致：浮层就得能被 Esc 收掉
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  /*
   * 开面板时把焦点挪进卡片。
   * 不然焦点还留在左下角那颗齿轮上，键盘用户按 Tab 会跑到卡片**背后**去 ——
   * 而这层东西本该独占这一屏。
   */
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => cardRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const now = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <>
      {/* 遮罩自带「点一下就退出」的手势 —— 它跟标题栏那颗 × 说的是同一件事 */}
      <div
        data-settings-mask
        onClick={() => setOpen(false)}
        className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[2px]"
      />
      {/*
        ⚠️ 外面这层全屏容器必须是 `pointer-events-none`：
        它盖在整个界面上，若不透传点击，「点空白处退出」就只剩卡片四周那一圈窄边。
        穿透之后，卡片以外的每一次点击都落在遮罩上。
      */}
      <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4 md:p-6 max-md:p-0">
        <div
          ref={cardRef}
          data-settings-panel
          data-settings-tab={tab}
          role="dialog"
          aria-modal="true"
          aria-label="设置"
          tabIndex={-1}
          className="dialog-in pointer-events-auto flex h-[min(680px,88vh)] w-[min(980px,96vw)] overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop outline-none max-md:h-full max-md:w-full max-md:rounded-none max-md:border-0 max-md:flex-col"
        >
          {/*
            左列：分节导航。手机上转而横排（这一列赊进来就占掉三分之一张卡），
            两种排法共用同一批按钮，只是 flex 方向不同。
          */}
          <nav
            data-settings-nav
            aria-label="设置分节"
            className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-line bg-surface-2/70 px-2 py-2 md:w-[184px] md:flex-col md:overflow-visible md:border-b-0 md:border-r md:px-2.5 md:py-3"
          >
            <div className="hidden px-1.5 pb-2 pt-0.5 text-[13.5px] font-semibold tracking-[0.08em] md:block">
              设置
            </div>
            {TABS.map((t) => {
              const on = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  data-settings-nav-item={t.id}
                  data-on={on ? '1' : '0'}
                  aria-current={on ? 'page' : undefined}
                  onClick={() => setTab(t.id)}
                  title={t.hint}
                  className={`flex shrink-0 items-center gap-1.5 rounded-[8px] px-2 py-[6px] text-[12.5px] transition-colors md:w-full ${
                    on
                      ? 'bg-surface font-medium text-ink shadow-xs'
                      : 'text-ink-2 hover:bg-surface hover:text-ink'
                  }`}
                >
                  <IconOf id={t.id} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            {/* 抬头：这一节的名字 + 关闭。就这两样 —— 名字节名归nav管，这儿不重复标题 */}
            <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
              <span className="eyebrow">{now.label}</span>
              <span className="h-px min-w-2 flex-1 bg-line" />
              <button
                data-settings-close
                onClick={() => setOpen(false)}
                aria-label="关闭设置"
                title="关闭（Esc）"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink max-md:h-9 max-md:w-9"
              >
                <Close size={14} />
              </button>
            </header>

            <div data-settings-body className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5">
              {tab === 'general' && <General />}
              {tab === 'sync' && <Sync />}
              {tab === 'reading' && <Reading />}
              {tab === 'about' && <About />}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── 常规：仓库在哪 + 文件列表怎么列 ── */
function General() {
  const showAll = useStore((s) => s.showAll);
  const setShowAll = useStore((s) => s.setShowAll);
  const files = useStore((s) => s.files);
  const repo = useStore((s) => s.repo);
  const repoBusy = useStore((s) => s.repoBusy);
  const repoError = useStore((s) => s.repoError);
  const pickRepoDir = useStore((s) => s.pickRepoDir);
  const useDefaultRepo = useStore((s) => s.useDefaultRepo);
  const canPick = useStore((s) => s.canPick);

  const desktop = isTauri();
  const pickable = canPick();

  return (
    <Section
      title="存储"
      intro="笔记就是磁盘上真的一堆 .md，仓库是装它们的那个文件夹 —— 这是全页唯一一处「选错了要搬家」的设置。"
    >
      <div data-repo-card className="rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-[11.5px] text-ink-3">当前仓库</span>
          <span data-repo-where className="min-w-0 flex-1 break-all font-mono text-[11px] text-ink">
            {describeRef(repo)}
          </span>
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            data-repo-change
            disabled={repoBusy || !pickable}
            onClick={() => void pickRepoDir()}
            title={pickable ? '换一个文件夹' : '这个环境不支持授权文件夹'}
            className="inline-flex items-center gap-1 rounded-[8px] border border-line bg-surface px-2.5 py-[5px] text-[11.5px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
          >
            <FolderPlus size={11.5} />
            {repoBusy ? '正在打开…' : '换一个文件夹'}
          </button>
          {desktop && repo?.kind !== 'tauri' && (
            <button
              type="button"
              data-repo-back-default
              disabled={repoBusy}
              onClick={() => void useDefaultRepo()}
              className="inline-flex items-center gap-1 rounded-[8px] border border-line bg-surface px-2.5 py-[5px] text-[11.5px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-45"
            >
              换回程序自带的目录
            </button>
          )}
        </div>

        {!pickable && (
          <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
            这个浏览器不支持授权文件夹（Safari / Firefox 都不行）—— 要挑真目录得用桌面版。
          </p>
        )}

        {repo?.kind === 'memory' && (
          <p
            data-repo-warn
            className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn"
          >
            <Alert size={11.5} className="mt-[2px] shrink-0" />
            <span>
              现在只是<b className="font-medium">暂存</b>：笔记留在浏览器里，
              受配额限制，换台机器或清缓存就没了。
            </span>
          </p>
        )}

        {repoError && (
          <p data-repo-error className="mt-2 text-[11px] leading-relaxed text-warn">
            {repoError}
          </p>
        )}
      </div>

      <Hint>
        换仓库不会搬动旧文件夹里的东西，但新仓库里有什么、左边就列什么 ——
        换之前可以先在旧仓库里同步一次，换回来也一样。
      </Hint>

      <div className="mt-4">
        <h3 className="text-[12.5px] font-medium text-ink">文件列表</h3>
        <p className="mb-3 mt-1 text-[11.5px] leading-relaxed text-ink-3">
          左边那一列按目录排下来，这里只有一个开关 —— 列表该不该把程序文件也列出来。
        </p>
        <Toggle
          id="showall"
          label="显示全部文件"
          hint="连脚本、配置这些程序文件一起列出来（只影响显示，同步照旧按它们的个头走）"
          on={showAll}
          onChange={setShowAll}
        />
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-[9px] border border-line bg-surface-2 px-3 py-2.5 text-[11.5px]">
          <dt className="text-ink-3">本机文件</dt>
          <dd className="text-ink-2">{Object.keys(files).length} 个</dd>
        </dl>
      </div>

      <Hint>
        仓库里的东西<b className="font-medium text-ink-2">不会自己上去</b>
        —— 只有你按了同步才往远端那一趟走。
      </Hint>
    </Section>
  );
}

/*
 * ── 规则编辑器 ──
 * 推送范围是用**手写的一行行字符串**表示的（见 lib/scope.ts），所以界面要做的
 * 是让人看得见自己写了什么：一条规则一枚 chip，点 × 就删，输入框回车就加。
 * ⚠️ 不做下拉选择：目录名是用户自己的，猜不出来，给个输入框比给十个选项有用。
 */
function RuleList({
  id,
  label,
  hint,
  values,
  onChange,
  placeholder,
  presets,
}: {
  id: string;
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  presets?: string[];
}) {
  const [draft, setDraft] = useState('');

  const add = (raw: string) => {
    /*
     * 逗号分隔也认 —— 一次贴进来好几条是很常见的。
     * ⚠️ 必须**先攒齐再一次 onChange**：`values` 是这一轮闭包里的旧数组，
     * 循环里调两次 `onChange([...values, v])` 的话第二条会把第一条顶掉
     * （实测：输入 `a.md, b.md` 只剩 b.md）。
     */
    const next = [...values];
    for (const part of raw.split(',')) {
      const v = part.trim();
      if (!v || next.includes(v)) continue;
      next.push(v);
    }
    if (next.length !== values.length) onChange(next);
    setDraft('');
  };

  return (
    <div data-rules={id} className="mt-2.5">
      <div className="text-[12px] text-ink">{label}</div>
      {hint && <div className="mt-[1px] text-[11px] leading-snug text-ink-3">{hint}</div>}

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            data-rule={v}
            className="flex max-w-full items-center gap-1 rounded-full border border-line bg-surface-2 py-[3px] pl-2 pr-1"
          >
            <span className="min-w-0 truncate font-mono text-[11px] text-ink">{v}</span>
            <button
              type="button"
              data-rule-del={v}
              title={`去掉 ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <Close size={9} strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <input
          data-rule-input={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault(); // 挡住默认动作，否则它会去提交这一屏
            add(draft);
          }}
          onBlur={() => draft.trim() && add(draft)}
          placeholder={placeholder}
          className="min-w-[120px] flex-1 rounded-full border border-line bg-surface-2 px-2.5 py-[3px] font-mono text-[11px] text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-3 focus:border-accent focus:bg-surface"
        />
      </div>

      {presets && presets.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              data-rule-preset={p}
              disabled={values.includes(p)}
              onClick={() => add(p)}
              className="rounded-full border border-dashed border-line-2 px-2 py-[2px] font-mono text-[10.5px] text-ink-3 transition-colors hover:border-accent-line hover:text-ink-2 disabled:opacity-40 disabled:pointer-events-none"
            >
              + {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 推送：选后端 → 填凭据 → 定范围与定时 → 就地推送 ── */
function Sync() {
  const provider = useStore((s) => s.provider);
  const setProvider = useStore((s) => s.setProvider);
  const dav = useStore((s) => s.dav);
  const setDav = useStore((s) => s.setDav);
  const od = useStore((s) => s.od);
  const setOd = useStore((s) => s.setOd);
  const token = useStore((s) => s.token);
  const setToken = useStore((s) => s.setToken);
  const busy = useStore((s) => s.busy);
  const doPush = useStore((s) => s.doPush);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const changes = useStore((s) => s.changes);
  const scope = useStore((s) => s.scope);
  const setScope = useStore((s) => s.setScope);
  const autoPush = useStore((s) => s.autoPush);
  const autoPushMin = useStore((s) => s.autoPushMin);
  const setAutoPush = useStore((s) => s.setAutoPush);
  const probe = useStore((s) => s.remoteProbe);
  const probeRemote = useStore((s) => s.probeRemote);

  const davReachable = hasDavTransport();
  const meta = PROVIDERS.find((p) => p.id === provider);

  /*
   * 凭据填了 ≠ 连得上，所以这里算的是「**有没有资格去连**」：
   * 坚果云在浏览器版即使填满了也连不通（没有 CORS），那种情况算没资格，
   * 于是按钮是禁用的、文案直接说"要用桌面端" —— 不给一个按了必然失败的按钮。
   */
  const credReady =
    provider === 'github'
      ? !!token
      : provider === 'nutstore'
        ? !!(dav.user && dav.pass) && davReachable
        : !!od.token;

  /** 连的是哪儿（一行字说清坐标） */
  const where =
    provider === 'github'
      ? `${OWNER}/${REPO} @ ${BRANCH}`
      : provider === 'nutstore'
        ? dav.url || '（还没填 WebDAV 地址）'
        : `OneDrive / ${od.basePath || '根目录'}`;
  const ghUrl = provider === 'github' ? `https://github.com/${OWNER}/${REPO}` : '';

  const verdict = !credReady
    ? provider === 'nutstore' && !davReachable
      ? '浏览器版连不上：坚果云的 WebDAV 不带 CORS 头，得用桌面端'
      : '还没连上 —— 先把上面的凭据填好'
    : probe.state === 'probing'
      ? '正在连…'
      : probe.state === 'ok'
        ? `已连上 · 远端 ${probe.count} 个文件${probe.at ? ` · ${probe.at} 试过` : ''}`
        : probe.state === 'error'
          ? `连不上：${probe.message ?? '未知原因'}`
          : '还没试过';

  /*
   * 能连了就去试一次 —— 打开这一屏就是为了看"现在到底通不通"，
   * 让人自己点一下才知道不通，等于没说。
   * ⚠️ 依赖里**不能有 token**（逐字写入会每个字符打一次远端）；
   * 只在"从不能连到能连"和换后端时各试一次。
   */
  useEffect(() => {
    if (!credReady) return;
    void probeRemote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credReady, provider]);

  return (
    <Section
      title="推送"
      intro="这一节决定东西存在哪儿、推哪些、多久推一次 —— 它是整页里唯一「选错了会换地方」的一组设置。"
    >
      {/*
        没做完的后端一律 disabled + 标「待接入」—— 给一个按了没反应的按钮，
        比不给更糟（用户会以为是自己填错了）。
      */}
      <div data-provider-list className="flex flex-wrap gap-1.5">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            data-provider={p.id}
            disabled={!p.ready}
            onClick={() => setProvider(p.id as ProviderId)}
            title={p.hint}
            className={`flex items-center gap-1 rounded-full border px-2.5 py-[4px] text-[12px] transition-colors ${
              provider === p.id
                ? 'border-accent-line bg-accent-soft font-medium text-accent'
                : 'border-line bg-surface-2 text-ink-2'
            } ${p.ready ? 'hover:text-ink' : 'cursor-not-allowed opacity-45'}`}
          >
            {p.label}
            {!p.ready && <span className="text-[10px] text-ink-3">待接入</span>}
          </button>
        ))}
      </div>

      {provider === 'github' && (
        <div className="mt-2.5 space-y-1.5">
          {/* 凭据跟着后端走：选了 GitHub，这里就是 GitHub 的 token */}
          <input
            data-token
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_… / github_pat_…"
            className="w-full rounded-[8px] border border-line bg-surface-2 px-2.5 py-[7px] font-mono text-[11.5px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent focus:bg-surface"
          />
          <p className="text-[11px] leading-relaxed text-ink-3">
            需要 fine-grained PAT，权限只给{' '}
            <span className="font-mono">
              {OWNER}/{REPO}
            </span>{' '}
            的 Contents 读写，分支 <span className="font-mono">{BRANCH}</span>。
            demo 阶段存在本机 localStorage，正式版会进系统凭据库。
          </p>
        </div>
      )}

      {provider === 'nutstore' && (
        <div className="mt-2.5 space-y-1.5">
          <input
            data-dav-url
            value={dav.url}
            onChange={(e) => setDav({ url: e.target.value })}
            placeholder="https://dav.jianguoyun.com/dav/QuitWriteRead"
            className="w-full rounded-[8px] border border-line bg-surface-2 px-2.5 py-[7px] font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:bg-surface"
          />
          <div className="flex gap-1.5">
            <input
              data-dav-user
              value={dav.user}
              onChange={(e) => setDav({ user: e.target.value })}
              placeholder="坚果云账号（邮箱）"
              className="min-w-0 flex-1 rounded-[8px] border border-line bg-surface-2 px-2.5 py-[7px] text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:bg-surface"
            />
            <input
              data-dav-pass
              type="password"
              value={dav.pass}
              onChange={(e) => setDav({ pass: e.target.value })}
              placeholder="应用密码"
              className="min-w-0 flex-1 rounded-[8px] border border-line bg-surface-2 px-2.5 py-[7px] text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:bg-surface"
            />
          </div>
          <p className="text-[11px] leading-relaxed text-ink-3">
            应用密码不是登录密码：坚果云 → 账户信息 → 安全选项 → 第三方应用管理里单独生成。
          </p>
          {!davReachable && (
            <p
              data-dav-warn
              className="rounded-[8px] border border-warn-line bg-warn-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-warn"
            >
              现在是网页版：坚果云的 WebDAV 不返回 CORS 头，浏览器直连一定被拦。
              凭据可以先把着，真正能同步要等桌面端（那里请求走原生，没有同源策略）。
            </p>
          )}
        </div>
      )}

      {provider === 'onedrive' && (
        <div className="mt-2.5 space-y-1.5">
          <p
            data-od-warn
            className="rounded-[8px] border border-line bg-surface-2 px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-2"
          >
            读写的代码已经就位（Microsoft Graph），缺的是<b className="font-medium">授权</b>：
            OAuth 要一个 Azure 应用的 client_id，得由账号主人去 Azure 门户注册（免费）。
            拿到之后走 PKCE 换 token，填进下面这个框就能用。
          </p>
          <input
            data-od-token
            type="password"
            value={od.token}
            onChange={(e) => setOd({ token: e.target.value })}
            placeholder="access token（留空 = 还没接上）"
            className="w-full rounded-[8px] border border-line bg-surface-2 px-2.5 py-[7px] font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:bg-surface"
          />
          <input
            data-od-base
            value={od.basePath}
            onChange={(e) => setOd({ basePath: e.target.value })}
            placeholder="库在 OneDrive 里的目录（留空 = 根目录）"
            className="w-full rounded-[8px] border border-line bg-surface-2 px-2.5 py-[7px] font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:bg-surface"
          />
        </div>
      )}

      {/*
        ── 连的是哪个仓库、通不通 ──
        以前这一屏只有"上次同步 XX:XX"，人看不出**连的到底是哪**、更看不出"其实没连上"。
        凭据填了 ≠ 连得上（token 过期、仓库改名、网盘路径写错、浏览器被 CORS 拦），
        所以这两件事在这里分开说，并且给一颗"试一下"让他当场验证。
      */}
      <div data-remote-status className="mt-3 border-t border-line pt-2.5">
        <div className="flex items-start gap-2">
          <span
            data-remote-dot={probe.state}
            className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${
              probe.state === 'ok'
                ? 'bg-ok'
                : probe.state === 'error'
                  ? 'bg-danger'
                  : probe.state === 'probing'
                    ? 'animate-pulse bg-ink-3'
                    : 'bg-line-2'
            }`}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-ink">远端仓库</div>
            <div data-remote-where className="mt-[1px] truncate font-mono text-[11px] text-ink-3">
              {where}
            </div>
            <div data-remote-verdict className="mt-[2px] text-[11px] leading-snug text-ink-3">
              {verdict}
            </div>
            {ghUrl && (
              <a
                data-remote-link
                href={ghUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-[11px] text-accent underline"
              >
                在 GitHub 上打开
              </a>
            )}
          </div>
          <button
            type="button"
            data-remote-probe
            disabled={probe.state === 'probing' || !credReady}
            title={credReady ? '真去远端列一次目录' : '先填好凭据'}
            onClick={() => void probeRemote()}
            className="inline-flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-surface-2 px-2 py-[5px] text-[11.5px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40 disabled:pointer-events-none"
          >
            <Refresh size={11.5} className={probe.state === 'probing' ? 'animate-spin' : ''} />
            {probe.state === 'probing' ? '正在连' : '试一下'}
          </button>
        </div>
      </div>

      {/*
        ── 推哪些 ──
        这是「不全量」的开关。话要说满：范围外的文件**同步层完全看不见**，
        取消勾选绝不等于删远端 —— 这条是整套设计里最容易让人误会的地方，
        不解释清楚用户不敢勾，或者勾错了以为文件没了。
      */}
      <div data-scope-box className="mt-3 border-t border-line pt-2.5">
        <div className="text-[12.5px] font-medium text-ink">推送范围</div>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
          只有范围内的文件参与比对。<b className="font-medium text-ink-2">范围外的文件同步这一层完全看不见</b>
          —— 不比对、不进清单、不会推、也绝不会因为「没勾它」而被当成删除推上去。
        </p>

        <RuleList
          id="include"
          label="推这些"
          hint="目录写 thoughts/，后缀写 *.md，单篇写 notes/a.md，** 是全推"
          values={scope.include}
          onChange={(include) => setScope({ ...scope, include })}
          placeholder="thoughts/"
          presets={['**', '*.md']}
        />
        <RuleList
          id="exclude"
          label="但不推这些"
          hint="写完整路径。单篇例外放这儿，它比上面那条更优先"
          values={scope.exclude}
          onChange={(exclude) => setScope({ ...scope, exclude })}
          placeholder="thoughts/私密.md"
        />
        <Hint>
          现在等于：<b className="font-medium text-ink-2">{describeScope(scope)}</b>
        </Hint>
      </div>

      {/*
        ── 多久推一次 ──
        ⚠️ 只在应用开着时：关了窗口就是一个普通网页，没有后台这一说（真要后台常驻
        得进 Tauri 起定时器 + 托盘，那是另一件事）。所以开关上就得写明白。
      */}
      <div data-autopush-box className="mt-3 border-t border-line pt-2.5">
        <Toggle
          id="autopush"
          label="定时推送"
          hint="应用开着的时候，每隔下面这段时间自动推一次（没有改动就不动）"
          on={autoPush}
          onChange={(v) => setAutoPush(v)}
        />
        {autoPush && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[5, 15, 30, 60, 120].map((m) => (
              <button
                key={m}
                type="button"
                data-autopush-min={m}
                data-on={autoPushMin === m ? '1' : '0'}
                onClick={() => setAutoPush(true, m)}
                className={`rounded-full border px-2.5 py-[3px] text-[11px] transition-colors ${
                  autoPushMin === m
                    ? 'border-accent-line bg-accent-soft font-medium text-accent'
                    : 'border-line bg-surface-2 text-ink-2 hover:text-ink'
                }`}
              >
                {m} 分钟
              </button>
            ))}
          </div>
        )}
      </div>

      {/*
        配完就地推送：选后端 → 填凭据 → 定范围，三步都在这一屏里，
        不用关掉面板再去找按钮（左下角 dock 上那颗一直在那儿）。
      */}
      <div className="mt-3 flex items-center gap-2 border-t border-line pt-2.5">
        <span data-sync-state className="min-w-0 flex-1 text-[11px] text-ink-3">
          {lastSyncAt ? `上次推送 ${lastSyncAt}` : '还没推送过'}
          {changes.length > 0 && ` · ${changes.length} 项差异待处理`}
        </span>
        <button
          data-sync-now
          onClick={() => void doPush()}
          disabled={busy !== null}
          className="inline-flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-surface-2 px-2.5 py-[5px] text-[11.5px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40 disabled:pointer-events-none"
        >
          <Refresh size={11.5} className={busy === 'sync' ? 'animate-spin' : ''} />
          {busy === 'sync' ? '推送中' : '立即推送'}
        </button>
      </div>

      {meta && <p className="mt-2 text-[10.5px] leading-relaxed text-ink-3">{meta.hint}</p>}
    </Section>
  );
}

/* ── 阅读：书的排版 ── */
function Reading() {
  const books = useStore((s) => s.books);

  return (
    <Section
      title="阅读"
      intro="看书那块的字体、字号、行距和纸色。这儿调出来的样子就是读的时候的样子 —— 下面这块预览跟正文走的是同一套 CSS，不是照着画的一张图。"
    >
      <ReaderStyleFields ns="set" preview />

      <div className="mt-4 border-t border-line pt-3">
        <Hint>
          书架上有 {books.length} 本书，存在本机的 IndexedDB 里，<b className="font-medium text-ink-2">不参与同步</b>
          （一本 epub 好几 MB，混进笔记那条链路只会拖慢每次比对）。排版偏好同样只在本机。
          读书时抬头那个「Aa」能随手调这几样，跟这里是一回事。
        </Hint>
      </div>
    </Section>
  );
}

/* ── 关于 ── */
function About() {
  return (
    <Section title="关于" intro="它读的是真的文件，这一点决定了后面所有事。">
      <div className="space-y-1.5 text-[11.5px] leading-relaxed text-ink-3">
        <p>
          QuitWriteRead 读的是<b className="font-medium text-ink-2">真的 markdown 文件</b>：
          笔记落盘成 <span className="font-mono">.md</span>，同步是拿这些文件去和远端对账，
          没有中间格式、也没有私有数据库。
        </p>
        <p>
          当前库：<span className="font-mono">{OWNER}/{REPO}</span>，分支{' '}
          <span className="font-mono">{BRANCH}</span>。demo 阶段凭据存在本机 localStorage。
        </p>
        <p>
          书（epub）是另一个世界：它有自己那份本地书架，不进上面这个库 ——
          所以删笔记不会动你的书，反过来也一样。
        </p>
      </div>
    </Section>
  );
}

/* ── 下面这些是排版的杂活 ── */

function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <div data-settings-section={title} className="max-w-[46rem]">
      <h2 className="font-serif text-[14.5px] font-semibold tracking-[0.04em] text-ink">{title}</h2>
      {intro && (
        <p className="mb-3.5 mt-1.5 text-[11.5px] leading-relaxed text-ink-3">{intro}</p>
      )}
      <div>{children}</div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[11px] leading-relaxed text-ink-3">{children}</p>;
}

function Toggle({
  id,
  label,
  hint,
  on,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-toggle={id}
      onClick={() => onChange(!on)}
      className="flex w-full items-start gap-3 rounded-[9px] text-left"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] text-ink">{label}</span>
        {hint && <span className="mt-[1px] block text-[11px] leading-snug text-ink-3">{hint}</span>}
      </span>
      <span
        className={`relative mt-[2px] h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-150 ${
          on ? 'bg-accent' : 'bg-line-2'
        }`}
      >
        <span
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-surface shadow-xs transition-[left] duration-150 ${
            on ? 'left-[16px]' : 'left-[2px]'
          }`}
        />
      </span>
    </button>
  );
}
