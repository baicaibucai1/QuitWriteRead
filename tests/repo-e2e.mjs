// 仓库（本机文件夹）的端到端。
//
//   node tests/repo-e2e.mjs                            # 默认打开发服务器 5183
//   DEMO_URL=http://localhost:5184 node tests/repo-e2e.mjs
//
// ⚠️ **只能跑 dev**：它靠 `window.__suisui`（只在 DEV 挂载）读仓库状态。
//
// 验的是"笔记的真身换成了磁盘／仓库之后"那几条**最容易悄悄坏掉**的事：
//   ① 浏览器里默认落在「暂存」上，且**不挡引导页**（启动就弹窗是弹不出来的）；
//   ② 建一篇笔记 → 刷新 → **还在**（真的落到仓库里了，不是只在内存）；
//   ③ localStorage 里那份 `files` **已经没有了** —— 仓库是唯一真相，
//      多一份就会出现"刷新前后不一致"这种没人能解释的现象；
//   ④ 改名之后仓库里 **旧路径没了、新路径有了**（存盘按差异写，最容易漏的就是删除）；
//   ⑤ 设置页把当前仓库**照实说出来**（暂存就说暂存，不粉饰成"已保存"）。
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

/*
 * 「零报错」只数**应用自己**的：pageerror + 来自开发服务器的 console error。
 * 第三方（api.github.com）那几条是浏览器替网络记的账 —— 仓库在不在、通不通
 * 由设置里「远端仓库」那一块说，不由这条断言说。判法见 ./remote-noise.mjs。
 */
const { errors, noise } = watchConsole(page);

/** 仓库里现在有哪些路径（暂存仓库 = localStorage 里那一坨） */
const repoPaths = () =>
  page.evaluate(() => {
    try {
      return Object.keys(JSON.parse(localStorage.getItem('suisui.repo.memory.v1') ?? '{}'));
    } catch {
      return [];
    }
  });
const state = (k) => page.evaluate((key) => window.__suisui.getState()[key], k);

step('启动：浏览器里自动落在「暂存」，不挡引导页');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-sync]');
await page.waitForFunction(() => window.__suisui?.getState().repoReady === true, { timeout: 8000 });

ok('仓库读完了（repoReady）', (await state('repoReady')) === true);
ok('它落在暂存上', (await state('repo'))?.kind === 'memory', JSON.stringify(await state('repo')));
ok('**不挡引导页**', (await page.locator('[data-repo-gate]').count()) === 0);
ok('界面照常能看见文件树', (await page.locator('[data-new-note]').count()) >= 1);

step('建一篇笔记 → 仓库里就有了');
// 笔记名自带日期前缀（`note.ts` 的规矩），所以断言一律用**建出来那条路径**，不自己拼
const made = await page.evaluate(() =>
  window.__suisui.getState().createNote('thoughts', '仓库测试'),
);
ok('建出来了', typeof made === 'string' && made.endsWith('.md'), String(made));
await page.waitForTimeout(900); // 存盘有 400ms 的防抖
{
  const paths = await repoPaths();
  ok('仓库里有这一篇', paths.includes(made), JSON.stringify(paths));
}

step('刷新 → 还在（真的落盘了，不是只在内存）');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-sync]');
await page.waitForFunction(() => window.__suisui?.getState().repoReady === true, { timeout: 8000 });
{
  const files = await state('files');
  ok('刷新之后那篇还在', made in files, JSON.stringify(Object.keys(files)));
  ok('正文没变', (files[made] ?? '').includes('仓库测试'), JSON.stringify(files[made]));
}

step('localStorage 里不再有第二份 files（仓库是唯一真相）');
{
  const legacy = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('suisui.demo.v1');
      return raw ? Object.keys(JSON.parse(raw)?.state ?? {}) : [];
    } catch {
      return ['(解析失败)'];
    }
  });
  ok('persist 那份里没有 files', !legacy.includes('files'), JSON.stringify(legacy));
  ok('仓库引用留在那儿（下次还开同一个）', legacy.includes('repo'), JSON.stringify(legacy));
}

step('改名：旧路径要从仓库里消失（存盘按差异写，最容易漏的就是删除）');
{
  const before = await repoPaths();
  ok('改名之前旧路径在仓库里', before.includes(made), JSON.stringify(before));
  const r = await page.evaluate(
    (p) => window.__suisui.getState().renameEntry(p, '改了名'),
    made,
  );
  ok('改名成功', r?.ok === true, JSON.stringify(r));
  const renamed = r?.to;
  await page.waitForTimeout(900);
  const after = await repoPaths();
  ok('新路径写进去了', after.includes(renamed), JSON.stringify(after));
  ok('**旧路径被删掉了**', !after.includes(made), JSON.stringify(after));
  ok('仓库里只剩这一篇（没有残留的副本）', after.length === 1, JSON.stringify(after));
}

step('删一篇：仓库里也要跟着没');
{
  const renamed = await page.evaluate(() => Object.keys(window.__suisui.getState().files)[0]);
  await page.evaluate((p) => window.__suisui.getState().removeFile(p), renamed);
  await page.waitForTimeout(900);
  const paths = await repoPaths();
  ok('仓库里已经没有它了', !paths.includes(renamed), JSON.stringify(paths));
  ok('仓库空了', paths.length === 0, JSON.stringify(paths));
}

step('设置页把当前仓库照实说出来');
await page.evaluate(() => window.__suisui.getState().openSettings('general'));
await page.waitForSelector('[data-settings-panel][data-settings-tab="general"]');
await page.waitForTimeout(400);
{
  const where = (await page.textContent('[data-repo-where]')) ?? '';
  ok('「当前仓库」写着暂存', where.includes('暂存'), where);
  ok('并且**提醒了它不在磁盘上**', (await page.locator('[data-repo-warn]').count()) === 1);
  ok('有「换一个文件夹」', (await page.locator('[data-repo-change]').count()) === 1);
  await page.screenshot({ path: `${OUT}/70-仓库设置.png` });
}

step('收尾');
ok('零报错', errors.length === 0, errors.join(' | '));
if (noise.length) console.log(`  · 远端网络噪声 ${noise.length} 条（不算失败 —— 仓库通不通看设置里「远端仓库」那块）`);

console.log('\n结果：' + pass + ' 通过 / ' + bad.length + ' 失败');
if (bad.length) console.log('失败项：' + bad.join('；'));
await browser.close();
if (bad.length) process.exit(1);
