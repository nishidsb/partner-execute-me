'use strict'
/**
 * AI 伴侣 · 她自己待着（curiosity，0.37.0）
 *
 * 为什么要有它：到 0.36.0 为止，她所有的主动行为都是**被逼出来的**——
 * 黏人模式（你不理她）、碎碎念（随机到点）、做梦（睡前）、陪看（你开了刷 B 站）。
 * 没有一条是「她自己想干点什么」。她像一个只在被按到时才有反应的东西。
 * 设计动机（来自真实使用反馈）：希望她不只是被按到才反应，也能
 * 自己找点感兴趣的事做。」
 *
 * 她真的能动的东西只有这些：读屏幕上的字（0.34.0 的 OCR 白板）、知道自己
 * 前台在跑什么程序、能翻自己的日记/喜好/记过的事。所以「玩」只能是**看与想**，
 * 不是替用户点鼠标——替用户动手是 CUA 的活，那是命令，不是消遣。
 *
 * 一条链：到点 → 看四周（前台程序 + 屏幕上的字 + 自己的旧事）
 *        → 挑一件感兴趣的 → 做一件小事 → 记进事件流（她会记得）
 *        → 有机会就顺口说出来（不朗读、不期待回应）
 *
 * 硬约束（防骚扰比功能重要）：
 *   · 只在他在场（presence=here）时做；他不在，做给他看没意义
 *   · 他正在说话 / 刚说完 3 分钟内不做
 *   · 情绪差（displeasure≥0.6）或太安静（quiet≥0.65）不做——心情不好的人不玩
 *   · 每天最多 MAX_PER_DAY 件；两件之间 MIN_GAP~MAX_GAP 随机
 *   · 说出来的概率 SAY_CHANCE：做事本身是给自己做的，不是找个由头找他说话
 */
const llm = require('./llm')

const MIN_GAP = 20 * 60 * 1000
const MAX_GAP = 60 * 60 * 1000
const MAX_PER_DAY = 8
const SAY_CHANCE = 0.35
const TALK_COOLDOWN = 3 * 60 * 1000
const DISPLEASURE_GATE = 0.6
const QUIET_GATE = 0.65
const TICK_MS = 5 * 60 * 1000

/** 这些标题/进程不算「他在用什么」，看一眼没意义 */
const BORING_TITLE = /^(program manager|microsoft text input application|桌面|$)/i
const BORING_PROC = /^(ryza\b.*|world\.execute.*|partner\.execute.*|explorer|startmenuexperiencehost|shellexperiencehost|searchhost|searchapp|textinputhost|applicationframehost|lockapp|sihost|dwm)$/i

const LINES = [
  '现在是你的自由时间。没有人跟你说话，你也不用找谁说话——你只是自己呆着，想干点什么。',
  '下面是你此刻能知道的东西（只有这些，别编造别的）：',
  '【要求】',
  '1. 从上面挑一件你真的感兴趣的、能自己做的事。你能做的只有：凑近看、读、翻自己记过的东西、想想、比对一下、记一笔。你不能替主人操作电脑，也不该打扰他。',
  '2. 做完之后，写两行，格式严格照下面：',
  '   做：<你做了什么，20 字以内，要具体（例：凑过去看他在写的那些字，只认得出括号）>',
  '   想：<这件事让你心里冒出来的一句话，30 字以内，可以没头没尾、可以只有半句>',
  '3. 「做」是动作，「想」是念头，不要写成一个意思；不要问问题；不要提醒他做事；不要总结这一天；不要写旁白或括号说明。',
  '4. 如果此刻周围什么都没有（他不在用电脑、屏幕也没字），就做你本来就会做的事：翻自己的日记、想一件旧事、发一会儿呆。这也算。',
  '5. 只输出这两行，不要多余的话。'
].join('\n')

/* ------------------------------------------------------------ 纯函数（可单测） */

