'use strict'
/**
 * 学习监督（0.45.68）
 *
 * 设计动机（来自真实使用反馈）：学习模式要真的能帮主人学习，而不是只是一个开关——
 * 优化方式是如果跟角色说好要学习，会不定时的过来看一眼屏幕，
 * 如果在玩游戏或者看其他的视频就会过来指责小生气，持续这样就会彻底生气，
 * 所有行为都会记录在长期记忆中。」
 *
 * 与 0.22.0「陪学计时器」的根本区别：
 * 那时候她只是每 15 分钟盲问一句「还在学吗」——她根本不知道屏幕上是行测还是原神，
 * 于是「查岗」退化成一个人肉闹钟。这里加的是**视觉抽查 + 怨气累积**：
 *
 * 1. 只有「说好要学」才有契约（contract）。0.45.12 的自动陪学检测到学习场景就静音陪着，
 *    他没跟你约定，凭什么指责他——那条路绝不走监督逻辑，否则是无端指责，会让人烦。
 * 2. 抽查间隔随机（9~21 分钟），抓现行后有概率 3~7 分钟突击复查（防「查完就切回去」）。
 * 3. 判定 study / idle / fun → 怨气 heat 累积 → mild（小生气）→ angry（真生气）→ furious（彻底生气、罢工）。
 * 4. 每个判定都会由宿主写进长期记忆（noteNarration），她第二天仍记得「昨天答应学习结果在打游戏」。
 * 5. 专注会降温——只罚不赏会让人讨厌她。连续专注还会被夸。
 *
 * 纯函数模块：不认识 Electron、不碰网络，时间与随机数全部显式传入，测试喂假时钟。
 */

/** 常规抽查间隔（分钟，随机）——「不定时过来看一眼」 */
const GAP = { min: 9, max: 21 }
/** 自动陪学的抽查间隔（0.45.75）：她自己发现他在学才进的，查勤别太密 */
const AUTO_GAP = { min: 20, max: 30 }
/** 抓到分心之后的突击复查窗口（分钟）——刚查完就切回去的人最容易被抓 */
const RECHECK = { min: 3, max: 7 }
/** 抓到分心后触发突击复查的概率 */
const RECHECK_P = 0.45
/** 开局缓冲：刚开始这几分钟不查（得给他进入状态的时间） */
const WARMUP_MIN = 4
/** 怨气自然消退速度（每分钟）——只涨不降的话一次误判就毁掉整场 */
const DECAY_PER_MIN = 0.45
/** 彻底生气后罢工多久自己消气回来（分钟） */
const SULK_MIN = 20
/** 罢工结束后残留的怨气（不会真的归零，她还记着） */
const HEAT_AFTER_SULK = 42

/** 怨气等级阈值 */
const LEVELS = { mild: 18, angry: 50, furious: 78 }
/** 判定对怨气的影响（数值按「第一次走神就该到小生气、第三次玩游戏就该彻底生气」校准） */
const HEAT_ADD = { fun: 28, fun_hot: 34, study: -22 }
/** 热态阈值：超过这个值说明已经在生气了，再加就加得更狠 */
const HOT = 35

/**
 * 抽查判定结果的四种语义（0.45.75 起，旧 idle 拆成两半）。
 * study = 在学（做题/看书/看课/写东西）；fun = 娱乐（游戏/短视频/番剧/直播）；
 * away = 黑屏/锁屏/屏保——人根本不在电脑前（不能当成走神骂，他可能在睡觉）；
 * unsure = 屏幕亮着但看不出在学还是在玩（桌面/文件夹/普通聊天）——存疑，只轻轻问，不定罪。
 */
const VERDICTS = ['study', 'fun', 'unsure', 'away', 'idle']
/** unsure 询问限频：整场最多说 2 次、间隔至少 15 分钟——存疑不是罪名，别追问个没完 */
const UNSURE_MAX_SAY = 2
const UNSURE_SAY_EVERY_MIN = 15

/**
 * 判定器提示词：只要一行 JSON。图 + 前台窗口一起给，两个证据互相校验。
 * 放在这里导出，是为了让 tools/study-judge-probe.js 用**同一份**提示词测准确率——
 * 各写一份的话，测出来的准头跟线上跑的就不是一个东西了。
 */
