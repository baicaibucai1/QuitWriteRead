/*
 * 两份文本的行级差异（git 那种 unified 视图用的）。
 *
 * ## 为什么自己写
 *
 * 只需要一个能力：把「本机这一版」和「云端那一版」摊开给人看，让他选一边。
 * 引一个 diff 库（几十 KB、还带着它自己的配置项）就为这个不划算 ——
 * 而且它是**纯函数、零依赖**，能跟 decide.ts / scope.ts 一样直接跑单测。
 *
 * ## 算法
 *
 * 最长公共子序列（LCS），动态规划。O(n×m)。
 * 笔记是几百行量级，10⁵ 次比较在毫秒级；但**不设上限会出事** ——
 * 有人拿一篇两万行的导出文件来比对就是 4×10⁸，界面会当场冻住。
 * 所以超过 MAX_LINES 就退化成"整块替换"（此时精确的行级差异已经没人看得过来了，
 * 展示成"这两版完全不同"反而更诚实）。
 */

export type DiffLine = {
  /** same = 两边都有；del = 本机有、云端没了；add = 云端有、本机没有 */
  kind: 'same' | 'del' | 'add';
  text: string;
};

/** 超过这个行数就退化为整块替换（见上面那段） */
const MAX_LINES = 2000;

function lcsMatrix(a: string[], b: string[]): Uint32Array {
  const n = a.length;
  const m = b.length;
  // (n+1) × (m+1)。Uint32Array 比 number[][] 省一个数量级的内存
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i] === b[j]
          ? dp[(i + 1) * (m + 1) + (j + 1)] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + (j + 1)]);
    }
  }
  return dp;
}

/**
 * 比对两份**文本**。返回一串带增删标记的行 —— 界面照着它画就行。
 *
 * ⚠️ 空行也算一行：markdown 里空行是段落分隔，把它当噪音滤掉会让
 * 「只多了一个空段」这种改动看起来像没改。
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ];
  }

  const m = b.length;
  const dp = lcsMatrix(a, b);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + (j + 1)]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'del', text: a[i] });
  for (; j < b.length; j++) out.push({ kind: 'add', text: b[j] });
  return out;
}

/** 给界面的一句话摘要（「+3 −1」） */
export function diffSummary(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

/**
 * 折叠没动过的长段落：只留前后各 `context` 行，中间用一条"⋯ 跳过 N 行"代替。
 *
 * 为什么必须折叠：一篇两千行的笔记里改了一行，全量摊开的话人得滚半天才找得到 ——
 * 而**找不着就等于没给**。git 的 unified diff 也是这么干的。
 */
export function collapseUnchanged(lines: DiffLine[], context = 2): (DiffLine | { kind: 'skip'; count: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === 'same') continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  }

  const out: (DiffLine | { kind: 'skip'; count: number })[] = [];
  let run = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (run) {
        out.push({ kind: 'skip', count: run });
        run = 0;
      }
      out.push(lines[i]);
    } else {
      run++;
    }
  }
  if (run) out.push({ kind: 'skip', count: run });
  return out;
}
