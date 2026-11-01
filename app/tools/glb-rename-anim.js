#!/usr/bin/env node
'use strict'
/* GLB 动画 clip 改名（纯 JSON chunk 手术，BIN 不动）。
 * 用法：node glb-rename-anim.js in.vrm out.vrm old=new [old=new ...]
 * 例：  node glb-rename-anim.js a.vrm b.vrm idle=idle_fidget gust_00000=idle
 */
const fs = require('fs')

const [, , inPath, outPath, ...pairs] = process.argv
if (!inPath || !outPath || !pairs.length) {
  console.error('用法: node glb-rename-anim.js <in.vrm> <out.vrm> old=new ...')
  process.exit(1)
}
const renames = pairs.map((p) => {
  const i = p.indexOf('=')
  if (i < 0) { console.error('Bad pair:', p); process.exit(1) }
  return [p.slice(0, i), p.slice(i + 1)]
})

const buf = fs.readFileSync(inPath)
const magic = buf.readUInt32LE(0)
const version = buf.readUInt32LE(4)
if (magic !== 0x46546c67) { console.error('不是 GLB'); process.exit(1) }
const jsonLen = buf.readUInt32LE(12)
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'))

// BIN chunk 紧跟 JSON chunk（各自 4 字节对齐）
const jsonEnd = 20 + jsonLen
const binHdr = jsonEnd + ((4 - (jsonEnd % 4)) % 4)
const binLen = binHdr + 8 <= buf.length ? buf.readUInt32LE(binHdr) : 0

const names = (json.animations || []).map((a) => a.name)
for (const [from, to] of renames) {
  if (!names.includes(from)) { console.error('警告: 找不到 clip', from); continue }
  const a = json.animations.find((x) => x.name === from)
  a.name = to
  console.log('renamed:', from, '->', to, `(tracks=${a.channels.length})`)
}

let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
const pad = (4 - (jsonBuf.length % 4)) % 4
if (pad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)])

const total = 12 + 8 + jsonBuf.length + 8 + binLen
const out = Buffer.alloc(total)
out.writeUInt32LE(magic, 0)
out.writeUInt32LE(version, 4)
out.writeUInt32LE(total, 8)
out.writeUInt32LE(jsonBuf.length, 12)
out.writeUInt32LE(0x4e4f534a, 16) // 'JSON'
jsonBuf.copy(out, 20)
out.writeUInt32LE(binLen, 20 + jsonBuf.length)
out.writeUInt32LE(0x004e4942, 24 + jsonBuf.length) // 'BIN\0'
if (binLen) buf.copy(out, 28 + jsonBuf.length, binHdr + 8, binHdr + 8 + binLen)

fs.writeFileSync(outPath, out)
console.log('written:', outPath, (out.length / 1e6).toFixed(1) + 'MB', 'clips:', json.animations.length)
