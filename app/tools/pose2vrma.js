'use strict'
/* 真人视频动作迁移第二段：MediaPipe 姿态 JSON → VRMA
 * 输入: tools/video2pose.py 产出的 JSON（{fps, frames:[{t, world[33], screen[33]}]}）
 * 输出: .vrma（GLB + VRMC_vrm_animation），骨架节点层与 humanoid 映射直接复用
 *       应用安装的 motions/walk.vrma（同为 T-pose 相对局部四元数约定）。
 *
 * 约定（与 kalidokit 官方 VRM demo 对齐）:
 *   - 各骨骼 euler(XYZ 序) → quaternion，直接作为该人骨节点的旋转轨道值
 *   - Hips.rotation 直接用；Spine 同时喂 spine 与 chest（chest 打折）
 *   - hips 位移取 world landmarks 髋中心相对第 0 帧的位移（米），默认剥线性漂移
 *
 * 跑法: node tools/pose2vrma.js <landmarks.json> <out.vrma> [--smooth 0.55] [--hip-y 1.0]
 *        [--chest 0.4] [--keep-root] [--flipx] [--flipz]
 */
const fs = require('fs')
const path = require('path')

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2)
const inPath = argv[0]
const outPath = argv[1]
if (!inPath || !outPath) {
  console.error('用法: node tools/pose2vrma.js <landmarks.json> <out.vrma> [opts]')
  process.exit(2)
}
const opt = {}
for (let i = 2; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = Number(argv[i + 1] ?? argv[i + 1])
const SMOOTH = opt.smooth !== undefined ? opt.smooth : 0.55   // 0..1，越大越平滑
const HIP_Y = opt['hip-y'] !== undefined ? opt['hip-y'] : 1.0 // 髋基准高（米）
const CHEST = opt.chest !== undefined ? opt.chest : 0.4
const KEEP_ROOT = argv.includes('--keep-root')
const FLIPX = argv.includes('--flipx')
const FLIPZ = argv.includes('--flipz')

/* ---------- kalidokit 载入（npm dist 是带目录导入的 ESM，Node 解析不了；用打包版） ---------- */
async function loadKalidokit () {
  try { return require('kalidokit') } catch { }
  const es = await import('file:///' + path.resolve(__dirname, '../node_modules/kalidokit/dist/kalidokit.es.js').replace(/\\/g, '/'))
  return es.default || es
}

/* ---------- euler(XYZ) → quaternion（three.js setFromEuler 公式） ---------- */
// three.js Quaternion.setFromEuler 'XYZ' 的精确公式
function eulerXYZ (x, y, z) {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2)
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2)
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3
  ]
}
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
const qnorm = (q) => { const l = Math.hypot(...q) || 1; return q.map(v => v / l) }
const lerp = (a, b, t) => a + (b - a) * t
const lerpQ = (a, b, t) => { // 同号 lerp 后归一（帧间小角度足够）
  let bb = b; if (qdot(a, bb) < 0) bb = bb.map(v => -v)
  return qnorm(a.map((v, i) => lerp(v, bb[i], t)))
}
const lerp3 = (a, b, t) => a.map((v, i) => lerp(v, b[i], t))

