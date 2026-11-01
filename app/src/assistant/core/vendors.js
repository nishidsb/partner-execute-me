/**
 * 厂商预设表（S7）——结构对齐参考项目 Coopanion 的 vendors.ts，协议换成 Ryza 实际支持的三种：
 *   - openai    = OpenAI 兼容 /chat/completions（绝大多数国内外服务）
 *   - anthropic = Messages API（直连 Claude）
 *   - gemini    = Gemini API generateContent（直连 Gemini）
 *
 * 数据来源：Coopanion vendors.ts（2026-10 版，含各厂商中国大陆/国际平台与视觉模型清单）。
 * 与参考表的两处有意偏差：
 *   1. 只保留 chat 协议的 baseUrl（Ryza 不支持 OpenAI Responses API）；
 *   2. DeepSeek 标为无视觉——参考表在 deepseek-flash 上标了 vision，但本机实测
 *      DeepSeek 官方接口对 image 消息回 400（2026-10-23 日志实锤），以实测为准。
 *
 * 本文件零依赖：主进程与渲染层都能用，测试也可直接静态断言。
 * 字段：effort=支持 reasoningEffort 的模型清单（1.5，UI 按此露出）；ctx=上下文 token 上限（1.8 预裁剪用）；
 *       price=人民币/百万 tokens 估算单价（1.9 成本图表，仅为量级估算）。
 */

