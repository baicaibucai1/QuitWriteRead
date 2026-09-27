// 三栏布局（参考 Obsidian）：右栏（大纲 + 关系）与左栏搜索框的端到端。
//
//   node tests/layout-e2e.mjs                      # 默认打开发服务器 5183
//   DEMO_URL=http://localhost:5184 node tests/layout-e2e.mjs
//
// 单测（tests/links.test.mjs 的大纲一节）验的是「解析得对不对」，
// 这里验的是「在页面上真的长出来、点得动、收得起」：
//   ① 右栏常驻（桌面 ≥768px），没开笔记时给说明，不白板
//   ② 大纲列出正文标题，点一下正文滚过去（所见即所得走 su-flash 高亮）
//   ③ 关系面板搬进右栏（同一份 data-backlinks，e2e 抓手不换）
//   ④ 顶栏按钮能把右栏收起 / 展开
//   ⑤ 左栏搜索框按文件名 / 标题过滤，Esc 和 × 都能清
//   ⑥ 手机（≤768px）右栏不渲染，关系面板回正文底部
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

/* 「零报错」只数**应用自己**的：pageerror + 来自开发服务器的 console error。
 * 第三方（api.github.com）那条是浏览器替网络记的账 —— 仓库通不通由设置里
 * 「远端仓库」那一块说，不由这条断言说。判法见 ./remote-noise.mjs。 */
const { errors, noise } = watchConsole(page);

const FILES = {
  'thoughts/2026-09-21-开张.md':
    '# 开张\n\n这是第一篇。\n\n## 第二段\n\n第二段的内容。\n\n## 第三段\n\n尾部内容。\n',
  'notes/2026-09-21-随手.md': '# 随手\n\n想起 [[开张]]，这条是 #灵感。\n',
  'drafts/2026-09-20-购物清单.md': '# 购物清单\n\n牛奶、鸡蛋。\n',
};

const openApp = async () => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.desk');
  await page.waitForTimeout(600);
  await page.evaluate((files) => {
    window.__suisui.setState({ files, current: null, token: '', tagFilter: null, drawer: false });
  }, FILES);
  await page.waitForTimeout(600);
};

/** 打开一篇并等编辑器就绪 */
const openNote = async (cur) => {
  await page.evaluate(() => window.__suisui.setState({ current: null }));
  await page.waitForTimeout(300);
  await page.evaluate((c) => window.__suisui.setState({ current: c }), cur);
  await page.waitForSelector('.ProseMirror', { timeout: 15000 });
  await page.waitForTimeout(900);
};

step('桌面：右栏常驻，没开笔记时有说明');
await openApp();
{
  const pane = page.locator('[data-rightpane]');
  ok('右栏在页面上', (await pane.count()) === 1);
  ok('右栏可见', await pane.isVisible());
  const txt = await pane.textContent();
  ok('空态有说明文字', txt.includes('打开一篇笔记'), txt.slice(0, 60));
}

step('大纲：列出标题，点一下正文滚过去');
await openNote('thoughts/2026-09-21-开张.md');
{
  const items = page.locator('[data-outline-item]');
  ok('三个标题都列出来', (await items.count()) === 3, String(await items.count()));
  const texts = await items.evaluateAll((els) => els.map((e) => e.textContent));
  ok('顺序对', texts.join('|') === '开张|第二段|第三段', texts.join('|'));

  // 点「第三段」：正文里那个 heading 会拿到 su-flash 高亮（跳转成功的记号）
  await items.nth(2).click();
  await page.waitForTimeout(700);
  const flashed = await page.evaluate(() => {
    const el = document.querySelector('.ProseMirror .su-flash');
    return el ? el.textContent : null;
  });
  ok('跳转后目标小节闪了一下', flashed !== null && flashed.includes('第三段'), String(flashed));
}
await page.screenshot({ path: `${OUT}/22-右栏大纲.png` });

