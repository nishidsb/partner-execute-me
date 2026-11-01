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
