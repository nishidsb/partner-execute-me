const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const MODEL = process.argv[2]
const OUT = process.argv[3] || path.join(path.dirname(MODEL || '.'), 'csp-probe.png')
const PAGE = path.join(__dirname, 'csp-vrm.html')

app.disableHardwareAcceleration = false
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 580, height: 800, show: false,
    webPreferences: { offscreen: false, backgroundThrottling: false, webSecurity: true }
  })
  const msgs = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (/Refused|Couldn't load texture|ERROR/i.test(message)) msgs.push(message.slice(0, 180))
  })
  await win.loadURL(pathToFileURL(PAGE).toString() + '?model=' + encodeURIComponent(pathToFileURL(MODEL).toString()) + (process.env.ONLY ? '&only=' + encodeURIComponent(process.env.ONLY) : '') + (process.env.WALK ? '&walk=1&dir=' + (process.env.DIR || '1') : '') + (process.env.WAIT ? '&wait=' + process.env.WAIT : '') + (process.env.POSE ? '&pose=' + process.env.POSE : ''))
  const t0 = Date.now()
  let probe = null
  while (Date.now() - t0 < 30000) {
    probe = await win.webContents.executeJavaScript('window.__probe || null').catch(() => null)
    if (probe) break
    await new Promise((r) => setTimeout(r, 200))
  }
  const shot = await win.webContents.executeJavaScript('window.__shot2 || window.__shot || null').catch(() => null)
  if (shot) fs.writeFileSync(OUT, Buffer.from(String(shot).split(',')[1], 'base64'))
  console.log('PROBE ' + JSON.stringify(probe))
  console.log('BLOCKED ' + JSON.stringify(msgs.slice(0, 4)))
  console.log('SHOT ' + (shot ? OUT : 'none'))
  app.quit()
})
