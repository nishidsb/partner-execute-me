/**
 * 模型能力判断（S7 厂商表的前身，先只回答一个问题：这个模型能不能读图）
 *
 * 为什么必须有这张表：
 *   CUA 的截图只有在模型能吃 image_url 消息时才有意义。塞进不支持的接口会
 *   400 → session 里降级成纯文本重跑 → 变成「模型看不见屏幕却在点鼠标」，
 *   比不点更糟。所以提前判一次：UI 上告诉用户，prompt 里切盲操作模式，
 *   并把「回微信」这类任务交给不依赖视觉的 wechat_send。
 *
 *   2026-10 修正：DeepSeek 已上线视觉（官方文档 deepseek-flash 直接收图，
 *   老 deepseek-v4-flash-vision-exp 已并回 Flash）；但 deepseek-chat /
 *   deepseek-reasoner 仍是纯文本，发图照样 400。按模型名细分，不再一刀切。
 *
 * 判断顺序：先认明确的「无视觉」，再认明确的「有视觉」，都没命中就当作有
 * （让服务端自己报错，session 里的 400 降级仍然兜底）。
 */
'use strict'

/** 明确没有视觉的（模型名或接口地址命中即无视觉）
 *  注意：DeepSeek 不放这张表——要看模型名细分（见 caps() 里的专门判断） */
const NO_VISION = [
  { re: /gpt-3\.5|text-davinci|text-curie|davinci/i, why: '这是纯文本模型' },
  { re: /claude-2|claude-instant/i, why: '老版本 Claude 不支持图片' },
  { re: /qwen(?!.*vl)[-_]?(turbo|plus|max)?($|\s)/i, why: '通义千问文本版不支持图片（要选 qwen-vl 系列）' }
]

/** 明确有视觉的 */
const HAS_VISION = /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o3|o4-|claude-3|claude-4|claude-sonnet|claude-opus|gemini|glm-4v|qwen.*vl|qvq|doubao.*(vision|vl)|step-1v|moonshot.*(vision|vl)|internvl|llava|pixtral|yi-vl|minicpm-v|deepseek[\w-]*(?:flash|vision|vl)/i

/**
 * @param {{baseUrl?:string, model?:string, visionOn?:boolean, probeDenied?:boolean}} o
 *   probeDenied：上次真机上发图被服务端拒了（400）。名字猜得再好也不如一次实测，
 *   这个标记由调用方在被拒后落盘，换模型时清掉。
 * @returns {{vision:boolean, model:string, note:string}}
 */
function caps (o = {}) {
  const model = String(o.model || '').trim()
  const base = String(o.baseUrl || '')
  const probe = model + ' ' + base
  if (o.visionOn === false) {
    return { vision: false, model, note: '「允许截屏看桌面」被关掉了，截图不会发给模型' }
  }
  if (o.probeDenied === true) {
    return { vision: false, model, note: '这个接口上次发图被服务端拒了（400），已降级成只看窗口标题；换模型或换网关后会自动重新尝试（当前：' + (model || base) + '）' }
  }
  // DeepSeek 专门判断（不能进 NO_VISION 按「模型名+地址」整体匹配——
  // baseUrl 是 api.deepseek.com 时会把 deepseek-flash 也误杀）：
  // 模型名（没填模型就看地址）含 deepseek 时，flash/vision/vl 系列有视觉
  // （官方 2026-10 起 deepseek-flash 直接收图），其余（chat/reasoner/裸名）纯文本
  const dsProbe = model || base
  if (/deepseek/i.test(dsProbe) && !/(?:flash|vision|vl)/i.test(model)) {
    return { vision: false, model, note: '这个 DeepSeek 模型还是纯文本，发图会被拒绝（要看图请换 deepseek-flash）（当前：' + (model || base) + '）' }
  }
  for (const r of NO_VISION) {
    if (r.re.test(probe)) return { vision: false, model, note: r.why + '（当前：' + (model || base) + '）' }
  }
  if (HAS_VISION.test(probe)) return { vision: true, model, note: '' }
  return { vision: true, model, note: '' }
}

module.exports = { caps }