const JUDGE_SYS = [
  '你是一个学习监督判定器。给你一张电脑屏幕截图（可能是多块屏横向拼成的一张图，会说明顺序），判断主人此刻在做什么。',
  '只输出一行 JSON，不要其他文字、不要代码块：',
  '{"v":"study|fun|unsure|away","what":"不超过30字的客观描述，说清屏幕上是什么","subj":"科目，没有就空串","words":0}',
  'v 取值：',
  '- study：在学习或工作——做题、看书、看网课、写文档笔记、读 PDF、查学习资料。',
  '- fun：在娱乐——游戏、短视频、番剧、直播、追剧、刷社交、看小说。',
  '- away：人不在电脑前——黑屏、锁屏、屏保、显示器关了。这是最重要的区分：屏幕暗着就是 away，',
  '  他很可能在睡觉，绝不能判成走神。',
  '- unsure：屏幕亮着，但看不出在学习还是在娱乐——桌面、文件夹、聊天列表、认不清的页面。',
  '  判断要保守：认不出来就判 unsure，不要瞎猜成 study 或 fun。',
  '多块屏的规则：**只要任意一块屏在放视频/游戏，就判 fun**（一边学一边看番也是在玩），',
  '并在 what 里指明是哪一块（例如「主屏在做题，副屏在放B站番剧」）。多块屏都在学或工作→study。',
  'subj：如果是行测/申论相关的做题，尽量填具体科目' +
  '（资料分析/数量关系/判断推理/言语理解/常识判断/图形推理/申论/大作文/应用文），否则空串。',
  'words：如果屏幕上明确显示了字数统计（Word/WPS 底部状态栏、在线编辑器字数），填那个整数；' +
  '看不到或没有就填 0。**不要估算、不要编**。'
].join('\n')

/** 行测 + 申论的常见科目词（让她的指责/夸奖能说到具体科目，这比空泛的「学习」可信得多） */
const SUBJECTS = [
  '资料分析', '数量关系', '判断推理', '言语理解', '常识判断', '图形推理', '逻辑判断',
  '申论', '行测', '大作文', '应用文', '归纳概括', '综合分析', '对策题'
]

/**
 * 台词情境提示（由宿主喂给 LLM，persona 由调用方给）。
 * 占位符：{what}=看到了什么 {goal}=约定目标 {strikes}=被抓第几次 {mins}=分钟 {subj}=科目
 */
const SPEECH_PROMPTS = {
  unsure: '你刚瞄了一眼主人的屏幕：{what}——说不上他这是在学还是在歇着。' +
    '轻轻地问一句「这是在学还是在休息呀」，一句就好。不带情绪、不催、不定罪，就像随口一问。',
  mild_fun: '你刚瞄了一眼主人的屏幕：{what}——那是在玩，不是学习。{preamble}' +
    '你有点生气了，但还压着。说一两句：指出你看到了什么。' +
    '不要骂人，是「我不太高兴」的那种。',
  angry: '又抓到他了（这已经是第 {strikes} 次）：{what}。你是真的生气了。' +
    '短句、直白、不哄人、不撒娇。说两三句：指出他反复这样、你也提醒过一次了。可以带一句「你要是不想学就直说」。',
  furious: '这是第 {strikes} 次抓到他分心（{what}），你已经彻底生气了。' +
    '这次不要哄他、不要劝他、也不要再讲道理：说一句很重的话，然后表示你不想陪了、要去一边待着。' +
    '三句以内。冷淡、简短、真实的失望。',
  recover: '你又看了一眼，他在学了（{what}）。你心里松了一口气，但还在装淡定。' +
    '说一句简短的「这才对」这种话，别太热情，一两句就好。',
  streak: '你连着三次抽查他都在认真学（这次是{what}）。你很满意，夸他一句，' +
    '可以带一点「我本来都准备好骂你了」的玩笑。一两句。',
  sulk_back: '你为学习的事生气走开了一阵（{mins} 分钟），现在气消了一点，自己回来了。' +
    '说一句很短的、还带着点没消气的台阶话：问他学不学。不要道歉，也不要软得太快。',
  essay: '你在看他在写申论（{what}），屏幕上的字数统计显示只有 {words} 字，而这篇至少要 {essayWords} 字。' +
    '说一两句：直接点出「才 {words} 字」这个事实，催他写，或者问他要不要先搭个提纲。' +
    '语气是着急、替他心焦的那种，不是在骂他——他确实在学，只是写得太慢。不要讲大道理。'
}

