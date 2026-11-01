'use strict'
/**
 * 动画骨骼世界坐标探针（构建期，不参与运行）
 *   electron tools/anim-probe.js <model.vrm> --ids=gust_01300,gust_30231 [--fracs=0,0.5,1]
 * 用 three.js 真实渲染链路算一遍骨骼世界坐标，用来校验 tools/anim-classify.js 的 FK。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const args = process.argv.slice(2)
const q = (k, d) => (args.find((a) => a.startsWith('--' + k + '=')) || '').split('=')[1] || d
const plain = args.filter((a) => !a.startsWith('--'))
const MODEL = path.resolve(plain[0] || '')
const IDS = q('ids', 'gust_01300,gust_30231,gust_00110,idle_still')
const FRACS = q('fracs', '0,0.5,1')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { webSecurity: false } })
  const page = path.join(__dirname, 'preview', 'anim-probe.html')
  await win.loadFile(page, { query: { vrm: pathToFileURL(MODEL).toString(), ids: IDS, fracs: FRACS } })
  let out = null
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 200))
    const p = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__probe || {})'))
    if (p.error) { console.error('[probe]', p.error); app.exit(1); return }
    if (p.done) { out = p; break }
  }
  if (!out) { console.error('[probe] 超时'); app.exit(1); return }
  for (const r of out.rows) {
    console.log(r.id.padEnd(12), 't=' + String(r.t).padEnd(5),
      'hip', r.hip.join(','), 'head', r.head.join(','),
      'handL', r.handL.join(','), 'footL', r.footL.join(','))
  }
  app.exit(0)
})
