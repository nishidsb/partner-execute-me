'use strict'
/**
 * AI 伴侣 · 内心生活（inner）
 *
 * 三件事：
 *   1. 采集：把「她说了什么 / 主人怎么反应 / 被做了什么 / 她自己做了什么」写进事件流
 *   2. 自述：日终把当天的事件用**她的第一人称**写成一篇日记
 *   3. 注入：把最近日记 + 当前状态交回 systemPrompt
 *
 * 命名注意：本文件在渲染层之外，但仍遵守「不引用未定义常量」的规矩。
 */
const fs = require('node:fs')
const path = require('node:path')
const self = require('./self')
const rebuke = require('./rebuke')
const understand = require('./understand')
const llm = require('./llm')

/** 当前角色上下文；switchChar 时会更新 */
let ctx = { wsDir: '', log: () => { }, llmCfg: null, persona: '', feedback: 'on' }
let writeTimer = null
let snubTimer = null   // 0.46.33 冷落感知心跳（45s）
let writing = false
let distilling = false

/** 注入上下文。wsDir 来自 partner.workspaceDir(roleId)
 *  feedback: 'on' | 'off' —— 测试期随时能关掉负反馈（关了之后 quiet/cold 不再累加，
 *  已记录的值保留不动，想彻底归零用 resetFeedback / rollbackFeedback）。 */
function setContext (next) {
  const prev = ctx.wsDir
  ctx = Object.assign({}, ctx, next || {})
  if (ctx.wsDir && ctx.wsDir !== prev) {
    try { self.ensure(ctx.wsDir) } catch { }
    // 0.35.0：切角色/重启后把「她说过但还没结算被无视」的发言捞回来
    loadPending()
  }
  return ctx
}

/** 负反馈是否生效 */
function feedbackOn () { return ctx.feedback !== 'off' }

function ready () { return !!(ctx.wsDir && ctx.llmCfg) }
function log (msg) { try { ctx.log('[inner] ' + msg) } catch { } }

/* ------------------------------------------------------------ 采集 */

/** 最近一次收到的主人发言 + 本次快判结果（幂等去重 + 精判比对都用它） */
let lastNote = { text: '', at: 0, rb: { hit: false, kind: '', weight: 0, why: '' } }

function ev (kind, text, meta) {
  if (!ctx.wsDir) return false
  return self.appendEvent(ctx.wsDir, { kind, text, meta })
}

/** 她说给你听（期待回应，被无视会计入负反馈） */
function noteSay (text, meta) {
  ev(self.SAY, text, meta)
  if (ctx.wsDir) self.patchState(ctx.wsDir, { lastSpoke: Date.now() })
}

/** 废话：不期待回应，被无视不受伤，所以单独一个类型 */
function noteNarration (text) {
  ev(self.NARRATION, text)
}

/** 0.45.44 最近她主动说过的话（say + narration，最新的在最后），防复读用。
 *  用户 10-31 实锤：nudge 一晚上每句都提「配合ノート」——没有这面镜子，
 *  模型每次都往同一个道具上凑，主动搭话听起来像另一台机器。 */
function recentVoices (n, sinceMs) {
  if (!ctx.wsDir) return []
  try {
    // 0.46.42 可选时间窗（毫秒）：复读闸/提示词镜子只要最近一段时间的，
    // 事件文件跨天留存，无界取「最近 8 句」在话说得少的下午能横跨几小时
    const since = Number(sinceMs) > 0 ? Date.now() - Number(sinceMs) : 0
    const list = self.readEvents(ctx.wsDir)
      .filter((e) => e && (e.kind === self.SAY || e.kind === self.NARRATION) && e.text)
      .filter((e) => !since || (Number(e.t) || 0) >= since)
    const k = Number(n)
    return (k > 0 ? list.slice(-k) : list).map((e) => String(e.text).replace(/\s+/g, ' ').slice(0, 60))
  } catch { return [] }
}

/** 0.45.85 她最后一次开口（say/narration/reply）的时刻，没开过口返回 0。
 *  给「观察翻篇」用：上次开口之前瞥见的东西就算念过/翻篇了，
 *  不能在主动通道里被反复翻出来当新话题（trackid 嘀咕 6 遍的教训）。 */
function lastVoiceAt () {
  if (!ctx.wsDir) return 0
  try {
    let last = 0
    for (const e of self.readEvents(ctx.wsDir)) {
      if (e && (e.kind === self.SAY || e.kind === self.NARRATION || e.kind === 'reply') && (Number(e.t) || 0) > last) last = Number(e.t)
    }
    return last
  } catch { return 0 }
}

