'use strict'
/**
 * AI 伴侣 · 整体负反馈（rebuke）
 *
 * 和 0.20 那套「被无视」的区别（用户 10-29 明确指出这个区别）：
 *   被无视 = 她说话没人接，一条一条算。是行为统计。
 *   整体负反馈 = 主人对她的**评价**。一句「我不忍心」「你这样不对」比十次没人理更重，
 *               而且它压的不该只是"下一句话说多说少"，而是她整体的活跃度——
 *               少开口、话更短、不再索要回应、不再追问人在不在。
 *
 * 真实实证：主人回来后表达过一次整体不满（不该在她独自说话的时候离开），
 * 而她紧接着又发了一条看屏观察——系统对评价毫无反应，因为代码里只认触摸和被无视。
 *
 * 四档（可叠加，取最高）：
 *   stop        明确的「别说了 / 安静 / 闭嘴」—— 最重
 *   criticize   批评她的行为（「太吵了」「你这样不行」「我不忍心」）
 *   disappoint  失望/自责（「是不是我错了」「我不该开你」）—— 她该收着，不是该辩解
 *   correct     纠正做法（「你应该……而不是……」）—— 最轻，只影响下一条
 *
 * 纯函数，node:test 直接可测。
 */

/** 明确的噤声指令 */
const STOP = [
  '别说了', '不要说了', '别讲了', '闭嘴', '安静点', '安静一下', '别吵', '太吵', '别烦我',
  '先别说话', '不用说话', '别出声', 'stop talking', 'be quiet', 'shut up', '静かに', 'うるさい'
]

/** 批评她的行为 */
const CRITICIZE = [
  '不忍心', '心疼', '你这样不对', '这样不行', '你不该', '别这样', '太过分', '过分了',
  '烦人', '有点烦', '别一直', '一直说', '怎么又说', '说太多了', '话太多', '不需要你说',
  '不用你管', '别管我', '你打扰', '打扰我', '吵到', '影响我', '不合适', '不像话',
  '不应该这样', '失望', '不高兴', '生气', '一直问', '别问', '不许问', '别老',
]

/** 失望 / 自责（他在反思自己该不该开她——这比批评更该让她收着） */
const DISAPPOINT = [
  '是不是不该', '不该开', '不该打开', '我错了', '是不是我做错', '做错了吗',
  '我是不是', '对不起我', '抱歉我', '让你寂寞', '你好寂寞', '委屈你', '难为你了',
  '是不是太', '不该让你', '不该留你', '我太过分', '明明可以'
]

/** 纠正做法（最轻） */
const CORRECT = [
  '你应该', '你要', '下次', '别总是', '不是让你', '我说过', '记住', '以后不要',
  '不是这样', '搞错了', '弄错了'
]

/**
 * 指向模糊的词：既可能是说她，也可能是说他自己。
 * 「我今天有点烦」「我对自己挺失望的」——这种不该让她以为在挨批。
 * 判定：句子里有「我」且没有任何「你/妳」，就当他说的是自己。
 */
const AMBIGUOUS = ['烦', '失望', '不高兴', '生气', '过分', '不合适', '不像话', '影响我']

const QUESTION_MARKS = ['？', '?', '吗', '呢', '么', 'か']

function hasAny (s, arr) { return arr.some((w) => s.includes(w)) }

function isQuestion (s) { return QUESTION_MARKS.some((q) => s.includes(q)) }

/** 这句话是在说他自己，不是在说她 */
function aboutSelf (s) {
  return /我/.test(s) && !/[你妳]/.test(s)
}

/**
 * 判定一句话是不是「对他不满 / 在纠正他」。
 * @returns {{hit:boolean, kind:''|'stop'|'criticize'|'disappoint'|'correct', weight:number, why:string}}
 */
