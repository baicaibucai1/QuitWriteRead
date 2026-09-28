// 设置对话框的端到端。
//
//   node tests/settings-e2e.mjs                            # 默认打开发服务器 5183
//   DEMO_URL=http://localhost:5184 node tests/settings-e2e.mjs
//
// 验的是几件「改回去功能也全对」的事：
//   ① 入口在左下角 —— 顶栏只说状况，动手的按钮沉在 dock 上
//   ② 没做完的后端是 disabled + 标「待接入」，不是假按钮
//   ③ 凭据跟着后端走（选谁配谁），且没配时齿轮上顶红点
//   ④ 对话框是居中的、独占一屏的：Esc / 点遮罩都收得掉，分节导航切得动
//   ⑤ 「阅读」一节和阅读器共用同一份排版偏好（在这改，读的时候跟着变）
//
// ⚠️ 壁纸功能已经整块拿掉了（2026-09-21）。这里留一条负向断言：
// 台面上不许再出现壁纸层，面板里也不许再有壁纸字样 —— 防止哪天又被塞回来。
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

const DESK = '.desk';

step('打开页面');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(DESK);
await page.waitForTimeout(1200);
// 负向断言：壁纸整块拿掉了，台面不该再有任何壁纸的痕迹
ok('没有壁纸层节点', (await page.locator('.desk-wall, .desk-wall-img, .desk-wall-veil').count()) === 0);
ok('台面不再打 data-wall', (await page.getAttribute(DESK, 'data-wall')) === null);
ok(
  '没有 --wall-* 变量',
  await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.desk'));
    return !s.getPropertyValue('--wall-url').trim() && !s.getPropertyValue('--wall-dim').trim();
  }),
);

/*
 * 入口位置：设置在**左下角那条 dock** 里，同步在底部状态栏上。
 *
 * ⚠️ 顶栏**回来了**（2026-09 那次骨架重做）：它现在管三件事 —— 书写 / 阅读的切换、
 * 当前文件路径、左右两栏的收起。这边守的是"**只有一条**"：
 * 顶栏的公信力来自唯一性，两条顶栏就没有"顶"了。
 */
/*
 * 入口在左下角 —— 但**同步已经不在这儿了**。
 * 同步是"整个库对外的动作"，现在收成小钮放在底部状态栏上（跟它报的状况同一条）；
 * ⚠️ **同步又搬回 dock 了**（2026-09-26，用户要求"同步放在设置旁边"）：
 * 三颗一行，顺序「刷新差异 → 同步 → 设置」。这段守三件事：
 *   ① dock 就是三颗，别再多也别再少；
 *   ② 同步**紧挨着**设置（中间不夹别的东西）；
 *   ③ 全应用只有这一颗同步 —— 状态栏那颗已经撤了，不许再长回来。
 */
