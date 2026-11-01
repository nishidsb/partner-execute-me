'use strict'
/* 列出模型自带全部动画 clip 名，找待机候选 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const UD = process.env.APPDATA ? path.join(process.env.APPDATA, 'ryza-assistant-app') : ''
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  win.webContents.on('console-message', (_e, _l, m) => console.log('[page]', m))
  const libsPath = path.resolve(__dirname, '../src/renderer/companion/libs.js').replace(/\\/g, '/')
  const html = `<!doctype html><html><body>
<script src="file:///${libsPath}"></script>
<script>
(async () => {
  try {
    const fs = require('fs'); const path = require('path'); const L = window.AuraLibs
    const assetsDir = ${JSON.stringify(UD)} + '/companion/assets/workspaceid'
    const vrms = fs.readdirSync(assetsDir).filter(f => /\\.vrm$/i.test(f))
    const modelFile = vrms.includes('ryza2-ryza.vrm') ? 'ryza2-ryza.vrm' : vrms[0]
    const buf = fs.readFileSync(path.join(assetsDir, modelFile))
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const loader = new L.GLTFLoader()
    loader.register((p) => new L.THREEVRM.VRMLoaderPlugin(p))
    const gltf = await new Promise((ok, bad) => loader.parse(ab, '', ok, bad))
    const clips = (gltf.animations || []).filter(c => c && c.tracks && c.tracks.length)
    console.log('clip 总数=' + clips.length)
    // 打名字+时长，每行一条
    for (const c of clips) console.log('CLIP ' + (c.name || '(无名)') + ' | ' + c.duration.toFixed(2) + 's | tracks=' + c.tracks.length)
  } catch (e) { console.log('FATAL ' + (e && e.message)) }
  console.log('__DONE__')
})()
</script></body></html>`
  const tmp = path.join(os.tmpdir(), 'list-clips.html')
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  const t0 = Date.now()
  const timer = setInterval(() => { if (Date.now() - t0 > 40000) { try { app.quit() } catch { } } }, 1000)
  win.webContents.on('console-message', function watch (_e, _l, msg) {
    if (msg.includes('__DONE__')) { clearInterval(timer); setTimeout(() => app.quit(), 300) }
  })
})
