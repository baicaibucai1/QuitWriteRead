/*
 * AI 助手端到端：**在真浏览器里把内核跑一遍**。
 *
 * 它验的不是"模型说了什么"（演示模式那句话是写死的），而是这几件事：
 *   ① 入口唯一 —— 顶栏那颗星，翻的是**右栏那排签**，且左栏 dock 没被塞第五颗；
 *   ② 没接上模型时**不装作答复** —— 明说没配，并把人指到设置里；
 *   ③ 事件流接上了 —— 文字 / 工具卡 / 状态徽标 / 计数都动；
 *   ④ 工具**真的**跑了 —— `list_notes` 的卡是真的 completed，
 *      并且 `read_note` 读出来的是仓库里那一篇的正文（不是编的）；
 *   ⑤ 翻到大纲再翻回来，聊到一半的**还在**（那一页只藏不拆）。
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

/*
 * 等一次**重建**真的完成。
 *
 * ⚠️ 只等"输入框可用"是不够的：配置改动有 600ms 落定时间，在那之前输入框
 * 还是**上一个** agent 的（本来就是亮的），等它等于没等 —— 发下去的那一句
 * 会由旧 agent 接，验的就不是想验的那个了。
 * 所以分两步：先等它变灰（说明重开始了），再等它亮回来（说明新的建好了）。
 */
