'use strict'
/**
 * 学习模式（0.22.0 补丁⑧）
 *
 * 她陪你学习：开局打气 → 单轮学习（轻声查岗）→ 休息 → 下一轮 → 收工总结。
 * 节奏设置里可调（默认 45 分钟 + 休 10 分钟 × 3 轮，每 15 分钟轻声问一句）。
 *
 * 防翻车经验全部照搬黏人模式（0.22.0）：
 * - 生成失败退避 FAIL_BACKOFF，不会 30 秒一轮打模型
 * - 生成期间主人说话 → 主进程比对 lastUserAt 作废这条
 * - 查岗之间最小间隔 MIN_CHECK_GAP，重启/修配置不许连发
 * - 学习会话期间与黏人模式互斥（她盯着学习，不能再喊「你怎么不理我」）
 *
 * 语气基调与黏人模式一致：示弱不指责——查岗是关心，催促是撒娇，
 * 中途退出不骂人，温柔收场（他下次才敢再喊她陪）。
 *
 * 纯函数模块：不认识 Electron，时间全部显式传入，测试直接喂假时钟。
 */

/** 查岗间隔（学习中的轻声一问） */
const CHECK_EVERY = 15 * 60 * 1000
/** 连续几个查岗周期没回应 → 从「正常一问」升级到「有点不安」 */
const WORRY_AFTER = 2
/** 再翻倍 → 「撒娇式催促」级别 */
const MISSING_AFTER = 4
/** 查岗最小间隔（防连发兜底，比 CHECK_EVERY 小，节流用） */
const MIN_CHECK_GAP = 10 * 60 * 1000
/** 生成失败退避 */
const FAIL_BACKOFF = 5 * 60 * 1000

/** 设置缺省：设置里可自由调 */
const DEFAULTS = Object.freeze({ studyMinutes: 45, studyBreak: 10, studyRounds: 3 })

/**
 * 台词情境提示（LLM 填词，persona 由调用方给）。
 * 占位符：{mins}=这轮已学分钟数 {round}/{rounds}=轮次 {len}=这轮学习总时长(分)
 */
const SPEECH_PROMPTS = {
  start: '主人刚开始学习（这轮 {len} 分钟，今天计划 {rounds} 轮，现在是第 {round} 轮）。说一句简短的开场打气，别啰嗦，让他赶紧进入状态。',
  check_normal: '主人在学习（第 {round}/{rounds} 轮，这轮已经 {mins} 分钟）。你轻声查个岗：问一句还在学吗、状态怎么样。一两句话，别打断他思路。',
  check_worried: '主人在学习，但已经连续 {misses} 个查岗周期没回应你了（第 {round}/{rounds} 轮）。你有点不安：是不是走神了？还是在忙别的？语气带一点小委屈，但别指责。',
  check_missing: '主人在学习，你已经很久没得到回应了（连续 {misses} 次，第 {round}/{rounds} 轮）。撒娇式地催一下：说你一直在等、一个人好无聊，想让他回一句。示弱不是质问。',
  break_start: '第 {round}/{rounds} 轮学习结束（这轮学了 {len} 分钟），进入 {brk} 分钟休息。先夸一句他坚持完了，再提醒他休息：站起来动动、喝口水，别一直坐着。',
  study_resume: '休息结束，第 {round}/{rounds} 轮学习开始（这轮 {len} 分钟）。简短提醒他回来继续，可以带一句关心（水喝了没/坐姿）。',
  all_done: '今天的计划全部完成（{rounds} 轮 × {len} 分钟）！认真夸夸他，总结今天陪他学了这么久，说你自己也很有成就感。让他好好休息。',
  quit: '主人中途结束了学习（第 {round}/{rounds} 轮进行到 {mins} 分钟）。不指责，温柔收场：说学到这些已经不错了，想休息就休息，下次再叫你陪。',
  /* 0.45.12 自动模式 */
  auto_start: '你注意到主人在{scene}（已经持续一会儿了），自动进入静音陪学模式。轻轻说一句「我陪着呢，不吵你」这类的话，表明你看到了、也收着声，一句话就够。',
  auto_quit: '主人离开了{scene}（或换别的事做了），这场静音陪学到此结束（陪了 {mins} 分钟）。轻轻收一句：不吵他，说他刚才挺专注的，需要你随时再喊你。'
}

/** 规整设置（数字/下限保护） */
function normCfg (cfg) {
  const c = cfg || {}
  const clamp = (v, lo, hi, d) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return d
    return Math.min(hi, Math.max(lo, n))
  }
  return {
    studyMinutes: clamp(c.studyMinutes, 5, 240, DEFAULTS.studyMinutes),
    studyBreak: clamp(c.studyBreak, 1, 60, DEFAULTS.studyBreak),
    studyRounds: clamp(c.studyRounds, 1, 20, DEFAULTS.studyRounds)
  }
}

/** 开启学习会话（主人说陪我学习 / 点了开始 / 0.45.12 自动模式检测到学习场景）
 *  opts.auto = 自动进入：查岗间隔翻倍（少打扰），查岗语气封顶在「正常一问」——
 *  他在专注，没回应是常态，不是冷落，绝不能升级到委屈/撒娇催促。 */