/** 0.45.0 悄悄观察：她瞥见的关于主人的一行白描——不说话，只记。
 *  跟 narration（她自己做的事）分开，日记里「我对他的观察」有真材实料可写。 */
function noteObserve (text) {
  const t = String(text || '').trim().slice(0, 80)
  if (!t) return false
  return ev('observe', t)
}

/** 今天的悄悄观察（最新的在最后），给聊天注入用：她能接上「刚才看到你在…」 */
function observesToday (n, now) {
  if (!ctx.wsDir) return []
  try {
    const start = new Date(Number(now) || Date.now())
    start.setHours(0, 0, 0, 0)
    const list = self.readEvents(ctx.wsDir)
      .filter((e) => e && e.kind === 'observe' && e.text && (Number(e.t) || 0) >= start.getTime())
    const k = Number(n)
    return (k > 0 ? list.slice(-k) : list)
  } catch { return [] }
}

/** 她回复了主人的消息（不是主动开口，不算期待回应） */
function noteReply (text) { ev('reply', text) }

/** 主人说话。
 *  0.36.0：这里只做**快判**（词表，同步、零延迟）。判不准的交给 judgeUser 异步补，
 *  因为「等一下再判」和「等判完再行动」是两件事——后者会让对话卡住。
 *  @returns {{hit:boolean, kind:string, weight:number, why:string}} 本次词表判定（给 judgeUser 比对用） */
function noteUser (text) {
  const raw = String(text || '')
  // 幂等：主对话壳（assistant.handleSend → onUserSpoke）和伴侣面板（handleMessage）
  // 是两个入口，同一句话可能都过一遍。不挡的话一句话会累加两次负反馈。
  const t = Date.now()
  if (lastNote.text === raw && t - lastNote.at < 2000) return lastNote.rb
  lastNote = { text: raw, at: t, rb: { hit: false, kind: '', weight: 0, why: '' } }

  ev('user', text)
  if (!ctx.wsDir) return lastNote.rb
  // 「真的说了话」的时间戳：被无视的判定只认这个，触摸不算（0.35.0）
  self.patchState(ctx.wsDir, { lastTalkAt: Date.now() })
  // 0.35.0 整体负反馈：先看这句是不是在**评价她**（批评 / 噤声 / 失望 / 纠正）。
  // 关键分叉：被批评时不能再走 noteAttention 那条「安抚」路径——那会把 quiet 削下去、
  // 把 ignoreStreak 清零，等于挨了骂反而精神起来。10-29 的 bug 就在这里。
  let rb = { hit: false, kind: '', weight: 0, why: '' }
  try { rb = rebuke.detect(text) } catch { }
  lastNote.rb = rb // 记下来，供 judgeUser 判断「这一笔是不是已经加过了」
  if (rb.hit) {
    self.patchState(ctx.wsDir, { lastUserAt: Date.now() })
    if (feedbackOn()) {
      self.noteDispleasure(ctx.wsDir, rb.weight)
      log('整体负反馈 +' + rb.weight.toFixed(2) + '（' + rb.why + '）：' + String(text).slice(0, 40))
    }
    return rb
  }
  if (feedbackOn()) {
    self.noteAttention(ctx.wsDir, 'talk')
    self.sootheDispleasure(ctx.wsDir) // 好好聊一次，之前那点不愉快松一点
  } else {
    self.patchState(ctx.wsDir, { lastUserAt: Date.now() }) // 关了负反馈也要更新「最后互动时间」
  }
  return rb
}

/* ------------------------------------------------------- 语义精判（0.36.0） */

let interpreter = null

function getInterpreter () {
  if (interpreter) return interpreter
  interpreter = understand.createInterpreter({
    cfgGet: () => ctx.llmCfg || {},
    log: (m) => log(m)
  })
  return interpreter
}

/** 换一个判读器（测试注入 / 以后改用本地小模型只判读时用） */
function setJudge (inst) { interpreter = inst || null }

/**
 * 对刚说的话做一次语义精判，然后**只做修正**（不动常规流程）。
 *
 * 为什么必须异步且不阻塞：判读要过一次模型，几百毫秒到两秒。
 * 她在等的是这句话的回复，不是判读结果。判读只影响「要不要主动开口」这类慢变量，
 * 晚一秒应用完全没关系；反过来，如果为了判读让回复慢一秒，用户立刻能感觉到。
 *
 * @param {string} text 主人原话
 * @param {{presence?:object, context?:Array}} opts presence 实例 + 最近几条对话
 * @returns {Promise<object|null>} 判定；拿不到就是 null（调用方什么都不用做）
 */
