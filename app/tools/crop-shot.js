'use strict'
// 截图裁剪放大（纯 canvas，无 .NET）：electron tools/crop-shot.js <in.png> <out.png> <x> <y> <w> <h> [scale]
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const plain = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const [IN, OUT, X, Y, W, H, S] = plain
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: Number(W) * (Number(S) || 4), height: Number(H) * (Number(S) || 4), show: false, useContentSize: true, webPreferences: { webSecurity: false } })
  const html = `<!DOCTYPE html><html><body><canvas id="c"></canvas><script>
    const img = new Image()
    img.onload = () => {
      const s = ${Number(S) || 4}
      const c = document.getElementById('c')
      c.width = ${Number(W)} * s; c.height = ${Number(H)} * s
      const g = c.getContext('2d')
      g.imageSmoothingEnabled = false
      g.drawImage(img, ${Number(X)}, ${Number(Y)}, ${Number(W)}, ${Number(H)}, 0, 0, c.width, c.height)
      document.title = 'DONE'
    }
    img.src = '${pathToFileURL(path.resolve(IN)).toString()}'
  </script></body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  for (let i = 0; i < 20; i++) { await wait(200); if ((await win.webContents.executeJavaScript('document.title')) === 'DONE') break }
  await wait(300)
  const img = await win.webContents.capturePage()
  fs.writeFileSync(OUT, img.toPNG())
  console.log('[crop] 已保存', OUT)
  app.exit(0)
})
