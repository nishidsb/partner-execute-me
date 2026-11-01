/**
 * 电脑画像 · 应用使用习惯（**只读**，本地统计）
 *
 * 「平时喜欢用电脑做什么」= 前台窗口的累计时长。做法：
 *   每 45 秒问一次 launcher 当前前台窗口（它内部 1.2s 缓存、PowerShell 常驻 worker），
 *   把这段时间记到当天 + 该程序名下。只记**进程名 + 窗口标题**，不记键盘、不记内容。
 *
 * 0.43.0 加了「活跃时长」（active）：采样那一刻查 powerMonitor.getSystemIdleTime()，
 * 空闲 < 90 秒就认为这段时间他在真的操作（敲键盘/动鼠标），否则是在看/挂机。
 * **明确不做键盘钩子**：能统计「今天在电脑前忙了多久」，不记录任何按键和输入内容。
 * 想要「他具体打了什么字」，正确做法是她看屏幕（watch 已有 OCR/视觉），不是 keylogger。
 *
 * 数据文件：<pcDir>/usage.json
 *   { "days": { "2026-10-28": { "msedge": { sec: 3600, active: 1200, titles: { "B站": 1200 } } } } }
 */
const fs = require('node:fs')
const path = require('node:path')

const SAMPLE_MS = 45 * 1000
const KEEP_DAYS = 60

let timer = null
let current = null // 上一次采到的 {app, title, at}
let lastIdleSec = -1 // 最近一次采样时的系统空闲秒数（-1 = 拿不到）
let filePath = ''
let logFn = () => {}

function dateKey (d = new Date()) {
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function readAll () {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const d = JSON.parse(raw)
    return d && d.days ? d : { days: {} }
  } catch { return { days: {} } }
}

function writeAll (data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(data))
  } catch (e) { logFn('[profile] 写 usage.json 失败: ' + e.message) }
}

/** 清掉太老的日期，避免文件无限长 */
function prune (data, keepDays = KEEP_DAYS) {
  const keys = Object.keys(data.days).sort()
  while (keys.length > keepDays) {
    delete data.days[keys.shift()]
  }
  return data
}

/** 记一段时长到当天（activeSec：这段时间里他真的在操作，而不是挂着看） */
function addSpan (app, title, sec, activeSec = 0) {
  if (!app || sec <= 0) return
  const data = readAll()
  const day = dateKey()
  if (!data.days[day]) data.days[day] = {}
  const rec = data.days[day][app] || { sec: 0, active: 0, titles: {} }
  rec.sec += sec
  rec.active = (Number(rec.active) || 0) + Math.max(0, Math.min(sec, activeSec))
  const t = String(title || '').slice(0, 60)
  if (t) rec.titles[t] = (rec.titles[t] || 0) + sec
  data.days[day][app] = rec
  /* 当天的最早/最晚活动时间（保留字段，前缀 __ 不会被当成程序名）。
     有这个才知道「他今天几点坐到电脑前、几点还在用」，比 45 秒一次的瞬时值有意义。 */
  const now = Date.now()
  const from = now - Math.max(0, sec) * 1000
  daysMeta(data.days[day], from, now)
  writeAll(prune(data))
}

/** 更新某天的最早开始 / 最晚结束（存在 day.__first / day.__last） */
function daysMeta (dayRec, from, to) {
  if (!dayRec) return
  const f = Number(dayRec.__first) || 0
  const l = Number(dayRec.__last) || 0
  dayRec.__first = f ? Math.min(f, from) : from
  dayRec.__last = l ? Math.max(l, to) : to
}

/** 系统空闲秒数。拿不到（纯 node 环境/权限问题）就返回 -1，调用方当「未知」处理 */
function idleSecOf () {
  try {
    const { powerMonitor } = require('electron')
    const s = powerMonitor.getSystemIdleTime()
    return Number.isFinite(s) ? s : -1
  } catch { return -1 }
}

/** 采一次样：把「上次采到的那一刻 → 现在」这段时间记给上次那个前台程序 */
async function sampleOnce () {
  let snap = null
  try {
    const launcher = require('../launcher')
    snap = await launcher.scan({ maxAge: 30000 })
  } catch { return }
  const fg = (snap && snap.windows || []).find((w) => w && w.fg)
  const next = fg ? { app: String(fg.pn || '').replace(/\.exe$/i, ''), title: String(fg.t || ''), at: Date.now() } : null
  /* 空闲 < 90 秒 = 这一个采样窗口里他动过键鼠。90 而不是 45，是因为 launcher 扫描本身
     有几百毫秒抖动，卡在边界上会漏掉「刚好在采样前一秒停手」的情况。 */
  const idle = idleSecOf()
  const active = idle >= 0 && idle < 90
  if (current && next) {
    const dt = Math.max(0, Math.min(120, Math.round((next.at - current.at) / 1000)))
    if (dt > 0) addSpan(current.app, current.title, dt, active ? dt : 0)
  }
  current = next
  lastIdleSec = idle
}