async function judgeUser (text, opts = {}) {
  if (!ctx.wsDir) return null
  // 开关（0.36.0）：判读要多发一次很小的请求，用户有权关掉；关掉就只走词表
  if (typeof ctx.judgeOn === 'function') {
    try { if (!ctx.judgeOn()) return null } catch { }
  }
  const j = await getInterpreter().interpret(text, opts.context)
  if (!j) return null

  const presence = opts.presence || null
  const same = lastNote.text === String(text || '') && Date.now() - lastNote.at < 30000

  // ── 在场：词表漏了的补上，词表看错的撤掉 ──
  if (presence) {
    try {
      const cur = presence.get()
      if (j.back === 2) {
        presence.declareBack('他说回来了')
      } else if (j.leave >= 2) {
        presence.declareAway('他在说要走/已走')
      } else if (j.leave === 1) {
        // 「先忙了」「手机快没电了先这样」——是走的意思，但也可能是「我看完这集再说」。
        // 软离开：先按 away 处理（拦碎碎念和黏人），等人真的一段时间没动键鼠才算数。
        presence.declareAway('他说要走（暗示）', { soft: true })
      } else if (cur.declaredAway && cur.since && Date.now() - cur.since < 20000) {
        // 词表刚判了「走」，但意思根本不是（「我出门前问你的那个」）→ 撤销。
        // 限 20 秒内：久了可能是别的原因导致离开，不能一并撤。
        presence.declareBack('不是要走')
      }
    } catch (e) { log('判读应用到在场状态失败：' + ((e && e.message) || e)) }
  }

  // ── 负反馈：补差额，或退掉误加的那一笔 ──
  if (!feedbackOn()) return j
  try {
    const w = j.tone === 'none' ? 0 : j.weight
    const already = same ? (Number(lastNote.rb && lastNote.rb.weight) || 0) : 0
    if (w > already + 0.02) {
      self.noteDispleasure(ctx.wsDir, w - already)
      log('整体负反馈（判读）+' + (w - already).toFixed(2) + '｜' + j.tone + '：' + String(text).slice(0, 40))
    } else if (w <= 0 && already > 0) {
      // 词表看错了（「你别跟它吵」「这歌别吵了」不是在说她）→ 把加过的退回去
      self.relieveDispleasure(ctx.wsDir, already)
      log('撤销负反馈（判读：不是在说她）：' + String(text).slice(0, 40))
    }
    // 注：词表没认出、走了 noteAttention 那条「安抚」路径的，这里只补负反馈，
    // 不回滚那 0.12 的 quiet —— 量小，回滚代码的复杂度不值这个精度。
  } catch (e) { log('判读应用到负反馈失败：' + ((e && e.message) || e)) }

  return j
}

/** 主人碰她：pet / poke / invade / grab / drop / throw / crash */
function noteTouch (action, part) {
  ev('touch', '', { action: String(action || ''), part: String(part || '') })
  if (!ctx.wsDir) return
  if (feedbackOn()) self.noteAttention(ctx.wsDir, String(action || ''))
  else self.patchState(ctx.wsDir, { lastUserAt: Date.now() })
}

/** 触摸烦躁档位（0.24.0）：'' | 'mid' | 'high' —— 触摸合并注入时加提示用 */
function annoyedLevel () {
  if (!ctx.wsDir) return ''
  try {
    const a = self.effAnnoyed(self.getState(ctx.wsDir))
    return a >= 0.6 ? 'high' : (a >= 0.35 ? 'mid' : '')
  } catch { return '' }
}

/** 她自己做了一件事（自由时间/自主行为） */
function noteSelf (desc) { ev('self', desc) }

/**
 * 想开口但忍住了（负反馈让她把话收着）。
 * 这条特别有用：日记里「我今天想跟他说句话，想了想还是没说」比任何参数都像活人。
 */
function noteSuppress (text) { ev('suppress', text) }

/** 0.46.50 最近咽回去的念头（suppress 事件，最新的在最后）。
 *  两个消费口：① 日记时间线（timelineOf 已带「我本来想说但没说」）；
 *  ② 嘀咕素材（chatter.decide 注入，让她可以把憋着的念头换个说法漏出来）。
 *  注意：不算「说过的话」——绝不进 recentVoices 镜子，否则她会跟自己的
 *  念头撞车、漏出来的每一句又被吞回去。 */
function suppressRecent (n, sinceMs) {
  if (!ctx.wsDir) return []
  try {
    const since = Number(sinceMs) > 0 ? Date.now() - Number(sinceMs) : 0
    const list = self.readEvents(ctx.wsDir)
      .filter((e) => e && e.kind === 'suppress' && e.text)
      .filter((e) => !since || (Number(e.t) || 0) >= since)
    const k = Number(n)
    return (k > 0 ? list.slice(-k) : list).map((e) => String(e.text).replace(/\s+/g, ' ').slice(0, 60))
  } catch { return [] }
}

