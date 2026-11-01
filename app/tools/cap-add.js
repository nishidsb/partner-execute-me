'use strict'
/**
 * 给莱莎 VRM 程序化加一顶报童帽（游戏里不存在帽子网格，2026-10-29 定案）
 *   node tools/cap-add.js <in.vrm> <out.vrm> [frontSign=+1|-1]
 *
 * 做法：生成刚体帽网格（帽冠球顶 + 前帽檐 + 缎带蝴蝶结，世界坐标系），
 * 用 head 骨 rest 姿态世界矩阵的逆变换到 head 局部空间，
 * 作为静态 mesh 节点 append 进 GLB（不蒙皮、不改既有节点索引 → 动画无需重烘）。
 * 模型正面朝 -Z（vrm-stage 相机在 -Z 侧），frontSign=-1 可整体翻转试方向。
 */
const fs = require('node:fs')

// ---------- 极简 mat4（列主序，与 glTF 一致） ----------
const M = {
  ident: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  compose (t, q, s) {
    const x = q[0], y = q[1], z = q[2], w = q[3]
    const x2 = x + x, y2 = y + y, z2 = z + z
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2
    const wx = w * x2, wy = w * y2, wz = w * z2
    return [
      (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
      (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
      (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
      t[0], t[1], t[2], 1
    ]
  },
  mul (a, b) { // a * b
    const o = new Array(16).fill(0)
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
    return o
  },
  invert (m) {
    // 刚体变换专用求逆（骨骼节点都是纯旋转+平移，无缩放）：
    // inv = [Rᵀ | -Rᵀt]。之前抄的通用 4x4 逆 b01~b05 项索引有误，
    // 对「平移+旋转」会算出丢平移的错误结果（帽子飞到 2.85m 高的根因）
    const c0 = [m[0], m[1], m[2]], c1 = [m[4], m[5], m[6]], c2 = [m[8], m[9], m[10]]
    const t = [m[12], m[13], m[14]]
    return [
      m[0], m[4], m[8], 0,
      m[1], m[5], m[9], 0,
      m[2], m[6], m[10], 0,
      -(c0[0] * t[0] + c0[1] * t[1] + c0[2] * t[2]),
      -(c1[0] * t[0] + c1[1] * t[1] + c1[2] * t[2]),
      -(c2[0] * t[0] + c2[1] * t[1] + c2[2] * t[2]),
      1
    ]
  },
  applyPoint (m, p) {
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
    ]
  },
  applyDir (m, d) {
    return [
      m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
      m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
      m[2] * d[0] + m[6] * d[1] + m[10] * d[2]
    ]
  },
  normalMat (m) { // 逆转置的 3x3
    const i = M.invert(m)
    return [i[0], i[4], i[8], i[1], i[5], i[9], i[2], i[6], i[10]] // 转置取出 = 逆的转置
  }
}

// ---------- GLB 读写 ----------
function readGlb (path) {
  const buf = fs.readFileSync(path)
  if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('不是 GLB')
  const total = buf.readUInt32LE(8)
  let off = 12
  let json = null, bin = null
  while (off < total) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4E4F534A) json = JSON.parse(data.toString('utf8'))
    else if (type === 0x004E4942) bin = Buffer.from(data) // 拷贝出来便于拼接
    off += 8 + len + ((4 - len % 4) % 4)
  }
  return { json, bin }
}
function writeGlb (json, bin, path) {
  let js = Buffer.from(JSON.stringify(json), 'utf8')
  while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')])
  while (bin.length % 4) bin = Buffer.concat([bin, Buffer.from([0])])
  const head = Buffer.alloc(12)
  head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8)
  const jHead = Buffer.alloc(8)
  jHead.writeUInt32LE(js.length, 0); jHead.writeUInt32LE(0x4E4F534A, 4)
  const bHead = Buffer.alloc(8)
  bHead.writeUInt32LE(bin.length, 0); bHead.writeUInt32LE(0x004E4942, 4)
  fs.writeFileSync(path, Buffer.concat([head, jHead, js, bHead, bin]))
}

