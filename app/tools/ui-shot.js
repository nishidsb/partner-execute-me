'use strict'
/* 设置页视觉验收：把 companion 设置页渲染出来截图，专门看「数字输入框里到底有没有数字」。
 * 不依赖主进程 IPC（缺 API 时页面内会有报错，但 DOM/CSS 照常生效，足够验证样式）。
 *
 * 跑法: cd app && env -u ELECTRON_RUN_AS_NODE npx electron tools/ui-shot.js <输出png> [宽] [高]
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const out = process.argv[2] || path.join(__dirname, '..', 'captures', 'settings-shot.png')
const W = Number(process.argv[3] || 1180)
const H = Number(process.argv[4] || 900)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[ui-shot] 超时'); app.exit(1) }, 60000)
  const win = new BrowserWindow({
    show: false, width: W, height: H, backgroundColor: '#111318',
    webPreferences: { nodeIntegration: false, contextIsolation: false, backgroundThrottling: false, offscreen: true }
  })
  win.webContents.on('console-message', () => { })
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'companion', 'index.html'))
  await wait(1200)
  const info = await win.webContents.executeJavaScript(`(() => {
    // 打开设置页，并切到包含目标字段的那个子页（sp-page）
    const tab = document.getElementById('tabSettings')
    if (tab) tab.hidden = false
    const anchor = document.getElementById('cpAutoIdle')
    if (anchor) {
      let el = anchor
      while (el && el !== document.body) {
        if (el.classList && el.classList.contains('sp-page')) el.hidden = false
        if (el.hidden) el.hidden = false
        el = el.parentElement
      }
    }
    // 填值（模拟真实回填）
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v }
    set('cpAutoIdle', 5); set('cpAutoMax', 20); set('cpAutoCount', 6)
    const row = document.getElementById('cpAutoIdle')
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' })
    const r = (id) => { const e = document.getElementById(id); if (!e) return null
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e)
      return { id, w: Math.round(b.width), h: Math.round(b.height), value: e.value, pad: cs.padding, color: cs.color, visible: b.width > 20 } }
    return { fields: [r('cpAutoIdle'), r('cpAutoMax'), r('cpAutoCount')],
             hasTab: !!tab }
  })()`)
  await wait(600)
  const img = await win.webContents.capturePage()
  fs.writeFileSync(out, img.toPNG())
  console.log(JSON.stringify(info, null, 1))
  console.log('[ui-shot] 已保存 ' + out)
  app.exit(0)
})
