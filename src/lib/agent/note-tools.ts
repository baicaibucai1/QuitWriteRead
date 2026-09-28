// 助手能用的**笔记**工具 —— 读的三个、写的两个。
//
// ## 为什么不直接用 Repo.write
//
// 界面上的 `files` 是 working copy，落盘是 store 里那个订阅（`SAVE_DEBOUNCE` 之后
// 把差异写回仓库）。如果工具绕过它直接 `repo.write()`，就会有**两条写路径**：
//
//   · 界面看不见助手写的东西（文件树不刷新、编辑器还是旧内容）；
//   · 更糟的是 next flush 按 `files` 为准，助手写的东西可能被下一次改动覆盖回去。
//
// 所以写**必须**走 `store.setContent` —— 它同时决定了屏幕上那一份和磁盘上那一份。
// 这也是为什么写权限值得单独开个口子：它动的是用户真正在编辑的东西。
//
// ## 权限
//
// 读的三个标 `readOnly: true`，内核在 default / readOnly 模式下直接放行；
// 写的两个什么都不标 → 走到 PermissionEngine 最后一句 "No rule allows …" →
// **必定弹卡**。这是刻意的：写不可逆，宁可多问一句。
// 卡上的 `title` 会先说清要覆盖多少字 —— 只报个文件名等于让人盲签。
import { currentRepo, useStore } from '../store';
import { isProgramArtifact } from '../visible';
import { defineTool, type Tool } from './core/types/tools';

/** 一篇最多给模型多少字符。超了就掐断并说清掐了多少 —— 静默截断等于撒谎 */
const MAX_CHARS = 24_000;

/** 列表最多给多少条。笔记可以有很多，但一次全塞进上下文会把正题挤掉 */
const MAX_LIST = 300;

/** 一次写进去的上限。一篇 50 万字的笔记基本是误操作或被塞进了别的格式 */
const MAX_WRITE = 200_000;

function noRepo(): string {
  return '还没有打开仓库 —— 请先在界面上选一个文件夹（或用一个暂存仓库）。';
}

/** 仓库里"该出现在助手眼前"的那些文件：程序自己写的隐藏文件与书不算 */
function visibleNotes(paths: string[]): string[] {
  return paths.filter((p) => !isProgramArtifact(p) && !p.startsWith('books/'));
}

function truncate(text: string): { text: string; note: string } {
  if (text.length <= MAX_CHARS) return { text, note: '' };
  return {
    text: text.slice(0, MAX_CHARS),
    note: `\n\n…（这篇一共 ${text.length} 字符，只给到前 ${MAX_CHARS} 字符。要看后面请指定更具体的问题。）`,
  };
}

/**
 * 先问内存那份（界面正在用的），没有再去仓库读 —— 两条路给出的是同一篇。
 *
 * ⚠️ **不能只靠 `repo.read` 的返回值判断存在**：仓库里没这篇时它不一定抛 ——
 * 暂存仓库那一份写的是 `memAll()[path] ?? ''`，**返回空串**。于是
 *   · `read_note` 读一个不存在的路径会给出一篇空笔记（而不是"读不出来"）；
 *   · 更糟的是"这一篇在不在"这种判断会全错 —— 没建过的文件被当成已存在。
 * 所以仓库这一侧先查清单再读。
 */
async function readNote(path: string): Promise<string | null> {
  const inMem = useStore.getState().files[path];
  if (typeof inMem === 'string') return inMem;
  const repo = currentRepo();
  if (!repo) return null;
  try {
    const there = (await repo.list()).some((e) => e.path === path);
    if (!there) return null;
    return await repo.read(path);
  } catch {
    return null;
  }
}

export type NoteToolsOptions = {
  /** 关掉就只注册只读的三个（写的一个都不给） */
  allowWrite: boolean;
};

