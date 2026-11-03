'use strict'
/**
 * 主动消息的「时段 + 计划」（0.45.93）
 *
 * 用户 11-02 的需求（原话）：
 *   「主动发 qq 消息，需要有选项是谷价可发和全时段可发，这都需要有对应的功能不只是选项」
 *   「在我这边或者角色那边主动提起什么时候会主动给我发 qq 消息的时候也会发。这个不用在意谷价还是峰价」
 *
 * 拆成两件事，各自都能单测：
 *   ① 时段策略 windowOk()：mode='valley' 只在谷时窗口内发（可跨零点），mode='all' 全时段可发。
 *   ② 计划队列 addPlan()/duePlans()：她答应「十点给你发」就排一条，到点由主进程 tick 真发。
 *
 * 纯逻辑，不碰 IO（落盘在宿主 companion/index.js，方便 node:test 直接跑）。
 */

const DEFAULT_FROM = '23:00'
const DEFAULT_TO = '08:00'
const MAX_PLANS = 20
const MAX_AHEAD_MS = 30 * 24 * 3600 * 1000   // 最远排到 30 天后（防止模型瞎填年份）

/** '09:30' → 570；非法 → null */
function parseHHMM (s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null
  return h * 60 + mi
}

function fmtHHMM (mins) {
  const m = ((Math.round(Number(mins) || 0) % 1440) + 1440) % 1440
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
}

/** 读配置里的时段设置（im 配置是唯一真源），坏值一律退回默认 */
function windowOf (ic) {
  const c = ic || {}
  const mode = c.reachWindowMode === 'valley' ? 'valley' : 'all'   // 默认全时段：先把「能发」跑通，谷时是想省/想安静时的选项
  const from = parseHHMM(c.reachValleyFrom)
  const to = parseHHMM(c.reachValleyTo)
  return {
    mode,
    from: from == null ? parseHHMM(DEFAULT_FROM) : from,
    to: to == null ? parseHHMM(DEFAULT_TO) : to
  }
}

/** 当前时刻是否落在谷时窗口里（支持 23:00→08:00 这种跨零点；起止相同视为全天） */
function inValley (now, w) {
  const d = new Date(Number(now) || Date.now())
  const cur = d.getHours() * 60 + d.getMinutes()
  const from = w && Number.isFinite(w.from) ? w.from : parseHHMM(DEFAULT_FROM)
  const to = w && Number.isFinite(w.to) ? w.to : parseHHMM(DEFAULT_TO)
  if (from === to) return true
  if (from < to) return cur >= from && cur < to
  return cur >= from || cur < to          // 跨零点
}

/**
 * 现在能不能主动发（只看时段，节流交给 reach.shouldReach）
 * @returns {{ok:boolean, why:string, mode:string, window:string}}
 */
function windowOk (ic, now) {
  const w = windowOf(ic)
  if (w.mode === 'all') return { ok: true, why: '', mode: 'all', window: '全时段' }
  const label = fmtHHMM(w.from) + '–' + fmtHHMM(w.to)
  if (inValley(now, w)) return { ok: true, why: '', mode: 'valley', window: label }
  return { ok: false, why: 'outside-window', mode: 'valley', window: label }
}

/** 距下一次谷时开始还有多久（毫秒），全时段模式返回 0 —— 用来给她一句「几点再发」 */
function msUntilWindow (ic, now) {
  const t = Number(now) || Date.now()
  const w = windowOf(ic)
  if (w.mode === 'all' || inValley(t, w)) return 0
  const d = new Date(t)
  const cur = d.getHours() * 60 + d.getMinutes()
  const delta = (w.from - cur + 1440) % 1440
  return (delta || 1440) * 60000
}

function nextId (now) {
  return 'p' + String(Number(now) || Date.now()).slice(-9) + Math.random().toString(36).slice(2, 5)
}

/**
 * 排一条计划
 * @param {Array} list 现有计划
 * @param {object} o { at: ms|string, text?, note?, source?: 'her'|'user', ignoreWindow?: bool }
 * @param {number} now
 * @returns {{ok:boolean, error?:string, list:Array, plan?:object}}
 */
function addPlan (list, o, now) {
  const t = Number(now) || Date.now()
  const arr = Array.isArray(list) ? list.slice() : []
  if (arr.length >= MAX_PLANS) return { ok: false, error: '计划太多了（最多 ' + MAX_PLANS + ' 条），先删几条', list: arr }
  const src = o && o.at
  const at = typeof src === 'number' ? src : Number(new Date(String(src || '')))
  if (!Number.isFinite(at)) return { ok: false, error: 'at 时间看不懂，用 ISO 或时间戳', list: arr }
  if (at < t + 5000) return { ok: false, error: '这个时间已经过去了', list: arr }
  if (at > t + MAX_AHEAD_MS) return { ok: false, error: '最多排到 30 天后', list: arr }
  const text = String((o && o.text) || '').trim().slice(0, 500)
  const note = String((o && o.note) || '').trim().slice(0, 200)
  if (!text && !note) return { ok: false, error: '要么给 text（原话），要么给 note（到点让她自己想说啥）', list: arr }
  const plan = {
    id: nextId(t),
    at,
    text,
    note,
    source: (o && o.source) === 'user' ? 'user' : 'her',
    // 用户明确要求：谈起「什么时候给我发」当场发 → 这条到点也不吃时段限制
    ignoreWindow: !!(o && o.ignoreWindow),
    createdAt: t
  }
  arr.push(plan)
  arr.sort((a, b) => a.at - b.at)
  return { ok: true, list: arr, plan }
}

/** 到点的挑出来（保持顺序），并顺手丢掉超期 2 小时还没发成功的（避免重启后被旧账砸一脸） */
function duePlans (list, now) {
  const t = Number(now) || Date.now()
  const arr = Array.isArray(list) ? list : []
  const due = []
  const rest = []
  for (const p of arr) {
    if (!p || !Number.isFinite(Number(p.at))) continue
    const at = Number(p.at)
    if (at > t) { rest.push(p); continue }
    if (t - at > 2 * 3600 * 1000) continue      // 过期太久：丢掉，别再补发
    due.push(p)
  }
  return { due, rest }
}

/** 她能拿来自查的人类可读描述 */
function describe (p, now) {
  const t = Number(now) || Date.now()
  const d = new Date(Number(p.at))
  const today = new Date(t); today.setHours(0, 0, 0, 0)
  const day0 = new Date(d); day0.setHours(0, 0, 0, 0)
  const diff = Math.round((day0 - today) / 86400000)
  const dayLabel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : (d.getMonth() + 1) + '月' + d.getDate() + '日'
  return dayLabel + ' ' + fmtHHMM(d.getHours() * 60 + d.getMinutes())
}

module.exports = {
  DEFAULT_FROM,
  DEFAULT_TO,
  MAX_PLANS,
  parseHHMM,
  fmtHHMM,
  windowOf,
  inValley,
  windowOk,
  msUntilWindow,
  addPlan,
  duePlans,
  describe
}