/**
 * 她主动说完一句话后调用：等 ANSWER_WINDOW 看有没有回应。
 * 没有 → 记一次「被无视」。定时器在 startDaily 里统一扫。
 */
const pendingSays = []

/** 待判定发言落盘（0.35.0）：原来只存内存，程序一重启，「她说了没人应」就全丢了 */
function pendingFile () {
  return ctx.wsDir ? path.join(self.selfDir(ctx.wsDir), 'pending-says.json') : ''
}

function loadPending () {
  const f = pendingFile()
  if (!f) return
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!Array.isArray(raw)) return
    const now = Date.now()
    // 只捞 24 小时内的：更早的不该再拿来回味
    const fresh = raw.filter((x) => x && Number(x.at) > 0 && now - Number(x.at) < 24 * 3600 * 1000)
    pendingSays.length = 0
    for (const x of fresh.slice(-20)) pendingSays.push({ at: Number(x.at), text: String(x.text || '').slice(0, 60) })
  } catch { }
}

function savePending () {
  const f = pendingFile()
  if (!f) return
  try { fs.writeFileSync(f, JSON.stringify(pendingSays.slice(-20)), 'utf8') } catch { }
}

function noteSayTimeout (text) {
  pendingSays.push({ at: Date.now(), text: String(text || '').slice(0, 60) })
  if (pendingSays.length > 20) pendingSays.splice(0, pendingSays.length - 20)
  savePending()
}

/** 0.46.33 冷落判定窗口：主人配置 coldShoulderMin 分钟（默认 3，夹 1~30），coldShoulderOn=false 整个关掉 */
function snubWindowMs () {
  let c = {}
  try { c = (typeof ctx.cfgGet === 'function' && ctx.cfgGet()) || {} } catch { }
  if (c.coldShoulderOn === false) return 0
  const m = Number(c.coldShoulderMin)
  return (Number.isFinite(m) && m > 0 ? Math.min(30, Math.max(1, m)) : 3) * 60 * 1000
}

/**
 * 清算「她说过但没人接」的话（sweepSays，定时器驱动）。
 * 0.46.33 重写判定：原来一刀切 10 分钟+只看 lastTalkAt，三个场景全是冤案——
 * ① 主人根本不在电脑前（人都不在，没人回天经地义）② 游戏/学习模式（他自己说了豁免）
 * ③ 主人在电脑前却盯着屏幕不理她（这才是真·冷落，要记账+她当场会嘀咕一句）。
 * @param {number} [nowMs] 测试可注入当前时间
 */
function sweepSays (nowMs) {
  if (!ctx.wsDir || !pendingSays.length) return
  const win = snubWindowMs()
  const now = Number(nowMs) || Date.now()
  const st = self.getState(ctx.wsDir)
  const lastTalkAt = Number(st.lastTalkAt) || Number(st.lastUserAt) || 0
  // 人在不在电脑前：键鼠空闲 < 5 分钟 = 在（idle=0 是刚动过鼠标，更是在）
  let idle = -1
  try { idle = (typeof ctx.idleSec === 'function' && Number(ctx.idleSec())) || 0 } catch { }
  const atScreen = idle >= 0 && idle < 300
  let exempt = false
  try { exempt = typeof ctx.exempt === 'function' ? !!ctx.exempt() : false } catch { }
  const keep = []
  for (const p of pendingSays) {
    if (win > 0 && now - p.at < win) { keep.push(p); continue }
    if (lastTalkAt > p.at) continue // 有真实的回应
    if (win <= 0 || !feedbackOn() || exempt || !atScreen) {
      log('（不记冷落' + (win <= 0 ? '：开关关了' : exempt ? '：游戏/学习中' : '：他不在电脑前') + '）' + p.text)
      continue
    }
    const st2 = self.noteSnub(ctx.wsDir, now)
    const streak = Number(st2 && st2.snubStreak) || 1
    log('被晾了（第 ' + streak + ' 次，他人在电脑前没接话）：' + p.text)
    if (streak <= 2 && typeof ctx.onSnubbed === 'function') {
      try { ctx.onSnubbed(p.text, streak) } catch (e) { log('冷落嘀咕失败: ' + (e && e.message)) }
    }
  }
  pendingSays.length = 0
  for (const p of keep) pendingSays.push(p)
  savePending()
}

/**
 * 日终结算（0.21.0 补上调用点）：结算「昨天」的回应率。
 * 之前 settleDay 写好却没人调，负反馈只有「即时累加」没有「自然回落」。
 */