step('入口在左下角（同步在 dock，挨着设置）');
{
  ok('顶栏只有一条', (await page.locator('header').count()) === 1);
  ok('刷新差异还在 dock 里', (await page.locator('[data-dock] [data-refresh]').count()) === 1);

  // dock 只管动手，状况并进了上面的「待同步」抬头 —— 一行装得下（两行那条试过，臃肿）
  const dockH = (await page.locator('[data-dock]').boundingBox()).height;
  ok('dock 只有一行', dockH <= 56, `高 ${dockH}px`);
  /*
   * 四颗：刷新 → 推送 → 拉取 → 设置。
   * 「拉取」是 2026-09-27 加的第四颗 —— 推送改成可以定时自动，拉取则永远是人挑的，
   * 两个方向并排摆着，谁挨着谁都能一眼看出是两件事。
   */
  ok(
    'dock 是四颗按钮（刷新 + 推送 + 拉取 + 设置）',
    (await page.locator('[data-dock] button').count()) === 4,
    String(await page.locator('[data-dock] button').count()),
  );
  ok('推送在 dock 里', (await page.locator('[data-dock] [data-sync]').count()) === 1);
  ok('拉取也在 dock 里', (await page.locator('[data-dock] [data-pull]').count()) === 1);
  ok(
    '顺序是 刷新 → 推送 → 拉取 → 设置（拉取紧挨着设置）',
    (await page.locator('[data-dock] button').evaluateAll((els) =>
      els.map((e) => e.dataset.refresh !== undefined ? 'refresh' : e.dataset.sync !== undefined ? 'push' : e.dataset.pull !== undefined ? 'pull' : e.dataset.settings !== undefined ? 'settings' : '?'),
    )).join('>') === 'refresh>push>pull>settings',
  );
  // 四颗挤在 272px 里，文字最容易先被吃掉
  ok(
    '四颗的字都没被挤掉（不是「推…」）',
    (await page.locator('[data-dock] button').evaluateAll((els) =>
      els.map((e) => {
        const s = e.querySelector('span');
        return !!s && e.scrollWidth <= e.clientWidth + 1 && s.textContent.trim().length >= 2;
      }),
    )).every(Boolean),
  );

  const aside = await page.locator('[data-drawer]').boundingBox();
  const dock = await page.locator('[data-dock]').boundingBox();
  ok('dock 贴着左边缘', !!dock && Math.abs(dock.x - aside.x) < 1, JSON.stringify(dock));
  ok(
    'dock 在这一列的最底部',
    !!dock && Math.abs(dock.y + dock.height - (aside.y + aside.height)) < 1.5,
    `dock底=${dock ? dock.y + dock.height : '?'} aside底=${aside.y + aside.height}`,
  );

  // 同步在 dock 里，跟设置同一行、同一个底
  const sync = await page.locator('[data-sync]').boundingBox();
  ok('同步钮在这一列里（不在状态栏）', !!sync && !!aside && sync.x < aside.x + aside.width, JSON.stringify(sync));
  ok('同步钮是小钮（不占一整列宽）', !!sync && sync.width < 120, sync ? String(sync.width) : 'no');
  const gear = await page.locator('[data-settings]').boundingBox();
  ok(
    '同步紧挨着设置（水平相邻，同一行）',
    !!gear && !!sync && sync.x < gear.x && Math.abs(sync.y - gear.y) < 1,
    `sync=${JSON.stringify(sync)} gear=${JSON.stringify(gear)}`,
  );
  ok(
    '全应用只有一颗同步（状态栏上没有了）',
    (await page.locator('footer.status-bar [data-sync]').count()) === 0,
  );
  await page.screenshot({ path: `${OUT}/08-左下角-dock.png` });
}

step('打开设置对话框');
await page.click('[data-settings]');
await page.waitForSelector('[data-settings-panel]', { timeout: 5000 });
ok('对话框出来了', await page.isVisible('[data-settings-panel]'));
{
  // 形状：遮罩 + 居中一张大卡。以前是从左边缘推出的抽屉（x≈0），
  // 现在它必须真的"居中" —— 左边留出的空当要跟右边大致对称。
  const vw = await page.evaluate(() => window.innerWidth);
  const box = await page.locator('[data-settings-panel]').boundingBox();
  ok('卡片比抽屉时代宽（横着铺得开四行排版）', !!box && box.width >= 700, box ? String(box.width) : 'no box');
  ok(
    '卡片居中（左右留白对称）',
    !!box && Math.abs(box.x - (vw - box.x - box.width)) < 24,
    JSON.stringify(box),
  );
  ok('遮罩在', (await page.locator('[data-settings-mask]').count()) === 1);

  const text = await page.textContent('[data-settings-panel]');
  ok('五节导航都在', ['常规', '推送', 'AI 助手', '阅读', '关于'].every((t) => text.includes(t)));
  ok('面板里没有壁纸字样了', !text.includes('壁纸') && !text.includes('台面'));
  ok('默认停在常规', (await page.getAttribute('[data-settings-panel]', 'data-settings-tab')) === 'general');
  ok('导航项有五颗', (await page.locator('[data-settings-nav-item]').count()) === 5);
}

