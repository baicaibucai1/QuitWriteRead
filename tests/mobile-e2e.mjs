// 移动端端到端：抽屉、工具栏横滚、触摸尺寸、顶栏/状态栏精简，外加桌面端不回归。
//
//   node tests/mobile-e2e.mjs
//
// 视口取 Pixel 7 的 CSS 像素，并带 isMobile / hasTouch —— 少了这两个，
// 浏览器不会按移动端处理，媒体查询和触摸行为都验不到。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { watchConsole } from './remote-noise.mjs';

// Playwright 会把本机 http_proxy 透传进浏览器（端口每次还不一样）→ 必须清掉
for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[k];
}

const { chromium } = createRequire('C:/AI_Production/QQbot/')('playwright');

const URL = process.env.DEMO_URL ?? 'http://localhost:5183';
const OUT = 'C:/AI_Production/suisui-app/shots/mobile';
fs.mkdirSync(OUT, { recursive: true });

const PIXEL = { width: 412, height: 915 };
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

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

const errors = [];

/** 造点数据：两篇 md。直接喂 store，不绕 UI —— 这里验的是布局，不是创建流程。 */
const seed = (p) =>
  p.evaluate(() => {
    window.__suisui.setState({
      files: {
        'thoughts/2026-09-21-开张.md': '# 开张\n\n第一篇。\n',
        'notes/2026-09-21-随手.md': '# 随手\n\n记一笔。\n',
      },
      current: 'thoughts/2026-09-21-开张.md',
      changes: [],
      showAll: false,
      drawer: false,
    });
  });

// ============================ 手机 ============================
step('手机视口（412×915）');
const page = await browser.newPage({
  viewport: PIXEL,
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent: ANDROID_UA,
});
/*
 * 「零报错」只数**应用自己**的：pageerror + 来自开发服务器的 console error。
 * 第三方（api.github.com）那条是浏览器替网络记的账 —— 仓库通不通由设置里
 * 「远端仓库」那一块说，不由这条断言说。判法见 ./remote-noise.mjs。
 *
 * ⚠️ 这里**沿用上面那个 `errors`**：底下还有别的页面（桌面视口那几个）往里推
 * pageerror，换成新数组会把它们的账丢掉。
 */
const noise = [];
watchConsole(page, { errors, noise });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
await seed(page);
await page.waitForTimeout(500);

{ // 视口确实是手机的
  const vw = await page.evaluate(() => window.innerWidth);
  ok('视口宽度是 412（媒体查询真的进了移动端分支）', vw === 412, String(vw));
  const rootH = await page.evaluate(() => document.getElementById('root').getBoundingClientRect().height);
  ok('#root 铺满视口高度（dvh 生效）', Math.abs(rootH - 915) <= 2, String(rootH));
}

step('抽屉：默认收起');
{
  ok('汉堡按钮在手机上是可见的', await page.locator('[data-drawer-toggle]').isVisible());
  const box = await page.locator('[data-drawer]').boundingBox();
  ok('侧栏默认停在屏幕左侧外', box !== null && box.x + box.width <= 1, JSON.stringify(box));
  ok('遮罩没渲染', (await page.locator('[data-drawer-mask]').count()) === 0);
  ok('正文区是整屏宽', (await page.locator('main').boundingBox()).width >= 411);
  await page.screenshot({ path: `${OUT}/01-默认收起.png` });
}

step('抽屉：打开 / 关掉');
{
  await page.click('[data-drawer-toggle]');
  await page.waitForTimeout(420);
  const box = await page.locator('[data-drawer]').boundingBox();
  ok('滑入后贴住左边缘', box !== null && Math.abs(box.x) < 2, JSON.stringify(box));
  ok('抽屉宽度不超过屏宽（没糊满整屏）', box.width < 412 * 0.9, String(box.width));
  ok('遮罩出现', await page.locator('[data-drawer-mask]').isVisible());

  // 点遮罩**露在外面的那部分**，不能点几何中心 —— 抽屉盖在左边，中心其实落在抽屉上
  const gap = 412 - (box.x + box.width);
  ok('抽屉右侧留出的空白够手指按（≥100px）', gap >= 100, `${Math.round(gap)}px`);
  await page.screenshot({ path: `${OUT}/02-抽屉打开.png` });

  const maskBox = await page.locator('[data-drawer-mask]').boundingBox();
  await page.mouse.click(maskBox.x + maskBox.width - 24, maskBox.y + maskBox.height / 2);
  await page.waitForTimeout(420);
  const back = await page.locator('[data-drawer]').boundingBox();
  ok('点遮罩后收回屏幕外', back.x + back.width <= 1, JSON.stringify(back));
}

