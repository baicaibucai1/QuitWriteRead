// `node:url` 的浏览器替身。内核只在 file:// 与路径互转时用它，
// 我们这条路上没有真文件 URL，给一个能转回去的最小实现。
export function fileURLToPath(url: string | URL): string {
  return decodeURIComponent(String(url).replace(/^file:\/\//, ''));
}
export function pathToFileURL(p: string): URL {
  return new URL('file://' + encodeURIComponent(p).replace(/%2F/g, '/'));
}
export default { fileURLToPath, pathToFileURL };
