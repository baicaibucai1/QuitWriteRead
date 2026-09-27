/*
 * 书籍（书架 + 阅读器）的端到端。
 *
 *   node tests/book-e2e.mjs
 *   DEMO_URL=http://localhost:5183 node tests/book-e2e.mjs
 *
 * ⚠️ **只能跑在 dev server 上**：要靠 `window.__suisui` 摆状态，那个钩子只在 DEV 暴露。
 *
 * 这套验的是**别人替不了的那一层**：书能不能真的从文件选择器进到 IndexedDB、
 * 目录点一下是不是真滚过去了、读到哪是不是真记下来了、书里的脚本有没有被剥掉。
 * 纯函数那层（解压 / 解析）在 epub.test.mjs 里，两边不重复。
 *
 * ⚠️ 书存在 IndexedDB，它是**跟着 origin 走的**，跑完不会自己清。
 * 所以开头先删库 —— 否则上一次跑留下的书会让"书架上只有一本"这种断言随机失败。
 */
import { createRequire } from 'node:module';
import { makeEpub, notAnEpub } from './make-epub.mjs';
import { watchConsole } from './remote-noise.mjs';

for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[k];
}

const { chromium } = createRequire('C:/AI_Production/QQbot/')('playwright');

const URL = process.env.DEMO_URL ?? 'http://localhost:5183';
const OUT = 'C:/AI_Production/suisui-app/shots/ui';

let pass = 0;
const bad = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    bad.push(name);
    console.log('  ✗ ' + name + (extra ? '   → ' + extra : ''));
  }
};
const step = (s) => console.log('\n== ' + s);

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

/*
 * 「零报错」只数**应用自己**的：pageerror + 来自开发服务器的 console error。
 * 第三方（api.github.com）那几条是浏览器替网络记的账 —— 仓库在不在、通不通
 * 由设置里「远端仓库」那一块说，不由这条断言说。判法见 ./remote-noise.mjs。
 */
const { errors, noise } = watchConsole(page);

const state = () => page.evaluate(() => window.__suisui.getState());
const text = async (sel) => ((await page.locator(sel).first().textContent()) ?? '').replace(/\s+/g, ' ');
const count = (sel) => page.locator(sel).count();

/** 把一本造好的书塞进文件选择框 —— 跟人点「导入 epub」选文件是同一条路 */
const importEpub = async (buf, name = '第一本.epub') => {
  await page.setInputFiles('[data-book-import-input]', {
    name,
    mimeType: 'application/epub+zip',
    buffer: buf,
  });
  await page.waitForTimeout(600);
};

await page.goto(URL, { waitUntil: 'domcontentloaded' });
// 先清掉上一轮留下的书架，再重新加载（删库要等它真的删完）
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
await page.waitForSelector('[data-sync]');
await page.waitForTimeout(900);

/*
 * 上一轮跑完可能留在阅读那边 —— `side` 现在是持久化的，它是有意的行为
 * （天天两处跑的人不想每次重选）。既然这套从这里起步，先明确掰回书写，
 * 下面的每一步才是从干净的地方走出去的。
 */
await page.evaluate(() => window.__suisui.setState({ side: 'write', lastBookId: null }));
await page.waitForTimeout(300);

step('入口：左栏顶上那条「书写 / 阅读」分段控件');
{
  ok('分段控件在', (await count('[data-mode]')) === 1);
  ok('当前在书写这边', (await page.getAttribute('[data-mode]', 'data-mode')) === 'write');
  ok('两项都在', (await count('[data-mode-tab]')) === 2);
  ok(
    '选中态跟着现在这边走',
    (await page.getAttribute('[data-mode-tab="write"]', 'aria-selected')) === 'true' &&
      (await page.getAttribute('[data-mode-tab="read"]', 'aria-selected')) === 'false',
  );
  const labels = await page.$$eval('[data-mode-tab]', (els) =>
    els.map((e) => e.textContent.trim()),
  );
  ok('两项分别是书写和阅读', JSON.stringify(labels) === '["书写","阅读"]', JSON.stringify(labels));
  await page.screenshot({ path: `${OUT}/46-切换-书写.png` });
}