function clamp (v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

function rand (a, b, rng) {
  const r = typeof rng === 'function' ? rng() : Math.random()
  return a + (b - a) * clamp(r, 0, 1)
}

/** 怨气等级 */
function levelOf (heat) {
  const h = Number(heat) || 0
  if (h >= LEVELS.furious) return 'furious'
  if (h >= LEVELS.angry) return 'angry'
  if (h >= LEVELS.mild) return 'mild'
  return 'fine'
}

/** 申论类写作的识别词（字数检查只在这些场景生效，别把行测题目的字数当作文） */
const ESSAY_RE = /申论|大作文|作文|议论文|策论|应用文|公文|归纳概括|综合分析|对策题|贯彻执行/

/**
 * 申论字数检查（0.45.69，选择性功能）。
 * 判定器只在屏幕上**明确显示字数**时才给 words（Word/WPS 状态栏），所以 words>0 本身就
 * 是很强的信号；再加一层「必须像申论/作文」，避免把行测资料的字数统计当成作文。
 * 同一个会话最多念 5 次、间隔至少 12 分钟——只提醒不啰嗦。
 * @returns {{words:number,target:number}|null}
 */
function essayCheck (s, t, what, subj, v) {
  if (!s || !s.essayOn) return null
  const words = Math.max(0, Math.trunc(Number(v && v.words) || 0))
  if (words <= 0) return null
  const target = Math.max(200, Math.round(Number(s.essayWords) || 1000))
  if (words >= target) return null
  const ctx = String(subj || '') + ' ' + String(what || '')
  if (!ESSAY_RE.test(ctx)) return null
  if (Number(s.essayCount) >= 5) return null
  if (s.essayAt && t - Number(s.essayAt) < 12 * 60000) return null
  return { words: words, target: target }
}

/** 记下她刚说过的话（防复读：她自己也不想每次用同一个句式骂人） */
function noteSaid (st, text) {
  if (!st) return st
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!t) return st
  const list = Array.isArray(st.recentSay) ? st.recentSay.slice(-7) : []
  list.push(t)
  st.recentSay = list
  return st
}

/** 规整目标文本（他说「行测和申论」就存「行测、申论」） */
function normGoal (g) {
  const s = String(g || '').replace(/[、,，和与及/\s]+/g, '、').replace(/^、|、$/g, '').trim()
  return s.slice(0, 40)
}

/** 这份契约的抽查间隔：自动陪学查勤稀一点（0.45.75） */
function gapOf (s, rng) {
  return Number(s && s.auto) ? AUTO_GAP : GAP
}

/**
 * 开一份学习契约。
 * @param {number} now
 * @param {object} o { goal, targetMin, rounds, lenMin, rng, auto }（auto=自动陪学带的监督）
 */
