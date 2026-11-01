'use strict'
/**
 * 开口节奏器的护栏（0.42.0）
 *
 * 这些用例守的不是「算得对」，而是几条会被后来的我改坏的约定：
 *   · 最小间隔永远优先 —— 任何时候都不能让两句话贴在一起
 *   · 长期实际频率要接近 perHour —— 否则「每小时 3 次」就成了假旋钮
 *   · 分布必须是重尾的 —— 如果哪天有人把它换成 Math.random() 均匀随机，
 *     第 5 条会立刻挂：均匀随机会让「超过 3 倍目标间隔」几乎不可能出现
 */
const test = require('node:test')
const assert = require('node:assert')
const { nextGapMs, budgetOf, dailyMaxOf, gauss, DEFAULTS, createRhythm } = require('../src/main/companion/rhythm')

/** 线性同余，给测试一个可复现的「随机」 */
function seeded (seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

test('最小间隔是硬底线：一千次抽样里没有一次短于它', () => {
  const rand = seeded(7)
  const minGapMs = 120_000
  for (let i = 0; i < 1000; i++) {
    const g = nextGapMs({ perHour: 6, minGapMs, burstChance: 0.4, rand })
    assert.ok(g >= minGapMs, '第 ' + i + ' 次抽到 ' + g + 'ms，短于最小间隔')
  }
})

test('成簇是「接着说一句」而不是连珠炮：短间隔集中在一两个最小间隔内', () => {
  const rand = seeded(11)
  const minGapMs = 60_000
  let short = 0
  const N = 500
  for (let i = 0; i < N; i++) {
    const g = nextGapMs({ perHour: 8, minGapMs, burstChance: 0.6, rand })
    assert.ok(g >= minGapMs, '短于最小间隔：' + g)
    if (g <= minGapMs * 1.75) short++
  }
  // burstChance 上限就是 0.6（再高就变刷屏了），所以短间隔占比应落在 45%~65%
  assert.ok(short / N > 0.45 && short / N < 0.68, '短间隔占 ' + (short / N * 100).toFixed(0) + '%')
})

test('长期频率接近 perHour（±40%），否则旋钮是假的', () => {
  for (const perHour of [1, 3, 6]) {
    const rand = seeded(2024 + perHour)
    let total = 0
    const N = 4000
    for (let i = 0; i < N; i++) {
      total += nextGapMs({ perHour, minGapMs: 60_000, burstChance: DEFAULTS.burstChance, rand })
    }
    const realized = (N * 3_600_000) / total
    assert.ok(
      realized > perHour * 0.6 && realized < perHour * 1.4,
      'perHour=' + perHour + ' 实际跑到 ' + realized.toFixed(2) + ' 次/小时'
    )
  }
})

test('尾巴够长：确实会出现长静默（重尾的判据）', () => {
  const rand = seeded(99)
  const perHour = 3
  const target = 3_600_000 / perHour
  let long = 0
  const N = 2000
  for (let i = 0; i < N; i++) {
    const g = nextGapMs({ perHour, minGapMs: 180_000, burstChance: DEFAULTS.burstChance, rand })
    if (g > target * 3) long++
  }
  // 均匀随机（指数分布）下 P(g > 3×均值) ≈ e^-3 ≈ 5%，且指数分布本身就没有 3 倍均值那么长的尾巴
  assert.ok(long / N > 0.04, '长静默占比只有 ' + (long / N * 100).toFixed(1) + '%，分布不像重尾')
  assert.ok(long / N < 0.45, '长静默占比 ' + (long / N * 100).toFixed(1) + '%，尾巴太肥，会像掉线')
})

test('间隔有上限，不会一安静就是一天', () => {
  const rand = seeded(5)
  for (let i = 0; i < 500; i++) {
    const g = nextGapMs({ perHour: 1, minGapMs: 60_000, maxGapMin: 180, rand })
    assert.ok(g <= 180 * 60_000, '抽到 ' + g)
  }
})

test('gauss 给的是标准正态（均值 0、方差 1）', () => {
  const rand = seeded(42)
  const N = 20000
  let sum = 0
  let sq = 0
  for (let i = 0; i < N; i++) { const z = gauss(rand); sum += z; sq += z * z }
  const mean = sum / N
  const varr = sq / N - mean * mean
  assert.ok(Math.abs(mean) < 0.06, '均值 ' + mean)
  assert.ok(Math.abs(varr - 1) < 0.12, '方差 ' + varr)
})

test('预算：软上限 1.2 倍、硬上限 1.8 倍、每天不低于 6 次', () => {
  assert.deepStrictEqual(budgetOf(3), { soft: 4, hard: 5 })
  assert.deepStrictEqual(budgetOf(1), { soft: 1, hard: 2 })
  assert.strictEqual(dailyMaxOf(1), 8)
  assert.strictEqual(dailyMaxOf(12), 96)
})

/* ---------------------------------------------------------------- 状态壳 */

function mk (cfg, clock) {
  const r = createRhythm({ cfgGet: () => cfg, now: () => clock.t, rand: seeded(3) })
  return r
}

test('开场不抢话：start() 之后立刻问也是 not-yet', () => {
  const clock = { t: 1_000_000 }
  const r = mk({ proactivePerHour: 3 }, clock)
  r.start()
  assert.strictEqual(r.ask('speech').ok, false)
  assert.strictEqual(r.ask('speech').why, 'not-yet')
})

test('说过一句之后至少隔 minGapSec 才有下一次', () => {
  const clock = { t: 1_000_000 }
  const cfg = { proactivePerHour: 12, proactiveMinGapSec: 120 }
  const r = createRhythm({ cfgGet: () => cfg, now: () => clock.t, rand: seeded(8) })
  r.start()
  clock.t += 10 * 60_000
  assert.strictEqual(r.ask('speech').ok, true)
  r.note('speech')
  clock.t += 30_000
  assert.strictEqual(r.ask('speech').why, 'min-gap')
  clock.t += 120_000
  assert.notStrictEqual(r.ask('speech').why, 'min-gap')
})

test('时间事件不吃预算、能穿过 nextAt，但半小时内最多 3 次', () => {
  const clock = { t: 1_000_000 }
  const cfg = { proactivePerHour: 12, proactiveMinGapSec: 60 }
  const r = createRhythm({ cfgGet: () => cfg, now: () => clock.t, rand: seeded(9) })
  r.start()
  clock.t += 5 * 60_000
  assert.strictEqual(r.ask('time').ok, true)
  r.note('time')
  clock.t += 61_000
  assert.strictEqual(r.ask('time').ok, true)
  r.note('time')
  clock.t += 61_000
  assert.strictEqual(r.ask('time').ok, true)
  r.note('time')
  clock.t += 61_000
  assert.strictEqual(r.ask('time').why, 'time-cap')
  // 时间事件不计入每天的开口数
  assert.strictEqual(r.status().todayCount, 0)
})

test('软上限到了，自言自语先让位，但「有话要说」还能说；硬上限谁都不许说', () => {
  const clock = { t: 1_000_000 }
  const cfg = { proactivePerHour: 2, proactiveMinGapSec: 30 } // soft=2 hard=4
  const r = createRhythm({ cfgGet: () => cfg, now: () => clock.t, rand: seeded(12) })
  r.start()
  // 白盒：直接把「最近一小时已经说过几句」摆好，绕开随机间隔（间隔本身在别的用例里测）
  const seedWindow = (n) => {
    clock.t += 211 * 60_000 // 先越过 maxGapMin，保证 nextAt 已经过了
    const arr = r._stamps()
    arr.length = 0
    for (let i = 0; i < n; i++) arr.push(clock.t - (i + 1) * 90_000)
  }
  seedWindow(2)
  assert.strictEqual(r.ask('talk').why, 'hourly-soft', '到软上限时自言自语该让位')
  assert.strictEqual(r.ask('speech').ok, true, '软上限之后「有话要说」的还应该能说')
  seedWindow(4)
  assert.strictEqual(r.ask('speech').why, 'hourly-hard')
  assert.ok(/^hourly-/.test(r.ask('talk').why), '硬上限时自言自语也该被挡')
})

test('每天上限到了就整天闭嘴（除非是时间事件）', () => {
  const clock = { t: 1_000_000 }
  const cfg = { proactivePerHour: 1, proactiveMinGapSec: 30 }
  const r = createRhythm({ cfgGet: () => cfg, now: () => clock.t, rand: seeded(13) })
  r.start()
  for (let i = 0; i < dailyMaxOf(1); i++) { clock.t += 40_000; r.note('speech') }
  clock.t += 40_000
  assert.strictEqual(r.ask('speech').why, 'daily-cap')
  assert.notStrictEqual(r.ask('time').why, 'daily-cap')
})

test('暂停后谁都不许说话', () => {
  const clock = { t: 1_000_000 }
  const r = createRhythm({ cfgGet: () => ({ proactivePerHour: 6, proactiveMinGapSec: 30 }), now: () => clock.t, rand: seeded(14) })
  r.start()
  r.setPaused(true)
  clock.t += 60 * 60_000
  assert.strictEqual(r.ask('speech').why, 'paused')
  assert.strictEqual(r.ask('time').why, 'paused')
  r.setPaused(false)
  assert.strictEqual(r.ask('time').ok, true)
})

test('status 里的数字跟实际动作对得上', () => {
  const clock = { t: 1_000_000 }
  const r = createRhythm({ cfgGet: () => ({ proactivePerHour: 4, proactiveMinGapSec: 30 }), now: () => clock.t, rand: seeded(15) })
  r.start()
  clock.t += 30 * 60_000
  assert.strictEqual(r.status().usedLastHour, 0)
  r.note('speech')
  const s = r.status()
  assert.strictEqual(s.usedLastHour, 1)
  assert.strictEqual(s.todayCount, 1)
  assert.ok(s.nextInMs > 0)
  assert.strictEqual(s.perHour, 4)
})

test('第一句封顶 10 分钟：掷出长间隔也不会让刚打开的人以为她坏了', () => {
  const clock = { t: 0 }
  const r = createRhythm({ cfgGet: () => ({ proactivePerHour: 1, proactiveMinGapSec: 60 }), now: () => clock.t, rand: () => 0.999 })
  r.start()
  assert.ok(r.status().nextInMs <= 10 * 60_000 + 1000, '首句要等 ' + Math.round(r.status().nextInMs / 60000) + ' 分钟')
  // 之后的间隔不再封顶（该安静就安静）：note 之后 nextAt 可以超过 20 分钟
  clock.t += 30 * 60_000
  assert.strictEqual(r.ask('speech').ok, true)
  r.note('speech')
  assert.ok(r.status().nextInMs > 10 * 60_000, '第二句之后的间隔不封顶')
})
