'use strict'
/**
 * AI 伴侣 · 开口节奏器（rhythm，0.42.0）
 *
 * 用户 2026-10-29 22:16 的原话：
 * 「这个屏幕陪伴只保留每小时主动问多少次是不是更好，随机频率是不是更好」
 *
 * 判断：方向对，但「随机」不能是均匀随机。原因见下。
 *
 * ── 之前的病灶 ──────────────────────────────────────────────
 * 三条主动通道各有一套自己的闸：
 *   看屏搭话  每 180 秒看一眼 + 冷却 10 分钟 + 每小时最多 4 次
 *   碎碎念    每天 5 次，间隔 50~110 分钟均匀随机
 *   她自己待着 每天 8 件，间隔 20~60 分钟均匀随机
 * 各自掷各自的骰子，结果是同一种病：
 *   · 只要你一直在电脑前，「看屏」这条就退化成**每 10 分钟一次**的打卡
 *     （冷却就是节拍器，条件满足一次就准点响一次）
 *   · 三路互相不知道对方刚说了话，于是会在同一个十分钟里撞成连珠炮，
 *     然后整小时鸦雀无声
 *   · 均匀随机（→ 泊松）听着仍然是「均匀的」，只是换了张脸
 *
 * ── 依据 ──────────────────────────────────────────────────
 * Barabási, Nature 435:207 (2005)：人类同类动作的间隔时间是**重尾**的，
 * 表现为「一阵子连着做几件，然后很长一段安静」，而不是泊松那种匀速。
 * 所以这里用**对数正态**：多数间隔落在目标值附近，但尾巴很长，
 * 偶尔会安静一小时；再叠一个「成簇」概率（连着补一句）。
 *
 * 唯一的旋钮是 perHour。看屏/碎碎念/她自己待着 全部改成向这里申请开口权，
 * 于是「每小时几次」第一次真的是她**整体**对你说话的次数。
 *
 * ── 优先级 ────────────────────────────────────────────────
 *   'time'    时间观念（该休息了 / 深夜劝睡 / 你回来了）—— 有信息量，允许突破预算，
 *             但仍守着最小间隔，不会跟上一句贴在一起
 *   'speech'  她看到什么、想跟你说话 —— 正常走预算
 *   'talk'    自言自语（不期待回应）—— 正常走预算，但预算紧张时最先被牺牲
 *
 * 纯函数（nextGapMs / budgetOf / gauss）+ 一个极小的状态壳，node:test 直接可测。
 */

const DEFAULTS = {
  proactivePerHour: 3,     // 每小时大约主动开口几次（唯一的旋钮）
  minGapSec: 180,          // 两句之间至少隔多久（防连珠炮；成簇时也守这条）
  burstChance: 0.22,       // 「接着说一句」的概率
  sigma: 0.8,              // 对数正态的宽度：越大越容易出长静默
  maxGapMin: 210,          // 单次间隔上限（3.5 小时，再久就不像在陪着了）
  dailyMax: 24             // 每天硬上限（防翻车）
}

