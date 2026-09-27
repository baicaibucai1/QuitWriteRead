// 改名 / 搬家 / 右键菜单的端到端。
//
//   node tests/rename-e2e.mjs           （默认打 http://localhost:5183）
//   DEMO_URL=http://localhost:5191 node tests/rename-e2e.mjs
//
// ⚠️ **只能跑在 dev server 上**，别拿去打构建产物：这套靠 `window.__suisui` 直接摆状态，
// 而那个钩子只在 DEV 暴露（`main.tsx` 里包在 `import.meta.env.DEV` 里，正式包不带）。
// 产物上只有 lazy-e2e / pwa-e2e 那两套有意义。
//
// 这几件事**只能在浏览器里验**，因为最容易坏的地方不在纯函数里，而在"谁都跟着动了"：
//   · 改完名字，编辑器里那篇（current）还指着旧路径吗？
//   · 全库的双链跟着改了吗？右栏的反链还在吗？
//   · 目录改名后，折叠状态和"新笔记落点"指的还是旧路径吗？
// 纯函数再绿也证明不了这些 —— 它们全是跨状态的连线。
import { createRequire } from 'node:module';
import { watchConsole } from './remote-noise.mjs';

for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[k];
}

const { chromium } = createRequire('C:/AI_Production/QQbot/')('playwright');

const URL = process.env.DEMO_URL ?? 'http://localhost:5183';

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
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL });
const page = await context.newPage();

/*
 * 「零报错」只数**应用自己**的：pageerror + 来自开发服务器的 console error。
 * 第三方（api.github.com）那几条是浏览器替网络记的账 —— 仓库在不在、通不通
 * 由设置里「远端仓库」那一块说，不由这条断言说。判法见 ./remote-noise.mjs。
 */
const { errors, noise } = watchConsole(page);

const files = () => page.evaluate(() => window.__suisui.getState().files);
const current = () => page.evaluate(() => window.__suisui.getState().current);
const dirs = () => page.$$eval('[data-dir]', (els) => els.map((e) => e.getAttribute('data-dir')));
const notice = async () => ((await page.locator('[data-op-notice]').count()) ? await page.textContent('[data-op-notice]') : '');
const opErr = async () => ((await page.locator('[data-op-error]').count()) ? await page.textContent('[data-op-error]') : '');

/** 把 store 直接摆成我们要的样子（前端 e2e 的常规做法：绕开同步，只验界面逻辑） */
const seed = (patch) =>
  page.evaluate(
    (p) =>
      window.__suisui.setState({
        snapshot: {},
        changes: [],
        showAll: false,
        drawer: false,
        token: 'ghp_demo',
        planStale: false,
        ...p,
      }),
    patch,
  );

/**
 * 真拖：鼠标按下 → 动过 6px 阈值 → 移到目标 → 松手。返回拖动中看到的那几个落点记号。
 *
 * ⚠️ 落点必须**在按下之前现算**（所以传的是函数不是坐标）：刚做完操作时顶上会多一条
 * "已改名/已移到"的通知条，它把列表整体往下挤 —— 事先量好的坐标到时候指的就是别的东西了。
 * 所以这里先等通知条走掉，再量坐标。真人拖动时也是看着当下这一屏，而不是四秒前那一屏。
 */
const drag = async (fromSel, toPoint) => {
  if (await page.locator('[data-op-notice]').count()) {
    await page.locator('[data-op-notice]').waitFor({ state: 'detached', timeout: 9000 }).catch(() => {});
  }
  const a = await page.locator(fromSel).first().boundingBox();
  const pt = typeof toPoint === 'function' ? await toPoint() : toPoint;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  // 先小小地动一下（越过阈值才算拖动）
  await page.mouse.move(a.x + a.width / 2 + 14, a.y + a.height / 2 + 6, { steps: 3 });
  await page.mouse.move(pt.x, pt.y, { steps: 8 });
  await page.waitForTimeout(150);
  const n = async (v) => page.locator(v).count();
  const marks = {
    mark: await n('[data-drop-target]'),
    okMark: await n('[data-drop-target="ok"]'),
    badMark: await n('[data-drop-target="bad"]'),
    sameMark: await n('[data-drop-target="same"]'),
    ghost: await n('[data-drag-ghost]'),
  };
  await page.mouse.up();
  await page.waitForTimeout(350);
  return marks;
};

