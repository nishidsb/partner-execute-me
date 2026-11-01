/**
 * 健康记录（睡眠 / 血压 / 心态）—— 0.24.0
 *
 * 三件事实在「主人自己的身体」上，不跟角色卡走：
 *   原始数据 <userData>/health/log.jsonl（追加写，一天可以记很多次，读的时候合并）
 *   摘要     <workspace>/health.md（这几天的概况，进 git，也进她的上下文）
 *
 * 三条入口：聊天里她说「昨晚两点睡」（工具 health_log）、设置页/手机表单手填、
 *          以后的手表截图导入（走同一条 record()）。
 * 手表数据不是硬需求：华强北手表的 App（Wearfit Pro / Da Fit 一类）没有开放接口，
 *          截图 OCR 与手动填是目前唯一稳的路；换支持 Health Connect 的手表后 APK 能直接读。
 */
const fs = require('node:fs')
const path = require('node:path')

const STATE = { dataRoot: '', log: () => { } }

function file () {
  return path.join(STATE.dataRoot || '', 'health', 'log.jsonl')
}

function ensureDir (f) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }) } catch { }
}

function dateKey (d = new Date()) {
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 中文小时：一~十二 / 阿拉伯数字 */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** 中文数字 → 0..99（'二十' → 20，'二十五' → 25，'十二' → 12） */
function cnNum (txt) {
  const s = String(txt || '').trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '十') return 10
  if (!s.includes('十')) return s.length === 1 && CN_DIGIT[s] != null ? CN_DIGIT[s] : null
  const parts = s.split('十')
  if (parts.length !== 2) return null
  const tens = parts[0] === '' ? 1 : CN_DIGIT[parts[0]]
  const ones = parts[1] === '' ? 0 : CN_DIGIT[parts[1]]
  if (tens == null || ones == null) return null
  return tens * 10 + ones
}

const cnHour = cnNum

/**
 * '1:30' / '01:30' / '0130' / '凌晨两点半' / '昨晚 23:40' / '下午3点' → 'HH:MM'
 * 认不出返回 ''（宁可不记，也别记错时间）
 */
function normClock (v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return ''
  /* 纯数字：1230 / 0130 */
  const pure = s.match(/^(\d{3,4})$/)
  if (pure) {
    const n = pure[1].padStart(4, '0')
    const h = Number(n.slice(0, 2)); const mi = Number(n.slice(2))
    if (h <= 24 && mi < 60) return n.slice(0, 2) + ':' + n.slice(2)
    return ''
  }
  /* 已经带冒号 / 点号 分隔 */
  let h = null
  let mi = 0
  const hm = s.match(/(\d{1,2})\s*[:：.]\s*(\d{1,2})/)
  if (hm) {
    h = Number(hm[1]); mi = Number(hm[2])
  } else {
    /* 中文口语：「凌晨两点半」「下午3点」「晚上十点二十」「七点一刻」 */
    const m = s.match(/([零一二两三四五六七八九十]{1,3}|\d{1,2})\s*[点时]\s*(半|一刻钟?|三刻|[零一二两三四五六七八九十]{1,3}|\d{1,2})?\s*分?/)
    if (!m) return ''
    h = cnHour(m[1])
    if (m[2] === '半') mi = 30
    else if (/^一刻/.test(String(m[2] || ''))) mi = 15
    else if (m[2] === '三刻') mi = 45
    else if (m[2]) { const x = cnHour(m[2]); mi = x == null ? 0 : x }
  }
  if (h == null || !Number.isFinite(h)) return ''
  /* 12 小时制修正：下午/晚上 +12；凌晨/半夜 的 12 点算 0 点 */
  const pm = /(下午|傍晚|晚上|夜里|夜间|今晚|明晚|昨晚)/.test(s)
  const am = /(凌晨|半夜|深夜|早上|早晨|上午|清晨)/.test(s)
  if (pm && h < 12) h += 12
  if (am && h === 12) h = 0
  if (h < 0 || h > 24 || mi < 0 || mi >= 60) return ''
  const p2 = (n) => (n < 10 ? '0' + n : '' + n)
  return p2(h) + ':' + p2(mi)
}

