'use strict'
/**
 * 学习账本（0.45.69）
 *
 * 真实使用反馈：学习模式里发生过的事都要进记忆、退出后不能什么都不记得，
 * 这是底层逻辑。」
 *
 * 之前的问题：学习会话的状态（watchSt）**只活在内存在**，所有记录只进「事件流」
 * （events/<date>.jsonl）——而事件流要等到「当天最后一次事件 30 分钟后」才被写成日记，
 * 且日记只做习惯归纳，不进 facts。于是：退出学习模式（或程序重启）之后，她真的什么都不记得，
 * 问她「今天学了多久」只能编。
 *
 * 这份账本是学习期间的**唯一真相**，三条铁律：
 *   1. 每次抽查当场落盘（进程被杀也不丢）；
 *   2. 按天分桶，跨天自动新开，昨天的还留着；
 *   3. 会话开始/结束/被抓这些关键节点由宿主写进长期记忆（memory.addEvent），
 *      账本本身负责「精确数字」，长期记忆负责「她真的记得」。
 *
 * 纯 node（只碰 fs），测试可以用临时目录直接跑。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 每天明细最多留这么多条（再多没人看，还会把文件撑大） */
const MAX_CHECKS = 240
/** 账本保留最近多少天 */
const KEEP_DAYS = 30

function dateStr (at) {
  const d = new Date(Number(at) || Date.now())
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function file (dir) { return path.join(dir, 'study', 'ledger.json') }

function emptyDb () { return { version: 1, days: {} } }

/** 最近一次 load 的目录：内部落盘用（不往 db 里塞 _dir，否则会被序列化进文件） */
let lastDir = ''

function load (dir) {
  lastDir = String(dir || lastDir || '')
  try {
    const doc = JSON.parse(fs.readFileSync(file(dir), 'utf8'))
    if (!doc || typeof doc !== 'object' || !doc.days) return emptyDb()
    return doc
  } catch { return emptyDb() }
}

function save (dir, db) {
  try {
    fs.mkdirSync(path.dirname(file(dir)), { recursive: true })
    // 只留最近 KEEP_DAYS 天，避免无限膨胀
    const keys = Object.keys(db.days).sort()
    if (keys.length > KEEP_DAYS) {
      for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete db.days[k]
    }
    const tmp = file(dir) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1))
    fs.renameSync(tmp, file(dir))
    return true
  } catch { return false }
}

/** 取/建当天
 * @returns {{date:string, goal:string, targetMin:number, checks:Array, active:object|null,
 *            penaltyMin:number, studyMin:number, sessions:Array, essay:{checks:number,short:number}}}
 */
function day (db, at, seed) {
  const k = dateStr(at)
  let d = db.days[k]
  if (!d) {
    d = {
      date: k,
      goal: '', targetMin: 0,
      checks: [],
      active: null,
      penaltyMin: 0,
      studyMin: 0,
      sessions: [],
      essay: { checks: 0, short: 0 }
    }
    db.days[k] = d
  }
  if (seed && typeof seed === 'object') {
    if (seed.goal) d.goal = String(seed.goal).slice(0, 60)
    if (Number(seed.targetMin) > 0) d.targetMin = Number(seed.targetMin)
  }
  return d
}

/** 会话开始：占一个 active 位（上一条没正常收场的先结算掉，不能丢） */
function open (db, at, o) {
  const t = Number(at) || Date.now()
  const d = day(db, t, o)
  if (d.active) {
    // 上一场没走 studyStop（程序被关/崩溃）→ 用最后一次记录的时间收场，仍然算数
    const lastAt = Number(d.active.lastAt) || Number(d.active.startedAt) || t
    const mins = Math.max(0, Math.round((lastAt - Number(d.active.startedAt)) / 60000))
    d.studyMin = Math.round((Number(d.studyMin) || 0) + mins)
    d.sessions.push(Object.assign({}, d.active, { endedAt: lastAt, aborted: true, min: mins }))
    d.active = null
  }
  d.active = {
    startedAt: t,
    goal: String((o && o.goal) || d.goal || '').slice(0, 60),
    targetMin: Number((o && o.targetMin) || d.targetMin) || 0,
    checks: 0, focus: 0, idle: 0, fun: 0, strikes: 0,
    penaltyMin: 0,
    lastAt: t
  }
  if (o && o.goal) d.goal = String(o.goal).slice(0, 60)
  if (o && Number(o.targetMin) > 0) d.targetMin = Number(o.targetMin)
  save(lastDir, db)
  return d.active
}

/** 记一次抽查 */
function noteCheck (db, at, o) {
  const t = Number(at) || Date.now()
  const d = day(db, t)
  const a = d.active
  const v = String((o && o.v) || 'idle')
  const row = {
    t,
    v,
    what: String((o && o.what) || '').slice(0, 120),
    subj: String((o && o.subj) || '').slice(0, 20),
    words: Number((o && o.words) || 0) || 0,
    kind: String((o && o.kind) || ''),
    heat: Math.round(Number((o && o.heat) || 0))
  }
  d.checks.push(row)
  if (d.checks.length > MAX_CHECKS) d.checks = d.checks.slice(-MAX_CHECKS)
  if (a) {
    a.checks = (a.checks || 0) + 1
    a.lastAt = t
    if (v === 'study') a.focus = (a.focus || 0) + 1
    else if (v === 'fun') a.fun = (a.fun || 0) + 1
    else a.idle = (a.idle || 0) + 1
    if (o && o.kind === 'furious') a.strikes = (a.strikes || 0) + 1
  }
  save(lastDir, db)
  return row
}

