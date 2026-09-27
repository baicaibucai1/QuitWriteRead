// 推送范围的规则覆盖。scope.ts 是零依赖纯函数，Node 24 可直接 import：
//   node tests/scope.test.mjs
import { matchPattern, inScope, scopePaths, normalizeScope, describeScope, DEFAULT_SCOPE } from '../src/lib/scope.ts';

let pass = 0;
const bad = [];
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else bad.push(`${name}${extra ? ` → ${extra}` : ''}`);
};

// ── matchPattern：四种写法各自的边界 ───────────────────────────
const pat = [
  // `**` / `*` 全选
  ['**', 'thoughts/a.md', true],
  ['**', '.gitignore', true],
  ['*', 'notes/a.md', true],

  // `*.md`：只看后缀，不限目录；大小写不敏感
  ['*.md', 'thoughts/a.md', true],
  ['*.md', 'a.md', true],
  ['*.md', 'a.MD', true],
  ['*.md', 'thoughts/a.txt', false],
  ['*.md', 'md', false],

  // `dir/`：目录前缀，**必须连斜杠一起比**
  ['thoughts/', 'thoughts/a.md', true],
  ['thoughts/', 'thoughts/2026/a.md', true],
  ['thoughts/', 'thoughts', true], // 目录自己（当文件看时也算在里面）
  ['thoughts/', 'thoughts-backup/a.md', false], // ⚠️ 这条是最容易错的一条
  ['thoughts/', 'notes/a.md', false],
  ['notes/2026/', 'notes/2026/a.md', true],
  ['notes/2026/', 'notes/2025/a.md', false],

  // 精确路径
  ['notes/a.md', 'notes/a.md', true],
  ['notes/a.md', 'notes/b.md', false],
  ['notes/a.md', 'x/notes/a.md', false],

  // 脏输入：空白、空串
  ['', 'a.md', false],
  ['   ', 'a.md', false],
  ['  thoughts/  ', 'thoughts/a.md', true],
];
for (const [pattern, path, want] of pat) {
  ok(`matchPattern ${JSON.stringify(pattern)} × ${path}`, matchPattern(path, pattern) === want, String(matchPattern(path, pattern)));
}

// ── inScope：排除必须压过 include ──────────────────────────────
ok('** 全选', inScope('thoughts/a.md', { include: ['**'], exclude: [] }));
ok('排除优先于 **（否则单篇例外永远轮不到）', !inScope('thoughts/私密.md', { include: ['**'], exclude: ['thoughts/私密.md'] }));
ok('排除优先于目录规则', !inScope('notes/a.md', { include: ['notes/', 'thoughts/'], exclude: ['notes/a.md'] }));
ok('排除不影响别的路径', inScope('notes/b.md', { include: ['notes/'], exclude: ['notes/a.md'] }));

// ⚠️ 空 include = 什么都不推。这是安全方向：配不出来时宁可不动，也不要"顺手全推了"
ok('空 include → 不推', !inScope('thoughts/a.md', { include: [], exclude: [] }));
ok('空 include 时排除也不救它', !inScope('a.md', { include: [], exclude: [] }));

// 多条 include 是"或"
ok('多条 include 取并集', inScope('books/a.md', { include: ['thoughts/', 'books/'], exclude: [] }));
ok('都不匹配就不推', !inScope('drafts/a.md', { include: ['thoughts/', 'books/'], exclude: [] }));

// 目录 + 后缀混用
ok('目录规则配后缀规则', inScope('notes/a.txt', { include: ['thoughts/', '*.txt'], exclude: [] }));

// ── scopePaths ────────────────────────────────────────────────
ok(
  'scopePaths 只留范围内的',
  JSON.stringify(scopePaths(['thoughts/a.md', 'notes/b.md', '.gitignore', 'drafts/c.md'], { include: ['thoughts/', 'notes/'], exclude: [] })) ===
    JSON.stringify(['thoughts/a.md', 'notes/b.md']),
  JSON.stringify(scopePaths(['thoughts/a.md', 'notes/b.md', '.gitignore', 'drafts/c.md'], { include: ['thoughts/', 'notes/'], exclude: [] })),
);
ok('scopePaths 空范围 → 空数组', scopePaths(['a.md'], { include: [], exclude: [] }).length === 0);

// ── normalizeScope：手写规则的清洗 ────────────────────────────
{
  const s = normalizeScope({ include: ['**', ' ** ', '', '  ', 'thoughts/', 'thoughts/'], exclude: ['a.md', ' a.md ', null, 3] });
  ok('去空白 + 去空行 + 去重', JSON.stringify(s.include) === JSON.stringify(['**', 'thoughts/']), JSON.stringify(s.include));
  ok('排除也洗（并丢掉非字符串）', JSON.stringify(s.exclude) === JSON.stringify(['a.md']), JSON.stringify(s.exclude));
  ok('缺字段不炸', JSON.stringify(normalizeScope({})) === JSON.stringify({ include: [], exclude: [] }));
  ok('null 不炸', JSON.stringify(normalizeScope({ include: null, exclude: null })) === JSON.stringify({ include: [], exclude: [] }));
}

// ── describeScope ─────────────────────────────────────────────
ok('默认范围是全部文件', describeScope(DEFAULT_SCOPE) === '全部文件', describeScope(DEFAULT_SCOPE));
ok('空范围说清楚', describeScope({ include: [], exclude: [] }).includes('什么都不推'));
ok('带排除时说清排除几篇', describeScope({ include: ['**'], exclude: ['a.md', 'b.md'] }).includes('2 篇'));
ok('列具体规则', describeScope({ include: ['thoughts/', '*.md'], exclude: [] }) === 'thoughts/、*.md');

// ── 回归：误删那条路必须是堵死的 ──────────────────────────────
/*
 * 这是整个改造最要紧的一条断言：
 * 一篇在范围外 → 它不进判定 → 因此**不可能**产生 push-del。
 * 用"把某个目录整个移出范围"这种最常见的操作来验，而不是只测一行纯函数。
 */
{
  const scope = { include: ['thoughts/'], exclude: [] };
  const all = ['thoughts/a.md', 'drafts/wip.md'];
  ok('目录移出范围后它不在待判定集合里', !scopePaths(all, scope).includes('drafts/wip.md'));
  const scope2 = { include: ['thoughts/'], exclude: ['thoughts/a.md'] };
  ok('单篇排除后它也不在集合里', !scopePaths(all, scope2).includes('thoughts/a.md'));
}

console.log(`结果：${pass} 通过 / ${bad.length} 失败`);
if (bad.length) {
  console.log('失败项：');
  for (const b of bad) console.log('  ✗ ' + b);
  process.exit(1);
}
