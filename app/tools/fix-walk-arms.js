'use strict'
/* 修「走路手臂方向反 / 手臂全程不动」——直接改写 .vrma 里手臂通道的四元数。
 *
 * 背景：walk.vrma 源自 MMD 素材，手臂 6 条通道（shoulder/upperArm/lowerArm/hand）
 * 首帧=末帧、完全常量，且左右不对称（左前臂屈着抬在胸前、右前臂 T-pose 伸直）——
 * 走路时腿在动、手臂却定格成一个别扭造型，看起来就是「左右手反了」。
 *
 * 做法：保留腿/髋/头全部原样，只把手臂写成「自然垂下 + 与同侧腿反相前后摆」。
 * 不动结构（帧数/通道数不变），只原地改 float 数据，所以对任何 vrma 都是安全的。
 *
 * 用法:
 *   node tools/fix-walk-arms.js <in.vrma> [out.vrma]
 *   环境变量: DOWN=72(下垂角) SWING=15(摆幅) ELBOW=14(屈肘) ORDER=zx|zy|xyz
 */
const fs = require('node:fs')
const path = require('node:path')

const inFile = process.argv[2]
const outFile = process.argv[3] || inFile.replace(/\.vrma$/i, '-arms.vrma')
if (!inFile) { console.error('用法: node tools/fix-walk-arms.js <in.vrma> [out.vrma]'); process.exit(2) }

const DOWN = Number(process.env.DOWN || 72)
const SWING = Number(process.env.SWING || 15)
const ELBOW = Number(process.env.ELBOW || 14)
const ORDER = process.env.ORDER || 'zx'

const buf = fs.readFileSync(inFile)
let off = 12
let json = null
let binStart = 0
let bin = null
while (off < buf.length) {
  const len = buf.readUInt32LE(off)
  const type = buf.readUInt32LE(off + 4)
  if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'))
  else if (type === 0x004e4942) { bin = buf.subarray(off + 8, off + 8 + len); binStart = off + 8 }
  off += 8 + len + ((4 - (len % 4)) % 4)
}
if (!json || !bin) throw new Error('不是合法 GLB')

const anim = (json.animations || [])[0]
if (!anim) throw new Error('没有动画')

function accInfo (idx) {
  const a = json.accessors[idx]
  const bv = json.bufferViews[a.bufferView]
  return {
    acc: a,
    offset: binStart + (bv.byteOffset || 0) + (a.byteOffset || 0),
    comps: { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type] || 1,
    count: a.count
  }
}
function readAll (info) {
  const out = []
  for (let i = 0; i < info.count; i++) {
    const r = []
    for (let c = 0; c < info.comps; c++) r.push(bin.readFloatLE(info.offset + (i * info.comps + c) * 4))
    out.push(r)
  }
  return out
}

/* ---- 四元数小工具 ---- */
const qAxis = (x, y, z, deg) => {
  const h = deg * Math.PI / 360
  const s = Math.sin(h)
  return [x * s, y * s, z * s, Math.cos(h)]
}
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
]
const qNorm = (q) => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}
const eulerX = (q) => Math.atan2(2 * (q[3] * q[0] + q[1] * q[2]), 1 - 2 * (q[0] * q[0] + q[1] * q[1])) * 180 / Math.PI

/* ---- 先取两条大腿的摆动作为相位源（手臂与同侧腿反相） ---- */
const chByNode = new Map()
for (const ch of anim.channels) chByNode.set(json.nodes[ch.target.node].name + ':' + ch.target.path, ch)

function legPhase (name) {
  const ch = chByNode.get(name + ':rotation')
  if (!ch) return null
  const info = accInfo(anim.samplers[ch.sampler].output)
  const vals = readAll(info).map(eulerX)
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const amp = Math.max(...vals.map((v) => Math.abs(v - mean))) || 1
  return vals.map((v) => (v - mean) / amp) // 归一化到 [-1,1]，+ 表示大腿摆向前
}

const armTargets = [
  { name: 'leftUpperArm', side: -1, kind: 'upper' },
  { name: 'rightUpperArm', side: 1, kind: 'upper' },
  { name: 'leftLowerArm', side: -1, kind: 'lower' },
  { name: 'rightLowerArm', side: 1, kind: 'lower' }
]

const report = []
for (const t of armTargets) {
  const ch = chByNode.get(t.name + ':rotation')
  if (!ch) { report.push(t.name + ' 没有旋转通道，跳过'); continue }
  const info = accInfo(anim.samplers[ch.sampler].output)
  const phase = legPhase(t.side < 0 ? 'leftUpperLeg' : 'rightUpperLeg')
  const n = info.count
  const written = []
  for (let i = 0; i < n; i++) {
    let q
    if (t.kind === 'upper') {
      const ph = phase ? phase[Math.min(i, phase.length - 1)] : 0
      // 手臂与同侧腿反相：腿前摆时同侧手臂后摆
      const swing = -ph * SWING // 度
      const down = qAxis(0, 0, 1, -t.side * DOWN)
      const sw1 = qAxis(1, 0, 0, swing)
      const sw2 = qAxis(0, 1, 0, swing)
      // 摆动必须作用在**父空间**（左乘）才是前后摆；右乘等于绕手臂自身轴扭转，
      // 会把手掌翻到身前、看起来像抱肚子（第一版就这样）
      q = ORDER === 'zy' ? qMul(sw2, down) : qMul(sw1, down)
      // 略内收，避免手臂穿进裙摆
      q = qMul(q, qAxis(0, 0, 1, -t.side * 4))
    } else {
      // 前臂：固定轻微屈肘（绕局部 x 负 = 屈），加一点跟摆的柔性
      const ph = phase ? phase[Math.min(i, phase.length - 1)] : 0
      q = qAxis(1, 0, 0, -ELBOW + ph * 3)
    }
    q = qNorm(q)
    written.push(q)
    const o = info.offset + i * info.comps * 4
    bin.writeFloatLE(q[0], o)
    bin.writeFloatLE(q[1], o + 4)
    bin.writeFloatLE(q[2], o + 8)
    bin.writeFloatLE(q[3], o + 12)
  }
  const zs = written.map((q) => q[2])
  report.push(t.name.padEnd(14) + ' 帧 ' + n + ' · z 范围 ' + Math.min(...zs).toFixed(2) + '~' + Math.max(...zs).toFixed(2))
}

fs.writeFileSync(outFile, buf)
console.log('参数: DOWN=' + DOWN + ' SWING=' + SWING + ' ELBOW=' + ELBOW + ' ORDER=' + ORDER)
console.log(report.join('\n'))
console.log('已写入 ' + path.resolve(outFile))
