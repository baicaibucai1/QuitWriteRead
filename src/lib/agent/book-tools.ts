// 助手能用的**书籍**工具 —— 全只读。
//
// ## 数据源跟笔记不是一处
//
// 笔记是磁盘上真的一堆 .md（Repo），书是 IndexedDB 里的 zip 字节（`lib/bookdb.ts`）——
// 当初就是刻意分开的：一本书 2~20MB，进笔记那条链路只会把每次同步拖死。
// 所以这里**不能**顺手用 Repo，得走 bookdb 那一套。
//
// ## 两个绕不开的细节
//
//   ① **模型不知道 uuid**：它只知道书名。所以匹配书一律走 "id 精确 / 标题包含"，
//      一本书对不上就把候选名列出来，让它自己挑 —— 猜一本错的给人看更糟。
//   ② **解压要缓存**：一本 epub 从头解压一遍要几百毫秒到几秒，而且 `files` 里
//      装着整本书的字节。同一个回合里问十次就是十份 —— 缓存并以"最近用"为准剔除旧的。
//
// ⚠️ 这批工具**只读** —— 读正文、读批注都行，但没有写工具：书当初就不打算让别处改。
import { chapterText, readEpub, searchBook, type ParsedBook } from '../epub';
import { getBookBytes, getProgress, listBooks, listNotes, type BookMeta } from '../bookdb';
import { defineTool, type Tool } from './core/types/tools';

/** 一次章节正文最多给多少字符 */
const MAX_CHARS = 12_000;

/** 同时缓存几本。书架可以有几十本，但一个回合里通常就在某一本里翻 */
const CACHE_MAX = 3;

/** id → 已解压的书。顺手当 LRU 用：满了丢最早那个 */
const cache = new Map<string, ParsedBook>();

async function opened(id: string): Promise<ParsedBook | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  const bytes = await getBookBytes(id);
  if (!bytes) return null;
  const parsed = readEpub(new Uint8Array(bytes));
  if (!parsed) return null;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(id, parsed);
  return parsed;
}

/**
 * 模型给的 `book` 可能是 id 也可能是书名里的一段 —— 两边都认。
 * 认不出来就返回 null，让工具把候选列给它（比替它猜要强）。
 */
function pickBook(all: BookMeta[], want: string): BookMeta | null {
  const q = want.trim().toLowerCase();
  if (!q) return null;
  return (
    all.find((b) => b.id === want) ??
    all.find((b) => b.title.toLowerCase() === q) ??
    all.find((b) => b.title.toLowerCase().includes(q)) ??
    null
  )
}

function noBooks(): string {
  return '书架上还没有书 —— 先在左栏的书架里导入一本 epub。';
}

/** 这一章叫什么。目录常常跳过了封面、版权页，所以按 href 反查；查不到就退回「第 N 章」 */
function labelOf(book: BookMeta, href: string, index: number): string {
  const hit = book.toc.find((t) => t.href.split('#')[0] === href.split('#')[0]);
  return hit?.label || `第 ${index + 1} 章`;
}

