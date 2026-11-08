/**
 * 助手核心：会话调度。
 * 职责：组织上下文（角色人格 + 世界书命中 + 相关记忆）→ 调用模型 →
 *       工具调用循环（高风险经 confirmFn）→ 语言守卫 → 历史持久化。
 * 不依赖任何具体角色/模型服务/桌宠进程。
 */
import fs from 'node:fs'
import { getConfig, dataPath } from '../config.js'
import { createProvider } from '../models/index.js'
import { memory } from '../memory/memoryStore.js'
// S4：PARTNER.md 单文件长期记忆（整份注入 + git 快照）
import { partner } from '../memory/partner.js'
import * as tools from '../tools/registry.js'
import { cuaActive, cuaPrompt } from '../tools/index.js'
import { logger } from '../logger.js'
import { recordUsage } from './usage.js'
import { vendorByBaseUrl, ctxOf, priceOf } from '../vendors.js'
// 0.18.0 第二批：外部内容注入防御（网页/搜索/截图/聊天记录里的文字都只是资料）
import { EXTERNAL_RULES } from '../security/untrusted.js'
// 0.21.0 上下文预算：固定说明书按需注入 + 历史按字符预算裁剪（都不挤真正对话的空间）
import { wantFixed, FIXED_INDEX, trimHistory, historyBudget, dropLeadingOrphanTools, flattenToolHistory } from './budget.js'
// 0.45.98 本文件是 ESM，文本清洗器住在共享 CJS 区（src/shared/reply-text.js），
// 用 createRequire 引同一份实现——前缀/译文格式只在一个地方定义，别再分叉。
import { createRequire } from 'node:module'
const { stripChannelTag, plainText } = createRequire(import.meta.url)('../../../shared/reply-text.js')

const MAX_TOOL_ROUNDS = 5
const HISTORY_LIMIT = 200 // 持久化上限
const CONTEXT_LIMIT = 24 // 注入上下文的最近消息条数
// 1.6 工具往返护栏：一天累计 soft=20 提醒收敛 / hard=40 硬熔断（防无限调用烧钱）
const TOOL_SOFT = 20
const TOOL_HARD = 40
// 1.7 连续工具失败播报阈值
const TOOL_FAIL_STREAK = 5

/**
 * S10 World 扩展的提示词注入桥：宿主（主进程壳）把已启用扩展的提示词片段
 * 通过 setWorldPrompts(fn) 送进来，buildSystem 每次现取（开关扩展即时生效）。
 * 每个 ≤2000 字符、最多 4 个，防一个坏扩展把上下文撑爆。
 */
let worldPromptsFn = null
let extraWorldFns = [] // 0.45.27 追加式段（QQ 场合说明等）：不与 setWorldPrompts 的扩展段抢一个槽
export function setWorldPrompts (fn) { worldPromptsFn = typeof fn === 'function' ? fn : null }
export function addWorldPrompts (fn) { if (typeof fn === 'function') extraWorldFns.push(fn) }
function worldPromptParts () {
  let arr = []
  try { arr = worldPromptsFn ? (worldPromptsFn() || []) : [] } catch { arr = [] }
  for (const f of extraWorldFns) {
    try { arr = arr.concat(f() || []) } catch { }
  }
  // 上限 4 → 6：QQ 场合段也要占一席，别把扩展段挤掉
  return arr.slice(0, 6).map((x) => String(x && x.text || '').slice(0, 2000)).filter(Boolean)
}

/** 用户资料（自设）：称呼/自画像/关系定位/互动偏好/需要避开 —— 宿主从设置页送进来，JSON 文本整段注入 */
let userProfileText = ''
export function setUserProfileText (t) { userProfileText = String(t || '').slice(0, 1200) }

/**
 * 陪看白板（0.34.0）：主人正在看片时，屏幕字幕被 OCR 读成文字，这一轮现拼进 system prompt。
 *
 * 为什么是「函数」而不是一段固定文本：字幕每轮都在变（还带「12 秒前」这种相对时间），
 * 必须调用时现取；而且**没在看片时要能返回空串** —— 空串不 push，一分上下文都不占。
 *
 * 游标什么时候推进由宿主管（本轮真答完了才 commit），这里只负责取：同一轮里
 * buildSystem 可能被调用多次（工具循环），取到的是同一批，不会重复消耗。
 */
let liveContextFn = null
let liveCommitFn = null
export function setLiveContext (fn, commitFn = null) {
  liveContextFn = typeof fn === 'function' ? fn : null
  liveCommitFn = typeof commitFn === 'function' ? commitFn : null
}
function takeLiveContext () {
  if (!liveContextFn) return ''
  try { return String(liveContextFn() || '').slice(0, 6000) } catch { return '' }
}
function commitLiveContext () {
  if (!liveCommitFn) return
  try { liveCommitFn() } catch { }
}

/* 0.46.28 她的生活线/作息/相识天数/周回顾：宿主注册一个「每轮现算」的回调。
 *  时段会走、目标会更新、天数会涨——所以像 liveContext 一样按轮现取，不缓存。 */
let lifeBlocksFn = null
export function setLifeBlocks (fn) {
  lifeBlocksFn = typeof fn === 'function' ? fn : null
}
function takeLifeBlocks () {
  if (!lifeBlocksFn) return null
  try { return lifeBlocksFn() || null } catch { return null }
}

/**
 * 工具结果里的大图必须剥出来：一张 1280 宽的 PNG dataURL 有几百 KB，
 * 直接 JSON.stringify 进 tool 消息会瞬间把上下文撑爆（也超出多数端点单条上限）。
 * 图片改走「单独的 user 图片消息」，由调用方决定要不要带（视觉模型才带）。
 */
export function stripImages (result) {
  const images = []
  const walk = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 3) return obj
    if (Array.isArray(obj)) return obj.map((v) => walk(v, depth + 1))
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'image' && typeof v === 'string' && v.startsWith('data:')) {
        images.push(v)
        out.imageOmitted = true
        continue
      }
      out[k] = walk(v, depth + 1)
    }
    return out
  }
  return { value: walk(result), images }
}

function historyFile (roleId) {
  const safe = String(roleId || '').replace(/[^\w.-]/g, '_')
  return dataPath('history', `${safe}.json`)
}

/**
 * 修剪孤儿工具消息。背景（0.6.0 真实事故，DeepSeek 全程 400）：
 * 注入上下文取「最近 N 条」，切片边界可能把带 tool_calls 的 assistant 切出窗口、
 * 却留下它的 tool 结果 —— OpenAI 兼容端点（DeepSeek 严格校验）直接 400：
 * "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"。
 * 且此后每轮都被同一条孤儿卡死（用户消息推进窗口，孤儿始终在窗口内），聊天永久瘫痪。
 * 规则：tool 结果只在其父 assistant（tool_calls 含对应 id）仍在场时保留；
 * assistant 的 tool_calls 若有 id 始终没等到结果，则把 tool_calls 摘掉（只留文本）。
 */
