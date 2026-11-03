'use strict'
/**
 * 需求系统（0.45.18）——她的行为由内部压力驱动，不再只是「冷却到了就出门」
 *
 * ── 为什么要有这个 ─────────────────────────────────────────────────
 * 之前的自主活动是「时钟驱动」：冷却到了、主人不在，就出门逛一圈。
 * 逛什么、为什么逛，全靠当次随机——像一个被闹钟叫醒去散步的人，
 * 而不是一个「憋着想做点什么」的活人。
 * 三道鸿沟（记忆改变行为 → 需求驱动 → 连续时间）里，这是下一道。
 *
 * ── 三股压力 ───────────────────────────────────────────────────────
 *   curiosity 好奇  —— 有想弄明白的东西（话题池里有货时涨得快）
 *   share     想分享—— 攒了没讲给主人听的经历了（有经历没说时涨得快，
 *                      主人开口聊过天就泄掉）
 *   boredom   无聊  —— 一个人待太久了（匀速涨，活动一次泄大半）
 * 每股 0~100，随时间积累，离线超过 12 小时不无限积压（睡了一觉不代表憋疯）。
 *
 * ── 压力怎么用 ─────────────────────────────────────────────────────
 *   1. 最高的那股决定这场活动的「动机语气」（goalBlock 注入系统提示词）
 *   2. 总压力越高，冷却越短（憋得越狠，出门越早）——缩放 nextCooldownMs
 *   3. 活动散场泄掉无聊+好奇；主人开口聊天泄掉想分享
 */

const CAP = 100
/** 每小时基础增速（无外部刺激时的底速） */
const GAIN_PER_HOUR = { curiosity: 6, share: 8, boredom: 10 }
/** 离线最多按 12 小时补积压（跨夜不爆表） */
const MAX_CATCHUP_H = 12
/** 有刺激时的加成倍率 */
const BOOST = { topics: 1.6, experience: 1.8 }
/** 没刺激时的衰减倍率（没东西可想/没经历可讲，压力慢慢淡掉） */
const FADE = { topics: 0.7, experience: 0.8 }
/** 冷却缩放：压力 100 时冷却缩到 65%，压力 0 时不变 */
const COOLDOWN_MIN_SCALE = 0.65

const clamp = (n) => Math.min(CAP, Math.max(0, n))

/** 一份全新的状态（第一次启动/文件坏了时的兜底）。now=0 也是合法时刻 */
function newState (now) {
  const t0 = Number(now)
  return { t: Number.isFinite(t0) && t0 >= 0 ? t0 : Date.now(), curiosity: 20, share: 10, boredom: 15 }
}

/**
 * 时间推进：按流逝的小时数给三股压力涨值（纯函数，返回新状态）。
 * @param {object} state  {t, curiosity, share, boredom}
 * @param {number} now    当前毫秒
 * @param {{hasTopics?:boolean, hadExperience?:boolean}} ctx 外部刺激
 */
function gainOf (state, now, ctx) {
  const s = state || newState(now)
  const c = ctx || {}
  const nNow = Number(now)
  const base = Number.isFinite(nNow) && nNow >= 0 ? nNow : Date.now()
  const h = Math.min(MAX_CATCHUP_H, Math.max(0, (base - (Number(s.t) || 0)) / 3600000))
  if (h <= 0) return Object.assign({}, s, { t: base })
  return {
    t: base,
    curiosity: clamp(s.curiosity + GAIN_PER_HOUR.curiosity * h * (c.hasTopics ? BOOST.topics : FADE.topics)),
    share: clamp(s.share + GAIN_PER_HOUR.share * h * (c.hadExperience ? BOOST.experience : FADE.experience)),
    boredom: clamp(s.boredom + GAIN_PER_HOUR.boredom * h)
  }
}

/** 总压力：最高的那股的值 */
function pressureOf (state) {
  const s = state || {}
  return Math.max(0, Number(s.curiosity) || 0, Number(s.share) || 0, Number(s.boredom) || 0)
}

/** 最强的那股需求（平手时按 好奇 > 想分享 > 无聊 的顺序） */
function dominantOf (state) {
  const s = state || {}
  const v = { curiosity: Number(s.curiosity) || 0, share: Number(s.share) || 0, boredom: Number(s.boredom) || 0 }
  let best = 'curiosity'
  for (const k of ['share', 'boredom']) if (v[k] > v[best]) best = k
  return best
}

/** 冷却缩放：压力越高冷却越短（憋得狠出门早），范围 [0.65, 1] */
function cooldownScaleOf (state) {
  const p = pressureOf(state)
  return Math.min(1, Math.max(COOLDOWN_MIN_SCALE, 1 - 0.35 * p / CAP))
}

/**
 * 动机语气块：注入 runSpace/runFree 的系统提示词（没有压力就不出声）。
 * 压力低于 45 时她还没到「想做点什么」的劲头，不装模作样编动机。
 */