/** Box-Muller：均匀随机 → 标准正态。单独提出来是为了测试能钉住分布 */
function gauss (rand) {
  const r = typeof rand === 'function' ? rand : Math.random
  let u = 0
  let v = 0
  // rand 可能返回 0（测试里注入定值），log(0) = -Infinity
  while (u === 0) u = r()
  while (v === 0) v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * 下一次开口的间隔（毫秒）。
 * 对数正态按「均值 = 目标间隔」反解 —— exp(mu + sigma²/2) = mean，
 * 再扣掉成簇那一部分的贡献，保证长期实际频率接近 perHour。
 */
function nextGapMs (o) {
  const i = o || {}
  const perHour = Math.max(0.2, Number(i.perHour) || DEFAULTS.proactivePerHour)
  const minGap = Math.max(30_000, Number(i.minGapMs) || DEFAULTS.minGapSec * 1000)
  const maxGap = Math.max(minGap * 2, (Number(i.maxGapMin) || DEFAULTS.maxGapMin) * 60_000)
  const sigma = Number(i.sigma) > 0 ? Number(i.sigma) : DEFAULTS.sigma
  const burstChance = Math.min(0.6, Math.max(0, i.burstChance == null ? DEFAULTS.burstChance : Number(i.burstChance)))
  const rand = typeof i.rand === 'function' ? i.rand : Math.random
  const target = 3_600_000 / perHour

  // 成簇：多数情况是一句短的（最小间隔的 1~1.7 倍）
  if (rand() < burstChance) return Math.round(minGap * (1 + rand() * 0.7))

  // 扣掉成簇占掉的份额，剩下的才交给对数正态
  const burstAvg = minGap * 1.35
  const mean = Math.max(minGap * 1.2, (target - burstChance * burstAvg) / (1 - burstChance))
  const mu = Math.log(mean) - (sigma * sigma) / 2
  const g = Math.exp(mu + sigma * gauss(rand))
  return Math.round(Math.min(maxGap, Math.max(minGap, g)))
}

/** 预算：软上限 = 名义值 ×1.2（成簇允许偶尔超标），硬上限 = ×1.8（绝不允许） */
function budgetOf (perHour) {
  const n = Math.max(0.5, Number(perHour) || DEFAULTS.proactivePerHour)
  return { soft: Math.max(1, Math.round(n * 1.2)), hard: Math.max(2, Math.round(n * 1.8)) }
}

/** 每天上限：按清醒 12 小时估，但不低于 6 次 */
function dailyMaxOf (perHour) {
  const n = Math.max(0.5, Number(perHour) || DEFAULTS.proactivePerHour)
  return Math.max(6, Math.round(n * 8))
}

/**
 * 建一个节奏器。
 * @param {{cfgGet?:Function, now?:Function, rand?:Function, log?:Function}} deps
 */
function createRhythm (deps) {
  const d = deps || {}
  const cfgGet = d.cfgGet || (() => ({}))
  const now = d.now || (() => Date.now())
  const rand = d.rand || Math.random
  const log = d.log || (() => {})
  // 0.45.14 当日状态跨重启：dayCount/lastAt/nextAt/stamps 落盘（宿主给 persist 实现）
  const persist = d.persist || null

  /** 开口时间戳（只留最近 2 小时，用来算窗口内已用次数） */
  let stamps = []
  let nextAt = 0
  let dayKey = ''
  let dayCount = 0
  let lastAt = 0
  let paused = false

  // 启动时恢复：dayKey 对得上才认（跨天的计数 rollDay 反正会清零）
  try {
    const saved = persist && persist.load && persist.load()
    if (saved && typeof saved === 'object') {
      const t = new Date(now())
      const k = t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate()
      if (saved.dayKey === k) {
        dayKey = saved.dayKey
        dayCount = Math.max(0, Number(saved.dayCount) || 0)
        lastAt = Number(saved.lastAt) || 0
        nextAt = Number(saved.nextAt) || 0
        stamps = (Array.isArray(saved.stamps) ? saved.stamps : [])
          .map(Number).filter((x) => isFinite(x) && now() - x < 2 * 3_600_000)
        log('[rhythm] 恢复今日状态：已开口 ' + dayCount + ' 次，最近一次 ' +
          (lastAt ? Math.round((now() - lastAt) / 60000) + ' 分钟前' : '无'))
      }
    }
  } catch (e) { log('[rhythm] 恢复失败（忽略）: ' + (e && e.message)) }

  function saveState () {
    if (!persist || !persist.save) return
    try { persist.save({ dayKey, dayCount, lastAt, nextAt, stamps: stamps.slice(-40) }) } catch { }
  }

  function cfg () {
    const c = cfgGet() || {}
    const perHour = Number(c.proactivePerHour) || DEFAULTS.proactivePerHour
    return {
      perHour: Math.min(12, Math.max(1, perHour)),
      minGapMs: Math.max(30, Number(c.proactiveMinGapSec) || DEFAULTS.minGapSec) * 1000,
      burstChance: c.proactiveBurst != null ? Number(c.proactiveBurst) : DEFAULTS.burstChance,
      sigma: DEFAULTS.sigma,
      maxGapMin: DEFAULTS.maxGapMin,
      dailyMax: dailyMaxOf(perHour)
    }
  }

  function rollDay () {
    const t = new Date(now())
    const k = t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate()
    if (k !== dayKey) { dayKey = k; dayCount = 0 }
  }

  function prune () {
    const t = now()
    while (stamps.length && t - stamps[0] > 3_600_000) stamps.shift()
  }

  /** 窗口内已用几个（默认 1 小时，也可以看 20 分钟这种近端窗口） */
  function usedIn (ms) {
    const t = now()
    return stamps.filter((x) => t - x < ms).length
  }

  /**
   * 申请一次开口权。
   * @param {'time'|'speech'|'talk'} kind
   * @returns {{ok:boolean, why:string, waitMs?:number, leftMs?:number}}
   */
  function ask (kind) {
    const c = cfg()
    const t = now()
    rollDay()
    prune()
    if (paused) return { ok: false, why: 'paused' }
    const since = lastAt ? t - lastAt : Infinity

    // 最小间隔：所有类别都得守（连着说两句也要隔 3 分钟，不然是复读机）
    if (since < c.minGapMs) return { ok: false, why: 'min-gap', waitMs: c.minGapMs - since, leftMs: 0 }

    if (kind === 'time') {
      // 时间事件有真实信息量（该休息了/夜深了/你回来了）：不吃预算，但半小时内不重复
      if (usedIn(30 * 60_000) >= 3) return { ok: false, why: 'time-cap', waitMs: 60_000 }
      return { ok: true, why: 'time' }
    }

    if (dayCount >= c.dailyMax) return { ok: false, why: 'daily-cap' }
    if (t < nextAt) return { ok: false, why: 'not-yet', waitMs: nextAt - t }
    const b = budgetOf(c.perHour)
    const used = usedIn(3_600_000)
    if (used >= b.hard) return { ok: false, why: 'hourly-hard', waitMs: 60_000 }
    // 软上限：自言自语先让位给「有话要说」的那种
    if (used >= b.soft && kind === 'talk') return { ok: false, why: 'hourly-soft', waitMs: 120_000 }
    return { ok: true, why: kind }
  }

  /** 记一次真的开口了（由宿主在 say 成功之后调） */
  function note (kind) {
    const c = cfg()
    const t = now()
    rollDay()
    lastAt = t
    stamps.push(t)
    prune()
    if (kind !== 'time') dayCount++
    nextAt = t + nextGapMs({ perHour: c.perHour, minGapMs: c.minGapMs, burstChance: c.burstChance, maxGapMin: c.maxGapMin, rand })
    saveState()
  }

  /** 启动时先掷一次，别一开机就撞上一句 */
  function start () {
    const c = cfg()
    rollDay()
    const gap = nextGapMs({ perHour: c.perHour, minGapMs: c.minGapMs, burstChance: c.burstChance, maxGapMin: c.maxGapMin, rand })
    // 第一句封顶 10 分钟：重尾偶尔会掷出一个多小时的间隔，刚装好第一次打开的人会以为她坏了。
    // 之后的间隔不再封顶——该安静的时候就安静。
    const first = Math.min(gap, 10 * 60_000)
    nextAt = now() + first
    log('[rhythm] 启动：每小时约 ' + c.perHour + ' 次，下一句最早 ' + Math.round(first / 60000) + ' 分钟后')
  }

  function status () {
    const c = cfg()
    const t = now()
    return {
      perHour: c.perHour,
      usedLastHour: usedIn(3_600_000),
      usedLast20Min: usedIn(20 * 60_000),
      budget: budgetOf(c.perHour),
      todayCount: dayCount,
      dailyMax: c.dailyMax,
      nextInMs: Math.max(0, nextAt - t),
      sinceLastMs: lastAt ? t - lastAt : -1,
      paused
    }
  }

  return {
    ask, note, start, status,
    /** 全部暂停（静音时段等场景由宿主决定） */
    setPaused (v) { paused = !!v },
    _stamps: () => stamps,
    _nextAt: () => nextAt
  }
}

module.exports = {
  DEFAULTS, gauss, nextGapMs, budgetOf, dailyMaxOf, createRhythm
}
