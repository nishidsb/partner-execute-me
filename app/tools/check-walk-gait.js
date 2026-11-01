'use strict'
/* 0.45.50 步态物理参数：摆角→步长，摆动周期→步频 → 等效前进速度
 * 跑法：cd app && env -u ELECTRON_RUN_AS_NODE npx electron tools/check-walk-gait.js */
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
    const fs = require('fs'); const path = require('path'); const L = window.AuraLibs; const THREE = L.THREE
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
    const T = clip.duration
    // 腿长（raw 骨骼世界距离，T-pose 下）
    const h = vrm.humanoid
    const up = h.getRawBoneNode('leftUpperLeg'), lo = h.getRawBoneNode('leftLowerLeg'), ft = h.getRawBoneNode('leftFoot')
    up.updateWorldMatrix(true, true)
    const wp = (o) => { const v = new THREE.Vector3(); o.getWorldPosition(v); return v }
    const knee = wp(lo), ankle = wp(ft), hip = wp(up)
    const thigh = hip.distanceTo(knee), shin = knee.distanceTo(ankle)
    console.log('腿长: 大腿=' + thigh.toFixed(3) + ' 小腿=' + shin.toFixed(3) + ' 全腿=' + (thigh + shin).toFixed(3))
    // 摆角: 每帧 UpLeg 四元数与首帧的夹角
    for (const side of ['L', 'R']) {
      const t = clip.tracks.find((x) => x.name === 'Normalized_SK_' + side + '_UpLeg.quaternion')
      if (!t) continue
      const n = t.times.length
      const q0 = new THREE.Quaternion(t.values[0], t.values[1], t.values[2], t.values[3])
      let maxAng = 0
      const angs = []
      for (let i = 0; i < n; i++) {
        const q = new THREE.Quaternion(t.values[i * 4], t.values[i * 4 + 1], t.values[i * 4 + 2], t.values[i * 4 + 3])
        const ang = 2 * Math.acos(Math.min(1, Math.abs(q.dot(q0))))
        angs.push(ang)
        if (ang > maxAng) maxAng = ang
      }
      // 摆动周期：过均值计数
      let mean = 0
      for (const x of angs) mean += x
      mean /= n
      let cross = 0
      for (let i = 1; i < n; i++) if ((angs[i] - mean) * (angs[i - 1] - mean) < 0) cross++
      const cycles = cross / 2
      const freq = cycles / T
      // 摆角幅度（相对均值的峰峰/2）
      let dev = 0
      for (const x of angs) dev = Math.max(dev, Math.abs(x - mean))
      const stride = 2 * (thigh + shin) * Math.sin(dev / 2)
      console.log(side + '_UpLeg: 摆动周期=' + cycles.toFixed(1) + ' 步频(单腿)=' + freq.toFixed(2) + '/s 摆幅=' + (dev * 180 / Math.PI).toFixed(1) + '° 步长≈' + stride.toFixed(3) + ' → 等效速度≈' + (2 * freq * stride).toFixed(3) + ' 单位/s')
    }
    // hips 高度起伏频率（触地频率）
    const hp = clip.tracks.find((x) => x.name === 'Normalized_SK_Hips.position')
    if (hp) {
      const n = hp.times.length
      let mean = 0
      for (let i = 0; i < n; i++) mean += hp.values[i * 3 + 1]
      mean /= n
      let cross = 0
      for (let i = 1; i < n; i++) if ((hp.values[i * 3 + 1] - mean) * (hp.values[(i - 1) * 3 + 1] - mean) < 0) cross++
      console.log('hips Y 过均值 ' + cross + ' 次 → 触地频率≈' + (cross / 2 / T).toFixed(2) + ' 步/s')
    }
    // 模型身高
    console.log('模型身高 st.height≈' + vrm.scene ? '' : '')
    const box = new THREE.Box3().setFromObject(vrm.scene)
    const size = new THREE.Vector3(); box.getSize(size)
    console.log('身高=' + size.y.toFixed(3))
  } catch (e) { console.log('FATAL ' + (e && (e.stack || e.message))) }
  console.log('__DONE__')
})()
</script></body></html>`
  const tmp = path.join(os.tmpdir(), 'check-walk-gait.html')
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  const t0 = Date.now()
  const timer = setInterval(() => { if (Date.now() - t0 > 30000) { try { app.quit() } catch { } } }, 1000)
  win.webContents.once('console-message', function watch (_e, _l, msg) {
    if (msg.includes('__DONE__')) { clearInterval(timer); setTimeout(() => app.quit(), 300) }
    else win.webContents.once('console-message', watch)
  })
})