export function createBookTools(): Tool[] {
  const listBooksTool = defineTool({
    name: 'list_books',
    description: '列出书架上的书：书名、作者、多少章、读到哪了，以及**后面要用的 id**。',
    kind: 'read',
    readOnly: true,
    parameters: { type: 'object', properties: {} },
    title: () => '列出书架',
    async execute() {
      const all = await listBooks();
      if (all.length === 0) return { content: noBooks() };
      const rows = await Promise.all(
        all.map(async (b) => {
          const p = await getProgress(b.id);
          const read = p ? `，读到 ${p.percent}%《${p.label}》` : '，还没开始读';
          return `${b.id}\t《${b.title}》${b.author ? ` / ${b.author}` : ''}　${b.spine.length} 章${read}`;
        }),
      );
      return { content: rows.join('\n') };
    },
  });

  const readBook = defineTool<{ book: string; chapter: number | string }>({
    name: 'read_book',
    description:
      '读一本书的某一章。`book` 给书名里的一段或 list_books 拿到的 id；' +
      '`chapter` 给章节序号（**从 1 开始**）。返回那一章的纯文本。',
    kind: 'read',
    readOnly: true,
    primaryArg: 'book',
    parameters: {
      type: 'object',
      properties: {
        book: { type: 'string', description: '书名（或其中一段）/ id' },
        chapter: { description: '第几章，从 1 开始', oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }] },
      },
      required: ['book', 'chapter'],
    },
    title: (a) => `读《${a.book}》第 ${a.chapter} 章`,
    async execute({ book: want, chapter }) {
      const all = await listBooks();
      if (all.length === 0) return { content: noBooks(), isError: true };
      const book = pickBook(all, String(want ?? ''));
      if (!book) {
        return {
          content: `书架上没有对得上「${want}」的书。现有的是：\n${all.map((b) => `· 《${b.title}》`).join('\n')}`,
          isError: true,
        };
      }
      const idx = Number(chapter) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx >= book.spine.length) {
        return {
          content: `章节序号不对：这本一共 ${book.spine.length} 章，${chapter} 不在范围内。`,
          isError: true,
        };
      }
      const parsed = await opened(book.id);
      if (!parsed) return { content: `《${book.title}》这本书打不开（文件坏了？）`, isError: true };

      const href = book.spine[idx]!;
      const raw = parsed.files[href];
      if (!raw) return { content: `找不到第 ${idx + 1} 章的正文文件（${href}）`, isError: true };

      const full = chapterText(new TextDecoder().decode(raw));
      const body = full.length > MAX_CHARS ? full.slice(0, MAX_CHARS) : full;
      const tail =
        full.length > MAX_CHARS
          ? `\n\n…（这一章共 ${full.length} 字，只给到前 ${MAX_CHARS} 字。）`
          : '';
      const next = idx + 1 < book.spine.length ? `\n\n（后面还有第 ${idx + 2} 章，这本共 ${book.spine.length} 章。）` : '\n\n（这是最后一章。）';
      return { content: `# 《${book.title}》 · ${labelOf(book, href, idx)}\n\n${body}${tail}${next}` };
    },
  });

  const searchBookTool = defineTool<{ book: string; query: string; limit?: number }>({
    name: 'search_book',
    description: '在一本书里搜一段话，返回命中的章节标题和前后那一小句。大小写不敏感。',
    kind: 'search',
    readOnly: true,
    primaryArg: 'query',
    parameters: {
      type: 'object',
      properties: {
        book: { type: 'string', description: '书名（或其中一段）/ id' },
        query: { type: 'string', description: '要找的话' },
        limit: { type: 'integer', description: '最多报几条，默认 10' },
      },
      required: ['book', 'query'],
    },
    title: (a) => `在《${a.book}》里搜「${a.query}」`,
    async execute({ book: want, query, limit }) {
      const all = await listBooks();
      if (all.length === 0) return { content: noBooks(), isError: true };
      const book = pickBook(all, String(want ?? ''));
      if (!book) {
        return {
          content: `书架上没有对得上「${want}」的书。现有的是：\n${all.map((b) => `· 《${b.title}》`).join('\n')}`,
          isError: true,
        };
      }
      const q = String(query ?? '').trim();
      if (!q) return { content: '（空的查询词）', isError: true };
      const parsed = await opened(book.id);
      if (!parsed) return { content: `《${book.title}》这本书打不开（文件坏了？）`, isError: true };

      /*
       * 整本书逐章转纯文本。这是这里最贵的一步（一本长篇能到几百毫秒），
       * 但搜索本来就是"全书扫描"，没法省 —— 能省的是别一本书重复跑。
       */
      const chapters = book.spine.map((href, i) => {
        const raw = parsed.files[href];
        return {
          href,
          label: labelOf(book, href, i),
          text: raw ? chapterText(new TextDecoder().decode(raw)) : '',
        };
      });
      const max = Math.min(Math.max(limit ?? 10, 1), 40);
      const hits = searchBook(chapters, q, max);
      if (hits.length === 0) return { content: `《${book.title}》里没找到「${q}」。` };
      return { content: hits.map((h) => `${h.label}：${h.snippet}`).join('\n') };
    },
  });

  const listBookNotes = defineTool<{ book: string }>({
    name: 'list_book_notes',
    description: '列出一本书的**批注**：划出来的那句话 + 人写在旁边的想法。没写字的只有划线。',
    kind: 'read',
    readOnly: true,
    primaryArg: 'book',
    parameters: {
      type: 'object',
      properties: { book: { type: 'string', description: '书名（或其中一段）/ id' } },
      required: ['book'],
    },
    title: (a) => `列出《${a.book}》的批注`,
    async execute({ book: want }) {
      const all = await listBooks();
      if (all.length === 0) return { content: noBooks(), isError: true };
      const book = pickBook(all, String(want ?? ''));
      if (!book) {
        return {
          content: `书架上没有对得上「${want}」的书。现有的是：\n${all.map((b) => `· 《${b.title}》`).join('\n')}`,
          isError: true,
        };
      }
      const notes = await listNotes(book.id);
      if (notes.length === 0) return { content: `《${book.title}》还没有批注。` };
      return {
        content: notes
          .map((n, i) => `${i + 1}. 【${n.label}】划了：「${n.quote}」${n.text ? `\n   想法：${n.text}` : '（没写字）'}`)
          .join('\n'),
      };
    },
  });

  return [listBooksTool, readBook, searchBookTool, listBookNotes];
}