step('AI 助手那一节：选一家 → 填 Key → 试一下');
{
  await page.click('[data-settings-nav-item="agent"]');
  await page.waitForTimeout(200);
  ok('切到 AI 助手', (await page.getAttribute('[data-settings-panel]', 'data-settings-tab')) === 'agent');
  /*
   * 默认**不演示**。上一版默认演示「读」，结果人打开助手问一句，它按脚本答一句
   * 跟问题无关的话 —— 看着像在工作，其实根本没连模型。没配就是没配。
   */
  ok('默认不演示', await page.evaluate(() => window.__suisui.getState().agent.demo === 'off'));
  ok('所以一上来就给 Key 输入框', (await page.locator('[data-agent-key]').count()) === 1);
  ok('服务商八颗可选', (await page.locator('[data-provider]').count()) === 8);
  ok('默认选中 DeepSeek', (await page.getAttribute('[data-provider="deepseek"]', 'data-on')) === '1');
  ok(
    '地址跟着那一家走（不用人记 /v1 这种）',
    (await page.inputValue('[data-agent-baseurl]')) === 'https://api.deepseek.com/v1',
  );
  ok('型号也跟着', (await page.inputValue('[data-agent-model]')) === 'deepseek-chat');
  ok('常用型号摆成了可点的', (await page.locator('[data-model-chip]').count()) === 2);

  // 换一家：连地址带型号一起换 —— 这几家地址长得都不一样，手填一次错一次
  await page.click('[data-provider="qwen"]');
  await page.waitForTimeout(200);
  ok(
    '换通义：地址整条换了',
    (await page.inputValue('[data-agent-baseurl]')) === 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  );
  ok('型号也换成它家的', (await page.inputValue('[data-agent-model]')) === 'qwen-plus');

  /*
   * Agnes：这家有**免费额度**，对"先零成本跑通"特别合适 —— 所以要确认真选得上。
   * 只验地址与型号跟着走；它通不通由人自己点「试一下」决定（要不要联网由他说了算）。
   */
  await page.click('[data-provider="agnes"]');
  await page.waitForTimeout(200);
  ok('选 Agnes：地址是 apihub 那个', (await page.inputValue('[data-agent-baseurl]')) === 'https://apihub.agnes-ai.com/v1');
  ok('默认型号是 2.5-flash', (await page.inputValue('[data-agent-model]')) === 'agnes-2.5-flash');
  ok('常用型号摆出来了', (await page.locator('[data-model-chip]').count()) === 3);
  await page.click('[data-provider="deepseek"]');
  await page.waitForTimeout(200);

  /*
   * 试一下。**没填 Key 时不打网络** —— 这条要验的是"它会直说还没填 Key"，
   * 而不是甩一句看不懂的失败。
   */
  await page.click('[data-agent-probe]');
  await page.waitForTimeout(400);
  ok('试了一下给了结论', (await page.getAttribute('[data-probe-state]', 'data-probe-state')) === 'error');
  ok('说的是"还没填 Key"（不是甩一个 HTTP 码）', (await page.textContent('[data-probe-state]')).includes('还没填 Key'));
  ok('没拉到过就不摆那个列表', (await page.locator('[data-model-list]').count()) === 0);
  ok('拉失败的提示不抹掉以前拉到的（现在也确实没有）', (await page.locator('[data-model-pick]').count()) === 0);

  /*
   * ══ 真点一次「拉取」 ══
   *
   * 上面那段验的是"缺 Key 会怎么说"，这一段验的是**链路真的通**：
   * 把网络拦掉冒充端点，看拉回来的型号有没有真的落进 store。
   * 端到端里不该赌人家放不放行 CORS —— 拦掉之后它就是确定的。
   */
  /*
   * Key 里混了中文/全角：浏览器连请求头都构造不出来，会抛一个跟断网一模一样的
   * TypeError。以前那句翻译会教你"换个桌面端试试" —— 桌面端也救不了几个非法字符。
   * 这条就是把这个坑钉在这儿。
   */
  await page.fill('[data-agent-key]', 'sk-这是假的，别当真');
  await page.click('[data-agent-probe]');
  await page.waitForTimeout(400);
  ok('Key 带中文：直说是字符的问题', (await page.textContent('[data-probe-state]')).includes('中文'));
  ok(
    '而且**不**把人往网络那条路上引',
    !(await page.textContent('[data-probe-state]')).includes('桌面端'),
    (await page.textContent('[data-probe-state]')).slice(0, 40),
  );

  await page.fill('[data-agent-key]', 'sk-fake-key-for-tests');
  /*
   * ⚠️ fulfill 出来的响应要**自带 CORS 头**：这是浏览器在拦，不是 playwright 不发货；
   *    带上 Authorization 的请求还会先抖一个 OPTIONS 预检，所以 Allow-Methods / Headers 也得给齐。
   */
  const CORS_OK = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  await page.route('**/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS_OK,
      body: JSON.stringify({ data: [{ id: 'route-a' }, { id: 'route-b' }] }),
    }),
  );
  await page.click('[data-agent-probe]');
  await page.waitForFunction(() => window.__suisui.getState().agent.models.length > 0, { timeout: 15000 });
  const got = await page.evaluate(() => window.__suisui.getState().agent.models);
  ok('拉回来的型号真的进了 store', got.length === 2 && got[0] === 'route-a', got.join(','));
  ok('那句结论是"连上了"', (await page.textContent('[data-probe-state]')).includes('连上了'));
  ok('列表跟着出来了', (await page.locator('[data-model-pick]').count()) === 2);
  ok('记下了是哪个地址拉的', await page.evaluate(() => window.__suisui.getState().agent.modelsURL === 'https://api.deepseek.com/v1'));
  await page.unroute('**/models');
  await page.click('[data-model-forget]'); // 下面要喂另一份，先清干净
  await page.waitForTimeout(200);

  /*
   * ══ 列表那块怎么摆 ══
   *
   * 喂一份假列表进去，专门验界面：全摆出来了吗、能搜吗、选得上吗、能忘掉吗。
   */
  const SEED_MODELS = ['alpha-1', 'alpha-2', 'beta-7', 'gamma-max'];
  await page.evaluate((list) => {
    const s = window.__suisui.getState();
    s.setAgent({ models: list, modelsAt: new Date().toISOString(), modelsURL: s.agent.baseURL.trim() });
  }, SEED_MODELS);
  await page.waitForTimeout(250);

  ok('喂进去之后列表出来了', (await page.locator('[data-model-list]').count()) === 1);
  ok('型号全摆着（不是只给前 12 个）', (await page.locator('[data-model-pick]').count()) === 4);
  ok('总数写在那儿', (await page.textContent('[data-model-count]')).includes('共 4 个'));
  ok(
    '列表自己交代了来历与时间（不跟那次拉取的结论抢地方）',
    (await page.textContent('[data-model-from]')).includes('4 个型号') &&
      (await page.textContent('[data-model-from]')).includes('存在本机'),
  );
  ok('按钮变成"重新拉取"', (await page.textContent('[data-agent-probe]')).includes('重新拉取'));

  await page.fill('[data-model-search]', 'alpha');
  await page.waitForTimeout(200);
  ok('一搜就只剩对得上的', (await page.locator('[data-model-pick]').count()) === 2);
  ok('计数跟着改成 命中 / 总数', (await page.textContent('[data-model-count]')).includes('2 / 4'));

  await page.fill('[data-model-search]', ''); // 清掉关键字，不然 beta-7 被自己筛掉了
  await page.waitForTimeout(200);
  await page.click('[data-model-pick="beta-7"]');
  await page.waitForTimeout(200);
  ok('点一下就选上了', (await page.inputValue('[data-agent-model]')) === 'beta-7');

  await page.fill('[data-model-search]', '不存在的关键字');
  await page.waitForTimeout(200);
  ok('搜空了会直说（不是留个空框）', (await page.textContent('[data-model-list]')).includes('没有对得上的型号'));
  await page.fill('[data-model-search]', '');

  /*
   * **这条是这套设计的关键**：cache 是跟地址绑的。
   * 换一家/改了地址还摆着上一份，人照着它选，端点回的就是 422。
   */
  await page.fill('[data-agent-baseurl]', 'https://api.openai.com/v1');
  await page.waitForTimeout(250);
  ok('地址一改，那份列表就不作数了', (await page.locator('[data-model-list]').count()) === 0);
  await page.fill('[data-agent-baseurl]', 'https://api.deepseek.com/v1');
  await page.waitForTimeout(250);
  ok('改回来又认了', (await page.locator('[data-model-list]').count()) === 1);

  await page.click('[data-model-forget]');
  await page.waitForTimeout(250);
  ok('「忘掉」把本机那份清了', (await page.locator('[data-model-list]').count()) === 0);
  ok('也真的从 store 里没了', await page.evaluate(() => window.__suisui.getState().agent.models.length === 0));

  ok('十个工具全列出来了', (await page.locator('[data-agent-tool-row]').count()) === 10);
  ok('写权限默认开着', (await page.getAttribute('[data-toggle="agent-write"]', 'aria-checked')) === 'true');
  ok('所以计数是十个', (await page.textContent('[data-agent-tool-count]')).trim().startsWith('10 /'));
  await page.click('[data-toggle="agent-write"]');
  await page.waitForTimeout(200);
  ok('关掉写权限，清单上三个写工具一起摘', (await page.getAttribute('[data-agent-tool-row="append_note"]', 'data-on')) === '0');
  ok('计数跟着变七个', (await page.textContent('[data-agent-tool-count]')).trim().startsWith('7 /'));

  // 演示三档：它是退路，不再抢在前面 —— 选了演示，Key 那一片就不该摆着
  ok('演示三档还在', (await page.locator('[data-demo]').count()) === 3);
  await page.click('[data-demo="write"]');
  await page.waitForTimeout(200);
  ok('选了演示写，写工具就开了', (await page.getAttribute('[data-agent-tool-row="write_note"]', 'data-on')) === '1');
  ok('演示时不摆 Key 输入框（填了也不生效）', (await page.locator('[data-agent-key]').count()) === 0);

  const st = await page.evaluate(() => window.__suisui.getState().agent);
  ok('写权限真的翻了', st.allowWrite === false);
  // 还原：后面的用例不该接着一份改过的助手配置
  await page.evaluate(() =>
    window.__suisui.getState().setAgent({
      demo: 'off',
      allowWrite: true,
      prov: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      // 上面那段喂的列表要清干净 —— 后面的用例不该接着一份假数据
      models: [],
      modelsAt: null,
      modelsURL: '',
    }),
  );
  await page.waitForTimeout(150);
}