function start (now, o) {
  const t = Number(now) || Date.now()
  const opt = o || {}
  const rng = opt.rng
  const targetMin = Math.round(clamp(opt.targetMin || opt.lenMin || 90, 5, 600))
  const g = opt.auto ? AUTO_GAP : GAP
  return {
    on: true,
    auto: !!opt.auto,
    goal: normGoal(opt.goal) || '说好的东西',
    targetMin,
    startedAt: t,
    lastAt: 0,                        // 上次抽查时刻
    lastHeatAt: t,                    // 上次怨气变化时刻（算自然消退用）
    nextAt: t + rand(g.min, g.max, rng) * 60000,
    heat: 0,
    strikes: 0,                       // 累计被抓次数（只含「确定在玩」）
    funStrikes: 0,                    // 其中「娱乐」次数（账本里分开算）
    streak: 0,                        // 连续专注次数
    checks: 0,                        // 总抽查次数
    focusChecks: 0,
    unsureChecks: 0,                  // 0.45.75 存疑次数（亮屏看不出）
    unsureSaid: 0,                    // 存疑问句已说几次（限 2 次）
    unsureAt: 0,                      // 上次存疑询问时刻
    awayChecks: 0,                    // 人不在（黑屏/锁屏）次数
    awayStreak: 0,                    // 连续「人不在」次数（手动会话连续 2 次 = 他走了）
    lastV: '',                        // 上次判定
    lastWhat: '',
    lastSubj: '',
    sulkUntil: 0,                     // 罢工到什么时候
    recheckP: 0,                      // 下次用突击概率
    /* 0.45.69 补时：抓到一次「在玩」就把今天的目标延长（0=关闭） */
    penaltyPer: Math.max(0, Math.min(60, Math.round(Number(opt.penaltyMin != null ? opt.penaltyMin : 5)))),
    penaltyAdded: 0,
    /* 0.45.69 申论字数检查（选择性功能，默认关，设置里开） */
    essayOn: opt.essayOn === true,
    essayWords: Math.round(clamp(opt.essayWords || 1000, 200, 5000)),
    essayCount: 0,
    essayAt: 0,
    /* 0.45.69 她这个会话里亲口说过的话：用来禁止自己复读同一句 */
    recentSay: [],
    log: []                           // [{t,v,what,subj}]，只留最近 40 条
  }
}

/** 怨气按时间自然消退（不动 phase，纯数值） */
function decay (st, now) {
  const t = Number(now) || Date.now()
  const s = Object.assign({}, st)
  const last = Number(s.lastHeatAt) || Number(s.startedAt) || t
  const mins = Math.max(0, (t - last) / 60000)
  if (mins >= 0.5 && Number(s.heat) > 0) {
    s.heat = Math.max(0, Number(s.heat) - mins * DECAY_PER_MIN)
    s.lastHeatAt = t
  }
  return s
}

/**
 * 周期推进（宿主每 30~60 秒调一次）。
 * @returns {{st:object, action:'none'|'check'|'sulk_over'}}
 */
function tick (st, now) {
  if (!st || !st.on) return { st: st, action: 'none' }
  const t = Number(now) || Date.now()
  let s = decay(st, t)

  // 罢工结束：自己消气回来（不是真的不气了，残留 42）
  if (s.sulkUntil) {
    if (t < s.sulkUntil) return { st: s, action: 'none' }
    const g = gapOf(s)
    s = Object.assign(s, {
      sulkUntil: 0,
      heat: HEAT_AFTER_SULK,
      lastHeatAt: t,
      nextAt: t + rand(g.min, g.max) * 60000,
      wokeAt: t
    })
    return { st: s, action: 'sulk_over' }
  }

  if (t < Number(s.nextAt)) return { st: s, action: 'none' }
  // 开局缓冲：还没到 warmup 就不查（顺手把下次推迟一点，别一上来就掐表）
  if (t - Number(s.startedAt) < WARMUP_MIN * 60000) {
    return { st: Object.assign(s, { nextAt: t + WARMUP_MIN * 60000 }), action: 'none' }
  }
  return { st: s, action: 'check' }
}

/**
 * 抽查结果回来 → 更新怨气/连击/账本，并决定她要说什么。
 * @param {object} st
 * @param {object} v { v:'study'|'fun'|'unsure'|'away', what:string, subj?:string }
 * @param {number} now
 * @param {function} rng 可注入随机（测试用）
 * @returns {{st:object, kind:string, level:string, say:boolean}}
 *          kind 是台词情境（空串=这次不说话，只记账）
 */
