'use strict'
/**
 * 动画烘入验证截图（不参与应用运行）
 *   electron tools/anim-sheet.js <model.vrm> [out.png] [--clips=idle,walk,...]
 * 每格播放一个 clip（名字逗号分隔），验证 g1a -> VRM 烘入结果。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const args = process.argv.slice(2)
const clipsArg = (args.find((a) => a.startsWith('--clips=')) || '').split('=')[1] || 'idle,walk,walkfast,run,runfast'
const seeksArg = (args.find((a) => a.startsWith('--seeks=')) || '').split('=')[1] || ''
const plain = args.filter((a) => !a.startsWith('--'))
const MODEL = path.resolve(plain[0] || '')
const OUT = path.resolve(plain[1] || path.join(__dirname, '..', 'captures', 'anim-sheet.png'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[anim-sheet] 超时退出'); app.exit(1) }, 90000)
  const n = clipsArg.split(',').filter(Boolean).length
  const win = new BrowserWindow({
    width: Math.max(900, n * 300),
    height: 460,
    show: true,
    frame: false,
    backgroundColor: '#e8e8ec',
    webPreferences: { webSecurity: false, offscreen: false }
  })
  const page = path.join(__dirname, 'preview', 'anim-sheet.html')
  await win.loadFile(page, { query: { vrm: pathToFileURL(MODEL).toString(), clips: clipsArg, seeks: seeksArg, noauto: '1' } })
  let probe = {}
  for (let i = 0; i < 50; i++) {
    await wait(200)
    probe = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__probe || {})'))
    if (probe.done) break
  }
  if (probe.notes && probe.notes.length) console.log('[anim-sheet] notes:', probe.notes.join(' | '))
  await wait(1200) // 播到动作中段
  const angles = await win.webContents.executeJavaScript('JSON.stringify(window.__angles ? window.__angles() : [])')
  console.log('[anim-sheet] 骨骼采样', angles)
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, img.toPNG())
  console.log('[anim-sheet] 已保存', OUT)
  app.exit(0)
})
