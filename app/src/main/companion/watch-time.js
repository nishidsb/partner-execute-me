'use strict'
/**
 * 0.18.0 M9 · 时间观念（用户 2026-10-25 需求：陪伴要有时间观念，并要求举一反三）
 *
 * 事件一览（纯状态机判定，发声由 watch.js 走 pet_say 链路，不在这里出声）：
 *   away   —— 无动静超过 tsAwayMin 分钟（默认 15）：轻轻问一句是不是走开了
 *   afk    —— 无动静超过 tsSleepMin 分钟（默认 30）：调侃摸鱼/睡着/不在电脑前
 *   gone   —— 无动静超过 tsGoneMin 分钟（默认 60）：表达想念，盼主人回来
 *   back   —— 离开（≥tsAwayMin）后回来了：欢迎回来，问休息得怎么样
 *   rest   —— 连续使用超过 tsWorkMin 分钟（默认 90）没休息过：提醒起身走走/护眼
 *             （休息 = 无动静 ≥ tsBreakMin 分钟；提醒后 45 分钟内不重复，休息过才清零）
 *   sleep  —— 深夜（静音时段，未开静音则默认 23:00-06:00）还在用电脑：温柔劝睡，每小时最多一次
 *   morning—— 早上 6-10 点第一次检测到活跃：道早安，一天最多一次
 *
 * 判定信号：系统空闲时间（键鼠无输入秒数，Electron powerMonitor），不需要截图、零模型成本。
 * 纯逻辑与 IO 分离：idleMs() 注入，node:test 无 Electron 直接可测。
 */

const MIN = 60000

/** 默认值（watch.js 的 DEFAULTS 会合并这份，设置页钳制也以这里为准） */
const TS_DEFAULTS = {
  timeSenseOn: true,
  tsAwayMin: 15,     // 无动静多久算「走开了」
  tsSleepMin: 30,    // 无动静多久调侃「摸鱼/睡着」
  tsGoneMin: 60,     // 无动静多久算「很久不在」
  tsWorkMin: 90,     // 连续使用多久提醒休息
  tsBreakMin: 5,     // 离开多久算「休息过了」（清零连续使用计时）
  tsSleepNudge: true, // 深夜还在用 → 劝睡
  tsMorning: true     // 早上第一次活跃 → 早安
}

/** 数值钳制（非法回默认） */
function tsClampNum (v, lo, hi, d) {
  const x = Number(v)
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d
}

/** 'HH:mm' 区间判定（跨零点也认；与 watch.js inQuietHours 同规则，复制避免循环 require） */
function tsInWindow (now, start, end) {
  if (!start || !end) return false
  const toMin = (s) => {
    const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/)
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }
  const a = toMin(start)
  const b = toMin(end)
  if (a == null || b == null) return false
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b)
}

