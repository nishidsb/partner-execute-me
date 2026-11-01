'use strict'
/* 0.45.48 矛盾定位：同循环内同时做 mixer.js 式 max 测量 + 逐帧打印 L_Leg raw
 * 跑法：cd app && env -u ELECTRON_RUN_AS_NODE npx electron tools/check-walk-contradiction.js */
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
    let updateCalls = 0
    const origUpdate = h.update.bind(h)
    h.update = function () { updateCalls++; return origUpdate() }

    const mixer = new THREE.AnimationMixer(vrm.scene)
    const act = mixer.clipAction(clip)
    act.setLoop(THREE.LoopRepeat, Infinity)
    act.play()

    const normBones = []
    const rawBones = []
    vrm.scene.traverse((o) => {
      if (/^Normalized_/.test(o.name || '')) normBones.push(o)
      else if (o.isBone) rawBones.push(o)
    })
    const restN = new Map(normBones.map((b) => [b, b.quaternion.clone()]))
    const restR = new Map(rawBones.map((b) => [b, b.quaternion.clone()]))
    say('Normalized ' + normBones.length + ' / raw(isBone) ' + rawBones.length)
    const legRaw = h.getRawBoneNode('leftLowerLeg')
    const legNorm = h.getNormalizedBoneNode('leftLowerLeg')
    say('leftLowerLeg 在 restR 中=' + restR.has(legRaw) + ' 在 restN 中=' + restN.has(legNorm))

    const dt = 1 / 30
    const maxN = new Map()
    const maxR = new Map()
    for (let i = 0; i < 90; i++) {
      mixer.update(dt)
      try { vrm.update(dt) } catch (e) { if (i < 3) say('vrm.update 失败@' + i + ': ' + e.message) }
      const z = legRaw.quaternion.z.toFixed(4)
      const nz = legNorm.quaternion.x.toFixed(4)
      if (i % 15 === 0) say('  帧' + i + ' L_Leg raw.z=' + z + ' norm.x=' + nz + ' updateCalls=' + updateCalls)
      for (const [b, q0] of restN) {
        const d = Math.abs(b.quaternion.x - q0.x) + Math.abs(b.quaternion.y - q0.y)
          + Math.abs(b.quaternion.z - q0.z) + Math.abs(b.quaternion.w - q0.w)
        if (d > (maxN.get(b) || 0)) maxN.set(b, d)
      }
      for (const [b, q0] of restR) {
        const d = Math.abs(b.quaternion.x - q0.x) + Math.abs(b.quaternion.y - q0.y)
          + Math.abs(b.quaternion.z - q0.z) + Math.abs(b.quaternion.w - q0.w)
        if (d > (maxR.get(b) || 0)) maxR.set(b, d)
      }
    }
    say('90 帧结束 updateCalls=' + updateCalls)
    const legD = maxR.get(legRaw)
    say('L_Leg raw 的 maxDelta=' + (legD === undefined ? '未记录!!' : legD.toFixed(4)))
    const mvR = [...maxR.entries()].filter(([, d]) => d > 0.05).sort((x, y) => y[1] - x[1])
    say('raw 动了 ' + mvR.length + '/' + rawBones.length + '，top10:')
    for (const [b, d] of mvR.slice(0, 10)) say('  R ' + b.name + ': ' + d.toFixed(4))
    const legByName = new Map(rawBones.map((b) => [b.name, b]))
    for (const nm of ['SK_L_UpLeg', 'SK_L_Leg', 'SK_L_Foot']) {
      const b = legByName.get(nm)
      say(nm + ' maxDelta=' + (b && maxR.has(b) ? maxR.get(b).toFixed(4) : '不在rawBones!'))
    }
    console.log('__DONE__')
  } catch (e) {
    console.log('FATAL: ' + (e && (e.stack || e.message)))
    console.log('__DONE__')
  }
})()
</script></body></html>`
  const tmp = path.join(os.tmpdir(), 'check-walk-contradiction.html')
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