/** 入睡 + 起床 → 睡了几个小时（跨午夜自动 +24） */
function hoursBetween (bed, wake) {
  const b = normClock(bed); const w = normClock(wake)
  if (!b || !w) return 0
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  let d = toMin(w) - toMin(b)
  if (d <= 0) d += 24 * 60
  return Math.round((d / 60) * 10) / 10
}

/** 心情：1-10 数字，或中文口语 → 分数 */
function normMood (v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (Number.isFinite(n) && n >= 0 && n <= 10) return Math.round(n)
  const s = String(v)
  const map = [
    [/很好|超好|开心|舒服|愉快|棒/, 9],
    [/不错|还行|还好|正常|平稳|可以/, 7],
    [/一般|普通|没什么|说不上/, 5],
    [/累|困|烦|难受|焦虑|低落|郁闷|down|emo/i, 3],
    [/很差|糟糕|崩|难受死|想哭/, 1]
  ]
  for (const [re, score] of map) if (re.test(s)) return score
  return null
}

function readAll () {
  const f = file()
  let raw = ''
  try { raw = fs.readFileSync(f, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* 坏行跳过，不影响别的 */ }
  }
  return out
}

/** 追加一条（同一个 date 允许多条，读时后写的覆盖前面的字段） */
function record (entry = {}) {
  const date = String(entry.date || dateKey()).slice(0, 10)
  const rec = { date, ts: Date.now(), source: entry.source || 'chat' }
  const sleep = entry.sleep || {}
  const bed = normClock(sleep.bed || entry.sleepBed)
  const wake = normClock(sleep.wake || entry.sleepWake)
  let hours = Number(sleep.hours || entry.sleepHours) || 0
  if (!hours && bed && wake) hours = hoursBetween(bed, wake)
  if (bed || wake || hours) {
    rec.sleep = {}
    if (bed) rec.sleep.bed = bed
    if (wake) rec.sleep.wake = wake
    if (hours > 0) rec.sleep.hours = Math.round(hours * 10) / 10
    if (sleep.quality) rec.sleep.quality = String(sleep.quality).slice(0, 20)
  }
  const sys = Number(entry.bpSys != null ? entry.bpSys : (entry.bp && entry.bp.sys))
  const dia = Number(entry.bpDia != null ? entry.bpDia : (entry.bp && entry.bp.dia))
  const pulse = Number(entry.pulse != null ? entry.pulse : (entry.bp && entry.bp.pulse))
  if (Number.isFinite(sys) && sys > 0) {
    rec.bp = { sys: Math.round(sys) }
    if (Number.isFinite(dia) && dia > 0) rec.bp.dia = Math.round(dia)
    if (Number.isFinite(pulse) && pulse > 0) rec.bp.pulse = Math.round(pulse)
    rec.bp.at = normClock(entry.bpAt) || new Date().toTimeString().slice(0, 5)
  }
  const moodScore = normMood(entry.moodScore != null ? entry.moodScore : entry.mood)
  if (moodScore != null || entry.moodNote) {
    rec.mood = {}
    if (moodScore != null) rec.mood.score = moodScore
    if (entry.moodNote) rec.mood.note = String(entry.moodNote).slice(0, 200)
  }
  const w = Number(entry.weight)
  if (Number.isFinite(w) && w > 0) rec.weight = Math.round(w * 10) / 10

  /* 什么都没识别出来就别写入脏数据 */
  if (!rec.sleep && !rec.bp && !rec.mood && rec.weight == null) {
    return { ok: false, error: '这条没有可记录的内容（睡眠/血压/心情至少要有一项）' }
  }

  const f = file()
  ensureDir(f)
  try {
    fs.appendFileSync(f, JSON.stringify(rec) + '\n')
  } catch (e) {
    return { ok: false, error: '写入失败：' + e.message }
  }
  STATE.log('[health] 记录 ' + date + ' ' + JSON.stringify(rec))
  return { ok: true, entry: rec }
}

