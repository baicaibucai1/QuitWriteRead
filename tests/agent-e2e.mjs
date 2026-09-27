/*
 * AI 助手端到端：**在真浏览器里把内核跑一遍**。
 *
 * 它验的不是"模型说了什么"（演示模式那句话是写死的），而是这几件事：
 *   ① 入口唯一 —— 顶栏那颗星，且左栏 dock 没被塞第五颗；
 *   ② 事件流接上了 —— 文字 / 工具卡 / 状态徽标 / 计数都动；
 *   ③ 工具**真的**跑了 —— `list_notes` 的卡是真的 completed，
 *      并且 `read_note` 读出来的是仓库里那一篇的正文（不是编的）；
 *   ④ 没有写权限 —— 三个工具都只读，卡上不会出现"等你点头"。
 *
 * ⚠️ 走的是演示模式（不需要 Key）：脚本里写死的两步是确定的，
 * 拿真模型来验"链路通不通"反而验不准 —— 它今天想不想调工具是不一定的。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

// 同 smoke.mjs：playwright 会透传本机那个每次换端口的代理，浏览器对 api.github.com
// 时通时不通（node 的 fetch 不吃它，所以"node 能连、浏览器连不上"不是玄学）。
for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[k];
}

const require = createRequire('C:/AI_Production/QQbot/');
const { chromium } = require('playwright');
const { watchConsole } = await import('./remote-noise.mjs');

const URL = process.env.DEMO_URL ?? 'http://localhost:5183';
const OUT = 'C:/AI_Production/suisui-app/shots';
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
const ok = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};
const step = (s) => console.log('\n== ' + s);

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
const { errors, noise } = watchConsole(page);

try {
  step('打开页面，等仓库就绪');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__suisui?.getState().repoReady === true, { timeout: 20000 });

  /*
   * 先保证仓库里**真有一篇 md**。
   * 空库也能跑通链路（list_notes 会回一句人话），但那样验不到最关键的一条：
   * 助手读到的就是屏幕上那堆笔记 —— 它得真的读到内容才算数。
   * 走 store 的 createNote（纯本地），不等远端。
   */
  const SEED = '助手读到的是我';
  await page.evaluate((seed) => {
    const s = window.__suisui.getState();
    const hit = Object.keys(s.files).find((p) => p.endsWith('.md'));
    if (hit) {
      s.setContent(hit, `# 助手冒烟\n\n${seed}\n`);
      return;
    }
    const p = s.createNote('thoughts', '助手冒烟');
    s.setContent(p, `# 助手冒烟\n\n${seed}\n`);
  }, SEED);
  await page.waitForTimeout(900); // 等落盘（store 里那个 400ms 防抖）
  const noteCount = await page.evaluate(
    () => Object.keys(window.__suisui.getState().files).filter((p) => p.endsWith('.md')).length,
  );
  console.log('  仓库里 md 篇数:', noteCount);
  ok('仓库里至少有一篇 md（不然验不到"真读到了"）', noteCount >= 1, String(noteCount));

  step('入口唯一：顶栏一颗，左栏没被塞第五颗');
  ok('顶栏有助手入口', (await page.locator('[data-agent-toggle]').count()) === 1);
  ok('左栏 dock 还是四颗', (await page.locator('[data-dock] button').count()) === 4);
  ok('面板默认不开', (await page.locator('[data-agent-pane]').count()) === 0);

  step('点开面板');
  await page.click('[data-agent-toggle]');
  await page.waitForSelector('[data-agent-pane]', { timeout: 10000 });
  ok('面板出来了', await page.isVisible('[data-agent-pane]'));
  ok('抬头写着演示模式', (await page.textContent('[data-agent-mode]')).includes('演示'));
  // 内核是懒加载的，等它真起来（输入框 disabled = 还没好）
  await page.waitForFunction(() => !document.querySelector('[data-agent-input]')?.disabled, { timeout: 20000 });
  ok('助手起来了（输入框可用）', !(await page.locator('[data-agent-input]').isDisabled()));

  step('问一句：演示脚本先 list_notes');
  await page.fill('[data-agent-input]', '我有哪些笔记？');
  await page.click('[data-agent-send]');
  await page.waitForSelector('[data-agent-tool]', { timeout: 20000 });
  ok('出现了工具卡', (await page.locator('[data-agent-tool]').count()) >= 1);
  ok('第一个是 list_notes', (await page.getAttribute('[data-agent-tool]', 'data-agent-tool')) === 'list_notes');

  // 等这一轮跑完（发送按钮回来 = 不再 busy）
  await page.waitForSelector('[data-agent-send]', { timeout: 40000 });
  await page.waitForTimeout(400);

  const statuses = await page
    .locator('[data-agent-tool]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-agent-status')));
  console.log('  工具状态:', statuses.join(' | '));
  ok('没有工具卡被拒 / 等待审批', !statuses.some((s) => s === 'denied' || s === 'awaiting_permission'));
  ok('全都跑完了', statuses.every((s) => s === 'completed'), statuses.join(','));

  const listResult = await page.locator('[data-agent-result]').first().textContent();
  console.log('  list_notes 结果头两行:', (listResult ?? '').split('\n').slice(0, 2).join(' / ').slice(0, 160));

  step('读的那篇是仓库里真有的');
  ok('第二步真的读了第一篇', statuses.length >= 2, `共 ${statuses.length} 张卡`);
  ok(
    '第二张是 read_note',
    (await page.locator('[data-agent-tool]').nth(1).getAttribute('data-agent-tool')) === 'read_note',
  );
  const mdHit = await page.evaluate(
    () => Object.keys(window.__suisui.getState().files).filter((p) => p.endsWith('.md')).sort()[0],
  );
  const readResult = (await page.locator('[data-agent-result]').nth(1).textContent()) ?? '';
  ok('路径是仓库里那篇（不是编的）', readResult.includes(mdHit ?? ''), mdHit ?? '');
  ok('读出来的是那一篇的正文（真读到了）', readResult.includes(SEED), SEED);

  step('助手开口了 + 计数记了');
  const said = await page.textContent('[data-agent-text]');
  ok('有文字输出', (said ?? '').trim().length > 0, (said ?? '').slice(0, 60));
  ok('文字里点明了这是演示', (said ?? '').includes('演示'));
  const used = await page.textContent('[data-agent-usage]');
  ok('token 记上了', /\d+ tokens/.test(used ?? ''), (used ?? '').trim());
  await page.screenshot({ path: `${OUT}/20-agent.png` });

  step('Esc 收得掉');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('面板收了', (await page.locator('[data-agent-pane]').count()) === 0);

  /*
   * ══ 写 ══
   *
   * 这是本轮要证明的头一条：**演示写的第一步一定会先问人**。
   * 内核里 `append_note` 没标 readOnly，PermissionEngine 走到最后一句
   * "No rule allows …"，于是必定弹 card —— 这条不靠提示词，是代码担保的。
   */
  step('演示「写」：先问人，点了允许才真的写');
  await page.evaluate(() => window.__suisui.getState().setAgent({ demo: 'write' }));
  await page.click('[data-agent-toggle]');
  await page.waitForSelector('[data-agent-pane]', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('[data-agent-input]')?.disabled, { timeout: 20000 });

  const target = await page.evaluate(
    () => `agent/演示-${new Date().toISOString().slice(0, 10)}.md`,
  );
  const before = await page.evaluate((p) => window.__suisui.getState().files[p] ?? null, target);

  await page.fill('[data-agent-input]', '随便写一句什么到笔记里');
  await page.click('[data-agent-send]');
  // 写工具不带 readOnly → 内核停下来问人
  await page.waitForSelector('[data-agent-perm]', { timeout: 20000 });
  ok('写之前弹了卡', await page.isVisible('[data-agent-perm]'));
  ok(
    '卡上点名的是 append_note',
    (await page.getAttribute('[data-agent-perm]', 'data-agent-perm-tool')) === 'append_note',
  );
  const permText = await page.textContent('[data-agent-perm]');
  ok('卡上写清了要往哪一篇写', (permText ?? '').includes(target), (permText ?? '').slice(0, 80));
  ok('四个选项都在', (await page.locator('[data-agent-perm-opt]').count()) === 4);
  await page.screenshot({ path: `${OUT}/21-agent-perm.png` });

  // —— 先拒绝：被拒之后一篇都不该动
  await page.click('[data-agent-perm-opt="reject_once"]');
  await page.waitForSelector('[data-agent-send]', { timeout: 30000 });
  await page.waitForTimeout(400);
  const afterReject = await page.evaluate((p) => window.__suisui.getState().files[p] ?? null, target);
  ok('点了拒绝：那一篇还是没有', afterReject === before, String(afterReject).slice(0, 40));
  const saidAfterReject = await page.textContent('[data-agent-text]');
  ok('被拒了它也没说"写好了"', !(saidAfterReject ?? '').includes('追加好了'), (saidAfterReject ?? '').slice(0, 60));

  // —— 再允许：这次要真的落进去
  await page.fill('[data-agent-input]', '再来一次，这次允许');
  await page.click('[data-agent-send]');
  await page.waitForSelector('[data-agent-perm]', { timeout: 20000 });
  await page.click('[data-agent-perm-opt="allow_once"]');
  await page.waitForSelector('[data-agent-send]', { timeout: 30000 });
  await page.waitForTimeout(500);
  const afterAllow = await page.evaluate((p) => window.__suisui.getState().files[p] ?? null, target);
  ok('点了允许：那一篇真的出来了', typeof afterAllow === 'string', String(afterAllow).slice(0, 40));
  ok(
    '而且是有内容的一段（不是空壳）',
    typeof afterAllow === 'string' && afterAllow.includes('演示里追加'),
    String(afterAllow).slice(0, 60),
  );
  // 写走的是 store 那份 —— 所以左栏文件树立刻就得有它，不用刷新
  ok(
    '左栏文件树里立刻看得到（写的是界面上那一份）',
    (await page.locator(`[data-file="${target}"]`).count()) === 1,
    target,
  );
  await page.screenshot({ path: `${OUT}/22-agent-wrote.png` });

  // 收尾：这篇是演示写出来的，删掉，别留在仓库里
  await page.evaluate((p) => window.__suisui.getState().removeFile(p), target);
  await page.waitForTimeout(400);

  step('零报错');
  ok('没有页面错误', errors.length === 0, errors.slice(0, 4).join(' | '));
  if (noise.length) console.log(`  · 远端网络噪声 ${noise.length} 条（不算失败）`);
} finally {
  await browser.close();
}

console.log(`\n${failed === 0 ? '全绿' : `红了 ${failed} 条`}`);
process.exit(failed === 0 ? 0 : 1);