export const VENDORS = [
  {
    id: 'deepseek', name: 'DeepSeek', type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'],
    effort: ['deepseek-v4-pro'], ctx: 131072, price: { inp: 2, out: 8 },
    vision: [],
    keyUrl: 'https://platform.deepseek.com/api_keys', keyHint: 'sk-…'
  },
  {
    id: 'qwen', name: '通义千问', type: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-flash', models: ['qwen3.8-flash', 'qwen3.7-flash', 'qwen3.8-max'],
    effort: ['qwen3.8-max'], ctx: 131072, price: { inp: 1, out: 4 },
    vision: ['qwen3.8-flash', 'qwen3.7-flash', 'qwen3.8-max'],
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key', keyHint: 'sk-…'
  },
  {
    id: 'kimi', name: 'Kimi', type: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3', models: ['kimi-k3'],
    effort: [], ctx: 131072, price: { inp: 4, out: 16 },
    vision: ['kimi-k3'],
    keyUrl: 'https://platform.kimi.com/console/api-keys', keyHint: 'sk-…'
  },
  {
    id: 'glm', name: '智谱 GLM', type: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3-flash', models: ['glm-5.3-flash', 'glm-5.3', 'glm-4.6v-flash'],
    effort: ['glm-5.3'], ctx: 131072, price: { inp: 2, out: 8 },
    vision: ['glm-5.3-flash', 'glm-4.6v-flash'],
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', keyHint: '粘贴 API Key'
  },
  {
    id: 'doubao', name: '豆包', type: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-1-lite-260915', models: ['doubao-seed-2-1-lite-260915', 'doubao-seed-2-0-mini-260428'],
    effort: [], ctx: 131072, price: { inp: 0.8, out: 2 },
    vision: ['doubao-seed-2-1-lite-260915', 'doubao-seed-2-0-mini-260428'],
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey', keyHint: '粘贴 API Key'
  },
  {
    id: 'minimax', name: 'MiniMax', type: 'openai',
    baseUrl: 'https://api.minimax.cn/v1',
    model: 'MiniMax-M3', models: ['MiniMax-M3', 'MiniMax-M2.7'],
    effort: ['MiniMax-M3'], ctx: 200000, price: { inp: 1, out: 5 },
    vision: ['MiniMax-M3'],
    keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key', keyHint: '粘贴 API Key'
  },
  {
    id: 'stepfun', name: '阶跃星辰', type: 'openai',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-3.7-flash', models: ['step-3.7-flash', 'step-5-preview'],
    effort: ['step-5-preview'], ctx: 131072, price: { inp: 1, out: 5 },
    vision: ['step-3.7-flash', 'step-5-preview'],
    keyUrl: 'https://platform.stepfun.com/interface-key', keyHint: '粘贴 API Key'
  },
  {
    id: 'qianfan', name: '百度千帆', type: 'openai',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: 'glm-5.3-flash', models: ['glm-5.3-flash', 'deepseek-v4.1-flash', 'ernie-4.5-turbo-vl'],
    effort: [], ctx: 131072, price: { inp: 2, out: 8 },
    vision: ['glm-5.3-flash', 'ernie-4.5-turbo-vl'],
    keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list', keyHint: 'bce-v3/…'
  },
  {
    id: 'openrouter', name: 'OpenRouter', type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4.1-flash',
    models: ['deepseek/deepseek-v4.1-flash', 'qwen/qwen3.8-flash', 'google/gemini-3.1-flash-lite', 'z-ai/glm-5.3-flash'],
    effort: ['deepseek/deepseek-v4.1-flash'], ctx: 131072, price: { inp: 2, out: 8 },
    vision: ['qwen/qwen3.8-flash', 'google/gemini-3.1-flash-lite', 'z-ai/glm-5.3-flash'],
    keyUrl: 'https://openrouter.ai/settings/keys', keyHint: 'sk-or-…'
  },
  {
    id: 'openai', name: 'OpenAI', type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    effort: ['gpt-4.1', 'gpt-4o'], ctx: 131072, price: { inp: 18, out: 72 },
    vision: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    keyUrl: 'https://platform.openai.com/settings/organization/api-keys', keyHint: 'sk-…'
  },
  {
    id: 'anthropic', name: 'Anthropic (Claude)', type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5', models: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1'],
    effort: ['claude-sonnet-4-5', 'claude-opus-4-1'], ctx: 200000, price: { inp: 22, out: 110 },
    vision: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1'],
    keyUrl: 'https://platform.claude.com/settings/keys', keyHint: 'sk-ant-…'
  },
  {
    id: 'gemini', name: 'Gemini', type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    effort: ['gemini-2.5-flash', 'gemini-2.5-pro'], ctx: 1048576, price: { inp: 8, out: 32 },
    vision: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…'
  },
  {
    id: 'xai', name: 'xAI (Grok)', type: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4', models: ['grok-4', 'grok-3'],
    effort: ['grok-4'], ctx: 131072, price: { inp: 12, out: 48 },
    vision: ['grok-4'],
    keyUrl: 'https://console.x.ai/team/default/api-keys', keyHint: 'xai-…'
  },
  {
    // 1.3 ChatGPT 账号登录：免 API Key，走 OAuth 令牌 + Codex Responses API
    // type=chatgpt（models/chatgpt.js）；价格未知 → price 不填（用量图不估成本）
    id: 'chatgpt', name: 'ChatGPT 账号（登录）', type: 'chatgpt',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'gpt-5', models: ['gpt-5', 'gpt-5-codex'],
    effort: ['gpt-5'], ctx: 272000,
    vision: ['gpt-5', 'gpt-5-codex'],
    keyHint: ''
  }
]

/** 按 baseUrl 匹配厂商（设置页回显用）；自定义地址返回 null */
export function vendorByBaseUrl (baseUrl) {
  const url = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) return null
  return VENDORS.find((v) => url === v.baseUrl || url.startsWith(v.baseUrl + '/')) || null
}

export const vendorById = (id) => VENDORS.find((v) => v.id === id) || null

/** 模型能不能读图：先查厂商表，查不到再交给人家的判定层（modelCaps） */
export function visionOf (vendorId, model) {
  const v = vendorById(vendorId)
  if (!v) return null
  return v.vision.includes(String(model || '').trim())
}

/** 1.5：某厂商支持 reasoningEffort 的模型清单（UI 据此露出档位下拉；空数组=不支持） */
export function effortModelsOf (vendorId) {
  const v = vendorById(vendorId)
  return v && Array.isArray(v.effort) ? v.effort : []
}

/** 1.8：厂商上下文 token 上限（查不到给个保守小值 32k，触发提前折叠） */
export function ctxOf (vendorId) {
  const v = vendorById(vendorId)
  return (v && v.ctx) || 32768
}

/** 1.9：单价估算（人民币/百万 tokens），查不到返回 null（不估成本） */
export function priceOf (vendorId) {
  const v = vendorById(vendorId)
  return v && v.price ? v.price : null
}