step('分节导航切得动');
{
  await page.click('[data-settings-nav-item="reading"]');
  await page.waitForTimeout(200);
  ok('切到阅读', (await page.getAttribute('[data-settings-panel]', 'data-settings-tab')) === 'reading');
  ok('阅读节的四行控件都在', await page.isVisible('[data-settings-panel] [data-reader-fonts]'));
  ok('预览块也给了', await page.isVisible('[data-reader-preview]'));
  ok('五档纸色都列出来了', (await page.locator('[data-set-theme-btn]').count()) === 5);
  ok('四档字体都列出来了', (await page.locator('[data-set-font-btn]').count()) === 4);

  await page.click('[data-settings-nav-item="about"]');
  await page.waitForTimeout(200);
  ok('关于里说了"真的 markdown 文件"', (await page.textContent('[data-settings-body]')).includes('markdown'));
  await page.click('[data-settings-nav-item="general"]');
  await page.waitForTimeout(200);
  ok('常规节有显示全部文件的开关', await page.isVisible('[data-toggle="showall"]'));
}

/*
 * 「阅读」一节不是摆设：在这改排版，读的时候得跟着变 ——
 * 两处入口共用一份 store 状态（家在 IndexedDB），这里验的就是这条链路通着。
 */
step('阅读排版：设置里改，状态真的动了');
{
  const themeNow = () => page.evaluate(() => window.__suisui.getState().readerPrefs.theme);
  await page.click('[data-settings-nav-item="reading"]');
  await page.waitForTimeout(200);
  const before = await themeNow();
  const target = before === 'green' ? 'cyan' : 'green';
  await page.click(`[data-set-theme-btn="${target}"]`);
  await page.waitForTimeout(300);
  ok('点了一档纸色，状态跟着走', (await themeNow()) === target, `${before} → ${await themeNow()}`);
  ok('预览块的纸色属性也跟上了', (await page.getAttribute('[data-reader-preview]', 'data-book-theme')) === target);
  // 还原，别把这套偏好留给后面的用例
  await page.click(`[data-set-theme-btn="${before}"]`);
  await page.waitForTimeout(200);
  ok('能切回去', (await themeNow()) === before);
}

