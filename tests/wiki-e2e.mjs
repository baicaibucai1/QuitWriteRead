// 双链补完三件的端到端：
//   ① 标签全局视图（左栏「标签」按钮 → 全库标签 + 篇数 → 点进筛）
//   ② 未建链接批量创建（右栏「待建」全库扫 → 多选 → 一键建）
//   ③ `![[某篇]]` 嵌正文（真把那篇渲染进来，带抬头 + 打开原文）
//
//   node tests/wiki-e2e.mjs                        # 默认打开发服务器 5183
//   DEMO_URL=http://localhost:5184 node tests/wiki-e2e.mjs
//
// 单测（links.test.mjs 的 missingNotes 一节、embed.test.mjs）验的是「算得对不对」，
// 这里验的是「页面上真的长出来、点得动、建得出」。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { watchConsole } from './remote-noise.mjs';

for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[k];
}

const { chromium } = createRequire('C:/AI_Production/QQbot/')('playwright');

const URL = process.env.DEMO_URL ?? 'http://localhost:5183';
const OUT = 'C:/AI_Production/suisui-app/shots/ui';
fs.mkdirSync(OUT, { recursive: true });

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
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });

/* 「零报错」只数**应用自己**的：pageerror + 来自开发服务器的 console error。
 * 第三方（api.github.com）那条是浏览器替网络记的账 —— 仓库通不通由设置里
 * 「远端仓库」那一块说，不由这条断言说。判法见 ./remote-noise.mjs。 */
const { errors, noise } = watchConsole(page);

/*
 * 库的布局是有讲究的：
 *   - `#灵感` 被两篇用过（用来验"标签视图按用量排序"）；
 *   - `[[读书笔记]]` 被 notes/ 两篇引用（验"落点 = 引用最多的目录"）；
 *   - `[[散记]]` 只被 thoughts/ 一篇引用；
 *   - notes/主篇.md 里嵌了 notes/被嵌.md（验嵌正文）。
 */
const FILES = {
  'thoughts/2026-09-21-开张.md':
    '# 开张\n\n这是第一篇，标 #灵感，还引了 [[散记]]。\n',
  'notes/2026-09-21-主篇.md':
    '# 主篇\n\n标 #灵感。见 [[读书笔记]]。\n\n![[被嵌]]\n',
  'notes/2026-09-22-另一篇.md': '# 另一篇\n\n也提 [[读书笔记]]。\n',
  'notes/2026-09-22-被嵌.md': '# 被嵌\n\n**这段是从别处搬来的正文。**\n\n## 它的小节\n\n小节内容。\n',
};

const openApp = async () => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.desk');
  await page.waitForTimeout(600);
  await page.evaluate((files) => {
    window.__suisui.setState({
      files,
      current: null,
      token: '',
      tagFilter: null,
      drawer: false,
      rightOpen: true,
      showAll: false,
    });
  }, FILES);
  await page.waitForTimeout(600);
};

const openNote = async (cur) => {
  await page.evaluate(() => window.__suisui.setState({ current: null }));
  await page.waitForTimeout(300);
  await page.evaluate((c) => window.__suisui.setState({ current: c }), cur);
  await page.waitForSelector('.ProseMirror', { timeout: 15000 });
  await page.waitForTimeout(900);
};

step('标签全局视图：左栏按钮 → 全库标签 + 篇数');
await openApp();
{
  // 默认是文件树，没有标签列表
  ok('默认不显示标签列表', (await page.locator('[data-tag-list]').count()) === 0);

  await page.click('[data-tag-view]');
  await page.waitForTimeout(400);
  ok('点按钮后标签列表出现', (await page.locator('[data-tag-list]').count()) === 1);

  const items = await page.locator('[data-tag-item]').all();
  ok('列出全库标签', items.length === 1, `共 ${items.length} 个`);
  ok('标签是「灵感」', (await items[0].getAttribute('data-tag-item')) === '灵感');
  const txt = await items[0].textContent();
  ok('带篇数 2', /2/.test(txt ?? ''), txt ?? '');

  // 点一个标签 → 进筛选（tagHits 那条路），标签列表让位
  await items[0].click();
  await page.waitForTimeout(500);
  ok('点标签后进了筛选', (await page.locator('[data-tag-filter]').count()) === 1);
  ok('筛选横幅写着 #灵感', ((await page.locator('[data-tag-filter]').textContent()) ?? '').includes('灵感'));
  ok('标签列表让位了', (await page.locator('[data-tag-list]').count()) === 0);

  // 选中带这个标签的篇数
  const hits = await page.locator('[data-file]').all();
  ok('筛出两篇', hits.length === 2, `共 ${hits.length} 篇`);

  await page.click('[data-tag-clear]');
  await page.waitForTimeout(400);
  ok('退出筛选回到文件树', (await page.locator('[data-tag-filter]').count()) === 0);
}
await page.screenshot({ path: `${OUT}/28-标签视图.png` });

