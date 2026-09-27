// 「零报错」那条断言到底该算什么 —— **一个套件一个写法迟早对不上**，所以收在这里。
//
// ## 为什么要把远端网络单独拎出来
//
// 浏览器会把**任何一次失败的网络请求**自动记成一条 console error
// （`Failed to load resource: the server responded with a status of 404 ()`），
// 这跟页面代码写没写错**无关**：只要页面真的去问了远端（启动那次比对、设置里探测），
// 而那个仓库此刻不存在 / 没权限 / 网络不通，就必然有一条。
//
// 于是一个"看网络脸色"的断言会把整套测试变成抽签 —— 这不是在守质量，
// 是在训练大家看见红就重跑一次。
//
// ## 那"仓库通不通"由谁盯
//
// 由**界面**盯，而且是给人看的那一处：设置 → 推送 → 「远端仓库」那一块
// （`data-remote-status`：状态灯 + 一句结论 + 「试一下」）。
// 那条链路本来就要求失败也照实说（`probeRemote` 失败只记状态，不抛、不静默）。
//
// ## 分界线
//
//   · **算失败**：pageerror，以及来自本应用自己的 console error
//     （本地 js/css 加载不出来、接口 500、自己 throw 的 —— 这些是真错）
//   · **不算失败**：第三方域（api.github.com 等）的资源加载失败
//
// ⚠️ 位置 URL 拿不到时**一律算失败**：宁可红一条让人来看，也不放过一个说不清来源的报错。
// ⚠️ 别用"文本里含不含 404 / 401"来判 —— 那是把**应用自己的**接口错误也一起赦免了。

/** 本应用自己（开发服务器 / 预览服务器）的地址。 */
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/;

/**
 * 这条 console error 是不是"浏览器替远端网络记的账"。
 * @param {string} text `m.text()`
 * @param {string} [url] `m.location()?.url`
 */
export function isRemoteNoise(text, url) {
  if (!/Failed to load resource|ERR_[A-Z_]+|net::|NS_ERROR/.test(text)) return false;
  if (!url) return false;
  return !LOCAL.test(url);
}

/**
 * 套件里那两行监听的统一写法（顺手把噪声也记下来，结尾打一行给人看）。
 *
 * 一个套件要盯**好几个页面**时（比如 lazy 那样连开三四个），传第二个参数当公共
 * 收口：`const sink = { errors: [], noise: [] }; … watchConsole(p, sink)`。
 * @param {import('playwright').Page} page
 * @param {{ errors: string[], noise: string[] }} [into]
 */
export function watchConsole(page, into) {
  const errors = into?.errors ?? [];
  const noise = into?.noise ?? [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text().slice(0, 200);
    if (isRemoteNoise(text, m.location()?.url)) {
      noise.push(text);
      return;
    }
    errors.push(text);
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
  return { errors, noise };
}