step('同步：后端不放假按钮');
await page.click('[data-settings-nav-item="sync"]');
await page.waitForTimeout(250);
ok('三个后端都列出来了', (await page.locator('[data-provider]').count()) === 3);
ok('GitHub 默认选中', (await page.getAttribute('[data-provider="github"]', 'class'))?.includes('bg-accent-soft') === true);
// 没做完的后端必须是 disabled + 标「待接入」：给一个按了没反应的按钮比不给更糟
ok('OneDrive 点不动（授权还没接）', await page.locator('[data-provider="onedrive"]').isDisabled());
ok('OneDrive 标了待接入', (await page.textContent('[data-provider="onedrive"]')).includes('待接入'));
await page.click('[data-provider="nutstore"]');
await page.waitForSelector('[data-dav-warn]');
ok('网页版把坚果云的限制说清楚了', (await page.textContent('[data-dav-warn]')).includes('CORS'));
ok('坚果云的凭据框在（先填着，桌面端能用）', await page.isVisible('[data-dav-user]'));
// 切回去：provider 是持久化的，留在坚果云上会让后面的用例连错地方
await page.click('[data-provider="github"]');

step('凭据：跟着后端走，搬出顶栏');
{
  ok(
    '凭据框在面板里（不再挂在顶栏那颗钥匙上）',
    await page.isVisible('[data-settings-panel] [data-token]'),
  );
  ok('凭据框是密码框', (await page.getAttribute('[data-token]', 'type')) === 'password');
  /*
   * 红点从顶栏那颗钥匙挪到了齿轮上：没配凭据就一直在。
   * ⚠️ dev 环境常常由 .env.local 自带 VITE_GH_TOKEN，所以"初始有红点"不成立 ——
   * 判据只能是"清掉 token 就出现、填上就消失"这个方向上的关系。
   */
  const realToken = await page.inputValue('[data-token]');
  await page.locator('[data-token]').fill('');
  await page.waitForTimeout(200);
  ok('没配凭据时齿轮上顶着红点', (await page.locator('[data-cred-dot]').count()) === 1);
  await page.locator('[data-token]').fill('ghp_d_e2e_only');
  await page.waitForTimeout(200);
  ok('配上之后红点消失', (await page.locator('[data-cred-dot]').count()) === 0);
  ok('面板里还有一颗「立即同步」', await page.isVisible('[data-sync-now]'));
  // 还原，而且必须还原到原来那个：后面还有 reload 的用例，留一个假 token
  // 会让页面一进来就自动比对，蹭蹭吃三个 401（控制台零报错那条就要红了）
  await page.locator('[data-token]').fill(realToken);
  await page.waitForTimeout(200);
}

