/*
 * AI 助手的**书籍工具**端到端。
 *
 * 跟 `agent-e2e.mjs` 分工：那边验内核那条流水线（事件流 / 审批卡），
 * 这边验**数据源** —— 工具到底有没有真的读到书架上那本书。
 * 书不是笔记：它在 IndexedDB 里（`bookdb`），要把 zip 解压过一遍才看得见字，
 * 这条链路接错的话，工具会面不改色地答一本错的、或者答"书架上还没有书"。
 * 这类错页面上一个红都不会冒，只能靠断言盯着。
 *
 * 做法是**在浏览器里直接调工具层**（Vite 开发期 `await import('/src/...')` 可用）：
 * 塞进书架的是 `make-epub.mjs` 自己造的那本书 —— 目录和正文都是已知的，断言才有意义。
 *
 * ⚠️ 书这批工具全是只读的 —— 这里也要盯着这一点不放。
 */
import { createRequire } from 'node:module';

for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[k];
}

const require = createRequire('C:/AI_Production/QQbot/');
const { chromium } = require('playwright');
const { watchConsole } = await import('./remote-noise.mjs');
const { makeEpub } = await import('./make-epub.mjs');

const URL = process.env.DEMO_URL ?? 'http://localhost:5183';

let failed = 0;
const ok = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};
const step = (s) => console.log('\n== ' + s);

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const { errors, noise } = watchConsole(page);

try {
  step('打开页面，清掉旧书架');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.deleteDatabase('suisui-books');
        r.onsuccess = () => res();
        r.onerror = () => res();
        r.onblocked = () => res();
      }),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-sync]', { timeout: 15000 });
  await page.waitForTimeout(600);

  step('切到阅读那边，导入一本造好的 epub');
  // 书架只在这一边 —— 导入的输入框也在它头上
  await page.click('[data-mode-tab="read"]');
  await page.waitForSelector('[data-bookshelf]', { timeout: 10000 });
  await page.setInputFiles('[data-book-import-input]', {
    name: '第一本.epub',
    mimeType: 'application/epub+zip',
    buffer: makeEpub(),
  });
  await page.waitForTimeout(800);
  ok('书架上有了一本', (await page.locator('[data-book-item]').count()) === 1);

  /*
   * 工具层的真身 —— 在开发期的模块图里是可以手取的。
   * 这一步之后所有的调用都走生产那一套代码，没有替身。
   */
  const tools = await page.evaluate(async () => {
    const m = await import('/src/lib/agent/book-tools.ts');
    const list = m.createBookTools();
    const run = async (name, args) => {
      const t = list.find((x) => x.name === name);
      const r = await t.execute(args, {
        signal: new AbortController().signal,
        workspaceRoot: '/repo',
        sessionId: 'e2e',
        runId: 'e2e',
        toolCallId: 'e2e',
        sandbox: { root: '/repo', additionalRoots: [], resolve: async (p) => p, resolveSync: (p) => p, isInside: () => true },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        progress() {},
        services: {},
      });
      return { text: String(r.content), isError: !!r.isError };
    };
    return {
      names: list.map((t) => ({ name: t.name, readOnly: t.readOnly === true })),
      listBooks: await run('list_books', {}),
      readCh1: await run('read_book', { book: '碎碎', chapter: 1 }),
      readCh3: await run('read_book', { book: '碎碎的第一本书', chapter: 3 }),
      badChapter: await run('read_book', { book: '碎碎', chapter: 9 }),
      noSuchBook: await run('read_book', { book: '没有这本书', chapter: 1 }),
      search: await run('search_book', { book: '碎碎', query: '饭要趁热吃' }),
      miss: await run('search_book', { book: '碎碎', query: '绝不会出现的句子xyzzy' }),
      notes: await run('list_book_notes', { book: '碎碎' }),
    };
  });

  step('这四个工具都是只读的');
  ok('一共四个', tools.names.length === 4, tools.names.map((t) => t.name).join(' '));
  ok('四个都标了 readOnly', tools.names.every((t) => t.readOnly), JSON.stringify(tools.names));
  ok(
    '名字就是设置页那张表上的', 
    ['list_books', 'read_book', 'search_book', 'list_book_notes'].every((n) => tools.names.some((t) => t.name === n)),
  );

  step('list_books：书名 / 作者 / 章数都在');
  const listed = tools.listBooks.text;
  console.log('  ' + listed.replace(/\n/g, ' | ').slice(0, 120));
  ok('书名取的是 dc:title', listed.includes('碎碎的第一本书'));
  ok('作者也在', listed.includes('白菜不菜'));
  ok('知道有几章', listed.includes('3 章'), listed.match(/\d+ 章/)?.[0] ?? '');

  step('read_book：读的是真的字，不是书名猜出来的');
  const c1 = tools.readCh1.text;
  ok('抬头有书名和章节标题', c1.includes('碎碎的第一本书') && c1.includes('第一章'), c1.slice(0, 50));
  ok('第一章正文里的话到了', c1.includes('出门买了菜'), c1.slice(0, 80));
  ok('后面还有几章也交代了', c1.includes('共 3 章'));
  // `__evil` 是那本书里刻意埋的 <script> —— chapterText 没把它挖干净的话会漏进正文
  const c3 = tools.readCh3.text;
  ok('第三章跟第一章不是一回事', c3.includes('猫又来了'), c3.slice(0, 60));
  ok('script 里的东西没混进正文', !c3.includes('__evil'), c3.includes('__evil') ? '漏出来了' : '');

  step('给错的东西要给得明白');
  ok('章节序号超了要说范围', tools.badChapter.isError && tools.badChapter.text.includes('3 章'), tools.badChapter.text);
  ok(
    '书名对不上要把候选列出来',
    tools.noSuchBook.isError && tools.noSuchBook.text.includes('碎碎的第一本书'),
    tools.noSuchBook.text.slice(0, 60),
  );

  step('search_book：找得到，也敢说找不到');
  const hit = tools.search.text;
  ok('命中了第二章那句', hit.includes('饭要趁热吃'), hit.slice(0, 80));
  ok('出处是第二章那个标题', hit.includes('第二章'), hit.slice(0, 40));
  ok('找不到就直说', tools.miss.text.includes('没找到'), tools.miss.text);

  step('list_book_notes：还没批注时要说还没有');
  ok('诚实说没有', tools.notes.text.includes('还没有批注'), tools.notes.text);

  step('零报错');
  ok('没有页面错误', errors.length === 0, errors.slice(0, 4).join(' | '));
  if (noise.length) console.log(`  · 远端网络噪声 ${noise.length} 条（不算失败）`);
} finally {
  await browser.close();
}

console.log(`\n${failed === 0 ? '全绿' : `红了 ${failed} 条`}`);
process.exit(failed === 0 ? 0 : 1);
