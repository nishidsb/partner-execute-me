'use strict'
/** 量 VRMA 动作幅度：解析 GLB 里的旋转轨道，算每条动画「最大四元数角差」。
 *  用途：待机池里混进了「呼吸/待机B」这种几乎不动的片段，肉眼等于没动。
 *  用法: node tools/measure-vrma.js <目录或文件...> */
const fs = require('node:fs')
const path = require('node:path')

function parseGLB (buf) {
  const magic = buf.readUInt32LE(0)
  if (magic !== 0x46546c67) throw new Error('not glb')
  let off = 12
  let json = null; let bin = null
  while (off < buf.length) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
    else if (type === 0x004e4942) bin = data
    off += 8 + len + ((4 - (len % 4)) % 4)
  }
  return { json, bin }
}

function readAccessor (g, bin, idx) {
  const acc = g.accessors[idx]
  const bv = g.bufferViews[acc.bufferView]
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0)
  const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type] || 1
  const out = []
  for (let i = 0; i < acc.count; i++) {
    const row = []
    for (let c = 0; c < comps; c++) row.push(bin.readFloatLE(start + (i * comps + c) * 4))
    out.push(row)
  }
  return out
}

function angleBetween (a, b) {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))
  return 2 * Math.acos(dot) * 180 / Math.PI
}

const targets = process.argv.slice(2)
const files = []
for (const t of targets) {
  const st = fs.statSync(t)
  if (st.isDirectory()) for (const f of fs.readdirSync(t)) if (/\.vrma$/i.test(f)) files.push(path.join(t, f))
  else files.push(t)
}
const rows = []
for (const f of files) {
  try {
    const { json, bin } = parseGLB(fs.readFileSync(f))
    let maxAngle = 0; let nRot = 0; let dur = 0
    for (const anim of json.animations || []) {
      for (const ch of anim.channels) {
        const s = anim.samplers[ch.sampler]
        const inputs = readAccessor(json, bin, s.input)
        if (inputs.length) dur = Math.max(dur, inputs[inputs.length - 1][0])
        if (ch.target.path !== 'rotation') continue
        const outs = readAccessor(json, bin, s.output)
        if (!outs.length) continue
        nRot++
        const first = outs[0]
        for (const q of outs) maxAngle = Math.max(maxAngle, angleBetween(first, q))
      }
    }
    rows.push({ name: path.basename(f), dur: +dur.toFixed(1), tracks: (json.animations || []).length, nRot, amp: +maxAngle.toFixed(1) })
  } catch (e) {
    rows.push({ name: path.basename(f), err: e.message })
  }
}
rows.sort((a, b) => (b.amp || 0) - (a.amp || 0))
console.log('片段'.padEnd(30), '时长s'.padStart(6), '轨道'.padStart(5), '旋转通道'.padStart(8), '最大幅度°'.padStart(9))
for (const r of rows) {
  if (r.err) { console.log(r.name.padEnd(30), 'ERR', r.err); continue }
  console.log(r.name.padEnd(30), String(r.dur).padStart(6), String(r.tracks).padStart(5), String(r.nRot).padStart(8), String(r.amp).padStart(9))
}