function onVerdict (st, v, now, rng) {
  if (!st || !st.on) return { st: st, kind: '', level: 'off', say: false }
  const t = Number(now) || Date.now()
  // 罢工期间不判定（她已经在一边待着了，不会再去看屏幕）。防宿主补查把状态带飞。
  if (st.sulkUntil && t < Number(st.sulkUntil)) {
    return { st: st, kind: '', level: levelOf(st.heat), say: false }
  }
  const rawV = String((v && v.v) || '').toLowerCase()
  const verdict = ['study', 'fun', 'unsure', 'away'].indexOf(rawV) >= 0 ? rawV : 'unsure'
  const what = String((v && v.what) || '').slice(0, 120)
  const subj = String((v && v.subj) || '').slice(0, 20)

  let s = decay(st, t)
  const prevHeat = Number(s.heat) || 0
  const prevV = String(s.lastV || '')

  s = Object.assign(s, {
    lastAt: t,
    checks: (Number(s.checks) || 0) + 1,
    lastV: verdict,
    lastWhat: what,
    lastSubj: subj
  })
  const log = Array.isArray(s.log) ? s.log.slice(-39) : []
  log.push({ t: t, v: verdict, what: what, subj: subj })
  s.log = log

  let kind = ''
  let say = false
  let penalty = 0
  let essay = null

  if (verdict === 'study') {
    s.focusChecks = (Number(s.focusChecks) || 0) + 1
    s.streak = (Number(s.streak) || 0) + 1
    s.awayStreak = 0
    s.heat = Math.max(0, prevHeat + HEAT_ADD.study)
    s.lastHeatAt = t
    // 0.45.69 申论字数（选择性）：在学时也可以开口——「才写了 320 字」比任何催促都具体
    essay = essayCheck(s, t, what, subj, v)
    if (essay) {
      s.essayCount = (Number(s.essayCount) || 0) + 1
      s.essayAt = t
      s.lastEssay = essay
      kind = 'essay'; say = true
    } else if (Number(s.streak) >= 3 && Number(s.streak) % 3 === 0) {
      // 连续三次专注 → 夸一句；刚被抓过又回来学了 → 给个台阶（「这才对」）
      kind = 'streak'; say = true
    } else if (prevV && prevV !== 'study' && prevV !== 'unsure' && prevV !== 'away' && prevHeat <= 55) {
      kind = 'recover'; say = true
    }
  } else if (verdict === 'fun') {
    s.streak = 0
    s.awayStreak = 0
    s.strikes = (Number(s.strikes) || 0) + 1
    s.funStrikes = (Number(s.funStrikes) || 0) + 1
    const hot = prevHeat >= HOT
    const add = hot ? HEAT_ADD.fun_hot : HEAT_ADD.fun
    s.heat = Math.min(100, prevHeat + add)
    s.lastHeatAt = t
    s.recheckP = RECHECK_P

    // 0.45.69 补时：抓到「在玩」就延长今天的目标
    if (Number(s.penaltyPer) > 0) {
      penalty = Number(s.penaltyPer)
      s.targetMin = Math.round((Number(s.targetMin) || 0) + penalty)
      s.penaltyAdded = Math.round((Number(s.penaltyAdded) || 0) + penalty)
    }

    const lv = levelOf(s.heat)
    if (lv === 'furious') {
      s.sulkUntil = t + SULK_MIN * 60000
      kind = 'furious'; say = true
    } else if (lv === 'angry') {
      kind = 'angry'; say = true
    } else {
      kind = 'mild_fun'
      say = true
    }
  } else if (verdict === 'away') {
    /* 0.45.75 人不在（黑屏/锁屏/屏保）：这不是走神，更不是罪名——他可能在睡觉。
     * 不涨怨气、不记过、不说话；「要不要收场」由宿主决定（自动陪学立刻静默收场，
     * 手动会话连续两次人不在才收）。 */
    s.streak = 0
    s.awayChecks = (Number(s.awayChecks) || 0) + 1
    s.awayStreak = (Number(s.awayStreak) || 0) + 1
    kind = ''; say = false
  } else {
    /* unsure（0.45.75）：亮屏但看不出在学还是在玩——存疑不是罪名。
     * 不涨怨气、不记过；只限频地问一句「这是在学还是在休息」，不乱夸也不乱骂。 */
    s.streak = 0
    s.awayStreak = 0
    s.unsureChecks = (Number(s.unsureChecks) || 0) + 1
    const canAsk = (Number(s.unsureSaid) || 0) < UNSURE_MAX_SAY &&
      (!Number(s.unsureAt) || t - Number(s.unsureAt) >= UNSURE_SAY_EVERY_MIN * 60000)
    if (canAsk) {
      s.unsureSaid = (Number(s.unsureSaid) || 0) + 1
      s.unsureAt = t
      kind = 'unsure'; say = true
    }
  }

  // 排下次抽查：刚抓到分心 → 有概率突击复查（防「查完就切回来」）
  const justHit = verdict === 'fun'
  const doRecheck = justHit && (typeof rng === 'function' ? rng() : Math.random()) < RECHECK_P
  const G = gapOf(s, rng)
  const gapMin = doRecheck
    ? rand(RECHECK.min, RECHECK.max, rng)
    : rand(G.min, G.max, rng)
  s.nextAt = t + gapMin * 60000
  s.recheck = doRecheck

  return { st: s, kind: kind, level: levelOf(s.heat), say: say, penalty: penalty, essay: essay }
}