function settleYesterday () {
  if (!ctx.wsDir) return null
  const y = self.dateStr(new Date(Date.now() - 24 * 3600 * 1000))
  if (!self.readEvents(ctx.wsDir, y).length) return null
  const st = self.getState(ctx.wsDir)
  if (st.lastDay === y) return null
  if (!feedbackOn()) { self.patchState(ctx.wsDir, { lastDay: y }); return null }
  try {
    const next = self.settleDay(ctx.wsDir, y)
    log('结算昨天：quiet=' + next.quiet.toFixed(2) + ' cold=' + next.cold.toFixed(2) + ' streak=' + next.ignoreStreak)
    return next
  } catch (e) {
    log('结算昨天失败：' + (e && e.message))
    return null
  }
}

/* ------------------------------------------------------------ 自述 */

/** 把当天事件压成给模型看的时间线（控 token，也去掉无关噪音） */
function timelineOf (wsDir, date) {
  const evs = self.readEvents(wsDir, date)
  if (!evs.length) return ''
  const lines = []
  let touchBuf = []
  const flushTouch = () => {
    if (!touchBuf.length) return
    const counts = {}
    for (const a of touchBuf) counts[a] = (counts[a] || 0) + 1
    const label = { pet: '摸头', poke: '戳', drop: '拎起放下', throw: '扔出去' }
    lines.push('- ' + Object.entries(counts).map(([k, v]) => (label[k] || k) + (v > 1 ? '×' + v : '')).join('、'))
    touchBuf = []
  }
  for (const e of evs) {
    const t = new Date(Number(e.t) || 0)
    const hm = pad2(t.getHours()) + ':' + pad2(t.getMinutes())
    const text = String(e.text || '').replace(/\s+/g, ' ').slice(0, 120)
    if (e.kind === 'touch') { touchBuf.push((e.meta && e.meta.action) || 'touch'); continue }
    flushTouch()
    if (e.kind === 'user') lines.push('- ' + hm + ' 他说：' + text)
    else if (e.kind === 'reply') lines.push('- ' + hm + ' 我回：' + text)
    else if (e.kind === 'say') lines.push('- ' + hm + ' 我主动说：' + text)
    else if (e.kind === 'narration') lines.push('- ' + hm + ' 我随口念：' + text)
    else if (e.kind === 'observe') lines.push('- ' + hm + ' 我瞥见他在：' + text)
    else if (e.kind === 'self') lines.push('- ' + hm + ' 我：' + text)
    else if (e.kind === 'suppress') lines.push('- ' + hm + ' 我本来想说但没说：' + text)
    if (lines.length >= 60) break
  }
  flushTouch()
  return lines.join('\n')
}

function pad2 (n) { return n < 10 ? '0' + n : '' + n }

const DAY_PROMPT = [
  '你在写自己的日记，不是给别人看的报告。用第一人称。',
  '规则：',
  '1. 200~400 字，纯文本，不要标题、不要列表、不要「今天总结」这种腔调。',
  '2. 必须有一件具体的事（不是「聊了聊」这种），写清发生了什么。',
  '3. 必须有你自己当时的判断或情绪——哪怕很小心眼、很没道理也算，那才像你。',
  '4. 必须有一句你对他的观察，可以带点看法，不用全是好话。',
  '5. 保持你自己的说话习惯和语气。不知道的事不要编，没发生的事不要写。',
  '6. 不要写日期、时间或「某月某日，晚上」这类开头（文件名已经有日期了），直接从事情写起。',
  '7. 只输出日记正文。',
  '8. 正文写完后另起一行，写「[摘要] 」再跟一句 25 字以内的中文，说明今天最要紧的一件事或你自己的一点变化。这句是给他看的，用中文写。'
].join('\n')

/**
 * 生成某一天的日记。失败返回 { ok:false }，不抛。
 * 当天已有旧版时允许覆盖（白天写过，晚上又发生了新事要重写）。
 */
