'use strict'
/**
 * 主动开口的「关系事件」判定（原黏人模式，0.22.0 移植 ohwhale-deploy，MIT；0.47.0 触发源重构）
 *
 * ⚠️ 0.47.0 设计红线（11-08 主人拍板，导读 §5.15）：陪伴 ≠ 注意力交换。
 * 原来的 15/60/180/360 分钟阶梯（轻声凑一句 → 问在干嘛 → 黏一点带委屈 → 没安全感小作文
 * → 每 3h 换角度续）是「他多久没理我」的计时器，产出的是愧疚感不是陪伴感——
 * 主人原话：「陪伴感更多是依靠黏人模式来的，我要的不是这种」。阶梯整体拆除。
 *
 * 现在剩下的「关系事件」只有两件，都由状态触发、一天最多一次：
 *   missing   他一整天（≥6h）没出现/没说话，一句「忙你的就好，我在」
 *             ——只在醒着的时间窗说（attentive.js 管判定）
 *   welcome   他离开一阵子回到电脑前，迎一句（状态触发，保留）
 *
 * 防翻车（沿用参考实现攒下的经验，全部保留）：
 * - 阶梯之间至少隔 MIN_STAGE_GAP，重启/休眠回来不许把几小时的量一口气发完
 * - 生成失败退避 FAIL_BACKOFF，不然会 30 秒一轮打模型
 * - 生成期间主人说话了 → 这条作废不发（宿主 tick 里比对 baseAt）
 * - 「我去睡了」静默 7 小时；睡醒那一刻才算计时起点；sleepArmed 到期 ≠ 他醒了
 * - 问句不算睡觉宣言、主语是她不算、邀请共同活动不算、回忆睡眠不算、白天不判、
 *   将来时不判（「再过一眼公式就躺下了」= 还没走，0.47.3）
 *
 * 桌面场景参数比 QQ 放宽（主人在屏幕前但不聊天是常态：打游戏/工作）：
 * idleNudgeOn 关掉就完全不找。
 */

const attentive = require('./attentive')

const SLEEP_HOURS = 7
const MAX_IDLE_TRACK = 24 * 60 * 60 * 1000
const MIN_STAGE_GAP = 10 * 60 * 1000
const FAIL_BACKOFF = 5 * 60 * 1000
// 欢迎回来（保留：状态触发，不是索取）——离开这么久才值得迎，两次至少隔这么久
const WELCOME_MIN = 30 * 60 * 1000
const WELCOME_GAP = 2 * 60 * 60 * 1000

const SLEEP_WORDS = (
  '睡觉,睡了,去睡,要睡,先睡,该睡,晚安,困了,眯一会,眯一会儿,休息了,睡啦,躺下了,上床了,' +
  '寝る,もう寝る,おやすみ,眠い,sleep,go to bed,good night,sleepy'
).split(',')

/** 出现这些就当问句处理，绝不判定为「我要睡了」 */
const QUESTION_WORDS = ('吗,呢,么,?,？,要不要,是不是,有没有,不睡,？,か,？,' +
  '睡吗,睡不,困吗').split(',').filter(Boolean)

/** 0.46.60 主语守卫：睡词前方贴着「她」= 这句在安排她的睡眠，不是主人的宣言。
    11-06 19:06 实锤：主人说「要是莱莎困了就先睡吧」（主语是她），关键词命中
    「困了/先睡」→ 误判主人去睡、静默 7 小时 → 主人一动就被当成「回来了」。
    中/日语主语通常前置在谓语前，只看睡词前方 8 字内；「晚安，莱莎」这类
    称呼后置不受影响，照常算宣言。 */
const OTHER_SUBJECT_WORDS = ('莱莎,ライザ,りぜ,リーゼ,莉莎,你,妳,她,汝').split(',')

/** 0.46.69 邀请否决：睡词后方 12 字内跟着「一起/视频」这类共同活动词 = 这是
    「陪我休息/一起玩」，不是就寝宣言。
    11-07 16:34 实锤：主人说「我这边可以好好休息了，来一起看视频吧」，
    「休息了」命中 → 误判晚安 → QQ 发了晚安 + 静默到 23:34。
    只查后方不查前方：「这集看完我就休息了」这种是真宣言，不能误伤；
    代价是「我先睡了，你们一起玩」会被漏判——宁可漏判（照常陪聊）不误判
    （乱发晚安+静默几小时）。 */
const INVITE_VETO_WORDS = '一起,视频,电影,游戏,聊天,陪我,看番,看剧,打牌'.split(',')

/** 0.46.74 回忆否决：睡词说的是「过去睡过的一觉」= 他已经醒了，不是要去睡。
    11-08 11:00 实锤：主人说「睡了几个小时，应该还好吧」——上午报睡眠时长
    是在说刚醒来的事，关键词命中「睡了」→ 判成去睡 → 大早上 QQ 发晚安 +
    静默到 18:00（他 11:20 开始的学习全程被静默盖住）。睡醒/起床/失眠同理。
    「熬夜到两点，先睡了，晚安」这种过去词+真宣言并存的句子，由
    STRONG_DECLARE_RE 压过回忆否决（宣言词是明确的将来动作）。 */