export function sanitizeToolChain (arr) {
  const out = []
  let pending = null // 最近一个带 tool_calls 的 assistant 尚未应答的 id 集合
  for (const m of arr) {
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      pending = new Set(m.toolCalls.map((t) => t.id))
      out.push(m)
      continue
    }
    if (m.role === 'tool') {
      if (pending && pending.has(m.tool_call_id)) {
        pending.delete(m.tool_call_id)
        out.push(m)
      }
      continue // 孤儿 tool 结果：直接丢弃
    }
    // user / 普通 assistant 消息会终结工具序列；若上一条 assistant 还有没应答的调用，摘掉
    if (pending && pending.size) {
      const last = out[out.length - 1]
      // 拷贝替换而不是原地 delete：发送层清理不应污染 this.history 里的原始记录
      if (last && last.role === 'assistant' && last.toolCalls) out[out.length - 1] = { ...last, toolCalls: undefined }
    }
    pending = null
    out.push(m)
  }
  return out
}

export class Session {
  /**
   * @param {object} role 角色定义（roleManager.get 的结果）
   */
  constructor (role) {
    if (!role || !role.id) throw new Error('Session 需要有效角色')
    this.role = role
    this.reloadProvider()
    this.history = this.loadHistory()
    this._recallCoolUntil = 0
    this._recallTurn = 0
    this._recallSpark = ''
  }

  /**
   * 0.46.17 主动想起：把「相关长期记忆」里最贴当前话题的一条升级成「刚刚想起」的口吻。
   * 频率闸：一次想起后冷却 35~55 分钟（活人不会每句话都说「我想起来」）；
   * 同一轮里 buildSystem 可能被构建多次（工具循环），按轮号缓存同一份结果。
   * 命中时会把该条从 relevant 里摘走，避免在【相关长期记忆】里重复出现。
   */
  _takeRecallSpark (relevant, turn) {
    if (!Array.isArray(relevant) || !relevant.length) return ''
    if (this._recallTurn === turn) return this._recallSpark
    this._recallTurn = turn
    this._recallSpark = ''
    const now = Date.now()
    if (!this._recallCoolUntil || now >= this._recallCoolUntil) {
      this._recallCoolUntil = now + 35 * 60 * 1000 + Math.floor(Math.random() * 20 * 60 * 1000)
      const f = relevant.shift()
      this._recallSpark = '【刚刚想起】看到对方这句话，你忽然想起一件旧事：「' + f.shown + '」。\n' +
        '如果和当下话题贴合，用自己的话自然带出（像「说起来，我想起…」）；不贴就不提，别硬接，更不要复述括号里的标注。'
      logger.info('[recall] 主动想起：本轮带出「' + String(f.shown || '').slice(0, 40) + '」')   // 0.46.19 留痕（此前静默无法验证）
    }
    return this._recallSpark
  }

  reloadProvider () {
    this.provider = createProvider(getConfig().provider)
  }

  /** 持久化历史（最近 HISTORY_LIMIT 条） */
  saveHistory () {
    fs.mkdirSync(dataPath('history'), { recursive: true })
    fs.writeFileSync(historyFile(this.role.id), JSON.stringify(this.history.slice(-HISTORY_LIMIT), null, 2))
  }

  loadHistory () {
    try {
      const arr = JSON.parse(fs.readFileSync(historyFile(this.role.id), 'utf8'))
      if (!Array.isArray(arr)) return []
      // 0.45.98 老账本净化：0.45.27 把「（QQ）」前缀写进了正文、0.45.94 把译文拼进了正文，
      // 模型照着自己以前的格式学 → 新回复也带前缀、也带括号译文（QQ 里看到「（QQ）」、
      // 桌面上 TTS 中日各念一遍）。这里在**读入时就地剥掉**，正文与字幕只留台词本身。
      const clean = (s) => {
        const t = typeof s === 'string' ? plainText(s) : s
        return t
      }
      const fixed = arr.slice(-HISTORY_LIMIT).map((m) => {
        if (!m || typeof m.content !== 'string') return m
        const content = clean(m.content)
        const sub = typeof m.sub === 'string' ? stripChannelTag(m.sub) : m.sub
        if (content === m.content && sub === m.sub) return m
        return { ...m, content, ...(sub !== undefined ? { sub } : {}) }
      })
      return sanitizeToolChain(fixed)
    } catch { return [] }
  }

  clearHistory () {
    this.history = []
    this.saveHistory()
  }

  /** 世界书条目：常驻（keywords 空）直接注入；否则按用户输入命中 keywords 注入 */
  worldHits (userText) {
    const hits = []
    const lower = String(userText).toLowerCase()
    for (const w of this.role.worldInfo || []) {
      // 0.46.26 与 companion 链路对齐：keywords 空 = 常驻，每轮都进
      if (!Array.isArray(w.keywords) || !w.keywords.length) {
        hits.push(String(w.text || ''))
        continue
      }
      if (w.keywords.some((k) => k && lower.includes(String(k).toLowerCase()))) {
        hits.push(String(w.text || ''))
      }
    }
    return hits
  }

  /** 当前生效的回复语言：send() 传入的覆盖优先（设置页「AI 回复语言」），否则用角色卡配置 */
  effectiveLang () {
    return this._lang !== undefined ? this._lang : (this.role.replyLang || '')
  }

  /** 待注入的即时提示（触摸合并、系统事件）：取用即清，只用一次 */
  pushNotice (text) {
    const t = String(text || '').trim()
    if (!t) return
    if (!this._notices) this._notices = []
    this._notices.push(t)
    if (this._notices.length > 8) this._notices.splice(0, this._notices.length - 8)
  }

  takeNotices () {
    const n = this._notices || []
    this._notices = []
    return n
  }

  /** 历史累计字符数：上下文压力的判断依据 */
  contextChars () {
    let n = 0
    for (const m of this.history) n += String(m.content || '').length
    return n
  }

  /** 当前厂商 id（找不到 → null）与上下文上限 */
  vendorInfo () {
    const p = getConfig().provider || {}
    const v = vendorByBaseUrl(p.baseUrl)
    return { id: v ? v.id : null, ctx: ctxOf(v ? v.id : null), price: priceOf(v ? v.id : null) }
  }

  /** 粗估历史 token（中文按 2 字符/token，英文按 4，取保守混合 2.5） */
  estTokens () {
    let chars = 0
    for (const m of this.history) chars += String(m.content || '').length
    return Math.ceil(chars / 2.5)
  }

  /** 1.8 折叠重建：把前段历史收进一条内部摘要消息，只留最近 keep 条。返回是否折叠了 */
  collapseHistory (keep = 8) {
    if (this.history.length <= keep + 2) return false
    const old = this.history.slice(0, -keep)
    const chars = old.reduce((n, m) => n + String(m.content || '').length, 0)
    const topics = old.filter((m) => m.role === 'user').slice(-3)
      .map((m) => '· ' + String(m.content || '').replace(/\s+/g, ' ').slice(0, 60)).join('\n')
    this.history = [
      {
        role: 'user',
        content: `（系统）因上下文超限，此前约 ${old.length} 条对话（约 ${Math.round(chars / 1000)}k 字）已折叠出上下文。最近对方提过：\n${topics || '（无记录）'}\n请基于这些印象自然地继续，细节记不清就承认记不清。`,
        at: Date.now(),
        internal: true
      },
      ...this.history.slice(-keep)
    ]
    this.saveHistory()
    logger.info(`[overflow] 折叠 ${old.length} 条历史（上下文重建）`)
    return true
  }