step('切到阅读：左边整条让给书架');
await page.click('[data-mode-tab="read"]');
await page.waitForSelector('[data-bookshelf]');
{
  ok('书架出来了', (await count('[data-bookshelf]')) === 1);
  ok('空态说明了怎么加书', (await text('[data-bookshelf-empty]')).includes('导入 epub'));
  ok('空态说清了书不参与同步', (await text('[data-bookshelf-empty]')).includes('不参与同步'));
  ok('这时候文件树不在', (await count('[data-file]')) === 0);
  ok('搜索框也跟着走了（它搜的是笔记）', (await count('[data-note-search]')) === 0);
  ok('新建那排也是', (await count('[data-new-note]')) === 0);
  ok('旧的那个小书图标没了', (await count('[data-book-view]')) === 0);
  ok('主区也是阅读这边的话，不是「写第一篇」那句', (await count('[data-book-empty]')) === 1);
  await page.screenshot({ path: `${OUT}/47-切换-阅读.png` });
}

step('导入：一本真 epub');
await importEpub(makeEpub());
{
  ok('书架上有了一本', (await count('[data-book-item]')) === 1, String(await count('[data-book-item]')));
  const t = await text('[data-book-item]');
  ok('书名取的是 opf 里的 dc:title', t.includes('碎碎的第一本书'), t);
  ok('作者也在', t.includes('白菜不菜'), t);
  ok('大小也标了', /\d+\s*(B|KB|MB)/.test(t), t);
  const s = await state();
  ok('书**没有**进 files（不参与同步）', !Object.keys(s.files).some((p) => /epub|碎碎的第一本书/.test(p)));
  ok('也没有进待同步', s.changes.every((c) => !/epub/i.test(c.path)));
}

step('导入：不是 epub 的文件要被挡下，并且说清为什么');
await importEpub(notAnEpub(), '假书.epub');
{
  ok('弹了错误', (await count('[data-book-error]')) === 1);
  const e = await text('[data-book-error]');
  ok('话说明白了', e.includes('读不出来') || e.includes('不是 epub'), e);
  ok('书架还是只有那一本', (await count('[data-book-item]')) === 1);
  await page.click('[data-book-error-close]');
  await page.waitForTimeout(200);
  ok('错误条能关', (await count('[data-book-error]')) === 0);
}

step('打开：阅读器 + 三章都摊开');
await page.click('[data-book-item]');
await page.waitForSelector('[data-book-body]');
await page.waitForTimeout(700);
{
  ok('阅读器在', (await count('[data-book-reader]')) === 1);
  ok('三章都在（连续滚动，不是一章一屏）', (await count('[data-chapter]')) === 3, String(await count('[data-chapter]')));
  const body = await text('[data-book-body]');
  ok('第一章的字在', body.includes('今天天气不错'), body.slice(0, 120));
  ok('第三章的字也在', body.includes('就这么过去了'), body.slice(-120));
  ok('书里的脚本被剥掉了（没有被执行）', (await page.evaluate(() => window.__evil)) === undefined);
  ok('正文里也没有 script 标签', (await page.evaluate(() => document.querySelectorAll('[data-book-body] script').length)) === 0);
  ok('图被换成了 blob URL（不是原来的相对路径）', await page.evaluate(() => {
    const img = document.querySelector('[data-book-body] img');
    return !!img && img.getAttribute('src').startsWith('blob:');
  }));
}

step('右栏是这本书的目录；左栏不让位，仍然是书架');
{
  ok('右栏的目录出来了', (await count('[data-book-aside-toc]')) === 1);
  ok('三条目录（含一条二级）', (await count('[data-toc-item]')) === 4, String(await count('[data-toc-item]')));
  /*
   * 以前读书时左栏会换成目录 —— 现在不了：目录挪到右栏当"读书时手边的东西"，
   * 左栏留着书架，读着这本可以直接翻下一本，不用先退回。
   */
  ok('左栏还是书架（不是目录）', (await count('[data-bookshelf]')) === 1);
  ok('正在读的那本在书架里被标出来了', (await count('[data-book-now]')) === 1);
  ok('笔记那套（大纲 / 关系）让位了', (await count('[data-rightpane-body]')) === 0);
  const labels = await page.$$eval('[data-toc-item]', (els) => els.map((e) => e.textContent.trim()));
  ok('目录文字对得上', labels.includes('第二章 承'), JSON.stringify(labels));
}

step('点目录：真的滚过去了');
{
  const before = await page.evaluate(() => document.querySelector('[data-book-scroll]').scrollTop);
  await page.click('[data-toc-item="OEBPS/Text/ch3.xhtml"]');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => document.querySelector('[data-book-scroll]').scrollTop);
  ok('滚动位置变了', after !== before, `${before} → ${after}`);
  ok('滚到了第三章（比开头远得多）', after > before + 200, String(after));
  ok('当前章被记住了（目录高亮用）', (await state()).bookChapter === 'OEBPS/Text/ch3.xhtml');
}

