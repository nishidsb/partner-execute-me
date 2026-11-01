'use strict'
/**
 * 官方动画全量盘点截图（不参与应用运行）
 *   electron tools/anim-sweep.js <model.vrm> <out.png> --ids=gust_00000,gust_00010,... [--fracs=0.5]
 * 一次加载模型，按名字列表逐个 seek 渲染成连拍网格，用来给无名字的官方动画做语义盘点。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const args = process.argv.slice(2)
const idsArg = (args.find((a) => a.startsWith('--ids=')) || '').split('=')[1] || ''
const fracsArg = (args.find((a) => a.startsWith('--fracs=')) || '').split('=')[1] || '0.5'
const colsArg = Number((args.find((a) => a.startsWith('--cols=')) || '').split('=')[1]) || 6
const cwArg = Number((args.find((a) => a.startsWith('--cw=')) || '').split('=')[1]) || 240
const chArg = Number((args.find((a) => a.startsWith('--ch=')) || '').split('=')[1]) || 168
const zoomArg = (args.find((a) => a.startsWith('--zoom=')) || '').split('=')[1] || '1'
const plain = args.filter((a) => !a.startsWith('--'))
const MODEL = path.resolve(plain[0] || '')
const OUT = path.resolve(plain[1] || path.join(__dirname, '..', 'captures', 'anim-sweep.png'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[anim-sweep] 超时退出'); app.exit(1) }, 180000)
  const ids = idsArg.split(',').filter(Boolean)
  const fracs = fracsArg.split(',').map(Number).filter((x) => isFinite(x))
  const rows = Math.ceil(ids.length * fracs.length / colsArg)
  const win = new BrowserWindow({
    width: colsArg * cwArg + 20,
    height: rows * chArg + 20,
    show: true,
    frame: false,
    backgroundColor: '#e8e8ec',
    webPreferences: { webSecurity: false, offscreen: false }
  })
  const page = path.join(__dirname, 'preview', 'anim-sweep.html')
  await win.loadFile(page, {
    query: {
      vrm: pathToFileURL(MODEL).toString(), ids: idsArg,
      fracs: fracsArg, cols: String(colsArg),
      cw: String(cwArg), ch: String(chArg), zoom: String(zoomArg)
    }
  })
  let probe = {}
  for (let i = 0; i < 300; i++) {
    await wait(200)
    probe = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__probe || {})'))
    if (probe.done) break
  }
  if (probe.notes && probe.notes.length) console.log('[anim-sweep] notes:', probe.notes.join(' | '))
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, img.toPNG())
  console.log('[anim-sweep] 已保存', OUT)
  app.exit(0)
})
