'use strict'
/**
 * AI 伴侣 · 语义判读（understand）
 *
 * 为什么要有这个（用户 10-29 20:11 的原话：「不能固定句式，要跟这个句式一样的意思也可以才行」）：
 *   0.35.0 的 presence/rebuke 是**词表匹配**——「我出门了」「要坐车了」认得，
 *   换成「车来了」「到公司了」「手机快没电了先不聊」「在路上了」就全瞎。
 *   而且词表分不清意思相反的两句：「今天你话真多」和「今天你话真少」都会命中。
 *   词表越补越长、越补越互相打架，这是死路。
 *
 * 所以判定分成两层：
 *   快判（词表，同步、零延迟、永远可用）—— 高置信命中直接用，没命中就当「没看见」
 *   精判（本模块，异步、走一次小模型）—— 看**意思**，同义、反问、反话都能认
 * 精判回来之后做两件事：**补**（词表漏了的）和**撤**（词表看错的）。
 *
 * 设计约束（每一条都对应一个具体的坑）：
 *   1. 绝不阻塞对话。它挂在旁路，结果晚到一两秒没关系，慢了一律当失败。
 *   2. 绝不因为判读失败影响任何正常功能。拿不到就返回 null，调用方保持原判。
 *   3. 同一个模型、同一份配置，不额外要求用户填第二套 key。
 *   4. 输出必须是严格 JSON —— 模型爱写前言，parseReply 负责把 JSON 挖出来。
 *   5. 连发很多条时不排队堆积（有了限流），也不能乱序（串行链）。
 */

/** 单句判定：太长的不是「宣告」，是正文，直接放过（省一次调用） */
const MAX_CHARS = 400
const CACHE_MAX = 200
/** 限流：60 秒内最多判这么多次。正常对话远够，刷屏时不至于把请求堆爆 */
const BURST_WINDOW_MS = 60 * 1000
const BURST_MAX = 40

const EMPTY = Object.freeze({ leave: 0, back: 0, about: 'other', tone: 'none', weight: 0, why: '' })

const SYSTEM_PROMPT = [
  '你是意图判读器。读「他」对桌面 AI 伴侣说的话，判断这件事，不回应、不评价、不展开。',
  '',
  '判三件事：',
  '',
  '1) leave —— 他是不是在说自己要离开 / 已经离开电脑前',
  '   2 = 明确（出门、上班、坐车、上车、到公司了、去忙、睡觉去了、不在电脑前、今晚不来了）',
  '   1 = 暗示（等下再聊、先这样、我去弄点别的、一会回来）',
  '   0 = 不是',
  '',
  '2) back —— 他是不是在说自己回来了 / 回到电脑前',
  '   2 = 明确（我回来了、到家了、我坐回来了、开机了）',
  '   1 = 暗示（忙完了、差不多了、又来了）',
  '   0 = 不是',
  '',
  '3) 这句话是不是在评价她、对她提要求：',
  '   about = "her"（说的是她的表现）| "him"（说的是他自己或别人）| "other"（无关）',
  '   tone  = "none" | "correct"（纠正做法，最轻）| "criticize"（不满、嫌吵、嫌烦、嫌黏）',
  '           | "disappoint"（失望、自责、觉得不该开她、心疼她寂寞）| "stop"（明确要求闭嘴、别说了）',
  '   weight = 0~1，他表达不满的强度',
  '',
  '判别要点（重要）：',
  '- 看意思，不看字面。同一件事有无数种说法，任何一条具体句式都只是例子：',
  '  「车来了」「在路上了」「到公司了」「手机快没电了先不聊」「我得走了」「先忙了」→ 都是 leave',
  '- 反话按真实意思判。「你可真安静啊」是嫌她太闷；「今天你话真多」是嫌她吵。',
  '- 说的是他自己（「我今天有点烦」「我对自己挺失望」）→ about=him，tone=none。',
  '- 问句（「你要出门吗」「你回来了没」）不是在报告行程，leave 和 back 都填 0。',
  '- 主语不是她就不算：' + "'这歌里别吵了'" + '「视频小声点」「你别跟它吵」「别吵到楼下」' +
    '是在说音乐、视频、别人——about 填 other 或 him，tone 填 none。',
  '  只有明确在说**她的表现**（她话说多了、太黏、太安静、让她别问了）才算 her。',
  '- 不确定就填 1 或 0，不要硬猜成 2。',
  '',
  '只输出这个 JSON，不要代码块，不要解释，不要多余的字：',
  '{"leave":0,"back":0,"about":"other","tone":"none","weight":0,"why":""}',
  'why 用不超过 12 个字说明依据（可以留空）。'
].join('\n')

/** 最近几条对话（给判读器当语境：单句歧义太大，尤其是反话） */
function contextLines (context, limit = 4) {
  if (!Array.isArray(context)) return ''
  const rows = context.slice(-limit).map((m) => {
    if (!m || !m.content) return ''
    const who = m.role === 'user' ? '他' : '你'
    const t = String(m.content).replace(/\s+/g, ' ').trim().slice(0, 80)
    return t ? who + '：' + t : ''
  }).filter(Boolean)
  return rows.join('\n')
}

function buildPrompt (text, context) {
  const s = String(text || '').trim().slice(0, MAX_CHARS)
  const ctx = contextLines(context)
  const user = (ctx ? '【刚在聊】\n' + ctx + '\n\n' : '') + '【要判的这句】\n' + s
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user }
  ]
}

const TONES = ['none', 'correct', 'criticize', 'disappoint', 'stop']
const ABOUTS = ['her', 'him', 'other']

