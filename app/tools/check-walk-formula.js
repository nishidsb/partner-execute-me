'use strict'
/* 0.45.48 公式验证②：raw = parentWorldRest⁻¹ ⊗ norm ⊗ parentWorldRest ⊗ rawRest
 * 跑法：cd app && env -u ELECTRON_RUN_AS_NODE npx electron tools/check-walk-formula.js */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const UD = process.env.APPDATA ? path.join(process.env.APPDATA, 'ryza-assistant-app') : ''

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  })
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[page]', message)
  })
  const libsPath = path.resolve(__dirname, '../src/renderer/companion/libs.js').replace(/\\/g, '/')
  const html = `<!doctype html><html><body>
<script src="file:///${libsPath}"></script>
<script>
(async () => {
  const fs = require('fs')
  const path = require('path')
  const L = window.AuraLibs
  const THREE = L.THREE
  const say = (s) => console.log(s)
  try {
    const ud = ${JSON.stringify(UD)}
    const assetsDir = path.join(ud, 'companion', 'assets', 'workspaceid')
    const vrms = fs.readdirSync(assetsDir).filter(f => /\\.vrm$/i.test(f))
    const modelFile = vrms.includes('ryza2-ryza.vrm') ? 'ryza2-ryza.vrm' : vrms[0]
    const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const loader = new L.GLTFLoader()
    loader.register((p) => new L.THREEVRM.VRMLoaderPlugin(p))
    loader.register((p) => new L.VRMAnim.VRMAnimationLoaderPlugin(p))
    const gltf = await new Promise((ok, bad) => loader.parse(toAB(fs.readFileSync(path.join(assetsDir, modelFile))), '', ok, bad))
    const vrm = gltf.userData.vrm
    const g2 = await new Promise((ok, bad) => loader.parse(toAB(fs.readFileSync(path.join(ud, 'motions', 'walk.vrma'))), '', ok, bad))
    const a = g2.userData.vrmAnimations[0]
    const clip = L.VRMAnim.createVRMAnimationClip(a, vrm)

    const h = vrm.humanoid
    say('autoUpdateHumanBones=' + h.autoUpdateHumanBones)
    const nhb = h._normalizedHumanBones
    say('私有数据可访问=' + !!nhb + ' parentWorldRotations=' + Object.keys(nhb._parentWorldRotations || {}).length)

    const mixer = new THREE.AnimationMixer(vrm.scene)
    const act = mixer.clipAction(clip)
    act.setLoop(THREE.LoopRepeat, Infinity)
    act.play()

    // 侦测 humanoid.update 调用
    let updateCalls = 0
    const origUpdate = h.update.bind(h)
    h.update = function () { updateCalls++; return origUpdate() }

    // 骨骼引用
    const bones = ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftUpperArm', 'leftHand'].map((n) => ({
      name: n,
      norm: h.getNormalizedBoneNode(n),
      raw: h.getRawBoneNode(n),
      pw: nhb._parentWorldRotations[n],
      br: nhb._boneRotations[n]
    }))
    for (const b of bones) {
      say(b.name + ': raw=' + (b.raw && b.raw.name) + ' norm=' + (b.norm && b.norm.name) +
        ' pw=' + (b.pw ? '有' : '无') + ' br=' + (b.br ? '有' : '无'))
    }
    const q = (x) => [x.x, x.y, x.z, x.w].map((v) => v.toFixed(4)).join(',')
    const errOf = (p, r) => (Math.abs(p.x - r.x) + Math.abs(p.y - r.y) + Math.abs(p.z - r.z) + Math.abs(p.w - r.w))

    const dt = 1 / 30
    for (let i = 0; i < 30; i++) {
      mixer.update(dt)
      vrm.update(dt)
      if (i === 0 || i === 15 || i === 29) {
        say('--- 第 ' + i + ' 帧（updateCalls=' + updateCalls + '）---')
        const tq = new THREE.Quaternion()
        const ti = new THREE.Quaternion()
        for (const b of bones) {
          const nq = b.norm.quaternion
          const rq = b.raw.quaternion
          // 公式: raw = pw⁻¹ ⊗ norm ⊗ pw ⊗ br
          ti.copy(nq).multiply(b.pw).premultiply(tq.copy(b.pw).invert()).multiply(b.br)
          say('  ' + b.name + ' norm[' + q(nq) + '] raw[' + q(rq) + '] 公式误差=' + errOf(ti, rq).toFixed(6))
        }
      }
    }
    say('30 帧结束，humanoid.update 共调用 ' + updateCalls + ' 次')
    console.log('__DONE__')
  } catch (e) {
    console.log('FATAL: ' + (e && (e.stack || e.message)))
    console.log('__DONE__')
  }
})()
</script></body></html>`
  const tmp = path.join(os.tmpdir(), 'check-walk-formula.html')
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  const t0 = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - t0 > 30000) { try { app.quit() } catch { } }
  }, 1000)
  win.webContents.once('console-message', function watch (_e, _l, msg) {
    if (msg.includes('__DONE__')) { clearInterval(timer); setTimeout(() => app.quit(), 300) }
    else win.webContents.once('console-message', watch)
  })
})
