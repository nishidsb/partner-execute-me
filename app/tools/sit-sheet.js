'use strict'
/**
 * 0.45.54 坐姿手势对照截图（不参与应用运行）
 *   npx electron tools/sit-sheet.js <model.vrm> [out.png]
 *
 * 八个格子：sit-idle / phoneCheck / lookAroundBig / legBounce / think / handHip /
 *           fixHair / lookAside。
 * 用途：用户「坐着没动作」，新增看手机/抖腿/大张望这些大剪影动作后，
 * 先一次截图看清「手抬到哪、头低多少」，别让角度错的姿势上机（一次截图代替反复重装）。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const plain = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const modelArg = plain[plain.length - 2] || ''
const outArg = plain[plain.length - 1] || ''
if (!modelArg) {
  console.error('[sit-sheet] 用法: electron tools/sit-sheet.js <model.vrm> [out.png]')
  app.exit(2)
}
const MODEL = path.resolve(modelArg)
const OUT = path.resolve(outArg || path.join(__dirname, '..', 'captures', 'sit-sheet.png'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[sit-sheet] 超时退出'); app.exit(1) }, 90000)
  const win = new BrowserWindow({
    width: 1400,
    height: 1260,
    // 必须真显示：show:false 时合成器不更新，capturePage 抓到首帧（踩过）
    show: true,
    frame: false,
    backgroundColor: '#1d2030',
    webPreferences: { webSecurity: false, offscreen: false }
  })
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 1) console.log('[page]', msg.slice(0, 300)) })
  const page = path.join(__dirname, 'preview', 'pose-sheet-sit.html')
  await win.loadFile(page, { query: { model: pathToFileURL(MODEL).toString() } })
    .catch((e) => console.error('[sit-sheet] 载入失败', e.message, e.code))

  for (let i = 0; i < 60; i++) {
    await wait(500)
    const probe = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__probe || {})'))
    if (probe.error) { console.error('[sit-sheet] 渲染失败:', probe.error); break }
    if (probe.ready) { console.log('[sit-sheet] 八个舞台就绪', probe.notes.join(' / ')); break }
  }
  // setup 在 ready+300ms 触发 → 坐下 900ms 后播手势 → 再等 1170ms = 手势 45%（峰值区）
  await wait(2400)
  const hands = await win.webContents.executeJavaScript('JSON.stringify(window.__hands ? window.__hands() : [])')
  console.log('[sit-sheet] 手部/头部采样', hands)
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, img.toPNG())
  console.log('[sit-sheet] 已保存', OUT, fs.statSync(OUT).size, 'bytes')
  app.exit(0)
})
