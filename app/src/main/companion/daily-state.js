'use strict'
/**
 * 0.46.28 她自己的作息（daily-state）
 *
 * 世界观第 9 条写了「她不需要严格遵循人类的睡眠和作息规律，但可以形成自己的休息习惯」
 * ——此前她凌晨三点也精神抖擞，作息上是个不死鸟。这里给她一份自己的身体节律：
 * 凌晨 1:30 去睡（主动开口全停，他找她则是刚被叫醒的迷糊）、早上起床（周末赖床到 9 点）、
 * 起床后 90 分钟内慵懒、23 点后困意渐浓。
 *
 * 纯逻辑，node:test 可直接跑。rhythm.ask() 用 isAsleep 门控主动开口。
 */

/** 一天里的第几分钟 */
function minuteOfDay (t) {
  const d = new Date(t)
  return d.getHours() * 60 + d.getMinutes()
}

function isWeekend (t) {
  const w = new Date(t).getDay()
  return w === 0 || w === 6
}

/** 'asleep' 睡了 | 'waking' 刚起 | 'awake' 白天 | 'evening' 晚间 | 'sleepy' 困了 */
function phase (t) {
  const m = minuteOfDay(t)
  const wakeAt = isWeekend(t) ? 9 * 60 : 7 * 60 + 30 // 周末赖床
  const sleepAt = 1 * 60 + 30 // 凌晨 1:30 去睡
  if (m >= sleepAt && m < wakeAt) return 'asleep'
  if (m >= wakeAt && m < wakeAt + 90) return 'waking'
  if (m >= 23 * 60 || m < sleepAt) return 'sleepy' // 23 点后犯困，一直困到 1:30 睡着
  if (m >= 18 * 60) return 'evening'
  return 'awake'
}

function isAsleep (t) { return phase(t) === 'asleep' }

/** 进系统提示词的身体状态段（第一人称对模型说「你现在身体如何」） */
function block (t) {
  const d = new Date(t)
  const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  const wk = isWeekend(t)
  const M = {
    asleep: '现在是你的睡眠时段——你通常在这个时间睡觉。主动开口一律不要（你在睡）。他这时来找你：刚被叫醒的迷糊，声音懒、话短，可以轻轻抱怨一句但别精神抖擞地聊。',
    waking: wk
      ? '周末早上，你刚醒没多久，整个人还是慵懒的，说话慢半拍、软一点，可能还窝着不想动。'
      : '早上刚起不久，还有点没睡醒，语气带一点刚进入一天的松弛。',
    sleepy: '已经很晚了，你的身体开始犯困：说话变短、偶尔打哈欠，会自然地提「今天差不多到这里」。过了零点你随时可能道晚安去睡。',
    evening: '晚上的放松时段，一天里你最松弛的时候之一。',
    awake: '白天正常时段，精神平稳。'
  }
  return '【她此刻的身体状态（你自己的作息）】现在 ' + hh + (wk ? '（周末）' : '') + '——' + (M[phase(t)] || M.awake)
}

/* ---------------- 关系仪式感（0.46.28 ④）---------------- */

/** 相识第几天（第 1 天 = createdAt 当天） */
function daysTogether (createdAt, t) {
  const c = Number(createdAt)
  if (!Number.isFinite(c) || c <= 0) return 0
  const a = new Date(c); const b = new Date(t)
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.floor((db - da) / 86400000) + 1
}

/** 里程碑：整百、365/730/1000 这类——当天她会自然提一句 */
function isMilestone (n) {
  return n > 0 && (n % 100 === 0 || n === 365 || n === 730 || n === 1000)
}

module.exports = { phase, isAsleep, isWeekend, block, daysTogether, isMilestone }