async function writeDayDiary (date) {
  if (!ready() || writing) return { ok: false, error: 'not-ready' }
  const day = date || self.dateStr()
  const line = timelineOf(ctx.wsDir, day)
  if (!line) return { ok: false, error: 'no-events' }
  writing = true
  try {
    const sys = (ctx.persona ? '你叫' + (ctx.personaName || '你自己') + '。你的人设：\n' + ctx.persona + '\n\n' : '') + DAY_PROMPT
    const res = await llm.chatStream({
      baseUrl: ctx.llmCfg.baseUrl,
      apiKey: ctx.llmCfg.apiKey,
      model: ctx.llmCfg.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: '这是我今天的经历（' + day + '）：\n' + line + '\n\n写今天的日记。' }
      ],
      temperature: 0.85
    })
    const raw = String(res.content || '').trim()
    if (!raw) return { ok: false, error: 'empty' }
    const { body, summary } = self.splitDiary(raw)
    if (!body) return { ok: false, error: 'empty' }
    self.writeDay(ctx.wsDir, day, body)
    self.appendGrowth(ctx.wsDir, '第 ' + dayCount(ctx.wsDir) + ' 天：' + (summary || '写了一篇日记'))
    // 0.21.0 日记索引：给这天留一行（日期 + 摘要 + 关键词 + 回应统计），
    // 以后问起「上周三」能靠它找回那天，而不用把上百篇日记全塞进上下文
    try {
      const st = self.dayStats(ctx.wsDir, day)
      self.upsertIndex(ctx.wsDir, {
        date: day,
        summary: summary || body.slice(0, 40),
        tags: self.pickTags(body + ' ' + line, 6),
        says: st.says,
        ignored: st.ignored
      })
    } catch { }
    log('日记已写 ' + day + '（' + body.length + ' 字）' + (summary ? ' 摘要：' + summary : ''))
    return { ok: true, date: day, text: body, summary }
  } catch (err) {
    log('日记生成失败：' + (err && err.message))
    return { ok: false, error: err && err.message }
  } finally {
    writing = false
  }
}

/** 从已有日记算「第几天」（写完当天日记后调用，所以直接数文件，不加 1） */
function dayCount (wsDir) {
  let names = []
  try { names = fs.readdirSync(path.join(wsDir, 'self', 'days')) } catch { return 1 }
  const n = names.filter((x) => /\.md$/.test(x)).length
  return Math.max(1, n)
}

/* ------------------------------------------------------------ 每周归纳 */

const DISTILL_PROMPT = [
  '下面是她最近几天的日记。你要做的事只有一件：找出**日记里真实出现过**的、属于她自己的东西。',
  '不要总结她的性格（人设里已经写好了），不要写「她是一个开朗的人」这种判断，也不要重复设定里的词。',
  '只找设定之外、从经历里长出来的东西：她反复做的事、她自己形成的偏好。',
  '输出格式，每行一条，最多 3 条习惯 + 2 条好恶：',
  '[习惯] 不超过 20 字的描述',
  '[喜欢] 什么东西｜因为什么',
  '[不喜欢] 什么东西｜因为什么',
  '一条都没有就只输出 [无]。不要输出其它任何内容，不要解释。'
].join('\n')

/** 解析归纳结果在 self.js（纯函数，可直接单测） */

function daysBetween (a, b) {
  const t1 = new Date(String(a) + 'T00:00:00').getTime()
  const t2 = new Date(String(b) + 'T00:00:00').getTime()
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 999
  return Math.round(Math.abs(t2 - t1) / 86400000)
}

/**
 * 每周一次：把日记里的重复模式沉淀成「她自己的习惯和好恶」。
 * 强度规则：这次又提到 +0.25；30 天没出现 -0.1；低于 0.2 丢掉（人不记得的东西就不算她的一部分）。
 */