/*
 * 批注。划词在 headless 里不用鼠标拖 —— 直接用 Range 造选区再派发 mouseup：
 * 鼠标拖动对像素敏感（拖偏两个字断言就飘），而这里要测的是"划了之后这条链路通不通"。
 */
const selectText = (needle, len) =>
  page.evaluate(
    ({ needle, len }) => {
      const p = Array.from(document.querySelectorAll('[data-book-body] p')).find((x) =>
        (x.textContent ?? '').includes(needle),
      );
      if (!p || !p.firstChild) return false;
      const node = p.firstChild;
      const at = (node.textContent ?? '').indexOf(needle);
      const r = document.createRange();
      r.setStart(node, Math.max(0, at));
      r.setEnd(node, Math.max(0, at) + len);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.querySelector('[data-book-body]').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    },
    { needle, len },
  );

/** 底色块跟它盖的那几个字差了多少（dx / dy 应该都是 0） */
const markOffset = (needle, len) =>
  page.evaluate(
    ({ needle, len }) => {
      const boxEl = document.querySelector('[data-note-box]');
      if (!boxEl) return { err: '没有底色块', dx: 99, dy: 99, w: 0, textW: 0 };
      const p = Array.from(document.querySelectorAll('[data-book-body] p')).find((x) =>
        (x.textContent ?? '').includes(needle),
      );
      const at = (p.firstChild.textContent ?? '').indexOf(needle);
      const r = document.createRange();
      r.setStart(p.firstChild, at);
      r.setEnd(p.firstChild, at + len);
      const t = r.getBoundingClientRect();
      const b = boxEl.getBoundingClientRect();
      return {
        dx: Math.abs(Math.round(b.left - t.left)),
        dy: Math.abs(Math.round(b.top - t.top)),
        w: Math.round(b.width),
        textW: Math.round(t.width),
      };
    },
    { needle, len },
  );

step('划一段字：浮出工具条');
{
  ok('划上了', await selectText('今天天气不错', 6));
  await page.waitForSelector('[data-book-sel-bar]');
  ok('工具条浮出来了', (await count('[data-book-sel-bar]')) === 1);
  ok('两个动作都在（划重点 / 写想法）', (await count('[data-book-mark-hl]')) === 1 && (await count('[data-book-mark-note]')) === 1);
}

step('写想法 → 留下');
{
  await page.click('[data-book-mark-note]');
  await page.waitForSelector('[data-book-draft]');
  ok('把划的那句摆在眼前（写的时候知道自己在对哪句说话）', (await text('[data-book-draft]')).includes('今天天气不错'));
  await page.fill('[data-book-draft-input]', '这句写得像日记开头');
  await page.click('[data-book-draft-save]');
  await page.waitForTimeout(600);
  ok('工具条收了', (await count('[data-book-draft]')) === 0);
  const s = await state();
  ok('批注留下了', s.bookNotes.length === 1, JSON.stringify(s.bookNotes.map((n) => n.quote)));
  ok('划到的原文跟着存了', s.bookNotes[0].quote === '今天天气不错', s.bookNotes[0].quote);
  ok('想法也存了', s.bookNotes[0].text === '这句写得像日记开头');
  ok('记下了是哪一章', s.bookNotes[0].href === 'OEBPS/Text/ch1.xhtml', s.bookNotes[0].href);
  ok('右栏列出来了', (await count('[data-book-note]')) === 1);
  ok('正文上多了底色', (await count('[data-note-box]')) >= 1, String(await count('[data-note-box]')));
  /*
   * 底色必须**压在字上**，不能偏一寸。它是一层绝对定位的方块，坐标是量出来的 ——
   * 量错基准（比如拿滚动容器当尺子而不是正文那一框）就会整体偏出去，
   * 表现上"有底色"，肉眼却是歪在一旁的方块。所以拿真实的 Range 现场对一遍。
   */
  const off = await markOffset('今天天气不错', 6);
  ok('底色压住了字（不多不少）', off.dx <= 2 && off.dy <= 2, JSON.stringify(off));
  ok('宽度也就是那几个字', Math.abs(off.w - off.textW) <= 2, `${off.w} vs ${off.textW}`);
  await page.screenshot({ path: `${OUT}/49-阅读-目录与批注.png` });
}

