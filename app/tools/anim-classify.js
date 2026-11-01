'use strict'
/**
 * 官方动画语义打标（构建期工具，不参与运行）
 *   node tools/anim-classify.js <model.vrm> [--out=anim-catalog.json] [--verbose]
 *
 * 为什么不用肉眼看连拍：369 个 clip、格子里的角色只有拇指大，连拍图看不出
 * 「挥手」和「拍手」的区别。这里直接读动画数据做正向运动学（FK），算出
 * 头/手/脚/胯在世界空间的轨迹，再用几条硬规则判「躺 / 坐 / 跳 / 挥 / 走」。
 *
 * 判据（都是相对量，跟模型身高无关）：
 *   躺   headY 明显低于 hipsY，或全身高度塌到原点附近
 *   坐   hipsY 掉到站立的一半左右，且膝盖弯（脚仍在胯下方）
 *   跳   hipsY 出现明显上升尖峰（>8% 身高）且回到原位
 *   挥手 某只手举过肩，且该手在水平方向来回摆动 ≥2 次
 *   走跑 脚在水平方向交替前后位移，节奏明显
 */
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const plain = args.filter((a) => !a.startsWith('--'))
const MODEL = path.resolve(plain[0] || path.join(process.env.APPDATA || '', 'ryza-assistant-app/companion/assets/workspaceid/ryza2-ryza.vrm'))
const OUT = path.resolve((args.find((a) => a.startsWith('--out=')) || '').split('=')[1] || path.join(__dirname, '..', 'src', 'renderer', 'shared', 'anim-catalog.js'))
const VERBOSE = args.includes('--verbose')

/* ---------- glb 解析 ---------- */
function readGlb (file) {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 glb/vrm')
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  // 第一个 BIN chunk 紧跟在 JSON chunk 之后
  let off = 20 + jsonLen
  while (off < buf.length) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    if (type === 0x004e4942) return { json, bin: buf.subarray(off + 8, off + 8 + len) }
    off += 8 + len
  }
  throw new Error('找不到 BIN chunk')
}

const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] }
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

function accessorFloats (json, bin, idx) {
  const a = json.accessors[idx]
  const [Ctor, bytes] = CT[a.componentType]
  const n = NC[a.type]
  const bv = json.bufferViews[a.bufferView]
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0)
  const stride = bv.byteStride || n * bytes
  const out = new Float32Array(a.count * n)
  for (let i = 0; i < a.count; i++) {
    const o = base + i * stride
    const view = new Ctor(bin.buffer, bin.byteOffset + o, n)
    for (let k = 0; k < n; k++) out[i * n + k] = view[k]
  }
  return out
}

/* ---------- 小矩阵库（列主序，和 glTF 一致） ---------- */
const M4 = {
  ident: () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m },
  mul (a, b) {
    const o = new Float64Array(16)
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
      }
    }
    return o
  },
  fromTRS (t, q, s) {
    const [x, y, z, w] = q
    const x2 = x + x, y2 = y + y, z2 = z + z
    const xx = x * x2, xy = x * y2, xz = x * z2
    const yy = y * y2, yz = y * z2, zz = z * z2
    const wx = w * x2, wy = w * y2, wz = w * z2
    const m = new Float64Array(16)
    m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0]
    m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1]
    m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2]
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1
    return m
  },
  pos (m) { return [m[12], m[13], m[14]] }
}

/* ---------- FK ---------- */
const WANT = ['SK_Hips', 'SK_Head', 'SK_Spine02', 'SK_L_Hand', 'SK_R_Hand', 'SK_L_Foot', 'SK_R_Foot',
  'SK_L_Leg', 'SK_R_Leg', 'SK_L_Toes', 'SK_R_Toes', 'SK_L_Arm', 'SK_R_Arm']

function buildModel (json, bin) {
  const nodes = json.nodes.map((n) => ({
    name: n.name || '',
    t: n.translation || [0, 0, 0],
    r: n.rotation || [0, 0, 0, 1],
    s: n.scale || [1, 1, 1],
    children: n.children || [],
    parent: -1
  }))
  nodes.forEach((n, i) => n.children.forEach((c) => { nodes[c].parent = i }))
  const byName = new Map()
  nodes.forEach((n, i) => { if (n.name && !byName.has(n.name)) byName.set(n.name, i) })
  return { nodes, byName }
}

