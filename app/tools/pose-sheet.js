'use strict'
/**
 * 站姿 / 待机手势 / 走路 对照截图（不参与应用运行）
 *   npx electron tools/pose-sheet.js <model.vrm> [out.png]
 *
 * 六个格子并排：idle / stretch / handHip / lookAside / walk 46 / walk 76。
 * 用途：改完 vrm-stage 的姿态参数后，一次截图就能看出「站得自不自然、动作读不读得出来」，
 * 不用反复重装 exe 让用户帮看（0.30.0 调站姿就是这么验的）。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const plain = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const modelArg = plain[plain.length - 2] || ''
const outArg = plain[plain.length - 1] || ''
if (!modelArg) {
  console.error('[pose-sheet] 用法: electron tools/pose-sheet.js <model.vrm> [out.png]')
  app.exit(2)
}
const MODEL = path.resolve(modelArg)
const OUT = path.resolve(outArg || path.join(__dirname, '..', 'captures', 'pose-sheet.png'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[pose-sheet] 超时退出'); app.exit(1) }, 90000)
  const win = new BrowserWindow({
    width: 2760,
    height: 460,
    // 必须真显示：show:false 时合成器不更新画面，capturePage 抓到的是首帧
    // （6 个格子姿态明明不同、截出来却一模一样，踩过一次）
    show: true,
    frame: false,
    backgroundColor: '#1d2030',
    webPreferences: { webSecurity: false, offscreen: false }
  })
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 1) console.log('[page]', msg.slice(0, 300)) })
  const page = path.join(__dirname, 'preview', 'pose-sheet.html')
  await win.loadFile(page, { query: { model: pathToFileURL(MODEL).toString() } })
    .catch((e) => console.error('[pose-sheet] 载入失败', e.message, e.code))

  for (let i = 0; i < 50; i++) {
    await wait(500)
    const probe = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__probe || {})'))
    if (probe.error) { console.error('[pose-sheet] 渲染失败:', probe.error); break }
    if (probe.ready) { console.log('[pose-sheet] 六个舞台就绪', probe.notes.join(' / ')); break }
  }
  // 剧本 0.4s 触发、手势统一 2s 时长，等 1300ms = 动作进行到 45%（峰值区）
  await wait(1300)
  const angles = await win.webContents.executeJavaScript('JSON.stringify(window.__angles ? window.__angles() : [])')
  console.log('[pose-sheet] 姿态采样', angles)
  const hands = await win.webContents.executeJavaScript('JSON.stringify(window.__hands ? window.__hands() : [])')
  console.log('[pose-sheet] 手部坐标', hands)
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, img.toPNG())
  console.log('[pose-sheet] 已保存', OUT, fs.statSync(OUT).size, 'bytes')
  app.exit(0)
})
