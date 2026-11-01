'use strict'
/**
 * 健康记录工具的宿主实现（0.24.0）
 *
 * 核心只声明 schema（core/tools/health.js），写入/统计在这里落地。
 * 数据：<userData>/health/log.jsonl；摘要：<workspace>/health.md
 */
const { log } = require('./logger')

function mod () {
  return require('./health')
}

/** 把「昨天 / 前天 / 今天」换成日期 */
function resolveDate (v) {
  const s = String(v == null ? '' : v).trim()
  const today = new Date()
  if (!s || /^(今天|today|刚才|刚刚)$/i.test(s)) return mod().dateKey(today)
  if (/^(昨天|yesterday)$/i.test(s)) { const d = new Date(today.getTime() - 86400000); return mod().dateKey(d) }
  if (/^(前天)$/i.test(s)) { const d = new Date(today.getTime() - 2 * 86400000); return mod().dateKey(d) }
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0')
  return mod().dateKey(today)
}

function currentWs () {
  try {
    const cfgMod = require('./config')
    const role = cfgMod.getConfig().currentRole
    return require('./assistant').workspaceDirFor(role) || ''
  } catch { return '' }
}

async function healthLog (args = {}) {
  const h = mod()
  const r = h.record({
    date: resolveDate(args.date),
    sleepBed: args.sleep_bed,
    sleepWake: args.sleep_wake,
    sleepHours: args.sleep_hours,
    bpSys: args.bp_sys,
    bpDia: args.bp_dia,
    pulse: args.pulse,
    mood: args.mood,
    moodNote: args.mood_note,
    weight: args.weight,
    source: 'chat'
  })
  if (!r.ok) return r
  /* 顺手刷新工作区里的摘要（她下次说话时上下文里就有最新的） */
  try { h.writeSummary(currentWs(), { days: 14 }) } catch { }
  log('[health] 聊天记录一条: ' + JSON.stringify(r.entry))
  const e = r.entry
  const bits = []
  if (e.sleep) {
    const s = e.sleep
    bits.push('睡眠 ' + (s.bed ? s.bed + ' 入睡 ' : '') + (s.wake ? s.wake + ' 起床 ' : '') + (s.hours ? s.hours + ' 小时' : '')).toString()
  }
  if (e.bp) bits.push('血压 ' + e.bp.sys + '/' + (e.bp.dia || '-') + (e.bp.pulse ? ' 心率 ' + e.bp.pulse : ''))
  if (e.mood) bits.push('心态 ' + (e.mood.score != null ? e.mood.score + '/10' : '') + (e.mood.note ? '（' + e.mood.note + '）' : ''))
  if (e.weight != null) bits.push('体重 ' + e.weight + 'kg')
  return { ok: true, date: e.date, recorded: bits.join('，'), message: '记下了（' + e.date + '）：' + bits.join('，') }
}

async function healthRead (args = {}) {
  const h = mod()
  const days = Math.max(1, Math.min(180, Number(args.days) || 14))
  const st = h.stats({ days })
  if (!st.ok) return { ok: false, days, message: '这 ' + days + ' 天还没有任何健康记录。可以问问他昨晚几点睡、血压多少，记下来之后就能看趋势了。' }
  const lines = []
  if (st.sleep.nights) {
    lines.push('睡眠：' + st.sleep.nights + ' 晚有数据，平均 ' + st.sleep.avgHours + ' 小时（' + st.sleep.minHours + '~' + st.sleep.maxHours + '）' +
      (st.sleep.avgBed ? '，平均 ' + st.sleep.avgBed + ' 入睡' : '') +
      (st.sleep.lateNights ? '，' + st.sleep.lateNights + ' 天凌晨 1 点后才睡' : ''))
  }
  if (st.bp.readings) {
    lines.push('血压：' + st.bp.readings + ' 次，平均 ' + st.bp.avgSys + '/' + (st.bp.avgDia || '-') + '，最高收缩压 ' + st.bp.maxSys +
      (st.bp.highCount ? '，' + st.bp.highCount + ' 次偏高' : '，都正常'))
  }
  if (st.mood.entries) lines.push('心态：平均 ' + st.mood.avg + '/10' + (st.mood.lowCount ? '，' + st.mood.lowCount + ' 天很低落' : ''))
  lines.push('逐日：')
  for (const r of st.rows.slice(-14)) {
    const bits = []
    if (r.sleep) bits.push((r.sleep.bed || '?') + '→' + (r.sleep.wake || '?') + (r.sleep.hours ? ' ' + r.sleep.hours + 'h' : ''))
    if (r.bp) bits.push(r.bp.sys + '/' + (r.bp.dia || '-'))
    if (r.mood && r.mood.score != null) bits.push('心情' + r.mood.score)
    if (r.weight != null) bits.push(r.weight + 'kg')
    lines.push('· ' + r.date + ' ' + bits.join(' '))
  }
  return { ok: true, days, recordedDays: st.recordedDays, text: lines.join('\n') }
}

async function invoke (name, args = {}) {
  switch (name) {
    case 'health_log': return healthLog(args)
    case 'health_read': return healthRead(args)
    default: throw new Error('未知的健康工具: ' + name)
  }
}

module.exports = { invoke, resolveDate }