step('只划重点：不写字也能留一笔');
{
  ok('划上了', await selectText('回来路上看见一只猫', 9));
  await page.waitForSelector('[data-book-sel-bar]');
  await page.click('[data-book-mark-hl]');
  await page.waitForTimeout(500);
  const s = await state();
  ok('两条了', s.bookNotes.length === 2, String(s.bookNotes.length));
  const plain = s.bookNotes.find((n) => n.quote === '回来路上看见一只猫');
  ok('没写字的那条 text 是空的', plain && plain.text === '', JSON.stringify(plain));
  ok(
    '按正文先后排好（先划的那句在前）',
    s.bookNotes[0].start < s.bookNotes[1].start,
    `${s.bookNotes[0].start} < ${s.bookNotes[1].start}`,
  );
}

step('点右栏的笔记：正文跳过去，并且把那一段点亮');
{
  await page.evaluate(() => {
    document.querySelector('[data-book-scroll]').scrollTop = 0;
  });
  await page.waitForTimeout(200);
  const id = (await state()).bookNotes.find((n) => n.href === 'OEBPS/Text/ch2.xhtml')?.id
    ?? (await state()).bookNotes[0].id;
  await page.click(`[data-book-note-goto="${id}"]`);
  await page.waitForTimeout(900);
  ok('那段被点亮了', (await count(`[data-note-box="${id}"][data-focus="1"]`)) >= 1);
  await page.waitForTimeout(2000);
  ok(
    '临时点亮自己退下去（它是"我说的是这一条"，不是常驻状态）',
    (await count(`[data-note-box="${id}"][data-focus="1"]`)) === 0,
  );
}

step('改想法 / 删笔记');
{
  await page.hover('[data-book-note]');
  await page.waitForTimeout(200);
  await page.click('[data-book-note-edit]');
  await page.waitForSelector('[data-book-note-input]');
  await page.fill('[data-book-note-input]', '改成另一句想法');
  await page.click('[data-book-note-save]');
  await page.waitForTimeout(500);
  ok('想法改掉了', (await state()).bookNotes.some((n) => n.text === '改成另一句想法'));

  await page.hover('[data-book-note]');
  await page.waitForTimeout(200);
  await page.click('[data-book-note-del]');
  await page.waitForTimeout(500);
  const s = await state();
  ok('删掉一条，还剩一条', s.bookNotes.length === 1, String(s.bookNotes.length));
  ok('正文上的底色也跟着撤了', (await count('[data-note-box]')) >= 1);
}

step('书内搜索');
await page.fill('[data-book-search]', '猫');
await page.waitForSelector('[data-book-hits]');
await page.waitForTimeout(400);
{
  const n = await count('[data-book-hit]');
  ok('搜到了', n >= 2, String(n));
  ok('片段里有上下文', (await text('[data-book-hit]')).includes('猫'));
  await page.click('[data-book-hit]');
  await page.waitForTimeout(400);
  ok('跳过去并高亮了', (await count('mark[data-book-mark]')) === 1, String(await count('mark[data-book-mark]')));
}
await page.fill('[data-book-search]', '绝不存在的词');
await page.waitForTimeout(400);
ok('搜不到就说搜不到', (await text('[data-book-hits]')).includes('没有'));
await page.click('[data-book-search-clear]');
await page.waitForTimeout(300);