const centerOf = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** 列表空白处（根目录落点）：贴着列表底部，那儿不会有行 */
const rootPoint = async () => {
  const b = await page.locator('[data-drop-root]').boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height - 14 };
};

step('准备：两篇互相引用的笔记 + 一个目录');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-sync]');
await page.waitForTimeout(700);
await seed({
  files: {
    'notes/2026-09-21-随手.md': '# 随手\n\n记一笔。\n',
    'thoughts/2026-09-21-开张.md': '# 开张\n\n见 [[随手]] 和 [[随手#开头|那段话]]。\n',
    '读书/2026/.folder': '# 2026\n\n标识文件。\n',
    '读书/2026/书评.md': '# 书评\n\n空。\n',
  },
  current: 'notes/2026-09-21-随手.md',
});
await page.waitForTimeout(400);
ok('树上有三篇', (await page.locator('[data-file]').count()) === 3, String(await page.locator('[data-file]').count()));

step('右键打开菜单');
await page.click('[data-file="notes/2026-09-21-随手.md"]', { button: 'right' });
await page.waitForSelector('[data-ctx-menu]');
ok('菜单出来了', (await page.locator('[data-ctx-menu]').count()) === 1);
for (const id of ['rename', 'new-note', 'new-folder', 'copy-path', 'copy-wiki', 'info', 'delete']) {
  ok(`菜单里有「${id}」`, (await page.locator(`[data-ctx-item="${id}"]`).count()) === 1);
}
ok('被点的那行有记号（知道菜单在说谁）', (await page.locator('[data-file="notes/2026-09-21-随手.md"][data-ctx-target="1"]').count()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok('Esc 能关掉', (await page.locator('[data-ctx-menu]').count()) === 0);

await page.click('[data-file="notes/2026-09-21-随手.md"]', { button: 'right' });
await page.waitForSelector('[data-ctx-menu]');
await page.mouse.click(700, 700);
await page.waitForTimeout(200);
ok('点外面也能关掉', (await page.locator('[data-ctx-menu]').count()) === 0);

step('目录的菜单：不该有"复制双链"');
await page.click('[data-dir="读书/2026"]', { button: 'right' });
await page.waitForSelector('[data-ctx-menu]');
ok('有重命名', (await page.locator('[data-ctx-item="rename"]').count()) === 1);
ok('有「新建子文件夹」', ((await page.textContent('[data-ctx-item="new-folder"]')) ?? '').includes('子文件夹'));
ok('没有复制双链（目录不是笔记）', (await page.locator('[data-ctx-item="copy-wiki"]').count()) === 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

step('就地改名（右键 → 重命名 → 直接敲 → 回车）');
await page.click('[data-file="notes/2026-09-21-随手.md"]', { button: 'right' });
await page.waitForSelector('[data-ctx-menu]');
await page.click('[data-ctx-item="rename"]');
await page.waitForSelector('[data-rename-input]');
ok('原地变成输入框', (await page.locator('[data-rename-input]').count()) === 1);
ok('输入框里预填了当前名字', (await page.inputValue('[data-rename-input]')).startsWith('2026-09-21-随手'));
await page.fill('[data-rename-input]', '2026-09-21-随笔');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
{
  const f = await files();
  ok('文件真的改名了', 'notes/2026-09-21-随笔.md' in f, Object.keys(f).join(' | '));
  ok('老路径没了', !('notes/2026-09-21-随手.md' in f));
  ok('输入框收掉了', (await page.locator('[data-rename-input]').count()) === 0);
  // ⚠️ 这里查 dirty 不查 planStale：启动时那次自动比对可能刚好在这几百毫秒里回来，
  // 把 planStale 冲成 false（跟本次改动无关）。dirty 只有同步才会清，稳。
  ok('状态栏知道有本地改动', (await page.evaluate(() => window.__suisui.getState().dirty)) === true);
}
ok('编辑器里打开的还是同一篇（路径跟过去了）', (await current()) === 'notes/2026-09-21-随笔.md', String(await current()));

step('双链跟着改（这是改名不烂库的关键）');
{
  const f = await files();
  const src = f['thoughts/2026-09-21-开张.md'] ?? '';
  ok('普通链接改了', src.includes('[[随笔]]'), src);
  ok('带小节和显示文字的也改了，两样都留着', src.includes('[[随笔#开头|那段话]]'), src);
  ok('不再残留旧名', !src.includes('随手'), src);
}
{
  const f = await files();
  ok('被改名那篇的正文标题也改了', (f['notes/2026-09-21-随笔.md'] ?? '').startsWith('# 随笔'), f['notes/2026-09-21-随笔.md']);
}
ok('界面告诉了用户改了几处引用', (await notice()).includes('2 处引用'), await notice());

step('F2 也能改名（当前打开的那篇），Esc 取消');
await page.keyboard.press('F2');
await page.waitForSelector('[data-rename-input]');
await page.fill('[data-rename-input]', '不该保存的名字');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
{
  const f = await files();
  ok('Esc 之后名字没变', 'notes/2026-09-21-随笔.md' in f && !('notes/不该保存的名字.md' in f), Object.keys(f).join(' | '));
}

step('改目录名：里面的东西一起走');
await page.click('[data-dir="读书/2026"]', { button: 'right' });
await page.waitForSelector('[data-ctx-menu]');
await page.click('[data-ctx-item="rename"]');
await page.waitForSelector('[data-rename-input]');
await page.fill('[data-rename-input]', '2027');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
{
  const d = await dirs();
  ok('目录改名了', d.includes('读书/2027') && !d.includes('读书/2026'), JSON.stringify(d));
  const f = await files();
  ok('里面的笔记跟着走', '读书/2027/书评.md' in f, Object.keys(f).join(' | '));
  ok('标识文件跟着走，且名字还是 .folder', '读书/2027/.folder' in f && !('读书/2026/.folder' in f));
  ok('标识文件里那行标题也改了', (f['读书/2027/.folder'] ?? '').startsWith('# 2027'), f['读书/2027/.folder']);
  ok('别的目录没被牵连', 'notes/2026-09-21-随笔.md' in f);
}
/**
 * 改名之后，"新笔记落点"和折叠状态里那些路径也得跟着走 ——
 * 这两样都记在组件自己的状态里，最容易漏。
 */
await page.click('[data-dir="读书/2027"]');
await page.waitForTimeout(200);
const target = (((await page.textContent('[data-new-note-target]')) ?? '') + '').replace(/\s+/g, ' ');
ok('点选目录后落点提示跟着更新', target.includes('读书/2027'), target);

step('拖动：把根部的文件拖进目录');
await seed({
  files: {
    'thoughts/2026-09-21-开张.md': '# 开张\n\n见 [[随笔]]。\n',
    'notes/2026-09-21-随笔.md': '# 随笔\n\n记一笔。\n',
    '读书/2027/.folder': '# 2027\n',
    '读书/2027/书评.md': '# 书评\n',
  },
  current: null,
});
await page.waitForTimeout(400);
{
  const r = await drag('[data-file="notes/2026-09-21-随笔.md"]', () => centerOf('[data-dir="读书/2027"]'));
  ok('拖动过程中目标目录有落点记号', r.okMark >= 1, JSON.stringify(r));
  ok('能放的时候是"可以"（不是红的）', r.okMark >= 1 && r.badMark === 0, JSON.stringify(r));
  const f = await files();
  ok('文件挪进目录了', '读书/2027/2026-09-21-随笔.md' in f, Object.keys(f).join(' | '));
  ok('老位置没了', !('notes/2026-09-21-随笔.md' in f));
  ok('内容原样', (f['读书/2027/2026-09-21-随笔.md'] ?? '').includes('记一笔'));
  ok('双链没被改（搬家不改名字，按名字照样找得到）', ((await files())['thoughts/2026-09-21-开张.md'] ?? '').includes('[[随笔]]'));
}

step('连拖两次都要能拖（第一次拖动会把行里的文字选中）');
{
  // 再拖一次别的：这正是"选中文字导致浏览器发起原生拖拽、把第二次拖动掐断"那个坑
  const r = await drag('[data-file="thoughts/2026-09-21-开张.md"]', () => centerOf('[data-dir="读书/2027"]'));
  ok('第二次拖动照样起来（有跟着走的小纸）', r.ghost === 1, JSON.stringify(r));
  ok('落点也认出来了', r.okMark >= 1, JSON.stringify(r));
  const f = await files();
  ok('第二个文件也挪进去了', '读书/2027/2026-09-21-开张.md' in f, Object.keys(f).join(' | '));
}

step('拖动：把目录拖到空白处 = 挪到根目录');
{
  const r = await drag('[data-dir="读书/2027"]', rootPoint);
  ok('空白处也能当落点', r.okMark >= 1, JSON.stringify(r));
  const d = await dirs();
  ok('目录到了根上', d.includes('2027') && !d.includes('读书/2027'), JSON.stringify(d));
  const f = await files();
  ok('里面的文件跟着走', '2027/书评.md' in f, Object.keys(f).join(' | '));
}

/*
 * 折叠的目录也能往里放 —— 但放进去之后如果它还折着，刚拖过去的东西当场就"没了"。
 * 所以拖到折叠目录上压住不动一会儿要自动展开（划过不停留的不算，否则一路划一路开）。
 */
step('拖到折叠的目录上：压住不动一会儿自动展开');
await seed({
  files: {
    'notes/随手.md': '# 随手\n\n记一笔。\n',
    '待归档/.folder': '# 待归档\n',
    '待归档/已有.md': '# 已有\n',
  },
  current: null,
});
await page.waitForTimeout(400);
{
  await page.click('[data-dir="待归档"]'); // 点一下 = 折上
  await page.waitForTimeout(250);
  ok(
    '先确认它是折上的',
    (await page.getAttribute('[data-dir="待归档"]', 'data-dir-open')) === '0',
    String(await page.getAttribute('[data-dir="待归档"]', 'data-dir-open')),
  );

  const a = await page.locator('[data-file="notes/随手.md"]').first().boundingBox();
  const b = await page.locator('[data-dir="待归档"]').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 14, a.y + a.height / 2 + 6, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.waitForTimeout(900); // 阈值 600ms，留一截富余
  const openedWhileDragging = await page.getAttribute('[data-dir="待归档"]', 'data-dir-open');
  ok('还没松手就已经展开了', openedWhileDragging === '1', String(openedWhileDragging));
  await page.mouse.up();
  await page.waitForTimeout(350);

  const f = await files();
  ok('文件确实落进去了', '待归档/随手.md' in f, Object.keys(f).join(' | '));
  ok('落进去之后看得见（不是藏在折叠里）', (await page.locator('[data-file="待归档/随手.md"]').count()) === 1);
}

step('划过不停留 = 不该把沿途目录全展开一遍');
await seed({
  files: {
    '随手.md': '# 随手\n',
    '待归档/.folder': '# 待归档\n',
    '待归档/已有.md': '# 已有\n',
  },
  current: null,
});
await page.waitForTimeout(400);
{
  await page.click('[data-dir="待归档"]'); // 折上
  await page.waitForTimeout(250);
  const a = await page.locator('[data-file="随手.md"]').first().boundingBox();
  const mid = await page.locator('[data-dir="待归档"]').boundingBox();
  const end = await rootPoint();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 14, a.y + a.height / 2 + 6, { steps: 3 });
  await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2, { steps: 8 });
  await page.waitForTimeout(150); // 只是划过，远没到 600ms
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  ok(
    '中途划过的折叠目录没被展开',
    (await page.getAttribute('[data-dir="待归档"]', 'data-dir-open')) === '0',
    String(await page.getAttribute('[data-dir="待归档"]', 'data-dir-open')),
  );
  ok('落点是最后松手的地方（根目录），不是半路划过的那个', '随手.md' in (await files()));
}

step('拖到会重名的地方：挡下来，并且说清为什么');
await seed({
  files: {
    'A.md': '# 根部的 A\n',
    '别处/.folder': '# 别处\n',
    '别处/A.md': '# 别处的 A\n',
  },
  current: null,
});
await page.waitForTimeout(400);
{
  const r = await drag('[data-file="A.md"]', () => centerOf('[data-dir="别处"]'));
  ok('能看出"放不下"（红记号）', r.badMark >= 1, JSON.stringify(r));
  ok('弹出说清了原因', (await opErr()).includes('已经有一个'), await opErr());
  const f = await files();
  ok('文件没被挪走', 'A.md' in f && f['A.md'] === '# 根部的 A\n', JSON.stringify(f));
  ok('目标里那份也没被动', f['别处/A.md'] === '# 别处的 A\n');
}
await page.click('[data-op-error-close]');
await page.waitForTimeout(200);
ok('错误条能关掉', (await page.locator('[data-op-error]').count()) === 0);

step('拖回原处 = 什么也不做，也不该画成"放不下"');
{
  const before = await files();
  const r = await drag('[data-file="别处/A.md"]', () => centerOf('[data-dir="别处"]'));
  const after = await files();
  ok('文件一条都没变', JSON.stringify(after) === JSON.stringify(before), Object.keys(after).join(' | '));
  ok('没弹错误', (await opErr()) === '', await opErr());
  ok('认出来是"原处"，不是"放不下"', r.sameMark >= 1 && r.badMark === 0, JSON.stringify(r));
  ok('拖动时有跟着走的小纸（能看出在拖什么）', r.ghost === 1, JSON.stringify(r));
}

step('属性面板');
await page.click('[data-file="别处/A.md"]', { button: 'right' });
await page.waitForSelector('[data-ctx-menu]');
await page.click('[data-ctx-item="info"]');
await page.waitForSelector('[data-info-panel]');
{
  const t = ((await page.textContent('[data-info-panel]')) ?? '').replace(/\s+/g, ' ');
  ok('显示路径', t.includes('别处/A.md'), t);
  ok('显示类型', t.includes('Markdown'), t);
  ok('显示大小', t.includes('字节'), t);
  ok('显示字数', t.includes('字'), t);
  ok('显示标签（没有也要说"没有"）', t.includes('标签') && t.includes('没有'), t);
  ok('显示关系', t.includes('引用'), t);
}
await page.click('[data-info-close]');
await page.waitForTimeout(200);
ok('能关掉', (await page.locator('[data-info-panel]').count()) === 0);

await page.click('[data-dir="别处"]', { button: 'right' });
await page.waitForSelector('[data-ctx-menu]');
await page.click('[data-ctx-item="info"]');
await page.waitForSelector('[data-info-panel]');
{
  const t = ((await page.textContent('[data-info-panel]')) ?? '').replace(/\s+/g, ' ');
  ok('目录的属性说它是文件夹', t.includes('文件夹'), t);
  ok('目录的属性说里面有几个', t.includes('1 个文件'), t);
}
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

step('复制路径 / 复制双链');
await page.click('[data-file="别处/A.md"]', { button: 'right' });
await page.waitForSelector('[data-ctx-menu]');
await page.click('[data-ctx-item="copy-path"]');
await page.waitForTimeout(300);
ok('提示说复制了', (await notice()).includes('已复制'), await notice());
{
  const got = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '(读不到)');
  ok('剪贴板里是那条路径', got === '别处/A.md', String(got));
}
await page.click('[data-file="别处/A.md"]', { button: 'right' });
await page.waitForSelector('[data-ctx-menu]');
await page.click('[data-ctx-item="copy-wiki"]');
await page.waitForTimeout(300);
{
  const got = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '(读不到)');
  ok('剪贴板里是双链写法', got === '[[A]]', String(got));
}

