/** 模型接入层工厂：按 provider.type 分发，业务逻辑不感知具体服务商 */
import * as openaiCompat from './openaiCompat.js'
import * as anthropic from './anthropic.js'
import * as gemini from './gemini.js'
import * as mock from './mock.js'
import * as chatgpt from './chatgpt.js'

const REGISTRY = { openai: openaiCompat, anthropic, gemini, mock, chatgpt }

export function createProvider (providerCfg) {
  const impl = REGISTRY[providerCfg.type]
  if (!impl) throw new Error(`未知的模型接入类型: ${providerCfg.type}（可用: ${Object.keys(REGISTRY).join(', ')}）`)
  return {
    type: providerCfg.type,
    // 0.45.95：把实际在用的 baseUrl/model 暴露出来。上层要判「这个端点是不是 DeepSeek 系」
    // （thinking 模式要求回传 reasoning_content），以前只能猜 config，猜错就整轮 400。
    baseUrl: providerCfg.baseUrl,
    model: providerCfg.model,
    chat: (opts) => impl.chat({
      ...opts,
      baseUrl: providerCfg.baseUrl,
      apiKey: providerCfg.apiKey,
      model: providerCfg.model,
      // 1.4：temperature 默认不发（配置里没有就不发）；1.5：reasoningEffort 按配置传
      temperature: providerCfg.temperature ?? opts.temperature,
      reasoningEffort: providerCfg.reasoningEffort ?? opts.reasoningEffort
    })
  }
}