/** 结束契约（不生气，只收账） */
function stop (st, now) {
  if (!st) return st
  return Object.assign({}, st, { on: false, endedAt: (now || Date.now()) })
}

/**
 * 把人话判定成三档。视觉模型被要求只输出 JSON，但网关/模型经常加 ```json 包裹、
 * 或者干脆多说两句，这里做归一化，失败返回 null（宿主当作「这次没查」，绝不误伤）。
 * @param {string} raw
 * @returns {{v:string, what:string, subj:string}|null}
 */
function normalizeVerdict (raw) {
  const s = String(raw || '')
  if (!s.trim()) return null
  let obj = null
  const m = s.match(/\{[\s\S]*\}/)
  if (m) {
    try { obj = JSON.parse(m[0]) } catch { obj = null }
  }
  if (obj) {
    const v = String(obj.v || obj.verdict || obj.status || '').toLowerCase()
    let verdict = ''
    if (/study|learn|focus|学习|做题|看书|上课/.test(v)) verdict = 'study'
    else if (/fun|game|video|play|娱乐|游戏|视频|玩/.test(v)) verdict = 'fun'
    else if (/away|lock|black|离屏|锁屏|黑屏|屏保|离开|人不在/.test(v)) verdict = 'away'
    else if (/unsure|not\s?sure|看不清|不确定|存疑/.test(v)) verdict = 'unsure'
    else if (/idle|other|发呆|其他|走神|桌面/.test(v)) verdict = 'unsure'   // 旧 idle 语义拆分后的兜底
    if (!verdict) {
      // v 字段不认识就用 what 兜一层
      const w = String(obj.what || obj.desc || obj.description || '')
      verdict = 'unsure'
      if (/游戏|视频|番|直播|短视频|b站|哔哩|抖音|youtube|steam|原神/.test(w)) verdict = 'fun'
      else if (/题|书|课|笔记|论文|申论|行测|资料分析|word|pdf|anki/.test(w)) verdict = 'study'
      else if (/锁屏|黑屏|屏保/.test(w)) verdict = 'away'
    }
    return {
      v: verdict,
      what: String(obj.what || obj.desc || obj.description || '').slice(0, 120),
      subj: String(obj.subj || obj.subject || obj.科目 || '').slice(0, 20),
      // 屏幕上显示的字数（Word 状态栏之类）。没有就是 0——宁可没有，也不许估
      words: Math.max(0, Math.min(99999, Math.trunc(Number(obj.words || obj.wc || obj.字数) || 0)))
    }
  }
  // 完全没 JSON：抓关键词
  const t = s.toLowerCase()
  if (/锁屏|黑屏|屏保|黑着|lock\s?screen/.test(t)) {
    return { v: 'away', what: s.slice(0, 120), subj: '', words: 0 }
  }
  if (/游戏|视频|番剧|直播|短视频|bilibili|哔哩|抖音|youtube|steam|原神|在玩/.test(t)) {
    return { v: 'fun', what: s.slice(0, 120), subj: '', words: 0 }
  }
  if (/做题|刷题|看书|课程|网课|论文|笔记|申论|行测|资料分析|在学习|专注/.test(t)) {
    return { v: 'study', what: s.slice(0, 120), subj: '', words: 0 }
  }
  return null
}

