import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { createNoteAgent } from '../lib/agent';
import type { Agent, PermissionRequest, PermissionResponse } from '../lib/agent';
import { createDemoProvider } from '../lib/agent/demo';
import type { AgentEvent } from '../lib/agent/core/types/events';
import type { ToolCallStatus } from '../lib/agent/core/types/messages';
import { textOf } from '../lib/agent/core/types/messages';
import { Close, Sparkle } from './icons';

/*
 * 助手面板：**把内核那串事件流画出来**，别的什么都不干。
 *
 * ## 它不管的三件事
 *
 *   ① **工具是什么** —— 三个只读工具在 `lib/agent/note-tools.ts` 里定死了；
 *   ② **能不能写** —— 权限门在内核，宿主只在下面这张卡上问一句（目前没有写工具，
 *      卡就不会出现；留着是因为加了写工具之后它必须立刻能用）；
 *   ③ **上下文怎么攒** —— 那是会话的事，这里只管显示。
 *
 * ## 三条渲染上的硬规矩（都是事件流逼出来的）
 *
 *   ① `text_reset` = **清空**，不是出错。流断在半句上时内核会重发整条消息，
 *      只 append 的 reducer 会把同一句话显示两遍（events.md 里点名过这个坑）。
 *   ② 工具卡按 `toolCallId` 记，不按"当前那一个"。并行调用是交织着来的。
 *   ③ **换配置要重建 agent**：provider / model 在建实例时就定死了，
 *      改了设置不重建，下一句用的还是老的。所以「新对话」和「改完设置」
 *      走的是同一条路 —— `gen` 加一，effect 重跑，旧的先 dispose。
 */

/** 一条要画出来的东西。按时间顺序平铺，文字和工具卡自然就交在一起了 */
type Item =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'tool'; name: string; title: string; status: ToolCallStatus; args: string; result?: string; error?: boolean; ms?: number }
  | { id: string; kind: 'note'; text: string };

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

export default function ChatPane() {
  const open = useStore((s) => s.agentPane);
  const setOpen = useStore((s) => s.setAgentPane);
  const cfg = useStore((s) => s.agent);

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
    if (!open) return;
    let alive = true;
    setReady(false);
    setFatal(null);
    void (async () => {
      try {
        const c = useStore.getState().agent;
        const agent = await createNoteAgent({
          baseURL: c.baseURL,
          apiKey: c.apiKey,
          model: c.model,
          ...(c.demo ? { provider: createDemoProvider() } : {}),
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
    // 改完设置在 ChatPane 关掉时生效（面板是条件挂载的，关一次就重来）。
  }, [open, gen, askPermission]);

  // 有新东西就贴到底。聊天就该跟着最新的那句走
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, busy, perm]);

  if (!open) return null;

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
            id: ev.toolCallId,
            kind: 'tool',
            name: ev.name,
            title: ev.title,
            status: 'pending',
            args: JSON.stringify(ev.args),
          },
        ]);
        break;
      case 'tool_status':
        setItems((p) =>
          p.map((i) => (i.id === ev.toolCallId && i.kind === 'tool' ? { ...i, status: ev.status } : i)),
        );
        break;
      case 'tool_result':
        setItems((p) =>
          p.map((i) =>
            i.id === ev.toolCallId && i.kind === 'tool'
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

  const greeting = cfg.demo
    ? '演示模式：不连模型，但它会真的去读你的仓库（list_notes → read_note）。'
    : cfg.apiKey
      ? `已配 ${cfg.model} @ ${cfg.baseURL}`
      : '还没填 Key —— 去设置里填，或者把「演示模式」打开。';

  return (
    <>
      <div data-agent-mask onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[2px]" />
      <div
        data-agent-pane
        role="dialog"
        aria-label="AI 助手"
        className="fixed left-1/2 top-1/2 z-50 flex h-[min(680px,86vh)] w-[min(620px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
          <Sparkle size={14} className="shrink-0 text-accent" />
          <span className="eyebrow shrink-0">AI 助手</span>
          <span data-agent-mode className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
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
          <button
            type="button"
            data-agent-close
            title="关闭（Esc）"
            onClick={() => setOpen(false)}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Close size={14} />
          </button>
        </header>

        <div ref={scrollRef} data-agent-log className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {items.length === 0 && (
            <div className="px-1 py-8 text-center">
              <p className="text-[12.5px] text-ink-2">问一句跟你的笔记有关的事。</p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
                它能用的只有三个只读工具：列出笔记、读一篇、全文搜一段。
                <br />
                <span className="font-mono">写</span>它干不了 —— 内核那边没给它写工具。
              </p>
            </div>
          )}

          <div className="space-y-2.5">
            {items.map((it) => {
              if (it.kind === 'user') {
                return (
                  <div key={it.id} className="flex justify-end">
                    <p className="max-w-[80%] whitespace-pre-wrap rounded-[10px] rounded-br-[3px] bg-accent-soft px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink">
                      {it.text}
                    </p>
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
            权限卡。目前三个工具都是只读的，它**不会真的出现** ——
            留着是因为"加写工具"那天它必须立刻能接上，而那时再写就来不及验了。
          */}
          {perm && (
            <div data-agent-perm className="mt-3 rounded-[10px] border border-accent-line bg-accent-soft px-3 py-2.5">
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
          <p data-agent-fatal className="shrink-0 border-t border-line px-4 py-2 text-[11.5px] text-danger">
            起不来：{fatal}
          </p>
        )}

        <footer className="shrink-0 border-t border-line px-3 py-2.5">
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
              placeholder={ready ? '问一句（Enter 发送，Shift+Enter 换行）' : '正在起…'}
              disabled={!ready}
              className="min-h-[42px] flex-1 resize-none rounded-[9px] border border-line bg-surface-2 px-2.5 py-[7px] text-[12.5px] leading-snug text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent focus:bg-surface disabled:opacity-50"
            />
            {busy ? (
              <button
                type="button"
                data-agent-stop
                onClick={stop}
                className="shrink-0 rounded-[9px] border border-line bg-surface-2 px-3 py-[7px] text-[12px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
              >
                停下
              </button>
            ) : (
              <button
                type="button"
                data-agent-send
                disabled={!ready || !input.trim()}
                onClick={() => void send()}
                className="shrink-0 rounded-[9px] border border-accent-line bg-accent-soft px-3 py-[7px] text-[12px] font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-40 disabled:pointer-events-none"
              >
                发送
              </button>
            )}
          </div>
          <p data-agent-usage className="mt-1.5 text-[10.5px] text-ink-3">
            {usage
              ? `${usage.tokens} tokens · ${usage.requests} 次请求`
              : '这一步花的钱会记在这儿'}
          </p>
        </footer>
      </div>
    </>
  );
}
