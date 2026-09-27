// 推送功能的端到端（2026-09-27 那次「同步 → 推送」改造）。
//
//   node tests/push-e2e.mjs                          # 打开发服务器 5183
//
// ⚠️ **只能跑开发服务器**：有两处靠 `window.__suisui.setState` 直接摆状态
// （远端文件清单、冲突的两版正文）—— 那个钩子 DEV 才有，产物里没有。
// 「摆状态」而不是"连真远端造一遍"是刻意的：真造一次要连 GitHub、还要制造真冲突，
// 套件会变得又慢又脆，而这里要验的是**界面能不能把东西说清楚**。
//
// 验的是「改回去功能也全对」的那几件事：
//   ① 推送范围能配、能删、能回读（规则是手写的，界面不回读一遍用户就不知道自己配了什么）
//   ② 范围配空了界面会自己说话，不会假装"已经推干净了"
//   ③ 定时开关与间隔是真实控件，不是摆设
//   ④ 拉取是**人选的**：面板要能打开、能搜、Esc 收得掉
//   ⑤ 冲突那块给得出差异、三个按钮的后果写得清楚
//
// ⚠️ 这里**不连远端**（没配 token 时 refreshPlan 根本不会跑）。
// 引擎那半（范围收窄 / 只推不拉 / 快照只记范围内）由 `scope.test.mjs` 和 `decide.test.mjs` 盯，
// 这里只盯"人能不能够到、看见的东西对不对" —— 两端分开，免得一个套件又慢又脆。
import { createRequire } from 'node:module';
import fs from 'node:fs';

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
    console.log('  ✗ ' + name + (extra ? `   → ${extra}` : ''));
  }
};
const step = (s) => console.log('\n== ' + s);

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));

const openSettings = async () => {
  await page.click('[data-settings]');
  await page.waitForSelector('[data-settings-panel]');
  await page.click('[data-settings-nav-item="sync"]');
  await page.waitForTimeout(200);
};

step('打开页面');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.desk');
await page.waitForTimeout(1200);

// ── ① 推送范围：配得动 ──────────────────────────────────────────
step('设置 → 推送：范围能配、能删、能回读');
await openSettings();
{
  ok('分节叫「推送」', (await page.textContent('[data-settings-nav-item="sync"]'))?.includes('推送'));
  ok('有推送范围这一块', (await page.locator('[data-scope-box]').count()) === 1);
  ok('有「推这些」和「但不推这些」两组', (await page.locator('[data-rules]').count()) === 2);

  // 默认出厂是全推 —— 老用户升级后不该发现"突然什么都不推了"
  const presetAll = page.locator('[data-rule-preset="**"]');
  ok('出厂默认是全推（`**` 已在规则里）', (await presetAll.count()) === 1 && (await presetAll.isDisabled()));

  // 加一条目录规则
  await page.fill('[data-rule-input="include"]', 'thoughts/');
  await page.press('[data-rule-input="include"]', 'Enter');
  await page.waitForTimeout(150);
  ok('回车能把规则加进去', (await page.locator('[data-rule="thoughts/"]').count()) === 1);

  // 排除优先级高：加一条单篇排除
  await page.fill('[data-rule-input="exclude"]', 'thoughts/私密.md');
  await page.press('[data-rule-input="exclude"]', 'Enter');
  await page.waitForTimeout(150);
  ok('单篇排除也能加', (await page.locator('[data-rule="thoughts/私密.md"]').count()) === 1);

  // 回读：界面得说出"现在等于什么"，否则用户不知道自己配出了什么
  const box = (await page.textContent('[data-scope-box]')) ?? '';
  ok('回读里点名了排除的篇数', box.includes('除了 1 篇'), box.slice(-80));

  // 删掉
  await page.click('[data-rule-del="thoughts/私密.md"]');
  await page.waitForTimeout(150);
  ok('点 × 能删掉一条', (await page.locator('[data-rule="thoughts/私密.md"]').count()) === 0);

  // 逗号分隔一次加两条（手写规则时很常见）
  await page.fill('[data-rule-input="exclude"]', 'a.md, b.md');
  await page.press('[data-rule-input="exclude"]', 'Enter');
  await page.waitForTimeout(150);
  ok(
    '逗号分隔一次加两条',
    (await page.locator('[data-rule="a.md"]').count()) === 1 && (await page.locator('[data-rule="b.md"]').count()) === 1,
  );
  await page.click('[data-rule-del="a.md"]');
  await page.click('[data-rule-del="b.md"]');
  await page.click('[data-rule-del="thoughts/"]');
  await page.waitForTimeout(150);
}

// ── ② 定时：真控件 ──────────────────────────────────────────────
step('定时推送：开关与间隔');
{
  ok('有定时那一块', (await page.locator('[data-autopush-box]').count()) === 1);
  const sw = page.locator('[data-toggle="autopush"]');
  ok('开关默认关着', (await sw.getAttribute('aria-checked')) === 'false');
  ok('关着时不显示间隔（不给用不上的选项）', (await page.locator('[data-autopush-min]').count()) === 0);

  await sw.click();
  await page.waitForTimeout(200);
  ok('打开后间隔出来了', (await page.locator('[data-autopush-min]').count()) === 5);

  await page.click('[data-autopush-min="15"]');
  await page.waitForTimeout(150);
  ok('选 15 分钟会选中', (await page.getAttribute('[data-autopush-min="15"]', 'data-on')) === '1');

  await sw.click();
  await page.waitForTimeout(150);
  ok('再点回去能关', (await sw.getAttribute('aria-checked')) === 'false');
}

