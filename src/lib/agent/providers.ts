/*
 * 模型服务商的预设表。
 *
 * 为什么要有一张表，而不是让人自己记住地址：
 * 这几家**地址长得都不一样**（`/v1` / `/compatible-mode/v1` / `/api/paas/v4`），
 * 手填一次错一次，而错了的表现只是"连不上"三个字 —— 人没法从这三个字里
 * 看出是自己把地址敲错了。选一家，地址自动填，这件事就不该让人记。
 *
 * ⚠️ 表里的型号只是**常用那几个**，不是全部：拿到 Key 之后点「试一下」，
 *    真实列表会从端点 `/models` 回来盖掉它。所以这张表的职责是
 *    "没连上时也能选"，不是"永远正确"。
 *
 * ⚠️ 改这张表 = 改界面上给人看的东西，加一家要连它的**文档地址**一起核。
 */
export type ProviderPreset = {
  id: string;
  label: string;
  baseURL: string;
  /** 常用型号。空的表示"我们不替你猜，试一下之后从端点拿" */
  models: string[];
  /** Key 在哪儿拿 —— 没配 Key 时那句提示要能指路 */
  keyHint: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyHint: '在 platform.deepseek.com 的 API Keys 里建一个',
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    keyHint: '阿里云百炼控制台的 API-KEY',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
    keyHint: 'open.bigmodel.cn 的 API Keys',
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyHint: 'platform.moonshot.cn 的 API Key 管理',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    keyHint: 'platform.openai.com 的 API keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    models: [], // 它家有几百个型号，猜不如去拿
    keyHint: 'openrouter.ai/keys',
  },
  {
    id: 'custom',
    label: '自定义',
    baseURL: '',
    models: [],
    keyHint: '自己填地址 —— 要是一家 OpenAI 兼容的端点',
  },
];

export const PROVIDER_DEFAULT = 'deepseek';

export function presetOf(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0]!;
}

/** 选了一家之后的默认型号：有就取第一个，没有就留空让人试一下 */
export function defaultModelOf(id: string): string {
  return presetOf(id).models[0] ?? '';
}

/** 地址末尾那截 `/v1` 不要让人看见 —— 它只是路径，不是"服务器" */
export function shortHost(baseURL: string): string {
  const m = /^https?:\/\/([^/]+)/.exec(baseURL.trim());
  return m ? m[1]! : baseURL;
}
