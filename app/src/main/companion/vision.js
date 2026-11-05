'use strict'
/**
 * 本地视觉通道（0.46.37）
 *
 * 用户想法（2026-11-04）：deepseek-flash 只能「一张一张发图判断」（每张图 1~2 分钱 API 费、
 * 截图要出本机），挡 3 自主活动那种高频看屏用它又贵又慢还上传隐私。方案：走本机
 * Ollama 的视觉模型，零成本、截图不出本机。
 *
 * 实测（2026-11-04，本机）：qwen3.5:4b **能吃图**——OpenAI 兼容层 /v1/chat/completions
 * 的 image_url 和原生层 images 字段都正确读出测试图（答 "Red"/"红色"）。qwen3.5 是
 * 原生多模态，虽然名字里没有 vl。注意它是 thinking 模型：max_tokens 给小了回复是空的
 * （token 被思考吃光），所以 describe 默认给 500。
 *
 * 原则：
 *   · 探测不到 Ollama / 没有视觉模型 → 如实返回 reason，**绝不静默假装看见了**
 *     （同类坑#4：一切失败先留痕，调用方拿到 ok:false 会降级成 read_text/盲模式并如实告知）；
 *   · 探测结果缓存：Ollama 模型列表不会每秒变，60s 缓存省一次 GET；
 *   · 失败缓存 15s：Ollama 没起时别每次调用都去敲一个死端口。
 */
const http = require('node:http')

const DEFAULT_BASE = 'http://127.0.0.1:11434'

/** 视觉模型候选规则（按优先级，第一个命中的先试）。
 *  qwen3.5 特判的依据是本机实测（见文件头），不是猜的。 */
const VLM_RULES = [
  { re: /qwen\d+(\.\d+)?-?vl/i, pri: 1 },   // qwen2-vl / qwen2.5-vl / qwen3-vl 系列
  { re: /qwen3\.5/i, pri: 2, why: 'qwen3.5 原生多模态（2026-11-04 本机实测吃图）' },
  { re: /minicpm-v/i, pri: 3 },
  { re: /llava|moondream|internvl|glm-4v|qvq/i, pri: 4 },
  { re: /vl|vision/i, pri: 5 }              // 兜底：名字里带 vl/vision 的
]

let cfg = { base: DEFAULT_BASE, model: '' }   // model 非空 = 强制指定（跳过探测）
let probeCache = { at: 0, r: null, failAt: 0 }

/** 允许测试注入 fetch 实现 */
let fetchImpl = (...a) => fetch(...a)
function setFetch (fn) { fetchImpl = fn || ((...a) => fetch(...a)) }

/** 测试用：清探测缓存与注入 */
function resetForTest () {
  probeCache = { at: 0, r: null, failAt: 0 }
  cfg = { base: DEFAULT_BASE, model: '' }
}

function configure (o) {
  if (!o) return
  if (o.base) cfg.base = String(o.base).replace(/\/+$/, '')
  if (o.model !== undefined) cfg.model = String(o.model || '').trim()
}

/** GET /api/tags → 挑一个视觉模型。返回 { ok, model } | { ok:false, reason } */
async function probe (force) {
  const now = Date.now()
  if (!force && probeCache.r && now - probeCache.at < 60000) return probeCache.r
  if (!force && probeCache.failAt && now - probeCache.failAt < 15000) {
    return { ok: false, reason: 'ollama 不可达（刚试过）' }
  }
  try {
    const r = await fetchImpl(cfg.base + '/api/tags', { signal: AbortSignal.timeout(3000) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const j = await r.json()
    const names = (j.models || []).map((m) => String(m.name || ''))
    let model = cfg.model   // 显式指定的优先
    if (model && !names.some((n) => n === model || n.startsWith(model + ':'))) {
      return { ok: false, reason: '指定的视觉模型 ' + model + ' 不在 Ollama 模型列表里' }
    }
    if (!model) {
      let best = null
      for (const n of names) {
        for (const rule of VLM_RULES) {
          if (rule.re.test(n) && (!best || rule.pri < best.pri)) best = { n, pri: rule.pri }
        }
      }
      if (!best) {
        probeCache = { at: now, r: { ok: false, reason: 'Ollama 在线但没有视觉模型（装一个即可，如 ollama pull qwen3-vl:4b）', failAt: now }
        }
        return probeCache.r
      }
      model = best.n
    }
    probeCache = { at: now, r: { ok: true, model }, failAt: 0 }
    return probeCache.r
  } catch (err) {
    probeCache = { at: now, r: { ok: false, reason: '本机 Ollama 未运行（' + (err && err.message) + '）' }, failAt: now }
    return probeCache.r
  }
}

/**
 * 看一张图。
 * @param {Buffer|string} image PNG/JPEG 字节，或已是 dataURL 的字符串
 * @param {string} question 想从画面里知道什么
 * @returns {Promise<{ok:true, text:string, model:string}|{ok:false, reason:string}>}
 */
async function describe (image, question, opts) {
  const o = opts || {}
  const p = await probe()
  if (!p.ok) return p
  const url = /^data:image\//.test(String(image))
    ? String(image)
    : 'data:image/png;base64,' + Buffer.from(image).toString('base64')
  try {
    const r = await fetchImpl(cfg.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(o.timeoutMs || 120000),
      body: JSON.stringify({
        model: p.model,
        // thinking 模型：思考也耗 token，500 起步（max_tokens=50 实测回复为空）
        max_tokens: o.maxTokens || 500,
        temperature: 0.4,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: String(question || '描述这张屏幕截图的内容。') },
            { type: 'image_url', image_url: { url } }
          ]
        }]
      })
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      return { ok: false, reason: '视觉模型 HTTP ' + r.status + '：' + body.slice(0, 120) }
    }
    const j = await r.json()
    const text = j && j.choices && j.choices[0] && j.choices[0].message && String(j.choices[0].message.content || '').trim()
    if (!text) return { ok: false, reason: '视觉模型返回了空内容（可能 max_tokens 被思考吃光）' }
    return { ok: true, text, model: p.model }
  } catch (err) {
    return { ok: false, reason: '视觉模型调用失败：' + (err && err.message) }
  }
}

module.exports = { probe, describe, configure, setFetch, resetForTest, DEFAULT_BASE, VLM_RULES }
