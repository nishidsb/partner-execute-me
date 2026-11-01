#!/usr/bin/env node
/* 0.45.67 坐姿/呼吸运动学探针（自查用，不参与应用运行）
 *   env -u ELECTRON_RUN_AS_NODE npx electron tools/sit-probe.js <model.vrm> [--json out.json]
 *
 * 用户三个抱怨都要变成数字才能改得准：
 *   ①「呼吸像漂浮在空中」→ 站立阶段脚底(minY)的波动幅度。>1cm = 脚离地 = 飘
 *   ②「坐下的时候一直抖」→ 落定后 root.y 的波动 / sitAmt 是否往回走
 *   ③「坐下之前有个怪动作很短」→ 过渡开始那几帧 minY/maxY 的跳变量
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const plain = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const jsonIdx = process.argv.indexOf('--json')
const modelArg = plain.find((a) => /\.(vrm|glb)$/i.test(a)) || ''
if (!modelArg) {
  console.error('[sit-probe] 用法: electron tools/sit-probe.js <model.vrm> [--json out.json]')
  app.exit(2)
}
const OUT = jsonIdx > 0 ? path.resolve(process.argv[jsonIdx + 1]) : ''
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function stats (arr) {
  if (!arr.length) return { n: 0 }
  const min = Math.min(...arr)
  const max = Math.max(...arr)
  return { n: arr.length, min: +min.toFixed(4), max: +max.toFixed(4), span: +(max - min).toFixed(4) }
}

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[sit-probe] 超时'); app.exit(1) }, 90000)
  const win = new BrowserWindow({
    width: 340, height: 560, show: true, frame: false,
    backgroundColor: '#1d2030',
    webPreferences: { webSecurity: false, offscreen: false }
  })
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 1) console.log('[page]', String(msg).slice(0, 200)) })
  await win.loadFile(path.join(__dirname, 'preview', 'sit-probe.html'), {
    query: { model: pathToFileURL(path.resolve(modelArg)).toString() }
  })

  // 等 done（站立 1.5s + 坐下 3s，虚拟时钟 2 倍速 → 实际约 3s）
  let samples = []
  for (let i = 0; i < 60; i++) {
    await wait(500)
    const dump = JSON.parse(await win.webContents.executeJavaScript(
      'JSON.stringify({s: window.__samples, e: window.__err, p: window.__phase})'))
    if (dump.e) { console.error('[sit-probe] 页面错误:', dump.e); break }
    samples = dump.s || []
    if (dump.p === 'done') break
  }
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ samples }, null, 1)) }

  const stand = samples.filter((s) => s.phase === 'stand')
  const sit = samples.filter((s) => s.phase === 'sit')
  const settled = samples.filter((s) => s.phase === 'settled' || s.phase === 'done')

  console.log('\n采样 ' + samples.length + ' 帧（' + (stand.length ? stand[0].t : 0) + 'ms 起）')
  console.log('\n【① 站立呼吸】脚底 minY 波动 = 脚是否离地')
  console.log('  ' + JSON.stringify(stats(stand.map((s) => s.minY))))
  console.log('  头顶 maxY 波动 ' + JSON.stringify(stats(stand.map((s) => s.maxY))))
  console.log('  root.y 波动 ' + JSON.stringify(stats(stand.map((s) => s.rootY))))

  console.log('\n【② 坐下过渡】sitAmt 是否单调 + 逐帧最大跳变')
  const s1 = sit.map((s) => s.sit)
  let back = 0
  for (let i = 1; i < s1.length; i++) if (s1[i] < s1[i - 1] - 1e-6) back++
  let maxJump = 0
  for (let i = 1; i < sit.length; i++) {
    maxJump = Math.max(maxJump, Math.abs(sit[i - 1].minY - sit[i].minY), Math.abs(sit[i - 1].maxY - sit[i].maxY))
  }
  console.log('  sitAmt 回退帧数 ' + back + (back ? '  ← 抖动' : '（单调）'))
  console.log('  过渡期逐帧最大跳变 ' + maxJump.toFixed(4) + '（模型高约 ' + (stand[0] ? (stand[0].maxY - stand[0].minY).toFixed(2) : '?') + 'm）')

  console.log('\n【③ 落定后】')
  console.log('  root.y ' + JSON.stringify(stats(settled.map((s) => s.rootY))))
  console.log('  minY  ' + JSON.stringify(stats(settled.map((s) => s.minY))))
  const tail = settled.slice(Math.floor(settled.length * 0.6))
  let jitter = 0
  for (let i = 1; i < tail.length; i++) jitter = Math.max(jitter, Math.abs(tail[i].rootY - tail[i - 1].rootY))
  console.log('  尾部 root.y 逐帧最大差 ' + jitter.toFixed(5) + (jitter > 0.0005 ? '  ← 还在动（抖）' : '（稳定）'))

  /* ④ 坐下前那一瞬：holdAnim 硬切会造成手/头瞬跳，用户看到「一个很短的奇怪动作」 */
  const withHand = samples.filter((s) => s.handY != null)
  let worst = { v: 0, i: -1 }
  for (let i = 1; i < withHand.length; i++) {
    const dh = Math.abs(withHand[i].handY - withHand[i - 1].handY)
    if (dh > worst.v) worst = { v: dh, i }
  }
  console.log('\n【④ 坐下前瞬跳】手/头世界坐标逐帧最大跳变（0.02m 以上才看得出来）')
  if (worst.i > 0) {
    const a = withHand[worst.i - 1]
    const b = withHand[worst.i]
    console.log('  手部最大跳变 ' + worst.v.toFixed(4) + 'm @ t=' + b.t + 'ms（' + a.phase + '→' + b.phase +
      ' rig=' + (b.rig ? 1 : 0) + ' sit=' + b.sit + '）')
    console.log('  该帧附近 handY: ' + withHand.slice(Math.max(0, worst.i - 3), worst.i + 3).map((s) => s.handY.toFixed(3)).join(' → '))
    let wh = 0
    for (let i = 1; i < withHand.length; i++) {
      wh = Math.max(wh, Math.abs((withHand[i].headY || 0) - (withHand[i - 1].headY || 0)))
    }
    console.log('  头部最大跳变 ' + wh.toFixed(4) + 'm')
  } else console.log('  （没采到手部骨骼）')

  app.exit(0)
})
