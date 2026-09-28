import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { createNoteAgent } from '../lib/agent';
import type { Agent, PermissionRequest, PermissionResponse } from '../lib/agent';
import { createDemoProvider } from '../lib/agent/demo';
import { canWriteFiles } from '../lib/agent/tool-list';
import { shortHost } from '../lib/agent/providers';
import type { AgentEvent } from '../lib/agent/core/types/events';
import type { ToolCallStatus } from '../lib/agent/core/types/messages';
import { textOf } from '../lib/agent/core/types/messages';
import { Sparkle } from './icons';

/*
 * 助手面板 —— **把内核那串事件流画出来**，别的什么都不干。
 *
 * ## 它不管的三件事
 *
 *   ① **工具是什么** —— 在 `lib/agent/note-tools.ts` / `book-tools.ts` 里定死了；
 *   ② **能不能写** —— 权限门在内核，宿主只在下面那张卡上问一句；
 *   ③ **上下文怎么攒** —— 那是会话的事，这里只管显示。
 *
 * ## 它是**长在右栏里的一页**，不是浮层
 *
 *   它读的就是你正在写的这一篇，隔着一层遮罩问「这篇讲了什么」是自找别扭 ——
 *   人要能一边看着正文一边问。所以这里没有遮罩、没有自己的关闭按钮：
 *   进出由右栏那排签管，收起整栏由顶栏那颗按钮管（`RightPane` / `TopBar`）。
 *
 * ## 三条渲染上的硬规矩（都是事件流逼出来的）
 *
 *   ① `text_reset` = **清空**，不是出错。流断在半句上时内核会重发整条消息，
 *      只 append 的 reducer 会把同一句话显示两遍（events.md 里点名过这个坑）。
 *   ② 工具卡按 `toolCallId` 记，不按"当前那一个"。并行调用是交织着来的。
 *   ③ **换配置要重建 agent**：provider / 工具在 `createAgent` 那会儿就定死了，
 *      改了不重建，下一句用的还是老的。重建由 `gen` 触发，见下面那条注释。
 */

/** 一条要画出来的东西。按时间顺序平铺，文字和工具卡自然就交在一起了 */
type Item =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'text'; text: string }
  /*
   * ⚠️ `id` 是**界面自己的**序列，不能拿 `toolCallId` 当 React key：
   * 演示脚本第二轮会把同一个 toolCallId 再发一次（TurnCounter 归零），
   * 而 items 是累积的 → 两个 key 撞上。映射按 `callId`（toolCallId）查，
   * key 用 `id` —— 两件事分开，这是 events.md 里"按 toolCallId 追踪"的正解。
   */
  | {
      id: string;
      kind: 'tool';
      callId: string;
      name: string;
      title: string;
      status: ToolCallStatus;
      args: string;
      result?: string;
      error?: boolean;
      ms?: number;
    }
  | { id: string; kind: 'note'; text: string }
  /** 换配置的分隔线。它存在的理由见 `onSettingsClosed` 那条注释 */
  | { id: string; kind: 'divider'; text: string };

const STATUS_LABEL: Record<ToolCallStatus, string> = {
  pending: '待执行',
  awaiting_permission: '等你点头',
  running: '跑着',
  completed: '完成',
  failed: '失败',
  denied: '被拒',
  cancelled: '取消',
};

/** 内核给的权限选项是英文的（`PERMISSION_OPTIONS`），界面上翻一遍 */
const OPTION_LABEL: Record<string, string> = {
  allow_once: '就这一次',
  allow_always: '以后都行',
  reject_once: '这次不行',
  reject_always: '以后都不行',
};

let seq = 0;
const nextId = () => `i${++seq}`;

/**
 * 配置改动之后要**安静多久**才算改完。
 * 人是逐字敲 Key 的 —— 这个数太小就会一场配置重建几十次 agent。
 */
const SETTLE_MS = 600;

/**
 * 哪几项变了就**必须**重建 agent。
 * ⚠️ model 不在这里 —— 型号可以现场换（`agent.setModel`），历史照样留着。
 */
function keyOf(c: { demo: string; baseURL: string; apiKey: string; allowWrite: boolean }): string {
  return [c.demo, c.baseURL.trim(), c.apiKey.trim(), c.allowWrite ? 'w' : 'r'].join('|');
}