/** 采样某一时刻各关注骨骼的世界坐标 */
function poseAt (model, anim, json, bin, time) {
  const { nodes, byName } = model
  // 通道：nodeIndex → {rotation?, translation?}
  const over = new Map()
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler]
    const key = ch.target.node
    let e = over.get(key)
    if (!e) { e = {}; over.set(key, e) }
    e[ch.target.path] = { s, t: time }
  }
  // 每帧现算插值（clip 只有几百个通道，11 帧 × 369 clip 完全跑得动）
  const local = new Map()
  for (const [nodeIdx, e] of over) {
    const trs = {}
    for (const p of ['rotation', 'translation']) {
      const ch = e[p]
      if (!ch) continue
      trs[p] = sampleTrack(json, bin, ch.s, p, ch.t)
    }
    local.set(nodeIdx, trs)
  }
  const world = new Map()
  const evalNode = (i) => {
    if (world.has(i)) return world.get(i)
    const n = nodes[i]
    const o = local.get(i) || {}
    const t = o.translation || n.t
    const r = o.rotation || n.r
    const s = n.s
    let m = M4.fromTRS(t, r, s)
    if (n.parent >= 0) m = M4.mul(evalNode(n.parent), m)
    world.set(i, m)
    return m
  }
  const out = {}
  for (const name of WANT) {
    const i = byName.get(name)
    if (i === undefined) continue
    out[name] = M4.pos(evalNode(i))
  }
  // 还有躯干朝向：Spine02 的世界旋转 → 用前向量估计
  const hip = byName.get('SK_Hips')
  const head = byName.get('SK_Head')
  const neck = byName.get('SK_Neck')
  if (head !== undefined && neck !== undefined) {
    const h = M4.pos(evalNode(head))
    const nk = M4.pos(evalNode(neck))
    out.headUp = [h[0] - nk[0], h[1] - nk[1], h[2] - nk[2]]
  }
  if (hip !== undefined) out.hipW = M4.pos(evalNode(hip))
  return out
}

function sampleTrack (json, bin, sampler, path, time) {
  const input = accessorFloats(json, bin, sampler.input)
  const output = accessorFloats(json, bin, sampler.output)
  const n = input.length
  const dim = path === 'rotation' ? 4 : 3
  if (n === 0) return path === 'rotation' ? [0, 0, 0, 1] : [0, 0, 0]
  let i = 0
  while (i < n - 1 && input[i + 1] <= time) i++
  if (i >= n - 1) return Array.from(output.subarray((n - 1) * dim, n * dim))
  const t0 = input[i]
  const t1 = input[i + 1]
  const a = (time - t0) / (t1 - t0 || 1)
  const p0 = Array.from(output.subarray(i * dim, (i + 1) * dim))
  const p1 = Array.from(output.subarray((i + 1) * dim, (i + 2) * dim))
  if (path === 'rotation') {
    // 四元数最短弧插值
    if (p0[0] * p1[0] + p0[1] * p1[1] + p0[2] * p1[2] + p0[3] * p1[3] < 0) for (let k = 0; k < 4; k++) p1[k] = -p1[k]
    const q = []
    let len = 0
    for (let k = 0; k < 4; k++) { q[k] = p0[k] * (1 - a) + p1[k] * a; len += q[k] * q[k] }
    len = Math.sqrt(len) || 1
    return q.map((v) => v / len)
  }
  return p0.map((v, k) => v * (1 - a) + p1[k] * a)
}

/* ---------- 统计 ---------- */
function clipDur (json, bin, anim) {
  let d = 0
  for (const s of anim.samplers) {
    const input = accessorFloats(json, bin, s.input)
    if (input.length) d = Math.max(d, input[input.length - 1])
  }
  return d
}

const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2])
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const maxOf = (a) => Math.max(...a)
const minOf = (a) => Math.min(...a)

/** 参考姿态（idle_still）：所有量都换算成「身体长度的几倍」，跟模型高矮无关 */
function makeRef (model, json, bin) {
  const a = json.animations.find((x) => /^(idle_still|idle)$/.test(x.name)) || json.animations[0]
  const dur = clipDur(json, bin, a)
  const f = poseAt(model, a, json, bin, dur * 0.5)
  const bodyLen = dist(f.SK_Head, f.SK_Hips)
  const footY = Math.min(f.SK_L_Foot[1], f.SK_R_Foot[1])
  return { bodyLen, hipStand: f.SK_Hips[1], footGap: f.SK_Hips[1] - footY, footY }
}

