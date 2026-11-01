'use strict'
/**
 * 0.45.63 官方 clip 对照截图（不参与应用运行）
 *   npx electron tools/clip-sheet.js <model.vrm> <clip1,clip2,...> [out.png]
 *
 * 官方 374 条全是 gust_XXXXX 代号，光看名字挑不出「像待机小动作」的，
 * 一次渲染多格看剪影，挑完再写进待机池（比一条一条装 exe 试快得多）。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const plain = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const modelArg = plain[0] || ''
const clipsArg = plain[1] || ''
const outArg = plain[2] || ''
if (!modelArg || !clipsArg) {
  console.error('[clip-sheet] 用法: electron tools/clip-sheet.js <model.vrm> <clip1,clip2,...> [out.png]')
  app.exit(2)
}
const MODEL = path.resolve(modelArg)
const OUT = path.resolve(outArg || path.join(__dirname, '..', 'captures', 'clip-sheet.png'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[clip-sheet] 超时退出'); app.exit(1) }, 120000)
  const n = clipsArg.split(',').filter(Boolean).length
  const cols = Math.min(4, n)
  const rows = Math.ceil(n / cols)
  const win = new BrowserWindow({
    width: 1400,
    height: Math.min(1320, rows * 596 + 20),
    show: true,
    frame: false,
    backgroundColor: '#1d2030',
    webPreferences: { webSecurity: false, offscreen: false }
  })
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 1) console.log('[page]', msg.slice(0, 240)) })
  const page = path.join(__dirname, 'preview', 'clip-sheet.html')
  await win.loadFile(page, { query: { model: pathToFileURL(MODEL).toString(), clips: clipsArg, force: process.env.FORCE_AU || '' } })
    .catch((e) => console.error('[clip-sheet] 载入失败', e.message))

  for (let i = 0; i < 60; i++) {
    await wait(500)
    const probe = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__probe || {})'))
    if (probe.error) { console.error('[clip-sheet] 渲染失败:', probe.error); break }
    if (probe.ready) { console.log('[clip-sheet] 就绪', probe.notes.join(' / ')); break }
  }
  // 500ms 触发 + 等 1200ms ≈ clip 中段
  await wait(1300)
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, img.toPNG())
  console.log('[clip-sheet] 已保存', OUT, fs.statSync(OUT).size, 'bytes')
  app.exit(0)
})
