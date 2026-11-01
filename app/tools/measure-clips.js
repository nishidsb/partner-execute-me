'use strict'
/** 量 VRM 内置官方 clip 的动作幅度（最大四元数角差），找出「幅度大、一眼能看出」的片段。
 *  用法: node tools/measure-clips.js <model.vrm> [topN] */
const fs = require('node:fs')
const path = require('node:path')

const file = process.argv[2]
const TOP = Number(process.argv[3] || 40)
if (!file) { console.error('用法: node tools/measure-clips.js <model.vrm> [topN]'); process.exit(2) }
const buf = fs.readFileSync(path.resolve(file))
let off = 12, json = null, bin = null
while (off < buf.length) {
  const len = buf.readUInt32LE(off)
  const type = buf.readUInt32LE(off + 4)
  const data = buf.subarray(off + 8, off + 8 + len)
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
  else if (type === 0x004e4942) bin = data
  off += 8 + len + ((4 - (len % 4)) % 4)
}
function readAcc (idx) {
  const acc = json.accessors[idx]
  const bv = json.bufferViews[acc.bufferView]
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
const ang = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI
const rows = []
for (const anim of json.animations || []) {
  let max = 0, dur = 0
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler]
    const inp = readAcc(s.input)
    if (inp.length) dur = Math.max(dur, inp[inp.length - 1][0])
    if (ch.target.path !== 'rotation') continue
    const outs = readAcc(s.output)
    if (!outs.length) continue
    const f = outs[0]
    for (const q of outs) { const a = ang(f, q); if (a > max) max = a }
  }
  rows.push({ name: anim.name, dur: +dur.toFixed(1), amp: +max.toFixed(0) })
}
rows.sort((a, b) => b.amp - a.amp)
console.log('总片段:', rows.length)
console.log('--- 幅度前 ' + TOP + ' ---')
for (const r of rows.slice(0, TOP)) console.log(String(r.amp).padStart(4) + '°  ' + String(r.dur).padStart(5) + 's  ' + r.name)
const idle = rows.filter((r) => /idle|wait|stand|watch/i.test(r.name)).sort((a, b) => b.amp - a.amp)
console.log('--- 名字像待机的 ---')
for (const r of idle) console.log(String(r.amp).padStart(4) + '°  ' + String(r.dur).padStart(5) + 's  ' + r.name)