function analyze (model, anim, json, bin, ref) {
  const dur = clipDur(json, bin, anim)
  const N = 16
  const frames = []
  for (let i = 0; i < N; i++) frames.push(poseAt(model, anim, json, bin, dur * (i / (N - 1))))
  const BL = ref.bodyLen || 0.5
  const ok = frames.every((f) => f.SK_Hips && f.SK_Head && f.SK_L_Hand && f.SK_R_Hand && f.SK_L_Foot && f.SK_R_Foot)
  if (!ok) return { dur, broken: true }

  // 1) 躯干竖直度：站立≈1，躺下≈0，倒立<0（对根骨骼的奇怪旋转免疫）
  const upright = frames.map((f) => {
    const v = [f.SK_Head[0] - f.SK_Hips[0], f.SK_Head[1] - f.SK_Hips[1], f.SK_Head[2] - f.SK_Hips[2]]
    const len = Math.hypot(...v) || 1
    return v[1] / len
  })
  // 2) 胯离地高度（相对站立时的胯-脚落差）：站着≈1，坐≈0.4，躺≈0
  const hipLevel = frames.map((f) => (f.SK_Hips[1] - Math.min(f.SK_L_Foot[1], f.SK_R_Foot[1])) / (ref.footGap || 1))
  // 3) 手举高：手比肩线高多少（肩线 = 胯 + 0.8 躯干）
  const shoulderY = (f) => f.SK_Hips[1] + 0.8 * (f.SK_Head[1] - f.SK_Hips[1])
  const handUpL = maxOf(frames.map((f) => (f.SK_L_Hand[1] - shoulderY(f)) / BL))
  const handUpR = maxOf(frames.map((f) => (f.SK_R_Hand[1] - shoulderY(f)) / BL))
  // 4) 手相对胯的水平位移量 + 方向反转次数（挥手/摆手）
  const rel = (f, k) => [f[k][0] - f.SK_Hips[0], f[k][2] - f.SK_Hips[2]]
  const swing = (k) => {
    const p = frames.map((f) => rel(f, k))
    const amp = Math.max(...p.map((v) => Math.hypot(...v))) - Math.min(...p.map((v) => Math.hypot(...v)))
    let rev = 0
    for (let i = 2; i < p.length; i++) {
      const a1 = Math.atan2(p[i][1] - p[i - 1][1], p[i][0] - p[i - 1][0])
      const a2 = Math.atan2(p[i - 1][1] - p[i - 2][1], p[i - 1][0] - p[i - 2][0])
      let d = Math.abs(a1 - a2)
      if (d > Math.PI) d = 2 * Math.PI - d
      if (d > 1.0) rev++
    }
    return { amp: amp / BL, rev }
  }
  const swL = swing('SK_L_Hand')
  const swR = swing('SK_R_Hand')
  // 5) 走路：两脚水平开合的幅度 + 交替次数
  const gap = frames.map((f) => dist2(f.SK_L_Foot, f.SK_R_Foot) / BL)
  const zgap = frames.map((f) => (f.SK_L_Foot[2] - f.SK_R_Foot[2]) / BL)
  let cross = 0
  for (let i = 1; i < zgap.length; i++) if (Math.sign(zgap[i]) !== Math.sign(zgap[i - 1])) cross++
  const footLift = Math.max(
    maxOf(frames.map((f) => f.SK_L_Foot[1])) - minOf(frames.map((f) => f.SK_L_Foot[1])),
    maxOf(frames.map((f) => f.SK_R_Foot[1])) - minOf(frames.map((f) => f.SK_R_Foot[1]))) / BL
  // 6) 转身：左右上臂连线（刚性挂在胸廓上）在水平面的角度累计变化
  //    不能用手：手臂前后摆动会让手连线转起来，误判成「转圈」
  let yaw = 0
  const face = (f) => (f.SK_L_Arm && f.SK_R_Arm)
    ? Math.atan2(f.SK_R_Arm[2] - f.SK_L_Arm[2], f.SK_R_Arm[0] - f.SK_L_Arm[0])
    : null
  for (let i = 1; i < frames.length; i++) {
    const a = face(frames[i - 1]); const b = face(frames[i])
    if (a === null || b === null) continue
    let d = Math.abs(b - a)
    if (d > Math.PI) d = 2 * Math.PI - d
    if (d < Math.PI * 0.6) yaw += d   // 单帧跳过 108° 以上视为采样跳变
  }
  // 7) 整体活跃度：逐帧位移的中位数
  const energy = med(frames.slice(1).map((f, i) =>
    (dist(f.SK_L_Hand, frames[i].SK_L_Hand) + dist(f.SK_R_Hand, frames[i].SK_R_Hand) +
     dist(f.SK_Head, frames[i].SK_Head)) / 3 / BL))
  // 8) 离地：两只脚都比站立时的脚底高 → 跳起来了
  const air = maxOf(frames.map((f) => (Math.min(f.SK_L_Foot[1], f.SK_R_Foot[1]) - (ref.footY || 0)) / BL))
  // 9) 首尾是否闭合（可循环播放）
  const loop = dist(frames[0].SK_L_Hand, frames[N - 1].SK_L_Hand) + dist(frames[0].SK_Head, frames[N - 1].SK_Head)

  return {
    dur: Number(dur.toFixed(2)),
    upright: Number(med(upright).toFixed(2)),
    hipLevel: Number(med(hipLevel).toFixed(2)),
    hipRange: Number((maxOf(hipLevel) - minOf(hipLevel)).toFixed(2)),
    hipMax: Number(maxOf(hipLevel).toFixed(2)),
    air: Number(air.toFixed(2)),
    handUp: Number(Math.max(handUpL, handUpR).toFixed(2)),
    swingAmp: Number(Math.max(swL.amp, swR.amp).toFixed(2)),
    swingRev: Math.max(swL.rev, swR.rev),
    stride: Number((maxOf(gap) - minOf(gap)).toFixed(2)),
    cross,
    footLift: Number(footLift.toFixed(2)),
    yaw: Number(yaw.toFixed(2)),
    energy: Number(energy.toFixed(3)),
    loop: Number((loop / BL).toFixed(2))
  }
}

