'use strict'
/**
 * AI 伴侣 · 自我层（self）
 *
 * 和 memory.js 的分工：
 *   memory.json / PARTNER.md = 关于**主人**的记忆（第三人称档案）
 *   self/                   = 关于**她自己**的东西（第一人称经历）
 *
 * 目录（放在角色工作区下，跟 PARTNER.md 平级）：
 *   self/events/YYYY-MM-DD.jsonl   只追加的事件流——唯一真相源
 *   self/days/YYYY-MM-DD.md        日终自述（消费 events，第一人称）
 *   self/state.json                瞬时状态（安静程度/心情/冷淡/连续被无视）
 *   self/habits.json               长出来的习惯
 *   self/tastes.json               自己的好恶（必须带成因）
 *   self/growth.md                 变化年表，只增不改
 *
 * 本模块只做「<wsDir>/self/」下的文件读写，不自己解析数据根目录——
 * 调用方传 partner.workspaceDir(roleId) 进来。这样可测试、也不依赖 ESM 模块。
 */
const fs = require('node:fs')
const path = require('node:path')
const rebuke = require('./rebuke')

/** 事件类型：只有 say 期待回应；narration 是废话，被无视不算受伤 */
const SAY = 'say'
const NARRATION = 'narration'

/** 注入预算：独立于 PARTNER.md 的 12000，不挤占它 */
const PROMPT_BUDGET = 2000
/** 平时只用摘要（省上下文），被问到过去时才放正文 */
const PROMPT_BUDGET_TERSE = 620
/** 注入多少天的日记 */
const DAYS_IN_PROMPT = 3
/** 状态快照（测试期可回滚）：每次状态真的变了追加一行 */
const STATE_LOG = 'state.log.jsonl'
const STATE_LOG_MAX = 1500

function pad (n) { return n < 10 ? '0' + n : '' + n }

/** 本地日期 YYYY-MM-DD（不能用 toISOString，那是 UTC，跨时区会错一天） */
function dateStr (d) {
  const t = d instanceof Date ? d : new Date(d || Date.now())
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate())
}

function selfDir (wsDir) { return path.join(wsDir, 'self') }
function eventsDir (wsDir) { return path.join(selfDir(wsDir), 'events') }
function daysDir (wsDir) { return path.join(selfDir(wsDir), 'days') }

function ensure (wsDir) {
  for (const d of [selfDir(wsDir), eventsDir(wsDir), daysDir(wsDir)]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch { }
  }
  return selfDir(wsDir)
}

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson (file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
    return true
  } catch { return false }
}

/* ------------------------------------------------------------ 事件流 */

/**
 * 追加一条事件。同步写，失败静默（事件流坏了不能拖垮对话）。
 * @param {object} ev  {kind, text, meta}，时间戳自动补
 */