step('关系面板搬进了右栏');
{
  const pane = page.locator('[data-rightpane] [data-backlinks]');
  ok('关系面板在右栏里', (await pane.count()) === 1);
  const txt = await pane.textContent();
  ok('写着被引用', txt.includes('被引用'), txt.slice(0, 80));

  // 打开一篇只有一级标题、没有关系的：右栏给轻提示，而不是整节消失
  await openNote('thoughts/2026-09-21-开张.md');
  await openNote('drafts/2026-09-20-购物清单.md');
  ok('没关系的篇给轻提示', (await page.locator('[data-rel-empty]').count()) === 1);
  const ol = await page.locator('[data-outline-item]').allTextContents();
  ok('只有文档标题自己', ol.join('|') === '购物清单', ol.join('|'));
}
await page.screenshot({ path: `${OUT}/23-右栏关系.png` });

/*
 * 右栏的收起 / 展开：开关**在顶栏上**（`TopBar` 的 `data-right-toggle`）。
 *
 * 为什么它不能长在右栏自己头上：栏一收起，按钮就跟栏一起没了 ——
 * 人只能靠猜把它叫回来。早先的补救是在原处留一条 18px 的窄轨当第二入口，
 * 但那条轨的前提是错的（开关已经常驻在顶栏了），于是白占 18px 且没人认得出
 * 那是按钮。现在收起 = 整列消失，要回来点顶栏那颗。
 *
 * ⚠️ 同一时刻 `[data-right-toggle]` 必须只有**一个**：右栏和书的目录栏
 * （BookAside）里原先各有一颗，Playwright 的 strict 模式会当场撞车。
 */
step('右栏的收起 / 展开（开关在顶栏，收起后整列消失、不留窄轨）');
{
  const sw = page.locator('[data-topbar] [data-right-toggle]');
  ok('顶栏上有这颗开关', (await sw.count()) === 1);
  ok('右栏开着时它标着开', (await sw.getAttribute('data-on')) === '1');

  await sw.click();
  await page.waitForTimeout(300);
  ok('点它收起', (await page.locator('[data-rightpane]').count()) === 0);
  ok('它跟着标成关', (await sw.getAttribute('data-on')) === '0');
  ok(
    '收起后没有留下窄轨（整列消失，开关还在顶栏）',
    (await page.locator('[data-right-toggle]').count()) === 1,
  );

  await sw.click();
  await page.waitForTimeout(300);
  ok('再点它回来', (await page.locator('[data-rightpane]').count()) === 1);
}

/*
 * 左栏的收起 / 展开：同一条道理 —— 开关在顶栏，收起是**整列消失**。
 * 早先左栏收起时在边上留过一条窄轨，跟右栏那条一样的毛病：占地方、没人认得出。
 */
step('左栏的收起 / 展开（同样是顶栏那颗，收起后整列消失）');
{
  const sw = page.locator('[data-topbar] [data-left-toggle]');
  ok('顶栏上有左栏那颗开关', (await sw.count()) === 1);
  ok('左栏开着时它标着开', (await sw.getAttribute('data-on')) === '1');

  await sw.click();
  await page.waitForTimeout(300);
  ok('点它收起', (await page.locator('[data-drawer]').count()) === 0);
  ok('它跟着标成关', (await sw.getAttribute('data-on')) === '0');

  // 左栏没了，但"我在哪一半、打开的是谁"还在 —— 那两段归顶栏，不归左栏
  ok('收起后顶栏还在', (await page.locator('[data-topbar]').count()) === 1);
  // ⚠️ 得带 role：`[data-mode]` 会同时抓到编辑器里「所见即所得 / 源码」那对按钮
  ok(
    '书写 / 阅读的切换还在（它长在顶栏，不随左栏走）',
    (await page.locator('[role="tablist"][data-mode]').count()) === 1,
  );

  await sw.click();
  await page.waitForTimeout(300);
  ok('再点它回来', (await page.locator('[data-drawer]').count()) === 1);
}

/*
 * 这一屏另外两个跟"同步"有关的位置：
 *   ① 同步纽 —— **在 dock 里**（左栏底上，挨着设置；2026-09-26 从状态栏搬回来的）。
 *      钩子 data-sync 没改名，但**位置**变了，得钉住它真在那一列里，
 *      且状态栏上**没有第二颗**（同一动作两个入口，人只会不知道该点哪个）；
 *   ② A− / A+ —— 调写笔记界面的正文字号（store 的 editorFont → CSS 变量 → .milkdown-wrap）。
 *      量的是渲染出来的像素，不是 store 里的数 —— 变量在哪一环断了这条都会红。
 */
