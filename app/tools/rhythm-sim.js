'use strict'
/**
 * 开口节奏对照（0.42.0）
 *
 * 为什么要有这个工具：改节奏这件事没法靠读代码判断好不好——
 * 必须把「一个下午她什么时候开口」画出来看。
 *
 * 三种排法各跑一遍，挑「开口总数最接近目标」的那一天来画，好让差别只在形状上：
 *
 *   固定周期   旧版看屏：每 N 秒看一眼 + 冷却 10 分钟 → 条件满足就准点响一次
 *   均匀随机   把间隔换成 Math.random() 均匀随机（= 泊松过程，很多「随机化」方案停在这一步）
 *   重尾       0.42.0 的做法：对数正态 + 成簇 + 最小间隔
 *
 * 用法：
 *   node tools/rhythm-sim.js                    # 每小时 3 次、8 小时
 *   node tools/rhythm-sim.js --per=6 --hours=6
 *   node tools/rhythm-sim.js --days=200         # 看长期分布（p10/p50/p90）
 */
const { nextGapMs } = require('../src/main/companion/rhythm')

const args = process.argv.slice(2)
const arg = (k, d) => {
  const hit = args.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.split('=')[1] : d
}

const PER_HOUR = Number(arg('per', 3))
const HOURS = Number(arg('hours', 8))
const DAYS = Number(arg('days', 200))
const MIN_GAP_MS = 3 * 60 * 1000
const TOTAL_MS = HOURS * 3600 * 1000

function seeded (seed) {
  let s = (seed >>> 0) || 1
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

/** 跑一天，返回开口时刻（分钟） */
function runDay (gen, seed) {
  const rand = seeded(seed)
  const out = []
  let t = 0
  while (true) {
    t += gen(rand)
    if (t >= TOTAL_MS) break
    out.push(t / 60000)
  }
  return out
}

const GEN = {
  fixed: () => (60 / PER_HOUR) * 60000,
  uniform: (rand) => Math.max(MIN_GAP_MS, -Math.log(1 - rand()) * (3600 / PER_HOUR) * 1000),
  heavy: (rand) => nextGapMs({ perHour: PER_HOUR, minGapMs: MIN_GAP_MS, rand })
}

function distribution (name, gen) {
  const target = PER_HOUR * HOURS
  const counts = []
  for (let k = 0; k < DAYS; k++) counts.push(runDay(gen, 1000 + k * 37).length)
  counts.sort((a, b) => a - b)
  const q = (p) => counts[Math.min(counts.length - 1, Math.floor(counts.length * p))]
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length
  console.log('  ' + name.padEnd(6) + '平均 ' + mean.toFixed(1) + ' 次' +
    '（目标 ' + target + '）  p10 ' + q(0.1) + ' · p50 ' + q(0.5) + ' · p90 ' + q(0.9) +
    ' · 最闲的一天 ' + counts[0] + ' · 最多的一天 ' + counts[counts.length - 1])
}

function timeline (label, mins) {
  const CELL = 6      // 一格 6 分钟：3 次/小时这个量级，30 分钟一格会把所有点糊成一排
  const perRow = 20
  const cols = Math.ceil(HOURS * 60 / CELL)
  const cells = new Array(cols).fill('·')
  for (const m of mins) cells[Math.min(cols - 1, Math.floor(m / CELL))] = '●'
  console.log('\n' + label)
  for (let r = 0; r * perRow < cols; r++) {
    const from = r * perRow * CELL
    console.log('  ' + String(Math.floor(from / 60)).padStart(2, '0') + 'h  ' + cells.slice(r * perRow, (r + 1) * perRow).join(' '))
  }
  const gaps = mins.slice(1).map((m, i) => m - mins[i])
  const sorted = [...gaps].sort((a, b) => a - b)
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  console.log('       共 ' + mins.length + ' 次，间隔 中位 ' + Math.round(med) + ' 分 · 最长 ' +
    Math.round(sorted.length ? sorted[sorted.length - 1] : 0) + ' 分（一格 = 6 分钟）')
}

/** 挑一天「开口次数正好等于目标」的来画，这样三种排法的差别只剩形状 */
function pickTypical (gen) {
  const target = Math.round(PER_HOUR * HOURS)
  let best = null
  for (let k = 0; k < 400; k++) {
    const d = runDay(gen, 7000 + k * 91)
    const diff = Math.abs(d.length - target)
    if (!best || diff < best.diff) best = { diff, d }
    if (diff === 0) break
  }
  return best.d
}

function run () {
  console.log('每小时约 ' + PER_HOUR + ' 次，一天看 ' + HOURS + ' 小时；下面是开口时刻（●）在时间轴上的位置')
  timeline('① 固定周期（旧版看屏：冷却就是节拍器）', pickTypical(GEN.fixed))
  timeline('② 均匀随机（泊松：听着随机，其实还是匀速）', pickTypical(GEN.uniform))
  timeline('③ 重尾 + 成簇（0.42.0：一阵连着说，然后安静很久）', pickTypical(GEN.heavy))

  console.log('\n长期分布（' + DAYS + ' 个同样时长的日子，看每天开口几次）')
  distribution('固定', GEN.fixed)
  distribution('均匀', GEN.uniform)
  distribution('重尾', GEN.heavy)
  console.log('\n怎么读：① 每格间隔相等，一眼就是机器；② 间隔不再相等，但「连着两句」依然少见；')
  console.log('        ③ 同一天里既有「连着两句」又有「四十多分钟没声」，而且每天的总数会浮动——')
  console.log('           人本来就有话多的一天和不想说话的一天。')
}

run()
