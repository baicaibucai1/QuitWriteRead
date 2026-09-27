// 三路比对同步引擎：上次快照 / 本地文件 / 远端 sha。
//
// ⚠️ 这一层**不认任何一家云服务**：只认 providers/types.ts 里的 Remote 接口。
// 换后端（GitHub / 坚果云 / OneDrive）不改这里一行 —— 判定表、冲突处理、删除确认
// 这些真正会丢东西的逻辑因此只有一份，不会在三个后端里各错一次。
// 下面那些 "一次同步只产生一个 commit" 之类的话，是按 GitHub 的语义写的：
// 网盘没有事务（见 Remote.write 的注释），但比对与冲突规则完全一样。

import { blobSha, normalizeText } from './gh';
import { bytesToBase64, isBinaryPath, storedSha } from './binary';
import { decide } from './decide';
import type { Change } from './decide';
import type { Remote, RemoteChange } from './providers/types';
import { DEFAULT_SCOPE } from './scope';
import { inScope, scopePaths } from './scope';
import type { PushScope } from './scope';

/**
 * 本地一份文件的指纹。**附件按解码后的字节算，文字按文本算** ——
 * 远端（GitHub）算的是文件字节的 blob sha，附件若按 base64 字符串算就永远对不上，
 * 结果就是每次同步都判成"本地改了"，附件被无休止地来回推。
 */
async function localSha(path: string, stored: string): Promise<string | undefined> {
  if (isBinaryPath(path)) {
    const sha = await storedSha(stored);
    // base64 坏了（比如被人手改过）时退回按字符串算 —— 至少不会让同步整个崩掉，
    // 只会判成"本地改了"，下一轮推上去把它修好
    return sha ?? (await blobSha(stored));
  }
  return blobSha(normalizeText(stored));
}

/** 从远端拿一份文件，返回要存进 `files` 的形态（附件是 base64）。 */
async function pullOne(remote: Remote, path: string): Promise<string> {
  if (isBinaryPath(path)) return bytesToBase64(await remote.readBytes(path));
  return normalizeText(await remote.read(path));
}

export type FileMap = Record<string, string>;
export type Snapshot = Record<string, string>;

export type Plan = {
  /** 远端**全部**文件的指纹（范围外的也在）—— 「浏览远端、挑几篇拉」要靠它 */
  remote: Record<string, string>;
  /** 待办清单。**只含范围内的路径** —— 范围外的文件这一层压根不看 */
  changes: Change[];
};

export type SyncStats = {
  pushed: number;
  pulled: number;
  removed: number;
  conflicts: number;
  commitSha: string | null;
};

export type SyncResult = {
  files: FileMap;
  snapshot: Snapshot;
  /** 远端**全部**文件的最新指纹。留着给「浏览远端、挑几篇拉」用 */
  remote: Record<string, string>;
  stats: SyncStats;
  log: string[];
  /**
   * 这轮计划里要删掉的远端文件。**删远端是不可逆的**，所以默认不动手：
   * 只把这些路径交回界面等用户点头（见 opts.allowDelete）。
   */
  pendingDeletes: string[];
  /**
   * 两边都改过、需要人选一边的路径。**这里不做自动处理**：
   * 以前是"远端版本另存副本、本地版本留着"，那是替用户做了决定 ——
   * 现在交回界面显示差异，由他说了算。
   */
  conflicts: string[];
};

export type SyncOptions = {
  /** 用户确认过「就删这些」才置 true。默认 false = 只推不删。 */
  allowDelete?: boolean;
};

/**
 * 比对一次。**只比对范围内的路径**（见 lib/scope.ts 头上那段为什么）。
 *
 * ⚠️ `changes` 里会有 pull-* 和 conflict —— 它们是**提示**，不是"待会儿要自动做的事"：
 * 自动动作只剩推送，远端的变化要人点名才拉（用户选的语义）。
 */
export async function planSync(
  remote: Remote,
  files: FileMap,
  snapshot: Snapshot,
  scope: PushScope = DEFAULT_SCOPE,
): Promise<Plan> {
  // 远端指纹和本地是同一种算法（blob sha）—— 见 providers/types.ts 里那条取舍，
  // 三路比对才成立
  const entries = await remote.list();
  const remoteMap: Record<string, string> = {};
  for (const e of entries) remoteMap[e.path] = e.sha;

  const paths = new Set<string>([...Object.keys(files), ...Object.keys(snapshot), ...Object.keys(remoteMap)]);
  const changes: Change[] = [];
  // 收窄就这一行，但它是整个"不全量"的开关：范围外的路径连 decide 都进不去，
  // 因此**不可能**产生 push-del —— 取消勾选绝不等于删远端
  for (const path of scopePaths([...paths], scope)) {
    const sha = path in files ? await localSha(path, files[path] ?? '') : undefined;
    const kind = decide(sha, snapshot[path], remoteMap[path]);
    if (kind) changes.push({ kind, path });
  }

  changes.sort((a, b) => a.path.localeCompare(b.path, 'zh'));
  return { remote: remoteMap, changes };
}

