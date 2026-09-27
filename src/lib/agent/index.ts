/*
 * AI 助手的装配处 —— 把 vendored 的 nosie-agent-core 接到 QuitWriteRead 上。
 *
 * ## 三条装配原则（都是踩过才有的）
 *
 * ① **polyfill 必须在最前**：内核里有 `process` / `setImmediate` 这类 Node 全局，
 *    得在任何内核模块被求值之前挂上去，所以这一行不能挪到后面。
 * ② **不给它文件系统**：内置工具关掉、记忆关掉、技能关掉、MCP 不接。
 *    它能动的只有 `note-tools.ts` 里那几个，底下是 Repo —— 仓库内相对路径，出不去。
 * ③ **模型请求走可注入的 fetch**：桌面端可以把它换成 Rust 侧代理（绕开 CORS、
 *    护住 Key），浏览器端直连。这是当初选这个内核的一条主因。
 */
import './shims/polyfill';

import type { Agent } from './core/runtime/agent';
import { createAgent } from './core/runtime/agent';
import { InMemorySessionStore } from './core/session/index';
import type { PermissionResponse } from './core/types/permission';
import type { PermissionRequest } from './core/types/events';
import type { OpenAICompatibleOptions, Provider } from './core/types/provider';
import { createNoteTools } from './note-tools';
import { createBookTools } from './book-tools';

export type { Agent };
export type { PermissionRequest, PermissionResponse };
/*
 * 工具名单独放在 `tool-list.ts`（零依赖）—— 设置页要列这张表，
 * 不该为此把整个内核拉进设置那个 chunk。
 */
export { AGENT_TOOLS, canWriteFiles, countUsableTools, type AgentToolRow } from './tool-list';

export type NoteAgentOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  /**
   * 宿主自己造的 provider —— 演示模式就是它（`demo.ts` 里的 MockProvider）。
   * 给了它，上面那三个（baseURL / apiKey / model）就不看了。
   *
   * 之所以要留这个口子：内核的 `createProvider` 认的是「有没有 `stream()`」，
   * 传实例就原样用、传配置才去造 OpenAICompatible 那个。省了在内核里塞开关。
   */
  provider?: Provider;
  /** 桌面端把它换成 Rust 侧代理；不给就是浏览器直连（要端点放行 CORS） */
  fetch?: typeof fetch;
  /** 写操作来问宿主。不传 = 内核按"默认拒绝"处理（写工具一律拦下） */
  onPermission?: (req: PermissionRequest, signal: AbortSignal) => Promise<PermissionResponse> | PermissionResponse;
  /**
   * 准不准它写笔记。关掉时**写工具一个都不注册** ——
   * 模型连"有个 write_note"都不知道，也就不会浪费一轮去调它。
   */
  allowWrite?: boolean;
  maxSteps?: number;
};

/**
 * 助手必须一直看见的那几条规则。
 *
 * 走 `injectedPrompts` 而不是写进 system prompt，是因为这条通道**不进 transcript**：
 * 上下文压缩、裁剪、模型自己跑偏都动不了它 —— 内核里唯一能保证"每一步都看见"的路子。
 */
const HOUSE_RULES = [
  {
    id: 'paths',
    text: 'Paths are repo-relative with forward slashes (e.g. thoughts/walk.md). Never invent absolute paths or drive letters; get real ones with list_notes.',
  },
  {
    id: 'grounding',
    text: 'Answer only from what the tools actually returned. If notes do not contain the answer, say so plainly instead of guessing.',
  },
  {
    id: 'cite',
    text: 'When you mention a note, name its path so the reader can open it. When you quote a book, name the book and the chapter.',
  },
  {
    id: 'books',
    text: 'Books live on a separate shelf from notes: list_books first, then read_book by chapter number (1-based) or search_book. They are read-only — there is no tool to change them.',
  },
  {
    id: 'writing',
    text: 'Write only through write_note / append_note. They ask the reader first: if the call comes back rejected, say it was not written and never claim otherwise. Use append_note unless replacing the whole note is really what was asked.',
  },
];

export async function createNoteAgent(opts: NoteAgentOptions): Promise<Agent> {
  return createAgent({
    provider:
      opts.provider ??
      ({
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
        model: opts.model,
        // 桌面端代理 / 浏览器直连。见文件头③。
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      } satisfies OpenAICompatibleOptions),
    /*
     * 这两个值是"必填"的：内核默认 `process.cwd()` 与 `os.homedir()`，
     * 浏览器里没有它们（我们的 shim 故意给 '/' 这种一看就不对的值）。
     * 我们不用沙箱也不读家目录，但给个明确的值比留默认值好查。
     */
    workspaceRoot: '/repo',
    homeDir: '/repo',
    // 内置（fs/shell）工具一个都不注册 —— 见 note-tools.ts 文件头
    builtinTools: false,
    memory: { enabled: false },
    skills: { enabled: false },
    // 会话默认只放内存；要跨刷新留住，宿主换一个 store 进来（IndexedDB）
    session: { store: new InMemorySessionStore() },
    /*
     * 工具集 = 笔记（读的三个 + 写的两个）+ 书籍（只读的四个）。
     *
     * ⚠️ 写的两个只在 `allowWrite` 为真时才注册。不是"注册了再拦"，
     *    是从模型眼前就不存在 —— 它不会白白花一轮去调一个必定被拒的东西。
     */
    tools: [...createNoteTools({ allowWrite: opts.allowWrite !== false }), ...createBookTools()],
    permission: {
      mode: 'default',
      ...(opts.onPermission ? { onRequest: opts.onPermission } : {}),
    },
    injectedPrompts: HOUSE_RULES,
    maxSteps: opts.maxSteps ?? 12,
    /*
     * 长回答会被端点悄悄截断（吃过这个亏），所以显式给一个够大的上限；
     * 整棵树的预算另算：步数、token、墙钟时间三重。
     */
    maxTokens: 8192,
    budget: { maxSteps: 40, maxTokens: 400_000, maxWallClockMs: 3 * 60_000 },
    includeInstructions: false,
  });
}