step('抽屉：选完文件自动收起');
{
  await page.click('[data-drawer-toggle]');
  await page.waitForTimeout(400);
  await page.click('[data-file="notes/2026-09-21-随手.md"]');
  await page.waitForTimeout(500);
  const cur = await page.evaluate(() => window.__suisui.getState().current);
  ok('打开的是点中的那篇', cur === 'notes/2026-09-21-随手.md', String(cur));
  const box = await page.locator('[data-drawer]').boundingBox();
  ok('抽屉自己收起来了（不用再点一次）', box.x + box.width <= 1, JSON.stringify(box));
}

step('md 工具栏：横滚而不是换行');
{
  const t = await page.evaluate(() => {
    const el = document.querySelector('[data-md-toolbar]');
    const cs = getComputedStyle(el);
    return { wrap: cs.flexWrap, scrollW: el.scrollWidth, clientW: el.clientWidth, h: el.getBoundingClientRect().height };
  });
  ok('不换行', t.wrap === 'nowrap', t.wrap);
  ok('内容比容器宽（说明确实要横滚）', t.scrollW > t.clientW, `scrollW=${t.scrollW} clientW=${t.clientW}`);
  ok('工具栏只有一行高（换行会变成两三行）', t.h < 60, String(t.h));

  // 滚到底，确认能滚
  const scrolled = await page.evaluate(() => {
    const el = document.querySelector('[data-md-toolbar]');
    el.scrollLeft = 9999;
    return el.scrollLeft;
  });
  ok('能横向滚动', scrolled > 0, String(scrolled));

  const btn = await page.evaluate(() => {
    const b = document.querySelector('[data-md="bold"]').getBoundingClientRect();
    return { w: b.width, h: b.height };
  });
  ok('按钮高度 ≥36px（手指点得着）', btn.h >= 36, `${btn.w}×${btn.h}`);
  await page.screenshot({ path: `${OUT}/03-md工具栏.png` });
}

step('顶栏 / 状态栏：手机上只留必要的');
{
  /*
   * 顶栏**回来了**（骨架重做那次），但手机上只留它该留的两段：
   * 书写 / 阅读的切换 + 当前文件路径。收栏那两颗箭头是 `hidden md:flex`
   * —— 手机上左栏是抽屉（归状态栏 ☰ 管）、右栏压根不渲染，
   * 给出去就是两颗按了没反应的按钮。
   */
  ok('顶栏只有一条', (await page.locator('header').count()) === 1);
  ok('手机上没有收栏的箭头', !(await page.locator('[data-left-toggle]').isVisible()));
  ok('右栏开关在手机上也不出现', !(await page.locator('[data-right-toggle]').isVisible()));
  /*
   * 同步**不在状态栏了** —— 它搬回了左栏底上的 dock，挨着设置（用户要求）。
   * dock 那三颗都带字（"刷新差异" / "同步" / "设置"）：纯图标方钮那次被人问过
   * "这个按钮哪里像设置"，字是故意加回来的，所以这儿不再断言"文字藏干净"。
   * 手机上 dock 跟着抽屉进来（抽屉宽 min(80vw,292px)，三颗带字放得下）。
   */
  ok('同步在 dock 里（不在状态栏）', (await page.locator('[data-dock] [data-sync]').count()) === 1);
  ok('状态栏上没有同步按钮了', (await page.locator('footer.status-bar [data-sync]').count()) === 0);
  const footSpans = await page.evaluate(() =>
    [...document.querySelectorAll('footer.status-bar span')]
      .filter((s) => s.offsetParent !== null)
      .map((s) => s.textContent.trim()),
  );
  ok('状态栏只剩状况（不再夹一个同步按钮）', !footSpans.some((t) => t === '同步'), JSON.stringify(footSpans));

  const statusSpans = await page.evaluate(() =>
    [...document.querySelectorAll('footer span')]
      .filter((s) => s.offsetParent !== null)
      .map((s) => s.textContent.trim()),
  );
  ok('状态栏不再堆文件数/凭据/时间', !statusSpans.some((t) => /个文件|凭据|同步于/.test(t)), JSON.stringify(statusSpans));
}

/*
 * 正文在手机上没被挤扁。
 * 这条原先验的是稿纸（富文本），富文本 2026-09-26 整块删掉之后改验 md 正文 ——
 * 要看的是"纸上那块字"在 412px 里站不站得住，跟用哪套编辑器无关。
 */
step('正文：左右都没溢出，也没被缩成小字');
{
  await page.click('[data-drawer-toggle]');
  await page.waitForTimeout(400);
  await page.click('[data-file="notes/2026-09-21-随手.md"]');
  await page.waitForTimeout(1200);

  const doc = await page.evaluate(() => {
    const el = document.querySelector('.milkdown-wrap .ProseMirror');
    const r = el.getBoundingClientRect();
    return { w: r.width, left: r.left, fontSize: getComputedStyle(el).fontSize };
  });
  ok('正文左右都没溢出屏幕', doc.left >= 0 && doc.left + doc.w <= 412, JSON.stringify(doc));
  ok('正文没被缩成小字', parseFloat(doc.fontSize) >= 15, doc.fontSize);
  await page.screenshot({ path: `${OUT}/04-正文不挤扁.png` });
}

