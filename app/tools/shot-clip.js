'use strict'
/* 渲染模型自带 clip 的某一帧 → PNG
 * 跑法: npx electron tools/shot-clip.js <clip名> [out.png] [采样时刻比例0.5] */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const UD = process.env.APPDATA ? path.join(process.env.APPDATA, 'ryza-assistant-app') : ''
const plain = process.argv.slice(2).filter(a => !a.startsWith('--'))
const NAME = plain[0] || 'idle'
const OUT = path.resolve(plain[1] || ('captures/clip-' + NAME + '.png'))
const FRAC = Number(plain[2] || 0.5)
app.whenReady().then(async () => {
  setTimeout(() => { console.error('超时'); app.exit(1) }, 60000)
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 420, height: 640,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true } })
  win.webContents.on('console-message', (_e, _l, m) => { if (!m.includes('Security')) console.log('[page]', m) })
  const libsPath = path.resolve(__dirname, '../src/renderer/companion/libs.js').replace(/\\/g, '/')
  const html = `<!doctype html><html><body style="margin:0">
<canvas id="c" width="420" height="640"></canvas>
<script src="file:///${libsPath}"></script>
<script>
(async () => {
  try {
    const fs = require('fs'); const path = require('path'); const THREE = window.AuraLibs.THREE; const L = window.AuraLibs
    const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    const assetsDir = ${JSON.stringify(UD)} + '/companion/assets/workspaceid'
    const vrms = fs.readdirSync(assetsDir).filter(f => /\\.vrm$/i.test(f))
    const modelFile = vrms.includes('ryza2-ryza.vrm') ? 'ryza2-ryza.vrm' : vrms[0]
    const loader = new L.GLTFLoader()
    loader.register((p) => new L.THREEVRM.VRMLoaderPlugin(p))
    const gltf = await new Promise((ok, bad) => loader.parse(toAB(fs.readFileSync(path.join(assetsDir, modelFile))), '', ok, bad))
    const vrm = gltf.userData.vrm
    const clip = (gltf.animations || []).find(c => c.name === ${JSON.stringify(NAME)})
    if (!clip) { console.log('FATAL 无此clip'); return }
    const canvas = document.getElementById('c')
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    renderer.setSize(420, 640, false)
    const scene = new THREE.Scene()
    const cam = new THREE.PerspectiveCamera(30, 420 / 640, 0.1, 20)
    cam.position.set(0, 1.0, 3.1); cam.lookAt(0, 0.9, 0)
    const dl = new THREE.DirectionalLight(0xffffff, 1.1); dl.position.set(1, 2, 2)
    scene.add(dl); scene.add(new THREE.AmbientLight(0xffffff, 0.55)); scene.add(vrm.scene)
    const mixer = new THREE.AnimationMixer(vrm.scene)
    mixer.clipAction(clip).play()
    if (vrm.humanoid) vrm.humanoid.autoUpdateHumanBones = false // 官方 clip 直绑 raw，开 true 会被 update 刷回 rest
    window.__go = (t) => { mixer.setTime(t); vrm.update(1 / 30); renderer.render(scene, cam); return true }
    window.__T = clip.duration
    console.log('__READY__ ' + clip.duration.toFixed(2) + 's')
  } catch (e) { console.log('FATAL ' + (e && e.message)) }
})()
</script></body></html>`
  const tmp = path.join(os.tmpdir(), 'shot-clip.html')
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  let ready = false
  win.webContents.on('console-message', (_e, _l, m) => { if (m.includes('__READY__')) ready = true })
  for (let i = 0; i < 200 && !ready; i++) await new Promise(r => setTimeout(r, 100))
  if (!ready) { console.error('未就绪'); app.exit(1) }
  const T = await win.webContents.executeJavaScript('window.__T')
  await win.webContents.executeJavaScript(`window.__go(${(T * FRAC).toFixed(3)})`)
  await new Promise(r => setTimeout(r, 150))
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, (await win.webContents.capturePage()).toPNG())
  console.log('OK → ' + OUT)
  app.exit(0)
})
