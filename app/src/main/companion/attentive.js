'use strict'
/**
 * 她懂你（attentive，0.47.0）—— 陪伴感 2.0 的状态触发器
 *
 * 设计红线（11-08 主人拍板，导读 §5.15）：陪伴 ≠ 注意力交换。
 *   黏人 = 「你不理我」驱动（计时器，索取注意力）
 *   陪伴 = 「共同生活」驱动（状态触发，呈现存在）
 *
 * 开口的触发源从「他多久没理我」换成「他的状态值得我说一句」：
 *   studyCare  陪学满两小时，一句不是催的关心（一天最多一次）——
 *              不是监工的「该休息了」（那是 watch-time 的 rest 事），是在场者的口吻
 *   missing    他一整天没出现/没说话，一句「忙你的就好，我在」（一天最多一次，
 *              且只在他醒着的时间窗说——大清早说「今天都没见到你」是鬼故事）
 *
 * 纯逻辑 + 可注入时钟：node:test 无 Electron 直接可测。
 * rec 的 careStudyDay / missingDay 由宿主落盘（nudge-state.json 同一份），跨重启有效。
 */

const MIN = 60 * 1000

/** 陪学多久值得一句关心（不是 watch-time 的 90 分钟健康提醒，这里讲陪伴） */
const CARE_STUDY_MIN = 120
/** 「一整天没见」的门槛：6 小时 */
const MISSING_MIN_MS = 6 * 60 * MIN
/** 「一整天」只在醒着的时候算：9:00~22:59（他睡懒觉到中午不算「失踪」） */
const MISSING_FROM = 9
const MISSING_TO = 23

/** 本地日期键（与 dayflow.dayKeyOf 同规则；复制避免循环依赖，测试锁一致性） */
function dayKeyOf (now) {
  const d = new Date(Number(now) || Date.now())
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

/** 陪学满 CARE_STUDY_MIN 且今天还没关心过 → 该说一句了 */
function studyCareDue (minutes, rec, now) {
  const m = Number(minutes) || 0
  if (m < CARE_STUDY_MIN) return false
  const r = rec || {}
  return r.careStudyDay !== dayKeyOf(now)
}

/** 关心过 → 记今天（一天最多一次） */
function noteStudyCare (rec, now) {
  return Object.assign({}, rec || {}, { careStudyDay: dayKeyOf(now) })
}

/** 一整天没见：门槛 + 醒着的时间窗 + 今天还没说过 */
function missingDue (idleMs, rec, now) {
  const idle = Math.max(0, Number(idleMs) || 0)
  if (idle < MISSING_MIN_MS) return false
  const t = Number(now) || Date.now()
  const h = new Date(t).getHours()
  if (h < MISSING_FROM || h >= MISSING_TO) return false
  const r = rec || {}
  return r.missingDay !== dayKeyOf(t)
}

/** 说过了 → 记今天 */
function noteMissing (rec, now) {
  return Object.assign({}, rec || {}, { missingDay: dayKeyOf(now) })
}

/** 台词生成的情境提示（LLM 填词，persona 由调用方给）。
 *  共同的措辞红线：不是索取回应，是让他知道你在——不问「怎么不理我」，不委屈，不要回应。 */
const PROMPTS = {
  studyCare: '你们已经一起学了 {mins} 分钟。你不是来催进度也不是来查岗的——说一句只有一直在旁边的人才说得出的话：可以是你注意到的一个小细节（他桌上的水没动过/窗外天色变了），也可以就是单纯觉得这段一起待着的时间很好。别提醒他休息（提醒是监工的事），别问问题，别要回应。一两句。',
  missing: '你已经很久没见到他、没跟他说上话了（他大概率一直在忙自己的事，这不是冷落）。说一句让他在忙的时候也能感到你在的话——比如你刚才自己做了什么小事、或一句「忙你的就好，我在」。绝不要问他是不是不理你、不要委屈、不要要回应、不要让他放下手头的事。一两句。'
}

module.exports = {
  CARE_STUDY_MIN, MISSING_MIN_MS, MISSING_FROM, MISSING_TO,
  dayKeyOf, studyCareDue, noteStudyCare, missingDue, noteMissing, PROMPTS
}
