'use strict'
/**
 * 形象包离线预览（开发用）：不开 GUI，把 pack.resolve() 的图层栅格化成 PNG，
 * 用来确认「画出来的位置对不对」——形状语义（ellipse/rect + rotate + opacity + stroke）
 * 由这里重新实现一遍，正好当渲染层的交叉校验。
 *
 * 用法：node tools/preview-figure.js <packId> [out.png] [axesJson] [palette]
 *   例：node tools/preview-figure.js ryza-example out.png '{"hat":"beret"}' mint
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const tmpRoot = path.join(__dirname, '..', '.tmp-figure')
process.env.RYZA_FIGURE_DIR = tmpRoot

const pack = require('../src/main/figures/pack')

/* ------------------------------- PNG 输出 ------------------------------- */

function crc32 (buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function toPng (w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* -------------------------------- 颜色解析 -------------------------------- */

function parseColor (v) {
  const s = String(v || '').trim()
  let m = /^#([0-9a-f]{3,8})$/i.exec(s)
  if (m) {
    let hex = m[1]
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
    if (hex.length === 4) hex = hex.split('').map((c) => c + c).join('')
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) : 255
    return [r, g, b, a]
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (m) {
    const parts = m[1].split(',').map((x) => parseFloat(x))
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, Math.round((parts[3] == null ? 1 : parts[3]) * 255)]
  }
  return [0, 0, 0, 0]
}

/* -------------------------------- 栅格化 -------------------------------- */

function render (resolved, scale) {
  const s = scale || 1
  const W = Math.round(resolved.size[0] * s)
  const H = Math.round(resolved.size[1] * s)
  const buf = Buffer.alloc(W * H * 4)

  const blend = (x, y, col, alpha) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const a = alpha
    if (a <= 0) return
    const i = (y * W + x) * 4
    const da = buf[i + 3] / 255
    const oa = a + da * (1 - a)
    if (oa <= 0) return
    for (let k = 0; k < 3; k++) {
      buf[i + k] = Math.round((col[k] * a + buf[i + k] * da * (1 - a)) / oa)
    }
    buf[i + 3] = Math.round(oa * 255)
  }

  for (const ly of resolved.layers) {
    const col = ly.fill ? parseColor(ly.fill.value || ly.fill) : null
    const stroke = ly.stroke ? parseColor(ly.stroke.value || ly.stroke) : null
    const x = ly.x * s
    const y = ly.y * s
    const w = ly.w * s
    const h = ly.h * s
    const alphaBase = ly.opacity == null ? 1 : ly.opacity
    const rad = (ly.rotate || 0) * Math.PI / 180
    const cx = x + w / 2
    const cy = y + h / 2
    const sw = (ly.strokeWidth || 0) * s

    // 眨眼层只在眨眼瞬间出现，静态预览按睁眼画（否则眼睛上会叠一道黑杠）
    if (ly.blink === 'closed') continue
    if (ly.type === 'image') { console.warn('跳过图片图层（离线预览不加载贴图）：', ly.src); continue }
    if (ly.shape === 'path') { console.warn('跳过 path 图层（离线预览只支持 ellipse/rect）'); continue }

    for (let py = Math.floor(y - sw); py <= Math.ceil(y + h + sw); py++) {
      for (let px = Math.floor(x - sw); px <= Math.ceil(x + w + sw); px++) {
        // 反变换到层的局部坐标
        let dx = px + 0.5 - cx
        let dy = py + 0.5 - cy
        if (rad) {
          const c = Math.cos(-rad)
          const sn = Math.sin(-rad)
          const t = dx * c - dy * sn
          dy = dx * sn + dy * c
          dx = t
        }
        const lx = dx + w / 2
        const ly2 = dy + h / 2
        let inside = false
        let edge = false
        if (ly.shape === 'rect') {
          inside = lx >= 0 && lx <= w && ly2 >= 0 && ly2 <= h
          if (inside && sw > 0) {
            edge = lx < sw || lx > w - sw || ly2 < sw || ly2 > h - sw
          }
        } else {
          const rx = w / 2
          const ry = h / 2
          const d = Math.hypot((lx - rx) / rx, (ly2 - ry) / ry)
          inside = d <= 1
          if (inside && sw > 0 && stroke) {
            const irx = Math.max(0.01, rx - sw)
            const iry = Math.max(0.01, ry - sw)
            edge = Math.hypot((lx - rx) / irx, (ly2 - ry) / iry) > 1
          }
        }
        if (!inside) continue
        if (edge && stroke) blend(px, py, stroke, alphaBase * (stroke[3] / 255))
        else if (col) blend(px, py, col, alphaBase * (col[3] / 255))
      }
    }
  }
  return { W, H, png: toPng(W, H, buf) }
}

/* --------------------------------- 主流程 --------------------------------- */

function main () {
  const id = process.argv[2] || 'ryza-example'
  const out = process.argv[3] || path.join(__dirname, '..', 'figure-preview.png')
  const axes = process.argv[4] ? JSON.parse(process.argv[4]) : {}
  const palette = process.argv[5] || null

  fs.rmSync(tmpRoot, { recursive: true, force: true })
  pack.setBaseDir(tmpRoot)
  const seed = path.join(__dirname, '..', 'resources', 'figures', 'ryza-example.zip')
  if (fs.existsSync(seed)) {
    const r = pack.importZip(seed)
    if (!r.ok) throw new Error('示例包导入失败：' + r.reason)
  }
  const target = fs.existsSync(path.join(tmpRoot, id)) ? id : pack.list()[0].id
  const resolved = pack.resolve(target, { axes, palette })
  if (!resolved) throw new Error('解析失败：' + target)
  const { png } = render(resolved, 2)
  fs.writeFileSync(out, png)
  console.log('layers=' + resolved.layers.length, '→', out)
  console.log('dress=' + JSON.stringify(resolved.dress))
}

main()
