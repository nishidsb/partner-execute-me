/* 诊断：检查烘入动画后 hips/root 的位移轨道 vs rest 位置
 * 用法: node tools/probe-anim-float.js <vrm路径> */
const fs = require('fs')
const path = process.argv[2]
if (!path) { console.error('用法: node probe-anim-float.js <vrm>'); process.exit(1) }
const buf = fs.readFileSync(path)
// GLB header
const jsonLen = buf.readUInt32LE(12)
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'))
const binStart = 20 + jsonLen + ((4 - ((20 + jsonLen) % 4)) % 4) + 8 // GLB BIN chunk 数据起始（跳过 8 字节 chunk 头）

const nodes = json.nodes || []
const nodeName = (i) => nodes[i].name || ('#' + i)
// 建父子表
const parent = new Map()
nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)))
const chain = (i) => { const out = []; let c = i; while (c !== undefined) { out.push(c); c = parent.get(c) } return out }
const restLocal = (i) => {
  const n = nodes[i]
  if (n.matrix) return { matrix: true }
  return { t: n.translation || [0, 0, 0], r: n.rotation || [0, 0, 0, 1] }
}

// 找关键节点
const interesting = ['hips', 'Hips', 'J_Bip_C_Hips', 'root', 'Root', 'Skeleton', 'Armature', 'J_Bip_C_Spine']
nodes.forEach((n, i) => {
  if (interesting.some((k) => n.name === k || (n.name || '').toLowerCase() === k.toLowerCase())) {
    const rl = restLocal(i)
    console.log(`[rest] ${n.name} (node ${i}) local t=${JSON.stringify(rl.t)} parent=${parent.has(i) ? nodeName(parent.get(i)) : '(root)'} depth=${chain(i).length}`)
  }
})

// 世界 Y（rest）：对每个骨骼算世界平移（简化：只乘平移链，旋转忽略够诊断 hips 高度）
function worldT (i) {
  const acc = [0, 0, 0]
  for (const n of chain(i)) {
    const t = restLocal(n).t || [0, 0, 0]
    acc[0] += t[0]; acc[1] += t[1]; acc[2] += t[2]
  }
  return acc
}

// 动画轨道
const accessors = json.accessors || []
function readAccessor (ai) {
  const a = accessors[ai]
  if (!a || a.__cache) return a && a.__cache
  const bv = json.bufferViews[a.bufferView]
  const base = bv.byteOffset || 0
  const comp = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type]
  const Arr = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5122: Int16Array }[a.componentType]
  const off = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0)
  const data = new Arr(buf.buffer, buf.byteOffset + off, a.count * comp)
  a.__cache = { data, count: a.count, comp }
  return a.__cache
}

for (const anim of json.animations || []) {
  console.log(`\n=== clip "${anim.name}" channels=${anim.channels.length} ===`)
  const report = new Map()
  for (const ch of anim.channels) {
    const ni = ch.target.node
    const nm = nodeName(ni)
    const isTrans = ch.target.path === 'translation'
    if (!isTrans) continue
    const low = nm.toLowerCase()
    if (!/hips|root|skeleton|armature/.test(low)) continue
    const s = anim.samplers[ch.sampler]
    const out = readAccessor(s.output)
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < out.count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = out.data[i * 3 + k]
        if (v < mn[k]) mn[k] = v
        if (v > mx[k]) mx[k] = v
      }
    }
    const w0 = worldT(ni)
    report.set(nm, { mn, mx, rest: restLocal(ni).t, restWorldY: w0[1] })
  }
  for (const [nm, r] of report) {
    const f = (v) => v.map((x) => x.toFixed(4)).join(',')
    console.log(`  ${nm}: rest_t=${f(r.rest || [])} restWorldY=${r.restWorldY.toFixed(4)}`)
    console.log(`    clip min=${f(r.mn)} max=${f(r.mx)}  ΔY=[${(r.mn[1] - (r.rest || [0,0,0])[1]).toFixed(4)}, ${(r.mx[1] - (r.rest || [0,0,0])[1]).toFixed(4)}]`)
  }
  // 统计所有 translation 轨道里 Y 均值偏移最大的 3 个节点
  const rows = []
  for (const ch of anim.channels) {
    if (ch.target.path !== 'translation') continue
    const s = anim.samplers[ch.sampler]
    const out = readAccessor(s.output)
    let sum = 0
    for (let i = 0; i < out.count; i++) sum += out.data[i * 3 + 1]
    rows.push({ nm: nodeName(ch.target.node), meanY: sum / out.count })
  }
  rows.sort((a, b) => Math.abs(b.meanY) - Math.abs(a.meanY))
  console.log('  Y 均值最大的平移轨道 top5:', rows.slice(0, 5).map((r) => `${r.nm}=${r.meanY.toFixed(3)}`).join('  '))
}
console.log('\nnodes total =', nodes.length, 'animations =', (json.animations || []).length)
