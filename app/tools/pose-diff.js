'use strict'
/**
 * 0.45.54 姿势变化量化（不参与应用运行）
 *   npx electron tools/pose-diff.js <图目录> [--tag 名字]
 *
 * 用户「动作还是一样」的问题在于以前只靠日志交差：日志能证明「预载成功」，
 * 证明不了屏幕上到底动没动。这个工具直接把一串截图缩成 24x40 灰度签名，
 * 输出「相邻帧差异」和「不同姿势的数量」——改动前后用同一把尺子量。
 *
 * 用法场景：OBS 实况帧每 3s 抓一张 → 跑这个 → 看 差异>3 的帧对有多少、
 * 不同姿势（聚类）有几个。数字上去了，才算真的变了。
 */
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const dirArg = args.find((a) => !a.startsWith('--'))
const tagIdx = args.indexOf('--tag')
const TAG = tagIdx >= 0 ? args[tagIdx + 1] : path.basename(dirArg || '')
const W = 24
const H = 40

if (!dirArg) {
  console.error('[pose-diff] 用法: electron tools/pose-diff.js <图目录> [--tag 名字]')
  app.exit(2)
}

app.whenReady().then(() => {
  const dir = path.resolve(dirArg)
  const files = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort()
  if (!files.length) { console.error('[pose-diff] 目录里没有 png'); app.exit(1) }

  const sigs = []
  for (const f of files) {
    const img = nativeImage.createFromPath(path.join(dir, f))
    if (img.isEmpty()) continue
    const small = img.resize({ width: W, height: H, quality: 'good' })
    const size = small.getSize()
    const bmp = small.getBitmap() // BGRA
    const arr = new Float64Array(W * H)
    for (let i = 0; i < W * H; i++) {
      const b = bmp[i * 4]; const g = bmp[i * 4 + 1]; const r = bmp[i * 4 + 2]
      arr[i] = r * 0.3 + g * 0.6 + b * 0.1
    }
    sigs.push({ name: f, w: size.width, arr })
  }

  const dist = (a, b) => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
    return s / a.length
  }

  // 相邻帧差异
  const diffs = []
  for (let i = 1; i < sigs.length; i++) diffs.push(Number(dist(sigs[i - 1].arr, sigs[i].arr).toFixed(2)))

  // 聚类：和已有簇心差异 < 2.0 视为同一个姿势
  const CLUSTER_T = 2.0
  const centers = []
  const counts = []
  for (const s of sigs) {
    let hit = -1
    for (let c = 0; c < centers.length; c++) {
      if (dist(centers[c], s.arr) < CLUSTER_T) { hit = c; break }
    }
    if (hit < 0) { centers.push(s.arr); counts.push(1) } else counts[hit]++
  }

  const avg = diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1)
  const bigMoves = diffs.filter((d) => d > 3).length
  console.log('===== pose-diff [' + TAG + '] =====')
  console.log('帧数: ' + sigs.length + ' · 时间跨度约 ' + Math.round(sigs.length * 3) + 's（3s 一张）')
  console.log('相邻帧平均差异: ' + avg.toFixed(2) + ' · 最大 ' + Math.max.apply(null, diffs) + ' · 最小 ' + Math.min.apply(null, diffs))
  console.log('明显换姿势的次数（相邻差异>3）: ' + bigMoves)
  console.log('不同姿势簇数量: ' + centers.length + ' · 各簇帧数 ' + counts.map((c, i) => '#' + (i + 1) + ':' + c).join(' '))
  console.log('差异序列: ' + diffs.join(', '))
  app.exit(0)
})
