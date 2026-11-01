'use strict'
/**
 * 3D 模型自查截图（不参与应用运行）
 *   npx electron tools/vrm-shot.js <model.vrm|model.glb> [out.png]
 *
 * 用真实的 libs.js + vrm-stage.js 把模型渲染到一个离屏窗口，再 capturePage 存 PNG。
 * 用途：PMX→VRM 转换后肉眼确认「贴图在、朝向对、没有被裁掉」，不用靠用户截图。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

// Chromium 开关也会出现在 argv 里（--use-angle=… 之类），这里只取非开关参数的最后两个
const plain = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const modelArg = plain[plain.length - 2] || ''
const outArg = plain[plain.length - 1] || ''
if (!modelArg) {
  console.error('[vrm-shot] 用法: electron tools/vrm-shot.js <model.vrm|glb> [out.png]')
  app.exit(2)
}
const MODEL = path.resolve(modelArg)
const OUT = path.resolve(outArg || path.join(__dirname, '..', 'captures', 'vrm-shot.png'))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))


app.whenReady().then(async () => {
  setTimeout(() => { console.error('[vrm-shot] 超时退出'); app.exit(1) }, 60000)
  const win = new BrowserWindow({
    width: 560,
    height: 900,
    show: false,
    frame: false,
    backgroundColor: '#1d2030',
    webPreferences: {
      // 自查页要直接 fetch file:// 的模型文件
      webSecurity: false,
      offscreen: false
    }
  })
  const page = path.join(__dirname, 'preview', 'vrm-shot.html')
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 1) console.log('[page]', msg.slice(0, 300)) })
  await win.loadFile(page, { query: { model: pathToFileURL(MODEL).toString() } }).catch((e) => console.error('[vrm-shot] 载入失败', e.message, e.code))
  // 等模型解析 + 几帧渲染（springbone 也要稳定一下）
  for (let i = 0; i < 40; i++) {
    await wait(500)
    const st = await win.webContents.executeJavaScript('JSON.stringify(window.__probe || {})')
    const probe = JSON.parse(st)
    if (i % 4 === 0) console.log('[vrm-shot] probe', st.slice(0, 200))
    if (probe.error) { console.error('[vrm-shot] 渲染失败:', probe.error); break }
    if (probe.ready) { console.log('[vrm-shot] 模型已就绪:', probe.kind); break }
  }
  await wait(1500)
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, img.toPNG())
  console.log('[vrm-shot] 已保存', OUT, fs.statSync(OUT).size, 'bytes')
  app.exit(0)
})