/** 台词情境提示填充（给 LLM 当「当前情境」） */
function fillHint (kind, st, now) {
  const tpl = SPEECH_PROMPTS[kind]
  if (!tpl) return ''
  const t = Number(now) || Date.now()
  const mins = Math.max(0, Math.round((t - (Number(st.startedAt) || t)) / 60000))
  const es = st.lastEssay || {}
  /* 0.45.75 自动陪学的监督：没约好就是没约好，台词里不许拿「约好」说事 */
  const preamble = st.auto
    ? '不过这场不是他跟你约好的学习——是你自己看他好像在学、才凑过去陪的，你们没约过什么，' +
      '所以别说「我们说好要学」「你怎么答应的」这种话，语气也比对约定场景轻。'
    : '而你们说好了今天要学「' + String(st.goal || '说好的东西') + '」，提醒他刚才是怎么答应的。'
  let out = tpl
    .replace(/\{preamble\}/g, preamble)
    .replace(/\{what\}/g, String(st.lastWhat || '屏幕上不是学习的内容'))
    .replace(/\{goal\}/g, String(st.goal || '说好的东西'))
    .replace(/\{strikes\}/g, String(st.strikes || 1))
    .replace(/\{subj\}/g, String(st.lastSubj || ''))
    .replace(/\{mins\}/g, String(mins))
    .replace(/\{words\}/g, String(es.words || 0))
    .replace(/\{essayWords\}/g, String(es.target || st.essayWords || 1000))

  // 补时（抓到在玩延长了目标）：可以提，但别每次都提，否则像罚单播报
  const pen = Math.round(Number(st.penaltyAdded) || 0)
  if (pen > 0) {
    out += '\n（补充事实：他今天已经因为分心被你补时 ' + pen + ' 分钟，今天目标变成 ' +
      Math.round(Number(st.targetMin) || 0) + ' 分钟。可以顺口提一句，但不是每次都提。）'
  }
  // 防复读：她自己也不愿意每次用同一句话骂人。列出最近的原话，明确要求不许重复。
  const rs = Array.isArray(st.recentSay) ? st.recentSay.slice(-5) : []
  if (rs.length) {
    out += '\n【你刚才已经亲口说过的话】\n' + rs.map((x) => '- ' + String(x).slice(0, 70)).join('\n') +
      '\n（不要重复上面的句子、句式或用词，也不要换个说法把同一句再说一遍。' +
      '你现在是顺着刚才那股情绪往下说，不是重新开场。）'
  }
  return out
}

/* 0.45.69 删掉固定台词表（FALLBACK / fallbackLine）。
 * 真实使用反馈：要的是角色真生气自己说出来的话，而不是固定语句。
 * 死记硬背的句子在这个场景里一眼假：同一句「又是这样。我说过一次了。」不管看到的是
 * 番剧还是原神都一样，她就不再像在生气，而在念稿。现在生成失败就是**这次不说话**，
 * 只记账——宁可暂时沉默，也不念台词；账本与情绪仍然照常累积，下一句真话会更凶。 */

/** 账本（写进长期记忆 / 她可以自己念出来） */
function report (st, now) {
  if (!st) return ''
  const t = Number(now) || Date.now()
  const mins = Math.max(0, Math.round((t - (Number(st.startedAt) || t)) / 60000))
  const checks = Number(st.checks) || 0
  if (!checks) return '学习 ' + mins + ' 分钟，还没来得及查。'
  const focus = Number(st.focusChecks) || 0
  const fun = Number(st.funStrikes) || 0
  const unsure = Number(st.unsureChecks) || 0
  const away = Number(st.awayChecks) || 0
  const parts = ['共查了 ' + checks + ' 次：专注 ' + focus + ' 次']
  if (fun > 0) parts.push('在玩 ' + fun + ' 次')
  if (unsure > 0) parts.push('看不太清 ' + unsure + ' 次')
  if (away > 0) parts.push('人不在 ' + away + ' 次')
  const off = checks - focus - fun - unsure - away
  if (off > 0) parts.push('分心 ' + off + ' 次')
  return '学习 ' + mins + ' 分钟（目标 ' + (st.targetMin || '?') + ' 分钟），' + parts.join('、') +
    (Number(st.heat) >= LEVELS.furious ? '，最后我彻底生气了' : '') + '。'
}