/** 本地日期键（早安「一天一次」用） */
function tsDayKey (now) {
  const d = new Date(now)
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

/**
 * 建一个时间观念状态机。依赖注入：
 *   cfgGet() → 伴侣配置（含 ts* 字段）   idleMs() → 系统空闲毫秒数
 */
function createTimeSense ({ cfgGet, idleMs, log = () => { } }) {
  const st = {
    tier: 0,          // 已经说到的「离开档」（0=没说过，1=away，2=afk，3=gone）
    awayAt: 0,        // 本次离开开始时刻（进入不活跃时的估算）
    broke: false,     // 无动静已达到「休息」档（回来时清零连续使用）
    usageMs: 0,       // 连续使用累计（休息过才清零）
    lastTickAt: 0,
    restRemindAt: 0,  // 上次久坐提醒时刻
    sleepNudgeAt: 0,  // 上次劝睡时刻
    greetedOn: ''     // 早安已说的日期
  }

  /** 深夜窗口：开着静音时段就沿用它的起止，否则默认 23:00-06:00 */
  function nightWindow (cfg) {
    if (cfg.watchQuiet && cfg.watchQuietStart && cfg.watchQuietEnd) return [cfg.watchQuietStart, cfg.watchQuietEnd]
    return ['23:00', '06:00']
  }

  /**
   * 每 60s 调一次。返回 { kind, ...info } | null：
   * kind ∈ away/afk/gone/back/rest/sleep/morning。同一事件只在跨过阈值时返回一次。
   */
  function tick (now = Date.now()) {
    const cfg = cfgGet() || {}
    if (cfg.timeSenseOn === false) return null
    const awayMin = tsClampNum(cfg.tsAwayMin, 5, 240, TS_DEFAULTS.tsAwayMin)
    const sleepMin = Math.max(awayMin + 5, tsClampNum(cfg.tsSleepMin, 10, 480, TS_DEFAULTS.tsSleepMin))
    const goneMin = Math.max(sleepMin + 5, tsClampNum(cfg.tsGoneMin, 15, 720, TS_DEFAULTS.tsGoneMin))
    const workMin = tsClampNum(cfg.tsWorkMin, 15, 480, TS_DEFAULTS.tsWorkMin)
    const breakMin = tsClampNum(cfg.tsBreakMin, 2, 30, TS_DEFAULTS.tsBreakMin)

    const idle = Math.max(0, Number(idleMs()) || 0)
    // 相邻两次 tick 的真实间隔（封顶 2 分钟，休眠唤醒后不暴涨）
    const dt = st.lastTickAt ? Math.min(now - st.lastTickAt, 120000) : 0
    st.lastTickAt = now
    const active = idle < breakMin * MIN

    if (active) {
      // 刚回来：无动静达到过「休息」档就算真休息——清零连续使用；
      // 且离开时长够「走开」档（≥awayMin）才打招呼（短起身不刷存在感）
      if (st.broke) {
        const awayMs = st.awayAt ? now - st.awayAt : 0
        st.broke = false
        st.awayAt = 0
        st.tier = 0
        st.usageMs = 0
        st.restRemindAt = 0
        if (awayMs >= awayMin * MIN) return { kind: 'back', minutes: Math.round(awayMs / MIN) }
      }
      st.usageMs += dt
      // 久坐提醒：连续用满 workMin，提醒后 45 分钟内不重复（休息过才清零，所以会一直惦记）
      if (st.usageMs >= workMin * MIN && now - st.restRemindAt >= 45 * MIN) {
        st.restRemindAt = now
        return { kind: 'rest', minutes: Math.round(st.usageMs / MIN) }
      }
      // 早安：早上 6-10 点第一次活跃（静音时段里不说，留到静音结束后第一次活跃）
      if (cfg.tsMorning !== false) {
        const d = new Date(now)
        const h = d.getHours()
        const quietOn = cfg.watchQuiet === true && tsInWindow(now, cfg.watchQuietStart, cfg.watchQuietEnd)
        const key = tsDayKey(now)
        if (h >= 6 && h < 10 && !quietOn && st.greetedOn !== key) {
          st.greetedOn = key
          return { kind: 'morning' }
        }
      }
      // 深夜劝睡：深夜还在用电脑，每小时最多一次（watch.js 会放行 sleep 穿过静音闸）
      if (cfg.tsSleepNudge !== false) {
        const [qs, qe] = nightWindow(cfg)
        if (tsInWindow(now, qs, qe) && now - st.sleepNudgeAt >= 60 * MIN) {
          st.sleepNudgeAt = now
          return { kind: 'sleep', hour: new Date(now).getHours() }
        }
      }
      return null
    }

    // 不活跃：离开计时开始；连续使用冻结（不累计也不清零——真休息以 breakMin 为准）
    if (idle >= breakMin * MIN) {
      if (!st.awayAt) st.awayAt = now - idle
      st.broke = true
    }
    const idleMin = idle / MIN
    const tier = idleMin >= goneMin ? 3 : idleMin >= sleepMin ? 2 : idleMin >= awayMin ? 1 : 0
    if (tier > st.tier) {
      st.tier = tier
      return { kind: ['away', 'afk', 'gone'][tier - 1], minutes: Math.round(idleMin) }
    }
    return null
  }

  return { tick, _state: st }
}

module.exports = { createTimeSense, TS_DEFAULTS, tsInWindow, tsDayKey }