/**
 * 交给用户选边时用得到：冲突副本的路径（`xxx.conflict-日期.md`）。
 * 日期用**本地日期** —— 它的作用是"看出这是哪天撞的"，不是精确时刻；
 * 同一天撞两次就加序号，绝不覆盖上一篇。
 */
function conflictPath(path: string, taken: Set<string>): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = `${dir}${stem}.conflict-${stamp}${ext}`;
  let i = 2;
  while (taken.has(candidate)) candidate = `${dir}${stem}.conflict-${stamp}-${i++}${ext}`;
  return candidate;
}

function commitMessage(paths: string[]): string {
  const names = paths.slice(0, 4).map((p) => p.split('/').pop());
  const n = paths.length;
  return `QuitWriteRead：${n > 4 ? `${names.join('、')} 等 ${n} 个文件` : names.join('、')}`;
}

/**
 * 收尾：把快照对齐到远端真值。**只记范围内的路径**。
 *
 * 为什么重新列一遍而不信自己刚写的东西：GitHub 是一个 commit（能算准），
 * 网盘是逐个 PUT，中途失败就是"一部分上去了" —— 只有列一遍才拿得到"现在到底是什么样"。
 *
 * ⚠️ 为什么过滤：范围外的文件这一层不认识，让它进快照等于又开始替用户记账，
 * 而"记了账却不管"正是误删的来源。
 */
async function freshRemote(
  remote: Remote,
  scope: PushScope,
): Promise<{ snapshot: Snapshot; remote: Record<string, string> }> {
  const after = await remote.list();
  const all: Record<string, string> = {};
  for (const e of after) all[e.path] = e.sha;
  const nextSnapshot: Snapshot = {};
  for (const e of after) if (inScope(e.path, scope)) nextSnapshot[e.path] = e.sha;
  return { snapshot: nextSnapshot, remote: all };
}

/**
 * **推送**：把范围内的本地改动推上去。
 *
 * 三个刻意的"不"：
 *   · **不自动拉** —— 远端的变化只列出来，拉什么是人的事（他要"选择拉取"）
 *   · **不自动处理冲突** —— 以前是"远端版本另存副本"，那是替他做了决定；
 *     现在交回界面显示差异，由他选哪一侧
 *   · **不删远端**（除非点过头）—— 删除不可逆
 */
export async function pushOnce(
  remote: Remote,
  files: FileMap,
  snapshot: Snapshot,
  scope: PushScope = DEFAULT_SCOPE,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const plan = await planSync(remote, files, snapshot, scope);
  const log: string[] = [];
  const next: FileMap = { ...files };
  const stats: SyncStats = { pushed: 0, pulled: 0, removed: 0, conflicts: 0, commitSha: null };

  // 「本地没有 + 上次快照有 + 远端没动」会被判成本地删除。本地文件列表一旦不完整
  // （拉了半截、工作副本被清过），这条判定就会把远端文件成片删掉 —— 不可逆。
  // 所以删除永远要人点头，默认只把它们列出来。
  const deletes = plan.changes.filter((c) => c.kind === 'push-del').map((c) => c.path);
  const pendingDeletes = deletes.length > 0 && !opts.allowDelete ? deletes : [];

  const conflicts = plan.changes.filter((c) => c.kind === 'conflict').map((c) => c.path);
  stats.conflicts = conflicts.length;
  if (conflicts.length) log.push(`⚠ ${conflicts.length} 处两边都改了，要先选一边`);

  const pulls = plan.changes.filter((c) => c.kind.startsWith('pull')).length;
  if (pulls) log.push(`· 远端有 ${pulls} 项更新（不会自动拉，要的话去「拉取」里挑）`);

  const writes: RemoteChange[] = [];
  const pushPaths: string[] = [];
  for (const c of plan.changes) {
    if (c.kind === 'push-del') {
      // 没确认过就不删远端，只在日志里说清楚
      if (pendingDeletes.includes(c.path)) {
        log.push(`⏸ 待确认删除远端 ${c.path}`);
        continue;
      }
      writes.push({ path: c.path, content: null });
      pushPaths.push(c.path);
      stats.pushed += 1;
      log.push(`↑ 删除 ${c.path}`);
    } else if (c.kind === 'push-new' || c.kind === 'push-mod') {
      // 附件原样发出去（它已经是 base64，且绝不能过 normalizeText）
      const content = isBinaryPath(c.path) ? (next[c.path] ?? '') : normalizeText(next[c.path] ?? '');
      next[c.path] = content;
      writes.push({ path: c.path, content, encoding: isBinaryPath(c.path) ? 'base64' : 'utf-8' });
      pushPaths.push(c.path);
      stats.pushed += 1;
      log.push(`↑ ${c.path}`);
    }
  }

  if (writes.length > 0) {
    await remote.write(writes, commitMessage(pushPaths));
    log.push(`✔ 已推送 ${writes.length} 个改动`);
  } else if (pendingDeletes.length) {
    log.push('⏸ 没有别的改动，只有待确认的删除');
  } else if (conflicts.length) {
    log.push('⏸ 只有冲突，先选一边');
  } else {
    log.push('✔ 没有要推送的改动');
  }

  return { files: next, ...(await freshRemote(remote, scope)), stats, log, pendingDeletes, conflicts };
}