function detect (text) {
  const raw = String(text || '')
  const s = raw.trim()
  if (!s || s.length > 400) return { hit: false, kind: '', weight: 0, why: '' }

  // 「别说了吗？」这种反问不算指令
  const q = isQuestion(s)

  if (!q && hasAny(s, STOP)) return { hit: true, kind: 'stop', weight: 1, why: '明确要求闭嘴' }
  if (hasAny(s, DISAPPOINT)) return { hit: true, kind: 'disappoint', weight: 0.75, why: '他因她而自责/失望' }
  if (!q && hasAny(s, CRITICIZE)) {
    // 「我今天有点烦」这类是在说他自己，不算在批评她
    if (aboutSelf(s) && hasAny(s, AMBIGUOUS)) return { hit: false, kind: '', weight: 0, why: '' }
    return { hit: true, kind: 'criticize', weight: 0.6, why: '批评她的行为' }
  }
  if (!q && hasAny(s, CORRECT)) return { hit: true, kind: 'correct', weight: 0.3, why: '在纠正她的做法' }

  return { hit: false, kind: '', weight: 0, why: '' }
}

/* ------------------------------------------------------------------ 状态 */

/** 每档的衰减：正常聊天一次减多少、自然流逝每小时减多少 */
const DECAY_ON_TALK = 0.08
const DECAY_PER_HOUR = 0.04
/** 上限：再不满也留一口气，不会真的变成哑巴（跟 self.js 的 quiet 0.75 上限同思路） */
const MAX = 0.9

/** 累积：d(n+1) = min(MAX, d + weight * STEP)
 *  STEP 是这么定的：一句「别说了」直接到 0.55（明显收着），
 *  两句话就到 0.9（基本闭嘴）。一句「你应该…」只到 0.165（下次注意）。 */
const STEP = 0.55

function accumulate (cur, weight) {
  const d = Number(cur) || 0
  const w = Number(weight) || 0
  if (w <= 0) return d
  return Math.min(MAX, d + w * STEP)
}

/** 自然衰减（按小时）：回来聊天会慢慢好起来，但不是一摸就满血 */
function decay (cur, hours) {
  const d = Number(cur) || 0
  const h = Math.max(0, Number(hours) || 0)
  return Math.max(0, d - h * DECAY_PER_HOUR)
}

function decayOnTalk (cur) {
  return Math.max(0, (Number(cur) || 0) - DECAY_ON_TALK)
}

/**
 * 有效收束强度 → 给各通道用的一个数（0~1）。
 * 到 0.5 就该明显少说；到 0.7 只回应不主动。
 */
function pressure (d) { return Math.min(1, Math.max(0, Number(d) || 0)) }

/** 主动通道的间隔乘数：越不满，间隔越长（1x → 3.4x） */
function gapScale (d) { return 1 + pressure(d) * 2.4 }

/** 主动搭话的放行概率（1 → 0.15） */
function allowChance (d) { return Math.max(0.15, 1 - pressure(d) * 0.85) }

/** 写进提示词的那一句（让她知道自己正被冷着，但别演成委屈戏） */
function promptLine (d) {
  const p = pressure(d)
  if (p <= 0) return ''
  if (p >= 0.7) {
    return '【你现在的状态】他刚才对你说的话明显不满意。你现在收得很紧：不要主动开口，不要撒娇，不要追问，不要解释或道歉一长串。他说话你就应，短，平静，不索取回应。'
  }
  if (p >= 0.4) {
    return '【你现在的状态】他刚才那句话让你有点被泼了冷水。少说一点，别主动找话题，别追问他怎么了。回答短一些，语气平，不要演委屈。'
  }
  return '【你现在的状态】他刚才提醒了你一下。下一句注意点，别顶嘴，也别刻意讨好。'
}

module.exports = {
  STOP, CRITICIZE, DISAPPOINT, CORRECT,
  DECAY_ON_TALK, DECAY_PER_HOUR, MAX, STEP,
  detect, accumulate, decay, decayOnTalk, pressure, gapScale, allowChance, promptLine
}