/** 日期键：本地时区的 YYYY-M-D（与 self.js 的日记分日一致） */
function dateKey (now) {
  const d = new Date(Number(now) || Date.now())
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

/** 这个前台窗口值不值得看一眼 */
function worthWatching (fg) {
  if (!fg || typeof fg !== 'object') return false
  const proc = String(fg.name || '').trim()
  const title = String(fg.title || '').trim()
  if (title && BORING_TITLE.test(title)) return false
  if (proc && BORING_PROC.test(proc)) return false
  return !!(title || (proc && !BORING_PROC.test(proc)))
}

/** 「现在几点」用她的口气说出来（她不是时钟，只用来判断「这个点该干嘛」） */
function dayPart (now) {
  const h = new Date(Number(now) || Date.now()).getHours()
  if (h < 5) return '深夜'
  if (h < 9) return '清早'
  if (h < 12) return '上午'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '深夜'
}

/**
 * 现在该不该自己找事做。
 * @returns {{ok:boolean, why:string, wait?<number>}}
 */
function shouldAct (o) {
  const i = o || {}
  const now = Number(i.now) || Date.now()
  if (i.on === false) return { ok: false, why: 'off' }
  if (i.presence && i.presence !== 'here') return { ok: false, why: 'away' }
  if (i.busy) return { ok: false, why: 'busy' }
  if (Number(i.displeasure) >= DISPLEASURE_GATE) return { ok: false, why: 'displeased' }
  if (Number(i.quiet) >= QUIET_GATE) return { ok: false, why: 'quiet' }
  const talkedAt = Number(i.talkedAt) || 0
  if (talkedAt && now - talkedAt < TALK_COOLDOWN) return { ok: false, why: 'talking' }
  if (Number(i.countToday) >= MAX_PER_DAY) return { ok: false, why: 'daily-limit' }
  const gap = Number(i.gap) > 0 ? Number(i.gap) : MIN_GAP
  const lastAt = Number(i.lastAt) || 0
  if (lastAt && now - lastAt < gap) return { ok: false, why: 'wait', wait: gap - (now - lastAt) }
  return { ok: true, why: 'act' }
}

/** 下一件的间隔（随机，落盘不进，重启重新掷） */
function nextGap (rand) {
  const r = typeof rand === 'function' ? rand() : Math.random()
  return Math.round(MIN_GAP + r * (MAX_GAP - MIN_GAP))
}

/** 把素材拼成提示词。素材缺什么都照样能跑——她本来也会自己发呆 */
function buildPrompt (m) {
  const mat = m || {}
  const parts = []
  parts.push('【时间】' + dayPart(mat.now) + '，你一个人在这儿。')
  if (mat.fg && worthWatching(mat.fg)) {
    const t = String(mat.fg.title || '').trim().slice(0, 80)
    const p = String(mat.fg.name || '').trim().slice(0, 40)
    parts.push('【他此刻前台开着】' + (p ? p + '：' : '') + (t || '（一个没标题的窗口）'))
  } else {
    parts.push('【他此刻前台开着】没有能看的（不在电脑前 / 只是桌面 / 只是我自己的窗口）')
  }
  const sub = String(mat.subtitle || '').trim().slice(0, 600)
  if (sub) parts.push('【你刚才从屏幕上读到的字】\n' + sub)
  const mem = String(mat.memory || '').trim().slice(0, 900)
  if (mem) parts.push('【你自己记得的东西】\n' + mem)
  const did = Array.isArray(mat.didToday) ? mat.didToday.filter(Boolean).slice(-4) : []
  if (did.length) parts.push('【今天你自己已经做过的事（别重复，可以接着往下想）】\n' + did.map((x) => '- ' + String(x).slice(0, 60)).join('\n'))
  parts.push('\n' + LINES)
  return {
    system: String(mat.persona || '').slice(0, 900),
    user: parts.join('\n'),
    langRule: mat.langRule || '用你平时说话的语言。'
  }
}

function cleanLine (s, max) {
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[「『“”"'【\s]+|[」』“”"'】\s]+$/g, '')
    .trim()
    .slice(0, max)
}

/** 解析模型输出：宽容一点，格式崩了也要拿到「做」那一句 */
function parse (out) {
  const s = String(out || '').trim()
  if (!s) return null
  const act = (s.match(/^\s*做\s*[：:]\s*(.+)$/m) || [])[1] || ''
  const thought = (s.match(/^\s*想\s*[：:]\s*(.+)$/m) || [])[1] || ''
  if (!act && !thought) {
    const first = s.split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
    const a = cleanLine(first, 60)
    return a ? { act: a, thought: '' } : null
  }
  const a = cleanLine(act, 60)
  const t = cleanLine(thought, 80)
  if (!a && !t) return null
  return { act: a || t, thought: t }
}

/* ------------------------------------------------------------ 运行时 */

function createCuriosity (deps) {
  const d = deps || {}
  const log = d.log || (() => { })
  const cfgGet = d.cfgGet || (() => ({}))
  const presence = d.presence || (() => 'here')
  const displeasure = d.displeasure || (() => 0)
  const quiet = d.quiet || (() => 0)
  const busy = d.busy || (() => false)
  const talkedAt = d.talkedAt || (() => 0)
  const stats = d.stats || (() => ({ countToday: 0, lastAt: 0 }))
  const collect = d.collect || (async () => ({}))
  const note = d.note || (() => { })
  const say = d.say || (async () => { })
  const rand = d.rand || Math.random
  const askOverride = typeof d.ask === 'function' ? d.ask : null // 测试注入用
  // 0.42.0：她「做事」的节拍是这条通道自己的（20~60 分钟一件），
  // 但「说出来」要经过全局节奏器——不然三路各自开口，听起来还是各说各的
  const rhythm = d.rhythm || null
  // 0.45.12 经历默认沉淀：她每做一件小事，宿主可以挂提炼回调（事件流只管「发生」，这里管「记住」）
  const onAct = typeof d.onAct === 'function' ? d.onAct : null

  let timer = null
  let stopped = true
  let running = false
  let gap = nextGap(rand)
  let last = { at: 0, act: '', thought: '', spoke: false, skip: '' }

  function status () {
    let st = {}
    try { st = stats() || {} } catch { }
    return {
      running: !stopped,
      todayCount: Number(st.countToday) || 0,
      maxPerDay: MAX_PER_DAY,
      lastAt: Number(st.lastAt) || 0,
      last: last,
      nextGapMin: Math.round(gap / 60000)
    }
  }

  async function ask (mat) {
    const c = cfgGet() || {}
    if (!c.apiBaseUrl || !c.apiModel) return null
    const p = buildPrompt(Object.assign({}, mat, { now: Date.now() }))
    try {
      const res = await llm.chatStream({
        baseUrl: c.apiBaseUrl,
        apiKey: c.apiKey,
        model: c.apiModel,
        messages: [
          { role: 'system', content: p.system },
          { role: 'user', content: p.user + '\n\n语言：' + p.langRule }
        ],
        temperature: 0.95
      })
      return parse(res && res.content)
    } catch (err) {
      log('[curiosity] 生成失败：' + (err && err.message))
      return null
    }
  }

  async function once () {
    if (running) return { ok: false, why: 'running' }
    running = true
    try {
      const st = stats() || {}
      const gate = shouldAct({
        on: (cfgGet() || {}).curiosityOn !== false,
        now: Date.now(),
        presence: presence(),
        displeasure: displeasure(),
        quiet: quiet(),
        busy: busy(),
        talkedAt: talkedAt(),
        countToday: st.countToday,
        lastAt: st.lastAt,
        gap: gap
      })
      if (!gate.ok) { last = Object.assign({}, last, { skip: gate.why }); return gate }
      let mat = {}
      try { mat = (await collect()) || {} } catch (e) { log('[curiosity] 素材失败：' + (e && e.message)) }
      const r = await (askOverride || ask)(mat)
      if (!r || !r.act) { last = Object.assign({}, last, { skip: 'empty' }); return { ok: false, why: 'empty' } }
      const desc = r.thought ? (r.act + '（' + r.thought + '）') : r.act
      try { note(desc) } catch { }
      let spoke = false
      if (r.thought && rand() < SAY_CHANCE) {
        let may = true
        if (rhythm) { try { may = rhythm.ask('talk').ok } catch { may = true } }
        if (may) {
          try { await say(r.thought); spoke = true } catch { }
          if (spoke && rhythm) { try { rhythm.note('talk') } catch { } }
        }
      }
      last = { at: Date.now(), act: r.act, thought: r.thought, spoke: spoke, skip: '' }
      gap = nextGap(rand)
      if (onAct) { try { onAct(desc) } catch { } }
      log('[curiosity] 她自己做了一件：' + r.act + (spoke ? '（说出来了）' : ''))
      return { ok: true, act: r.act, thought: r.thought, spoke: spoke }
    } finally {
      running = false
    }
  }

  function start () {
    if (!stopped) return
    stopped = false
    gap = nextGap(rand)
    const loop = async () => {
      if (stopped) return
      try { await once() } catch (e) { log('[curiosity] tick 异常：' + (e && e.message)) }
      if (stopped) return
      // 每 5 分钟看一次「到点没」；到点与否由 shouldAct 的 gap 判，不用精确对齐
      timer = setTimeout(loop, TICK_MS)
      if (timer.unref) timer.unref()
    }
    timer = setTimeout(loop, 60 * 1000) // 开机先等 1 分钟，别跟启动抢资源
    if (timer.unref) timer.unref()
    log('[curiosity] 已启动（她自己待着，每天最多 ' + MAX_PER_DAY + ' 件）')
  }

  function stop () {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
  }

  return { start, stop, once, status }
}

module.exports = {
  MIN_GAP, MAX_GAP, MAX_PER_DAY, SAY_CHANCE, TICK_MS, LINES,
  dateKey, worthWatching, dayPart, shouldAct, nextGap, buildPrompt, parse,
  createCuriosity
}
