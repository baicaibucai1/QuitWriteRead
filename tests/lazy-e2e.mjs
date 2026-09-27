// 「编辑器按需加载」的端到端验证。
//
//   node tests/lazy-e2e.mjs                          # 只看构建产物 + 开发服务器（默认）
//   DEMO_URL=http://localhost:5184 node tests/lazy-e2e.mjs
//
// 背景：编辑器（Milkdown / Crepe / KaTeX）压缩后 1.1MB，而首屏真正需要的只有顶栏和文件列表。
// 拆开之后主包只有 260KB —— 但这件事**一旦被改回静态 import 就完全看不出来**
// （功能全对，只是首屏白白多下 1MB），所以必须拿测试钉住。
//
// 验三层：
//   ① 构建产物：入口 chunk 里不该有编辑器的东西，且它确实被拆到了别的 chunk
//   ② 运行时：进页面不请求编辑器模块；没选文件时是空态（压根没挂编辑器）
//   ③ 加载中：把编辑器模块拦慢，骨架必须出现（否则手机上那几秒像"点了没反应"）
//
// ⚠️ 构建产物里没有 `window.__suisui`（那是 DEV 才挂的调试口），所以那里改成
//    往 localStorage 塞一份持久化状态再刷新 —— 两条路都走一遍，省得只在 DEV 绿。
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { watchConsole } from './remote-noise.mjs';

for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[k];
}
const { chromium } = createRequire('C:/AI_Production/QQbot/')('playwright');

const DEV = 'http://localhost:5183';
const PREVIEW = process.env.DEMO_URL ?? 'http://localhost:5184';
const ROOT = 'C:/AI_Production/suisui-app';

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

const FILES = {
  'thoughts/2026-09-21-开张.md': '# 开张\n\n第一篇。\n',
  'notes/2026-09-21-随手.md': '# 随手\n\n记一笔。\n',
};
const MD = 'thoughts/2026-09-21-开张.md';

/** 往页面里塞几篇文件但不选中。DEV 走调试口，构建产物走 localStorage + 刷新。 */
async function seed(page, url) {
  const viaDebug = await page.evaluate((files) => {
    if (!window.__suisui) return false;
    window.__suisui.setState({ files, current: null, changes: [], showAll: false, drawer: false });
    return true;
  }, FILES).catch(() => false);

  if (viaDebug) {
    await page.waitForTimeout(500);
    return;
  }
  await page.evaluate((files) => {
    // ⚠️ 笔记的真身现在是**仓库**（浏览器里 = localStorage 那个暂存键）——
    // 往 persist 那份里塞 files 已经没用了：它不再从那儿恢复（仓库才是唯一真相）。
    localStorage.setItem('suisui.repo.memory.v1', JSON.stringify(files));
  }, FILES);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-sync]', { timeout: 15000 });
  await page.waitForTimeout(400);
}

const editorReqs = (asked) => asked.filter((u) => /EditorPane/i.test(u));

