/** 模型接入层工厂：按 provider.type 分发，业务逻辑不感知具体服务商 */
import * as openaiCompat from './openaiCompat.js'
import * as mock from './mock.js'

const REGISTRY = { openai: openaiCompat, mock }

export function createProvider (providerCfg) {
  const impl = REGISTRY[providerCfg.type]
  if (!impl) throw new Error(`未知的模型接入类型: ${providerCfg.type}（可用: ${Object.keys(REGISTRY).join(', ')}）`)
  return {
    type: providerCfg.type,
    chat: (opts) => impl.chat({ ...opts, baseUrl: providerCfg.baseUrl, apiKey: providerCfg.apiKey, model: providerCfg.model, temperature: providerCfg.temperature ?? opts.temperature })
  }
}