/** 冲突时选哪一边。`both` = 两版都留（云端那版另存副本）。 */
export type ConflictSide = 'local' | 'remote' | 'both';

/**
 * **选边**：两边都改过的那一篇，由人说用哪一侧。
 *
 * 为什么不做自动合并：markdown 没有可靠的合并单位 ——
 * 按行合会把「把第 3 段删了」和「在第 3 段后面加了一句」合成一坨谁都读不懂的东西。
 * 而**猜错一次就是丢字**，所以这里只做"选"，不做"合"。
 */
export async function resolveConflict(
  remote: Remote,
  files: FileMap,
  path: string,
  side: ConflictSide,
  scope: PushScope = DEFAULT_SCOPE,
): Promise<SyncResult> {
  const log: string[] = [];
  const next: FileMap = { ...files };
  const stats: SyncStats = { pushed: 0, pulled: 0, removed: 0, conflicts: 0, commitSha: null };

  const localText = isBinaryPath(path) ? (next[path] ?? '') : normalizeText(next[path] ?? '');
  const remoteText = await pullOne(remote, path);
  const writes: RemoteChange[] = [];

  if (side === 'remote') {
    // 用云端那版：覆盖本地。⚠️ 这是**人点过的**，不是偷偷盖 —— 所以不另存副本
    next[path] = remoteText;
    stats.pulled += 1;
    log.push(`↓ ${path}（用了云端那版）`);
  } else {
    const copy = side === 'both' ? conflictPath(path, new Set(Object.keys(next))) : null;
    if (copy) {
      next[copy] = remoteText;
      writes.push({ path: copy, content: remoteText, encoding: isBinaryPath(copy) ? 'base64' : 'utf-8' });
      log.push(`⚠ 云端那版存为 ${copy}`);
    }
    next[path] = localText;
    writes.push({ path, content: localText, encoding: isBinaryPath(path) ? 'base64' : 'utf-8' });
    stats.pushed += 1;
    log.push(`↑ ${path}（${copy ? '两边都留' : '用了本机这版'}）`);
  }

  if (writes.length) {
    await remote.write(writes, commitMessage(writes.map((w) => w.path)));
    log.push('✔ 已落远端');
  }

  return { files: next, ...(await freshRemote(remote, scope)), stats, log, pendingDeletes: [], conflicts: [] };
}

/**
 * **拉取**：把指定的几篇从远端拿回来。
 *
 * ⚠️ 这是**人选的动作**（在远端目录里挑的），所以跟以前的自动拉取不一样：
 *   · 本地没改过 → 直接用远端版本覆盖
 *   · 两边都改过 → **不动**，交回界面显示差异让人选（覆盖就等于丢字，不能替他决定）
 */
export async function pullOnce(
  remote: Remote,
  files: FileMap,
  snapshot: Snapshot,
  paths: string[],
  scope: PushScope = DEFAULT_SCOPE,
): Promise<SyncResult> {
  const plan = await planSync(remote, files, snapshot, scope);
  const log: string[] = [];
  const next: FileMap = { ...files };
  const stats: SyncStats = { pushed: 0, pulled: 0, removed: 0, conflicts: 0, commitSha: null };
  const conflicts: string[] = [];

  for (const path of paths) {
    if (!(path in plan.remote)) {
      log.push(`· 远端没有 ${path}，跳过`);
      continue;
    }
    const c = plan.changes.find((x) => x.path === path);
    if (c?.kind === 'conflict') {
      conflicts.push(path);
      stats.conflicts += 1;
      log.push(`⚠ ${path} 两边都改了，先选一边再拉`);
      continue;
    }
    next[path] = await pullOne(remote, path);
    stats.pulled += 1;
    log.push(`↓ ${path}`);
  }

  if (stats.pulled) log.push(`✔ 已拉取 ${stats.pulled} 篇`);
  else if (!conflicts.length) log.push('· 没有可拉的');

  return { files: next, ...(await freshRemote(remote, scope)), stats, log, pendingDeletes: [], conflicts };
}
