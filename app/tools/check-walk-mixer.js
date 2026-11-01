'use strict'
/* 0.45.47 离线诊断③：轨道逐条 findNode 绑定验证 + 真实 mixer 播放采样偏差。
 * 跑法：cd app && env -u ELECTRON_RUN_AS_NODE npx electron tools/check-walk-mixer.js */
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
    say('原始轨道 ' + clip.tracks.length + ' 条，样例名:')
    for (const t of clip.tracks.slice(0, 5)) say('  ' + t.name)

    // 逐条 findNode 绑定验证
    const THREE = L.THREE
    let bound = 0, unbound = []
    for (const t of clip.tracks) {
      const nodeName = t.name.split('.')[0]
      const found = THREE.PropertyBinding.findNode(vrm.scene, nodeName) ||
                    THREE.PropertyBinding.findNode(vrm.scene, nodeName.replace(/^J_Bip_/, ''))
      if (found) bound++; else unbound.push(t.name)
    }
    say('findNode 绑定成功 ' + bound + '/' + clip.tracks.length + (unbound.length ? '，绑不上的样例: ' + unbound.slice(0, 5).join(' | ') : ''))

    // ① 轨道值本身是否在变（常量轨道 = 转换产物是死的，播什么都一样）
    const quatTracks = clip.tracks.filter((t) => /quaternion/i.test(t.name))
    let varying = 0
    const legSample = []
    for (const t of quatTracks) {
      const v0 = [t.values[0], t.values[1], t.values[2], t.values[3]]
      let differs = false
      for (let i = 4; i < t.values.length; i += 4) {
        if (Math.abs(t.values[i] - v0[0]) > 1e-5 || Math.abs(t.values[i + 1] - v0[1]) > 1e-5 ||
          Math.abs(t.values[i + 2] - v0[2]) > 1e-5 || Math.abs(t.values[i + 3] - v0[3]) > 1e-5) { differs = true; break }
      }
      if (differs) varying++
      if (/Hips|UpperLeg/.test(t.name)) {
        legSample.push({ name: t.name, keys: t.times.length, first: v0.map((x) => x.toFixed(3)).join(','), last: [t.values[t.values.length - 4], t.values[t.values.length - 3], t.values[t.values.length - 2], t.values[t.values.length - 1]].map((x) => x.toFixed(3)).join(',') })
      }
    }
    say('quaternion 轨道 ' + quatTracks.length + ' 条，其中有变化的 ' + varying + ' 条')
    for (const s of legSample) say('  ' + s.name + ' keys=' + s.keys + ' 首[' + s.first + '] 末[' + s.last + ']')
    say('--- 全部轨道的变化状态（CONST=常量）---')
    for (const t of quatTracks) {
      const v0 = [t.values[0], t.values[1], t.values[2], t.values[3]]
      let differs = false
      for (let i = 4; i < t.values.length; i += 4) {
        if (Math.abs(t.values[i] - v0[0]) > 1e-5 || Math.abs(t.values[i + 1] - v0[1]) > 1e-5 ||
          Math.abs(t.values[i + 2] - v0[2]) > 1e-5 || Math.abs(t.values[i + 3] - v0[3]) > 1e-5) { differs = true; break }
      }
      say((differs ? ' VAR ' : ' CONST ') + t.name + ' keys=' + t.times.length)
    }

    // ② 真实 mixer 播放 + vrm.update（归一化→原生骨架传播靠它，线上渲染循环就是这么跑的）
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
    say('Normalized 节点 ' + normBones.length + ' 个，原生骨骼 ' + rawBones.length + ' 个')
    const dt = 1 / 30
    const maxN = new Map()
    const maxR = new Map()
    for (let i = 0; i < 90; i++) {
      mixer.update(dt)
      try { vrm.update(dt) } catch (e) { if (i === 0) say('vrm.update 失败: ' + e.message) }
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
    const mvN = [...maxN.entries()].filter(([, d]) => d > 0.05).sort((a, b) => b[1] - a[1])
    const mvR = [...maxR.entries()].filter(([, d]) => d > 0.05).sort((a, b) => b[1] - a[1])
    say('90 帧后：Normalized 动了 ' + mvN.length + '/' + normBones.length + '，原生骨骼动了 ' + mvR.length + '/' + rawBones.length + '（按偏差降序）')
    for (const [b, d] of mvN.slice(0, 14)) say('  N ' + b.name + ': ' + d.toFixed(4))
    for (const [b, d] of mvR.slice(0, 14)) say('  R ' + b.name + ': ' + d.toFixed(4))

    // ③ 验证合成公式：raw = rawRest ⊗ normalized（用 leftLowerLeg 数值对账）
    try {
      const h = vrm.humanoid
      const nn = h.getNormalizedBoneNode('leftUpperLeg')
      const rn = h.getRawBoneNode('leftUpperLeg')
      const byName = new Map(rawBones.map((b) => [b.name, b]))
      const rb = byName.get(rn.name)
      const rest2 = (restR.get(rb) || restR.get(rn))
      const nq = nn.quaternion
      if (rest2) {
        const mk = (q) => new L.THREE.Quaternion(q.x, q.y, q.z, q.w)
        const p1 = mk(rest2).multiply(nq)
        const e1 = Math.abs(p1.x - rn.quaternion.x) + Math.abs(p1.y - rn.quaternion.y) + Math.abs(p1.z - rn.quaternion.z) + Math.abs(p1.w - rn.quaternion.w)
        const p2 = mk(nq).multiply(mk(rest2))
        const e2 = Math.abs(p2.x - rn.quaternion.x) + Math.abs(p2.y - rn.quaternion.y) + Math.abs(p2.z - rn.quaternion.z) + Math.abs(p2.w - rn.quaternion.w)
        say('公式对比 ' + rn.name + '：rest⊗norm 误差=' + e1.toFixed(6) + '｜norm⊗rest 误差=' + e2.toFixed(6))
      } else say('restR 里没有 ' + rn.name + '（rawBones=' + rawBones.length + '）');
      say('遍历到的腿骨: ' + rawBones.map(b=>b.name).filter(n=>/[Ll]eg|足|膝|Knee|Foot/i.test(n)).join(','));
      say('getRawBoneNode 名: ' + rn.name + ' isBone=' + rn.isBone + ' 类型=' + rn.type)
    } catch (e) { say('公式验证失败: ' + e.message) }
    console.log('__DONE__')
  } catch (e) {
    console.log('FATAL: ' + (e && (e.stack || e.message)))
    console.log('__DONE__')
  }
})()
</script></body></html>`
  const tmp = path.join(os.tmpdir(), 'check-walk-mixer.html')
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