// ---------- 帽子几何生成（世界坐标系） ----------
// 尺寸依据官方立绘比例 + 实测头顶 1.548m：帽宽≈头宽×1.2，帽顶盖住发顶
// frontSign：模型正面朝 -Z，传 -1（默认）
function buildCap (H, frontSign) {
  const F = frontSign || -1 // 前方 z 方向系数
  const parts = [] // {pos:[], idx:[], color:[r,g,b], doubleSide}
  const push = (arr, v) => arr.push(v[0], v[1], v[2])

  // -- 帽冠：软塌球顶（newsboy 帽的蓬松感，轻微八瓣起伏）
  //    中心 H.y+0.11 ≈ 1.476，顶 ≈ 1.561（发顶 1.548 上方 1.3cm）
  {
    const pos = [], idx = []
    const CX = H.x, CY = H.y + 0.115, CZ = H.z + 0.002 * F
    const RX = 0.127, RY = 0.108, RZ = 0.130
    const rings = 14, segs = 24
    for (let i = 0; i <= rings; i++) {
      const phi = (i / rings) * Math.PI * 0.55 // 上半球，帽口抬高露出刘海
      for (let j = 0; j <= segs; j++) {
        const th = (j / segs) * Math.PI * 2
        const bump = 1 + 0.004 * Math.sin(th * 8)
        push(pos, [
          CX + RX * bump * Math.sin(phi) * Math.cos(th),
          CY + RY * Math.cos(phi),
          CZ + RZ * bump * Math.sin(phi) * Math.sin(th) * F
        ])
      }
    }
    for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j, b = a + segs + 1
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
    parts.push({ pos, idx, color: [0.93, 0.885, 0.80] })
  }

  // -- 缎带：帽口一圈深色带（半径略大于帽冠帽口，露出来）
  {
    const pos = [], idx = []
    const CY = H.y + 0.093
    const RX = 0.126, RZ = 0.129
    for (let i = 0; i <= 2; i++) for (let j = 0; j <= 24; j++) {
      const th = (j / 24) * Math.PI * 2
      push(pos, [RX * Math.cos(th), CY + (i - 1) * 0.011, H.z + RZ * Math.sin(th) * F])
    }
    for (let i = 0; i < 2; i++) for (let j = 0; j < 24; j++) {
      const a = i * 25 + j, b = a + 25
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
    parts.push({ pos, idx, color: [0.23, 0.20, 0.19], doubleSide: true })
  }

  // -- 帽檐：前方伸出的半圆盘（微微上翘）
  {
    const pos = [], idx = []
    const Y0 = H.y + 0.070, Z0 = H.z + 0.10 * F
    const RINGS = 8, SEGS = 20
    for (let i = 0; i <= RINGS; i++) for (let j = 0; j <= SEGS; j++) {
      const u = i / RINGS, v = (j / SEGS) * Math.PI // 半圆：v ∈ [0, π]
      const rx = 0.098 * (1 - u * 0.12)
      push(pos, [
        H.x + rx * Math.cos(v),
        Y0 + u * 0.022 + Math.cos(v * 2) * 0.003,
        Z0 + F * (u * 0.085)
      ])
    }
    for (let i = 0; i < RINGS; i++) for (let j = 0; j < SEGS; j++) {
      const a = i * (SEGS + 1) + j, b = a + SEGS + 1
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
    parts.push({ pos, idx, color: [0.91, 0.86, 0.77], doubleSide: true })
  }

  // -- 兔耳发饰：她的右侧（世界 +X）帽口上，竖立双环蝴蝶结（官方立绘造型）
  {
    const pos = [], idx = []
    const BX = H.x + 0.128, BY = H.y + 0.100, BZ = H.z + 0.018 * F
    // 两个竖立椭圆环（XY 平面），像兔耳朵一样立起来，微微外撇
    const ear = (cx, cy, dx, dy, lean) => {
      const base = pos.length / 3
      for (let j = 0; j <= 16; j++) {
        const th = (j / 16) * Math.PI * 2
        const x = cx + dx * Math.cos(th) + lean * Math.max(0, Math.sin(th)) // 上半外撇
        push(pos, [x, cy + dy * Math.sin(th), BZ + 0.008 * Math.sin(th)])
      }
      for (let j = 0; j < 16; j++) idx.push(base + j, base + j + 1, base)
    }
    ear(BX - 0.022, BY + 0.052, 0.016, 0.050, -0.35)  // 左耳
    ear(BX + 0.022, BY + 0.048, 0.016, 0.046, 0.35)   // 右耳
    // 中心结（小球）
    const knotBase = pos.length / 3
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 8; j++) {
      const th = (j / 8) * Math.PI * 2, phi = (i / 4) * Math.PI
      push(pos, [BX + 0.011 * Math.sin(phi) * Math.cos(th), BY + 0.011 * Math.cos(phi), BZ + 0.011 * Math.sin(phi) * Math.sin(th)])
    }
    for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) {
      const a = knotBase + i * 9 + j, b = a + 9
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
    parts.push({ pos, idx, color: [0.16, 0.14, 0.135], doubleSide: true })
  }
  return parts
}

// ---------- 主流程 ----------
const [, , inPath, outPath, frontArg] = process.argv
if (!inPath || !outPath) { console.error('用法: node tools/cap-add.js <in.vrm> <out.vrm> [frontSign]'); process.exit(2) }
const frontSign = Number(frontArg || -1) // 模型正面 -Z

const { json, bin: bin0 } = readGlb(inPath)
let bin = bin0
const g = json

// 找 head 节点（VRMC_vrm.humanoid.humanBones 是 { bone名: nodeIndex } 映射）
const hb = g.extensions?.VRMC_vrm?.humanoid?.humanBones || {}
const headEntry = hb.head
const headIdx = headEntry && typeof headEntry === 'object' ? headEntry.node : headEntry
if (headIdx === undefined || headIdx === null) throw new Error('VRM 里没找到 humanoid head 骨')
console.log('[cap] head node =', headIdx, JSON.stringify(g.nodes[headIdx].name))

// 计算 head 世界矩阵（rest 姿态）
function worldOf (idx) {
  const parents = new Map()
  g.scenes[g.scene || 0].nodes.forEach((root) => {
    const walk = (i, parent) => { parents.set(i, parent); (g.nodes[i].children || []).forEach((c) => walk(c, i)) }
    walk(root, -1)
  })
  const chain = []
  for (let i = idx; i !== -1; i = parents.get(i)) chain.unshift(i)
  let m = M.ident()
  for (const i of chain) {
    const n = g.nodes[i]
    const t = n.translation || [0, 0, 0]
    const q = n.rotation || [0, 0, 0, 1]
    const s = n.scale || [1, 1, 1]
    m = M.mul(m, M.compose(t, q, s))
  }
  return m
}
const headWorld = worldOf(headIdx)
const H = [headWorld[12], headWorld[13], headWorld[14]]
console.log('[cap] head 世界位置 =', H.map((v) => v.toFixed(4)).join(', '))

// 生成帽子 → head 局部空间
const inv = M.invert(headWorld)
const nmat = M.normalMat(headWorld)
console.log('[cap] inv finite=', inv.every(Number.isFinite), 'headWorld finite=', headWorld.every(Number.isFinite))
const parts = buildCap({ x: H[0], y: H[1], z: H[2] }, frontSign) // buildCap 用 .x/.y/.z 取值
console.log('[cap] 各部件原始顶点 finite=', parts.map((p) => p.pos.every(Number.isFinite)))
const allPos = [], allNorm = [], allIdx = []
for (const p of parts) {
  const base = allPos.length / 3
  for (let i = 0; i < p.pos.length; i += 3) {
    const lp = M.applyPoint(inv, [p.pos[i], p.pos[i + 1], p.pos[i + 2]])
    if (!lp.every(Number.isFinite)) { console.error('[cap] NaN! 原始点', [p.pos[i], p.pos[i + 1], p.pos[i + 2]], '→', lp); process.exit(3) }
    allPos.push(lp[0], lp[1], lp[2])
    const ln = M.applyDir(nmat, [0, 1, 0]) // 近似法线：统一朝上（unlit 下无光照影响，仅防背面剔除）
    allNorm.push(ln[0], ln[1], ln[2])
  }
  for (const v of p.idx) allIdx.push(base + v)
}

// 材质（unlit，与模型一致）
const matIdx = g.materials.length
g.materials.push({
  name: 'ryza_cap',
  pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 },
  extensions: { KHR_materials_unlit: {} },
  doubleSided: true
})