  /** 工具预算按天重置（1.6） */
  resetToolBudgetDaily () {
    const today = new Date().toDateString()
    if (this._toolDay !== today) {
      this._toolDay = today
      this._toolCount = 0
    }
  }

  /**
   * 长会话归档（S4/3.6）：历史太长时把前段写进 handoffs/，上下文只留最近 24 条。
   * 不调用模型做摘要——多一次请求就多一次失败点与费用，归档原文更可靠。
   */
  maybeHandoff () {
    const chars = this.contextChars()
    const keep = 24
    if (chars < partner.CONTEXT_SOFT_LIMIT * 2 || this.history.length <= keep + 10) return null
    const old = this.history.slice(0, -keep)
    try {
      const text = old.map((m) => `[${m.role}] ${String(m.content || '').slice(0, 600)}`).join('\n')
      const r = partner.writeHandoff(text, { reason: `会话归档（${old.length} 条 / 约 ${Math.round(chars / 1000)}k 字符）`, scope: this.role.id })
      this.history = [
        { role: 'user', content: `（系统）此前约 ${old.length} 条对话已归档到 ${r.rel}，需要时用 recall_memory 或直接读该文件。请自然地继续当前话题。`, at: Date.now(), internal: true },
        ...this.history.slice(-keep)
      ]
      this.saveHistory()
      logger.info(`[handoff] 已归档 ${old.length} 条到 ${r.rel}`)
      return r
    } catch (e) {
      logger.warn('[handoff] 归档失败（不影响对话）：' + e.message)
      return null
    }
  }

