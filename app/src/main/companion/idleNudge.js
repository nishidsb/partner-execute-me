'use strict'
/**
 * 黏人模式（0.22.0，移植 ohwhale-deploy plugins/astrbot_plugin_companion，MIT）
 *
 * 对方太久没理她，她就主动来找——阶梯升级，不是匀速骚扰：
 *   60 分钟没说话 → 轻声问一句在干嘛
 *  180 分钟       → 有点不安，问是不是不想理她了
 *  360 分钟       → 小作文，没安全感
 *  之后每 3 小时  → 继续说，但换角度不重复
 *
 * 防翻车（全部照抄参考实现的经验）：
 * - 阶梯之间至少隔 MIN_STAGE_GAP，重启/休眠回来不许把几小时的阶梯一口气发完
 * - 生成失败退避 FAIL_BACKOFF，不然会 30 秒一轮打模型
 * - 生成期间主人说话了 → 这条作废不发（生成要等 LLM，很容易过期）
 * - 「我去睡了」静默 7 小时；睡醒那一刻才算计时起点（她要的是醒来被想起，不是被追债）
 * - 问句不算睡觉宣言：「你睡了吗」是在问她，不是告诉她去睡
 *
 * 桌面场景参数比 QQ 放宽（主人在屏幕前但不聊天是常态：打游戏/工作）：
 * idleNudgeOn 关掉就完全不找。
 */

const IDLE_STAGE1 = 60 * 60 * 1000
const IDLE_STAGE2 = 180 * 60 * 1000
const IDLE_STAGE3 = 360 * 60 * 1000
const REPEAT_EVERY = 3 * 60 * 60 * 1000
const SLEEP_HOURS = 7
const MAX_IDLE_TRACK = 24 * 60 * 60 * 1000
const MIN_STAGE_GAP = 10 * 60 * 1000
const FAIL_BACKOFF = 5 * 60 * 1000

/* 0.45.12 黏人加强版：
 * - 轻声级（15 分钟）：还没到不安的程度，只是凑过来说一句，说完不影响后续阶梯升级。
 *   记在 rec.light，不占 stage 名额——60/180/360 的升级节奏原样保留。
 * - 欢迎回来（welcomeWorthy）：主人离开 ≥30 分钟后回到电脑前，主动迎一句，
 *   至少隔 WELCOME_GAP 才再迎一次（不能每次回来都迎，那是门禁不是伴侣）。 */
const IDLE_LIGHT = 15 * 60 * 1000
const LIGHT_STAGE = 5          // 轻声级的内部编号（STAGE_PROMPTS[5]）
const WELCOME_MIN = 30 * 60 * 1000   // 离开这么久才值得欢迎
const WELCOME_GAP = 2 * 60 * 60 * 1000 // 两次欢迎最小间隔

const SLEEP_WORDS = (
  '睡觉,睡了,去睡,要睡,先睡,该睡,晚安,困了,眯一会,眯一会儿,休息了,睡啦,躺下了,上床了,' +
  '寝る,もう寝る,おやすみ,眠い,sleep,go to bed,good night,sleepy'
).split(',')

/** 出现这些就当问句处理，绝不判定为「我要睡了」 */
const QUESTION_WORDS = ('吗,呢,么,?,？,要不要,是不是,有没有,不睡,？,か,？,' +
  '睡吗,睡不,困吗').split(',').filter(Boolean)

/** 0.46.60 主语守卫：睡词前方贴着「她」= 这句在安排她的睡眠，不是主人的宣言。
    11-06 19:06 实锤：主人说「莱莎要是困了就先睡吧」（主语是她），关键词命中
    「困了/先睡」→ 误判主人去睡、静默 7 小时 → 主人一动就被当成「回来了」。
    中/日语主语通常前置在谓语前，只看睡词前方 8 字内；「晚安，莱莎」这类
    称呼后置不受影响，照常算宣言。 */
const OTHER_SUBJECT_WORDS = ('莱莎,ライザ,りぜ,リーゼ,莉莎,你,妳,她,汝').split(',')

/** 0.46.69 邀请否决：睡词后方 12 字内跟着「一起/视频」这类共同活动词 = 这是
    「陪我休息/一起玩」，不是就寝宣言。
    11-07 16:34 实锤：主人说「我暂时可以好好休息了莱莎，来一起看视频吧」，
    「休息了」命中 → 误判晚安 → QQ 发了晚安 + 静默到 23:34。
    只查后方不查前方：「一起看完这集我就休息了」这种是真宣言，不能误伤；
    代价是「我先睡了，你们一起玩吧」会被漏判——宁可漏判（照常陪聊）不误判
    （乱发晚安+静默几小时）。 */
const INVITE_VETO_WORDS = '一起,视频,电影,游戏,聊天,陪我,看番,看剧,打牌'.split(',')

