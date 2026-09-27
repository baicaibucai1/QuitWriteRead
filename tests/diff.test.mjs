// 行级 diff 的覆盖。diff.ts 是零依赖纯函数，Node 24 可直接 import：
//   node tests/diff.test.mjs
import { diffLines, diffSummary, collapseUnchanged } from '../src/lib/diff.ts';

let pass = 0;
const bad = [];
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else bad.push(`${name}${extra ? ` → ${extra}` : ''}`);
};

const shape = (lines) => lines.map((l) => `${l.kind}:${l.text}`).join(' | ');

// ── 基本情形 ───────────────────────────────────────────────────
ok('两边一样 → 全是 same，没有增删', diffLines('a\nb', 'a\nb').every((l) => l.kind === 'same'));
ok('一样时行数不变', diffLines('a\nb\nc', 'a\nb\nc').length === 3);

{
  const d = diffLines('a\nb', 'a\nc');
  ok('改一行 = 一删一加', JSON.stringify(d.map((l) => l.kind)) === JSON.stringify(['same', 'del', 'add']), shape(d));
  ok('删掉的是旧的那行', d[1].text === 'b');
  ok('加上的是新的那行', d[2].text === 'c');
}

{
  const d = diffLines('a\nb', 'a\nb\nc');
  ok('末尾加一行 = 一个 add', JSON.stringify(d.map((l) => l.kind)) === JSON.stringify(['same', 'same', 'add']), shape(d));
}

{
  const d = diffLines('a\nb\nc', 'a\nc');
  ok('中间删一行 = 一个 del', JSON.stringify(d.map((l) => l.kind)) === JSON.stringify(['same', 'del', 'same']), shape(d));
}

// 整块替换：全删 + 全加
{
  const d = diffLines('x\ny', 'p\nq');
  ok('完全不同的两行 = 2 删 2 加', diffSummary(d).removed === 2 && diffSummary(d).added === 2, shape(d));
}

// ── 空行必须算数（markdown 里它是段落分隔） ────────────────────
{
  const d = diffLines('# 标题\n\n正文', '# 标题\n正文');
  ok('删掉一个空段能看出来', diffSummary(d).removed === 1 && diffSummary(d).added === 0, shape(d));
  ok('删的是那个空行', d.some((l) => l.kind === 'del' && l.text === ''));
}

// ── 空文本 ─────────────────────────────────────────────────────
ok('两边都空 → 一行 same（空串）', diffLines('', '').length === 1 && diffLines('', '')[0].kind === 'same');
{
  const d = diffLines('', 'a');
  ok('空 → 有内容', diffSummary(d).added === 1, shape(d));
  const e = diffLines('a', '');
  ok('有内容 → 空', diffSummary(e).removed === 1, shape(e));
}

// ── diffSummary ────────────────────────────────────────────────
{
  const s = diffSummary(diffLines('a\nb\nc', 'a\nB\nc\nd'));
  ok('摘要数得对（+2 −1）', s.added === 2 && s.removed === 1, JSON.stringify(s));
}

// ── collapseUnchanged：长文里折叠没动过的段 ────────────────────
{
  const before = Array.from({ length: 40 }, (_, i) => `行 ${i}`).join('\n');
  const after = before.replace('行 20', '行 二十');
  const lines = diffLines(before, after);
  const folded = collapseUnchanged(lines, 2);
  ok('折叠后短了一大截', folded.length < lines.length, `${folded.length} vs ${lines.length}`);
  ok('改的那两行还在', folded.some((l) => l.kind === 'del' && l.text === '行 20') && folded.some((l) => l.kind === 'add' && l.text === '行 二十'));
  ok('折叠段标得出跳过了几行', folded.some((l) => l.kind === 'skip' && l.count > 0));
  ok(
    '折叠的行数加起来对得上',
    folded.reduce((n, l) => n + (l.kind === 'skip' ? l.count : 1), 0) === lines.length,
    `${folded.reduce((n, l) => n + (l.kind === 'skip' ? l.count : 1), 0)} vs ${lines.length}`,
  );
  ok('context=2 时改动前后各留两行', folded.filter((l) => l.kind === 'same').length === 4, String(folded.filter((l) => l.kind === 'same').length));
}

// 全是 same 时不该产出一条巨大的 skip（那就等于把内容全藏了）
{
  const all = diffLines('a\nb\nc', 'a\nb\nc');
  const folded = collapseUnchanged(all, 2);
  ok('没有改动就整段跳过（一条 skip）', folded.length === 1 && folded[0].kind === 'skip', JSON.stringify(folded));
}

// ── 大文本退化：不能把界面冻住 ─────────────────────────────────
{
  const big = Array.from({ length: 2500 }, (_, i) => `行 ${i}`).join('\n');
  const t = Date.now();
  const d = diffLines(big, big + '\n多一行');
  const ms = Date.now() - t;
  ok('超过上限走整块替换（不卡）', ms < 500, `${ms}ms`);
  ok('退化了也还是有内容可看', d.length > 0 && d.some((l) => l.kind === 'add'), String(d.length));
}

// ── 真实一点的场景：改了标题、中间插了一段 ─────────────────────
{
  const before = '# 散步\n\n今天出门走了很久。\n\n## 路上\n\n看见一只猫。\n';
  const after = '# 雨天散步\n\n今天出门走了很久。\n\n## 路上\n\n看见一只猫，它不怕人。\n\n## 回来\n\n泡了茶。\n';
  const d = diffLines(before, after);
  const s = diffSummary(d);
  ok('真实场景：有加有删', s.added > 0 && s.removed > 0, JSON.stringify(s));
  ok('没动过的段落仍是 same', d.filter((l) => l.kind === 'same').length > 0);
  ok('标题那行被标成改动', d.some((l) => l.kind === 'del' && l.text === '# 散步') && d.some((l) => l.kind === 'add' && l.text === '# 雨天散步'));
}

console.log(`结果：${pass} 通过 / ${bad.length} 失败`);
if (bad.length) {
  console.log('失败项：');
  for (const b of bad) console.log('  ✗ ' + b);
  process.exit(1);
}
