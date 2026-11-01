'use strict'
/* VMD 裁剪：保留前 N 秒（默认 60s@30fps=1800 帧）。
   注意 VMD 骨骼记录布局=骨骼名(15B)在前、帧号(4B)在后。
   用法：node trim-vmd.js <in.vmd> <out.vmd> [帧上限=1800] */
const fs = require('fs')
const src = fs.readFileSync(process.argv[2])
const dv = new DataView(src.buffer, src.byteOffset, src.byteLength)
const LIMIT = Number(process.argv[4]) || 1800
const boneCount = dv.getUint32(50, true)
const boneStart = 54
let kb = 0
for (let i = 0; i < boneCount; i++) if (dv.getUint32(boneStart + i * 111 + 15, true) <= LIMIT) kb++
let o = boneStart + boneCount * 111
const morphCount = dv.getUint32(o, true); o += 4
const morphStart = o; let km = 0
for (let i = 0; i < morphCount; i++) if (dv.getUint32(morphStart + i * 23 + 15, true) <= LIMIT) km++
o = morphStart + morphCount * 23
const u32b = (v) => { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, v, true); return Buffer.from(d.buffer) }
const parts = [src.subarray(0, 50), u32b(kb)]
for (let i = 0; i < boneCount; i++) { const s = boneStart + i * 111; if (dv.getUint32(s + 15, true) <= LIMIT) parts.push(src.subarray(s, s + 111)) }
parts.push(u32b(km))
for (let i = 0; i < morphCount; i++) { const s = morphStart + i * 23; if (dv.getUint32(s + 15, true) <= LIMIT) parts.push(src.subarray(s, s + 23)) }
parts.push(src.subarray(o)) // 尾部（可视/IK）原样保留：超限帧不会被采样
fs.writeFileSync(process.argv[3], Buffer.concat(parts))
console.log('trimmed: bones', boneCount, '->', kb, ', morphs', morphCount, '->', km)