// ── ③ 范围空了要自己说话 ────────────────────────────────────────
step('范围配空：界面自己说明，不假装"推干净了"');
{
  await page.evaluate(() =>
    window.__suisui.setState({ scope: { include: [], exclude: [] }, changes: [], planStale: false }),
  );
  // 用 Esc 收面板：点遮罩的中心会打在面板自己身上（遮罩在它下面一层）
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('设置面板收掉了', (await page.locator('[data-settings-panel]').count()) === 0);
  ok('清单给出「推送范围是空的」', (await page.locator('[data-scope-empty]').count()) === 1);
  const t = (await page.textContent('[data-changes]')) ?? '';
  ok('没说「没有要推的」（那是撒谎）', !t.includes('范围里没有要推的'), t.slice(0, 80));
  await page.screenshot({ path: `${OUT}/90-推送范围为空.png` });
}

// ── ④ 拉取：人选的 ──────────────────────────────────────────────
step('拉取：面板能开、能搜、Esc 收得掉');
{
  await page.evaluate(() =>
    window.__suisui.setState({
      scope: { include: ['**'], exclude: [] },
      remoteFiles: { 'thoughts/2026-09-21-开张.md': 'a', 'notes/随手.md': 'b', 'README.md': 'c' },
      changes: [],
      planStale: false,
    }),
  );
  await page.click('[data-pull]');
  await page.waitForSelector('[data-remote-panel]');
  ok('远端面板打开了', (await page.locator('[data-remote-panel]').count()) === 1);
  ok('列出了远端的文件', (await page.locator('[data-remote-row]').count()) >= 2, String(await page.locator('[data-remote-row]').count()));
  // 程序文件在远端浏览里也该藏起来（跟左侧一个规矩，别两处两套）
  ok('程序文件不出现', (await page.locator('[data-remote-row="README.md"]').count()) === 0);

  await page.fill('[data-remote-search]', '随手');
  await page.waitForTimeout(200);
  ok('搜得到', (await page.locator('[data-remote-row]').count()) === 1, String(await page.locator('[data-remote-row]').count()));
  await page.fill('[data-remote-search]', '');
  await page.waitForTimeout(150);

  ok('没勾时拉取按钮是禁用的（不给"闭眼全拉"）', await page.locator('[data-remote-pull]').isDisabled());

  await page.click('[data-remote-row="notes/随手.md"]');
  await page.waitForTimeout(150);
  ok('勾上一篇后能拉了', !(await page.locator('[data-remote-pull]').isDisabled()));
  ok('计数说出来勾了几篇', ((await page.textContent('[data-remote-count]')) ?? '').includes('1 篇'));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('Esc 收掉了', (await page.locator('[data-remote-panel]').count()) === 0);
}

// ── ⑤ 冲突：给得出差异、后果写得清 ──────────────────────────────
step('冲突：显示差异 + 三个按钮');
{
  // 直接摆状态（openConflict 要连远端，这里只验面板本身）
  await page.evaluate(() =>
    window.__suisui.setState({
      files: { 'thoughts/散步.md': '# 散步\n\n今天走了很久。\n' },
      conflictOf: 'thoughts/散步.md',
      conflictRemote: '# 雨天散步\n\n今天走了很久。\n\n泡了茶。\n',
      conflictBusy: false,
    }),
  );
  await page.waitForSelector('[data-conflict-panel]');
  ok('冲突面板打开了', (await page.locator('[data-conflict-panel]').count()) === 1);
  ok('有删掉的行（本机有、云端没有）', (await page.locator('[data-diff-line="del"]').count()) >= 1);
  ok('有新增的行（云端有、本机没有）', (await page.locator('[data-diff-line="add"]').count()) >= 1);

  for (const side of ['local', 'remote', 'both']) {
    ok(`有「${side}」这颗按钮`, (await page.locator(`[data-conflict-side="${side}"]`).count()) === 1);
  }
  const foot = (await page.textContent('[data-conflict-panel] footer')) ?? '';
  ok('按钮写清了后果（谁覆盖谁）', foot.includes('覆盖云端') && foot.includes('覆盖本机'), foot.slice(0, 120));
  await page.screenshot({ path: `${OUT}/91-冲突选边.png` });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('Esc 关掉（不处理，冲突还留在清单里）', (await page.locator('[data-conflict-panel]').count()) === 0);
}

step('控制台');
ok('零报错', errors.length === 0, errors.join(' | '));

console.log('\n结果：' + pass + ' 通过 / ' + bad.length + ' 失败');
if (bad.length) console.log('失败项：' + bad.join('；'));
await browser.close();
if (bad.length) process.exit(1);