export default function ChatPane() {
  const cfg = useStore((s) => s.agent);
  const openSettings = useStore((s) => s.openSettings);

  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ tokens: number; requests: number } | null>(null);
  const [input, setInput] = useState('');
  const [perm, setPerm] = useState<PermissionRequest | null>(null);

  /** `gen` 加一 = 重建一次 agent（新对话 / 改完设置都走这条） */
  const [gen, setGen] = useState(0);

  const agentRef = useRef<Agent | null>(null);
  const runRef = useRef<{ abort: () => void } | null>(null);
  /** 正在流的那条文字。按 id 找它，别按"最后一条" —— 工具卡会插在它后面 */
  const textIdRef = useRef<string | null>(null);
  const permRef = useRef<{ resolve: (r: PermissionResponse) => void } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 手上这个 agent 是按哪套配置建的（含型号）。配置变了拿它比对，看要不要重建 */
  const builtRef = useRef<{ key: string; model: string } | null>(null);

  /*
   * 没接上模型 = 演示也没开、Key 也是空的。
   * 这种时候**不建 agent**，也不装作答复 —— 拿一个空 Key 去连只会拿到 401，
   * 而"它回了一句不知道从哪来的话"比"它明说自己没接上"糟得多。
   */
  const needsSetup = cfg.demo === 'off' && !cfg.apiKey.trim();
  /** 重建要看的那半截配置（型号不算 —— 它能现场换） */
  const cfgKey = keyOf(cfg);

  /*
   * 权限：**宿主回答，内核执行**。
   * 这里只做一件事 —— 把请求摊开给人看，把点到的那个选项回给内核。
   * ⛔ 不要在组件里自己判断"这个能不能放行"：那道门在内核里，写两遍迟早对不上。
   */
  const askPermission = useCallback(
    (req: PermissionRequest) =>
      new Promise<PermissionResponse>((resolve) => {
        permRef.current = { resolve };
        setPerm(req);
      }),
    [],
  );

  const answer = (optionId: PermissionResponse['optionId']) => {
    const p = permRef.current;
    if (!p) return;
    permRef.current = null;
    setPerm(null);
    p.resolve({ optionId });
  };

  useEffect(() => {
    let alive = true;
    setReady(false);
    setFatal(null);
    void (async () => {
      const c = useStore.getState().agent;
      builtRef.current = { key: keyOf(c), model: c.model.trim() };
      if (c.demo === 'off' && !c.apiKey.trim()) {
        // 没接上：就这么耗着不建，界面上那块「去设置」会说明为什么
        if (alive) setReady(false);
        return;
      }
      try {
        const demo = c.demo !== 'off';
        const agent = await createNoteAgent({
          baseURL: c.baseURL,
          apiKey: c.apiKey,
          model: c.model,
          ...(demo ? { provider: createDemoProvider(c.demo === 'write' ? 'write' : 'read') } : {}),
          /*
           * 写权限只有**一个判定的地方**（`tool-list.canWriteFiles`）——
           * 设置页那句"它现在能用 N 个工具"是同一个函数算出来的，
           * 两边各写一份迟早对不上，而对不上就是在骗人。
           */
          allowWrite: canWriteFiles(c),
          onPermission: askPermission,
        });
        if (!alive) {
          void agent.dispose();
          return;
        }
        agentRef.current = agent;
        setReady(true);
      } catch (e) {
        if (alive) setFatal(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      runRef.current?.abort();
      runRef.current = null;
      void agentRef.current?.dispose();
      agentRef.current = null;
    };
    // ⚠️ 依赖里**不放 cfg**：那是个对象，每次渲染都是新的，带进来会一直重建 agent。
    // 配置变了靠 `gen` 推（见下面那条防抖）。
  }, [gen, askPermission]);

  /*
   * 改完设置 → **等它落定**再看该重建还是该换型号。
   *
   * 为什么要等（`SETTLE_MS`）：人是**一个字一个字**敲 Key 的，
   * 敲到第 3 个字母就重建一次的话，配一场要起几十个 agent。
   * 等 600ms 没动静了才算改完 —— 打字中间那几十次变化，一次都不算。
   *
   * 两档后果：
   *   · 地址 / Key / 演示 / 写权限变了 → **重建**（provider 和工具是建实例那会儿装死的）；
   *   · 只改了型号 → **现场换**（内核有 `setModel`，历史原样留着，聊到一半不会断）。
   *
   * ⚠️ 重建 = 换了一个新的 Agent，它的历史是空的。屏幕上那段留着（人还想看），
   *    但必须画一条线告诉人"上面那些它已经不记得了"，否则就是拿旧记录装新记性。
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      const cur = useStore.getState().agent;
      const key = keyOf(cur);
      const model = cur.model.trim();
      const prev = builtRef.current;
      if (!prev) return; // 一次都还没建起来 —— 那是首次装配，不算"改配置"
      if (prev.key !== key) {
        setItems((p) =>
          p.length
            ? [...p, { id: nextId(), kind: 'divider', text: '配置改了 —— 下面是新的一条线，上面那段它不记得了' }]
            : p,
        );
        setGen((g) => g + 1);
        return;
      }
      if (!model || model === prev.model) return;
      const a = agentRef.current;
      if (!a || a.model === model) return;
      try {
        a.setModel(model);
        builtRef.current = { key, model };
      } catch {
        /* 型号不合法就维持原来的 —— 真发请求时端点会自己报错，那时候说得清 */
      }
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [cfgKey, cfg.model]);

  // 有新东西就贴到底。聊天就该跟着最新的那句走
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, busy, perm]);

  /** 事件 → 界面。抄的是 docs/events.md 里那份 reducer，补了 tool 卡与错误 */
  const reduce = (ev: AgentEvent) => {
    switch (ev.type) {
      case 'text_start': {
        const id = nextId();
        textIdRef.current = id;
        setItems((p) => [...p, { id, kind: 'text', text: '' }]);
        break;
      }
      case 'text_delta': {
        let id = textIdRef.current;
        if (!id) {
          // 防御：万一没等到 `text_start`（换 provider / 老版本内核）就先收到 delta
          const fresh = nextId();
          id = fresh;
          textIdRef.current = fresh;
          setItems((p) => [...p, { id: fresh, kind: 'text', text: '' }]);
        }
        const at: string = id;
        setItems((p) => p.map((i) => (i.id === at && i.kind === 'text' ? { ...i, text: i.text + ev.delta } : i)));
        break;
      }
      // 流断在半句上，内核会整条重发 —— 这里必须**清空**，append 会显示两遍
      case 'text_reset': {
        const at = textIdRef.current;
        if (at) setItems((p) => p.map((i) => (i.id === at && i.kind === 'text' ? { ...i, text: '' } : i)));
        break;
      }
      case 'text_end': {
        const at = textIdRef.current;
        textIdRef.current = null;
        if (!at) break;
        // `text_end.text` 是权威的那份（deltas 只是给渲染用的快车道），所以这里整段覆盖
        const id: string = at;
        setItems((p) => p.map((i) => (i.id === id && i.kind === 'text' ? { ...i, text: ev.text } : i)));
        break;
      }
      case 'tool_call_ready':
        setItems((p) => [
          ...p,
          {
            id: nextId(),
            kind: 'tool',
            callId: ev.toolCallId,
            name: ev.name,
            title: ev.title,
            status: 'pending',
            args: JSON.stringify(ev.args),
          },
        ]);
        break;
      case 'tool_status':
        setItems((p) =>
          p.map((i) => (i.kind === 'tool' && i.callId === ev.toolCallId ? { ...i, status: ev.status } : i)),
        );
        break;
      case 'tool_result':
        setItems((p) =>
          p.map((i) =>
            i.kind === 'tool' && i.callId === ev.toolCallId
              ? {
                  ...i,
                  status: ev.isError ? 'failed' : 'completed',
                  result: textOf(ev.content),
                  error: ev.isError,
                  ms: ev.durationMs,
                }
              : i,
          ),
        );
        break;
      case 'usage':
        setUsage({ tokens: ev.cumulative.totalTokens, requests: ev.cumulative.requests });
        break;
      case 'warning':
        setItems((p) => [...p, { id: nextId(), kind: 'note', text: ev.message }]);
        break;
      case 'error':
        setItems((p) => [...p, { id: nextId(), kind: 'note', text: ev.error.message }]);
        break;
      default:
        break;
    }
  };

  const send = async () => {
    const text = input.trim();
    const agent = agentRef.current;
    if (!text || !agent || busy) return;
    setInput('');
    textIdRef.current = null;
    setItems((p) => [...p, { id: nextId(), kind: 'user', text }]);
    setBusy(true);
    try {
      const handle = agent.run(text);
      runRef.current = handle;
      for await (const ev of handle) reduce(ev);
      runRef.current = null;
    } catch (e) {
      setItems((p) => [...p, { id: nextId(), kind: 'note', text: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    runRef.current?.abort();
    runRef.current = null;
  };

  // 跟设置页那条清单同一个函数算出来的 —— 空态这句话不能跟那里说两套
  const canWrite = canWriteFiles(cfg);

  const greeting = needsSetup
    ? '还没接上模型'
    : cfg.demo === 'write'
      ? '演示「写」：它会往 agent/演示-<今天>.md 追加一段，中途一定先问你一句。'
      : cfg.demo === 'read'
        ? '演示「读」：不连模型，但它会真的去读你的仓库（list_notes → read_note）。'
        : `${cfg.model} @ ${shortHost(cfg.baseURL)}${cfg.allowWrite ? ' · 能写（每次都会先问）' : ' · 只读'}`;

  return (
    <div data-agent-pane className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
        <Sparkle size={12} className={`shrink-0 ${needsSetup ? 'text-ink-3' : 'text-accent'}`} />
        <span data-agent-mode className="min-w-0 flex-1 truncate text-[11px] text-ink-3" title={greeting}>
          {greeting}
        </span>
        <button
          type="button"
          data-agent-new
          title="开一段新的（旧的这段就忘了）"
          onClick={() => {
            setItems([]);
            setUsage(null);
            setGen((g) => g + 1);
          }}
          className="shrink-0 rounded-[7px] border border-line bg-surface-2 px-2 py-[4px] text-[11px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
        >
          新对话
        </button>
      </header>

      <div ref={scrollRef} data-agent-log className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {/*
          没接上模型：**明说**。以前默认走演示脚本，人问什么它都照脚本答一句，
          答的还是错的（"仓库里一篇笔记都没有"）—— 那才是"完全不可用"的根子。
          现在没配就是没配，一句话也不编。
        */}
        {needsSetup ? (
          <div data-agent-setup className="rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
            <p className="text-[12px] text-ink">还没接上模型</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
              填一个接口地址 + Key，它才开始真的读你的笔记和书架上的书。
              没填之前它不会装作答复 —— 宁可一句话不说，也不该编。
            </p>
            <button
              type="button"
              data-agent-goset
              onClick={() => openSettings('agent')}
              className="mt-2 rounded-[8px] border border-accent-line bg-accent-soft px-2.5 py-[5px] text-[11.5px] font-medium text-accent transition-colors hover:bg-accent hover:text-white"
            >
              去设置里接一个
            </button>
          </div>
        ) : (
          items.length === 0 && (
            <div className="px-1 py-6 text-center">
              <p className="text-[12.5px] text-ink-2">问一句跟你的笔记有关的事。</p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
                笔记能列、能读、能搜
                {canWrite ? '，也能写（写之前一定先问你）' : ' —— 写工具现在是关的'}
                ；书架上的书能列出、读某一章、书内搜、读你的批注。
                {!canWrite && <br />}
                {!canWrite && '不开写权限的话，它能说的全是"真的看到了什么"。'}
              </p>
            </div>
          )
        )}

        <div className="space-y-2.5">
          {items.map((it) => {
            if (it.kind === 'user') {
              return (
                <div key={it.id} className="flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-[10px] rounded-br-[3px] bg-accent-soft px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink">
                    {it.text}
                  </p>
                </div>
              );
            }
            if (it.kind === 'divider') {
              return (
                <div key={it.id} data-agent-divider className="flex items-center gap-2 py-1">
                  <span className="h-px flex-1 bg-line" />
                  <span className="shrink-0 text-[10.5px] text-ink-3">{it.text}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              );
            }
            if (it.kind === 'text') {
              return (
                <p
                  key={it.id}
                  data-agent-text
                  className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink"
                >
                  {it.text}
                  {busy && <span className="ml-[1px] inline-block h-[13px] w-[6px] animate-pulse bg-ink-3 align-[-2px]" />}
                </p>
              );
            }
            if (it.kind === 'note') {
              return (
                <p key={it.id} data-agent-note className="text-[11.5px] leading-relaxed text-danger">
                  {it.text}
                </p>
              );
            }
            return (
              <div
                key={it.id}
                data-agent-tool={it.name}
                data-agent-status={it.status}
                className="overflow-hidden rounded-[9px] border border-line bg-surface-2/60"
              >
                <div className="flex items-center gap-2 px-2.5 py-[6px]">
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-2">{it.title || it.name}</span>
                  <span
                    data-agent-badge
                    className={`shrink-0 rounded-full px-1.5 py-[1px] text-[10px] ${
                      it.status === 'failed'
                        ? 'bg-danger-soft text-danger'
                        : it.status === 'completed'
                          ? 'bg-surface-3 text-ink-3'
                          : 'bg-accent-soft text-accent'
                    }`}
                  >
                    {STATUS_LABEL[it.status]}
                    {it.ms !== undefined ? ` · ${it.ms}ms` : ''}
                  </span>
                </div>
                {it.result !== undefined && (
                  <pre
                    data-agent-result
                    className={`max-h-[150px] overflow-auto border-t border-line px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed ${
                      it.error ? 'text-danger' : 'text-ink-3'
                    }`}
                  >
                    {it.result}
                  </pre>
                )}
              </div>
            );
          })}
        </div>

        {/*
          权限卡。写工具关着的时候它不会出现 ——
          留着是因为"开写权限"那天它必须立刻能接上，而那时再写就来不及验了。
        */}
        {perm && (
          <div data-agent-perm data-agent-perm-tool={perm.name} className="mt-3 rounded-[10px] border border-accent-line bg-accent-soft px-3 py-2.5">
            <p className="text-[12px] text-ink">要动这一步：{perm.title || perm.name}</p>
            <p className="mt-1 font-mono text-[10.5px] text-ink-3">{JSON.stringify(perm.args)}</p>
            <div className="mt-2 flex gap-1.5">
              {perm.options.map((o) => (
                <button
                  key={o.optionId}
                  type="button"
                  data-agent-perm-opt={o.optionId}
                  onClick={() => answer(o.optionId)}
                  className="rounded-[7px] border border-line bg-surface px-2 py-[4px] text-[11px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  {OPTION_LABEL[o.optionId] ?? o.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {fatal && (
        <p data-agent-fatal className="shrink-0 border-t border-line px-3 py-2 text-[11.5px] text-danger">
          起不来：{fatal}
        </p>
      )}

      <footer className="shrink-0 border-t border-line px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            data-agent-input
            value={input}
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              needsSetup ? '接上模型之后才能问' : ready ? '问一句（Enter 发送，Shift+Enter 换行）' : '正在起…'
            }
            disabled={!ready}
            className="min-h-[42px] flex-1 resize-none rounded-[9px] border border-line bg-surface-2 px-2.5 py-[7px] text-[12.5px] leading-snug text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent focus:bg-surface disabled:opacity-50"
          />
          {busy ? (
            <button
              type="button"
              data-agent-stop
              onClick={stop}
              className="shrink-0 rounded-[9px] border border-line bg-surface-2 px-2.5 py-[7px] text-[12px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              停下
            </button>
          ) : (
            <button
              type="button"
              data-agent-send
              disabled={!ready || !input.trim()}
              onClick={() => void send()}
              className="shrink-0 rounded-[9px] border border-accent-line bg-accent-soft px-2.5 py-[7px] text-[12px] font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-40 disabled:pointer-events-none"
            >
              发送
            </button>
          )}
        </div>
        <p data-agent-usage className="mt-1 text-[10.5px] text-ink-3">
          {usage ? `${usage.tokens} tokens · ${usage.requests} 次请求` : '这一步花的钱会记在这儿'}
        </p>
      </footer>
    </div>
  );
}
