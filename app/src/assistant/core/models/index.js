/** 模型接入层工厂：按 provider.type 分发，业务逻辑不感知具体服务商 */
import * as openaiCompat from './openaiCompat.js'
import * as anthropic from './anthropic.js'
import * as gemini from './gemini.js'
import * as mock from './mock.js'
import * as chatgpt from './chatgpt.js'

const REGISTRY = { openai: openaiCompat, anthropic, gemini, mock, chatgpt }

/* 0.50.0 备胎位：云端失败时本地大模型顶上（主人拍板「副手+备胎」）。
 * FALLBACK 由宿主（assistant/index.js）注入——核心保持通用，不感知路由细节：
 * fn(opts, err) → 用本地参数调 openaiCompat.chat 返回同形状结果；失败可抛原错。
 * 切换守卫：主人主动中断（signal.aborted）绝不切；流已吐字（onDelta 被调过）不切
 *（同一句话说两遍的风险）。 */
let FALLBACK = null
export function setChatFallback (fn) { FALLBACK = fn || null }

export function createProvider (providerCfg) {
  const impl = REGISTRY[providerCfg.type]
  if (!impl) throw new Error(`未知的模型接入类型: ${providerCfg.type}（可用: ${Object.keys(REGISTRY).join(', ')}）`)
  const rawChat = (opts) => impl.chat({
    ...opts,
    baseUrl: providerCfg.baseUrl,
    apiKey: providerCfg.apiKey,
    model: providerCfg.model,
    // 1.4：temperature 默认不发（配置里没有就不发）；1.5：reasoningEffort 按配置传
    temperature: providerCfg.temperature ?? opts.temperature,
    reasoningEffort: providerCfg.reasoningEffort ?? opts.reasoningEffort
  })
  return {
    type: providerCfg.type,
    // 0.45.95：把实际在用的 baseUrl/model 暴露出来。上层要判「这个端点是不是 DeepSeek 系」
    // （thinking 模式要求回传 reasoning_content），以前只能猜 config，猜错就整轮 400。
    baseUrl: providerCfg.baseUrl,
    model: providerCfg.model,
    chat: async (opts) => {
      let emitted = false
      const wrapped = opts.onDelta ? (t) => { emitted = true; return opts.onDelta(t) } : undefined
      try {
        return await rawChat({ ...opts, onDelta: wrapped })
      } catch (err) {
        if (!FALLBACK || (opts.signal && opts.signal.aborted) || emitted) throw err
        try {
          return await FALLBACK(opts, err)
        } catch (fbErr) {
          // 备胎也失败 → 抛原错（云端错误信息更有分诊价值）
          throw err
        }
      }
    }
  }
}
