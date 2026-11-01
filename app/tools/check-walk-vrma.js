'use strict'
/* 0.45.45 离线诊断：用应用同款 libs 真实加载「角色 VRM + motions/*.vrma」，
 * 验证 createVRMAnimationClip 产出的轨道数（空轨道 = 走路/动作词永远播不上）。
 * 跑法：cd app && env -u ELECTRON_RUN_AS_NODE npx electron tools/check-walk-vrma.js
 * 只做 GLTFParser 解析，不创建 WebGLRenderer，无 GPU 依赖。 */
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
  const say = (s) => console.log(s)
  try {
    say('libs keys: ' + Object.keys(L).join(','))
    const ud = ${JSON.stringify(UD)}
    const assetsDir = path.join(ud, 'companion', 'assets', 'workspaceid')
    const motionsDir = path.join(ud, 'motions')
    const vrms = fs.readdirSync(assetsDir).filter(f => /\\.vrm$/i.test(f))
    say('assets 里 VRM: ' + vrms.join(', '))
    const modelFile = vrms.includes('ryza2-ryza.vrm') ? 'ryza2-ryza.vrm' : vrms[0]
    const modelBuf = fs.readFileSync(path.join(assetsDir, modelFile))
    say('模型: ' + modelFile + ' (' + modelBuf.length + ' bytes)')

    const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

    const loader = new L.GLTFLoader()
    loader.register((p) => new L.THREEVRM.VRMLoaderPlugin(p))
    loader.register((p) => new L.VRMAnim.VRMAnimationLoaderPlugin(p))
    const gltf = await new Promise((ok, bad) => loader.parse(toAB(modelBuf), '', ok, bad))
    const vrm = gltf.userData && gltf.userData.vrm
    say('vrm: ' + (vrm ? 'yes' : 'NO'))
    if (vrm) {
      const meta = (vrm.meta && (vrm.meta.metaVersion || vrm.meta.version)) || '?'
      say('vrm version: ' + meta)
      say('humanoid bones: ' + Object.keys((vrm.humanoid && vrm.humanoid.humanBones) || {}).length)
    }
    if (!vrm || !vrm.humanoid) { say('!! 模型没有 humanoid，VRMA 全废'); return }

    for (const f of fs.readdirSync(motionsDir).filter(f => /\\.vrma$/i.test(f))) {
      try {
        const buf = fs.readFileSync(path.join(motionsDir, f))
        const g2 = await new Promise((ok, bad) => loader.parse(toAB(buf), '', ok, bad))
        const anims = (g2.userData && g2.userData.vrmAnimations) || []
        say('--- ' + f + ': anims=' + anims.length)
        if (!anims.length) continue
        const a = anims[0]
        const ht = a.humanoidTracks || {}
        say('  humanoidTracks: hierarchy=' + ((ht.hierarchy && (ht.hierarchy.size || ht.hierarchy.length)) || 0)
          + ' rotation=' + ((ht.rotation && (ht.rotation.size || ht.rotation.length)) || 0)
          + ' position=' + ((ht.position && (ht.position.size || ht.position.length)) || 0)
          + ' animKeys=' + Object.keys(a).filter(k => /track|rest/i.test(k)).join('|'))
        if (ht.rotation instanceof Map) say('  rotation 骨骼: ' + [...ht.rotation.keys()].slice(0, 20).join(','))
        const clip = L.VRMAnim.createVRMAnimationClip(a, vrm)
        const tracks = (clip && clip.tracks) || []
        say('  clip.tracks=' + tracks.length)
        say('  轨道样例: ' + tracks.slice(0, 6).map(t => t.name).join(' | '))
        const nonPos = tracks.filter(t => !/position/i.test(t.name || ''))
        say('  剥 position 后剩 ' + nonPos.length + ' 条（0 = 走路接管会失败）')
        const dur = tracks.length ? Math.max(...tracks.map(t => t.times && t.times.length ? t.times[t.times.length - 1] : 0)) : 0
        say('  时长: ' + dur.toFixed(2) + 's')
      } catch (e) {
        say('--- ' + f + ' 解析失败: ' + (e && e.message))
      }
    }
    console.log('__DONE__')
  } catch (e) {
    console.log('FATAL: ' + (e && (e.stack || e.message)))
    console.log('__DONE__')
  }
})()
</script></body></html>`
  const tmp = path.join(os.tmpdir(), 'check-walk-vrma.html')
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  const t0 = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - t0 > 25000) { try { app.quit() } catch {} }
  }, 1000)
  win.webContents.once('console-message', function watch (_e, _l, msg) {
    if (msg.includes('__DONE__')) { clearInterval(timer); setTimeout(() => app.quit(), 300) }
    else win.webContents.once('console-message', watch)
  })
})