function goalBlockOf (state) {
  const s = state || {}
  const p = pressureOf(s)
  if (p < 45) return ''
  const lines = []
  switch (dominantOf(s)) {
    case 'curiosity':
      lines.push('你现在有点好奇心上头：有想弄明白的东西。这次就顺着这股劲去查去看，把它弄清楚。')
      break
    case 'share':
      lines.push('你攒了几件有意思的事还没讲给主人听。这次活动里多留意值得讲的细节，回头他回来聊天时说给他。')
      break
    default:
      lines.push('你有点闲得发慌，就想找点新鲜事解解闷。看什么都行，看得开心就好。')
  }
  if (p >= 75) lines.push('这股劲挺强的，认真去做，别敷衍两下就散。')
  return lines.join('\n')
}

/**
 * 泄压（纯函数，返回新状态）。
 * kind = 'session' 自主活动散场：无聊泄到大半、好奇泄掉一截、想分享不动（没跟主人讲就不算分享）
 * kind = 'interrupt' 主人回来被打断（0.46.4）：也算出了半趟门——真的看了做了，好奇泄一半；
 *                    以前 user-back 完全不泄压，好奇常年顶在 100，她永远处于「憋着一股劲」状态
 * kind = 'chat'    主人开口聊天：想分享泄掉、无聊也松一点
 */
function dischargeOf (state, now, kind) {
  const base = gainOf(state, now, {})
  if (kind === 'chat') {
    return Object.assign({}, base, { share: 10, boredom: clamp(base.boredom - 15) })
  }
  if (kind === 'interrupt') {
    return Object.assign({}, base, { boredom: clamp(base.boredom - 20), curiosity: clamp(base.curiosity - 25) })
  }
  // session：无聊回到 15，好奇打对折再减一点
  return Object.assign({}, base, { boredom: 15, curiosity: clamp(base.curiosity - 45) })
}

/** 状态文件（工作区里）：needs-state.json */
function fileOf (wsDir) {
  return wsDir ? require('node:path').join(wsDir, 'needs-state.json') : ''
}

function loadState (wsDir, now) {
  try {
    const raw = JSON.parse(require('node:fs').readFileSync(fileOf(wsDir), 'utf8'))
    if (!raw || typeof raw !== 'object') return newState(now)
    const rt = Number(raw.t)
    const nt = Number(now)
    return {
      t: Number.isFinite(rt) && rt >= 0 ? rt : (Number.isFinite(nt) && nt >= 0 ? nt : Date.now()),
      curiosity: clamp(Number(raw.curiosity) || 0),
      share: clamp(Number(raw.share) || 0),
      boredom: clamp(Number(raw.boredom) || 0)
    }
  } catch { return newState(now) }
}

function saveState (wsDir, state) {
  try {
    const f = fileOf(wsDir)
    if (!f) return false
    require('node:fs').writeFileSync(f, JSON.stringify(state), 'utf8')
    return true
  } catch { return false }
}

/**
 * 运行时实例：autonomy/index 都只跟它说话。
 * @param {{wsDir:Function, now:Function, log:Function}} deps
 */
function create (deps) {
  const d = deps || {}
  const now = d.now || Date.now
  const log = d.log || (() => { })
  const wsDirOf = typeof d.wsDir === 'function' ? d.wsDir : () => ''
  let state = null

  function ensure () {
    if (!state) state = loadState(wsDirOf(), now())
    return state
  }
  function commit () { try { saveState(wsDirOf(), state) } catch { } }

  return {
    /** 读状态（顺带把时间推进落盘）。ctx: {hasTopics, hadExperience} */
    state (ctx) {
      state = gainOf(ensure(), now(), ctx)
      commit()
      return state
    },
    goalBlock (ctx) {
      return goalBlockOf(this.state(ctx))
    },
    discharge (kind) {
      state = dischargeOf(ensure(), now(), kind)
      commit()
      log('[needs] 泄压(' + kind + ') 好奇' + Math.round(state.curiosity) +
        ' 分享' + Math.round(state.share) + ' 无聊' + Math.round(state.boredom))
      return state
    },
    /** 换工作区（角色切换）后强制重读 */
    reset () { state = null },
    status () {
      const s = this.state()
      return { curiosity: Math.round(s.curiosity), share: Math.round(s.share), boredom: Math.round(s.boredom), dominant: dominantOf(s), pressure: Math.round(pressureOf(s)) }
    }
  }
}

module.exports = {
  CAP, GAIN_PER_HOUR, MAX_CATCHUP_H, COOLDOWN_MIN_SCALE,
  newState, gainOf, pressureOf, dominantOf, cooldownScaleOf, goalBlockOf, dischargeOf,
  loadState, saveState, create
}