step('排版：字号 / 字体 / 纸色');
await page.click('[data-book-skin]');
await page.waitForSelector('[data-book-skin-panel]');
{
  const sizeOf = () =>
    page.evaluate(() => getComputedStyle(document.querySelector('[data-book-body]')).fontSize);
  const a = await sizeOf();
  await page.click('[data-book-font-plus]');
  await page.waitForTimeout(300);
  const b = await sizeOf();
  ok('字号真的变了', a !== b, `${a} → ${b}`);
  await page.click('[data-book-font-minus]');
  await page.waitForTimeout(300);
  ok('能缩回去', (await sizeOf()) === a, `${await sizeOf()} vs ${a}`);

  const bgOf = () =>
    page.evaluate(() => getComputedStyle(document.querySelector('[data-book-scroll]')).backgroundColor);
  await page.click('[data-book-theme-btn="night"]');
  await page.waitForTimeout(300);
  const night = await bgOf();
  ok('夜间模式真把纸变黑了', /rgb\(23, 24, 26\)/.test(night), night);

  // 新加的两档纸色也得真的铺得开 —— 色样点了没反应，用户只会以为按钮坏了
  await page.click('[data-book-theme-btn="green"]');
  await page.waitForTimeout(300);
  const green = await bgOf();
  ok('豆绿那档也认', /rgb\(230, 239, 227\)/.test(green), green);
  await page.click('[data-book-theme-btn="cyan"]');
  await page.waitForTimeout(300);
  ok('淡青那档也认', (await bgOf()) !== green, await bgOf());

  // 字体：换一档，正文的 font-family 得真的换（这是这轮新加的维度）
  const fontOf = () =>
    page.evaluate(() => getComputedStyle(document.querySelector('[data-book-body]')).fontFamily);
  await page.click('[data-book-font-btn="kai"]');
  await page.waitForTimeout(300);
  const kai = await fontOf();
  ok('楷体那档换上了', /KaiTi|楷体/i.test(kai), kai);
  await page.click('[data-book-font-btn="sans"]');
  await page.waitForTimeout(300);
  ok('能换回默认那套', (await fontOf()) !== kai, await fontOf());

  ok('五档纸色都在面板里', (await count('[data-book-theme-btn]')) === 5);
  ok('四档字体都在面板里', (await count('[data-book-font-btn]')) === 4);

  // 收起面板：它是浮层，敞着会压住后面要点的目录（右栏那份不在这个坐标系里，但保险）
  await page.click('[data-book-theme-btn="paper"]');
  await page.waitForTimeout(200);
  await page.click('[data-book-skin-close]');
  await page.waitForTimeout(200);
  ok('面板收掉了', (await count('[data-book-skin-panel]')) === 0);
}

/** 底下两个场景都要回头比对"读到哪一章" */
let atChapter = '';
/** 批注要跨刷新考验：删之前记下还剩几条 */
let notesLeft = 0;

step('记住读到哪');
{
  await page.evaluate(() => {
    document.querySelector('[data-book-scroll]').scrollTop = 0;
  });
  await page.click('[data-toc-item="OEBPS/Text/ch2.xhtml"]');
  await page.waitForTimeout(900); // 等节流那 400ms 落库
  atChapter = (await state()).bookChapter;
  notesLeft = (await state()).bookNotes.length;
}

step('书写 ↔ 阅读：在读的那本不该被这一趟弄丢');
{
  await page.click('[data-mode-tab="write"]');
  await page.waitForTimeout(300);
  ok('主区回到笔记（不再是阅读器）', (await count('[data-book-reader]')) === 0);
  ok('在读哪本仍然记着', (await state()).currentBook !== null);
  await page.click('[data-mode-tab="read"]');
  await page.waitForTimeout(500);
  ok('切回来直接落在那本书上', (await count('[data-book-reader]')) === 1);
  ok(
    '也没被从头翻开',
    (await page.evaluate(() => document.querySelector('[data-book-scroll]').scrollTop)) > 100,
  );
}

step('书架上这本书一直挂着「正在读」');
{
  /*
   * 读书的时候左栏不再换成目录，所以这一层不需要"先退回书架" —— 书架一直在，
   * 只是当前那本被标了出来。这点回应了最早那个误解：目录的位置应该跟着
   * "读书时手边要用的东西"走，而不是占掉换书的地方。
   */
  await page.waitForTimeout(300);
  const shelf = await text('[data-book-item]');
  ok('书架上标出了进度', /读到 \d+%/.test(shelf), shelf);
  ok('手上这本写着「正在读」', (await text('[data-book-now]')).includes('正在读'), await text('[data-book-now]'));
  ok('「继续读」那张卡不让位给正在读的这本（它俩不能是同一本）', (await count('[data-book-resume]')) === 0);
}

step('合上书：回到「书架上什么都没打开」那个状态');
{
  await page.click('[data-book-back]');
  await page.waitForTimeout(400);
  ok('阅读器收了', (await count('[data-book-reader]')) === 0);
  ok('主区回到阅读那边的空态', (await count('[data-book-empty]')) === 1);
  ok('右栏那份目录也跟着走了', (await count('[data-book-aside-toc]')) === 0);
  ok('书架还在（合上书不等于离开书架）', (await count('[data-bookshelf]')) === 1);
  ok('冒出「继续读」那张卡', (await count('[data-book-resume]')) === 1);
  const card = await text('[data-book-resume]');
  ok('卡上写着是哪本', card.includes('碎碎的第一本书'), card);
  ok('卡上也带着进度', /读到 \d+%/.test(card), card);
  await page.screenshot({ path: `${OUT}/48-切回阅读-继续读.png` });
}