/** 是否处于罢工（不理人）状态 */
function sulking (st, now) {
  if (!st || !st.sulkUntil) return false
  return (Number(now) || Date.now()) < Number(st.sulkUntil)
}

/** 给 systemPrompt 的一段话（契约生效时注入——她自己得知道正在被监督、正在生气） */
function brief (st, now) {
  if (!st || !st.on) return ''
  const t = Number(now) || Date.now()
  const mins = Math.max(0, Math.round((t - (Number(st.startedAt) || t)) / 60000))
  const heat = Math.round(Number(st.heat) || 0)
  const lv = levelOf(heat)
  const mood = {
    fine: '你现在心态平和，还挺满意。',
    mild: '你心里有点不痛快，还在忍着。',
    angry: '你是真的生气了，说话要短、要直、不要主动撒娇哄他。',
    furious: '你已经彻底生气了，语气冷淡，不想陪他，也不接受他一两句好话就翻篇。'
  }[lv]
  const last = st.lastAt
    ? '最近一次你偷偷看了一眼（{minsAgo} 分钟前）：' + (st.lastWhat ||
      ({ study: '在学', fun: '在玩', unsure: '看不清', away: '人不在' }[st.lastV] || '没在学')) +
      '（判定：' + ({ study: '在学', fun: '在玩', unsure: '存疑', away: '人不在', idle: '走神' }[st.lastV] || '未知') + '）'
    : '你还没看过他屏幕。'
  let out = st.auto
    ? '【学习监督·正在进行】你发现主人在学习，自己凑过去陪着（已过 ' + mins +
      ' 分钟，这场约 ' + st.targetMin + ' 分钟）。这不是他跟你约好的——是你自己的选择，' +
      '但既然在陪，你就会不定时偷偷看一眼他的屏幕：他认真学就安静陪，抓到他在玩也有权不高兴。\n'
    : '【学习契约·正在进行】主人跟你约好了今天学「' + st.goal + '」（已过 ' + mins +
      ' 分钟，目标 ' + st.targetMin + ' 分钟）。\n' +
      '你自己会不定时偷偷看一眼他的屏幕（每次都会记下来），被抓到分心 ' + (st.strikes || 0) + ' 次。\n' +
    last.replace('{minsAgo}', String(Math.max(0, Math.round((t - (Number(st.lastAt) || t)) / 60000)))) + '\n' +
    '当前的你：' + mood + '\n'
  // 0.45.69：规则本身也要让她知道——不告诉她有补时，她永远不会提，用户会觉得「说了半天没惩罚」
  if (Number(st.penaltyPer) > 0) {
    out += '规矩（你们默认就有的）：抓到他在玩，今天的任务就往后加 ' + st.penaltyPer + ' 分钟' +
      (Number(st.penaltyAdded) > 0 ? '；目前已经加到 ' + st.targetMin + ' 分钟（补了 ' + st.penaltyAdded + ' 分钟）' : '') + '。\n'
  }
  if (st.essayOn) {
    out += '你还在留意他写申论的字数（这篇按 ' + st.essayWords + ' 字算）；看到字数栏就顺口说一句。\n'
  }
  out += '规则：主动开口时别提「抽查/监控/判定」这些词，就像你自己瞟了一眼那样自然。' +
    (sulking(st, t) ? '你现在还在为这事赌气，不想多说话。' : '')
  return out
}

module.exports = {
  GAP, AUTO_GAP, RECHECK, RECHECK_P, WARMUP_MIN, DECAY_PER_MIN, SULK_MIN, HEAT_AFTER_SULK,
  UNSURE_MAX_SAY, UNSURE_SAY_EVERY_MIN,
  LEVELS, HEAT_ADD, HOT, VERDICTS, SUBJECTS, JUDGE_SYS,
  SPEECH_PROMPTS,
  levelOf, normGoal, start, tick, onVerdict, stop, decay,
  normalizeVerdict, fillHint, noteSaid, essayCheck, report, sulking, brief
}
