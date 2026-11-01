'use strict'
/* video2vrma 第三段验证：离线加载「角色 VRM + 产出的 .vrma」，渲染关键帧出 PNG 肉眼验收。
 * 跑法: cd app && env -u ELECTRON_RUN_AS_NODE npx electron tools/check-pose2vrma.js <motion.vrma> [out前缀] [帧数4]
 * 输出: captures/pose2vrma-<前缀>-<i>.png（等时间距采样）
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const UD = process.env.APPDATA ? path.join(process.env.APPDATA, 'ryza-assistant-app') : ''

const plain = process.argv.slice(2).filter(a => !a.startsWith('--'))
const motionArg = plain[0] || ''
const outPrefix = plain[1] || 'p'
const nShots = Number(plain[2] || 4)
if (!motionArg) { console.error('[check-pose2vrma] 用法: electron tools/check-pose2vrma.js <motion.vrma> [前缀] [帧数]'); app.exit(2) }
const MOTION = path.resolve(motionArg)
const OUTDIR = path.join(__dirname, '..', 'captures')
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true })

const wait = (ms) => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  setTimeout(() => { console.error('[check-pose2vrma] 超时退出'); app.exit(1) }, 90000)
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 420,
    height: 640,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true }
  })
  win.webContents.on('console-message', (_e, _l, m) => { if (!m.includes('Security Warning')) console.log('[page]', m) })
  const libsPath = path.resolve(__dirname, '../src/renderer/companion/libs.js').replace(/\\/g, '/')
  const motionJs = JSON.stringify(MOTION.replace(/\\/g, '/'))
  const html = `<!doctype html><html><body style="margin:0">
<canvas id="c" width="420" height="640"></canvas>
<script src="file:///${libsPath}"></script>
<script>
(async () => {
  try {
    const fs = require('fs'); const path = require('path'); const THREE = window.AuraLibs.THREE; const L = window.AuraLibs
    const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const ud = ${JSON.stringify(UD)}
    const assetsDir = ud + '/companion/assets/workspaceid'
    const vrms = fs.readdirSync(assetsDir).filter(f => /\\.vrm$/i.test(f))
    const modelFile = vrms.includes('ryza2-ryza.vrm') ? 'ryza2-ryza.vrm' : vrms[0]
    const loader = new L.GLTFLoader()
    loader.register((p) => new L.THREEVRM.VRMLoaderPlugin(p))
    loader.register((p) => new L.VRMAnim.VRMAnimationLoaderPlugin(p))
    const gltf = await new Promise((ok, bad) => loader.parse(toAB(fs.readFileSync(path.join(assetsDir, modelFile))), '', ok, bad))
    const vrm = gltf.userData.vrm
    const g2 = await new Promise((ok, bad) => loader.parse(toAB(fs.readFileSync(${motionJs})), '', ok, bad))
    const va = g2.userData.vrmAnimations[0]
    const clip = L.VRMAnim.createVRMAnimationClip(va, vrm)
    console.log('clip 时长=' + clip.duration.toFixed(2) + ' 轨道=' + clip.tracks.length)
    const canvas = document.getElementById('c')
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    renderer.setSize(420, 640, false)
    const scene = new THREE.Scene()
    const cam = new THREE.PerspectiveCamera(30, 420 / 640, 0.1, 20)
    cam.position.set(0, 1.0, 3.1)
    cam.lookAt(0, 0.9, 0)
    const dl = new THREE.DirectionalLight(0xffffff, 1.1)
    dl.position.set(1, 2, 2)
    scene.add(dl)
    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    scene.add(vrm.scene)
    const mixer = new THREE.AnimationMixer(vrm.scene)
    const act = mixer.clipAction(clip)
    act.play()
    if (vrm.humanoid) vrm.humanoid.autoUpdateHumanBones = true
    window.__stage = { mixer, vrm, renderer, scene, cam, T: clip.duration }
    console.log('__READY__')
  } catch (e) { console.log('FATAL ' + (e && (e.stack || e.message))) }
})()
window.__render = (t) => {
  const s = window.__stage
  if (!s) return false
  s.mixer.setTime(Math.min(t, s.T - 0.001))
  s.vrm.update(1 / 30)
  s.renderer.render(s.scene, s.cam)
  return true
}
</script></body></html>`
  const tmp = path.join(os.tmpdir(), 'check-pose2vrma.html')
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)

  // 等 __READY__
  let ready = false
  win.webContents.on('console-message', (_e, _l, m) => { if (m.includes('__READY__')) ready = true })
  for (let i = 0; i < 300 && !ready; i++) await wait(100)
  if (!ready) { console.error('页面未就绪'); app.exit(1) }

  const T = await win.webContents.executeJavaScript('window.__stage.T')
  for (let i = 0; i < nShots; i++) {
    const t = T * (i + 0.5) / nShots
    await win.webContents.executeJavaScript(`window.__render(${t})`)
    await wait(120)
    const img = await win.webContents.capturePage()
    const out = path.join(OUTDIR, `pose2vrma-${outPrefix}-${i}.png`)
    fs.writeFileSync(out, img.toPNG())
    console.log(`shot ${i} t=${t.toFixed(2)} → ${out}`)
  }
  console.log('__DONE__')
  app.exit(0)
})
