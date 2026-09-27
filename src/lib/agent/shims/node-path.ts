// `node:path` 的浏览器替身（vendored 内核要用，浏览器/WebView 里没有这一层）。
//
// ## 为什么敢自己写而不是引 path-browserify
//
// 内核拿 path 只做一件事：**把"仓库内的相对路径"拼成规范形式**（join / resolve /
// relative / isAbsolute 那一套）。而我们这儿的路径天生就是正斜杠、且**不准有盘符**
// （`lib/repo.ts` 的硬规矩①：路径是仓库内的相对路径）。Windows 的 `\` 在这一层
// 就该已经归一成 `/` 了 —— 所以这里实现的就是一套纯 POSIX 语义，不处理 `C:\`。
//
// ⚠️ 反过来：谁要是把一个真的 Windows 绝对路径喂进来，`isAbsolute` 仍会认出来
// （正则里带了盘符判断），不会假装它是相对路径 —— 那是沙箱的事，不能在这儿放宽。

export const sep = '/';
export const delimiter = ':';

/** 拆段并去掉空段与 `.`，保留"这是绝对路径"这个信息 */
function segs(p: string): string[] {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!p.startsWith('/')) out.push('..');
      continue;
    }
    out.push(part);
  }
  return out;
}

export function isAbsolute(p: string): boolean {
  if (p.startsWith('/')) return true;
  return /^[A-Za-z]:[\\/]/.test(p);
}

export function normalize(p: string): string {
  if (p === '') return '.';
  const abs = p.startsWith('/');
  const body = segs(p).join('/');
  if (abs) return '/' + body;
  return body === '' ? '.' : body;
}

/**
 * ⚠️ 没有 `process.cwd()` 可用，所以"基准"就是一个 `/`：
 * 内核那条 `path.resolve(config.workspaceRoot ?? process.cwd())` **必须**由宿主
 * 传 `workspaceRoot`（见 `agent/index.ts`）。这里留 cwd='/'，万一漏传也只会得到
 * `/xxx` 这种一眼能看出不对的路径，而不是 undefined。
 */
export function resolve(...parts: string[]): string {
  let base = '/';
  let rest = parts;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (p && isAbsolute(p)) {
      base = p.replace(/\\/g, '/');
      rest = parts.slice(i + 1);
      break;
    }
  }
  const tail = rest.filter(Boolean).join('/');
  if (!tail) return normalize(base);
  return normalize(base.replace(/\/$/, '') + '/' + tail);
}

export function join(...parts: string[]): string {
  const kept = parts.filter((p) => p !== '');
  if (kept.length === 0) return '.';
  const first = kept[0]!;
  const abs = first.startsWith('/');
  const body = segs(kept.join('/')).join('/');
  if (abs) return '/' + body;
  return body === '' ? '.' : body;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  if (i === -1) return '.';
  if (i === 0) return '/';
  return p.slice(0, i);
}

export function basename(p: string, ext?: string): string {
  const i = p.lastIndexOf('/');
  const name = i === -1 ? p : p.slice(i + 1);
  if (ext && name.length > ext.length && name.endsWith(ext)) return name.slice(0, -ext.length);
  return name;
}

export function extname(p: string): string {
  const name = basename(p);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i);
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean);
  const b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => '..');
  return [...up, ...b.slice(i)].join('/') || '.';
}

export function parse(p: string) {
  const dir = dirname(p);
  const base = basename(p);
  const ext = extname(p);
  return { root: p.startsWith('/') ? '/' : '', dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export function format(o: { dir?: string; base?: string; name?: string; ext?: string }): string {
  const base = o.base ?? `${o.name ?? ''}${o.ext ?? ''}`;
  if (!o.dir) return base;
  return o.dir.endsWith('/') ? o.dir + base : o.dir + '/' + base;
}

const path = {
  sep,
  delimiter,
  normalize,
  isAbsolute,
  join,
  resolve,
  relative,
  dirname,
  basename,
  extname,
  parse,
  format,
  posix: { sep, delimiter, normalize, isAbsolute, join, resolve, relative, dirname, basename, extname },
  win32: { sep: '\\', delimiter: ';' },
};

export default path;