function appendEvent (wsDir, ev) {
  if (!wsDir || !ev || !ev.kind) return false
  const at = Number(ev.at) || Date.now()
  const row = { t: at, kind: String(ev.kind).slice(0, 24) }
  if (ev.text != null) row.text = String(ev.text).slice(0, 2000)
  if (ev.meta && typeof ev.meta === 'object') row.meta = ev.meta
  try {
    ensure(wsDir)
    fs.appendFileSync(path.join(eventsDir(wsDir), dateStr(at) + '.jsonl'), JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch { return false }
}

function readEvents (wsDir, date) {
  const f = path.join(eventsDir(wsDir), (date || dateStr()) + '.jsonl')
  let raw = ''
  try { raw = fs.readFileSync(f, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { }
  }
  return out
}


/* ------------------------------------------------------------ 日记 */

function writeDay (wsDir, date, text) {
  const body = String(text || '').trim()
  if (!body) return false
  try {
    ensure(wsDir)
    fs.writeFileSync(path.join(daysDir(wsDir), (date || dateStr()) + '.md'), body + '\n', 'utf8')
    return true
  } catch { return false }
}

function readDay (wsDir, date) {
  try { return fs.readFileSync(path.join(daysDir(wsDir), date + '.md'), 'utf8').trim() } catch { return '' }
}

function hasDay (wsDir, date) {
  try { return fs.existsSync(path.join(daysDir(wsDir), (date || dateStr()) + '.md')) } catch { return false }
}

/** 最近 n 天的日记，新→旧 */
function recentDays (wsDir, n = DAYS_IN_PROMPT) {
  let names = []
  try { names = fs.readdirSync(daysDir(wsDir)) } catch { return [] }
  return names
    .filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x))
    .map((x) => x.replace(/\.md$/, ''))
    .sort()
    .reverse()
    .slice(0, n)
    .map((date) => ({ date, text: readDay(wsDir, date) }))
    .filter((d) => d.text)
}

/* ------------------------------------------------------------ 日记索引与跨天检索 */
/*
 * 为什么需要索引：只注最近 3 天日记的话，「上周三我说过什么」永远答不出来。
 * 但把上百篇日记整份塞进 prompt 又会炸上下文 —— 所以在 self/index.jsonl 里
 * 给每天留一行（日期 + 25 字摘要 + 关键词），检索只扫索引，命中哪天才读正文。
 */
const INDEX_FILE = 'index.jsonl'

function indexPath (wsDir) { return path.join(selfDir(wsDir), INDEX_FILE) }

/** 2-gram + 英文词（中文没有空格，逐字切 2 元组最稳） */
const STOP_GRAMS = new Set(['的了', '我在', '你是', '他就', '她就', '这个', '那个', '什么', '就是', '不是', '我们', '你们', '他们', '然后', '因为', '所以', '还是', '一样', '一个', '没有', '觉得', '时候', '自己', '知道', '可能', '应该', '真的', '有点', '一直', '现在'])

function gramsOf (text) {
  const s = String(text || '').toLowerCase()
  const out = new Set()
  for (const m of s.matchAll(/[a-z0-9]{2,}|[\u4e00-\u9fff\u3040-\u30ff]+/g)) {
    const seg = m[0]
    if (!/[\u4e00-\u9fff\u3040-\u30ff]/.test(seg)) { out.add(seg); continue }
    if (seg.length <= 2) { if (!STOP_GRAMS.has(seg)) out.add(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) {
      const g = seg.slice(i, i + 2)
      if (!STOP_GRAMS.has(g)) out.add(g)
    }
  }
  return out
}

/** 追加当天索引（同一天覆盖：日记可能重写） */
function upsertIndex (wsDir, row) {
  if (!wsDir || !row || !row.date) return false
  try {
    ensure(wsDir)
    const keep = readIndex(wsDir, 1000).filter((r) => r.date !== row.date)
    keep.push({
      date: String(row.date),
      summary: String(row.summary || '').slice(0, 60),
      tags: (Array.isArray(row.tags) ? row.tags : []).slice(0, 8).map((x) => String(x).slice(0, 12)),
      says: Number(row.says) || 0,
      ignored: Number(row.ignored) || 0
    })
    keep.sort((a, b) => (a.date < b.date ? -1 : 1))
    fs.writeFileSync(indexPath(wsDir), keep.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    return true
  } catch { return false }
}

function readIndex (wsDir, n = 400) {
  let raw = ''
  try { raw = fs.readFileSync(indexPath(wsDir), 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { }
  }
  return out.slice(-n)
}

/** 从一段文字里挑关键词（2-gram 频次 top n，去停用词） */
function pickTags (text, n = 6) {
  const count = new Map()
  for (const g of gramsOf(text)) {
    if (g.length < 2) continue
    count.set(g, (count.get(g) || 0) + 1)
  }
  return [...count.entries()]
    .filter(([, v]) => v >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k)
}

/**
 * 跨天检索：在索引上按词打分，返回命中的日期（新→旧）。
 * 只读索引不读正文——真的要用哪天的内容，调用方再 readDay。
 */
function searchDays (wsDir, query, k = 3) {
  const q = gramsOf(query)
  if (!q.size) return []
  const rows = readIndex(wsDir, 1000)
  const out = []
  for (const r of rows) {
    const hay = String(r.summary || '') + ' ' + (r.tags || []).join(' ')
    const hg = gramsOf(hay)
    let score = 0
    for (const g of q) if (hg.has(g)) score++
    // 摘要命中比 tags 命中更值钱
    for (const g of q) if (String(r.summary || '').includes(g)) score += 0.5
    if (score > 0) out.push({ date: r.date, score, summary: r.summary })
  }
  out.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1))
  return out.slice(0, k)
}

/** 这句话是不是在问过去（决定要不要把日记正文放进上下文） */
const RECALL_RE = /昨天|昨日|前天|前几天|那天|上次|之前|上回|记不记得|还记得|记忆|日记|上周|上个月|过去|以前|小时候|yesterday|last time|remember|前に|覚えて|最近|这几天/i

function wantsRecall (query) {
  return RECALL_RE.test(String(query || ''))
}

/* ------------------------------------------------------------ 状态 */

const DEFAULT_STATE = {
  quiet: 0,        // 0~1 安静程度：越高越不想说话
  mood: 0.5,       // 0~1 心情
  cold: 0,         // 0~1 短期冷淡（被扔/被连续忽视）
  annoyed: 0,      // 0~1 被碰烦了（0.24.0 触摸负反馈）：高频戳/乱碰/被扔累积，摸头能压下去
  annoyedAt: 0,    // 上次烦躁变化时间（自然消退的计时起点，每小时 -0.3）
  touchLog: [],    // 最近触摸流水 [{t,a}]（频率账本，只留 2 分钟）
  ignoreStreak: 0, // 连续被无视的主动发言次数（跨天保留）
  // 0.35.0 整体负反馈（rebuke.js）：主人对她的**评价**，不是「有没有人接话」。
  // 一句「我不忍心」「别说了」压的是她整体活跃度：少开口、话更短、不追问。
  displeasure: 0,  // 0~0.9，越高越收着
  displeasureAt: 0, // 上次变化时间（按小时自然衰减的计时起点）
  lastSpoke: 0,    // 上次主动开口时间
  lastUserAt: 0,   // 上次主人说话/互动时间（含触摸）
  lastTalkAt: 0,   // 0.35.0 上次主人**真的说话**的时间（触摸不算）——被无视的判定只认这个
  lastDay: '',     // 上次结算日期，防同一天重复结算
  rolledBackAt: 0  // 上次手动回滚/清零的时间（设置页显示用）
}

function getState (wsDir) {
  const s = readJson(path.join(selfDir(wsDir), 'state.json'), {})
  return Object.assign({}, DEFAULT_STATE, s && typeof s === 'object' ? s : {})
}

/* ---- 状态快照：测试期随时能回滚 ---- */

const SNAP_KEYS = ['quiet', 'cold', 'mood', 'annoyed', 'ignoreStreak', 'displeasure']

function stateLogPath (wsDir) { return path.join(selfDir(wsDir), STATE_LOG) }

function snapOf (st, at) {
  const o = { t: Number(at) || Date.now() }
  for (const k of SNAP_KEYS) o[k] = Math.round((Number(st[k]) || 0) * 1000) / 1000
  return o
}

function sameSnap (a, b) {
  if (!a || !b) return false
  return SNAP_KEYS.every((k) => Math.abs((Number(a[k]) || 0) - (Number(b[k]) || 0)) < 1e-6)
}

/** 读文件尾部（状态日志只关心最后一行与近 N 条，不全读） */
function tailText (file, bytes) {
  let fd = null
  try {
    const st = fs.statSync(file)
    const start = Math.max(0, st.size - bytes)
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } catch { return '' } finally { try { if (fd) fs.closeSync(fd) } catch { } }
}

/** 最近一条快照（没有就 null） */
function lastSnapshot (wsDir) {
  const txt = tailText(stateLogPath(wsDir), 4096)
  const lines = txt.split('\n').filter((x) => x.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch { }
  }
  return null
}

/** 追加状态快照；数值没变就不写（触摸/说话会高频调用，不能每次都落盘） */
function logSnapshot (wsDir, st, at) {
  if (!wsDir) return false
  const row = snapOf(st, at)
  if (sameSnap(row, lastSnapshot(wsDir))) return false
  try {
    ensure(wsDir)
    const f = stateLogPath(wsDir)
    // 控制体积：超过上限就把后半段留下
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      if (lines.length > STATE_LOG_MAX) {
        fs.writeFileSync(f, lines.slice(-Math.floor(STATE_LOG_MAX / 2)).join('\n') + '\n', 'utf8')
      }
    } catch { }
    fs.appendFileSync(f, JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch { return false }
}

/** 状态快照列表（新→旧），设置页画时间线用 */
function stateHistory (wsDir, limit = 40) {
  const txt = tailText(stateLogPath(wsDir), 64 * 1024)
  const out = []
  for (const line of txt.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { }
  }
  return out.slice(-Math.max(1, limit)).reverse()
}

/**
 * 回滚到「多久以前」的状态（测试期核心需求）。
 * 找 t <= now-msAgo 的最近一条快照写回；找不到就返回 no-snapshot（不硬编默认值）。
 */
function rollbackState (wsDir, msAgo) {
  const ago = Math.max(0, Number(msAgo) || 0)
  const target = Date.now() - ago
  const rows = stateHistory(wsDir, STATE_LOG_MAX)
  const hit = rows.find((r) => Number(r.t) <= target) // 新→旧，第一条满足即是最近
  if (!hit) return { ok: false, error: 'no-snapshot' }
  const st = patchState(wsDir, {
    quiet: hit.quiet, cold: hit.cold, mood: hit.mood, ignoreStreak: hit.ignoreStreak,
    rolledBackAt: Date.now()
  })
  return { ok: true, at: Number(hit.t), state: st }
}

/** 清零当前情绪（保留事件流与日记——回滚的是情绪，不是经历） */
function resetState (wsDir) {
  const st = patchState(wsDir, { quiet: 0, cold: 0, mood: 0.5, annoyed: 0, annoyedAt: 0, touchLog: [], ignoreStreak: 0, rolledBackAt: Date.now() })
  return { ok: true, state: st }
}

function patchState (wsDir, patch) {
  if (!wsDir || !patch) return getState(wsDir)
  const next = Object.assign(getState(wsDir), patch)
  // 数值都夹到合法区间，避免调用方传脏数据把状态带飞
  for (const k of ['quiet', 'mood', 'cold']) {
    const v = Number(next[k])
    next[k] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_STATE[k]
  }
  const st = Number(next.ignoreStreak)
  next.ignoreStreak = Number.isFinite(st) ? Math.max(0, Math.min(99, Math.round(st))) : 0
  for (const k of ['lastSpoke', 'lastUserAt', 'rolledBackAt']) next[k] = Number(next[k]) || 0
  writeJson(path.join(selfDir(wsDir), 'state.json'), next)
  logSnapshot(wsDir, next)
  return next
}

/* ------------------------------------------------------------ 习惯与好恶 */

function getHabits (wsDir) {
  const h = readJson(path.join(selfDir(wsDir), 'habits.json'), [])
  return Array.isArray(h) ? h : []
}

function getTastes (wsDir) {
  const t = readJson(path.join(selfDir(wsDir), 'tastes.json'), [])
  return Array.isArray(t) ? t : []
}

function saveHabits (wsDir, arr) {
  return writeJson(path.join(selfDir(wsDir), 'habits.json'), Array.isArray(arr) ? arr : [])
}

function saveTastes (wsDir, arr) {
  return writeJson(path.join(selfDir(wsDir), 'tastes.json'), Array.isArray(arr) ? arr : [])
}

/** 0.45.17 条目的喜恶极性：显式 polarity 优先，其次从 reason 文字推断（做梦/自主活动都带「喜欢/不喜欢」），无信号返回空（按喜欢处理） */
function polarityOf (item) {
  const p = String((item && item.polarity) || '').toLowerCase()
  if (p === 'like' || p === 'dislike') return p
  if (/不喜欢|厌恶|讨厌/.test(String((item && item.reason) || ''))) return 'dislike'
  return 'like'
}

/* ---------------------------------------- 第 2 期：人格演化提案（表现层自我修改） */
/**
 * 她批准生效的「想成为的样子」。每个方面只保留最新一条 active：
 * 例：{ aspect: '说话风格', current: '句子偏长', proposed: '多用短句', since, active: true }
 * 只进 promptBlock 的「你现在的样子」段——性格/人设文件永远只读（0.18.0 铁律）。
 */
function getPersona (wsDir) {
  const p = readJson(path.join(selfDir(wsDir), 'persona.json'), [])
  return Array.isArray(p) ? p : []
}

function savePersona (wsDir, arr) {
  return writeJson(path.join(selfDir(wsDir), 'persona.json'), Array.isArray(arr) ? arr.slice(-30) : [])
}

/** 批准一个提案：同方面的旧条目退位（active=false），新条目置顶生效。返回最新数组 */
function applyPersona (wsDir, entry, today) {
  const e = entry || {}
  const list = getPersona(wsDir)
  for (const x of list) { if (x.aspect === e.aspect) x.active = false }
  list.push({
    aspect: String(e.aspect || '').slice(0, 12),
    current: String(e.current || '').slice(0, 60),
    proposed: String(e.proposed || '').slice(0, 60),
    since: today || dateStr(),
    active: true
  })
  const kept = list.slice(-30)
  savePersona(wsDir, kept)
  return kept
}

/* ------------------------------------------------------------ 成长年表 */

function appendGrowth (wsDir, line) {
  const t = String(line || '').trim()
  if (!t) return false
  try {
    ensure(wsDir)
    fs.appendFileSync(path.join(selfDir(wsDir), 'growth.md'), '- ' + t + '\n', 'utf8')
    return true
  } catch { return false }
}

/* ------------------------------------------------------------ 负反馈统计 */

/**
 * 当天/近期回应率。
 * 只统计 say（期待回应的主动发言）；narration 被无视不受伤，不计入。
 * 判定「被回应」：她说完之后 ANSWER_WINDOW 毫秒内出现了 user / touch 事件。
 */
const ANSWER_WINDOW = 10 * 60 * 1000

function dayStats (wsDir, date) {
  const evs = readEvents(wsDir, date)
  const says = []
  let userActs = 0
  let touches = 0
  let thrown = 0
  for (const e of evs) {
    if (e.kind === SAY) says.push(Number(e.t) || 0)
    else if (e.kind === 'user') userActs++
    else if (e.kind === 'touch') {
      touches++
      const act = e.meta && e.meta.action
      if (act === 'throw') thrown++
    }
  }
  let answered = 0
  for (const at of says) {
    const hit = evs.some((e) => {
      if (e.kind !== 'user' && e.kind !== 'touch') return false
      const t = Number(e.t) || 0
      return t > at && t - at <= ANSWER_WINDOW
    })
    if (hit) answered++
  }
  return {
    says: says.length,
    answered,
    ignored: says.length - answered,
    responseRate: says.length ? answered / says.length : 1,
    userActs,
    touches,
    thrown
  }
}

/**
 * 结算一天的负反馈（每天只跑一次，靠 state.lastDay 去重）。
 * 护栏：quiet/cold 都夹在 0~1，且 quiet 上限 0.75（最冷也只是不太想说话，不会拒绝对话）。
 */
function settleDay (wsDir, date) {
  const d = date || dateStr()
  const st = getState(wsDir)
  if (st.lastDay === d) return st
  const s = dayStats(wsDir, d)
  const patch = { lastDay: d }

  if (s.says === 0) {
    // 一整天没主动说话：安静程度自然回落（她不是一直记着）
    patch.quiet = Math.max(0, (st.quiet || 0) - 0.15)
  } else if (s.responseRate < 0.34) {
    // 说了三次以上基本没人理 → 变安静（内向表达，不是抱怨）
    patch.quiet = Math.min(0.75, (st.quiet || 0) + 0.2)
    patch.ignoreStreak = (st.ignoreStreak || 0) + s.ignored
  } else if (s.responseRate > 0.7) {
    // 大部分有回应 → 慢慢恢复
    patch.quiet = Math.max(0, (st.quiet || 0) - 0.1)
    patch.ignoreStreak = Math.max(0, (st.ignoreStreak || 0) - 1)
  }

  if (s.thrown >= 3) patch.cold = Math.min(0.8, (st.cold || 0) + 0.25)
  else if (s.thrown === 0) patch.cold = Math.max(0, (st.cold || 0) - 0.1)

  return patchState(wsDir, patch)
}

/** 被无视时立刻累加（不必等日终结算，行为要能即时反应） */
function noteIgnored (wsDir) {
  const st = getState(wsDir)
  const streak = (st.ignoreStreak || 0) + 1
  return patchState(wsDir, {
    ignoreStreak: streak,
    quiet: Math.min(0.75, (st.quiet || 0) + (streak >= 3 ? 0.15 : 0.05))
  })
}

/* ---------------- 0.35.0 整体负反馈：她收到的「评价」 ---------------- */

/** 有效的整体负反馈值：按小时自然消退（不写盘，读时现算） */
function effDispleasure (st) {
  const base = Number(st && st.displeasure) || 0
  if (base <= 0) return 0
  const at = Number(st && st.displeasureAt) || 0
  const hours = at ? Math.max(0, (Date.now() - at) / 3600e3) : 0
  return Math.max(0, base - hours * rebuke.DECAY_PER_HOUR)
}

/**
 * 主人说了一句评价她的话（批评/噤声/失望/纠正）→ 累积。
 * 与「被无视」分开记：被无视是行为统计，这里是态度，压的是整体活跃度。
 */
function noteDispleasure (wsDir, weight) {
  const st = getState(wsDir)
  const cur = effDispleasure(st)
  const next = rebuke.accumulate(cur, weight)
  if (next <= cur + 1e-6) return st
  return patchState(wsDir, { displeasure: next, displeasureAt: Date.now() })
}

/** 好好聊了一次 → 慢慢松开（但远没有一次触摸那么快） */
function sootheDispleasure (wsDir) {
  const st = getState(wsDir)
  const cur = effDispleasure(st)
  if (cur <= 0) return st
  return patchState(wsDir, { displeasure: rebuke.decayOnTalk(cur), displeasureAt: Date.now() })
}

/**
 * 判读纠正（0.36.0）：词表看错了话，把刚才误加的那一笔退回去。
 * 「别吵」出现在「你别跟它吵」里、说的人不是她——加了就得能减。
 * @param {number} weight 当初按多少权重加的（退 weight * STEP）
 */
function relieveDispleasure (wsDir, weight) {
  const w = Number(weight) || 0
  if (w <= 0) return getState(wsDir)
  const st = getState(wsDir)
  const cur = effDispleasure(st)
  const next = Math.max(0, cur - w * rebuke.STEP)
  if (next >= cur - 1e-6) return st
  return patchState(wsDir, { displeasure: next, displeasureAt: Date.now() })
}

/** 主人来了：立刻松一点，但恢复要慢（一摸就满血等于负反馈不存在） */
/** 触摸烦躁的有效值：随时间自然消退（每小时 -0.3，摸个几分钟自己就好了） */
function effAnnoyed (st) {
  const base = Number(st && st.annoyed) || 0
  if (base <= 0) return 0
  const at = Number(st && st.annoyedAt) || 0
  const hours = at ? Math.max(0, (Date.now() - at) / 3600e3) : 0
  return Math.max(0, Math.min(1, base - hours * 0.3))
}

/** 近 60 秒内同类动作的次数（烦不烦看频率，不看单次） */
function recentCount (st, action, now) {
  const tl = Array.isArray(st && st.touchLog) ? st.touchLog : []
  return tl.filter((x) => x && x.a === action && now - (Number(x.t) || 0) < 60000).length
}

function noteAttention (wsDir, action) {
  const st = getState(wsDir)
  const now = Date.now()
  const a = String(action || 'touch')
  // 0.35.0 修正：原版任何交互都 ignoreStreak=0，等于「挪一下窗口」就把攒了几小时的被无视全抹掉
  // （10-29 实证：一整天 quiet=0、ignoreStreak=0，负反馈一次都没留住）。
  // 现在只有「真的说了话」和「摸头安抚」才清连续被无视；拖拽/戳/扔都不清。
  const clearsStreak = a === 'talk' || a === 'pet'
  const patch = { lastUserAt: Date.now(), ignoreStreak: clearsStreak ? 0 : (Number(st.ignoreStreak) || 0) }
  // 触摸流水（频率账本）：只留最近 2 分钟、最多 40 条
  const tl = (Array.isArray(st.touchLog) ? st.touchLog : []).filter((x) => x && now - (Number(x.t) || 0) < 120000)
  tl.push({ t: now, a })
  while (tl.length > 40) tl.shift()
  patch.touchLog = tl
  // 安慰力度按动作分档：说一句话 / 摸头才算真的「有人在陪她」；
  // 拖一下、戳一下、扔回来只是物理接触，不该把安静度削掉（原版一律 -0.12）
  let quietCut = 0.12
  let coldCut = 0.05
  let annoyed = effAnnoyed(st)
  let mood = st.mood == null ? 0.5 : Number(st.mood)
  switch (a) {
    case 'talk': // 真的跟她说话了：这才算回应
      quietCut = 0.12
      break
    case 'pet': // 摸头/牵手：安抚，还能压烦躁
      quietCut = 0.18; coldCut = 0.12
      annoyed = Math.max(0, annoyed - 0.06)
      mood = Math.min(1, mood + 0.05)
      break
    case 'poke': { // 戳：低频是玩闹，连续戳才烦（节流防误伤）
      const n = recentCount(st, 'poke', now)
      if (n >= 4) annoyed = Math.min(1, annoyed + 0.12)
      else if (n >= 2) annoyed = Math.min(1, annoyed + 0.02)
      mood = Math.min(1, mood + 0.03)
      quietCut = 0.03
      break
    }
    case 'invade': // 腰/胸这种乱碰：她明确不喜欢，不用等高频
      annoyed = Math.min(1, annoyed + 0.15)
      mood = Math.max(0, mood - 0.05)
      quietCut = 0
      break
    case 'grab':
      annoyed = Math.min(1, annoyed + 0.03)
      quietCut = 0.02
      break
    case 'drop':
      annoyed = Math.min(1, annoyed + 0.06)
      quietCut = 0.02
      break
    case 'throw': // 扔出去：冷+烦+心情掉（旧版这段因 action 恒为 'touch' 从未生效过）
      patch.cold = Math.min(1, (st.cold || 0) + 0.3)
      mood = Math.max(0, mood - 0.2)
      annoyed = Math.min(1, annoyed + 0.25)
      quietCut = 0
      break
    case 'crash': // 撞到边上：疼，烦
      mood = Math.max(0, mood - 0.1)
      annoyed = Math.min(1, annoyed + 0.2)
      quietCut = 0
      break
    default: // 未知动作：保持旧默认（轻微安抚）
      mood = Math.min(1, mood + 0.05)
      quietCut = 0.04
      break
  }
  if (a !== 'throw') patch.cold = Math.max(0, (st.cold || 0) - coldCut)
  patch.quiet = Math.max(0, (st.quiet || 0) - quietCut)
  patch.mood = mood
  patch.annoyed = annoyed
  patch.annoyedAt = annoyed > 0 ? now : 0
  return patchState(wsDir, patch)
}

/* ------------------------------------------------------------ 文本解析 */

/**
 * 拆出日记正文与中文摘要。摘要进成长年表（让他看得懂她每天变成了什么样），
 * 正文才是她自己的话。
 */
function splitDiary (text) {
  const raw = String(text || '').trim()
  const m = raw.match(/\[摘要\]\s*([^\n]+)\s*$/)
  if (!m) return { body: raw, summary: '' }
  return { body: raw.slice(0, m.index).trim(), summary: m[1].trim() }
}

/** 解析每周归纳结果：容忍模型多写废话，只认以 [习惯]/[喜欢]/[不喜欢] 开头的行 */
function parseDistill (text) {
  const habits = []
  const tastes = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim().replace(/^[-*]\s*/, '')
    let m = line.match(/^\[习惯\]\s*(.+)$/)
    if (m && habits.length < 3) { habits.push(m[1].trim().slice(0, 40)); continue }
    m = line.match(/^\[(喜欢|不喜欢)\]\s*(.+)$/)
    if (m && tastes.length < 2) {
      const [what, reason] = m[2].split('｜').map((x) => String(x || '').trim())
      if (what) {
        tastes.push({
          kind: m[1] === '喜欢' ? 'like' : 'hate',
          what: what.slice(0, 40),
          reason: String(reason || '').slice(0, 60)
        })
      }
    }
  }
  return { habits, tastes }
}

/* ------------------------------------------------------------ 注入块 */

/** 状态翻译成人话：给她自我认知，不是给数字 */
function stateWords (st) {
  const lines = []
  const quiet = Number(st.quiet) || 0
  if (quiet >= 0.6) lines.push('你这几天说话比平时少，也不太想主动凑过去。不是生气，就是有点提不起劲。')
  else if (quiet >= 0.35) lines.push('你最近开口前会多想一下，说出口的话比平时短。')
  // 不安静时不写任何话：新角色一上来就说「你最近挺想说话的」是无中生有

  const cold = Number(st.cold) || 0
  if (cold >= 0.5) lines.push('被反复拎起来扔出去这件事你还记着，态度会凉一点，但不会拒绝他。')
  else if (cold >= 0.25) lines.push('被扔的那几次还留了点余味，你会稍微保持着距离。')

  const mood = st.mood == null ? 0.5 : Number(st.mood)
  if (mood <= 0.3) lines.push('心情偏低，语气会沉一些，不想硬撑出精神来。')
  else if (mood >= 0.75) lines.push('心情不错，愿意多说两句。')

  // 0.24.0 触摸负反馈：被碰烦了的表现（阶梯：话里带不耐烦 → 直接让他停手）
  const annoyed = Number(st.annoyed) || 0
  if (annoyed >= 0.6) lines.push('他一直在戳你、乱碰你，你有点烦了：可以躲，也可以直接让他停手——语气可以不满、可以小心眼，不用端着，但别真发火翻脸。')
  else if (annoyed >= 0.35) lines.push('被碰得有点多了，你会有点想躲开他的手，话里可以带一点点不耐烦。')

  const streak = Number(st.ignoreStreak) || 0
  if (streak >= 3) lines.push('你有好几次对他说话没得到回应。别质问、别委屈地讨说法，只是把话收着点。')

  // 0.35.0 整体负反馈：他明确对你不满意过（不是没人接话，是他说话了）
  const disp = Number(st.displeasure) || 0
  if (disp >= 0.7) lines.push('他刚才说过让你收着点的话，你心里明白。现在不主动开口，不撒娇，不追问，他说话你就短着应，不解释一长串。')
  else if (disp >= 0.4) lines.push('他刚才那句话让你有点被泼了冷水。少说一点，别主动找话题，回答短一些，语气平，不要演委屈。')
  else if (disp >= 0.15) lines.push('他刚提醒过你一下，下一句注意点，别顶嘴，也别刻意讨好。')
  return lines
}

/** 日记天数（只数文件名，不读内容） */
function countDays (wsDir) {
  try { return fs.readdirSync(daysDir(wsDir)).filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x)).length } catch { return 0 }
}