step('同步在 dock（挨着设置），A± 在状态栏且调得动字号');
{
  const aside = await page.locator('[data-drawer]').boundingBox();
  const sync = await page.locator('[data-sync]').boundingBox();
  ok('同步钮在左栏那条里', !!sync && !!aside && sync.x < aside.x + aside.width, JSON.stringify(sync));
  ok('同步钮是小钮（宽 < 120px）', !!sync && sync.width < 120, sync ? String(sync.width) : 'no');
  ok('状态栏上没有第二颗同步', (await page.locator('footer.status-bar [data-sync]').count()) === 0);
  ok('A− / A+ 都在', (await page.locator('[data-editor-font-minus]').count()) === 1 && (await page.locator('[data-editor-font-plus]').count()) === 1);

  // 打开一篇，量渲染出来的字号
  await openNote('thoughts/2026-09-21-开张.md');
  const sizeOf = () =>
    page.evaluate(
      () => getComputedStyle(document.querySelector('.milkdown-wrap .ProseMirror')).fontSize,
    );
  const a = await sizeOf();
  await page.click('[data-editor-font-plus]');
  await page.waitForTimeout(300);
  const b = await sizeOf();
  ok('A+ 之后正文变大', parseFloat(b) > parseFloat(a), `${a} → ${b}`);
  await page.click('[data-editor-font-minus]');
  await page.click('[data-editor-font-minus]');
  await page.waitForTimeout(300);
  const c = await sizeOf();
  ok('A− 两次后比初始还小一档', parseFloat(c) < parseFloat(a), `${a} → ${c}`);

  // 还原到出厂档，别把这套字号留给后面的用例（手机段换页面会重开，但稳妥为先）
  await page.click('[data-editor-font-plus]');
  await page.evaluate(() => window.__suisui.setState({ current: null }));
  await page.waitForTimeout(300);
  const persisted = await page.evaluate(() => {
    const raw = localStorage.getItem('suisui.demo.v1');
    return raw ? JSON.parse(raw)?.state?.editorFont : undefined;
  });
  ok('字号进了 persist（下次打开还是这份）', typeof persisted === 'number', String(persisted));
}

/*
 * 两侧边栏的宽度能拖。
 *
 * 这条压的是三件"看着能动、其实不一定真动"的事：
 *   ① 拖完之后**渲染出来的宽度**真的变了（不是只有一条线跟着走）；
 *   ② 松手才落盘 —— 拖动中若每次都写 persist，那份里装着整个 files，手感会糊；
 *      所以这里验的是"松手后 store 里是最终值"，而不是过程中的某个中间值；
 *   ③ 刷新后还在（persist 里真的有它）。
 *   ④ 手机上没有这两条：那一侧是浮上来的抽屉，宽度由视口定，没有"调"这回事。
 */