const waitRebuilt = async () => {
  await page
    .waitForFunction(() => document.querySelector('[data-agent-input]')?.disabled === true, { timeout: 8000 })
    .catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[data-agent-input]')?.disabled, { timeout: 20000 });
};

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

  step('没接上模型时：明说，不装作答复');
  await page.click('[data-agent-toggle]');
  await page.waitForSelector('[data-agent-pane]', { timeout: 10000 });
  ok('右栏翻到了助手那一页', (await page.getAttribute('[data-right-tab="agent"]', 'data-on')) === '1');
  ok('面板出来了', await page.isVisible('[data-agent-pane]'));
  /*
   * 默认 `demo: 'off'` 且没有 Key —— 这时候它**不该**照着脚本答一句。
   * 上一版默认演示「读」，人问"河边我看见了什么"，它答"仓库里一篇笔记都没有"
   * （答非所问，而仓库里明明有笔记）—— 那才是"完全不可用"的根子。
   */
  ok('抬头写着还没接上', (await page.textContent('[data-agent-mode]')).includes('还没接上'));
  ok('摆出了「去设置里接一个」', await page.isVisible('[data-agent-setup]'));
  ok('输入框是灰的（没东西可问）', await page.locator('[data-agent-input]').isDisabled());

  // 那颗按钮要能直接落到设置里 AI 助手那一节 —— 指路就得指到位
  await page.click('[data-agent-goset]');
  await page.waitForSelector('[data-settings-panel]', { timeout: 10000 });
  ok(
    '点它直接跳到 AI 助手那一节',
    (await page.getAttribute('[data-settings-panel]', 'data-settings-tab')) === 'agent',
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('设置关掉了', (await page.locator('[data-settings-panel]').count()) === 0);

  step('接上演示「读」：等它自己重建');
  await page.evaluate(() => window.__suisui.getState().setAgent({ demo: 'read' }));
  await waitRebuilt();
  ok('助手起来了（输入框可用）', !(await page.locator('[data-agent-input]').isDisabled()));
  ok('抬头写着演示', (await page.textContent('[data-agent-mode]')).includes('演示'));

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
  const said = await page.locator('[data-agent-text]').last().textContent();
  ok('有文字输出', (said ?? '').trim().length > 0, (said ?? '').slice(0, 60));
  ok('文字里点明了这是演示', (said ?? '').includes('演示'));
  const used = await page.textContent('[data-agent-usage]');
  ok('token 记上了', /\d+ tokens/.test(used ?? ''), (used ?? '').trim());
  await page.screenshot({ path: `${OUT}/20-agent.png` });

  /*
   * ══ 写 ══
   *
   * 这是本轮要证明的头一条：**演示写的第一步一定会先问人**。
   * 内核里 `append_note` 没标 readOnly，PermissionEngine 走到最后一句
   * "No rule allows …"，于是必定弹 card —— 这条不靠提示词，是代码担保的。
   */
  step('演示「写」：先问人，点了允许才真的写');
  await page.evaluate(() => window.__suisui.getState().setAgent({ demo: 'write' }));
  await page.waitForTimeout(900); // 先把那条防抖的重建放过去，免得它待会儿插进来
  // 再开一段新的：上面那轮读的工具卡不该混进来，数起来才数得准
  await page.click('[data-agent-new]');
  await waitRebuilt();
  ok('抬头换成演示「写」了', (await page.textContent('[data-agent-mode]')).includes('演示「写」'));

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
  const saidAfterReject = await page.locator('[data-agent-text]').last().textContent();
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

  /*
   * ══ 创建能力：create_note ══
   *
   * 走**生产那一套代码**（开发期的模块图里能手取），没有替身。
   * 之所以不靠"问它一句让它去建"：模型今天想不想调这个工具是不一定的，
   * 而"能建"和"绝不盖掉已有的"这两条必须**每次都是真的**，不能赌概率。
   */
  step('create_note：真的能建，而且绝不盖掉已有的');
  const NEW_PATH = `agent/助手新建-${Date.now()}.md`;
  const keep = await page.evaluate(() => window.__suisui.getState().current);

  const created = await page.evaluate(async (path) => {
    const m = await import('/src/lib/agent/note-tools.ts');
    const ctx = {
      signal: new AbortController().signal,
      workspaceRoot: '/repo',
      sessionId: 'e2e',
      runId: 'e2e',
      toolCallId: 'e2e',
      sandbox: {
        root: '/repo',
        additionalRoots: [],
        resolve: async (p) => p,
        resolveSync: (p) => p,
        isInside: () => true,
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      progress() {},
      services: {},
    };
    const call = async (list, name, args) => {
      const t = list.find((x) => x.name === name);
      if (!t) return { missing: true, text: '' };
      const r = await t.execute(args, ctx);
      return { text: String(r.content), isError: !!r.isError };
    };
    const full = m.createNoteTools({ allowWrite: true });
    const off = m.createNoteTools({ allowWrite: false });
    return {
      // ① 关掉写权限时，写的三个**一个都不该在**
      offNames: off.map((t) => t.name),
      // ② 没标 readOnly → 内核那道门会拦下它并弹卡（代码担保，不是提示词）
      createReadOnly: full.find((t) => t.name === 'create_note')?.readOnly === true,
      fullNames: full.map((t) => t.name),
      // ③ 建一个不存在的（连目录一起建）
      made: await call(full, 'create_note', { path, content: '# 助手建的\n\n这是新建的一篇。' }),
      // ④ 再建一次同名 —— 必须拒绝，而且一个字都不动
      twice: await call(full, 'create_note', { path, content: '这回是来覆盖的' }),
      /*
       * 顺手钉住另一条：**读一个根本没有的篇要说"读不出来"**。
       * 以前仓库那一份对不存在的路径返回空串，于是给出一篇空笔记 ——
       * 模型拿到"这篇是空的"这个假事实，比直接说没有更糟。
       */
      noSuch: await call(full, 'read_note', { path: '根本没有的目录/没有这篇.md' }),
      // ⑤ 三道护栏
      dotdot: await call(full, 'create_note', { path: '../逃出去.md', content: 'x' }),
      books: await call(full, 'create_note', { path: 'books/别建在这儿.md', content: 'x' }),
      empty: await call(full, 'create_note', { path: '随便/空壳.md', content: '   ' }),
    };
  }, NEW_PATH);

  console.log('  工具清单:', created.fullNames.join(' '));
  ok('create_note 在工具里', created.fullNames.includes('create_note'));
  ok('关掉写权限时它就不注册了', !created.offNames.includes('create_note'), created.offNames.join(','));
  ok('写的三个一起消失', created.offNames.length === 3, created.offNames.join(','));
  ok('它没标 readOnly（所以内核必定弹卡问人）', created.createReadOnly === false);

  ok('建成功了', !created.made.isError && created.made.text.includes('新建了'), created.made.text.slice(0, 60));
  ok(
    '建完它自己出现在左栏（我没被切走）',
    (await page.locator(`[data-file="${NEW_PATH}"]`).count()) === 1,
    NEW_PATH,
  );
  ok(
    '当前打开的还是原来那篇（不抢焦点）',
    (await page.evaluate(() => window.__suisui.getState().current)) === keep,
    String(keep),
  );
  ok(
    '正文就是给的那段',
    (await page.evaluate((p) => window.__suisui.getState().files[p] ?? '', NEW_PATH)).includes('这是新建的一篇'),
  );

  ok(
    '读一篇根本没有的 → 说"读不出来"，不是给一篇空的',
    created.noSuch.isError && created.noSuch.text.includes('读不出来'),
    created.noSuch.text.slice(0, 60),
  );
  ok('同名的再来一次 → 拒绝', created.twice.isError && created.twice.text.includes('已经存在'), created.twice.text.slice(0, 60));
  ok(
    '而且**真的没盖掉**（还是原来那段）',
    (await page.evaluate((p) => window.__suisui.getState().files[p] ?? '', NEW_PATH)).includes('这是新建的一篇'),
  );
  ok('想跳出仓库的路径 → 拦下', created.dotdot.isError && created.dotdot.text.includes('..'));
  ok('往书架里建 → 拦下', created.books.isError && created.books.text.includes('书架'));
  ok('空正文 → 不建空壳', created.empty.isError && created.empty.text.includes('空的正文'));

  // 收尾：这篇是这次新建的，删掉
  await page.evaluate((p) => window.__suisui.getState().removeFile(p), NEW_PATH);
  await page.waitForTimeout(400);

  /*
   * ══ 它是右栏的一页，不是浮层 ══
   *
   * 这一段验的是"搬进右栏"之后新的那几条：两颗签、翻页不丢、收起整栏。
   */
  step('右栏两页签：翻到大纲再翻回来，聊的还在');
  ok('两颗签都在', (await page.locator('[data-right-tab]').count()) === 2);
  ok('现在停在助手', (await page.getAttribute('[data-right-tab="agent"]', 'data-on')) === '1');
  const kept = await page.locator('[data-agent-text]').count();
  ok('此刻助手确实说过话', kept >= 1, String(kept));

  await page.click('[data-right-tab="outline"]');
  await page.waitForTimeout(300);
  ok('大纲那一页翻上来了', (await page.getAttribute('[data-right-tab="outline"]', 'data-on')) === '1');
  ok('助手那一页藏起来了（不是拆掉）', !(await page.isVisible('[data-agent-pane]')));

  await page.click('[data-right-tab="agent"]');
  await page.waitForTimeout(300);
  ok(
    '翻回来：刚才那几句还在（没被拆掉重来）',
    (await page.locator('[data-agent-text]').count()) === kept,
    `${await page.locator('[data-agent-text]').count()} vs ${kept}`,
  );
  await page.screenshot({ path: `${OUT}/23-agent-in-rightpane.png` });

  step('再点那颗星：把右栏收起来');
  await page.click('[data-agent-toggle]');
  await page.waitForTimeout(300);
  ok('右栏收了', await page.evaluate(() => window.__suisui.getState().rightOpen === false));
  ok('助手跟着看不见了', !(await page.isVisible('[data-agent-pane]')));
  await page.click('[data-agent-toggle]');
  await page.waitForTimeout(300);
  ok('再点一次又回来了', await page.isVisible('[data-agent-pane]'));

  step('窄屏（手机）不给那颗星');
  /*
   * 手机上右栏整条都不渲染 —— 那颗星给了就是一颗按了没反应的按钮。
   * 宁可手机上没有助手，也不给一颗骗人的按钮。
   */
  await page.setViewportSize({ width: 420, height: 860 });
  await page.waitForTimeout(400);
  // ⚠️ 这颗星是靠 CSS（`hidden md:flex`）收的，节点还在 —— 所以要问**看得见吗**，不能问"有几个"
  ok('窄屏没有助手入口', !(await page.locator('[data-agent-toggle]').isVisible()));
  ok('右栏也不在', (await page.locator('[data-rightpane-tabs]').count()) === 0);
  await page.setViewportSize({ width: 1500, height: 920 });
  await page.waitForTimeout(300);

  step('零报错');
  ok('没有页面错误', errors.length === 0, errors.slice(0, 4).join(' | '));
  if (noise.length) console.log(`  · 远端网络噪声 ${noise.length} 条（不算失败）`);
} finally {
  await browser.close();
}

console.log(`\n${failed === 0 ? '全绿' : `红了 ${failed} 条`}`);
process.exit(failed === 0 ? 0 : 1);
