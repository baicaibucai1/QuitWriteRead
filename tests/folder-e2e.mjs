// 文件夹的端到端：建 → 能看见（含空目录）→ 往里写笔记 → 删。
//
//   node tests/folder-e2e.mjs
//
// 文件夹的落地是一个**隐藏的标识文件**（.folder），所以最容易出错的两个地方是：
//   ① 空目录（里面只有标识文件）在树上还看不看得见 —— 看不见就等于"建了没反应"；
//   ② 标识文件自己会不会出现在文件列表里 —— 它冒出来就是噪音。
// 这两条光靠单测盖不住（取决于 FileTree 怎么过滤、怎么建树），必须在浏览器里验。
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

const seed = () =>
  page.evaluate(() =>
    window.__suisui.setState({
      files: {
        'thoughts/2026-09-21-开张.md': '# 开张\n\n第一篇。\n',
        'notes/2026-09-21-随手.md': '# 随手\n\n记一笔。\n',
      },
      snapshot: {},
      current: null,
      changes: [],
      showAll: false,
      drawer: false,
      token: 'ghp_demo',
    }),
  );
const files = () => page.evaluate(() => window.__suisui.getState().files);
const dirs = () =>
  page.$$eval('[data-dir]', (els) => els.map((e) => e.getAttribute('data-dir')));

step('准备：喂两个文件');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-sync]');
await page.waitForTimeout(700);
await seed();
await page.waitForTimeout(500);
ok('目录是从文件路径推出来的', JSON.stringify(await dirs()) === JSON.stringify(['notes', 'thoughts']), JSON.stringify(await dirs()));

step('建一个两层文件夹');
await page.click('[data-new-folder]');
await page.waitForSelector('[data-folder-name]');
await page.fill('[data-folder-name]', '读书/2026');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const d1 = await dirs();
ok('两层目录都在树上', d1.includes('读书') && d1.includes('读书/2026'), JSON.stringify(d1));
ok('嵌套层缩进更深（在同一棵子树里）', await page.isVisible('[data-dir="读书/2026"]'));
const f1 = await files();
ok('落了标识文件', '读书/2026/.folder' in f1, Object.keys(f1).join(' | '));
ok('标识文件有内容', String(f1['读书/2026/.folder'] ?? '').length > 0);
const shown = await page.$$eval('[data-file]', (els) => els.map((e) => e.getAttribute('data-file')));
ok('标识文件不出现在文件列表里', shown.every((p) => !p.endsWith('.folder')), shown.join(' | '));
ok('原有的两个文件还在', shown.length === 2, shown.join(' | '));
await page.screenshot({ path: `${OUT}/09-文件夹.png` });

step('空目录也留得住（刷新后）');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-sync]');
await page.waitForTimeout(900);
ok('刷新后目录还在', (await dirs()).includes('读书/2026'), JSON.stringify(await dirs()));

step('往这个文件夹里写笔记');
/*
 * 自建目录不再出现在「去处」候选里 —— 改成点它一下选中，
 * 加号就落在它下面（这也是唯一能把笔记放进自建目录的路子）。
 */
await page.click('[data-dir="读书/2026"]');
await page.waitForTimeout(250);
ok(
  '点目录行即选中',
  (await page.locator('[data-dir="读书/2026"][data-dir-selected="1"]').count()) === 1,
);
const target = (((await page.textContent('[data-new-note-target]')) ?? '') + '').replace(/\s+/g, ' ').trim();
ok('底部提示条指向这个目录', target.includes('读书/2026'), target);
await page.click('[data-new-note]');
await page.waitForTimeout(900);
const shown2 = await page.$$eval('[data-file]', (els) => els.map((e) => e.getAttribute('data-file')));
ok('笔记落在了这个目录', shown2.some((p) => p.startsWith('读书/2026/') && p.endsWith('.md')), shown2.join(' | '));

step('目录里的文件计数');
const badge = await page.textContent('[data-dir="读书/2026"]');
ok('目录行上标了里面有几个文件', (badge ?? '').includes('1'), badge ?? '');

step('删文件夹要先问一句');
await page.hover('[data-dir="读书/2026"]');
await page.click('[data-dir-del="读书/2026"]');
await page.waitForSelector('[data-folder-del-confirm]');
const warn = await page.textContent('[data-folder-del-confirm]');
ok('确认条里说了会删几个', (warn ?? '').includes('1 个文件'), warn ?? '');
await page.click('[data-folder-del-cancel]');
await page.waitForTimeout(250);
ok('取消后目录还在', (await dirs()).includes('读书/2026'));

await page.hover('[data-dir="读书/2026"]');
await page.click('[data-dir-del="读书/2026"]');
await page.waitForSelector('[data-folder-del-confirm]');
await page.click('[data-folder-del-ok]');
await page.waitForTimeout(400);
const d2 = await dirs();
ok('目录没了', !d2.includes('读书/2026'), JSON.stringify(d2));
const f2 = await files();
ok('里面的笔记和标识文件一起没了', !Object.keys(f2).some((p) => p.startsWith('读书/2026/')), Object.keys(f2).join(' | '));

step('目录名里的 .. 不许跳出库');
await page.click('[data-new-folder]');
await page.waitForSelector('[data-folder-name]');
await page.fill('[data-folder-name]', '../../etc');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const d3 = await dirs();
ok('被洗成了 etc（没有 ..）', d3.includes('etc') && !d3.some((d) => d.includes('..')), JSON.stringify(d3));

step('重复建同名不报错');
await page.click('[data-new-folder]');
await page.fill('[data-folder-name]', 'etc');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const d4 = await dirs();
ok('只有一个 etc', d4.filter((d) => d === 'etc').length === 1, JSON.stringify(d4));
const f3 = await files();
ok('标识文件没被重写成两份', Object.keys(f3).filter((p) => p === 'etc/.folder').length === 1);

step('控制台');
ok('零报错', errors.length === 0, errors.slice(0, 3).join(' | '));
if (noise.length) console.log(`  · 远端网络噪声 ${noise.length} 条（不算失败 —— 仓库通不通看设置里「远端仓库」那块）`);

await browser.close();
console.log(`\n结果：${pass} 通过 / ${bad.length} 失败`);
if (bad.length) console.log('失败：\n' + bad.map((b) => '  - ' + b).join('\n'));
process.exit(bad.length ? 1 : 0);