/** 按日期合并（后写的覆盖同名字段） */
function merged () {
  const rows = readAll()
  const byDate = new Map()
  for (const r of rows) {
    const d = String(r.date || '').slice(0, 10)
    if (!d) continue
    const cur = byDate.get(d) || { date: d }
    if (r.sleep) cur.sleep = Object.assign({}, cur.sleep, r.sleep)
    if (r.bp) cur.bp = Object.assign({}, cur.bp, r.bp)
    if (r.mood) cur.mood = Object.assign({}, cur.mood, r.mood)
    if (r.weight != null) cur.weight = r.weight
    if (r.note) cur.note = r.note
    cur.ts = Math.max(cur.ts || 0, r.ts || 0)
    byDate.set(d, cur)
  }
  return [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : 1)
}

function list ({ days = 30 } = {}) {
  const all = merged()
  return all.slice(-Math.max(1, days))
}

/** 统计：均值 + 极端值，用来让她说「你最近都两点睡」 */
function stats ({ days = 14 } = {}) {
  const rows = list({ days })
  const sleeps = rows.filter((r) => r.sleep && r.sleep.hours)
  const bps = rows.filter((r) => r.bp && r.bp.sys)
  const moods = rows.filter((r) => r.mood && r.mood.score != null)
  const avg = (arr) => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0

  /* 入睡时间均值（把 0-6 点当作 24+，避免 01:00 与 23:00 平均成 12:00） */
  const bedMin = sleeps.map((r) => {
    const t = r.sleep.bed
    if (!t) return null
    let m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
    if (m < 6 * 60) m += 24 * 60
    return m
  }).filter((x) => x != null)
  let avgBed = ''
  if (bedMin.length) {
    let m = Math.round(bedMin.reduce((a, b) => a + b, 0) / bedMin.length) % (24 * 60)
    avgBed = (m < 600 ? '0' : '') + Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0')
  }

  return {
    ok: rows.length > 0,
    days,
    recordedDays: rows.length,
    sleep: {
      nights: sleeps.length,
      avgHours: avg(sleeps.map((r) => r.sleep.hours)),
      minHours: sleeps.length ? Math.min(...sleeps.map((r) => r.sleep.hours)) : 0,
      maxHours: sleeps.length ? Math.max(...sleeps.map((r) => r.sleep.hours)) : 0,
      avgBed,
      lateNights: bedMin.filter((m) => m >= 24 * 60 + 60).length // 1 点后睡
    },
    bp: {
      readings: bps.length,
      avgSys: avg(bps.map((r) => r.bp.sys)),
      avgDia: avg(bps.filter((r) => r.bp.dia).map((r) => r.bp.dia)),
      maxSys: bps.length ? Math.max(...bps.map((r) => r.bp.sys)) : 0,
      highCount: bps.filter((r) => r.bp.sys >= 140 || (r.bp.dia || 0) >= 90).length
    },
    mood: {
      entries: moods.length,
      avg: avg(moods.map((r) => r.mood.score)),
      lowCount: moods.filter((r) => r.mood.score <= 3).length
    },
    rows
  }
}