step('未建链接批量创建：全库扫 + 多选 + 一键建');
{
  await openNote('notes/2026-09-21-主篇.md');

  const pane = page.locator('[data-missing-pane]');
  ok('右栏有「待建」块', (await pane.count()) === 1);

  const targets = await page.locator('[data-missing-item]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-missing-item')),
  );
  // 读书笔记（notes 两篇引）+ 散记（thoughts 一篇引）
  ok('扫出两个待建目标', targets.length === 2, targets.join(', '));
  ok('按被引用次数排（读书笔记在前）', targets[0] === '读书笔记', targets.join(', '));

  // 落点：引用最多的那个目录
  const firstText = await page.locator('[data-missing-item="读书笔记"]').textContent();
  ok('读书笔记建到 notes/', (firstText ?? '').includes('notes/'), firstText ?? '');
  const secondText = await page.locator('[data-missing-item="散记"]').textContent();
  ok('散记建到 thoughts/', (secondText ?? '').includes('thoughts/'), secondText ?? '');

  // 默认全不选：按钮是禁用的
  ok('默认没选中，建按钮禁用', await page.locator('[data-missing-build]').isDisabled());

  await page.click('[data-missing-all]');
  await page.waitForTimeout(200);
  ok('全选后按钮可用', !(await page.locator('[data-missing-build]').isDisabled()));

  await page.click('[data-missing-build]');
  await page.waitForTimeout(900);

  // 建完：files 里多了两篇，且落点对
  const made = await page.evaluate(() => Object.keys(window.__suisui.getState().files));
  ok('notes/ 多了读书笔记', made.some((p) => p.startsWith('notes/') && p.includes('读书笔记')), made.join(', '));
  ok('thoughts/ 多了散记', made.some((p) => p.startsWith('thoughts/') && p.includes('散记')), made.join(', '));
  ok('给了"建好了"回执', (await page.locator('[data-missing-done]').count()) === 1);
  ok('待建列表空了（都建完了）', (await page.locator('[data-missing-item]').count()) === 0);

  // 建完不该抢焦点 —— current 还是原来那篇
  ok('没有切走当前笔记', (await page.evaluate(() => window.__suisui.getState().current)) === 'notes/2026-09-21-主篇.md');
}
await page.screenshot({ path: `${OUT}/29-待建批量.png` });

step('![[某篇]] 嵌正文：真渲染进来 + 抬头可点');
{
  await openNote('notes/2026-09-21-主篇.md');

  // 等渲染器懒加载完成（插件会 refreshWiki，装饰重算把正文补上）
  await page
    .waitForFunction(() => document.querySelector('[data-note-embed]') !== null, { timeout: 15000 })
    .catch(() => {});

  const emb = page.locator('[data-note-embed]');
  ok('嵌入块出现了', (await emb.count()) >= 1, `共 ${await emb.count()} 个`);
  ok(
    '嵌的是被嵌那篇',
    (await emb.first().getAttribute('data-note-embed')) === 'notes/2026-09-22-被嵌.md',
    (await emb.first().getAttribute('data-note-embed')) ?? '',
  );

  const body = (await page.locator('.su-note-body').first().textContent()) ?? '';
  ok('正文渲染进来了', body.includes('这段是从别处搬来的正文'), body.slice(0, 80));
  ok('小节标题也在（降级成 p）', body.includes('它的小节'), body.slice(0, 80));

  const head = (await page.locator('.su-note-head').first().textContent()) ?? '';
  ok('抬头写着篇名', head.includes('被嵌'), head);
  ok('抬头有「打开原文」', head.includes('打开原文'), head);

  // 原始语法本身不该露出来（`![[被嵌]]` 那几个字被藏在 su-embed-src 里）
  const editorText = await page.locator('.ProseMirror').first().innerText();
  ok('没有把 ![[被嵌]] 当字显示', !editorText.includes('![[被嵌]]'), editorText.slice(0, 120));

  // 截图要在跳转**之前**拍 —— 跳过去之后这篇就不在屏幕上了
  await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    pm?.scrollIntoView({ block: 'start' });
  });
  await page.screenshot({ path: `${OUT}/30-嵌入正文.png` });

  // 点「打开原文」跳过去
  await page.locator('.su-note-open').first().click();
  await page.waitForTimeout(1200);
  const cur = await page.evaluate(() => window.__suisui.getState().current);
  ok('点「打开原文」跳到那篇', cur === 'notes/2026-09-22-被嵌.md', cur ?? '(null)');
}

step('防自嵌：正文里写 ![[本文]] 不炸');
{
  await page.evaluate(() => {
    const s = window.__suisui.getState();
    const p = 'notes/2026-09-22-自嵌.md';
    window.__suisui.setState({
      files: { ...s.files, [p]: '# 自嵌\n\n![[自嵌]]\n' },
      current: null,
    });
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__suisui.setState({ current: 'notes/2026-09-22-自嵌.md' }));
  await page.waitForSelector('.ProseMirror', { timeout: 15000 });
  await page.waitForTimeout(1500);

  // 自嵌被收成卡片（▤），不该无限展开 —— 页面还活着、没有第二个 su-note
  const nests = await page.locator('.su-note').count();
  ok('自嵌没有无限展开', nests === 0, `页面里有 ${nests} 个 su-note`);
  const alive = await page.locator('.ProseMirror').count();
  ok('编辑器还活着', alive > 0);
}

await browser.close();

step('结果');
console.log(`  通过 ${pass}，失败 ${bad.length}`);
if (bad.length) console.log('  失败项：\n' + bad.map((b) => '    - ' + b).join('\n'));
if (errors.length) {
  console.log(`  控制台错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 8)) console.log('    ! ' + e);
}
if (noise.length) console.log(`
远端网络噪声 ${noise.length} 条（不算失败 —— 仓库通不通看设置里「远端仓库」那块）`);

process.exit(bad.length || errors.length ? 1 : 0);