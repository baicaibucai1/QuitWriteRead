/*
 * 推送范围：哪些文件参与同步。
 *
 * ## 为什么要有这一层
 *
 * 之前是**全量**：`planSync` 拿「本地 ∪ 快照 ∪ 远端」的全部路径做三路判定。
 * 全量不是懒，是被判定表逼的 —— 「本地没有 + 快照有 + 远端没动」会被判成"你删了它"，
 * 本地文件列表一旦不完整（只同步了一部分），这条判定就会把远端成片删掉。
 *
 * 但"全量"意味着用户没有选择权：想只把 `thoughts/` 推上去做备份、把草稿留在本地，
 * 做不到。所以改成**先圈范围，再判定**：
 *
 *   **范围外的文件，同步这一层完全看不见它** —— 不比对、不进清单、不写快照、
 *   永远不会因为"范围外"而产生任何远端删除。
 *
 * ## 为什么这样就不会再误删
 *
 * 误删的唯一来源是 `push-del` 这条判定。它现在要同时满足：
 *   ① 在范围内（否则压根不进判定）
 *   ② 快照里有过它（说明上次同步时它在）
 *   ③ 本地现在没有
 *   ④ 远端没动过
 * 把一篇从范围内划出去，只影响 ①，后面三条一个都不碰 —— 于是它安静地留在远端。
 * ⚠️ 反过来想一遍：如果把"范围外"实现成"判定时假装本地没这个文件"，
 *   那取消勾选一篇就等于宣布"我删了它"，推一次就没了。这就是不能那么写的原因。
 *
 * ## 规则怎么写
 *
 * | 写法          | 意思                              |
 * | ------------- | --------------------------------- |
 * | `**`          | 全部文件                          |
 * | `*.md`        | 所有 markdown（不限目录）         |
 * | `thoughts/`   | `thoughts/` 及其子目录里的全部    |
 * | `notes/a.md`  | 就这一篇                          |
 *
 * 四种写法刻意都只用一行字符串表示，不引 glob 库：规则是**人手写的、写在设置里的**，
 * 越朴素越不容易写错，也越容易在设置面板里解释清楚。
 */

export type PushScope = {
  /** 进来。空数组 = 什么都不推（明确的"我不要自动推"）。 */
  include: string[];
  /** 排除：精确路径。单篇例外用这个，优先级高于 include。 */
  exclude: string[];
};

/** 出厂默认：`**` —— 全量，跟改造前的行为一致，老用户升级后不丢东西。 */
export const DEFAULT_SCOPE: PushScope = { include: ['**'], exclude: [] };

/** 一条规则是否命中一个路径。导出是为了能单独测（比对着 scope 整体测好定位）。 */
export function matchPattern(path: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;

  if (p === '**' || p === '*') return true;

  // `*.md`：只看后缀，不限目录。大小写不敏感（`.MD` 也是 markdown）
  if (p.startsWith('*.')) {
    const ext = p.slice(1).toLowerCase();
    return path.toLowerCase().endsWith(ext);
  }

  // `thoughts/`：目录前缀。⚠️ 必须连斜杠一起比 —— 否则 `notes/` 会把
  // `notes-backup/a.md` 也算进来（这种"看起来像"的误伤最难查）
  if (p.endsWith('/')) return path === p.slice(0, -1) || path.startsWith(p);

  // 其余当精确路径
  return path === p;
}

/**
 * 这个路径在不在推送范围内。
 *
 * ⚠️ 判定顺序不能反：**排除先看**。因为 include 里常有 `**`（全选），
 * 若先判 include，单篇例外就永远轮不到。
 */
export function inScope(path: string, scope: PushScope): boolean {
  if (scope.exclude.includes(path)) return false;
  if (scope.include.length === 0) return false;
  return scope.include.some((p) => matchPattern(path, p));
}

/** 从一堆路径里挑出范围内的。引擎和界面共用同一个判定，别各写一份。 */
export function scopePaths(paths: string[], scope: PushScope): string[] {
  return paths.filter((p) => inScope(p, scope));
}

/**
 * 清洗设置里存进来的规则：去空白、去空行、去重、保序。
 * 手写的东西总有空格和回车混进去，不洗的话「`**` 」跟「`**`」是两条规则，
 * 界面上看着一样、行为却对不上。
 */
export function normalizeScope(raw: {
  include?: string[] | null;
  exclude?: string[] | null;
}): PushScope {
  const clean = (v: string[] | null | undefined): string[] => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
      if (typeof item !== 'string') continue;
      const s = item.trim();
      if (!s || out.includes(s)) continue;
      out.push(s);
    }
    return out;
  };
  return { include: clean(raw.include), exclude: clean(raw.exclude) };
}

/**
 * 一句话说明这个范围（给设置面板 / 状态栏用）。
 * 写这句不是为了好看：规则是用户手写的，界面上不回读一遍，
 * 他就不知道自己配出来的到底是"全部"还是"只有 md"。
 */
export function describeScope(scope: PushScope): string {
  const { include, exclude } = scope;
  if (include.length === 0) return '什么都不推（范围为空）';
  if (include.includes('**') || include.includes('*')) {
    return exclude.length ? `全部文件，除了 ${exclude.length} 篇` : '全部文件';
  }
  const head = include.join('、');
  return exclude.length ? `${head}，另外排除 ${exclude.length} 篇` : head;
}
