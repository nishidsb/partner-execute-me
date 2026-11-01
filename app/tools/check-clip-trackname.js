'use strict'
/* 验证官方 clip 轨道命名（判别式依赖）：raw 名 vs Normalized_ 前缀 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const UD = process.env.APPDATA ? path.join(process.env.APPDATA, 'ryza-assistant-app') : ''
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_e, _l, m) => console.log('[page]', m))
  const libsPath = path.resolve(__dirname, '../src/renderer/companion/libs.js').replace(/\\/g, '/')
  const html = `<!doctype html><html><body>
<script src="file:///${libsPath}"></script>
<script>
(async () => {
  try {
    const fs = require('fs'); const path = require('path'); const L = window.AuraLibs
    const ud = ${JSON.stringify(UD)}
    const assetsDir = path.join(ud, 'companion', 'assets', 'workspaceid')
    const vrms = fs.readdirSync(assetsDir).filter(f => /\\.vrm$/i.test(f))
    const modelFile = vrms.includes('ryza2-ryza.vrm') ? 'ryza2-ryza.vrm' : vrms[0]
    const buf = fs.readFileSync(path.join(assetsDir, modelFile))
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const loader = new L.GLTFLoader()
    loader.register((p) => new L.THREEVRM.VRMLoaderPlugin(p))
    const gltf = await new Promise((ok, bad) => loader.parse(ab, '', ok, bad))
    const clips = (gltf.animations || []).filter(c => c && c.tracks && c.tracks.length)
    console.log('官方 clip 数=' + clips.length)
    let norm = 0
    for (const c of clips) { if (/^Normalized_/.test(String(c.tracks[0].name || ''))) norm++ }
    console.log('首轨道带 Normalized_ 前缀的=' + norm)
    const names = new Set()
    for (const c of clips.slice(0, 40)) names.add(c.tracks[0].name)
    console.log('首轨道名样例: ' + [...names].slice(0, 8).join(' | '))
  } catch (e) { console.log('FATAL ' + (e && e.message)) }
  console.log('__DONE__')
})()
</script></body></html>`
  const tmp = path.join(os.tmpdir(), 'check-clip-trackname.html')
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  const t0 = Date.now()
  const timer = setInterval(() => { if (Date.now() - t0 > 20000) { try { app.quit() } catch { } } }, 1000)
  win.webContents.once('console-message', function watch (_e, _l, msg) {
    if (msg.includes('__DONE__')) { clearInterval(timer); setTimeout(() => app.quit(), 300) }
    else win.webContents.once('console-message', watch)
  })
})