/** 补时（抓到一次在玩就延长今天的目标） */
function addPenalty (db, at, min) {
  const t = Number(at) || Date.now()
  const d = day(db, t)
  const n = Math.max(0, Math.round(Number(min) || 0))
  if (!n) return 0
  d.penaltyMin = (Number(d.penaltyMin) || 0) + n
  d.targetMin = (Number(d.targetMin) || 0) + n
  if (d.active) {
    d.active.penaltyMin = (d.active.penaltyMin || 0) + n
    d.active.targetMin = (Number(d.active.targetMin) || 0) + n
  }
  save(lastDir, db)
  return d.penaltyMin
}

/** 记一次申论字数检查 */
function noteEssay (db, at, o) {
  const t = Number(at) || Date.now()
  const d = day(db, t)
  d.essay = d.essay || { checks: 0, short: 0 }
  d.essay.checks = (Number(d.essay.checks) || 0) + 1
  if (o && o.short) d.essay.short = (Number(d.essay.short) || 0) + 1
  d.essay.words = Number((o && o.words) || 0) || 0
  d.essay.target = Number((o && o.target) || 0) || 0
  save(lastDir, db)
}

/** 会话收场：结算时长，返回这一场的结算对象 */
function close (db, at, extra) {
  const t = Number(at) || Date.now()
  const d = day(db, t)
  const a = d.active
  if (!a) return null
  const mins = Math.max(0, Math.round((t - Number(a.startedAt)) / 60000))
  d.studyMin = Math.round((Number(d.studyMin) || 0) + mins)
  const sess = Object.assign({}, a, { endedAt: t, min: mins }, extra || {})
  delete sess.lastAt
  d.sessions.push(sess)
  if (d.sessions.length > 40) d.sessions = d.sessions.slice(-40)
  d.active = null
  save(lastDir, db)
  return sess
}

/** 今天的一句账（给 systemPrompt / 收场报账，都是真数字） */
function summary (db, at, o) {
  const opts = o || {}
  const t = Number(at) || Date.now()
  const d = day(db, t)
  const mins = Math.round((Number(d.studyMin) || 0) +
    (d.active ? Math.max(0, (t - Number(d.active.startedAt)) / 60000) : 0))
  const checks = (d.checks || []).length
  const a = d.active
  const focus = a ? a.focus || 0 : (d.sessions || []).reduce((s, x) => s + (Number(x.focus) || 0), 0)
  const fun = a ? a.fun || 0 : (d.sessions || []).reduce((s, x) => s + (Number(x.fun) || 0), 0)
  const parts = []
  if (mins > 0) parts.push('今天已经学了 ' + mins + ' 分钟')
  if (d.goal) parts.push('目标「' + d.goal + '」')
  if (d.targetMin) parts.push('定的是 ' + d.targetMin + ' 分钟')
  if (checks > 0) parts.push('你查了 ' + checks + ' 次（专注 ' + focus + ' 次，在玩 ' + fun + ' 次）')
  if (Number(d.penaltyMin) > 0) parts.push('因为分心给他补了 ' + d.penaltyMin + ' 分钟')
  if (d.essay && Number(d.essay.short) > 0) {
    parts.push('申论字数不够 ' + d.essay.short + ' 次' +
      (Number(d.essay.words) ? '（最近一次 ' + d.essay.words + ' 字）' : ''))
  }
  if (!parts.length) return ''
  return parts.join('，') + '。'
}

/** 最近几天的一句话（今天是完整版，前几天只给时长） */
function recentText (db, at, days) {
  const n = Math.max(1, Math.min(7, Number(days) || 3))
  const keys = Object.keys((db && db.days) || {}).sort().reverse().slice(0, n)
  const out = []
  for (const k of keys) {
    const d = db.days[k]
    if (!d) continue
    const mins = Math.round(Number(d.studyMin) || 0)
    const checks = (d.checks || []).length
    if (!mins && !checks) continue
    out.push('  · ' + k + '：' + (mins ? mins + ' 分钟' : '不到 1 分钟') +
      '，抽查 ' + checks + ' 次' + (Number(d.penaltyMin) ? '，补时 ' + d.penaltyMin + ' 分' : '') +
      (d.goal ? '（' + String(d.goal).slice(0, 20) + '）' : ''))
  }
  return out.join('\n')
}

/** 有没有未收场的会话（启动补记用）。跨天也要找——昨晚没点结束就关机，今天仍算数。 */
function dangling (db) {
  const keys = Object.keys((db && db.days) || {}).sort().reverse()
  for (const k of keys) {
    const d = db.days[k]
    if (d && d.active) return Object.assign({}, d.active, { date: d.date })
  }
  return null
}

module.exports = {
  MAX_CHECKS, KEEP_DAYS,
  dateStr, file, load, save, day, open, noteCheck, addPenalty, noteEssay, close,
  summary, recentText, dangling
}
