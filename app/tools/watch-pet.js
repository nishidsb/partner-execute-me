#!/usr/bin/env node
/* 0.45.67 真机动作连拍（观察用，不参与应用运行）
 *   env -u ELECTRON_RUN_AS_NODE npx electron tools/watch-pet.js [秒数] [--save-dir captures/sit]
 *
 * 为什么要有：用户说「坐下之前有个奇怪的动作很短」「坐下时一直抖」，这些在离屏探针里
 * 只能量到位移，看不到「那个动作」。这里直接拍真机画面：每 200ms 抓一帧，算 32×48 灰度
 * 签名差，只把「有变化」的帧留下来（960×180s 全存太大），再给出时间线。
 * 之后看关键帧就知道她到底做了什么。
 */
const { app, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const plain = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const SECONDS = Number(plain.find((a) => /^\d+$/.test(a))) || 120
const dirIdx = process.argv.indexOf('--save-dir')
const SAVE = path.resolve(dirIdx > 0 ? process.argv[dirIdx + 1] : path.join(__dirname, '..', 'captures', 'watch'))
const URL = 'http://127.0.0.1:8712/frame'
const GAP = 200
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function sig (buf) {
  try {
    const img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return null
    const small = img.resize({ width: 32, height: 48, quality: 'good' })
    const bm = small.toBitmap() // BGRA
    const out = new Float32Array(32 * 48)
    for (let i = 0; i < 32 * 48; i++) {
      out[i] = (bm[i * 4] + bm[i * 4 + 1] + bm[i * 4 + 2]) / 3
    }
    return out
  } catch { return null }
}
function diff (a, b) {
  if (!a || !b) return 999
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length
}

app.whenReady().then(async () => {
  fs.mkdirSync(SAVE, { recursive: true })
  const t0 = Date.now()
  const timeline = []
  let prev = null
  const keep = [] // {i, buf, d}
  let i = 0
  console.log('[watch] 连拍 ' + SECONDS + 's，存到 ' + SAVE)
  while (Date.now() - t0 < SECONDS * 1000) {
    let buf = null
    try {
      const res = await fetch(URL)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      buf = Buffer.from(await res.arrayBuffer())
    } catch (e) {
      console.error('[watch] 抓帧失败: ' + e.message)
      await wait(1000)
      continue
    }
    const s = sig(buf)
    const d = prev ? diff(prev, s) : 0
    timeline.push({ i, t: Math.round((Date.now() - t0) / 100) / 10, d: +d.toFixed(2) })
    if (s) prev = s
    // 有变化就留帧（阈值 2.5：静止时的呼吸浮动约 1~2）
    if (d > 2.5) {
      const f = path.join(SAVE, 'f' + String(i).padStart(4, '0') + '_' + timeline[timeline.length - 1].t.toFixed(1) + '.png')
      fs.writeFileSync(f, buf)
      keep.push({ i, t: timeline[timeline.length - 1].t, d: +d.toFixed(2), f })
    }
    i++
    await wait(GAP)
  }
  fs.writeFileSync(path.join(SAVE, 'timeline.json'), JSON.stringify(timeline, null, 0))
  console.log('[watch] 共 ' + i + ' 帧，留下 ' + keep.length + ' 帧有变化的')
  // 打印变化最剧烈的 20 处
  const top = timeline.slice().sort((a, b) => b.d - a.d).slice(0, 20)
  console.log('[watch] 差异最大的时刻（秒 / 差）：')
  console.log(top.map((x) => x.t + 's:' + x.d).join('  '))
  app.exit(0)
})