const WAKE_VETO_RE = /睡[了过].{0,4}?[0-9０-９一二两三四五六七八九十半几]+\s*(个)?\s*(小时|钟头|钟|分钟)|睡[了过]刚好|睡醒|睡过头|睡够|睡饱|没睡好|没睡够|起床|起来了|失眠/
const STRONG_DECLARE_RE = /晚安|先睡[了下]|去睡[了下]|要睡[了]|睡下了|躺下了|上床了|おやすみ/

/** 0.47.3 延后宣言否决：「再过一眼公式我就躺下了」= 还差一件事才睡，现在没走。
    11-08 23:39 实锤：主人说「我再过一眼公式我就躺下了，莱莎基本从现在开始
    就可以自由使用电脑了」——「躺下了」命中强宣言词表 → 判成马上去睡 →
    QQ 发晚安 + 桌面静默到早上 6:39（他明明还在，前一句还刚给了她自由用电脑的许可）。
    「再/等/回头/待会/看完/弄完…就(躺下/睡)」是将来时：中间还隔着一件事。
    句子里带真告别（晚安/おやすみ/good night）时压不过告别——说了晚安就是现在说。
    宁漏判不误判：他真去睡了要么补句晚安（照常判），要么直接安静（missing/静音时段兜底）。 */
const DELAY_DECLARE_RE = new RegExp(
  '(?:再|等|回头|待会|呆会|过一?[会眼下]|看完|弄完|忙完|搞完|学完|写完|打完|干完|做完|过完|刷完|复习完|整理完|收拾完)' +
  '[^。！？!?\\n]{0,16}' +
  '(?:(?:就|再|才|然后)?\\s*(?:躺下|上床|去睡|要睡|先睡|该睡|睡觉|休息|睡下了)|(?:就|才)睡)'
)
const FAREWELL_RE = /晚安|おやすみ|good night/i

/** 0.46.74 白天闸：白天（5:00~16:59）根本不存在「就寝宣言」这回事。
    上午说睡词十有八九在说刚醒来的那一觉；判错了代价巨大（QQ 晚安 + 静默 7 小时），
    判漏了代价只是她照常陪聊——宁漏判不误判，白天一律不判。
    只在调用方显式传了 now 才生效（旧测试不传 now 只测文本形状，不受挂钟影响）。 */
const DAY_GATE_FROM = 5
const DAY_GATE_TO = 17

/** 这句是「我要睡了」还是「你睡了吗」——问句一律不算宣言（参考 declaresSleep 修复） */
function declaresSleep (text, now) {
  const s = String(text || '')
  if (!s) return false
  if (QUESTION_WORDS.some((q) => s.includes(q))) return false
  const strong = STRONG_DECLARE_RE.test(s)
  if (WAKE_VETO_RE.test(s) && !strong) return false
  // 0.47.3 延后宣言否决（压过强宣言词表；真告别除外）
  if (DELAY_DECLARE_RE.test(s) && !FAREWELL_RE.test(s)) return false
  if (now != null) {
    const h = new Date(Number(now)).getHours()
    if (h >= DAY_GATE_FROM && h < DAY_GATE_TO) return false
  }
  for (const w of SLEEP_WORDS) {
    let i = s.indexOf(w)
    while (i >= 0) {
      const before = s.slice(Math.max(0, i - 8), i)
      const after = s.slice(i + w.length, i + w.length + 12)
      const subjectOk = !OTHER_SUBJECT_WORDS.some((n) => before.includes(n))
      const noInvite = !INVITE_VETO_WORDS.some((v) => after.includes(v))
      if (subjectOk && noInvite) return true
      i = s.indexOf(w, i + 1)
    }
  }
  return false
}

/**
 * 阶段判定（0.47.0 重构：阶梯没了，只剩「一整天没见」这一件真实需要）。
 * rec = { missingDay, lastProactiveAt, nextTryAt, baseAt, sleepUntil, sleepArmed }（毫秒，可空）
 * baseAt：计时起点（主人上次说话，或被告知睡觉后的「睡醒时刻」）
 * @returns 0=不触发 1=一整天没见（一天最多一次，由 rec.missingDay 保证）
 */
function stageOf (idleMs, rec, now) {
  const t = now || Date.now()
  const r = rec || {}
  const idle = Math.max(0, Number(idleMs) || 0)
  // 0.45.91 睡前静默期内一律不给阶段（唯一真源：调用点散在四处，漏一处她就会半夜开口）。
  // 11-02 实锤：23:39 说了「静默到 06:39」，23:56 还是出了「第 5 阶」。
  if (r.sleepUntil && t < Number(r.sleepUntil)) return 0
  // 0.46.56 睡醒等待：静默到期 ≠ 他醒了。armed 挂着时阶段一律不出——
  // 宿主 tick 见到他真回到电脑前才解除武装并重置计时（否则大清早 QQ 催起床）。
  if (r.sleepArmed && t >= (Number(r.sleepUntil) || 0)) return 0
  if (idle > MAX_IDLE_TRACK) return 0                       // 超过一天不理就不再追了
  if (t < (Number(r.nextTryAt) || 0)) return 0              // 生成失败退避中
  // 距上一条主动消息太近就先忍着（重启回来不许连发）
  if (r.lastProactiveAt && t - Number(r.lastProactiveAt) < MIN_STAGE_GAP) return 0
  // 0.47.0 触发源重构：唯一的开口理由 = 「一整天没见」（attentive 管门槛与时间窗）
  if (attentive.missingDue(idle, r, t)) return 1
  return 0
}

