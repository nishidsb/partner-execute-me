#!/usr/bin/env node
/* 0.45.73 「坐下之前那段怪动作」逐帧探针（自查用，不参与应用运行）
 *   env -u ELECTRON_RUN_AS_NODE npx electron tools/sit-snap.js <model.vrm> [--walk motions/walk.vrma] [--json out.json]
 *
 * 为什么要有：sit-probe 只能量「手/脚的世界坐标跳了多少」，看不到「哪根骨头在第几帧
 * 转了多少度」。真机日志里坐下那一秒 rig 从无到有、官方 idle 被 stopAllAction 硬切，
 * 到底是「一瞬间跳到 rest（A-pose）」还是「某个手势没做完整」，只有逐帧角度能说清。
 *
 * 判定口径：单帧转角 > 25° = 肉眼可见的抽搐；正常过渡每帧 < 5°。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const plain = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const argOf = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : '' }
const modelArg = plain.find((a) => /\.(vrm|glb)$/i.test(a)) || ''
const walkArg = argOf('--walk')
const OUT = argOf('--json')
const SHOT = argOf('--shots')
if (!modelArg) {
  console.error('[sit-snap] 用法: electron tools/sit-snap.js <model.vrm> [--walk walk.vrma]')
  app.exit(2)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[sit-snap] 超时'); app.exit(1) }, 120000)
  const win = new BrowserWindow({
    width: 340, height: 560, show: true, frame: false,
    backgroundColor: '#1d2030',
    webPreferences: { webSecurity: false, offscreen: false }
  })
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 1 && String(msg).indexOf('Security Warning') < 0) console.log('[page]', String(msg).slice(0, 200))
  })
  const query = { model: pathToFileURL(path.resolve(modelArg)).toString() }
  if (walkArg) query.walk = pathToFileURL(path.resolve(walkArg)).toString()
  await win.loadFile(path.join(__dirname, 'preview', 'sit-snap.html'), { query })

  let samples = []
  let notes = []
  const shotAt = {}
  if (SHOT) { fs.mkdirSync(path.resolve(SHOT), { recursive: true }) }
  for (let i = 0; i < 90; i++) {
    await wait(400)
    const dump = JSON.parse(await win.webContents.executeJavaScript(
      'JSON.stringify({s: window.__samples, e: window.__err, p: window.__phase, n: window.__notes, b: window.__bones})'))
    if (dump.e) { console.error('[sit-snap] 页面错误:', dump.e); break }
    samples = dump.s || []
    notes = dump.n || []
    if (dump.b && !global.__bShown) { global.__bShown = 1; console.log("[bones] " + JSON.stringify(dump.b)) }
    // 想看「走路时手到底什么样」「坐下坐成什么样」就按相位各存一张
    if (SHOT && !shotAt[dump.p] && (dump.p === 'walk' || dump.p === 'settled')) {
      shotAt[dump.p] = 1
      try {
        const img = await win.capturePage()
        fs.writeFileSync(path.join(path.resolve(SHOT), dump.p + '.png'), img.toPNG())
      } catch { }
    }
    if (dump.p === 'done') break
  }
  if (OUT) fs.writeFileSync(path.resolve(OUT), JSON.stringify({ samples, notes }, null, 1))
  notes.forEach((n) => console.log('[note] ' + n))

  if (!samples.length) { console.error('[sit-snap] 没采到样本'); app.exit(1) }
  const walk = samples.filter((s) => s.phase === 'walk')
  console.log('\n采样 ' + samples.length + ' 帧，walk 段 ' + walk.length + ' 帧')

  // 相位切换点（phase 第一次变）
  const marks = []
  let lastPhase = ''
  for (const s of samples) {
    if (s.phase !== lastPhase) { marks.push(s.phase + '@' + s.t + 'ms'); lastPhase = s.phase }
  }
  console.log('相位: ' + marks.join('  →  '))

  // 每帧最大转角：找出所有 > 8° 的尖峰
  const spikes = samples.filter((s) => s.maxDeg > 8)
  console.log('\n【单帧转角尖峰（>8°）】')
  if (!spikes.length) console.log('  没有尖峰')
  for (const s of spikes.slice(0, 24)) {
    console.log('  t=' + String(s.t).padStart(5) + 'ms ' + String(s.phase).padEnd(8) +
      ' ' + String(s.maxBone).padEnd(13) + ' ' + s.maxDeg.toFixed(1) + '°' +
      '  sit=' + s.sit + ' rig=' + (s.rig ? 1 : 0) + ' hold=' + (s.hold ? 1 : 0) +
      ' walk=' + (s.walkOn ? 1 : 0) + (s.handJump != null ? '  手位移=' + (s.handJump * 100).toFixed(1) + 'cm' : ''))
  }

  // 稳定期噪声基线（settled 段）
  const settled = samples.filter((s) => s.phase === 'settled')
  const stand = samples.filter((s) => s.phase === 'stand')
  const avg = (arr, k) => {
    const v = arr.map((x) => x[k]).filter((x) => typeof x === 'number')
    return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : '?'
  }
  console.log('\n【姿态几何】站立 → 坐定（世界 y，m）')
  for (const k of ['head', 'hip', 'hand', 'foot']) {
    console.log('  ' + k.padEnd(5) + ' ' + avg(stand, k) + ' → ' + avg(settled, k))
  }
  const base = settled.length ? settled.reduce((a, s) => a + s.maxDeg, 0) / settled.length : 0
  const worst = samples.reduce((a, s) => (s.maxDeg > a.maxDeg ? s : a), samples[0])
  console.log('\n【结论】')
  console.log('  静置基线 每帧 ' + base.toFixed(2) + '°')
  console.log('  全段最大  ' + worst.maxDeg.toFixed(1) + '° @ ' + worst.maxBone + ' t=' + worst.t + 'ms（' + worst.phase + '）')
  const big = samples.filter((s) => s.maxDeg > 25)
  console.log('  超过 25° 的帧: ' + big.length + (big.length ? '  ← 肉眼可见的抽搐' : '  （没有硬跳）'))
  const s1 = settled[settled.length - 1]
  const w1 = walk[walk.length - 1]
  const s0 = stand[stand.length - 1]
  if (s1) console.log('\n【膝/大腿】坐定 kneeRaw=' + s1.kneeRaw + '° thighRaw=' + JSON.stringify(s1.thighRaw) + ' | kneeNorm=' + s1.kneeNorm + '° thighNorm=' + JSON.stringify(s1.thighNorm))
  if (s0) console.log(' droop=' + (s0 && s0.droop));console.log(' 站立 kneeRaw=' + s0.kneeRaw + '° thighRaw=' + JSON.stringify(s0.thighRaw) + ' | thighNorm=' + JSON.stringify(s0.thighNorm))
  if (w1) console.log(' 走路 kneeRaw=' + w1.kneeRaw + '° | kneeNorm=' + w1.kneeNorm + '°')
  app.exit(0)
})
