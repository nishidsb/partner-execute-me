'use strict'
/**
 * 0.18.0 第一批 · 闹钟（对齐 Coopanion core/alarms.ts 的行为，重写实现）
 *
 * 模型/用户给角色设一个「每天几点」或「某天几点」的提醒；到点角色自己开口
 * （气泡 + 朗读 + 系统通知），错过 15 分钟内补发一次（带原定时间），更久直接跳到下一次。
 *
 * 纯逻辑与 IO 分离：parseTime / nextFireAt / planDue 可直接 node:test。
 * 数据落在 <userData>/companion/alarms.json，随角色卡一起在本机，不联网。
 */

const fs = require('node:fs')
const path = require('node:path')

const MAX_ALARMS = 20
const GRACE_MS = 15 * 60 * 1000 // 错过多久内还补发
const DAY_MS = 24 * 60 * 60 * 1000

/** 'HH:MM' / 'H:M' / '7：30'（全角冒号） → {h,m}；非法返回 null */
function parseTime (s) {
  const m = /^(\d{1,2})[:：](\d{1,2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return { h, m: mi }
}

/** HH:MM 文本（补零） */
function fmtTime (t) {
  if (!t) return ''
  return String(t.h).padStart(2, '0') + ':' + String(t.m).padStart(2, '0')
}

/** 0.46.23 'YYYY-MM-DD' 校验（严格日历：2 月 30 日这类要能挡掉）；非法返回 null */
function parseDate (s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** 从 now 往后的下一次触发时间（时间戳）；一次性且已过 → null */
function nextFireAt (alarm, now = Date.now()) {
  const t = parseTime(alarm && alarm.time)
  if (!t) return null
  const d = new Date(now)
  // 0.46.23 date（某天一次性）：就是那一天，过了就是过了（daily 对 date 闹钟无意义）
  const dateS = alarm && alarm.date ? parseDate(alarm.date) : null
  if (dateS) {
    const [y, mo, dd] = dateS.split('-').map(Number)
    const at = new Date(y, mo - 1, dd, t.h, t.m, 0, 0).getTime()
    return at > now ? at : null
  }
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.m, 0, 0).getTime()
  if (at > now) return at
  if (alarm && alarm.daily) {
    let n = at + DAY_MS
    // 电脑关了两天：直接跳到第一个未来的 occurrence，不重复炸
    while (n <= now) n += DAY_MS
    return n
  }
  return null
}

/**
 * 检查一批闹钟：返回 { fire, next, changed }
 *  fire: [{ alarm, at, late }]（at=原定时间；late=迟到毫秒）
 *  next: 推进 nextAt 后的新数组（daily 推进一天/一次性置 null）
 */
function planDue (alarms, now = Date.now()) {
  const list = Array.isArray(alarms) ? alarms : []
  const fire = []
  let changed = false
  const next = list.map((a) => {
    if (!a || a.enabled === false) return a
    let at = a.nextAt
    if (!at || at <= 0) {
      at = nextFireAt(a, now)
      if (!at) return a
      changed = true
    }
    if (now < at) {
      if (a.nextAt !== at) { changed = true; return { ...a, nextAt: at } }
      return a
    }
    // 到点/已过
    const late = now - at
    if (late <= GRACE_MS) fire.push({ alarm: a, at, late })
    let nAt = null
    if (a.daily) {
      nAt = at + DAY_MS
      while (nAt <= now) nAt += DAY_MS
    }
    changed = true
    return {
      ...a,
      nextAt: nAt,
      lastFiredAt: late <= GRACE_MS ? now : (a.lastFiredAt || 0),
      lastSkipAt: late > GRACE_MS ? now : (a.lastSkipAt || 0)
    }
  })
  return { fire, next, changed }
}

function makeId () {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * 创建闹钟管理器。
 * @param {object} o
 * @param {string} o.home       数据目录（companion 根目录）
 * @param {() => number} [o.now] 可注入时钟（测试用）
 * @param {(alarm:{id,time,label,daily,late}) => void} [o.onFire]
 * @param {(msg:string) => void} [o.log]
 */
function createAlarms ({ home, now = () => Date.now(), onFire = () => { }, log = () => { } }) {
  const dir = home
  const file = path.join(dir, 'alarms.json')
  let cache = null
  let timer = null

  function read () {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.alarms) ? raw.alarms : [])
    } catch { return [] }
  }
  function write (list) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(list.slice(0, MAX_ALARMS), null, 1), 'utf8')
    } catch (err) { log('[alarms] 保存失败: ' + (err && err.message)) }
  }
  function load () {
    if (!cache) cache = read()
    return cache
  }
  function save (list) { cache = list; write(list); return list }

  /** 列表（顺带把 nextAt 修正到未来；返回对外视图，不含内部字段） */
  function list () {
    const t = now()
    const { next, changed } = planDue(load(), t)
    if (changed) save(next)
    return next
      .filter((a) => a && a.time)
      .map((a) => ({
        id: a.id,
        time: a.time,
        date: a.date || '',
        label: a.label || '',
        daily: a.daily !== false,
        enabled: a.enabled !== false,
        nextAt: a.nextAt || null,
        lastFiredAt: a.lastFiredAt || 0
      }))
      .sort((x, y) => String(x.time).localeCompare(String(y.time)))
  }

  function add ({ time, label = '', daily = true, date = '' } = {}) {
    const t = parseTime(time)
    if (!t) return { ok: false, error: '时间格式要像 07:30' }
    // 0.46.23 date（YYYY-MM-DD）：用户说「明天/几号」的事时用——此前模型表达不了某天，
    // 只能设今天的一次性（今天到了就响，之后 nextAt=null 静默死掉，两头都是错的）
    let dateS = ''
    if (date) {
      dateS = parseDate(date)
      if (!dateS) return { ok: false, error: 'date 要是 YYYY-MM-DD（例如 2026-11-04）' }
      daily = false   // 指定了日期就是那一次，不每天
    }
    const probe = { time: fmtTime(t), daily: daily !== false, date: dateS }
    const nextAt = nextFireAt(probe, now())
    if (!nextAt) {
      return {
        ok: false,
        error: dateS
          ? `${dateS} ${fmtTime(t)} 已经过了，设个未来的时间`
          : '今天 ' + fmtTime(t) + ' 已经过了；如果是明天或以后的事，把 date 给成 YYYY-MM-DD'
      }
    }
    const cur = load()
    if (cur.length >= MAX_ALARMS) return { ok: false, error: `最多 ${MAX_ALARMS} 个闹钟` }
    const alarm = {
      id: makeId(),
      time: fmtTime(t),
      date: dateS,
      label: String(label || '').trim().slice(0, 40),
      daily: daily !== false,
      enabled: true,
      nextAt,
      lastFiredAt: 0
    }
    save([...cur, alarm])
    log('[alarms] 新增 ' + (alarm.date ? alarm.date + ' ' : '') + alarm.time + (alarm.daily ? ' 每天' : ' 一次') + (alarm.label ? ' · ' + alarm.label : ''))
    return { ok: true, alarm }
  }

  function remove (id) {
    const cur = load()
    const next = cur.filter((a) => a && a.id !== id)
    if (next.length === cur.length) return false
    save(next)
    return true
  }

  function setEnabled (id, on) {
    const cur = load()
    let hit = null
    const next = cur.map((a) => {
      if (!a || a.id !== id) return a
      hit = { ...a, enabled: !!on, nextAt: on ? nextFireAt(a, now()) : a.nextAt }
      return hit
    })
    if (!hit) return false
    save(next)
    return true
  }

  /** 立刻检查一次（定时器每 20s 调；测试直接调） */
  function tick () {
    const t = now()
    const { fire, next, changed } = planDue(load(), t)
    if (changed) save(next)
    for (const f of fire) {
      const a = f.alarm
      const lateMin = Math.round(f.late / 60000)
      log('[alarms] 触发 ' + a.time + (a.label ? ' · ' + a.label : '') + (lateMin >= 1 ? `（迟到 ${lateMin} 分）` : ''))
      try {
        onFire({
          id: a.id,
          time: a.time,
          label: a.label || '',
          daily: a.daily !== false,
          late: f.late,
          lateMin,
          scheduledAt: f.at
        })
      } catch (err) { log('[alarms] onFire 失败: ' + (err && err.message)) }
    }
    return fire.length
  }

  function start () {
    stop()
    timer = setInterval(() => { try { tick() } catch (err) { log('[alarms] tick 异常: ' + (err && err.message)) } }, 20000)
    if (timer.unref) timer.unref()
    // 启动即检查一次：关机期间到点的在 15 分钟内能补上
    setTimeout(() => { try { tick() } catch { } }, 4000)
    return true
  }
  function stop () {
    if (timer) { clearInterval(timer); timer = null }
  }

  return { list, add, remove, setEnabled, tick, start, stop, file }
}

module.exports = { parseTime, parseDate, fmtTime, nextFireAt, planDue, createAlarms, MAX_ALARMS, GRACE_MS }