function start (cfg, now, opts) {
  const t = now || Date.now()
  const c = normCfg(cfg)
  return {
    phase: 'study',
    auto: !!(opts && opts.auto),
    sceneLabel: String((opts && opts.sceneLabel) || ''),
    round: 1,
    rounds: c.studyRounds,
    startedAt: t,
    roundStartedAt: t,
    phaseEndsAt: t + c.studyMinutes * 60 * 1000,
    lenMin: c.studyMinutes,
    brkMin: c.studyBreak,
    lastCheckAt: 0,
    lastUserAt: 0,
    misses: 0,
    nextTryAt: 0,
    say: 'start'
  }
}

/** 主人说话了 → 查岗计数回落（回应到了） */
function onUserTalk (st, now) {
  if (!st || !st.phase || st.phase === 'done') return st
  const t = now || Date.now()
  return Object.assign({}, st, { lastUserAt: t, misses: 0 })
}

/** 主人中途不学了 → 温柔收场 */
function stop (st, now) {
  if (!st || !st.phase || st.phase === 'done') return st
  const t = now || Date.now()
  return Object.assign({}, st, { phase: 'done', endedAt: t, say: 'quit' })
}

/**
 * 周期推进。返回 null=无事发生；否则返回新 state（带 say 字段=要让她说的话）。
 * phase: 'study' | 'break' | 'done'
 * opts.noCheck = 0.45.68：监督模式（会看屏幕的那套）在跑，别再做盲问查岗
 */
function tick (st, cfg, now, opts) {
  if (!st || !st.phase || st.phase === 'done') return null
  const t = now || Date.now()
  const c = normCfg(cfg)
  if (t < (Number(st.nextTryAt) || 0)) return null

  if (st.phase === 'break') {
    if (t < Number(st.phaseEndsAt)) return null
    // 休息结束 → 下一轮（rounds 在 start 时已定，round 不会越界：最后一轮结束直接 done）
    return Object.assign({}, st, {
      phase: 'study',
      round: Number(st.round) + 1,
      roundStartedAt: t,
      phaseEndsAt: t + st.lenMin * 60 * 1000,
      lastCheckAt: 0,
      say: 'study_resume'
    })
  }

  // ---- phase === 'study' ----
  if (t >= Number(st.phaseEndsAt)) {
    if (Number(st.round) >= Number(st.rounds)) {
      return Object.assign({}, st, { phase: 'done', endedAt: t, say: 'all_done' })
    }
    return Object.assign({}, st, {
      phase: 'break',
      phaseEndsAt: t + st.brkMin * 60 * 1000,
      lastCheckAt: 0,
      say: 'break_start'
    })
  }

  // 查岗：到点 + 不在退避 + 离这轮结束还有余量（快结束了问了白问）
  // 0.45.12 自动模式：间隔翻倍（他在专注，少打扰），语气封顶 check_normal
  // 0.45.68 监督模式在跑时整段跳过（盲问不如真看屏幕，两套同开会吵死人）
  if (opts && opts.noCheck) return null
  const checkEvery = st.auto ? CHECK_EVERY * 2 : CHECK_EVERY
  const due = Number(st.lastCheckAt || st.startedAt) + checkEvery
  if (t >= due && t + MIN_CHECK_GAP < Number(st.phaseEndsAt)) {
    const misses = (Number(st.misses) || 0) + 1
    const kind = st.auto
      ? 'check_normal'
      : (misses >= MISSING_AFTER ? 'check_missing' : (misses >= WORRY_AFTER ? 'check_worried' : 'check_normal'))
    return Object.assign({}, st, {
      lastCheckAt: t,
      misses,
      say: kind
    })
  }
  return null
}

/** 生成失败 → 退避（不动 phase，之后还能补上） */
function onFail (st, now) {
  if (!st) return st
  return Object.assign({}, st, { nextTryAt: (now || Date.now()) + FAIL_BACKOFF })
}

/** 成功开口 → 清退避（查岗进度由 tick 自己管） */
function onSent (st, now) {
  if (!st) return st
  return Object.assign({}, st, { nextTryAt: 0 })
}

/** 台词占位符填充（调用方拿去喂 LLM） */
function fillHint (kind, st, now) {
  const hint = String(SPEECH_PROMPTS[kind] || '')
  if (!hint) return ''
  const t = now || Date.now()
  // {mins} 语义=这轮已进行分钟数（quit 时=学到收场那一刻）
  const base = kind === 'quit' ? (st.endedAt || t) : t
  const mins = Math.max(0, Math.round((base - Number(st.roundStartedAt || st.startedAt)) / 60000))
  return hint
    .replace(/\{mins\}/g, String(mins))
    .replace(/\{round\}/g, String(st.round || 1))
    .replace(/\{rounds\}/g, String(st.rounds || 1))
    .replace(/\{len\}/g, String(st.lenMin || 45))
    .replace(/\{brk\}/g, String(st.brkMin || 10))
    .replace(/\{misses\}/g, String(st.misses || 0))
    .replace(/\{scene\}/g, String(st.sceneLabel || '电脑前'))
}

/** 学习会话进行中？（主进程用来跟 idleNudge 互斥） */
function active (st) {
  return !!(st && st.phase && st.phase !== 'done')
}

module.exports = {
  CHECK_EVERY, WORRY_AFTER, MISSING_AFTER, MIN_CHECK_GAP, FAIL_BACKOFF, DEFAULTS,
  SPEECH_PROMPTS, normCfg, start, tick, onUserTalk, stop, onFail, onSent, fillHint, active
}