/* ---------- 主流程 ---------- */
;(async () => {
  const K = await loadKalidokit()
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'))
  const frames = data.frames.filter(f => f.world && f.world.length >= 33)
  if (frames.length < 2) { console.error('有效帧不足'); process.exit(1) }
  const fps = data.fps || 30
  const n = frames.length

  /* 逐帧 kalidokit 求解 */
  const raw = []
  let solveFail = 0
  for (const f of frames) {
    try {
      const rig = K.Pose.solve(f.world, f.screen, { runtime: 'mediapipe', enableLegs: true })
      // hips 世界位移（米）：world 髋中心（23 左/24 右）相对首帧
      const c = [(f.world[23].x + f.world[24].x) / 2, (f.world[23].y + f.world[24].y) / 2, (f.world[23].z + f.world[24].z) / 2]
      raw.push({ rig, c })
    } catch (e) { solveFail++; raw.push(null) }
  }
  if (raw.every(r => !r)) { console.error('kalidokit 全帧求解失败'); process.exit(1) }
  // 缺帧用上一帧补
  for (let i = 0; i < n; i++) if (!raw[i]) raw[i] = raw[i - 1] || null

  const c0 = raw[0].c
  const hipRaw = raw.map(r => {
    let dx = r.c[0] - c0[0], dy = r.c[1] - c0[1], dz = r.c[2] - c0[2]
    if (FLIPX) dx = -dx
    if (FLIPZ) dz = -dz
    // mediapipe world y 向下为正 → VRM 向上为正
    return [dx, HIP_Y - dy, dz]
  })

  /* 剥线性漂移（默认）：走路视频想原地走时用 */
  if (!KEEP_ROOT) {
    const T = (n - 1) / fps
    const d = [0, 1, 2].map(k => (hipRaw[n - 1][k] - hipRaw[0][k]) / (T || 1))
    for (let i = 0; i < n; i++) {
      const t = i / fps
      for (let k = 0; k < 3; k++) hipRaw[i][k] -= d[k] * t
    }
  }

  /* euler → quat + EMA 平滑 + 符号连续 */
  const BONES = ['LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightUpperArm', 'RightLowerArm', 'RightHand', 'LeftUpperLeg', 'LeftLowerLeg', 'RightUpperLeg', 'RightLowerLeg']
  const q = {} // bone → [ [x,y,z,w], ... ]
  for (const b of BONES) q[b] = new Array(n)
  const qHips = new Array(n), qSpine = new Array(n), qChest = new Array(n)
  const hipT = new Array(n)
  let prev = null
  for (let i = 0; i < n; i++) {
    const r = raw[i]
    const cur = {}
    const hr = r.rig.Hips || {}
    cur._hips = eulerXYZ(hr.rotation ? hr.rotation.x : 0, hr.rotation ? hr.rotation.y : 0, hr.rotation ? hr.rotation.z : 0)
    cur._spine = r.rig.Spine ? eulerXYZ(r.rig.Spine.x, r.rig.Spine.y, r.rig.Spine.z) : [0, 0, 0, 1]
    cur._chest = eulerXYZ((r.rig.Spine ? r.rig.Spine.x : 0) * CHEST, (r.rig.Spine ? r.rig.Spine.y : 0) * CHEST, (r.rig.Spine ? r.rig.Spine.z : 0) * CHEST)
    for (const b of BONES) {
      const e = r.rig[b]
      cur[b] = e ? eulerXYZ(e.x, e.y, e.z) : [0, 0, 0, 1]
    }
    // 平滑 + 符号连续
    if (prev) {
      cur._hips = lerpQ(prev._hips, cur._hips, 1 - SMOOTH)
      cur._spine = lerpQ(prev._spine, cur._spine, 1 - SMOOTH)
      cur._chest = lerpQ(prev._chest, cur._chest, 1 - SMOOTH)
      for (const b of BONES) cur[b] = lerpQ(prev[b], cur[b], 1 - SMOOTH)
      cur._hipsT = lerp3(prev._hipsT, hipRaw[i], 1 - SMOOTH)
    } else cur._hipsT = hipRaw[i].slice()
    qHips[i] = cur._hips; qSpine[i] = cur._spine; qChest[i] = cur._chest
    hipT[i] = cur._hipsT
    for (const b of BONES) q[b][i] = cur[b]
    prev = cur
  }

  /* ---------- 写 GLB(VRMA)：节点层复用 walk.vrma ---------- */
  const ud = process.env.APPDATA ? path.join(process.env.APPDATA, 'ryza-assistant-app') : ''
  const walkPath = path.join(ud, 'motions', 'walk.vrma')
  if (!fs.existsSync(walkPath)) { console.error('找不到 ' + walkPath); process.exit(1) }
  const wb = fs.readFileSync(walkPath)
  const wl = wb.readUInt32LE(12)
  const wj = JSON.parse(wb.slice(20, 20 + wl).toString('utf8'))
  const nodes = JSON.parse(JSON.stringify(wj.nodes))
  const hb = wj.extensions.VRMC_vrm_animation.humanoid.humanBones
  const N = (name) => { const e = hb[name]; if (!e) throw new Error('walk.vrma 缺人骨 ' + name); return e.node }

  const g = {
    asset: { version: '2.0', generator: 'video2vrma 1.0 (mediapipe+kalidokit)' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: hb } } },
    scene: 0,
    scenes: [{ nodes: [N('hips')] }],
    nodes,
    animations: [{ name: 'Video Motion', samplers: [], channels: [] }],
    buffers: [{ byteLength: 0 }], bufferViews: [], accessors: []
  }
  g.buffers[0].byteLength = 0 // 占位，导出前回填
  const chunks = []
  let blen = 0
  function accessor (f32, type, bounds) {
    const view = g.bufferViews.length
    g.bufferViews.push({ buffer: 0, byteOffset: blen, byteLength: f32.byteLength })
    chunks.push(new Uint8Array(f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength)))
    blen += f32.byteLength
    const comp = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type]
    const a = { bufferView: view, componentType: 5126, count: f32.length / comp, type }
    if (bounds) { a.min = [f32[0]]; a.max = [f32[f32.length - 1]] }
    g.accessors.push(a)
    return g.accessors.length - 1
  }
  const times = new Float32Array(n)
  for (let i = 0; i < n; i++) times[i] = i / fps
  const timeAcc = accessor(times, 'SCALAR', true)
  const anim = g.animations[0]
  function channel (node, p, vals) {
    const s = anim.samplers.length
    anim.samplers.push({ input: timeAcc, output: accessor(vals, p === 'rotation' ? 'VEC4' : 'VEC3'), interpolation: 'LINEAR' })
    anim.channels.push({ sampler: s, target: { node, path: p } })
  }
  const packQ = (arr) => { const v = new Float32Array(n * 4); arr.forEach((qq, i) => v.set(qq, i * 4)); return v }
  const pack3 = (arr) => { const v = new Float32Array(n * 3); arr.forEach((vv, i) => v.set(vv, i * 3)); return v }
  channel(N('hips'), 'rotation', packQ(qHips))
  channel(N('hips'), 'translation', pack3(hipT))
  channel(N('spine'), 'rotation', packQ(qSpine))
  channel(N('chest'), 'rotation', packQ(qChest))
  for (const b of BONES) channel(N(b.charAt(0).toLowerCase() + b.slice(1)), 'rotation', packQ(q[b]))

  /* GLB 组装 */
  const bin = Buffer.concat(chunks.map(c => Buffer.from(c)))
  const binPad = (4 - (bin.length % 4)) % 4
  g.buffers[0].byteLength = bin.length + binPad
  let jsonStr = JSON.stringify(g)
  while (jsonStr.length % 4) jsonStr += ' '
  const jsonBuf = Buffer.from(jsonStr, 'utf8')
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length + binPad
  const out = Buffer.alloc(total)
  let o = 0
  out.writeUInt32LE(0x46546C67, o); o += 4 // glTF
  out.writeUInt32LE(2, o); o += 4
  out.writeUInt32LE(total, o); o += 4
  out.writeUInt32LE(jsonBuf.length, o); o += 4
  out.writeUInt32LE(0x4E4F534A, o); o += 4 // JSON
  jsonBuf.copy(out, o); o += jsonBuf.length
  out.writeUInt32LE(bin.length + binPad, o); o += 4
  out.writeUInt32LE(0x004E4942, o); o += 4 // BIN
  bin.copy(out, o); o += bin.length
  if (binPad) { for (let i = 0; i < binPad; i++) out.writeUInt8(0, o + i); o += binPad }
  fs.writeFileSync(outPath, out)

  /* 报告 */
  const stat = (arr) => {
    let mx = 0
    for (const qq of arr) { const a = 2 * Math.acos(Math.min(1, Math.abs(qq[3]))); if (a > mx) mx = a }
    return (mx * 180 / Math.PI).toFixed(1)
  }
  console.log(`帧数=${n} fps=${fps} 时长=${(n / fps).toFixed(1)}s solve失败=${solveFail}`)
  console.log('最大摆角(deg):', BONES.map(b => `${b}=${stat(q[b])}`).join(' '))
  console.log(`hips 位移范围: x=${Math.min(...hipT.map(v => v[0])).toFixed(3)}~${Math.max(...hipT.map(v => v[0])).toFixed(3)} z=${Math.min(...hipT.map(v => v[2])).toFixed(3)}~${Math.max(...hipT.map(v => v[2])).toFixed(3)}`)
  console.log('输出 →', outPath)
})().catch(e => { console.error('FATAL', e && (e.stack || e.message)); process.exit(1) })