function start ({ pcDir, log, intervalMs = SAMPLE_MS } = {}) {
  stop()
  if (pcDir) filePath = path.join(pcDir, 'usage.json')
  if (typeof log === 'function') logFn = log
  if (!filePath) return false
  current = null
  // 先立刻采一次建立基线，之后定时
  sampleOnce().catch(() => { })
  timer = setInterval(() => { sampleOnce().catch(() => { }) }, Math.max(20000, intervalMs))
  if (timer.unref) timer.unref()
  return true
}

function stop () {
  if (timer) { clearInterval(timer); timer = null }
  current = null
}

/**
 * 汇总。days 天内：
 *   - byApp: [{app, minutes, share}] 降序
 *   - byDay: [{date, totalMinutes, top: [{app, minutes}]}]
 *   - titles: 各应用最常出现的窗口标题（看「用浏览器在干嘛」）
 */
function collect ({ days = 14 } = {}) {
  const data = filePath ? readAll() : { days: {} }
  const keys = Object.keys(data.days).sort().slice(-days)
  const appTotal = new Map()
  const titleTotal = new Map()
  const byDay = []
  let grand = 0

  for (const k of keys) {
    const rec = data.days[k] || {}
    let dayTotal = 0
    const dayApps = []
    for (const [app, v] of Object.entries(rec)) {
      if (app.startsWith('__')) continue   // __first/__last 是当天元信息，不是程序
      const sec = Number(v && v.sec) || 0
      dayTotal += sec
      appTotal.set(app, (appTotal.get(app) || 0) + sec)
      for (const [t, s] of Object.entries((v && v.titles) || {})) {
        titleTotal.set(app + ' ▸ ' + t, (titleTotal.get(app + ' ▸ ' + t) || 0) + Number(s || 0))
      }
      dayApps.push({ app, minutes: Math.round(sec / 60), activeMinutes: Math.round((Number(v && v.active) || 0) / 60) })
    }
    grand += dayTotal
    byDay.push({
      date: k,
      totalMinutes: Math.round(dayTotal / 60),
      top: dayApps.sort((a, b) => b.minutes - a.minutes).slice(0, 6)
    })
  }

  const byApp = [...appTotal.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([app, sec]) => ({ app, minutes: Math.round(sec / 60), share: grand ? Math.round((sec / grand) * 100) : 0 }))

  const titles = [...titleTotal.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([name, sec]) => ({ name, minutes: Math.round(sec / 60) }))

  return {
    ok: byApp.length > 0,
    days,
    sampledDays: keys.length,
    totalHours: Math.round((grand / 3600) * 10) / 10,
    byApp,
    byDay,
    titles
  }
}

/**
 * 只取「今天」——给「她今天知道你在干嘛」用。
 * 和 collect() 的区别：collect 是 14 天的画像（「你是个什么样的人」），
 * today 是当天切片（「你今天做了什么」）。后者才是聊天里能自然提起的东西。
 *
 * @returns {{ok:boolean, first:number, last:number, totalSec:number, activeSec:number,
 *            apps:Array, idleSec:number}}
 */
function today () {
  const data = readAll()
  const day = data.days[dateKey()] || {}
  const apps = []
  let totalSec = 0
  let activeSec = 0
  for (const [app, v] of Object.entries(day)) {
    if (app.startsWith('__')) continue
    const sec = Number(v && v.sec) || 0
    const act = Number(v && v.active) || 0
    totalSec += sec
    activeSec += act
    if (sec < 60) continue
    apps.push({
      app,
      minutes: Math.round(sec / 60),
      activeMinutes: Math.round(act / 60),
      titles: Object.entries((v && v.titles) || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0])
    })
  }
  apps.sort((a, b) => b.minutes - a.minutes)
  return {
    ok: totalSec >= 60,
    first: Number(day.__first) || 0,
    last: Number(day.__last) || 0,
    totalSec,
    activeSec,
    apps: apps.slice(0, 8),
    idleSec: lastIdleSec
  }
}

function clearFile () {
  try { fs.unlinkSync(filePath) } catch { }
}

module.exports = { start, stop, sampleOnce, collect, today, clearFile, dateKey }