step('两侧边栏可以拖动调宽度');
{
  const widthOf = (sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().width, sel);
  const storeW = (key) => page.evaluate((k) => window.__suisui.getState()[k], key);

  ok('左栏有一条分隔条', (await page.locator('[data-resizer="left"]').count()) === 1);
  ok('右栏也有一条', (await page.locator('[data-resizer="right"]').count()) === 1);

  // 左栏：往右拖 60px（分隔条在主区的左边，往右 = 这一列变宽）
  const leftBar = await page.locator('[data-resizer="left"]').boundingBox();
  const beforeL = await widthOf('[data-drawer]');
  await page.mouse.move(leftBar.x + leftBar.width / 2, leftBar.y + leftBar.height / 2);
  await page.mouse.down();
  await page.mouse.move(leftBar.x + 60, leftBar.y + leftBar.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterL = await widthOf('[data-drawer]');
  ok('左栏拖宽了', afterL > beforeL + 40, `${beforeL} → ${afterL}`);
  ok('松手后 store 里是最终值', (await storeW('sidebarL')) === Math.round(afterL), `${await storeW('sidebarL')} vs ${afterL}`);

  // 右栏：往左拖 50px（分隔条在主区的右边，往左 = 这一列变宽）
  const rightBar = await page.locator('[data-resizer="right"]').boundingBox();
  const beforeR = await widthOf('[data-rightpane]');
  await page.mouse.move(rightBar.x + rightBar.width / 2, rightBar.y + rightBar.height / 2);
  await page.mouse.down();
  await page.mouse.move(rightBar.x - 50, rightBar.y + rightBar.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterR = await widthOf('[data-rightpane]');
  ok('右栏拖宽了', afterR > beforeR + 30, `${beforeR} → ${afterR}`);

  // 上限：怎么拖都不会把正文挤没
  const rb = await page.locator('[data-resizer="right"]').boundingBox();
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x - 900, rb.y + rb.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  ok('拖到底也不超过上限 520', (await widthOf('[data-rightpane]')) <= 520, String(await widthOf('[data-rightpane]')));
  ok('正文还有地方（没被挤成 0）', (await widthOf('main')) > 100, String(await widthOf('main')));

  // 双击复位
  await page.locator('[data-resizer="right"]').dblclick();
  await page.waitForTimeout(300);
  ok('双击右栏分隔条复位到 250', (await widthOf('[data-rightpane]')) === 250, String(await widthOf('[data-rightpane]')));

  // 刷新后还在（左栏那个被拖宽的值）
  const kept = await storeW('sidebarL');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-drawer]');
  await page.waitForTimeout(700);
  ok('刷新后宽度还在（进了 persist）', Math.abs((await widthOf('[data-drawer]')) - kept) < 1.5, `${kept} → ${await widthOf('[data-drawer]')}`);
  await page.screenshot({ path: `${OUT}/24-侧栏拖动.png` });
}

step('左栏搜索框：文件名 / 标题过滤');
{
  const box = page.locator('[data-note-search]');
  ok('搜索框在', (await box.count()) === 1);
  await box.fill('随手');
  await page.waitForTimeout(300);
  const hits = page.locator('[data-file]');
  ok('按名字命中一篇', (await hits.count()) === 1, String(await hits.count()));
  ok('命中是「随手」', (await hits.first().getAttribute('data-file')) === 'notes/2026-09-21-随手.md');
  ok('横幅写了命中数', (await page.locator('[data-search-banner]').textContent()).includes('1 篇'));

  // 标题也能搜：文件名是 2026-09-20-购物清单.md，搜「购物」靠标题命中
  await box.fill('购物');
  await page.waitForTimeout(300);
  ok('按标题命中', (await page.locator('[data-file]').count()) === 1);

  await box.fill('查无此篇');
  await page.waitForTimeout(300);
  ok('没命中给空态', (await page.locator('[data-search-empty]').count()) === 1);

  await page.locator('[data-note-search-clear]').click();
  await page.waitForTimeout(300);
  ok('× 清空后整棵树回来', (await page.locator('[data-file]').count()) === 3);

  await box.fill('随手');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('Esc 也能清', (await page.locator('[data-file]').count()) === 3);
}
await page.screenshot({ path: `${OUT}/24-搜索过滤.png` });

/*
 * 「待同步」只给结论、不给清单：大多数时候人只想知道"有几项待推 / 待拉"，
 * 一条条文件名既是噪音也会把文件树挤掉半屏。要看再点抬头那一行展开。
 * ⚠️ 收的是**清单**，不是状态 —— 抬头上的计数、空态那两条提示都不能跟着收。
 */
step('待同步：具体文件默认收着，点抬头才展开');
{
  const setChanges = (changes, planStale = false) =>
    page.evaluate((v) => window.__suisui.setState({ ...v, showAll: false, token: '' }), { changes, planStale });

  await setChanges([
    { path: 'notes/a.md', kind: 'push-modify' },
    { path: 'notes/b.md', kind: 'push-add' },
    { path: 'thoughts/c.md', kind: 'pull-modify' },
  ]);
  await page.waitForTimeout(350);
  const box = async () => (await page.locator('[data-changes]').boundingBox()).height;

  ok('默认一条文件都不列', (await page.locator('[data-change-row]').count()) === 0);
  ok('开关说"没展开"', (await page.getAttribute('[data-changes-toggle]', 'aria-expanded')) === 'false');
  const h0 = await box();
  ok('收着的时候只占一行', h0 < 60, Math.round(h0) + 'px');
  const head = ((await page.textContent('[data-changes]')) ?? '').replace(/\s+/g, ' ');
  ok('计数照旧在（收的是清单，不是"有没有差异"）', head.includes('2 待推送') && head.includes('1 待拉取'), head);
  ok('总项数也在', head.includes('3 项'), head);

  await page.click('[data-changes-toggle]');
  await page.waitForTimeout(300);
  ok('点一下：文件出来了', (await page.locator('[data-change-row]').count()) === 3);
  ok('开关说"已展开"', (await page.getAttribute('[data-changes-toggle]', 'aria-expanded')) === 'true');
  ok('展开后确实把那块撑高了', (await box()) > 60, Math.round(await box()) + 'px');

  await page.click('[data-change-row="thoughts/c.md"]');
  await page.waitForTimeout(300);
  ok('点文件照样跳到那篇', (await page.evaluate(() => window.__suisui.getState().current)) === 'thoughts/c.md');

  await page.click('[data-changes-toggle]');
  await page.waitForTimeout(300);
  ok('再点一下又收起来', (await page.locator('[data-change-row]').count()) === 0);

  // 一条差异都没有时，那两条提示是"现在要不要同步"的答案 —— 不能跟着收起
  await setChanges([]);
  await page.waitForTimeout(300);
  /*
   * 文案 2026-09-27 改过：同步改成"推送"之后，空态该说的是**这个范围里没有要推的**，
   * 而不是"本地和远端一致" —— 后者在"范围只圈了 thoughts/"时是撒谎
   * （远端可能有一堆别的文件的更新，只是没进范围）。
   */
  ok('无差异时说"范围里没有要推的"', ((await page.textContent('[data-changes]')) ?? '').includes('范围里没有要推的'));
  ok('无差异时没有那个开关', (await page.locator('[data-changes-toggle]').count()) === 0);
  await setChanges([], true);
  await page.waitForTimeout(300);
  ok('没比对时说"还没比对"', ((await page.textContent('[data-changes]')) ?? '').includes('还没比对'));
}
await page.screenshot({ path: `${OUT}/25-待同步收起.png` });

step('手机（≤768px）：右栏不渲染，关系面板回正文底部');
{
  const d = await browser.newPage({ viewport: { width: 412, height: 915 } });
  d.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message.slice(0, 200)));
  await d.goto(URL, { waitUntil: 'domcontentloaded' });
  await d.waitForSelector('.desk');
  await d.waitForTimeout(600);
  await d.evaluate((files) => {
    window.__suisui.setState({ files, current: null, token: '', tagFilter: null, drawer: false });
  }, FILES);
  await d.evaluate(() => window.__suisui.setState({ current: 'notes/2026-09-21-随手.md' }));
  await d.waitForSelector('.ProseMirror', { timeout: 15000 });
  await d.waitForTimeout(900);
  ok('右栏不在 DOM 里', !(await d.locator('[data-rightpane]').isVisible()));
  ok('关系面板在正文底部', (await d.locator('.sheet [data-backlinks]').count()) === 1);
  ok('搜索框还在抽屉里', (await d.locator('[data-note-search]').count()) === 1);
  // 手机上那两侧是浮上来的抽屉 / 干脆不渲染，宽度由视口定 —— 分隔条不该出现，
  // 出现就是一条 6px 的"怎么按都没反应"的缝
  ok('手机上没有左栏分隔条', !(await d.locator('[data-resizer="left"]').isVisible()));
  ok('手机上也没有右栏分隔条', !(await d.locator('[data-resizer="right"]').isVisible()));
  await d.screenshot({ path: `${OUT}/25-手机底部关系.png` });
  await d.close();
}

await browser.close();

console.log(`\n结果：${pass} 通过 / ${bad.length} 失败`);
if (errors.length) {
  console.log('\n页面报错（前几条）：');
  for (const e of errors.slice(0, 6)) console.log('  ' + e);
}
if (noise.length) console.log(`
远端网络噪声 ${noise.length} 条（不算失败 —— 仓库通不通看设置里「远端仓库」那块）`);

process.exit(bad.length || errors.length ? 1 : 0);
