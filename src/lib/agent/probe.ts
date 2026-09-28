/*
 * 连通性自检：**点了就知道通不通，不通还知道为什么不通**。
 *
 * ## 为什么非得有它
 *
 * 「接一个模型」这件事的失败方式太多了：Key 错、Key 没充钱、地址敲错、
 * 型号写错、被限流、浏览器被 CORS 挡住、压根没网。它们落在界面上**全是同一句**
 * "发送失败" —— 人对着这句话只能一个一个试。所以这里把 HTTP 状态码和
 * 网络层异常分开翻译成人话，让失败自己说出原因。
 *
 * ## 为什么打 `/models` 而不是发一句聊天
 *
 *   ① 它便宜（不烧 token），可以随手点；
 *   ② 它是 OpenAI 兼容端点的**标准接口**，几家都认；
 *   ③ 拿回来的列表正好喂给型号下拉 —— 一次请求两件事。
 * 有的小厂没实现 `/models`，那种情况**不算连不上**：认 404，但降级成
 * "地址通了，只是它不报型号列表" —— 这时候照旧能用，只是型号得手填。
 */
/*
 * ⚠️ 这一层**零依赖**（连 store 都不 import）：
 * 它要能被 node 直接单测（`node tests/probe.test.mjs`），
 * 一旦 import 了 store 就会把 zustand / IndexedDB 一起拖进 node，跑不起来。
 */
export type ProbeInput = {
  baseURL: string;
  apiKey: string;
  model: string;
};

export type ProbeState = 'unknown' | 'probing' | 'ok' | 'error';

export type ProbeResult = {
  state: ProbeState;
  /** 说给人听的那句结论 */
  message: string;
  /** 端点报出来的型号。拿不到就是空 —— 那时候型号得手填，别假装拿到了 */
  models: string[];
  at: string | null;
};

export const PROBE_IDLE: ProbeResult = { state: 'unknown', message: '', models: [], at: null };

/** 超时。自检是"点一下就想知道"，等太久就没意义了 */
const TIMEOUT_MS = 12_000;

/**
 * 这个 Key 放进请求头发不发得出去。
 *
 * HTTP 头的值只认 **ISO-8859-1 那 256 个字符**。粘 Key 的时候手一抖带进来
 * 个中文逗号、全角冒号，浏览器连包都不发就在 `fetch()` 那一行抛 TypeError ——
 * 而那句类型错误长得跟「断网 / CORS 不让过」一模一样，不先认出来就会被翻成
 * "请求没到对面，要不换个桌面端试试"。**被人照着去做就白折腾了**，
 * 因为问题从头到尾只是那几个字放不进 HTTP 头。
 */
export function headerUnsafe(key: string): boolean {
  return /[^\u0000-\u00FF]/.test(key);
}

/**
 * 把一次失败翻译成一句人话。
 *
 * ⚠️ 要分开「对面不认」和「根本没到对面」：后者在浏览器里几乎总是 CORS 或断网，
 * 而 CORS 是**浏览器**拦的、换桌面端就能过。这句话必须说清楚，
 * 否则人会以为是自己 Key 填错了，在那儿换 Key 换一下午。
 */
export function explain(status: number, body: string): string {
  const hint = (() => {
    if (status === 401) return 'Key 不对（或者这把 Key 看不到这个资源）';
    if (status === 403) return 'Key 没有权限 —— 有的家要单独开通模型服务、有的要充钱';
    if (status === 404) return '地址不对 —— 多半是末尾少了 /v1，或者这家根本不是 OpenAI 兼容的';
    if (status === 422) return '端点收到了，但它不认这个型号';
    if (status === 429) return '被限流了（也可能是余额不够）';
    if (status >= 500) return '对面服务端出错了 —— 等一会儿再试';
    return '';
  })();
  const detail = body.trim().slice(0, 160);
  return hint ? `${hint}${detail ? `：${detail}` : ''}` : `连不上（HTTP ${status}）${detail ? `：${detail}` : ''}`;
}

export function explainNetError(e: unknown): string {
  if (e instanceof Error && e.name === 'AbortError') return '等太久了 —— 对面没在 12 秒内回应';
  const msg = e instanceof Error ? e.message : String(e);
  // 浏览器把 CORS 失败也报成 TypeError，跟断网混在一起。两种都是"请求没到对面"
  return `请求没到对面（${msg || '网络不通'}）—— 浏览器直连还要端点放行 CORS，放行不了就得用桌面端`;
}

/** `/models` 响应里把型号捞出来。各家字段名略有出入，只认 `data[].id` */
export function modelsOf(json: unknown): string[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const it of data) {
    const id = (it as { id?: unknown })?.id;
    if (typeof id === 'string' && id) out.push(id);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * 试一下。
 *
 * `fetch` 可注入（测试要 stub）。⛔ **永不抛** —— 失败也是个结论，
 * 抛出去只会让界面上那颗按钮一直转圈。
 */
export async function probeModel(
  cfg: ProbeInput,
  opts: { fetch?: typeof fetch } = {},
): Promise<ProbeResult> {
  const doFetch = opts.fetch ?? fetch;
  const base = cfg.baseURL.trim().replace(/\/+$/, '');
  const at = new Date().toISOString();
  const key = cfg.apiKey.trim();
  if (!base) return { state: 'error', message: '还没填接口地址', models: [], at };
  if (!key) return { state: 'error', message: '还没填 Key', models: [], at };
  // 这一条要排在发网络之前：它连请求都构造不出来，犯不上等那 12 秒
  if (headerUnsafe(key)) {
    return {
      state: 'error',
      message: 'Key 里有中文 / 全角这类字符 —— HTTP 头只放得下拉丁字符，多半是复制的时候多带了几个字',
      models: [],
      at,
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as unknown;
      const models = modelsOf(json);
      return {
        state: 'ok',
        message: models.length
          ? `连上了 · 端点报了 ${models.length} 个型号`
          : '连上了 —— 但这个端点没报型号列表，型号要自己填准',
        models,
        at,
      };
    }
    // 404：地址是通的，只是这家没有 /models —— 不算连不上
    if (res.status === 404) {
      return { state: 'ok', message: '地址通了，但它不提供型号列表 —— 型号自己填准就行', models: [], at };
    }
    const body = await res.text().catch(() => '');
    return { state: 'error', message: explain(res.status, body), models: [], at };
  } catch (e) {
    return { state: 'error', message: explainNetError(e), models: [], at };
  } finally {
    clearTimeout(timer);
  }
}
