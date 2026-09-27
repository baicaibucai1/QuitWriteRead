// 导入本机 md 的端到端。
//
//   node tests/import-e2e.mjs                            # 默认打开发服务器 5183
//   DEMO_URL=http://localhost:5184 node tests/import-e2e.mjs   # 打包产物（DEV-only 手段用不了，见下）
//
// ⚠️ 这个套件**只能跑 dev**：它靠 `window.__suisui`（只在 DEV 挂载）直接喂库内容、
// 直接读回 files。prod 那一侧能验的只是界面在，验不了"字节真的解对了"。
//
// 验的是四件"组件里发生过、但单测看不见"的事：
//   ① 选中的文件真的进库了，正文就是原文（不是空壳、不是被改过的）；
//   ② **GBK 文件解出来是中文** —— 这条错了不报错，只会在库里留一篇问号；
//   ③ 撞名的那篇变成 -2，**原来那篇一个字都没动**；
//   ④ 不是 md 的文件被挡下，并且**告诉你挡了**（静默跳过等于文件凭空消失）。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { watchConsole } from './remote-noise.mjs';

for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[k];
}

const { chromium } = createRequire('C:/AI_Production/QQbot/')('playwright');

const URL = process.env.DEMO_URL ?? 'http://localhost:5183';
const OUT = 'C:/AI_Production/suisui-app/shots/ui';
const TMP = 'C:/AI_Production/suisui-app/tests/tmp-import';
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