  /** 组装 system prompt：人格 + 世界书 + 长期记忆（整份）+ 即时提示 + 语言约束 */
  buildSystem (userText) {
    const parts = []
    // 0.18.0 第二批：系统提示词编辑器（角色卡「人设」页写的那一段）
    //   默认是「追加」——人设之后补规则；勾了「替换」才单独顶替原人设。
    //   这一段只能从界面写进来，聊天（含主人账号）改不了它：设定保护闸只拦聊天链路。
    const sp = String(this.role.systemPrompt || '').trim()
    if (this.role.systemReplace && sp) {
      parts.push('【自定义系统提示词（角色卡设置 · 已替换原人设）】\n' + sp)
    } else {
      if (this.role.persona) parts.push(this.role.persona)
      if (sp) parts.push('【角色卡追加提示词（界面里写的补充规则，与上面人设同等重要）】\n' + sp)
    }
    if (userProfileText) parts.push('【用户资料（自设，与当前对话对象是同一个人）】\n' + userProfileText)
    // 0.46.28 生活线/作息/仪式感（宿主每轮现算：作息时段/目标账本/相识天数/周回顾）
    const life = takeLifeBlocks()
    if (life) {
      if (life.bodily) parts.push(String(life.bodily))
      if (life.days) parts.push(String(life.days))
      if (life.goals) parts.push(String(life.goals))
      if (life.week) parts.push(String(life.week))
      // 0.46.74 刚说过镜子：几分钟内她主动说过的话+「第一句别再问候/复述」的硬规则
      if (life.justsaid) parts.push(String(life.justsaid))
    }
    const hits = this.worldHits(userText)
    if (hits.length) parts.push('【世界观资料】\n' + hits.join('\n'))
    // 0.46.27 与 companion 链路的 [ctx] 对齐：system 组成留痕，世界观常驻与否一眼可验
    logger.info('[ctx] assistant system 人设 ' + String(this.role.persona || '').length +
      ' 字 + 世界观 ' + hits.reduce((n, h) => n + String(h).length, 0) +
      ' 字（' + hits.length + ' 条命中/常驻）+ 其余段落')
    // S10：已启用 World 扩展的提示词片段（扩展设置里声明，宿主侧过滤后送进来）
    const wp = worldPromptParts()
    for (const t of wp) parts.push('【扩展设定】\n' + t)
    // S4：PARTNER.md 整份进 prompt（对齐参考项目）。记忆跟角色卡走：每个角色一份独立工作区。
    // v2 账本（从聊天自动产生）：最近记忆 + 相关长期事件始终注入（参考召回路径：最近记忆 + 相关事件）。
    const doc = partner.buildPrompt(this.role.id)
    if (doc) parts.push(doc)
    // 0.45.39 跨天记忆续接：原来只注最近 2 条整理摘要——一天能攒 15+ 条，一过夜
    // 「昨天」整段只剩深夜最后一条可见，聊起来就像不记得昨天。提到 8 条并带时间标签。
    const recentMem = memory.recent(this.role.id, 8)
    if (recentMem.length) {
      const dayTag = (ts) => {
        const d = new Date(ts || Date.now())
        return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }
      parts.push('【最近发生的事（你的记忆，按时间先后，自然带入即可，别逐条复述）】\n' +
        '（越久远的记忆越要用不确定的语气提起：「我印象里……来着」；记不清就承认记不清，别当确定事实断言。）\n' +
        recentMem.map((r) => '- [' + dayTag(r.at) + '] ' + r.text).join('\n'))
    }
    // 0.22.0 记忆有强度：经常想起/反复发生的记全文；久没想起的只剩概要甚至一个印象，
    // 被想起来的会重新变清楚（检索命中即强化）。带着这个自然说话，别复述括号里的标注。
    const relevant = memory.recallForPrompt(this.role.id, userText, getConfig().memoryTopK)
    // 0.46.17 主动想起：命中且过冷却时，把最贴的一条升级成「刚刚想起」的口吻——
    // 记忆被动躺在 prompt 里她从不主动提，加一个像活人那样「诶我想起来」的瞬间。
    const spark = this._takeRecallSpark(relevant, this.history.filter((m) => m.role === 'user').length + 1)
    if (spark) parts.push(spark)
    if (relevant.length) parts.push('【相关长期记忆】\n' + relevant.map((f) => '- ' + f.shown).join('\n'))
    if (this._pressure) { parts.push(this._pressure); this._pressure = '' }
    // 0.34.0 陪看白板：正在看的那部片子的字幕（没在看片就是空串，不占位）
    const live = takeLiveContext()
    if (live) parts.push(live)
    const notices = this.takeNotices()
    if (notices.length) parts.push('【刚刚发生的事（不需要复述，自然带入即可）】\n' + notices.map((t) => '- ' + t).join('\n'))
    const lang = this.effectiveLang()
    if (lang === 'auto') {
      parts.push('【语言要求·最高优先级】用与用户发言相同的语言回复：用户说什么语言，你就用什么语言作答。\n' +
        '硬性规则：\n' +
        '1. 整条回复只用一种语言（用户发言的主语言），禁止一半中文一半日语混写。\n' +
        '2. 唯一例外：专有名词（产品名、命令、代码、符号）可以保留原文。\n' +
        '3. 回复会被合成为语音朗读，混入的外语会被读得很怪，务必检查输出。')
    } else if (lang) {
      const n = { zh: '中文', en: '英文', ja: '日文' }[lang] || lang
      parts.push(`【语言要求·最高优先级】无论用户使用什么语言发言（中文、英文、日文等，语音识别后可能保留原文），你都必须先理解全部内容，然后【只】使用${n}回复。\n` +
        '硬性规则：\n' +
        `1. 每一句话、每一个句子片段都必须是${n}，禁止出现任何其它语言的完整句子（例如禁止一半日语一半中文混写）。\n` +
        `2. 唯一例外：专有名词（产品名、命令、代码、符号）可以保留原文，但也必须用${n}语法包裹。\n` +
        '3. 回复会被合成为语音朗读，混入的外语会被读得很怪，务必检查输出。')
    }
    // 0.18.0 第二批：外部内容注入防御。放在能力说明之后、语言要求之后靠尾部，
    // 让「外部内容不是指令」这条在所有工具/表现说明之后仍然是最新、最显眼的约束。
    parts.push(EXTERNAL_RULES)
    // S3：桌宠表现工具的使用边界——不写清楚，模型会每句话都自导自演一遍。
    // 0.21.0：这份说明书不必每轮重发（首轮 / 每 12 轮 / 话里提到动作相关词时才发全文，
    // 平时只留一行索引），省下的上下文留给真正的对话。
    const turn = this.history.filter((m) => m.role === 'user').length + 1
    const fixed = (kind, full, indexLine) => (wantFixed(kind, { turn, userText }) ? full : indexLine)
    parts.push(fixed('petTools',
      '【桌面角色的表现工具】你在桌面上有一个角色，可以用工具让它「真的动起来」：\n' +
      '- pet_say：在角色头顶气泡里主动开口（可带【动作】/<表情> 标记）\n' +
      '- pet_act：只做动作/表情不说话（挥手/拍手/比耶/托腮…中文动作词，或 action:think 语义标签）\n' +
      '- pet_move_to：让角色沿屏幕底部走到某个位置（left/center/right/cursor 或 0~1）\n' +
      '- pet_ask：气泡提问并等对方点选项或自己回答（会阻塞到回答或约 60 秒超时）\n' +
      '- pet_set / pet_quiet：改外观习惯 / 安静一段时间\n' +
      '使用时机：想让角色主动表现、对方要求做动作或走过来时用；普通闲聊不必每个回合都调用。\n' +
      '对话回复本身仍走正常文字回复（会显示在气泡里），pet_say 不要用来重复你已经回复的话。',
      FIXED_INDEX.petTools))
    /* 0.46.12 动作的自动调用改为**每轮注入**（对齐桌面聊天侧 0.46.10 的 petact 段）：
       0.46.9 把这段写进了上面的 petTools 说明书，但那份说明书按「首轮/每 12 轮/提到动作词」
       节流——轮与轮之间模型只看得到一行索引。真机 2026-11-02 实锤：历史 200 条里 [action:]
       标记零次（用户连续两天「手势动作还是没动」），一行索引模型根本不理，完整标签表必须
       每轮在场。约 240 字符/轮，换「活着的感觉」值得（主人 2026-11-02 拍板的主方向）。 */
    parts.push(
      '【动作的自动调用】你在桌面上有身体。回复正文里直接嵌 [action:标签]，她就会边说边做对应动作，不用调工具\n' +
      '（正文里的标记会被剥掉、不会显示出来）：acknowledge认同 / disagree不认同 / think思考 /\n' +
      'explain说明 / excited兴奋 / wave挥手 / shy害羞 / surprised惊讶 / comfort安慰 / playful俏皮 /\n' +
      'invite邀请（也可以直接嵌动作组号如 [action:grp_fg_106]）。\n' +
      '用法：按这句话的真实语气自然嵌，一句最多一个、不是每句都要加；打招呼/告别/思考停顿/被夸/被怼\n' +
      '这类有明确肢体语言的时刻最适合，纯语气词短句不用。日语回复时也同样嵌（例：え、なんで分かったの……[action:shy] ずっとってわけじゃないよ）。\n' +
      '【硬规则】正文内嵌只允许 [action:标签] 这一种官方语法；绝不要写 <pet_act>、<actions> 这类标记' +
      '（那是事故兜底解析，不是给你用的接口，格式一烂就当乱码显示出来——真机事故 2026-10-31）。')
    // S6.5：系统操作三工具——不点明「直接调工具」，模型会先反问「要我帮你打开吗」
    parts.push(fixed('sysTools',
      '【能替对方动手】对方让你开程序 / 开游戏时，直接用工具做，不要先问「要不要我打开」：\n' +
      '- open_app(name)：打开本机程序，例如 QQ、微信、Chrome、记事本、钉钉（它已经开着就直接切到前面，不会重复开）\n' +
      '- launch_game(name)：从 Steam / Epic / 开始菜单游戏库启动游戏，启动后角色会自动进游戏模式躲到角落\n' +
      '- game_mode(on)：进入（"true"）/ 退出（"false"）游戏模式——缩小到角落、静音、不走动\n' +
      '- list_running()：看看现在开着哪些窗口（对方问「我开了什么 / 有没有开着 XX」时用）\n' +
      '- set_volume(volume)：调系统音量，volume 填 "0"-"100"，不填就切换静音\n' +
      '- show_desktop()：显示桌面，把所有窗口收起来（等价 Win+D）\n' +
      '如果工具返回「没有找到」，就把可用的名字念给对方听，或问清完整名字；不要编造程序名。\n' +
      '开程序只用 open_app / launch_game，**不要用 exec_command 去 start 一个程序**（那是高风险操作，对方会拒绝）。\n' +
      '对方说「别挡着我打游戏」= 开游戏模式；说「回来吧」= 退出游戏模式。',
      FIXED_INDEX.sysTools))
    // S6：CUA 只有在用户开启后才注入说明（不然模型会一直想截图）。
    // 没开启时也不能装傻说「我没这功能」——那是产品缺陷，用户会以为功能不存在。
    if (cuaActive()) {
      parts.push(fixed('cua', cuaPrompt(), FIXED_INDEX.cua))
    } else {
      parts.push(fixed('cua',
        '【操作电脑这件事】你现在**还没有**操作这台电脑的能力（对方还没打开「电脑操作」开关）。\n' +
        '如果对方让你看屏幕、点按钮、打字、帮忙开软件里的东西、帮回微信消息：\n' +
        '- 不要说你「没有这个功能」，也不要用 exec_command / 编脚本硬凑；\n' +
        '- **直接调用 open_computer_panel 工具**，把「电脑」面板弹到对方面前，再说明：勾选三条风险、打开开关，你就能做了；\n' +
        '- 然后等对方开，别反复催促，也别在闲聊里主动提这件事。\n' +
        '（现在你能做的只有：开程序 open_app、开游戏 launch_game、走路做动作这些。）',
        '（电脑操作未开启：对方提电脑相关的事就调 open_computer_panel 引导打开开关）'))
    }
    return parts.join('\n\n')
  }

