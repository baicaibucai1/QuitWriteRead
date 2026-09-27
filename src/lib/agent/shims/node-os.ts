// `node:os` 的浏览器替身。内核只拿它问三件事：家目录在哪、什么架构、换行符。
// 家目录在浏览器里没有对应物 —— 宿主**必须**显式传 `homeDir`，
// 这里给一个一眼能看出是占位的路径，免得它悄悄变成 undefined 混进系统提示词。
export function homedir() {
  return '/home';
}
export function arch() {
  return 'browser';
}
export function platform() {
  return 'browser';
}
export function tmpdir() {
  return '/tmp';
}
export function hostname() {
  return 'browser';
}
export const EOL = '\n';
export const type = 'Browser';
export default { homedir, arch, platform, tmpdir, hostname, EOL, type };