// mesh + node
const meshIdx = g.meshes.length
g.meshes.push({ name: 'ryza_cap', primitives: [{ attributes: { POSITION: 0, NORMAL: 0 }, indices: 0, material: matIdx }] })
const nodeIdx = g.nodes.length
g.nodes.push({ name: 'ryza_cap', mesh: meshIdx })
const head = g.nodes[headIdx]
if (!head.children) head.children = []
head.children.push(nodeIdx)
if (!g.scenes[g.scene || 0].nodes.includes(nodeIdx) && !head.children.includes(nodeIdx)) {
  g.scenes[g.scene || 0].nodes.push(nodeIdx)
}

// buffer 拼接：positions / normals / indices 各一个 bufferView
const pad4 = (n) => (4 - n % 4) % 4
function addView (typedArr, target) {
  const start = bin.length
  const data = Buffer.from(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength)
  const nb = Buffer.concat([bin, data])
  bin = nb
  g.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: data.byteLength, target })
  return g.bufferViews.length - 1
}
g.bufferViews = g.bufferViews || []
const posArr = new Float32Array(allPos)
const normArr = new Float32Array(allNorm)
const idxArr = allIdx.length < 65536 ? new Uint16Array(allIdx) : new Uint32Array(allIdx)
if (bin.length % 4) bin = Buffer.concat([bin, Buffer.alloc(pad4(bin.length))])
const posMin = [Math.min(...allPos.filter((_, i) => i % 3 === 0)), Math.min(...allPos.filter((_, i) => i % 3 === 1)), Math.min(...allPos.filter((_, i) => i % 3 === 2))]
const posMax = [Math.max(...allPos.filter((_, i) => i % 3 === 0)), Math.max(...allPos.filter((_, i) => i % 3 === 1)), Math.max(...allPos.filter((_, i) => i % 3 === 2))]
const posView = addView(posArr, 34962)
const normView = addView(normArr, 34962)
const idxView = addView(idxArr, 34963)
const acc = (view, type, count, comps, minMax) => {
  g.accessors.push({
    bufferView: view, componentType: type, count, type: comps,
    ...(minMax ? { min: posMin, max: posMax } : {})
  })
  return g.accessors.length - 1
}
g.accessors = g.accessors || []
const posAcc = acc(posView, 5126, allPos.length / 3, 'VEC3', true)
const normAcc = acc(normView, 5126, allNorm.length / 3, 'VEC3', false)
const idxAcc = acc(idxView, idxArr instanceof Uint16Array ? 5123 : 5125, allIdx.length, 'SCALAR', false)
g.meshes[meshIdx].primitives[0].attributes = { POSITION: posAcc, NORMAL: normAcc }
g.meshes[meshIdx].primitives[0].indices = idxAcc

console.log('[cap] 顶点', allPos.length / 3, '/ 三角', allIdx.length / 3, '/ 新节点', nodeIdx, '→ head.children')
writeGlb(g, bin, outPath)
console.log('[cap] 已写出', outPath, (fs.statSync(outPath).size / 1048576).toFixed(1) + 'MB')