// ==================== ① 构建产物：入口包里没有编辑器 ====================
step('构建产物');
if (!existsSync(join(ROOT, 'dist/assets'))) {
  ok('dist/assets 存在（没构建就先跑 scripts/build.mjs）', false);
} else {
  const idx = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  // 只数 <script src>：rolldown 会给入口再配一个 <link rel=modulepreload> 的
  // runtime 垫片（约 1KB），那是构建器的运行时，不是"第二个入口脚本" —— 别把它数进去。
  const entryRefs = [...idx.matchAll(/<script[^>]+src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  ok('index.html 只引一个入口 js', entryRefs.length === 1, `引了 ${entryRefs.length} 个`);

  const entryName = entryRefs[0]?.replace('/assets/', '');
  const entrySize = entryName ? statSync(join(ROOT, 'dist/assets', entryName)).size : 0;
  const entry = entryName ? readFileSync(join(ROOT, 'dist/assets', entryName), 'utf8') : '';
  const kb = (n) => Math.round(n / 1024);
  for (const mark of ['katex', 'milkdown', 'prosemirror', 'crepe']) {
    ok(`入口 chunk 不含 ${mark}`, !new RegExp(mark, 'i').test(entry));
  }
  ok('入口 chunk 小于 600KB', entry.length > 0 && entry.length < 600 * 1024, `实际 ${kb(entry.length)}KB`);

  // 编辑器得真的被拆出去，不能是"整个丢了"
  const others = readdirSync(join(ROOT, 'dist/assets'))
    .filter((f) => f.endsWith('.js') && f !== entryName)
    .map((f) => [f, statSync(join(ROOT, 'dist/assets', f)).size])
    .sort((a, b) => b[1] - a[1]);
  const hit = others.filter(([f]) => /katex|prosemirror|milkdown|crepe/i.test(readFileSync(join(ROOT, 'dist/assets', f), 'utf8')));
  ok('编辑器被拆成了独立 chunk', hit.length > 0);
  ok('编辑器 chunk 名字带 EditorPane（便于运行时识别）', hit.some(([f]) => /^EditorPane/.test(f)), hit.map(([f]) => f).join(', '));
  console.log(`     入口 ${kb(entrySize)}KB　编辑器 ${hit.map(([, z]) => kb(z) + 'KB').join(' + ') || '(没找到)'}`);
}

// ==================== ②③ 运行时 ====================
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
/* 「零报错」只数**应用自己**的：pageerror + 来自开发服务器的 console error。
 * 第三方（api.github.com）那条是浏览器替网络记的账 —— 判法见 ./remote-noise.mjs。
 * ⚠️ 一个套件会连开好几个页面，所以账收在同一个 sink 里。 */
const sink = { errors: [], noise: [] };
const { errors, noise } = sink;
const watch = (page) => watchConsole(page, sink);

step(`运行时（构建产物 ${PREVIEW}）`);
{
  const page = await browser.newPage();
  watch(page);
  const asked = [];
  page.on('request', (r) => asked.push(r.url()));

  await page.goto(PREVIEW, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-sync]', { timeout: 15000 });
  await page.waitForTimeout(800);

  ok('首屏本来就是空态', await page.locator('[data-editor-empty]').isVisible());
  ok('首屏没有请求编辑器 chunk', editorReqs(asked).length === 0, editorReqs(asked).join(', '));

  await seed(page, PREVIEW);
  ok('喂完数据仍是空态（没自动选中）', await page.locator('[data-editor-empty]').isVisible());
  ok('喂完数据也没拉编辑器', editorReqs(asked).length === 0, editorReqs(asked).join(', '));

  await page.click(`[data-file="${MD}"]`);
  await page.waitForSelector('.milkdown', { timeout: 20000 });
  const after = editorReqs(asked);
  ok('点开文件后才请求编辑器 chunk', after.length > 0, `请求 ${after.length} 次`);
  ok('拿的确实是 /assets/EditorPane-*.js', after.some((u) => /\/assets\/EditorPane-[^/]+\.js/.test(u)), after.join(', '));
  ok('编辑器挂上了（md 那条线）', (await page.locator('.milkdown').count()) > 0);
  ok('空态让位了', (await page.locator('[data-editor-empty]').count()) === 0);
  await page.close();
}

step(`加载中给骨架（开发服务器 ${DEV}）`);
{
  const page = await browser.newPage();
  watch(page);

  // 慢放编辑器模块：真机上那 1.1MB 就是这个体感
  await page.route('**/EditorPane*', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await page.goto(DEV, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-sync]', { timeout: 15000 });
  await seed(page, DEV);

  await page.click(`[data-file="${MD}"]`);
  const shown = await page.locator('[data-editor-loading]').isVisible().catch(() => false);
  ok('加载中出现了骨架', shown);
  if (shown) {
    const txt = await page.locator('[data-editor-loading]').innerText();
    ok('骨架里写明了在打开编辑器', /正在打开编辑器/.test(txt));
    /*
     * 路径**不在骨架里报了**（骨架重做那轮挪走的）：顶栏中间那条面包屑就是它，
     * 骨架再画一遍是同一个事实说两次。这里改钉顶栏 —— 骨架转圈的这一两秒里，
     * 人得能在顶栏看到"正在打开的是谁"，不然就是点了没反应。
     */
    ok('顶栏报出了路径', (await page.textContent('[data-topbar-path]'))?.includes(MD.split('/').pop() ?? ''), '');
  }
  await page.waitForSelector('.milkdown', { timeout: 20000 });
  ok('包到了之后编辑器正常挂上', (await page.locator('.milkdown').count()) > 0);
  ok('骨架撤掉了', (await page.locator('[data-editor-loading]').count()) === 0);
  await page.close();
}

await browser.close();

if (errors.length) {
  console.log('\n控制台错误：');
  for (const e of errors.slice(0, 8)) console.log('  ! ' + e);
}
console.log(`\n结果：${pass} 通过，${bad.length} 失败`);
if (bad.length) {
  for (const b of bad) console.log('  ✗ ' + b);
  process.exit(1);
}
if (noise.length) console.log(`
远端网络噪声 ${noise.length} 条（不算失败 —— 仓库通不通看设置里「远端仓库」那块）`);
process.exit(errors.length ? 1 : 0);