export function createNoteTools(opts: NoteToolsOptions): Tool[] {
  const listNotes = defineTool<{ prefix?: string }>({
    name: 'list_notes',
    description: '列出仓库里的笔记（可给一个目录前缀，比如 "thoughts/"）。返回相对路径清单。',
    kind: 'search',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: { prefix: { type: 'string', description: '目录前缀，不给就是全部' } },
    },
    title: (a) => (a.prefix ? `列出 ${a.prefix} 下的笔记` : '列出笔记'),
    async execute({ prefix }) {
      const repo = currentRepo();
      if (!repo) return { content: noRepo(), isError: true };
      const all = visibleNotes((await repo.list()).map((e) => e.path)).sort();
      const hit = prefix ? all.filter((p) => p.startsWith(prefix)) : all;
      if (hit.length === 0) return { content: `（没有匹配的笔记${prefix ? `：${prefix}` : ''}）` };
      const shown = hit.slice(0, MAX_LIST).join('\n');
      const more = hit.length > MAX_LIST ? `\n\n…（还有 ${hit.length - MAX_LIST} 条没列）` : '';
      return { content: `${shown}${more}` };
    },
  });

  const readNoteTool = defineTool<{ path: string }>({
    name: 'read_note',
    description: '读一篇笔记的正文。path 是仓库内的相对路径，用 list_notes 拿到的那种。',
    kind: 'read',
    readOnly: true,
    primaryArg: 'path',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '仓库内相对路径，如 thoughts/散步.md' } },
      required: ['path'],
    },
    title: (a) => `读 ${a.path}`,
    async execute({ path }) {
      const text = await readNote(path);
      if (text === null) return { content: `读不出来 ${path}：仓库没打开，或这篇不存在`, isError: true };
      const { text: body, note } = truncate(text);
      return { content: `# ${path}\n\n${body}${note}` };
    },
  });

  const searchNotes = defineTool<{ query: string; limit?: number }>({
    name: 'search_notes',
    description: '在所有笔记里搜一段文字（大小写不敏感），返回命中的篇、行号与那一行。',
    kind: 'search',
    readOnly: true,
    primaryArg: 'query',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找的文字' },
        limit: { type: 'integer', description: '最多报几条，默认 20' },
      },
      required: ['query'],
    },
    title: (a) => `搜「${a.query}」`,
    async execute({ query, limit }) {
      const repo = currentRepo();
      if (!repo) return { content: noRepo(), isError: true };
      const q = query.trim().toLowerCase();
      if (!q) return { content: '（空的查询词）', isError: true };
      const max = Math.min(Math.max(limit ?? 20, 1), 50);
      const paths = visibleNotes((await repo.list()).map((e) => e.path)).sort();
      const out: string[] = [];
      for (const p of paths) {
        if (out.length >= max) break;
        const text = await readNote(p);
        if (text === null) continue; // 一篇读不出来不该断掉整次搜索
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]!.toLowerCase().includes(q)) continue;
          out.push(`${p}:${i + 1}: ${lines[i]!.trim().slice(0, 160)}`);
          break; // 一篇只报第一处，免得单篇刷屏
        }
      }
      return { content: out.length ? out.join('\n') : `（没找到「${query}」）` };
    },
  });

  if (!opts.allowWrite) return [listNotes, readNoteTool, searchNotes];

  /*
   * 新建。**它跟 write_note 是两件事，别合成一个**：
   *
   *   write_note 是**覆盖**式的 —— 那篇已经在的话，旧内容就没了；
   *   create_note 是**只建不改** —— 那篇已经在的话，它拒绝，一个字都不动。
   *
   * 「帮我建一篇 X」这种话，模型要么用覆盖式的那个（同名时误盖），
   * 要么先读一遍确认不存在（多一轮）。给它一个语义就是"建新"的工具，
   * 这两条都不用赌 —— 而"创建"和"覆盖"本来就不该是同一个动作。
   */
  const createNote = defineTool<{ path: string; content: string }>({
    name: 'create_note',
    description:
      '在仓库里**新建**一篇笔记（要建的目录不存在会自动建）。' +
      '⚠️ 那篇**已经存在时它会拒绝**，一个字都不动 —— 那是绝不能盖掉的东西。' +
      '要改已有的一篇：整篇换掉用 write_note，加一段用 append_note。' +
      '会先在界面上问人一句，批了才真的建。',
    kind: 'edit',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库内相对路径，如 thoughts/散步.md。带扩展名。' },
        content: { type: 'string', description: '这一篇的正文' },
      },
      required: ['path', 'content'],
    },
    primaryArg: 'path',
    title: (a) => `新建 ${a.path}（${(a.content ?? '').length} 字）`,
    async execute({ path, content }) {
      const p = (path ?? '').trim();
      const text = content ?? '';
      if (!p) return { content: '（没给路径 —— 不知道建在哪儿）', isError: true };
      /*
       * 三道护栏，都在**写之前**：
       *  · `..` —— 路径是 repo 相对的，带 .. 就可能绕到仓库外面去；
       *  · `books/` —— 那是书架（IndexedDB）的地盘，助手往那儿写就是第二个真相；
       *  · 程序产物 —— 那些文件是软件自己维护的，改了下次启动就被覆盖回来。
       */
      if (p.includes('..')) return { content: `（路径里不能有 ..：${p}）`, isError: true };
      if (p.startsWith('books/')) return { content: `（books/ 是书架的地方，笔记不建在那儿：${p}）`, isError: true };
      if (isProgramArtifact(p)) return { content: `（那是程序自己的文件，不能建：${p}）`, isError: true };
      if (!text.trim()) return { content: '（空的正文 —— 没建，免得建出一篇空笔记）', isError: true };
      if (text.length > MAX_WRITE) {
        return { content: `（太长了：${text.length} 字，一次最多 ${MAX_WRITE} 字。分开几次写。）`, isError: true };
      }
      if (!currentRepo()) return { content: noRepo(), isError: true };

      // ⚠️ 存在性要**两边都问**：内存那份（界面正在用）和仓库里那份
      const existing = await readNote(p);
      if (existing !== null) {
        return {
          content:
            `${p} 已经存在（${existing.length} 字），没动它 —— 我不盖已有的东西。` +
            '要改它：整篇换掉用 write_note，加一段用 append_note。',
          isError: true,
        };
      }

      /*
       * 只建，不抢焦点：人正在写那一篇的时候被切走是很恼火的。
       * 建出来那篇自己在左栏出现就够了（setContent 决定界面那一份，落盘由订阅管）。
       */
      useStore.getState().setContent(p, text);
      return { content: `新建了 ${p}（${text.length} 字）。它已经在左栏里了，我没切过去。` };
    },
  });

  /*
   * 「校准能力」的护栏写在这儿而不是提示词里 —— 提示词只是概率，代码才是事实。
   * 目标是人批了就要执行、被拒了就得认账。
   */
  const writeNote = defineTool<{ path: string; content: string }>({
    name: 'write_note',
    description:
      '把一篇笔记**整个改写**成给的内容（不存在就新建）。会先在界面上问人一句，批了才真的写。' +
      '只想加一段用 append_note —— 用它改写会丢掉原来全部内容。',
    kind: 'edit',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库内相对路径，如 thoughts/散步.md' },
        content: { type: 'string', description: '这篇改完后**完整**的正文（不是增量）' },
      },
      required: ['path', 'content'],
    },
    primaryArg: 'path',
    // 卡上的这句话就是人看到的全部依据 —— 必须说清"要把什么换成什么"
    title: (a) => {
      const before = useStore.getState().files[a.path];
      const n = a.content ?? '';
      if (typeof before !== 'string') return `新建 ${a.path}（${n.length} 字）`;
      return `改写 ${a.path}：${before.length} 字 → ${n.length} 字`;
    },
    async execute({ path, content }) {
      const text = content ?? '';
      if (!text.trim()) return { content: '（空的正文 —— 没写，怕把原来的盖掉）', isError: true };
      if (text.length > MAX_WRITE) {
        return { content: `（太长了：${text.length} 字，一次最多 ${MAX_WRITE} 字。分开几次写。）`, isError: true };
      }
      const before = useStore.getState().files[path];
      useStore.getState().setContent(path, text);
      return {
        content:
          typeof before === 'string'
            ? `改好了 ${path}：${before.length} 字 → ${text.length} 字。`
            : `新建了 ${path}（${text.length} 字）。`,
      };
    },
  });

  const appendNote = defineTool<{ path: string; content: string }>({
    name: 'append_note',
    description: '在一篇笔记**末尾**追加一段（不动原有内容）。笔记不存在就新建。',
    kind: 'edit',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '仓库内相对路径' },
        content: { type: 'string', description: '要追加的那一段（会另起一行接在后面）' },
      },
      required: ['path', 'content'],
    },
    primaryArg: 'path',
    title: (a) => {
      const before = useStore.getState().files[a.path];
      const add = (a.content ?? '').length;
      if (typeof before !== 'string') return `新建 ${a.path}（${add} 字）`;
      return `往 ${a.path} 末尾加 ${add} 字（原有 ${before.length} 字不动）`;
    },
    async execute({ path, content }) {
      const before = await readNote(path);
      const add = content ?? '';
      if (!add.trim()) return { content: '（空的追加内容 —— 什么都没动）', isError: true };
      if ((before?.length ?? 0) + add.length > MAX_WRITE) {
        return { content: `（加上去会到 ${(before?.length ?? 0) + add.length} 字，超过单次 ${MAX_WRITE} 字上限，没动）`, isError: true };
      }
      const next = before && before.trim() ? `${before.replace(/\s*$/, '')}\n\n${add}` : add;
      useStore.getState().setContent(path, next);
      return { content: `追加好了 ${path}：现在共 ${next.length} 字。` };
    },
  });

  return [listNotes, readNoteTool, searchNotes, createNote, writeNote, appendNote];
}
