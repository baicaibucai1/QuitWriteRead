/*
 * 连通性自检的单测：**失败要能自己说出原因**。
 *
 * 这一类代码最容易被写成「失败就报错」，然后界面上只剩三个字"连不上"，
 * 人对着它只能一个一个试 Key。所以这里盯的不是"能不能连"，
 * 而是**每种失败是不是都说到了点上** —— 尤其 CORS：它跟"Key 填错了"
 * 在浏览器里长得一模一样（都是 TypeError），不说清就是害人换一下午 Key。
 *
 * 跑：node tests/probe.test.mjs
 * （probe.ts 是零依赖纯逻辑，node 直接 import .ts 就行 —— 别给它加 import）
 */
import assert from 'node:assert/strict';
import { explain, explainNetError, modelsOf, probeModel } from '../src/lib/agent/probe.ts';

let pass = 0;
let bad = 0;
const ok = async (label, fn) => {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + label);
  } catch (e) {
    bad++;
    console.log('  ✗ ' + label + ' — ' + (e && e.message ? e.message.split('\n')[0] : e));
  }
};

const res = (status, body = '', json = null) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
  json: async () => json,
});

console.log('\n状态码 → 人话');
await ok('401 = Key 不对', () => assert.match(explain(401, ''), /Key 不对/));
await ok('403 = 没权限，并提到开通 / 充钱', () => {
  const s = explain(403, '');
  assert.match(s, /权限/);
  assert.match(s, /开通|充钱/);
});
await ok('404 = 地址不对，且点出 /v1 这个最常见的坑', () =>
  assert.match(explain(404, ''), /地址不对[\s\S]*\/v1/),
);
await ok('422 = 型号不认', () => assert.match(explain(422, ''), /型号/));
await ok('429 = 限流 / 余额', () => assert.match(explain(429, ''), /限流|余额/));
await ok('500 = 对面出错', () => assert.match(explain(500, ''), /服务端/));
await ok('没见过的状态码也别沉默', () => assert.match(explain(418, ''), /HTTP 418/));
await ok('响应里的细节带上，但别把整页贴上来', () => {
  const s = explain(401, 'x'.repeat(500));
  assert.ok(s.includes('xxx'));
  assert.ok(s.length < 400, '长度 ' + s.length);
});

console.log('\n网络层异常 → 人话');
await ok('超时说"等太久"', () => {
  const e = new Error('x');
  e.name = 'AbortError';
  assert.match(explainNetError(e), /等太久/);
});
await ok('TypeError 说清可能是 CORS，并指路桌面端', () => {
  const s = explainNetError(new TypeError('Failed to fetch'));
  assert.match(s, /CORS/);
  assert.match(s, /桌面端/);
});

console.log('\n型号列表解析');
await ok('认 data[].id 并排序', () => assert.deepEqual(modelsOf({ data: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b']));
await ok('空 / 脏输入给空数组，不炸', () => {
  assert.deepEqual(modelsOf(null), []);
  assert.deepEqual(modelsOf({}), []);
  assert.deepEqual(modelsOf({ data: [{ nope: 1 }, 'x'] }), []);
});

console.log('\nprobeModel：失败也要是个结论，不许抛');
const base = { baseURL: 'https://x.test/v1', apiKey: 'sk-1', model: 'm' };

await ok('没填地址：说"还没填接口地址"，且不打网络', async () => {
  let called = 0;
  const r = await probeModel({ ...base, baseURL: '' }, { fetch: async () => { called++; } });
  assert.equal(called, 0);
  assert.equal(r.state, 'error');
  assert.match(r.message, /还没填接口地址/);
});

await ok('没填 Key：说"还没填 Key"，且**不打网络**', async () => {
  let called = 0;
  const r = await probeModel({ ...base, apiKey: '  ' }, { fetch: async () => { called++; return res(200)(); } });
  assert.equal(called, 0, '不该打请求');
  assert.equal(r.state, 'error');
  assert.match(r.message, /还没填 Key/);
});

await ok('200 + 列表：ok 并把型号带回来', async () => {
  const r = await probeModel(base, { fetch: res(200, '', { data: [{ id: 'm2' }, { id: 'm1' }] }) });
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.models, ['m1', 'm2']);
  assert.match(r.message, /2 个型号/);
});

await ok('200 但没有列表：ok，但明说型号要手填', async () => {
  const r = await probeModel(base, { fetch: res(200, '', {}) });
  assert.equal(r.state, 'ok');
  assert.match(r.message, /型号要自己填准/);
});

await ok('404：算通（只是没列表），不能报成连不上', async () => {
  const r = await probeModel(base, { fetch: res(404) });
  assert.equal(r.state, 'ok');
  assert.match(r.message, /地址通了/);
});

await ok('401：报 Key 不对', async () => {
  const r = await probeModel(base, { fetch: res(401, 'invalid api key') });
  assert.equal(r.state, 'error');
  assert.match(r.message, /Key 不对/);
});

await ok('网络抛错：归到"没到对面"，不抛出去', async () => {
  const r = await probeModel(base, { fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(r.state, 'error');
  assert.match(r.message, /CORS/);
});

await ok('每次都有时间戳（界面上那句"什么时候试的"靠它）', async () => {
  const r = await probeModel(base, { fetch: res(200, '', { data: [{ id: 'a' }] }) });
  assert.ok(typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)));
});

console.log(`\n通过 ${pass} 项${bad ? ` / 失败 ${bad} 项` : ''}`);
process.exit(bad ? 1 : 0);
