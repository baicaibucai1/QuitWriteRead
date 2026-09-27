import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/*
 * vendored 的 agent 内核（src/lib/agent/core/）原本是给 Node 写的，里面有
 * `node:path` / `node:fs` 这类 import。浏览器里没有它们，也不该有 ——
 * 内核的循环、权限、压缩那半是纯逻辑，落盘那半我们**根本不用**（笔记读写走
 * `lib/repo.ts` 的 Repo 接口）。所以这里把 node 内置换成替身：
 *
 *   · path / os / crypto / url —— 真实现（见 shims 目录里的说明）
 *   · fs / child_process / readline / stream —— 空壳，**调到就抛错**
 *     （静默返回空数据会让"内核以为自己写了文件"这种事故查不出来）
 *
 * ⚠️ 别把这条改成"整个 node:* 都指向空对象"：那样打包能过，但 path.join 会
 * 静默返回 undefined，路径拼错就看不出来了。
 */
const shim = (name: string) => fileURLToPath(new URL(`./src/lib/agent/shims/${name}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      'node:path': shim('node-path.ts'),
      'node:os': shim('node-os.ts'),
      'node:crypto': shim('node-crypto.ts'),
      'node:url': shim('node-url.ts'),
      'node:fs': shim('node-fs.ts'),
      'node:fs/promises': shim('node-fs-promises.ts'),
      'node:child_process': shim('node-child-process.ts'),
      'node:readline': shim('node-readline.ts'),
      'node:stream': shim('node-stream.ts'),
    },
  },
  server: {
    // 绑所有网卡：手机连同一个 WiFi 就能打开，真机预览靠这个。
    // localhost / 127.0.0.1 照常可用，桌面 e2e 不受影响。
    host: true,
    port: 5183,
    strictPort: true,
  },
  preview: {
    // 正式产物预览。Service Worker / 「添加到主屏幕」只有在构建产物上才能验
    // —— 开发期是 Vite 的内存模块图，没有可缓存的静态文件。
    host: true,
    port: 5184,
  },
});