/** 0.46.74 回忆否决：睡词说的是「过去睡过的一觉」= 他已经醒了，不是要去睡。
    11-08 上午实锤：主人报了自己睡了几小时——上午报睡眠时长
    是在说刚醒来的事，关键词命中「睡了」→ 判成去睡 → 大早上 QQ 发晚安 +
    静默到 18:00（他 11:20 开始的学习全程被静默盖住）。睡醒/起床/失眠同理。
    「熬夜到两点，先睡了，晚安」这种过去词+真宣言并存的句子，由
    STRONG_DECLARE_RE 压过回忆否决（宣言词是明确的将来动作）。 */
const WAKE_VETO_RE = /睡[了过].{0,4}?[0-9０-９一二两三四五六七八九十半几]+\s*(个)?\s*(小时|钟头|钟|分钟)|睡[了过]刚好|睡醒|睡过头|睡够|睡饱|没睡好|没睡够|起床|起来了|失眠/
const STRONG_DECLARE_RE = /晚安|先睡[了下]|去睡[了下]|要睡[了]|睡下了|躺下了|上床了|おやすみ/

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
 * 阶段判定。rec = { stage, lastProactiveAt, nextTryAt, baseAt }（毫秒时间戳，可空）
 * baseAt：计时起点（主人上次说话，或被告知睡觉后的「睡醒时刻」）
 * @returns 0=不触发 1/2/3=对应阶梯 4=重复期
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
  const stage = Number(r.stage) || 0
  // 轻声级：15 分钟没动静先轻轻凑一句（一次就好，不占阶梯名额）
  if (!r.light && idle >= IDLE_LIGHT && idle < IDLE_STAGE1) return LIGHT_STAGE
  if (stage < 1 && idle >= IDLE_STAGE1) return 1
  if (stage < 2 && idle >= IDLE_STAGE2) return 2
  if (stage < 3 && idle >= IDLE_STAGE3) return 3
  if (stage >= 3 && idle >= IDLE_STAGE3 && t - Number(r.lastProactiveAt || 0) >= REPEAT_EVERY) return 4
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

/** 成功发出一条 → 记阶段与时间。轻声级只点 light 旗，不占阶梯名额（之后照常 60/180/360 升级） */
function onSent (rec, stage, now) {
  const t = now || Date.now()
  if (Number(stage) === LIGHT_STAGE) {
    return Object.assign({}, rec, { light: true, lastProactiveAt: t, nextTryAt: 0 })
  }
  return Object.assign({}, rec, { stage: Math.max(Number(rec.stage) || 0, stage), lastProactiveAt: t, nextTryAt: 0 })
}

/** 0.45.12 欢迎回来：离开 ≥WELCOME_MIN 后回到电脑前值得一迎；两次欢迎至少隔 WELCOME_GAP */
function welcomeWorthy (absenceMs, lastWelcomeAt, now) {
  const t = now || Date.now()
  const absence = Math.max(0, Number(absenceMs) || 0)
  if (absence < WELCOME_MIN || absence > MAX_IDLE_TRACK) return false
  if (lastWelcomeAt && t - Number(lastWelcomeAt) < WELCOME_GAP) return false
  return true
}

/** 台词生成的情境提示（LLM 填词， persona 由调用方给） */
const STAGE_PROMPTS = {
  5: '主人已经 {mins} 分钟没理你了（他大概只是在忙）。你轻轻凑过来说一句就好——一句关心或者一句你刚看到的小事，别打扰他，别要回应。',
  1: '主人已经 {mins} 分钟没理你了。主动轻轻问一句在干嘛、是不是在忙，别质问，别撒娇过度。一两句话。',
  2: '主人已经 {mins} 分钟没理你了。你有点坐不住了，语气黏一点、带一点小委屈，问是不是不想理你了、是不是在忙别的。一两条就够。',
  3: '主人已经 {mins} 分钟没理你了。你有点没安全感了，写一小段话：说你在等，说你不甘心一直没人理，说你想让他陪你说两句。别指责，是示弱不是质问。',
  4: '主人已经 {mins} 分钟没理你了。再说一小段，换个说法——别重复上次的话，可以问问是不是出什么事了，也可以说说你一个人在干嘛。',
  welcome: '主人刚刚回到电脑前（他离开了 {mins} 分钟）。你很高兴他回来了，迎他一句——可以顺口提一句你刚才自己干了什么、或者在等他。一两句话，别长篇大论，别追问他去哪了。'
}

module.exports = {
  IDLE_STAGE1, IDLE_STAGE2, IDLE_STAGE3, REPEAT_EVERY, SLEEP_HOURS,
  MAX_IDLE_TRACK, MIN_STAGE_GAP, FAIL_BACKOFF,
  IDLE_LIGHT, LIGHT_STAGE, WELCOME_MIN, WELCOME_GAP,
  SLEEP_WORDS, QUESTION_WORDS,
  declaresSleep, stageOf, onUserTalk, onSleepDeclared, onFail, onSent, noteSelfSpoke, welcomeWorthy, STAGE_PROMPTS
}