/* ── 造三个真文件：utf-8 中文 / GBK 中文 / 不是 md ── */
fs.mkdirSync(TMP, { recursive: true });
const UTF8_MD = '# 随手\n\n这是从本机导入的一篇。\n';
fs.writeFileSync(`${TMP}/随手.md`, UTF8_MD, 'utf8');
// 「中」= D6D0 「文」= CEC4 —— 整篇不是合法 utf-8，正是 Windows 上老 md 的样子
fs.writeFileSync(
  `${TMP}/老笔记.md`,
  Buffer.from([...Buffer.from('# note\n\n', 'ascii'), 0xd6, 0xd0, 0xce, 0xc4, 0x0a]),
);
fs.writeFileSync(`${TMP}/封面.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

/*
 * 「零报错」只数**应用自己**的：pageerror + 来自开发服务器的 console error。
 * 第三方（api.github.com）那几条是浏览器替网络记的账 —— 仓库在不在、通不通
 * 由设置里「远端仓库」那一块说，不由这条断言说。判法见 ./remote-noise.mjs。
 */
const { errors, noise } = watchConsole(page);

const seed = () =>
  page.evaluate(() =>
    window.__suisui.setState({
      files: { 'thoughts/随手.md': '# 随手\n\n**原来就在库里的那一篇。**\n' },
      snapshot: {},
      current: null,
      changes: [],
      showAll: false,
      drawer: false,
      token: 'ghp_demo',
    }),
  );
const files = () => page.evaluate(() => window.__suisui.getState().files);
const current = () => page.evaluate(() => window.__suisui.getState().current);
const rows = () => page.$$eval('[data-file]', (els) => els.map((e) => e.getAttribute('data-file')));

step('准备：库里先有一篇「随手」');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-sync]');
await page.waitForTimeout(700);
await seed();
await page.waitForTimeout(400);
ok('那一篇在列表里', (await rows()).some((p) => p.includes('随手')), JSON.stringify(await rows()));

step('入口在文件树工具条的「⋯」菜单里');
/*
 * 工具条收纳那轮（2026-09-26）搬进菜单的：导入属于"一周用一次"的那类，
 * 常驻位只留 + 建笔记 / 建文件夹 / 标签。落点跟着「新笔记落在」走 ——
 * 菜单项的 hint 里写的是同一个目录。
 */
ok('「⋯」在', (await page.locator('[data-more]').count()) === 1);
await page.click('[data-more]');
ok('菜单里有「导入 md」', (await page.locator('[data-ctx-item="tools-import"]').count()) === 1);
ok(
  '它写着会落到哪个目录',
  ((await page.textContent('[data-ctx-item="tools-import"]')) ?? '').includes('thoughts/'),
  await page.textContent('[data-ctx-item="tools-import"]'),
);
await page.keyboard.press('Escape'); // 收起菜单，下一步直接 setInputFiles
await page.waitForTimeout(200);

step('选三个文件：两篇 md（含一个 GBK）+ 一张图');
await page.setInputFiles('[data-import-input]', [
  `${TMP}/随手.md`,
  `${TMP}/老笔记.md`,
  `${TMP}/封面.png`,
]);
await page.waitForTimeout(900);

{
  const f = await files();
  const keys = Object.keys(f);
  ok('GBK 那篇进来了', 'thoughts/老笔记.md' in f, JSON.stringify(keys));
  ok(
    'GBK 解出来是「中文」，不是问号',
    (f['thoughts/老笔记.md'] ?? '').includes('中文') && !f['thoughts/老笔记.md'].includes('�'),
    JSON.stringify(f['thoughts/老笔记.md']),
  );
  ok('ASCII 那半也保住了', (f['thoughts/老笔记.md'] ?? '').startsWith('# note'));

  ok('重名的那篇变成 -2', 'thoughts/随手-2.md' in f, JSON.stringify(keys));
  ok('它的正文就是导入的原文', f['thoughts/随手-2.md'] === UTF8_MD, JSON.stringify(f['thoughts/随手-2.md']));
  ok(
    '**原来那篇一个字都没动**',
    f['thoughts/随手.md'] === '# 随手\n\n**原来就在库里的那一篇。**\n',
    JSON.stringify(f['thoughts/随手.md']),
  );
  ok('图片没被当成笔记收进来', !keys.some((k) => k.endsWith('.png')), JSON.stringify(keys));
}

step('反馈里说清导入了几篇、改了几次名、跳过了什么');
{
  const text = (await page.textContent('[data-op-notice]')) ?? '';
  ok('报了导入 2 篇', text.includes('导入 2 篇'), text);
  ok('报了 1 篇因重名改了名', text.includes('1 篇因重名改了名'), text);
  ok('报了 1 个不是 md', text.includes('1 个不是 md'), text);
}

step('导入完切到第一篇，界面上就能读能改');
{
  const cur = await current();
  ok('打开的是刚导入的一篇', cur === 'thoughts/随手-2.md' || cur === 'thoughts/老笔记.md', String(cur));
  await page.waitForTimeout(1200);
  const shown = await page.evaluate(() => document.body.innerText);
  ok('正文出现在界面上', shown.includes('这是从本机导入的一篇') || shown.includes('中文'), shown.slice(0, 120));
}
await page.screenshot({ path: `${OUT}/60-导入-md.png` });

step('再导一次同一个文件：-3，不覆盖');
{
  await page.setInputFiles('[data-import-input]', [`${TMP}/随手.md`]);
  await page.waitForTimeout(700);
  const f = await files();
  ok('第二次给 -3', 'thoughts/随手-3.md' in f, JSON.stringify(Object.keys(f)));
  ok('-2 那篇还在', f['thoughts/随手-2.md'] === UTF8_MD);
}

step('把文件拖进列表：也能导入');
{
  const dt = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# 拖进来的\n\n正文。\n'], '拖进来的.md', { type: 'text/markdown' }));
    return dt;
  });
  await page.dispatchEvent('[data-import-dropzone]', 'dragover', { dataTransfer: dt });
  await page.waitForTimeout(200);
  ok(
    '拖到列表上方时整块描边（看得见会落进来）',
    (await page.getAttribute('[data-import-dropzone]', 'data-import-dragover')) === '1',
  );
  await page.screenshot({ path: `${OUT}/61-拖入-md.png` });
  await page.dispatchEvent('[data-import-dropzone]', 'drop', { dataTransfer: dt });
  await page.waitForTimeout(700);
  const f = await files();
  ok('拖进来的那篇进了库', 'thoughts/拖进来的.md' in f, JSON.stringify(Object.keys(f)));
  ok('正文没丢', (f['thoughts/拖进来的.md'] ?? '').includes('正文。'));
  ok(
    '松手后描边收掉',
    (await page.getAttribute('[data-import-dropzone]', 'data-import-dragover')) === null,
  );
}

step('收尾');
ok('零报错', errors.length === 0, errors.join(' | '));
if (noise.length) console.log(`  · 远端网络噪声 ${noise.length} 条（不算失败 —— 仓库通不通看设置里「远端仓库」那块）`);

console.log('\n结果：' + pass + ' 通过 / ' + bad.length + ' 失败');
if (bad.length) console.log('失败项：' + bad.join('；'));
await browser.close();
fs.rmSync(TMP, { recursive: true, force: true });
if (bad.length) process.exit(1);