/* ---------- 打标 ----------
 * 阈值都取得偏保守：宁可有 clip 落进 gesture 兜底，也不要把「站着挥手」塞进「躺下」池。
 * 每个 clip 只有一个 pose（站/坐/蹲/躺），behavior 可以有多个，选池时两者都要对上。
 */
function tag (m) {
  if (m.broken) return { pose: 'unknown', tags: ['broken'] }
  let pose = 'stand'
  if (m.upright < 0.3 && m.hipLevel < 0.55) pose = 'lie'
  else if (m.hipLevel < 0.4 && m.upright >= 0.3) pose = 'sit'
  else if (m.hipLevel < 0.75 && m.upright >= 0.3) pose = 'crouch'
  const t = [pose]
  if (m.air > 0.15) t.push('jump')
  if (m.handUp > 0.4) t.push('armsUp')
  if (m.swingRev >= 3 && m.swingAmp > 0.5 && m.handUp > 0.1) t.push('wave')
  if (m.cross >= 2 && m.stride > 0.5) t.push('step')
  if (m.yaw > 2.5) t.push('turn')
  if (m.energy < 0.012) t.push('still')
  if (t.length === 1) t.push('gesture')
  return { pose, tags: t }
}

function main () {
  const { json, bin } = readGlb(MODEL)
  const model = buildModel(json, bin)
  const out = { model: path.basename(MODEL), madeAt: new Date().toISOString().slice(0, 10), clips: {} }
  const ref = makeRef(model, json, bin)
  let n = 0
  for (const anim of json.animations) {
    const name = anim.name || ('#' + n)
    const m = analyze(model, anim, json, bin, ref)
    const g = tag(m)
    out.clips[name] = { pose: g.pose, tags: g.tags, ...m }
    n++
    if (VERBOSE) console.log(name.padEnd(14), (out.clips[name].tags.join('+')).padEnd(22), JSON.stringify(m))
  }
  // 只保留选池要用的字段，别把 16 帧采样明细塞进渲染层
  const KEEP = ['dur', 'upright', 'hipLevel', 'air', 'handUp', 'swingAmp', 'yaw', 'stride', 'energy']
  const slim = {}
  for (const [k, v] of Object.entries(out.clips)) {
    const o = { pose: v.pose, tags: v.tags }
    for (const f of KEEP) if (v[f] !== undefined) o[f] = v[f]
    slim[k] = o
  }
  const payload = { model: out.model, madeAt: out.madeAt, clips: slim }
  const js = '/* 由 tools/anim-classify.js 生成，不要手改（重跑：node tools/anim-classify.js） */\n' +
    ';(function (root) {\n  const DATA = ' + JSON.stringify(payload) + '\n' +
    '  if (typeof module !== \'undefined\' && module.exports) module.exports = DATA\n' +
    '  if (root) root.AuraAnimCatalog = DATA\n' +
    '})(typeof window !== \'undefined\' ? window : null)\n'
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, js)
  const tally = {}
  for (const c of Object.values(out.clips)) for (const t of c.tags) tally[t] = (tally[t] || 0) + 1
  console.log('已写', OUT, '·', n, '个 clip ·', (fs.statSync(OUT).size / 1024).toFixed(0) + 'KB')
  console.log('标签分布：', Object.entries(tally).map(([k, v]) => k + '=' + v).join('  '))
}

if (require.main === module) main()
module.exports = { readGlb, buildModel, analyze, tag, poseAt, makeRef }
