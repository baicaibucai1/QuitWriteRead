// 助手能用的工具 —— **全部走 Repo 接口**，不给它 node:fs，也不给它整个磁盘。
//
// ## 为什么自己造而不是用内核自带的 read_file / write_file
//
//   ① 内核那两个实现靠 node:fs，浏览器端没有（已经随文件一起删掉了）；
//   ② 就算有，也不该给 —— 那等于把整个家目录交给模型。
//      Repo 只有 `list/read/write/...`，且**只认仓库内的相对路径**
//      （`lib/repo.ts` 硬规矩①：绝对路径不许进这个接口），
//      所以"沙箱"这件事在这里是天然的，不需要再靠一层路径检查去兜。
//
// ## 权限
//
// 只读的三个标 `readOnly: true`，内核在 default / readOnly 模式下直接放行；
// 写的那个会去问宿主（弹卡）。**读不用问，写必须问** —— 这条区分是刻意的。
import { currentRepo } from '../store';
import { isProgramArtifact } from '../visible';
import { defineTool, type Tool } from './core/types/tools';

/** 一篇最多给模型多少字符。超了就掐断并说清掐了多少 —— 静默截断等于撒谎 */
const MAX_CHARS = 24_000;

/** 列表最多给多少条。笔记可以有很多，但一次全塞进上下文会把正题挤掉 */
const MAX_LIST = 300;

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

export function createNoteTools(): Tool[] {
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

  const readNote = defineTool<{ path: string }>({
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
      const repo = currentRepo();
      if (!repo) return { content: noRepo(), isError: true };
      try {
        const raw = await repo.read(path);
        const { text, note } = truncate(raw);
        return { content: `# ${path}\n\n${text}${note}` };
      } catch (e) {
        return { content: `读不出来 ${path}：${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
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
        let text = '';
        try {
          text = await repo.read(p);
        } catch {
          continue; // 一篇读不出来不该断掉整次搜索
        }
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

  return [listNotes, readNote, searchNotes];
}