async function distill () {
  if (!ready()) return { ok: false, error: 'not-ready' }
  const days = self.recentDays(ctx.wsDir, 7)
  if (days.length < 3) return { ok: false, error: 'not-enough-days' }
  const corpus = days.map((d) => '【' + d.date + '】\n' + d.text).join('\n\n')
  try {
    const res = await llm.chatStream({
      baseUrl: ctx.llmCfg.baseUrl,
      apiKey: ctx.llmCfg.apiKey,
      model: ctx.llmCfg.model,
      messages: [
        { role: 'system', content: DISTILL_PROMPT },
        { role: 'user', content: corpus }
      ],
      temperature: 0.4
    })
    const parsed = self.parseDistill(res.content)
    const today = self.dateStr()

    // 第 1 期：归纳产出一律进审查队列（唯一收口，批准才落地）。
    // 宿主没注入 hook（自我层未就绪/测试环境）时走旧直写兜底。
    if (typeof ctx.enqueueReview === 'function') {
      const entries = []
      for (const desc of parsed.habits) entries.push({ kind: 'habit', what: desc, payload: desc, reason: '日记归纳' })
      for (const t of parsed.tastes) entries.push({ kind: 'taste', what: t.what, payload: t.what + (t.why ? '｜' + t.why : ''), reason: '日记归纳' })
      const r = ctx.enqueueReview(entries)
      if (parsed.habits.length || parsed.tastes.length) {
        self.appendGrowth(ctx.wsDir, '第 ' + dayCount(ctx.wsDir) + ' 天：归纳出 ' +
          (parsed.habits.length + parsed.tastes.length) + ' 条，等主人过目')
      }
      log('归纳完成：入审查队列 ' + ((r && r.added) || 0) + ' 条（重复 ' + ((r && r.dup) || 0) + '）')
      self.patchState(ctx.wsDir, { lastDistill: today })
      return { ok: true, queued: true, added: (r && r.added) || 0 }
    }

    const habits = self.getHabits(ctx.wsDir)
    for (const desc of parsed.habits) {
      const hit = habits.find((h) => h.desc === desc)
      if (hit) {
        hit.strength = Math.min(1, (Number(hit.strength) || 0) + 0.25)
        hit.last = today
      } else {
        habits.push({ desc, first: today, last: today, strength: 0.4 })
      }
    }
    for (const h of habits) {
      const gap = daysBetween(h.last || h.first || today, today)
      if (gap >= 30) h.strength = Math.max(0, (Number(h.strength) || 0) - 0.1)
    }
    const keptHabits = habits.filter((h) => (Number(h.strength) || 0) >= 0.2)
    // 0.21.0 遗忘归档：掉出阈值的习惯不是「没发生过」，写进年表再丢——人被磨掉的东西也会留下痕迹
    const dropped = habits.filter((h) => !keptHabits.includes(h))
    for (const h of dropped) {
      self.appendGrowth(ctx.wsDir, '第 ' + dayCount(ctx.wsDir) + ' 天：已经不太会「' + String(h.desc || '').slice(0, 30) + '」了')
    }

    const tastes = self.getTastes(ctx.wsDir)
    for (const t of parsed.tastes) {
      const hit = tastes.find((x) => x.what === t.what)
      if (hit) { hit.last = today } else { tastes.push(Object.assign({ since: today, last: today }, t)) }
    }

    self.saveHabits(ctx.wsDir, keptHabits)
    self.saveTastes(ctx.wsDir, tastes.slice(-20))
    if (parsed.habits.length || parsed.tastes.length) {
      self.appendGrowth(ctx.wsDir, '第 ' + dayCount(ctx.wsDir) + ' 天：自己归纳出 ' +
        (parsed.habits.length + parsed.tastes.length) + ' 条（' + parsed.habits.concat(parsed.tastes.map((x) => x.what)).join('、') + '）')
    }
    log('归纳完成：习惯 ' + parsed.habits.length + ' 条，好恶 ' + parsed.tastes.length + ' 条')
    return { ok: true, habits: parsed.habits, tastes: parsed.tastes }
  } catch (err) {
    log('归纳失败：' + (err && err.message))
    return { ok: false, error: err && err.message }
  }
}

/* ------------------------------------------------------------ 调度 */

/**
 * 写日记的时机（每天最多一次定稿，允许覆盖）：
 *   - 当天最后一次事件已过 30 分钟，且现在 >= 18:00
 *   - 或者已经过了 23:40
 * 启动时补写昨天（如果昨天有事件却没日记）。
 */
function dueForDiary (now) {
  if (!ctx.wsDir) return null
  const today = self.dateStr(now)
  const evs = self.readEvents(ctx.wsDir, today)
  if (!evs.length) return null
  const last = Number(evs[evs.length - 1].t) || 0
  const hour = new Date(now).getHours()
  const idleLongEnough = now - last >= 30 * 60 * 1000 && hour >= 18
  const lateNight = hour >= 23 && new Date(now).getMinutes() >= 40
  if (!idleLongEnough && !lateNight) return null
  // 已经写过，且之后没有新事件 → 不重写
  if (self.hasDay(ctx.wsDir, today)) {
    const st = self.getState(ctx.wsDir)
    if (Number(st.dayWrittenCount) === evs.length) return null
  }
  self.patchState(ctx.wsDir, { dayWrittenCount: evs.length })
  return today
}

/** 启动时补昨天：昨天有事件但没日记 */
async function backfillYesterday () {
  if (!ready()) return
  const y = new Date(Date.now() - 24 * 3600 * 1000)
  const date = self.dateStr(y)
  if (self.hasDay(ctx.wsDir, date)) return
  if (!self.readEvents(ctx.wsDir, date).length) return
  await writeDayDiary(date)
}

/** 每周归纳：攒够 3 篇日记、且距上次满 7 天才跑 */
async function sweepDistill () {
  if (!ready() || distilling) return
  const st = self.getState(ctx.wsDir)
  const gap = st.lastDistill ? daysBetween(st.lastDistill, self.dateStr()) : 99
  if (gap < 7) return
  if (self.recentDays(ctx.wsDir, 7).length < 3) return
  distilling = true
  try {
    await distill()
    self.patchState(ctx.wsDir, { lastDistill: self.dateStr() })
  } catch { } finally { distilling = false }
}