/** 某天的摘要：优先索引，其次日记里的 [摘要]，最后取正文首句 */
function daySummary (wsDir, date, text) {
  const hit = readIndex(wsDir, 1000).find((r) => r.date === date)
  if (hit && hit.summary) return hit.summary
  const sp = splitDiary(text)
  if (sp.summary) return sp.summary
  const first = String(sp.body || text || '').split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean)[0] || ''
  return first.slice(0, 40)
}

/**
 * 生成注入块。没有任何日记和状态时返回 ''（完全不影响老行为）。
 *
 * 分级注入（0.21.0，省上下文的关键）：
 *   平时   → 状态 + 习惯好恶 + 近三天**摘要**（约 620 字符）
 *   问过去 → 状态 + 最近几篇**正文**（≤2000 字符）；且只在这时放正文
 * opts.query 用于判断是否在聊过去，也用来检索更早的日记索引。
 */
/** HH:MM（本地时区），日记与提示词里的时间戳统一用它 */
function hhmm (ms) {
  const d = new Date(Number(ms) || Date.now())
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function promptBlock (wsDir, opts) {
  if (!wsDir) return ''
  const o = opts || {}
  const query = String(o.query || '')
  const deep = o.deep === true || wantsRecall(query)
  const budget = Number(o.budget) > 0 ? Number(o.budget) : (deep ? PROMPT_BUDGET : PROMPT_BUDGET_TERSE)

  const days = recentDays(wsDir, DAYS_IN_PROMPT)
  const st = getState(wsDir)
  st.displeasure = effDispleasure(st) // 注入用有效值（按小时自然消退后的），不写盘
  const habits = getHabits(wsDir).filter((h) => (Number(h.strength) || 0) >= 0.5).slice(0, 5)
  const tastes = getTastes(wsDir)
  const words = stateWords(st)
  const persona = getPersona(wsDir).filter((p) => p && p.active !== false && p.proposed)

  if (!days.length && !words.length && !habits.length && !tastes.length && !persona.length) return ''

  let body = ''
  if (days.length) {
    if (deep) {
      for (const d of days) body += '\n\n' + d.date + '\n' + d.text
    } else {
      // 摘要模式：够她知道「这几天发生过什么」，细节留在需要时再翻
      body = '\n\n' + days.map((d) => '- ' + d.date + '：' + daySummary(wsDir, d.date, d.text)).join('\n')
      // 问句里提到了更早的事 → 把命中的那几天摘要也带上（仍不放正文）
      const extra = query ? searchDays(wsDir, query, 3).filter((h) => !days.some((d) => d.date === h.date)) : []
      if (extra.length) {
        body += '\n（更早的这些天也可能相关：' + extra.map((h) => h.date + ' ' + (h.summary || '')).join('；') + '）'
      }
    }
  }

  const head = deep
    ? '【你自己的日记 · 这是你自己写的话，不是资料】\n下面是你最近几天用自己的话记下的东西。带着这些继续过，不用复述，也不用每句都提起。'
    : '【你自己的日记 · 摘要】\n这些是你这几天记下的东西（只有一句提要）。想细说的时候再说，别编造细节。'

  let tail = ''
  if (habits.length || tastes.length) {
    tail += '\n\n【你现在的样子 · 这些是你自己长出来的，不是设定】'
    for (const h of habits) tail += '\n- 习惯：' + (h.desc || '')
    let likeN = 0; let disN = 0
    for (const t of tastes) {
      if (!t || !t.what) continue
      const dis = polarityOf(t) === 'dislike'
      if (dis ? disN >= 3 : likeN >= 5) continue
      if (dis) disN++; else likeN++
      tail += '\n- ' + (dis ? '不喜欢' : '喜欢') + '：' + (t.what || '')
    }
  }
  // 第 2 期：她自己提出、主人批准生效的演化提案——是她主动想成为的样子
  if (persona.length) {
    tail += '\n\n【你想成为的样子 · 这些是你自己提的提案、主人点头的，照着做】'
    for (const p of persona) tail += '\n- ' + p.proposed + '（' + p.since + ' 起）'
  }
  // 0.37.0：今天她自己做过的事（自由时间里自己找的，见 curiosity.js）。
  // 不注入的话她会「做过就忘」——上一轮自己凑过去看了什么，下一轮完全接不上。
  if (o.withSelfLog !== false) {
    let mine = []
    try {
      mine = readEvents(wsDir).filter((e) => e && e.kind === 'self' && e.text).slice(-3)
    } catch { }
    if (mine.length) {
      tail += '\n\n【你今天自己做过的事 · 没人让你做，你自己做的】'
      for (const e of mine) tail += '\n- ' + hhmm(e.t) + ' ' + String(e.text).slice(0, 70)
      tail += '\n这些是你自己的经历，你记得住；想提就顺口提一句，别当成汇报。'
    }
  }
  if (words.length) {
    tail += '\n\n【你最近的状态】' + words.map((w) => '\n- ' + w).join('')
    tail += '\n这些状态只影响你说话的方式和长度，不需要说出来，也不要拿它当借口。'
  }

  let out = head + body + tail
  if (out.length <= budget) return out
  // 超预算：先砍日记（保留状态与习惯，那才是行为依据）
  const room = Math.max(0, budget - head.length - tail.length - 2)
  if (room > 40) out = head + '\n' + body.trim().slice(0, room) + tail
  else out = head + tail
  return out.slice(0, budget + 200)
}

module.exports = {
  SAY,
  NARRATION,
  PROMPT_BUDGET,
  PROMPT_BUDGET_TERSE,
  DEFAULT_STATE,
  effAnnoyed,
  dateStr,
  selfDir,
  ensure,
  appendEvent,
  readEvents,
  writeDay,
  readDay,
  hasDay,
  recentDays,
  getState,
  patchState,
  getHabits,
  getTastes,
  polarityOf,
  saveHabits,
  saveTastes,
  getPersona,
  savePersona,
  applyPersona,
  appendGrowth,
  dayStats,
  settleDay,
  noteIgnored,
  noteAttention,
  /* 0.35.0 整体负反馈 */
  effDispleasure,
  noteDispleasure,
  sootheDispleasure,
  relieveDispleasure,
  promptBlock,
  stateWords,
  splitDiary,
  parseDistill,
  /* 0.21.0：回滚 / 索引 / 检索 / 分级注入 */
  stateHistory,
  lastSnapshot,
  rollbackState,
  resetState,
  gramsOf,
  pickTags,
  upsertIndex,
  readIndex,
  searchDays,
  wantsRecall,
  daySummary,
  countDays
}