function mdOf (rows, st) {
  const L = []
  L.push('# 健康记录（' + st.recordedDays + ' 天有记录）')
  L.push('')
  if (st.sleep.nights) {
    L.push('## 睡眠')
    L.push('平均 ' + st.sleep.avgHours + ' 小时（最少 ' + st.sleep.minHours + ' / 最多 ' + st.sleep.maxHours + '）' +
      (st.sleep.avgBed ? '，平均入睡 ' + st.sleep.avgBed : '') +
      (st.sleep.lateNights ? '，其中 ' + st.sleep.lateNights + ' 天凌晨 1 点后才睡' : ''))
    L.push('')
  }
  if (st.bp.readings) {
    L.push('## 血压')
    L.push('平均 ' + st.bp.avgSys + '/' + (st.bp.avgDia || '-') + '（最高收缩压 ' + st.bp.maxSys + '）' +
      (st.bp.highCount ? '，有 ' + st.bp.highCount + ' 次偏高（≥140/90）' : '，都在正常范围'))
    L.push('')
  }
  if (st.mood.entries) {
    L.push('## 心态')
    L.push('平均 ' + st.mood.avg + '/10' + (st.mood.lowCount ? '，有 ' + st.mood.lowCount + ' 天状态很低落' : ''))
    L.push('')
  }
  L.push('## 逐日明细')
  for (const r of rows.slice(-14)) {
    const bits = []
    if (r.sleep) bits.push('睡眠 ' + (r.sleep.bed ? r.sleep.bed + '→' : '') + (r.sleep.wake || '') + (r.sleep.hours ? '(' + r.sleep.hours + 'h)' : ''))
    if (r.bp) bits.push('血压 ' + r.bp.sys + '/' + (r.bp.dia || '-') + (r.bp.pulse ? ' 心率' + r.bp.pulse : ''))
    if (r.mood && r.mood.score != null) bits.push('心态 ' + r.mood.score + '/10' + (r.mood.note ? '：' + r.mood.note : ''))
    if (r.weight != null) bits.push('体重 ' + r.weight + 'kg')
    L.push('- ' + r.date + '：' + (bits.join(' · ') || '（无数据）'))
  }
  return L.join('\n')
}

/** 给上下文用的一小段（≤900 字） */
function promptBlock ({ days = 7 } = {}) {
  const st = stats({ days })
  if (!st.ok) return ''
  const L = ['# 主人最近的身体状况（他自己记录的，' + st.recordedDays + ' 天有数据）']
  if (st.sleep.nights) {
    L.push('- 睡眠：平均 ' + st.sleep.avgHours + ' 小时' + (st.sleep.avgBed ? '，平均 ' + st.sleep.avgBed + ' 睡' : '') +
      (st.sleep.lateNights ? '（' + st.sleep.lateNights + ' 天过了 1 点才睡）' : ''))
  }
  if (st.bp.readings) L.push('- 血压：平均 ' + st.bp.avgSys + '/' + (st.bp.avgDia || '-') + (st.bp.highCount ? '，有偏高的记录' : ''))
  if (st.mood.entries) L.push('- 心态：平均 ' + st.mood.avg + '/10' + (st.mood.lowCount ? '（' + st.mood.lowCount + ' 天很低落）' : ''))
  const last = st.rows[st.rows.length - 1]
  if (last) {
    const bits = []
    if (last.sleep && last.sleep.hours) bits.push('昨晚睡 ' + last.sleep.hours + ' 小时')
    if (last.bp) bits.push('血压 ' + last.bp.sys + '/' + (last.bp.dia || '-'))
    if (last.mood && last.mood.score != null) bits.push('心情 ' + last.mood.score + '/10')
    if (bits.length) L.push('- 最近一次：' + last.date + ' ' + bits.join('，'))
  }
  L.push('（这些是他自己记的，聊天时可以自然关心，但别拿数据说教）')
  let text = L.join('\n')
  if (text.length > 900) text = text.slice(0, 900)
  return text
}

/** 写一份摘要到工作区（进 git、也能被别的模块读） */
function writeSummary (wsDir, { days = 14 } = {}) {
  if (!wsDir) return ''
  const st = stats({ days })
  if (!st.ok) return ''
  const text = mdOf(st.rows, st)
  try {
    fs.mkdirSync(wsDir, { recursive: true })
    fs.writeFileSync(path.join(wsDir, 'health.md'), text)
  } catch (e) { STATE.log('[health] 写 health.md 失败: ' + e.message) }
  return text
}

function init ({ dataRoot, log } = {}) {
  STATE.dataRoot = dataRoot || ''
  if (typeof log === 'function') STATE.log = log
}

function clear () {
  try { fs.unlinkSync(file()) } catch { }
  return { ok: true }
}

module.exports = {
  init, record, list, stats, promptBlock, writeSummary, clear,
  dateKey, normClock, hoursBetween, normMood, file
}