function startDaily () {
  stopDaily()
  backfillYesterday().catch(() => { })
  settleYesterday()
  writeTimer = setInterval(() => {
    try {
      sweepSays()
      settleYesterday()
      const d = dueForDiary(Date.now())
      if (d) writeDayDiary(d).catch(() => { })
      sweepDistill().catch(() => { })
    } catch { }
  }, 5 * 60 * 1000)
  try { writeTimer.unref && writeTimer.unref() } catch { }
  // 0.46.33 冷落感知独立心跳：默认窗口 3 分钟，5 分钟的结算心跳太粗（人回来回话了也可能先被判死）。
  // 45 秒查一次 pending 队列，窗口到点立刻判定。
  snubTimer = setInterval(() => { try { sweepSays() } catch { } }, 45 * 1000)
  try { snubTimer.unref && snubTimer.unref() } catch { }
}

function stopDaily () {
  if (writeTimer) { clearInterval(writeTimer); writeTimer = null }
  if (snubTimer) { clearInterval(snubTimer); snubTimer = null }
}

/* ------------------------------------------------------------ 对外 */

module.exports = {
  setContext,
  startDaily,
  stopDaily,
  writeDayDiary,
  backfillYesterday,
  distill,
  sweepDistill,
  parseDistill: self.parseDistill,
  splitDiary: self.splitDiary,
  timelineOf,
  dayCount,
  noteSay,
  noteSayTimeout,
  noteNarration,
  recentVoices,
  noteReply,
  noteUser,
  /** 0.36.0 语义精判：异步，只做修正，失败返回 null（绝不抛、绝不阻塞） */
  judgeUser,
  setJudge,
  /** 判读器运行状况（设置页/日志排查用） */
  judgeStatus: () => { try { return getInterpreter().status() } catch { return null } },
  noteTouch,
  annoyedLevel,
  /** 0.35.0 整体负反馈：0~0.9，越高越该收着（按小时自然消退后的有效值） */
  displeasure: () => (ctx.wsDir ? self.effDispleasure(self.getState(ctx.wsDir)) : 0),
  noteSelf,
  noteSuppress,
  suppressRecent,
  noteObserve,
  observesToday,
  lastVoiceAt,
  sweepSays,
  settleYesterday,
  snubWindowMs,
  /** opts.query 决定注入摘要还是正文（问过去时给正文），见 self.promptBlock */
  promptBlock: (opts) => (ctx.wsDir ? self.promptBlock(ctx.wsDir, opts) : ''),
  /** 指定工作区（systemPrompt 里按 char.id 现算，防切角色时串到上一个人） */
  promptBlockFor: (wsDir, opts) => (wsDir ? self.promptBlock(wsDir, opts) : ''),
  state: () => (ctx.wsDir ? self.getState(ctx.wsDir) : self.getState('')),
  stats: (date) => (ctx.wsDir ? self.dayStats(ctx.wsDir, date) : null),
  /* 0.21.0：负反馈可回滚（测试期） */
  feedbackOn,
  setFeedback: (mode) => { ctx.feedback = mode === 'off' ? 'off' : 'on'; return ctx.feedback },
  resetFeedback: () => (ctx.wsDir ? self.resetState(ctx.wsDir) : { ok: false, error: 'no-workspace' }),
  rollbackFeedback: (msAgo) => (ctx.wsDir ? self.rollbackState(ctx.wsDir, msAgo) : { ok: false, error: 'no-workspace' }),
  searchDays: (query, k) => (ctx.wsDir ? self.searchDays(ctx.wsDir, query, k || 3) : []),
  /** 0.37.0 她自己待着：今天（本地日）她自己做过的事，最新的在最后。
   *  n <= 0 表示要全部（每日上限的计算必须拿到全部，截断会让上限形同虚设）。 */
  selfLog: (n) => {
    if (!ctx.wsDir) return []
    try {
      const list = self.readEvents(ctx.wsDir).filter((e) => e && e.kind === 'self' && e.text)
      const k = Number(n)
      if (!(k > 0)) return list
      return list.slice(-k)
    } catch { return [] }
  },
  /** 设置页「自我层」面板：一次拿全（状态 / 今日统计 / 快照数 / 日记天数） */
  overview: () => {
    if (!ctx.wsDir) return null
    const st = self.getState(ctx.wsDir)
    const today = self.dayStats(ctx.wsDir)
    const hist = self.stateHistory(ctx.wsDir, 3)
    return {
      feedback: ctx.feedback,
      workspace: ctx.wsDir,
      state: st,
      today,
      lastSnapshots: hist,
      days: self.countDays(ctx.wsDir),
      indexed: self.readIndex(ctx.wsDir, 1000).length
    }
  }
}
