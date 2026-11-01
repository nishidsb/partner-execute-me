'use strict'
/* 0.45.50 前置分析：walk.vrma 髋部 position 轨道 = 前移漂移（被剥掉→滑步）+上下起伏（被剥掉→没步感）
 * 跑法：cd app && env -u ELECTRON_RUN_AS_NODE npx electron tools/check-walk-drift.js */
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
    console.log('clip 时长 T=' + T.toFixed(2) + 's 轨道数=' + clip.tracks.length)
    for (const t of clip.tracks) {
      if (!/position/i.test(t.name || '')) continue
      const n = t.values.length / 3
      const ax = [[], [], []]
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) ax[k].push(t.values[i * 3 + k])
      const names = ['x', 'y', 'z']
      for (let k = 0; k < 3; k++) {
        const v = ax[k]
        const v0 = v[0], vN = v[n - 1]
        let mn = Infinity, mx = -Infinity
        for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x }
        // 去线性趋势后的残差范围（=保留下来的周期性起伏）
        let rMn = Infinity, rMx = -Infinity
        for (let i = 0; i < n; i++) {
          const r = v[i] - (v0 + (vN - v0) * (t.times[i] / T))
          if (r < rMn) rMn = r; if (r > rMx) rMx = r
        }
        console.log(t.name + ' [' + names[k] + '] 起点=' + v0.toFixed(3) + ' 终点=' + vN.toFixed(3) +
          ' 净漂移=' + (vN - v0).toFixed(3) + '（' + ((vN - v0) / T).toFixed(3) + ' 单位/s）' +
          ' 全程范围=' + (mx - mn).toFixed(3) + ' 去趋势残差峰峰=' + (rMx - rMn).toFixed(3))
      }
    }
    // 大腿摆动频率（步频）
    for (const t of clip.tracks) {
      if (!/UpLeg.*quaternion/i.test(t.name || '')) continue
      const n = t.times.length
      let crossings = 0
      for (let i = 1; i < n; i++) {
        if ((t.values[i * 4 + 2] - 0.55) * (t.values[(i - 1) * 4 + 2] - 0.55) < 0) crossings++
      }
      console.log(t.name + ' z 轴过中线 ' + crossings + ' 次 / ' + T.toFixed(1) + 's ≈ ' + (crossings / 2 / T).toFixed(2) + ' 步/s（单腿）')
    }
  } catch (e) { console.log('FATAL ' + (e && (e.stack || e.message))) }
  console.log('__DONE__')
})()
</script></body></html>`
  const tmp = path.join(os.tmpdir(), 'check-walk-drift.html')
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  const t0 = Date.now()
  const timer = setInterval(() => { if (Date.now() - t0 > 30000) { try { app.quit() } catch { } } }, 1000)
  win.webContents.once('console-message', function watch (_e, _l, msg) {
    if (msg.includes('__DONE__')) { clearInterval(timer); setTimeout(() => app.quit(), 300) }
    else win.webContents.once('console-message', watch)
  })
})
