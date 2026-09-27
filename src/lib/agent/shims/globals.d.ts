// 内核里那些"只有 Node 才有"的全局：process、Buffer、NodeJS.Timeout。
// 宿主项目不带 @types/node（它只认 vite/client），所以这里补最小声明：
// 类型够用即可，运行时由 polyfill.ts 挂上去。
declare namespace NodeJS {
  type Timeout = ReturnType<typeof setTimeout>;
  interface ErrnoException extends Error {
    code?: string;
    errno?: number;
    path?: string;
    syscall?: string;
  }
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
}

interface BrowserProcess {
  cwd(): string;
  env: Record<string, string | undefined>;
  platform: string;
  version: string;
  kill(pid: number): void;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
}

declare const process: BrowserProcess;

// ⛔ 只声明、不实现：真用到 Buffer 的路子（附件 base64）我们走 Repo 的
// readBytes/writeBytes，不进这一层。声明在这里只为让类型检查过。
declare const Buffer: {
  from(input: string | Uint8Array, encoding?: string): Uint8Array;
  isBuffer(v: unknown): boolean;
  alloc(size: number): Uint8Array;
};

type BufferAsType = Uint8Array;

// 内核用它让出一次事件循环（loop.ts 的 tick()）；浏览器没有，由 polyfill 挂上去。
declare function setImmediate(handler: () => void): unknown;
