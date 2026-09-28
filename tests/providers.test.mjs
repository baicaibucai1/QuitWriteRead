/*
 * 服务商预设表的问题只有一种：**地址悄悄写错了**。
 *
 * 错的表现不在代码里 —— 人在界面上点「试一下」，得到一句"连不上"，
 * 然后开始怀疑自己的 Key、怀疑网络、怀疑 CORS，最后才是那份表。
 * 所以这里把"各家那个地址"钉死：改可以，改的时候得连这个文件一起改。
 *
 * ⚠️ 这里跑的是**零依赖**的 `providers.ts`（它不 import 任何东西），
 *    所以能被 node 直接吃 —— 别给它加依赖，一加这套就跑不起来了。
 */
import { PROVIDER_PRESETS, PROVIDER_DEFAULT, presetOf, defaultModelOf, shortHost } from '../src/lib/agent/providers.ts';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
};

/*
 * 几家**写在官方文档里**、核对过的地址。
 * 改这里的任何一个值 = 承认文档变了，请先把出处重新看一遍。
 */
const KNOWN = {
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  agnes: 'https://apihub.agnes-ai.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  openai: 'https://api.openai.com/v1',
};

console.log('\n== 表本身站得住');

const ids = PROVIDER_PRESETS.map((p) => p.id);
ok('id 不重复', new Set(ids).size === ids.length, ids.join(','));
ok('默认那一家在表里', ids.includes(PROVIDER_DEFAULT), PROVIDER_DEFAULT);
ok('自定义的 id 就叫 custom', ids.includes('custom'));
ok(
  '每家都有给人看的型号获取提示',
  PROVIDER_PRESETS.every((p) => p.keyHint.trim().length > 0),
);
ok(
  '自定义那一家的地址留空（不能替人猜）',
  presetOf('custom').baseURL === '' && presetOf('custom').models.length === 0,
);

console.log('\n== 地址的形状');

for (const p of PROVIDER_PRESETS) {
  if (p.id === 'custom') continue;
  ok(`${p.id}：https 开头`, p.baseURL.startsWith('https://'), p.baseURL);
  // ⛔ 别把 /chat/completions 写进 baseURL —— 内核会自己拼，拼出来就成了 //chat/completions
  ok(`${p.id}：不带具体 endpoint`, !p.baseURL.includes('/chat/completions'), p.baseURL);
  ok(`${p.id}：末尾没有多余的斜杠`, !p.baseURL.endsWith('/'), p.baseURL);
}

console.log('\n== 核对过的那几家不能漂');

for (const [id, url] of Object.entries(KNOWN)) {
  ok(`${id} 是文档里那个地址`, presetOf(id).baseURL === url, presetOf(id).baseURL);
}
ok(
  'Agnes 默认取 flash（不是那个付费的 pro）',
  defaultModelOf('agnes') === 'agnes-2.5-flash',
  defaultModelOf('agnes'),
);
ok('OpenRouter 不给默认型号（它家有几百个，猜不如去拿）', defaultModelOf('openrouter') === '');
ok('presetOf 认不得的就退回第一家的样子', presetOf('不存在的家').id === PROVIDER_PRESETS[0].id);

console.log('\n== shortHost：型号列表前那半句');

ok('剥掉路径，只留主机名', shortHost('https://apihub.agnes-ai.com/v1') === 'apihub.agnes-ai.com');
ok('带前缀空格也认', shortHost('  https://api.deepseek.com/v1  ') === 'api.deepseek.com');
ok('不是 URL 就原样退回来', shortHost('随便写点什么') === '随便写点什么');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
