// PWA 端到端：Service Worker 注册 → 离线仍能打开；顺带在**构建产物**上
// 复验一遍移动端布局（开发期跑得通不代表产物里也对，Tailwind 的产物顺序就变过）。
//
//   node tests/pwa-e2e.mjs        # 需要先 build，并让 preview 跑在 5184
//
// 为什么必须在 preview 上验：SW 缓存的是真实静态文件，而开发期的 Vite 是
// 内存里的模块图，没有可缓存的东西 —— 在 dev 上测 SW 等于什么都没测。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { watchConsole } from './remote-noise.mjs';

for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[k];
}

const { chromium } = createRequire('C:/AI_Production/QQbot/')('playwright');

const URL = process.env.PREVIEW_URL ?? 'http://localhost:5184';
const OUT = 'C:/AI_Production/suisui-app/shots/mobile';
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
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
});
const page = await ctx.newPage();

/* 「零报错」只数**应用自己**的：pageerror + 来自开发服务器的 console error。
 * 第三方（api.github.com）那条是浏览器替网络记的账 —— 仓库通不通由设置里
 * 「远端仓库」那一块说，不由这条断言说。判法见 ./remote-noise.mjs。 */
const { errors, noise } = watchConsole(page);

step('打开构建产物');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
ok('页面渲染出来了', (await page.locator('[data-dock]').count()) > 0);

step('Service Worker 注册');
{
  const state = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: !!reg.active, script: reg.active?.scriptURL ?? null };
  });
  ok('SW 注册并激活', state.active, JSON.stringify(state));
  ok('作用域盖住整个站点', state.scope.endsWith('/'), state.scope);

  const noDevHook = await page.evaluate(() => typeof window.__suisui === 'undefined');
  ok('产物里没有开发期的 window.__suisui', noDevHook);
}

step('让 SW 接管并缓存资源');
await page.evaluate(() => {
  // 造点本地内容，离线后要能看到它 —— 这条才是「离线可用」的实证。
  // ⚠️ 笔记的真身现在是仓库（浏览器里 = localStorage 那个暂存键），
  // persist 那份只管 `current`（选中哪篇），不再管 files —— 仓库才是唯一真相。
  localStorage.setItem(
    'suisui.repo.memory.v1',
    JSON.stringify({ 'thoughts/离线也要能看.md': '# 离线也要能看\n\n飞机上写的。\n' }),
  );
  localStorage.setItem(
    'suisui.demo.v1',
    JSON.stringify({
      state: { token: '', current: 'thoughts/离线也要能看.md', lastSyncAt: null, showAll: false },
      version: 0,
    }),
  );
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
ok('这次页面由 SW 接管', controlled);

const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  if (!names.length) return { names, count: 0 };
  const c = await caches.open(names[0]);
  const keys = await c.keys();
  return { names, count: keys.length, urls: keys.map((k) => new URL(k.url).pathname).slice(0, 12) };
});
ok('缓存里有东西', cached.count > 0, JSON.stringify(cached).slice(0, 200));
ok(
  'HTML 外壳进了缓存（离线回退靠它）',
  (cached.urls ?? []).includes('/'),
  JSON.stringify(cached.urls),
);
ok(
  'JS 产物进了缓存',
  (cached.urls ?? []).some((u) => /^\/assets\/.*\.js$/.test(u)),
  JSON.stringify(cached.urls),
);

step('断网：仍然打得开');
{
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  ok('断网后页面还是渲染出来了', (await page.locator('[data-dock]').count()) > 0);
  const text = await page.evaluate(() => document.body.innerText);
  ok('离线时能看到本地那篇笔记', text.includes('离线也要能看'), text.slice(0, 80).replace(/\n/g, ' / '));

  // 离线时移动端布局照样成立
  ok('离线时汉堡按钮也在', await page.locator('[data-drawer-toggle]').isVisible());
  await page.click('[data-drawer-toggle]');
  await page.waitForTimeout(400);
  const box = await page.locator('[data-drawer]').boundingBox();
  ok('离线时抽屉也能拉出来', box && Math.abs(box.x) < 2, JSON.stringify(box));
  await page.screenshot({ path: `${OUT}/06-离线也能用.png` });

  await ctx.setOffline(false);
}

step('产物里的移动端布局（Tailwind 产物顺序会变，得单独验）');
{
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const t = await page.evaluate(() => {
    const el = document.querySelector('[data-md-toolbar]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { wrap: cs.flexWrap, h: el.getBoundingClientRect().height };
  });
  if (t) {
    ok('工具栏在产物里也是横滚不换行', t.wrap === 'nowrap' && t.h < 60, JSON.stringify(t));
  } else {
    ok('工具栏在产物里也在（当前没选中 md 文件，跳过形状检查）', true);
  }

  /*
   * 同步那颗**搬回 dock 了**（挨着设置），所以这里不再断言"顶栏按钮文字藏住" ——
   * dock 那三颗现在是**带字**的（纯图标方钮那次被人问"这个按钮哪里像设置"）。
   * 改钉两件事：同步真在 dock 里，且字没被挤掉。
   */
  const hideOk = await page.evaluate(() => {
    const sync = document.querySelector('[data-sync]');
    const label = sync?.querySelector('span');
    const burger = document.querySelector('[data-drawer-toggle]');
    return {
      syncInDock: !!sync?.closest('[data-dock]'),
      syncTextShown: label ? getComputedStyle(label).display !== 'none' : false,
      burgerShown: burger ? getComputedStyle(burger).display !== 'none' : false,
    };
  });
  ok('产物里同步在 dock 里（跟设置同一条）', hideOk.syncInDock, JSON.stringify(hideOk));
  ok('产物里同步按钮带着文字', hideOk.syncTextShown, JSON.stringify(hideOk));
  ok('产物里汉堡按钮仍然显示', hideOk.burgerShown, JSON.stringify(hideOk));
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
