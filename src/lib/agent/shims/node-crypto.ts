// `node:crypto` 的浏览器替身。内核用到两个函数，各自的处理不同：
//
//   · `randomBytes` —— **真能用**。内核只拿它当"随机字节数组"来造 id（`newId`），
//     浏览器有 `crypto.getRandomValues`，语义完全对得上。
//   · `createHash`  —— **只能给兜底**。`lib/runtime/audit.ts` 用它算参数摘要，
//     而 WebCrypto 的 `subtle.digest` 是**异步**的，签名对不上；好在审计默认不开启
//     （`audit` 不配置就是关），真要开也建议走 Rust 侧。所以这里给一个同步的非加密
//     哈希（FNV-1a），并在注释里写死它是兜底 —— ⛔ 别拿它当安全用途。
//
// ⚠️ 这两个都只是"让打包与调用通过"。真正的密钥处理不该发生在前端。

export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  return out;
}

export function randomUUID(): string {
  return crypto.randomUUID();
}

class SyncHash {
  private h = 0x811c9dc5;
  update(data: string | Uint8Array): this {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    for (const b of bytes) {
      this.h ^= b;
      this.h = Math.imul(this.h, 0x01000193) >>> 0;
    }
    return this;
  }
  digest(_encoding?: string): any {
    const hex = this.h.toString(16).padStart(8, '0');
    if (_encoding === 'hex') return hex;
    return new TextEncoder().encode(hex);
  }
}

/** ⚠️ 不是 sha256 —— 见文件头。仅为"审计开启时也能跑"提供同步兜底。 */
export function createHash(_algorithm: string): SyncHash {
  return new SyncHash();
}

export default { randomBytes, randomUUID, createHash };
