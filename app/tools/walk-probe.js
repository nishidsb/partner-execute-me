'use strict'
/** 走路朝向实测截图（不参与应用运行）
 *   electron tools/walk-probe.js <model.vrm> <out.png>
 * 真实 vrm-stage 驱动 dir=±1 各走 1.6s，截一帧拼图，肉眼判定朝向与位移是否同向。 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const plain = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const MODEL = path.resolve(plain[0] || '')
const OUT = path.resolve(plain[1] || path.join(__dirname, '..', 'captures', 'walk-probe.png'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[walk-probe] 超时退出'); app.exit(1) }, 120000)
  const win = new BrowserWindow({
    width: 620,
    height: 545,
    show: true,
    frame: false,
    backgroundColor: '#e8e8ec',
    webPreferences: { webSecurity: false }
  })
  const page = path.join(__dirname, 'preview', 'walk-probe.html')
  await win.loadFile(page, { query: { vrm: pathToFileURL(MODEL).toString() } })
  let probe = {}
  for (let i = 0; i < 150; i++) {
    await wait(200)
    probe = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__probe || {})'))
    if (probe.done) break
  }
  if (probe.notes && probe.notes.length) console.log('[walk-probe] notes:', probe.notes.join(' | '))
  await wait(300)
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, img.toPNG())
  console.log('[walk-probe] 已保存', OUT)
  app.exit(0)
})