step('Esc 收面板，点遮罩也收');
{
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('Esc 关掉了', (await page.locator('[data-settings-panel]').count()) === 0);
  // 再开一次，这回点遮罩 —— 两个手势说的是同一件事，都得管用
  await page.click('[data-settings]');
  await page.waitForSelector('[data-settings-panel]');
  await page.mouse.click(12, 450); // 卡片居中，这个点落在遮罩上
  await page.waitForTimeout(250);
  ok('点遮罩也关掉了', (await page.locator('[data-settings-panel]').count()) === 0);
}

step('手机上：整屏铺满，导航转横排');
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-settings]');
// 手机上入口在**抽屉**里（这一列整体变成了从左侧推入的浮层）：
// 得先把抽屉拉出来，够得着左下角那个齿轮。
await page.click('[data-drawer-toggle]');
await page.waitForTimeout(400);
ok('齿轮也跟着抽屉进来了', await page.isVisible('[data-settings]'));
await page.click('[data-settings]');
await page.waitForSelector('[data-settings-panel]');
const box = await page.locator('[data-settings-panel]').boundingBox();
ok('设置铺满窄屏', !!box && box.width >= 380 && box.x < 2, box ? JSON.stringify(box) : 'no box');
ok('分节导航横着排在顶上', await page.isVisible('[data-settings-nav]'));
await page.screenshot({ path: `${OUT}/07-设置-手机.png` });

step('控制台');
ok('零报错', errors.length === 0, errors.slice(0, 3).join(' | '));
if (noise.length) console.log(`  · 远端网络噪声 ${noise.length} 条（不算失败 —— 仓库通不通看设置里「远端仓库」那块）`);

await browser.close();
console.log(`\n结果：${pass} 通过 / ${bad.length} 失败`);
if (bad.length) console.log('失败：\n' + bad.map((b) => '  - ' + b).join('\n'));
process.exit(bad.length ? 1 : 0);