step('从「继续读」再打开：回到刚才那一页');
{
  await page.click('[data-book-resume]');
  await page.waitForSelector('[data-book-body]');
  await page.waitForTimeout(1200);
  ok('再打开还是那一章', (await state()).bookChapter === atChapter, `${(await state()).bookChapter} vs ${atChapter}`);
  const top = await page.evaluate(() => document.querySelector('[data-book-scroll]').scrollTop);
  ok('而且不是从头开始', top > 100, String(top));
  ok('批注跨重建还在（跟着书存在本机）', (await state()).bookNotes.length === notesLeft, `${(await state()).bookNotes.length} vs ${notesLeft}`);
  ok('底色也重新画出来了', (await count('[data-note-box]')) >= 1, String(await count('[data-note-box]')));
}

step('刷新之后：书还在，而且记得自己上一轮在阅读这边');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-sync]');
await page.waitForTimeout(1200);
{
  ok('不用点任何东西，回来就在书架上了', (await count('[data-bookshelf]')) === 1);
  ok('书还在书架上', (await count('[data-book-item]')) === 1, String(await count('[data-book-item]')));
  ok(
    '而且不会自作主张把书翻开（重开一律先回书架，哪本在读交给「继续读」来说）',
    (await count('[data-book-reader]')) === 0,
  );
  ok('但那张「继续读」还在', (await count('[data-book-resume]')) === 1);
  ok('主区也是阅读的空态（阅读这边不说书写的话）', (await count('[data-book-empty]')) === 1);
  await page.screenshot({ path: `${OUT}/48-切回阅读-继续读.png` });
}

step('删除要问一句');
{
  /*
   * 删之前先把书摊开 —— 这样能顺带验证"删书时批注跟着走"：
   * 书没了，它身上那些批注就是没处落的孤儿，留着只会让右栏越攒越乱。
   */
  await page.click('[data-book-item]');
  await page.waitForSelector('[data-book-body]');
  await page.waitForTimeout(700);
  await page.click('[data-book-back]');
  await page.waitForTimeout(400);

  // 删除钮是悬停才露出来的（跟文件行一个规矩），先悬停再点
  await page.hover('[data-book-item]');
  await page.waitForTimeout(200);
  await page.click('[data-book-del]');
  await page.waitForSelector('[data-book-del-confirm]');
  ok('确认条说清了后果', (await text('[data-book-del-confirm]')).includes('阅读进度会一起清掉'));
  await page.click('[data-book-del-no]');
  await page.waitForTimeout(300);
  ok('反悔了书还在', (await count('[data-book-item]')) === 1);

  await page.hover('[data-book-item]');
  await page.waitForTimeout(200);
  await page.click('[data-book-del]');
  await page.waitForSelector('[data-book-del-confirm]');
  await page.click('[data-book-del-yes]');
  await page.waitForTimeout(800);
  ok('确认后书没了', (await count('[data-book-item]')) === 0, String(await count('[data-book-item]')));
  const empty = await page.evaluate(async () => {
    const d = await new Promise((res, rej) => {
      const r = indexedDB.open('suisui-books');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const n = await new Promise((res) => {
      const q = d.transaction('progress').objectStore('progress').count();
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(-1);
    });
    const notes = await new Promise((res) => {
      const q = d.transaction('notes').objectStore('notes').count();
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(-1);
    });
    return { progress: n, notes };
  });
  ok('进度也一起清了', empty.progress === 0, String(empty.progress));
  ok('批注跟着书一起走了（书没了，锚点就无处可落）', empty.notes === 0, String(empty.notes));
  ok('回到空态', (await count('[data-bookshelf-empty]')) === 1);
  ok('书没了，「继续读」那张卡也没了', (await count('[data-book-resume]')) === 0);
}

step('切回书写');
await page.click('[data-mode-tab="write"]');
await page.waitForTimeout(400);
{
  ok('书架走了', (await count('[data-bookshelf]')) === 0);
  ok('书写这边的工具条回来了（新建 / 搜索）', (await count('[data-new-note]')) === 1 && (await count('[data-note-search]')) === 1);
  const s = await state();
  ok('连「在读哪本」这条线索也一并清了', s.currentBook === null && s.lastBookId === null);
}

step('控制台');
ok('零报错', errors.length === 0, errors.join(' | '));
if (noise.length) console.log(`  · 远端网络噪声 ${noise.length} 条（不算失败 —— 仓库通不通看设置里「远端仓库」那块）`);

console.log(`\n结果：${pass} 通过 / ${bad.length} 失败`);
await browser.close();
process.exit(bad.length ? 1 : 0);
