'use strict'
/**
 * 把 ryza2-hat.vrm 里的正版帽饰（PC20A_MODEL_P_CapShape：白帽+兔耳结，游戏自带网格）
 * 移植进当前全量动画 VRM。前提（已验证）：两文件前 243 节点名零差异（同一身体构建），
 * joints/材质贴图索引直接可用，只需搬 accessor 数据块 + skin + material + mesh + node。
 *   node tools/cap-transplant.js <hat.vrm> <current.vrm> <out.vrm>
 */
const fs = require('node:fs')

function readGlb (path) {
  const buf = fs.readFileSync(path)
  const total = buf.readUInt32LE(8)
  let off = 12, json = null, bin = null
  while (off < total) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4)
    const d = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4E4F534A) json = JSON.parse(d.toString('utf8'))
    else if (type === 0x004E4942) bin = Buffer.from(d)
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
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4E4F534A, 4)
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4)
  fs.writeFileSync(path, Buffer.concat([head, jh, js, bh, bin]))
}

const [, , hatPath, curPath, outPath] = process.argv
if (!hatPath || !curPath || !outPath) { console.error('用法: node tools/cap-transplant.js <hat.vrm> <cur.vrm> <out.vrm>'); process.exit(2) }
const hat = readGlb(hatPath)
const cur = readGlb(curPath)
const H = hat.json, C = cur.json

// 安全校验：节点名对齐
for (let i = 0; i < C.nodes.length; i++) {
  if ((H.nodes[i].name || '') !== (C.nodes[i].name || '')) throw new Error(`节点 ${i} 名字不一致: ${H.nodes[i].name} vs ${C.nodes[i].name}`)
}

// 定位帽饰
const nodeIdx = H.nodes.findIndex((n) => n.name === 'PC20A_MODEL_P_CapShape')
if (nodeIdx < 0) throw new Error('hat.vrm 里没有 PC20A_MODEL_P_CapShape')
const hNode = H.nodes[nodeIdx]
const hMesh = H.meshes[hNode.mesh]
const hSkin = H.skins[hNode.skin]
const hMat = H.materials[hMesh.primitives[0].material]

// 1) 收集需要搬运的数据块（mesh 全部 accessor + IBM）
const accIdx = [...new Set([
  ...Object.values(hMesh.primitives[0].attributes),
  hMesh.primitives[0].indices,
  hSkin.inverseBindMatrices
])]
// accessor 可能共享 bufferView，按 bufferView 汇总搬运
const bvSet = new Set(accIdx.map((a) => H.accessors[a].bufferView))

// 2) 搬运 bufferView 原始字节到 cur BIN 末尾
const pad4 = (n) => (4 - n % 4) % 4
let bin = cur.bin
if (bin.length % 4) bin = Buffer.concat([bin, Buffer.alloc(pad4(bin.length))])
const bvMap = {}
for (const bvi of [...bvSet].sort((a, b) => a - b)) {
  const bv = H.bufferViews[bvi]
  const start = bin.length
  bin = Buffer.concat([bin, hat.bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength)])
  C.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: bv.byteLength, ...(bv.target ? { target: bv.target } : {}) })
  bvMap[bvi] = C.bufferViews.length - 1
  console.log('[transplant] bv', bvi, '→', bvMap[bvi], `(${bv.byteLength}B)`)
}

// 3) 搬运 accessor
const accMap = {}
for (const ai of accIdx) {
  const a = H.accessors[ai]
  C.accessors.push({ ...a, bufferView: bvMap[a.bufferView] })
  accMap[ai] = C.accessors.length - 1
}

// 4) 搬运 skin（joints 是节点索引，两文件一致，直接用）
const skinIdx = C.skins.length
C.skins.push({
  joints: hSkin.joints,
  inverseBindMatrices: accMap[hSkin.inverseBindMatrices],
  ...(hSkin.skeleton !== undefined ? { skeleton: hSkin.skeleton } : {})
})

// 5) 搬运材质（贴图索引 0-3 两文件同位，直接用）
const matIdx = C.materials.length
C.materials.push(JSON.parse(JSON.stringify(hMat)))

// 6) 搬运 mesh
const meshIdx = C.meshes.length
C.meshes.push({
  name: hMesh.name,
  primitives: [{
    attributes: Object.fromEntries(Object.entries(hMesh.primitives[0].attributes).map(([k, v]) => [k, accMap[v]])),
    indices: accMap[hMesh.primitives[0].indices],
    material: matIdx,
    mode: hMesh.primitives[0].mode || 4
  }]
})

// 7) 挂节点（与其他蒙皮网格一样做 scene root）
const newNode = { name: hNode.name, mesh: meshIdx, skin: skinIdx }
if (hNode.translation || hNode.rotation || hNode.scale) {
  newNode.translation = hNode.translation; newNode.rotation = hNode.rotation; newNode.scale = hNode.scale
}
const newNodeIdx = C.nodes.length
C.nodes.push(newNode)
C.scenes[C.scene || 0].nodes.push(newNodeIdx)

console.log('[transplant] 顶点数据 8 块 / skin joints', hSkin.joints.length, '/ 新节点', newNodeIdx)
writeGlb(C, bin, outPath)
console.log('[transplant] 已写出', outPath, (fs.statSync(outPath).size / 1048576).toFixed(1) + 'MB')