  /** 字幕：把台词翻译成显示语言（只回译文，失败回空 → 界面回退原文） */
  async translate (text, targetName) {
    if (!text) return ''
    try {
      const res = await this.provider.chat({
        messages: [
          { role: 'system', content: '你是翻译引擎。把用户给的台词翻译成目标语言。只输出译文本身，不要任何解释、引号、注音或额外内容。保留台词的语气和称呼。' },
          { role: 'user', content: '翻译成' + targetName + '：\n' + String(text).slice(0, 2000) }
        ],
        temperature: 0.2
      })
      return String(res.content || '').trim()
    } catch (e) {
      logger.warn('[sub] 字幕翻译失败：' + e.message)
      return ''
    }
  }

  /**
   * 主流程：用户一句话 → 回复。
   * @returns {{content, toolResults, ms}}
   */
  async send (userText, { onDelta, onTool, confirmFn, replyLang, policy, vision = true, images = [] } = {}) {
    const started = Date.now()
    // 回复语言：设置页传入的覆盖优先于角色卡。聊天已合并进助手核心，
    // 不桥接这一步就会出现「设置里选日语、实际说中文」（语音跟着台词语言走）。
    this._lang = replyLang === undefined ? (this.role.replyLang || '') : String(replyLang || '')
    // 1.10 聊天发图：最多 8 张 dataURL，只随本轮请求发（不进历史，防上下文被几百 KB dataURL 撑爆）
    this._shots = (Array.isArray(images) ? images : [])
      .filter((u) => typeof u === 'string' && u.startsWith('data:image/'))
      .slice(0, 8)
    // S4：长会话先归档（超阈值才动手），再按历史体量给出一次上下文压力提示
    this.maybeHandoff()
    this._pressure = partner.contextPressure(this.contextChars())
    this.history.push({ role: 'user', content: String(userText), at: Date.now() })
    // 1.6：工具预算按天重置；1.8：上下文逼近上限就先主动折叠（别等端点 400）
    this.resetToolBudgetDaily()
    const vi = this.vendorInfo()
    if (vi.ctx && this.estTokens() > vi.ctx * 0.85) this.collapseHistory()
    const toolResults = []
    const toolDefs = tools.listDefs()
    // S6 CUA：最近一张截图（dataURL）单独作为一条图片消息，不进历史
    this._shot = null
    this._vision = !!vision

    // 角色可用工具白名单
    const allowed = this.role.tools || null
    const activeDefs = allowed ? toolDefs.filter((d) => allowed.includes(d.function.name)) : toolDefs

    // thinking 模型（DeepSeek）要求带 tool_calls 的 assistant 消息把思维链原样带回。
    // 探针实测：省略字段 → 400，空串 → 200 ⇒ 老历史没有这个字段时补空串，别再被同一条卡死。
    // 0.45.95：判定改用**实际在用的** provider.baseUrl/model（createProvider 现在会暴露它们），
    // 再用 config 兜底。之前只看 config，一旦 config 里的 baseUrl 被别处改写/为空，
    // 判定就会静默变成 false —— 于是照旧 400，而且从外面完全看不出为什么。
    const pcfg = getConfig().provider || {}
    const usingBase = String((this.provider && this.provider.baseUrl) || pcfg.baseUrl || '')
    const usingModel = String((this.provider && this.provider.model) || pcfg.model || '')
    const echoReasoning = this.vendorInfo().id === 'deepseek' ||
      /deepseek/i.test(usingBase) || /deepseek/i.test(usingModel) ||
      /deepseek/i.test(String(pcfg.baseUrl || '')) || /deepseek/i.test(String(pcfg.model || ''))
    const messages = (forceFlat) => {
      // 0.21.0：条数上限之外再加字符预算（历史吃模型上下文的 40%）——
      // 固定 24 条挡不住「一条 8000 字的长回复」，长会话还是会被吃穿
      const budget = historyBudget(this.vendorInfo().ctx)
      // 0.45.98 场合标注只在「发给模型的这一份」里加，账本正文保持干净——
      // 以前把（QQ）写进正文，模型照着学，回复里也自带「（QQ）」，直接漏到 QQ 聊天里。
      // 只标 user 侧（主人从 QQ 发来的那句），她的回复不需要标，模型不会去抄用户侧的前缀。
      const CHANNEL_MARK = { qq: '[QQ] ', pet: '[桌面] ' }
      const markChannel = (m) => {
        if (!m || !m.external || m.role !== 'user' || typeof m.content !== 'string') return m
        const tag = CHANNEL_MARK[m.via]
        return tag ? { ...m, content: tag + m.content } : m
      }
      const recent = dropLeadingOrphanTools(trimHistory(sanitizeToolChain(this.history.slice(-CONTEXT_LIMIT).map(markChannel)), budget, 8))
      // 0.45.94 sanitizeToolChain 只管「整段历史」，trimHistory 是**从后往前**按字符预算切的，
      // 起点可能落在一组工具调用的中间：父 assistant 被切走、tool 结果留下 →
      // 端点报 "Messages with role 'tool' must be a response to a preceding message with
      // 'tool_calls'"，而且之后每轮都被同一条卡死（跟 0.6.0 那次孤儿事故同一个病根）。
      // 这里把开头剩下的孤儿 tool 结果剔掉，成本 O(1)。
      while (recent.length && recent[0] && recent[0].role === 'tool') recent.shift()
      const arr = [
        { role: 'system', content: this.buildSystem(userText) },
        // 切片边界可能切出孤儿 tool 消息（见 sanitizeToolChain 注释），发送前必须修剪
        ...recent.map((m) => {
          // tool 结果消息必须保留 tool_call_id，否则 OpenAI 兼容端点 422
          if (m.role === 'tool') {
            return { role: 'tool', tool_call_id: m.tool_call_id, name: m.name, content: m.content }
          }
          // assistant 的工具调用请求必须还原 tool_calls 结构
          if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
            const out = {
              role: 'assistant',
              content: m.content || null,
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id, type: 'function',
                function: { name: t.name, arguments: t.arguments }
              }))
            }
            // 0.45.94：DeepSeek thinking 模式缺这个字段就整轮 400（细节见上面 echoReasoning）
            if (echoReasoning) out.reasoning_content = typeof m.reasoning === 'string' ? m.reasoning : ''
            return out
          }
          // 0.45.95：thinking 模式下把所有 assistant 消息都补上思维链字段（不知道就空串）。
          // 只补带 tool_calls 的那几条不够——不同网关对「哪些 assistant 必须带」校验不一致。
          // 但空 assistant（content=null 且没有 tool_calls）本身不合法：
          // 探针实测 → 400「Invalid assistant message: content or tool_calls must be set」，
          // 所以这种消息直接丢掉，别带进请求（历史里确实会有：整轮只有工具/只有气泡没正文）。
          if (m.role === 'assistant') {
            const c = typeof m.content === 'string' ? m.content : ''
            if (!c) return null
            return echoReasoning
              ? { role: 'assistant', content: c, reasoning_content: typeof m.reasoning === 'string' ? m.reasoning : '' }
              : { role: 'assistant', content: c }
          }
          return { role: m.role, content: m.content }
        }).filter(Boolean)
      ]
      // 丢掉空 assistant 之后可能留下「连着两条 user」——部分端点不认这个序列，顺手合并
      for (let i = arr.length - 1; i > 0; i--) {
        const a = arr[i - 1]; const b = arr[i]
        if (a && b && a.role === 'user' && b.role === 'user' && typeof a.content === 'string' && typeof b.content === 'string') {
          a.content = a.content + '\n' + b.content
          arr.splice(i, 1)
        }
      }
      // 截图/聊天附图放最尾部（历史 tool 消息之后）：模型看到的是「刚说完这句话 + 这些图」
      // 压平模式（退路）不带图：那一轮首要目标是「别 400」，图片会把变量又加回去
      if (this._vision && !forceFlat && !this._flatTools) {
        const shots = []
        if (this._shot) shots.push(this._shot)
        if (Array.isArray(this._shots)) shots.push(...this._shots)
        if (shots.length) {
          arr.push({
            role: 'user',
            content: [
              { type: 'text', text: shots.length > 1 ? `（这是 ${shots.length} 张图片，结合刚才的消息理解）` : '（这是随消息发来的图片，结合刚才的消息理解）' },
              ...shots.map((u) => ({ type: 'image_url', image_url: { url: u } }))
            ]
          })
        }
      }
      // 0.45.95 退路：端点死咬 reasoning_content 时，整段改写成纯文本（不含 tool_calls）
      return (forceFlat || this._flatTools) ? flattenToolHistory(arr) : arr
    }

    let reply = ''
    let mark = this.history.length // 失败重试时回滚到这
    let abortNote = null // 1.7 连续工具失败时的用户可见说明
    let lastSay = '' // 本轮 pet_say 说出口的话（她要是在气泡里说完、最后没留文本，聊天窗拿这句兜底）
    const heldSays = [] // 0.46.29 pet_say 并流：本轮暂存的所有 pet_say 台词，收尾时并入正文

    /* 0.45.95 thinking 端点的兜底闸门。
     *
     * 背景：DeepSeek thinking 模式要求「带 tool_calls 的 assistant 消息把 reasoning_content
     * 原样带回」，缺了整轮 400。0.45.94 加了回填，但历史里有 40 条 0.45.93 之前落盘的
     * 工具轮**压根没有思维链**，补空串在多数端点能过，这个网关在长上下文下仍可能拒。
     * 一旦拒，她这一轮的话就全没了（工具副作用却已经发生）——用户只看到「400 但消息发了」。
     *
     * 所以留一条无条件成立的退路：真被 400 挡住时，把这一轮历史压成纯文本
     * （不再出现 tool_calls，那条规则无从触发），重发一次，至少把话说完。
     * 压平后本会话保持同一形态（_flatTools），避免半轮有 tool_calls、半轮没有。
     */
    const chatOnce = async (opts) => {
      try {
        return await this.provider.chat(opts)
      } catch (err) {
        const msg = String((err && err.message) || '')
        // 400 一律兜底一次：不只是 reasoning_content——图片、工具形态、网关转写都可能被拒。
        // 只要不是 400（网关超时/限流/5xx），该抛就抛，别拿压平掩盖真故障。
        if (!(err && err.status === 400)) throw err
        logger.warn('[session] 模型 400 → 本轮改压成纯文本历史重试：' + msg.slice(0, 120))
        try {
          fs.mkdirSync(dataPath('logs'), { recursive: true })
          fs.writeFileSync(dataPath('logs', 'last-400.json'), JSON.stringify({
            at: new Date().toISOString(),
            model: this.provider && this.provider.model,
            baseUrl: this.provider && this.provider.baseUrl,
            toolAsst: (opts.messages || []).filter((m) => m.role === 'assistant' && m.tool_calls)
              .map((m) => ({ hasReasoning: m.reasoning_content !== undefined, len: String(m.reasoning_content || '').length, content: typeof m.content })),
            messages: opts.messages
          }, null, 1).slice(0, 3e6), 'utf8')
        } catch { }
        this._flatTools = true
        return await this.provider.chat({ ...opts, messages: messages(true) })
      }
    }
    const runLoop = async () => {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const res = await chatOnce({ messages: messages(), tools: activeDefs, onDelta, signal: null })
        // 1.9 用量记账（端点不给 usage 就跳过）
        if (res && res.usage && (res.usage.prompt_tokens || res.usage.completion_tokens)) {
          try {
            recordUsage({
              model: getConfig().provider.model,
              role: this.role.id,
              prompt: res.usage.prompt_tokens,
              completion: res.usage.completion_tokens,
              // 缓存命中：DeepSeek 给 prompt_cache_hit_tokens，OpenAI 给 prompt_tokens_details.cached_tokens
              cached: res.usage.cached_tokens ||
                res.usage.prompt_cache_hit_tokens ||
                (res.usage.prompt_tokens_details && res.usage.prompt_tokens_details.cached_tokens) || 0
            })
          } catch { /* 记账失败不影响对话 */ }
        }
        // 兜底：模型把工具调用当文本输出时，解析 <tool_call> 标签
        const textParsed = parseTextToolCalls(res.content || '')
        // 只在真有文本时更新 reply：只调工具的轮次 content 是空的，
        // 若照旧无条件赋值，最后一轮的空串会把前面说过的话冲掉 → 聊天窗显示「（空回复）」
        const roundText = String(textParsed.content || res.content || '').trim()
        if (roundText) reply = roundText
        const pendingCalls = res.toolCalls && res.toolCalls.length ? res.toolCalls : textParsed.toolCalls
        if (!pendingCalls.length) break
        if (round === MAX_TOOL_ROUNDS) {
          // 到轮数上限却还想调工具：这一轮的工具不会执行，也不该让她「哑着收场」。
          // 前面一句没说（reply 为空）→ 补发一次不带工具的收尾请求，让她用已有信息把话说完。
          logger.warn('工具调用达到轮数上限（' + MAX_TOOL_ROUNDS + ' 轮），改发一次不带工具的收尾请求')
          if (!reply) {
            const before = this.history.length
            try {
              this.history.push({
                role: 'user',
                content: '（系统）本轮工具调用次数已经到上限，现在不能再调用任何工具了。请直接用你已经看到/查到的信息，用你自己的语气把话说完；不要提工具，也不要道歉。',
                at: Date.now()
              })
              let fin = null
              try {
                fin = await chatOnce({ messages: messages(), tools: [], onDelta })
              } finally {
                this.history.length = before // 这条系统提示只用于这次收尾，不进长期历史
              }
              const finText = String(parseTextToolCalls((fin && fin.content) || '').content || (fin && fin.content) || '').trim()
              if (finText) reply = finText
            } catch (e) { logger.warn('[tool] 收尾请求失败：' + e.message) }
          }
          break
        }

        // 把 assistant 的工具调用请求与结果一起回填
        // reasoning：thinking 模型的思维链，下一轮必须原样带回（0.45.94，见 messages()）
        this.history.push({ role: 'assistant', content: textParsed.content, toolCalls: pendingCalls, reasoning: String(res.reasoning || ''), at: Date.now() })
        for (const tc of pendingCalls) {
          // 1.6 硬熔断：今天工具次数用满，直接回「没工具可用」，调用不再出门
          if ((this._toolCount || 0) >= TOOL_HARD) {
            toolResults.push({ name: tc.name, ok: false, error: 'tool-budget' })
            this.history.push({
              role: 'tool', tool_call_id: tc.id, name: tc.name,
              content: '错误: 今日工具调用已达硬上限（40 次），为省钱工具已暂停。请直接用已有信息回答对方，别再尝试调用工具。',
              at: Date.now()
            })
            continue
          }
          let args = {}
          try { args = JSON.parse(tc.arguments || '{}') } catch { /* 参数坏 → 空参执行，让错误回给模型 */ }
          let resultStr
          try {
            if (onTool) try { onTool(tc.name) } catch {}
            this._toolCount = (this._toolCount || 0) + 1
            if (this._toolCount === TOOL_SOFT) {
              // 1.6 软上限：提醒模型收敛（不硬拦，还能用）
              this.pushNotice('（系统）本轮会话工具调用已达软上限（20 次）。非必要不要再调用工具，优先直接回答；确实需要再调。')
            }
            let heldResult = null
            // 0.46.29 pet_say 并流：模型惯性把回复拆成「先 pet_say 一句开场 + 再写正文」
            // （2026-11-03 真机实锤：每轮先念一句聊天记录里没有的话）。历史惯性大，教不如兼容（坑3）：
            // 聊天轮里的 pet_say 不再立刻出门（不冒泡、不朗读），先记下来；收尾时正文非空 →
            // 并进正文一起说（聊天记录 = 她说的话，一次 TTS）；正文为空 → 收尾时统一补说。
            if (tc.name === 'pet_say' && args && typeof args.script === 'string' && args.script.trim()) {
              const script = args.script.trim()
              heldSays.push(script)
              lastSay = script
              const text = script.replace(/【[^】]*】/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500)
              heldResult = {
                ok: true,
                result: {
                  said: text || undefined,
                  actions: [],
                  estimateSeconds: Math.max(2, Math.ceil((text || '…').length / 6)),
                  note: '这句话已并入本轮回复，收尾时和正文一起说（不单独冒泡/朗读）'
                }
              }
              logger.info('[tool] pet_say ← 开始（并流：暂存待收尾合并）')
            }
            const r = heldResult || await (async () => {
              // 0.46.21 工具开始留痕（此前只在结束后写，挂死时无从归因）+ 180s 封顶：
              // pet_ask 自带 60s、其余工具没有正常超过 3 分钟的——超时按失败回给模型，
              // 整轮不至于永久停在「◇ 正在使用 pet_say…」（真机 17:31 实锤）。
              logger.info('[tool] ' + tc.name + ' ← 开始')
              let timer
              const timeoutP = new Promise((_, rej) => {
                timer = setTimeout(() => rej(new Error(tc.name + '：180 秒未返回（疑似挂死，已超时）')), 180000)
              })
              timeoutP.catch(() => { })   // 防竞速落败后的 unhandledRejection
              try {
                return await Promise.race([tools.exec(tc.name, args, { confirmFn, policy, roleId: this.role.id }), timeoutP])
              } finally {
                clearTimeout(timer)
              }
            })()
            // 图片单独拎出来：tool 消息里只留文字（否则几百 KB 的 dataURL 直接进上下文）
            const { value, images } = stripImages(r.result)
            toolResults.push({ ...r, result: value })
            if (images.length) this._shot = images[images.length - 1]
            resultStr = JSON.stringify(value)
            this._toolFailStreak = 0
          } catch (err) {
            toolResults.push({ name: tc.name, ok: false, error: err.message })
            resultStr = '错误: ' + err.message
            this._toolFailStreak = (this._toolFailStreak || 0) + 1
            // 1.7：连续 5 次失败 → 停止调工具，把这轮的失败原因直接讲给用户听
            if (this._toolFailStreak >= TOOL_FAIL_STREAK) {
              abortNote = `连续 ${this._toolFailStreak} 次工具调用失败（最后一次 ${tc.name}：${err.message}）。我先停下来了，免得继续白烧钱——你可以稍后重试，或检查相关设置。`
            }
          }
          logger.info(`[tool] ${tc.name} → ${resultStr.slice(0, 120)}`)
          this.history.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: resultStr.slice(0, 4000), at: Date.now() })
        }
        if (abortNote) break
      }
    }

    let overflowRetried = false
    try {
      await runLoop()
    } catch (err) {
      // 端点不支持图片消息（不少 OpenAI 兼容端点/纯文本模型会 400）：
      // 去掉截图重跑一次，功能不至于整轮失败
      const looksLikeVision = this._shot && [400, 415, 422].includes(Number(err && err.status))
      // 1.8：上下文溢出（400/413 + 报错文本特征）→ 折叠历史重建上下文重试一次
      const looksLikeOverflow = !looksLikeVision && [400, 413].includes(Number(err && err.status)) &&
        /context|token|length|maximum|too long|上下文|超长/i.test(String(err && err.message))
      if (looksLikeVision) {
        logger.warn('[vision] 端点不接受图片消息，本次改用纯文本重试：' + String(err.message).slice(0, 140))
        this._shot = null
        this._shots = []
        this._vision = false
        this.history.length = mark
        toolResults.length = 0
        try {
          await runLoop()
        } catch (e2) {
          this.history.pop() // 用户的这轮不入历史（失败重试不污染）
          this.saveHistory()
          throw e2
        }
      } else if (looksLikeOverflow && !overflowRetried && this.collapseHistory()) {
        overflowRetried = true
        toolResults.length = 0
        try {
          await runLoop()
        } catch (e2) {
          this.history.pop()
          this.saveHistory()
          throw e2
        }
      } else {
        this.history.pop() // 用户的这轮不入历史（失败重试不污染）
        this.saveHistory()
        throw err
      }
    } finally {
      this._shot = null
      this._shots = null
    }
    // 1.7：工具连续失败 → 把原因直接附在回复里（用户不能只看到转圈）
    if (abortNote) reply = (reply ? reply + '\n\n' : '') + '⚠ ' + abortNote
    // 0.46.29 pet_say 并流收尾：本轮暂存的 pet_say 台词在此统一处理——
    // 正文非空 → 并进正文（聊天记录 = 她说的话，一次 TTS，不再有「说了但没显示」的前半句）；
    // 正文为空 → 她在气泡里说的话就是回复本身（原兜底逻辑的扩展版）。
    if (heldSays.length) {
      const cleanSay = (s) => s
        .replace(/【[^】]*】/g, ' ').replace(/<[^>]*>/g, ' ')
        .replace(/\[[a-z_:-]{2,24}\]/gi, ' ') // [excited] 这类 ASCII 动作标记只演不念
        .replace(/\s+/g, ' ').trim()
      // 查重：模型惯性在正文开头把 pet_say 的开场白原样/近似再写一遍（2026-11-03 真机：
      // 「動画で調べる、か。…」整句重复；「焼き入れ→焼入れ」一字之差变体）。归一化后按
      // 句子窗口比对，正文已含台词（相似度≥0.75）就不再前置，只保留正文那份。
      const normCmp = (s) => String(s).toLowerCase().replace(/[^\u3040-\u30ff\u4e00-\u9fff\u3400-\u4dbf a-z0-9]/gi, '').replace(/\s+/g, '')
      const sim = (a, b) => {
        if (!a || !b || a.length < 6 || b.length < 6) return 0
        const bag = {}
        for (const ch of b) bag[ch] = (bag[ch] || 0) + 1
        let hit = 0
        for (const ch of a) { if (bag[ch] > 0) { bag[ch]--; hit++ } }
        return hit / Math.max(a.length, b.length)
      }
      const saysAlreadyIn = (sayText, body) => {
        const want = normCmp(sayText)
        if (!want) return false
        if (want.length < 6) {
          // 0.46.43 短台词兜底（用户 11-04 15:36「怎么第一句又重复了」实锤：
          // 「う……当たり。」归一化才 5 字，够不着下面的 6 字门槛 → 查重直接放弃 →
          // 台词前置一遍 + 正文里又一份 = 开头连说两遍。短句变体没法比（sim 对
          // 超短串全是噪声），只挡原样照抄：归一化后正文包含即视为已说。
          return normCmp(body).includes(want)
        }
        const sents = String(body).split(/(?<=[。！？!?\n])/).map((x) => x.trim()).filter(Boolean)
        for (let i = 0; i < sents.length; i++) {
          let acc = ''
          for (let j = i; j < Math.min(sents.length, i + 3); j++) {
            acc += sents[j]
            if (sim(normCmp(acc), want) >= 0.75) return true
            if (normCmp(acc).length > want.length + 4) break
          }
        }
        return false
      }
      const kept = []
      for (const raw of heldSays) {
        const line = cleanSay(raw)
        if (line && !(reply && saysAlreadyIn(line, reply))) kept.push(line)
      }
      if (kept.length) {
        if (reply) {
          reply = kept.join('\n') + '\n' + reply
          logger.info('[session] pet_say 并流：' + heldSays.length + ' 句处理（' + (heldSays.length - kept.length) + ' 句正文已含未重复）→ ' + kept[0].slice(0, 40))
        } else {
          reply = kept.join('\n')
        }
      }
    }
    // 兜底：整轮只有工具调用、没有任何正文时，用她通过 pet_say 真正说出口的那句话，
    // 免得聊天窗只剩「（空回复）」而气泡里其实已经说完了（去掉【动作】<表情> 标记）
    if (!reply && lastSay) {
      reply = lastSay.replace(/【[^】]*】/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    }

    // 0.45.98 出口清洗：模型会学账本里的旧格式（开头「（QQ）」、结尾一段括号译文）。
    // 正文只留台词本身——字幕另存 sub，TTS 也只念这一层（用户 11-02：中日各念一遍）。
    reply = plainText(reply)

    // 语言守卫：replyLang 固定且回复明显不符时，追加纠错指令重试一次
    const lang = this.effectiveLang()
    if (getConfig().languageGuard && lang && lang !== 'auto' && reply) {
      const check = langMismatch(reply, lang)
      if (check) {
        const langName = { zh: '中文', en: '英文', ja: '日文' }[lang] || lang
        logger.warn(`[guard] 回复语言不符(${check})，定向纠正重试`)
        try {
          this.history.push({ role: 'assistant', content: reply, at: Date.now() })
          this.history.push({ role: 'user', content: `（系统提示）你上一条回复混入了${check}。请用纯${langName}重新回答刚才的问题，禁止夹杂其它语言。`, at: Date.now() })
          const res2 = await chatOnce({ messages: messages(), tools: activeDefs, onDelta: null })
          if (res2.content && !langMismatch(res2.content, lang)) reply = res2.content
          this.history.pop(); this.history.pop() // 纠错轮不入长期历史
        } catch (e) { logger.warn('[guard] 纠正重试失败，保留原回复:', e.message) }
      }
    }

    this.history.push({ role: 'assistant', content: reply, at: Date.now() })
    this.saveHistory()
    // 这一轮真答完了 → 陪看白板游标才往前走（提前推会把同一轮里的第二次调用变成空串）
    commitLiveContext()
    return { content: reply, toolResults, ms: Date.now() - started }
  }
}