step('触摸设备上不该出现「只有 hover 才出来」的删除按钮');
{
  await page.click('[data-drawer-toggle]');
  await page.waitForTimeout(400);
  const delVisible = await page.evaluate(() => {
    // 非当前文件行上的删除按钮：桌面是 group-hover 才显示，触摸屏上没有 hover
    const rows = [...document.querySelectorAll('[data-file]')];
    return rows
      .filter((r) => !r.className.includes('bg-surface '))
      .map((r) => r.querySelector('button'))
      .filter((b) => b && b.offsetParent !== null).length;
  });
  ok('未选中行上没有常显的删除按钮', delVisible === 0, String(delVisible));
  await page.click('[data-drawer-toggle]');
  await page.waitForTimeout(300);
}

step('PWA 清单');
{
  const m = await page.evaluate(async () => {
    const r = await fetch('/manifest.webmanifest');
    return { status: r.status, json: await r.json() };
  });
  ok('manifest 能取到且是合法 JSON', m.status === 200 && !!m.json.name, JSON.stringify(m).slice(0, 120));
  ok('display 是 standalone（装到主屏后没有地址栏）', m.json.display === 'standalone', m.json.display);
  ok('start_url 是根路径', m.json.start_url === '/', m.json.start_url);
  const sizes = (m.json.icons ?? []).map((i) => i.sizes);
  ok('带了 192 与 512 两种尺寸', sizes.includes('192x192') && sizes.includes('512x512'), JSON.stringify(sizes));
  ok(
    '带了 maskable（安卓自绘图标形状）',
    (m.json.icons ?? []).some((i) => i.purpose === 'maskable'),
    JSON.stringify(m.json.icons),
  );

  const iconOk = await page.evaluate(async () => {
    const r = await fetch('/icons/icon-512.png');
    const b = await r.blob();
    return { status: r.status, type: b.type, size: b.size };
  });
  ok('图标文件真的是 PNG', iconOk.status === 200 && iconOk.type === 'image/png' && iconOk.size > 1000, JSON.stringify(iconOk));
}

await page.close();

// ============================ 桌面 ============================
step('桌面（1500×920）：一个字都不该变');
{
  const d = await browser.newPage({ viewport: { width: 1500, height: 920 } });
  d.on('pageerror', (e) => errors.push('desktop pageerror: ' + e.message.slice(0, 200)));
  await d.goto(URL, { waitUntil: 'domcontentloaded' });
  await d.waitForTimeout(2200);
  await seed(d);
  await d.waitForTimeout(400);

  ok('汉堡按钮隐藏（桌面不需要抽屉把手）', !(await d.locator('[data-drawer-toggle]').isVisible()));

  const box = await d.locator('[data-drawer]').boundingBox();
  ok('侧栏常驻、272px、贴着左边缘', Math.abs(box.x) < 1 && Math.abs(box.width - 272) < 1, JSON.stringify(box));

  ok('桌面上顶栏也只有一条', (await d.locator('header').count()) === 1);
  ok('收栏那两颗箭头在桌面出现', await d.locator('[data-left-toggle]').isVisible());
  ok('同步按钮文字回来了（dock 那三颗都带字）', await d.locator('[data-sync] span').isVisible());
  ok('同步在 dock 里，挨着设置', (await d.locator('[data-dock] [data-sync]').count()) === 1);

  const statusSpans = await d.evaluate(() =>
    [...document.querySelectorAll('footer span')].filter((s) => s.offsetParent !== null).map((s) => s.textContent.trim()),
  );
  ok('状态栏还是原来那几项', statusSpans.some((t) => /个文件/.test(t)), JSON.stringify(statusSpans));

  const t = await d.evaluate(() => getComputedStyle(document.querySelector('[data-md-toolbar]')).flexWrap);
  ok('桌面工具栏仍是可换行的', t === 'wrap', t);
  await d.screenshot({ path: `${OUT}/05-桌面未受影响.png` });
  await d.close();
}

