/**
 * 电脑画像 · 设备运行时间（**只读**）
 *
 * 「他到底有多少时间泡在这台电脑前」，光看浏览记录推不出来。这里采三样：
 *   1. 本次开机已运行多久（os.uptime，即时可信）
 *   2. 每次开机关机的时间点（Windows 事件日志 Kernel-General 12/13）
 *   3. 每天最早/最晚在用的时刻（来自 usage.json 的采样，是「真在用」而不是「开着机」）
 *
 * 事件日志用 /f:xml 取，不用 /f:text：文本格式随系统语言变，中文系统解析必炸。
 * 拿不到日志（权限/精简系统）就退回采样数据，两个都没有就说没有，不编。
 */
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const DAY = 24 * 3600 * 1000

/** 解析 wevtutil 的 XML：只认 Kernel-General 的 12（启动）/ 13（关机） */
function parseEventsXml (xml) {
  const out = []
  const blocks = String(xml || '').split('<Event ').slice(1)
  for (const b of blocks) {
    const prov = (b.match(/<Provider Name='([^']+)'/) || [])[1] || ''
    if (!/Kernel-General/i.test(prov)) continue
    const id = Number((b.match(/<EventID>(\d+)<\/EventID>/) || [])[1] || 0)
    if (id !== 12 && id !== 13) continue
    const iso = (b.match(/SystemTime='([^']+)'/) || [])[1] || ''
    const at = Date.parse(iso)
    if (!at) continue
    out.push({ type: id === 12 ? 'boot' : 'shutdown', at })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** 把事件配成「开机 → 关机」段；没有关机记录的（断电/强制重启）标 abnormal */
function pairSessions (events, now = Date.now()) {
  const out = []
  let bootAt = 0
  for (const e of events) {
    if (e.type === 'boot') {
      if (bootAt) out.push({ on: bootAt, off: 0, hours: 0, abnormal: true })
      bootAt = e.at
    } else if (e.type === 'shutdown' && bootAt) {
      out.push({ on: bootAt, off: e.at, hours: round1((e.at - bootAt) / 3600000) })
      bootAt = 0
    }
  }
  if (bootAt) out.push({ on: bootAt, off: 0, hours: round1((now - bootAt) / 3600000), running: true })
  return out
}

function round1 (n) {
  return Math.round((Number(n) || 0) * 10) / 10
}

function readEventLog ({ count = 120, timeout = 8000 } = {}) {
  try {
    const out = execFileSync('wevtutil', [
      'qe', 'System',
      '/q:*[System[(EventID=12 or EventID=13)]]',
      '/c:' + count, '/rd:true', '/f:xml'
    ], { encoding: 'utf8', windowsHide: true, timeout })
    return parseEventsXml(out)
  } catch { return null }
}

/** 从 usage.collect() 的结果里取每天最早/最晚（__first/__last 是 0.24.0 才有的，老数据没有） */
function daysFromUsage (usage) {
  const out = []
  for (const d of (usage && usage.byDay) || []) {
    const first = Number(d.first) || 0
    const last = Number(d.last) || 0
    if (!first || !last) continue
    out.push({ date: d.date, first, last, spanHours: round1((last - first) / 3600000), activeMinutes: d.totalMinutes || 0 })
  }
  return out
}

/**
 * @param {{usage?:object, days?:number}} o
 * @returns {{ok:boolean, source:string, uptimeHours:number, sessions:Array, days:Array,
 *            avgUpHours:number, bootsPerDay:number, lateShutdowns:number, lastShutdownAt:number}}
 */
function collect ({ usage = null, days = 14, now = Date.now() } = {}) {
  const uptimeHours = round1(os.uptime() / 3600)
  const events = readEventLog()
  const sessions = events ? pairSessions(events, now) : []
  const since = now - days * DAY
  /* 掉了 6 分钟以内的段是重启/更新/蓝屏，不是「用过电脑」——
     留着会把「平均开机时长」和「凌晨关机次数」都算歪。 */
  const recent = sessions.filter((s) => s.on >= since && (s.running || s.hours >= 0.1))

  const done = recent.filter((s) => s.off)
  const avgUpHours = done.length
    ? round1(done.reduce((n, s) => n + s.hours, 0) / done.length)
    : 0

  /* 关机时间落在 01:00–05:59 = 熬夜；这是比「最晚浏览时间」更硬的证据 */
  const lateShutdowns = done.filter((s) => {
    const h = new Date(s.off).getHours()
    return h >= 1 && h < 6
  }).length

  const lastShutdown = done.length ? done[done.length - 1].off : 0
  const dayCount = new Set(recent.map((s) => new Date(s.on).toDateString())).size || 1

  return {
    ok: recent.length > 0 || uptimeHours > 0,
    source: events ? 'eventlog' : 'none',
    uptimeHours,
    sessions: recent.slice(-40),
    days: daysFromUsage(usage),
    avgUpHours,
    bootsPerDay: round1(recent.length / dayCount),
    lateShutdowns,
    lastShutdownAt: lastShutdown
  }
}

module.exports = { collect, parseEventsXml, pairSessions, daysFromUsage, readEventLog }
