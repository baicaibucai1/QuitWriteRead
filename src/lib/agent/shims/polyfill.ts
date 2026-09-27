/*
 * 把内核需要的 Node 全局挂到 globalThis —— **必须在任何内核模块之前执行**，
 * 所以 lib/agent/index.ts 的第一行就是 import 它。
 *
 * · `process.cwd()` 故意返回 '/'：内核那条
 *   `path.resolve(config.workspaceRoot ?? process.cwd())` 只在宿主漏传 workspaceRoot
 *   时才走到，给它一个"一看就不对"的值，比返回 undefined 好查。
 * · `setImmediate` 在浏览器里没有，内核用它让出一次事件循环（loop.ts 里
 *   把"这一步的收尾"排到当前微任务之后）—— setTimeout(fn, 0) 语义够用。
 */

type Mutable = Record<string, unknown>;
const g = globalThis as unknown as Mutable;

if (g.process === undefined) {
  g.process = {
    cwd: () => '/',
    env: {},
    platform: 'browser',
    version: 'browser',
    kill: () => undefined,
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  };
}

if (g.Buffer === undefined) {
  g.Buffer = {
    from: (input: string | Uint8Array) => (typeof input === 'string' ? new TextEncoder().encode(input) : input),
    isBuffer: () => false,
    alloc: (size: number) => new Uint8Array(size),
  };
}

if (g.setImmediate === undefined) {
  g.setImmediate = (fn: () => void) => setTimeout(fn, 0);
}

export {};