step('右键空白处：建到当前落点');
await page.click('[data-drop-root]', { button: 'right', position: { x: 40, y: 300 } });
await page.waitForSelector('[data-ctx-menu]');
ok('空白处的菜单没有重命名 / 删除', (await page.locator('[data-ctx-item="rename"]').count()) === 0 && (await page.locator('[data-ctx-item="delete"]').count()) === 0);
await page.click('[data-ctx-item="new-note"]');
await page.waitForTimeout(600);
{
  const f = await files();
  const made = Object.keys(f).filter((p) => p.includes('未命名'));
  ok('建出了一篇未命名', made.length === 1, Object.keys(f).join(' | '));
  ok('正文第一行是标题', (f[made[0]] ?? '').startsWith('# 未命名'), f[made[0]]);
}

step('控制台');
ok('零报错', errors.length === 0, errors.slice(0, 3).join(' | '));
if (noise.length) console.log(`  · 远端网络噪声 ${noise.length} 条（不算失败 —— 仓库通不通看设置里「远端仓库」那块）`);

await browser.close();
console.log(`\n结果：${pass} 通过 / ${bad.length} 失败`);
if (bad.length) console.log('失败：\n' + bad.map((b) => '  - ' + b).join('\n'));
process.exit(bad.length ? 1 : 0);