/** 主人说了话 → 计时清零（所有已发阶段作废），并解除睡前静默
 *  0.45.91：原来 sleepUntil 只写在默认参数里，被 rec 里的旧值覆盖掉了 ——
 *  他半夜起来说句话，静默还挂到早上，反而是另一种「不理人」。 */
function onUserTalk (rec, now) {
  const t = now || Date.now()
  return Object.assign({ stage: 0, lastProactiveAt: 0, nextTryAt: 0, baseAt: t, sleepUntil: 0 }, rec, {
    stage: 0, lastProactiveAt: 0, nextTryAt: 0, baseAt: t, sleepUntil: 0, sleepArmed: 0
  })
}

/** 0.46.36 她自己开了口（做梦收尾/自主活动收尾）：记「刚说过话」，之后按最小间隔忍住。
 *  绝不能走 onUserTalk——那会把睡前静默一起清掉（11-04 实锤：00:05 道晚安静默到 07:05，
 *  01:13 做梦完成清了静默，02:39 她 QQ 去「85 分钟没理我了？」——主人睡得好好的）。 */
function noteSelfSpoke (rec, now) {
  return Object.assign({}, rec, { lastProactiveAt: now || Date.now() })
}

/** 主人宣告睡觉 → 静默到睡醒，且计时起点挪到睡醒那一刻。
 *  0.46.56 再补一刀（11-06 投诉「晚安后还一直发消息」）：静默到期 ≠ 他醒了。
 *  sleepArmed 挂着的时候，黏人阶梯（尤其 QQ reach）一律不开——他真的回到
 *  电脑前（宿主 tick 判定）才算「早上好」，计时从头起。否则他还在被窝里，
 *  她按 baseAt=睡醒时刻算出「闲置 15 分钟」就去 QQ 催起床（11-06 06:34/07:42
 *  两条实锤）。 */
function onSleepDeclared (rec, now) {
  const t = now || Date.now()
  const until = t + SLEEP_HOURS * 3600 * 1000
  return Object.assign({ stage: 0, lastProactiveAt: 0, nextTryAt: 0, baseAt: t, sleepUntil: 0 }, rec, {
    stage: 0, lastProactiveAt: 0, nextTryAt: 0, baseAt: until, sleepUntil: until, sleepArmed: 1
  })
}

/** 生成失败 → 退避（不动 stage，之后还能补上） */
function onFail (rec, now) {
  return Object.assign({}, rec, { nextTryAt: (now || Date.now()) + FAIL_BACKOFF })
}

/** 成功发出一条 → 记账。stage 1 = 「一整天没见」，记 missingDay（今天不再说第二次） */
function onSent (rec, stage, now) {
  const t = now || Date.now()
  const r = Object.assign({}, rec, { lastProactiveAt: t, nextTryAt: 0 })
  if (Number(stage) === 1) return attentive.noteMissing(r, t)
  return r
}

/** 0.45.12 欢迎回来：离开 ≥WELCOME_MIN 后回到电脑前值得一迎；两次欢迎至少隔 WELCOME_GAP */
function welcomeWorthy (absenceMs, lastWelcomeAt, now) {
  const t = now || Date.now()
  const absence = Math.max(0, Number(absenceMs) || 0)
  if (absence < WELCOME_MIN || absence > MAX_IDLE_TRACK) return false
  if (lastWelcomeAt && t - Number(lastWelcomeAt) < WELCOME_GAP) return false
  return true
}

/** 台词生成的情境提示（LLM 填词，persona 由调用方给）。
 *  0.47.0：5/2/3/4 阶的「凑过来/委屈/没安全感小作文/换个说法续」全部删除。
 *  措辞红线（§5.15）：不索取回应、不委屈、不追问——她在共同生活，不在讨 attention。 */
const STAGE_PROMPTS = {
  1: attentive.PROMPTS.missing,
  welcome: '主人刚刚回到电脑前（他离开了 {mins} 分钟）。你很高兴他回来了，迎他一句——可以顺口提一句你刚才自己干了什么、或者在等他。一两句话，别长篇大论，别追问他去哪了。'
}

module.exports = {
  SLEEP_HOURS,
  MAX_IDLE_TRACK, MIN_STAGE_GAP, FAIL_BACKOFF,
  WELCOME_MIN, WELCOME_GAP,
  SLEEP_WORDS, QUESTION_WORDS,
  declaresSleep, stageOf, onUserTalk, onSleepDeclared, onFail, onSent, noteSelfSpoke, welcomeWorthy, STAGE_PROMPTS
}