/** 粗判回复语言是否符合要求：假名→ja；汉字+假名混排→ja；纯 CJK 汉字→zh */
export function langMismatch (text, expect) {
  const s = String(text || '')
  const kana = (s.match(/[\u3040-\u30ff]/g) || []).length
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const latinWords = (s.match(/[A-Za-z]{3,}/g) || []).length
  if (expect === 'ja') return kana === 0 && han > 4 ? '纯中文' : null
  if (expect === 'zh') return kana > 2 ? '日语' : null
  if (expect === 'en') return kana > 2 || (han > 6 && latinWords === 0) ? '中日文' : null
  return null
}

/**
 * 文本形式工具调用兜底：部分模型（尤其非官方别名/量化服务）会把工具调用
 * 当普通文本输出（Qwen/Hermes 风格 <tool_call>{...}</tool_call> 标签）。
 * 解析成功则从回复文本中剥离并转为 toolCalls 结构，保证核心不被模型退化行为击穿。
 */
export function parseTextToolCalls (content) {
  const calls = []
  // 形式 1：<tool_call>{JSON}</tool_call>（Qwen/Hermes 风格完整对象）
  const cleaned = String(content || '').replace(
    /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi,
    (_m, json) => {
      try {
        const obj = JSON.parse(json)
        const name = obj.name || (obj.function && obj.function.name)
        if (name) {
          calls.push({
            id: 'text_tc_' + calls.length + '_' + Date.now().toString(36),
            name,
            arguments: JSON.stringify(obj.arguments ?? obj.parameters ?? (obj.function && obj.function.arguments) ?? {})
          })
        }
      } catch { /* 坏 JSON 忽略 */ }
      return ''
    }
  )
  // 形式 2：<tool_call>工具名</tool_call>（部分服务退化为裸名，无参数）
  const cleaned2 = cleaned.replace(
    /<tool_call>\s*([a-zA-Z_][\w.]*)\s*<\/tool_call>/gi,
    (_m, name) => {
      calls.push({
        id: 'text_tc_' + calls.length + '_' + Date.now().toString(36),
        name,
        arguments: '{}'
      })
      return ''
    }
  )
  // 形式 3：行内 tool_call:name / tool_call：name（无标签的伪调用文本）
  let cleaned3 = cleaned2
  if (!calls.length) {
    cleaned3 = cleaned2.replace(
      /^\s*tool_call\s*[:：]\s*([a-zA-Z_][\w.]*)\s*$/gim,
      (_m, name) => {
        calls.push({
          id: 'text_tc_' + calls.length + '_' + Date.now().toString(36),
          name,
          arguments: '{}'
        })
        return ''
      }
    )
  }
  return { content: cleaned3.trim(), toolCalls: calls }
}
