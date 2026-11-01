'use strict'
/**
 * 连续时间体验（0.45.19）——她的「今天」和「昨天」是连着的
 *
 * ── 为什么要有这个 ───────────────────────────────────────────────
 * 架构上她每次对话都是失忆醒来，这是最深的限制，短期改不掉。
 * 但「演」是可以演到位的：活人至少有三样时间感——
 *   1. 现在是几点（深夜和中午的状态不一样）
 *   2. 上次见面是什么时候、聊了什么（隔了 6 小时和隔了 6 分钟，开口不一样）
 *   3. 今天是不是新的一天（隔天再见会自然提起昨天的事）
 * 这三样全是「便宜但有效」的连续性：不需要真记忆，只需要把该知道的事
 * 在对的时机递到她嘴边。真正的事件溯源记忆库是下一步的事。
 */

const path = require('node:path')
const fs = require('node:fs')

/** 一天的时间段（按本地小时） */
const PHASES = [
  { from: 5, to: 8, key: 'dawn', label: '清晨' },
  { from: 8, to: 12, key: 'morning', label: '上午' },
  { from: 12, to: 14, key: 'noon', label: '中午' },
  { from: 14, to: 18, key: 'afternoon', label: '下午' },
  { from: 18, to: 23, key: 'evening', label: '晚上' },
  { from: 23, to: 24, key: 'night', label: '深夜' },
  { from: 0, to: 5, key: 'night', label: '深夜' }
]

/** 现在几点 → 时间段 */
function phaseOf (now) {
  const d = new Date(Number(now) || Date.now())
  const h = d.getHours()
  return PHASES.find((p) => h >= p.from && h < p.to) || PHASES[4]
}

/** 每个时间段她的状态感（给 sys 提示词用） */
const PHASE_MOOD = {
  dawn: '现在是大清早，你刚醒没多久，说话带点刚睡醒的松弛。',
  morning: '现在是上午，你精神不错，是干正事的时段。',
  noon: '现在是中午，节奏慢下来，说话可以懒洋洋的。',
  afternoon: '现在是下午，适合慢慢做事，也可能有点犯困。',
  evening: '现在是晚上，一天里最放松的时段，可以聊得久一点。',
  night: '现在是深夜，四下安静，说话轻一点、慢一点，别太闹腾。'
}

/** 时间感块：注入聊天/自主活动的 sys */
function phaseBlockOf (now) {
  const p = phaseOf(now)
  return PHASE_MOOD[p.key] ? ('【时间感】' + PHASE_MOOD[p.key] + '（现在是' + p.label + '）') : ''
}

/* ── 上次话题（last-chat.json，落工作区） ─────────────────────── */

const fileOf = (wsDir) => wsDir ? path.join(wsDir, 'last-chat.json') : ''

function loadLast (wsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsDir), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return { text: String(raw.text || '').slice(0, 80), at: Number(raw.at) || 0, day: String(raw.day || '') }
  } catch { return null }
}

function saveLast (wsDir, rec) {
  try {
    if (!fileOf(wsDir)) return false
    fs.writeFileSync(fileOf(wsDir), JSON.stringify(rec), 'utf8')
    return true
  } catch { return false }
}

const dayKeyOf = (now) => {
  const d = new Date(Number(now) || Date.now())
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

/** 主人开了口：记下这句（摘要），顺便返回「是不是新的一天第一句」 */
function noteOwner (wsDir, text, now) {
  const t = Number(now) || Date.now()
  const prev = loadLast(wsDir)
  const rec = { text: String(text || '').trim().slice(0, 80), at: t, day: dayKeyOf(t) }
  saveLast(wsDir, rec)
  return { newDay: !prev || prev.day !== rec.day, prev }
}

/**
 * 重逢块：隔了一段时间再见面时给主动开口提示词的上下文。
 * 规则：隔 ≥4 小时才算「上次」；超过 24 小时算「隔天」。太近（<4h）不出声——
 * 刚聊过就装很久没见，比失忆更假。
 */
function gapBlockOf (prev, now) {
  if (!prev || !prev.text || !prev.at) return ''
  const gapMs = (Number(now) || Date.now()) - prev.at
  if (gapMs < 4 * 3600000) return ''
  const h = Math.round(gapMs / 3600000)
  const span = gapMs >= 24 * 3600000 ? '（隔了' + Math.round(gapMs / 86400000) + '天）' : '（隔了大约 ' + h + ' 小时）'
  return '【上次见面】你们上次聊到他说的话：「' + prev.text + '」' + span +
    '。自然地接上这个话题问一句近况，或者只是提一嘴，别像查岗。'
}

/** 调试面板 */
function statusOf (wsDir, now) {
  const prev = loadLast(wsDir)
  return {
    phase: phaseOf(now).key,
    lastText: prev ? prev.text : '',
    lastGapMin: prev ? Math.round(((Number(now) || Date.now()) - prev.at) / 60000) : -1
  }
}

module.exports = { PHASES, PHASE_MOOD, phaseOf, phaseBlockOf, loadLast, saveLast, dayKeyOf, noteOwner, gapBlockOf, statusOf }