function clampInt (v, lo, hi) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 0
  return Math.min(hi, Math.max(lo, n))
}

function pick (v, allowed, dflt) {
  const s = String(v || '').toLowerCase().trim()
  return allowed.includes(s) ? s : dflt
}

/**
 * 把模型输出解析成判定。模型爱加 ```json 围栏、爱写「好的，结果如下：」——这里都剥掉。
 * 拿不到 JSON 就返回 null（调用方保持原判），绝不猜。
 * @returns {{leave:number, back:number, about:string, tone:string, weight:number, why:string}|null}
 */
function parseReply (raw) {
  let s = String(raw || '').trim()
  if (!s) return null
  s = s.replace(/^```[a-zA-Z]*\s*/g, '').replace(/```$/g, '').trim()
  // 从第一个 { 到最后一个 }（模型有时前后带话）
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  const body = s.slice(a, b + 1)
  let j
  try { j = JSON.parse(body) } catch {
    // 容错：单引号 / 尾逗号
    try {
      j = JSON.parse(body.replace(/'/g, '"').replace(/,\s*}/g, '}'))
    } catch { return null }
  }
  if (!j || typeof j !== 'object') return null
  // 一个约定的字段都没有 → 这不是判读结果（`{}`、`{"error":"..."}`），当不成形处理。
  // 不能给它补成全 0 的判定：那看起来「判过了」，其实是模型没照格式答。
  if (!('leave' in j) && !('back' in j) && !('tone' in j)) return null

  const out = {
    leave: clampInt(j.leave, 0, 2),
    back: clampInt(j.back, 0, 2),
    about: pick(j.about, ABOUTS, 'other'),
    tone: pick(j.tone, TONES, 'none'),
    weight: Math.min(1, Math.max(0, Number(j.weight) || 0)),
    why: String(j.why || '').slice(0, 24)
  }
  // 自称「在说她」但没给语气 → 视为无关，避免凭空制造负反馈
  if (out.about !== 'her') out.tone = 'none'
  if (out.tone === 'none') out.weight = 0
  // 同一句既说走又说回（「我出去一趟马上回来」）→ 以「走」为准，回来另有信号
  if (out.leave === 2 && out.back === 2) out.back = 0
  return out
}

/**
 * 判读器外壳。
 * @param {{cfgGet:()=>object, chat?:Function, log?:Function, now?:()=>number}} deps
 *   cfgGet 返回 { apiBaseUrl, apiKey, apiModel }（就是 companion 那套现成配置）
 *   chat 可注入（测试用），默认走 llm.chatOnce
 */
function createInterpreter ({ cfgGet, chat, log = () => { }, now = () => Date.now(), timeoutMs = 8000 } = {}) {
  const say = (m) => { try { log('[understand] ' + m) } catch { } }
  const call = chat || ((args) => require('./llm').chatOnce(args))

  const cache = new Map()   // text → judgment（同句重发不重复烧 token）
  let chain = Promise.resolve()
  let stamps = []           // 最近调用的时间戳（限流用）
  const stats = { calls: 0, ok: 0, fail: 0, cached: 0, skipped: 0 }

  function cachePut (k, v) {
    if (cache.size >= CACHE_MAX) {
      const first = cache.keys().next()
      if (!first.done) cache.delete(first.value)
    }
    cache.set(k, v)
  }

  function overBurst () {
    const t = now()
    stamps = stamps.filter((x) => t - x < BURST_WINDOW_MS)
    return stamps.length >= BURST_MAX
  }

  /**
   * 判一句。永远 resolve（失败给 null），永远不抛。
   * @returns {Promise<object|null>}
   */
  function interpret (text, context) {
    const s = String(text || '').trim()
    if (!s || s.length > MAX_CHARS) return Promise.resolve(null)
    const key = s.slice(0, 120)
    if (cache.has(key)) { stats.cached++; return Promise.resolve(cache.get(key)) }
    if (overBurst()) { stats.skipped++; return Promise.resolve(null) }

    const c = (typeof cfgGet === 'function' ? cfgGet() : null) || {}
    if (!c.apiBaseUrl || !c.apiModel) return Promise.resolve(null)  // 没配模型：静默退词表

    // 串行：保证「先说的话先应用」，也避免连发时并发打满
    chain = chain.then(async () => {
      stats.calls++
      stamps.push(now())
      try {
        const raw = await call({
          baseUrl: c.apiBaseUrl,
          apiKey: c.apiKey,
          model: c.apiModel,
          messages: buildPrompt(s, context),
          temperature: 0,
          maxTokens: 220,
          timeoutMs
        })
        const j = parseReply(raw)
        if (!j) { stats.fail++; say('判读输出不成形，本次忽略：' + String(raw || '').slice(0, 60)); return null }
        stats.ok++
        cachePut(key, j)
        if (j.leave || j.back || j.tone !== 'none') {
          say('判读：leave=' + j.leave + ' back=' + j.back + ' tone=' + j.tone +
            ' w=' + j.weight + (j.why ? '（' + j.why + '）' : ''))
        }
        return j
      } catch (err) {
        stats.fail++
        say('判读失败（不影响对话）：' + ((err && err.message) || err))
        return null
      }
    })

    return chain
  }

  function status () { return Object.assign({ cache: cache.size, pending: 0 }, stats) }
  function clearCache () { cache.clear() }

  return { interpret, status, clearCache }
}

module.exports = {
  MAX_CHARS, CACHE_MAX, BURST_WINDOW_MS, BURST_MAX,
  EMPTY, SYSTEM_PROMPT,
  buildPrompt, contextLines, parseReply,
  createInterpreter
}
