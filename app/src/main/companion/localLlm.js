'use strict'
/**
 * 0.50.0 本地大模型自动路由（主人 23:21 拍板：副手+备胎，端点 Ollama）
 *
 * 她自己按情况调本地大模型，主人不再需要在设置里切换模型槽：
 *  - 副手位：旁路小活（语义判读/记忆提炼这类 chatOnce）本地在线就优先走本地，省 token；
 *  - 备胎位：云端失败（429/5xx/断网/超时）时主对话自动切本地顶上，云端恢复自动切回
 *    （无状态——每次调用本来就先走云端，不存在要复位的切换状态）。
 *
 * 端点：OpenAI 兼容 /v1（Ollama 默认 http://127.0.0.1:11434/v1）。
 * 探测：GET /models，在线缓存 30s；失败冷却 60s（不给死端点刷请求）。
 * 选模：自动发现——过滤嵌入类模型（embed/bge/nomic/bert…），配置名优先，否则取第一个。
 * 本地不在线 = 一切照旧走云端，对她完全无感。
 */
const { log } = require('../logger')
const llm = require('./llm')

let CFG = { on: true, url: 'http://127.0.0.1:11434/v1', model: '' }

function configure (c) {
  CFG = {
    on: !c || c.on !== false,
    url: String((c && c.url) || 'http://127.0.0.1:11434/v1').trim(),
    model: String((c && c.model) || '').trim()
  }
}

const UP_TTL_MS = 30000       // 在线：30s 内不重探
const DOWN_COOLDOWN_MS = 60000 // 离线：60s 内不重探（死端点不刷）
const EMBED_RE = /embed|bge|nomic|bert|minilm|rerank|e5-|gte-/i // 嵌入类模型不能对话

let lastProbeAt = 0
let lastOk = false
let pickedModel = ''
let probing = null

/** 探测端点并自动选模。缓存期内直接返回已知状态（force=true 强制重探）。 */
async function probe ({ force = false } = {}) {
  const now = Date.now()
  if (!force && now - lastProbeAt < (lastOk ? UP_TTL_MS : DOWN_COOLDOWN_MS)) return lastOk
  if (probing) return probing
  probing = (async () => {
    try {
      const models = await llm.listModels({ baseUrl: CFG.url, apiKey: '' })
      const usable = (models || []).filter((m) => !EMBED_RE.test(String(m)))
      if (usable.length) {
        lastOk = true
        pickedModel = (CFG.model && usable.includes(CFG.model)) ? CFG.model : usable[0]
        log('[localLlm] 本地端点在线（' + usable.length + ' 个可用模型），选用 ' + pickedModel)
      } else {
        lastOk = false
        pickedModel = ''
        if ((models || []).length) log('[localLlm] 端点在线但只有嵌入类模型，不用于对话')
      }
    } catch {
      if (lastOk) log('[localLlm] 本地端点掉线，全部走云端')
      lastOk = false
      pickedModel = ''
    }
    lastProbeAt = Date.now()
    return lastOk
  })()
  try {
    return await probing
  } finally {
    probing = null
  }
}

/** 路由取参：本地可用给 {baseUrl, apiKey:'', model}，否则 null。
 *  只读缓存状态：在线 TTL 内给参数；离线冷却内直接 null；
 *  缓存过期则后台刷新（不阻塞调用方，先按已知状态走——本地真死了调用方自己会回落）。 */
function pick () {
  if (!CFG.on || !CFG.url) return null
  const fresh = Date.now() - lastProbeAt < (lastOk ? UP_TTL_MS : DOWN_COOLDOWN_MS)
  if (!fresh) probe().catch(() => { })
  return (lastOk && pickedModel) ? { baseUrl: CFG.url, apiKey: '', model: pickedModel } : null
}

/** UI 状态（设置页探测按钮/状态行） */
function stats () {
  return { on: CFG.on, url: CFG.url, model: CFG.model, online: lastOk, picked: pickedModel, probedAt: lastProbeAt }
}

module.exports = { configure, probe, pick, stats }
