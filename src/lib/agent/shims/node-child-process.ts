/*
 * 浏览器端**不该走到**的那一层（真文件系统 / 子进程 / 终端）。
 *
 * 这些模块还在包里，是因为 vendored 的内核对它们是**静态 import**
 * （`agent.ts` 门面会拉 file-store / jsonl-store / sandbox 进来），打包时躲不开。
 * 但只要宿主按 `agent/index.ts` 那样配置 —— `builtinTools: false`、
 * `memory:{enabled:false}`、`skills:{enabled:false}`、`session.store` 给内存实现 ——
 * **这些函数一次都不会被调到**。
 *
 * 所以这里留的是"调到就大声说"的空壳，而不是悄悄返回空数据。
 * 沉默的空实现会让"内核以为自己写了文件"这种事故查不出来；抛错至少当场可见。
 * ⛔ 别把它改成静默 no-op。
 */

export class BrowserUnsupported extends Error {
  constructor(what: string) {
    super(`浏览器端不支持：${what}。要走真文件系统请用桌面端，或让工具走 Repo 接口。`);
    this.name = 'BrowserUnsupported';
  }
}

const deny = (what: string) => (..._args: any[]): any => {
  throw new BrowserUnsupported(what);
};

export const spawn = deny('child_process.spawn');
export const exec = deny('child_process.exec');
export const execFile = deny('child_process.execFile');
export const fork = deny('child_process.fork');
export const spawnSync = deny('child_process.spawnSync');
export default { spawn, exec, execFile, fork, spawnSync };