// ======================= 手机壳预览页 =======================
// mobile.html 把应用放进真机尺寸的 iframe。iframe 有自己的视口，
// 所以里面的 @media (max-width:768px) 是按【壳的宽度】求值的 —— 这一节就是验这件事。
step('手机壳预览页（public/mobile.html）');
{
  const sh = await browser.newPage({ viewport: { width: 1500, height: 920 } });
  sh.on('pageerror', (e) => errors.push('shell pageerror: ' + e.message.slice(0, 200)));
  await sh.goto(URL + '/mobile.html', { waitUntil: 'domcontentloaded' });
  await sh.waitForTimeout(2400);

  const app = () => sh.frames().find((f) => f.url().endsWith('/') || /\/\?/.test(f.url()));

  ok('壳页标题对', (await sh.title()).includes('手机预览'), await sh.title());
  ok('iframe 套着应用', (await app()) !== undefined);

  // 默认机型 Pixel 7 → 里面必须是手机布局
  {
    const inner = await app().evaluate(() => ({
      vw: window.innerWidth,
      vh: window.innerHeight,
      toggle: document.querySelector('[data-drawer-toggle]')
        ? getComputedStyle(document.querySelector('[data-drawer-toggle]')).display
        : 'missing',
    }));
    ok('iframe 视口就是 412×915（不是把桌面版缩小）', inner.vw === 412 && inner.vh === 915, JSON.stringify(inner));
    ok('里面渲染的是手机布局（汉堡按钮可见）', inner.toggle !== 'none' && inner.toggle !== 'missing', inner.toggle);

    const meta = await sh.locator('#meta').textContent();
    ok('脚注报出了视口尺寸', /412×915/.test(meta), meta);
    ok('脚注认得出这是手机布局', /手机布局/.test(meta), meta);

    // 空状态看不出布局好坏，喂点数据再拍
    await seed(app());
    await sh.waitForTimeout(700);
    await sh.screenshot({ path: `${OUT}/07-手机壳.png` });

    const fl = sh.frameLocator('#screen');
    await fl.locator('[data-drawer-toggle]').click();
    await sh.waitForTimeout(520);
    ok('壳里面也能点（抽屉能打开）', await fl.locator('[data-drawer-mask]').isVisible());
    await sh.screenshot({ path: `${OUT}/08-手机壳-抽屉.png` });
    await fl.locator('[data-drawer-toggle]').click();
    await sh.waitForTimeout(420);
  }

  // 切机型 → 里面跟着变
  {
    await sh.click('[data-device="桌面 1280"]');
    await sh.waitForTimeout(500);
    const inner = await app().evaluate(() => {
      const t = document.querySelector('[data-drawer-toggle]');
      const d = document.querySelector('[data-drawer]').getBoundingClientRect();
      return { vw: window.innerWidth, toggle: getComputedStyle(t).display, drawer: { x: d.x, w: d.width } };
    });
    ok('切到桌面 1280 后 iframe 跟着变宽', inner.vw === 1280, String(inner.vw));
    ok('里面退回桌面布局（汉堡按钮消失）', inner.toggle === 'none', inner.toggle);
    ok('侧栏变回常驻的 272px 列', Math.abs(inner.drawer.x) < 1 && Math.abs(inner.drawer.w - 272) < 1, JSON.stringify(inner.drawer));
    ok('脚注跟着改成桌面布局', /桌面布局/.test(await sh.locator('#meta').textContent()));
  }

  // 断点两侧各测一档。边界是 `width < 48rem`（＝768px 本身算桌面），
  // 别按「768 算手机」的直觉写 —— 那样会假红。
  for (const [label, expectMobile] of [['临界 767', true], ['临界 768', false]]) {
    await sh.click(`[data-device="${label}"]`);
    await sh.waitForTimeout(420);
    const t = await app().evaluate(() => getComputedStyle(document.querySelector('[data-drawer-toggle]')).display);
    ok(`${label}：${expectMobile ? '仍是手机布局' : '已切到桌面布局'}`, (t !== 'none') === expectMobile, t);
  }

  // 旋转 & 缩放
  await sh.click('[data-device="Pixel 7"]');
  await sh.waitForTimeout(350);
  await sh.click('#rotate');
  await sh.waitForTimeout(350);
  const rot = await app().evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  ok('旋转后宽高对调', rot.w === 915 && rot.h === 412, JSON.stringify(rot));
  const slot = await sh.locator('#slot').boundingBox();
  ok('缩放后槽位不超出容器（居中算对了）', slot.width <= 1500, JSON.stringify(slot));

  await sh.close();
}

await browser.close();

step('结果');
console.log(`  通过 ${pass}，失败 ${bad.length}`);
if (bad.length) console.log('  失败项：\n' + bad.map((b) => '    - ' + b).join('\n'));
if (errors.length) {
  console.log(`  控制台错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 8)) console.log('    ! ' + e);
}
console.log(`  截图在 ${OUT}`);
if (noise.length) console.log(`  远端网络噪声 ${noise.length} 条（不算失败 —— 仓库通不通看设置里「远端仓库」那块）`);
process.exit(bad.length || errors.length ? 1 : 0);
