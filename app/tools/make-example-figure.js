'use strict'
/**
 * 生成示例形象包 resources/figures/ryza-example.zip
 *
 * 为什么用程序生成而不是塞图：形象包 API 2 的图层本身就够画一个小人，
 * 仓库里不需要放任何第三方美术资源（规格：内置形象包美术资源不得进仓库）。
 * 这个包同时充当「冷冻夹具」：api=2 + axes + palettes + presets 一个不少，
 * 以后改解析逻辑时先看它还能不能画出来。
 *
 * 用法：node tools/make-example-figure.js
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const OUT_DIR = path.join(__dirname, '..', 'resources', 'figures')
const OUT = path.join(OUT_DIR, 'ryza-example.zip')

/* ------------------------------ 迷你 zip 写入 ------------------------------ */

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

function writeZip (files) {
  const locals = []
  const central = []
  let off = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8')
    const data = zlib.deflateRawSync(raw, { level: 9 })
    const crc = crc32(raw)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0x800, 6)
    lfh.writeUInt16LE(8, 8)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(data.length, 18)
    lfh.writeUInt32LE(raw.length, 22)
    lfh.writeUInt16LE(name.length, 26)
    locals.push(lfh, name, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x800, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(off, 42)
    central.push(cd, name)
    off += 30 + name.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}

/* ------------------------------- 迷你 PNG 编码 ------------------------------- */

function png (w, h, rgba) {
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
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 缩略图：渐变底 + 一个简笔小人（纯像素画，不依赖任何图片） */
function makeThumb (size) {
  const w = size
  const h = size
  const buf = Buffer.alloc(w * h * 4)
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = (y * w + x) * 4
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a
  }
  // 底：竖向渐变
  for (let y = 0; y < h; y++) {
    const t = y / h
    const r = Math.round(38 + 26 * (1 - t))
    const g = Math.round(42 + 22 * (1 - t))
    const b = Math.round(66 + 44 * (1 - t))
    for (let x = 0; x < w; x++) set(x, y, r, g, b, 255)
  }
  const cx = w / 2
  const disc = (ccx, ccy, rx, ry, col) => {
    for (let y = Math.floor(ccy - ry); y <= ccy + ry; y++) {
      for (let x = Math.floor(ccx - rx); x <= ccx + rx; x++) {
        const dx = (x - ccx) / rx
        const dy = (y - ccy) / ry
        if (dx * dx + dy * dy <= 1) set(x, y, col[0], col[1], col[2], col[3] == null ? 255 : col[3])
      }
    }
  }
  const hair = [124, 108, 255, 255]
  const skin = [246, 214, 194, 255]
  const dress = [96, 110, 220, 255]
  disc(cx, h * 0.72, w * 0.26, h * 0.26, dress) // 身体
  disc(cx, h * 0.42, w * 0.22, h * 0.24, hair) // 头发
  disc(cx, h * 0.44, w * 0.17, h * 0.19, skin) // 脸
  disc(cx - w * 0.07, h * 0.45, w * 0.017, h * 0.024, [40, 40, 52, 255]) // 眼
  disc(cx + w * 0.07, h * 0.45, w * 0.017, h * 0.024, [40, 40, 52, 255])
  disc(cx, h * 0.50, w * 0.02, h * 0.012, [226, 128, 148, 255]) // 嘴
  return png(w, h, buf)
}

/* -------------------------------- 形象定义 -------------------------------- */

const E = (x, y, w, h, fill, extra) => Object.assign({ type: 'shape', shape: 'ellipse', x, y, w, h, fill }, extra || {})
const R = (x, y, w, h, fill, extra) => Object.assign({ type: 'shape', shape: 'rect', x, y, w, h, fill }, extra || {})

const figure = {
  api: 2,
  oldest: 2,
  manifest: {
    name: '示例形象 · 小蓝',
    author: 'Ryza Assistant',
    version: '1.0.0',
    url: ''
  },
  size: [360, 560],
  thumbnail: 'thumb.png',
  /* 0.41.0：包对宿主的要求。
     facing 决定走路镜像方向，views 声明自己带侧身图，stage 是希望的最小绘制尺寸。
     不写这一块 = 老行为（只有正脸、向右走不翻、按 size 等比缩）。 */
  needs: { facing: 'right', views: ['front', 'side'], stage: [300, 470], anchor: 'bottom' },
  layers: [
    // 头发（后）
    E(66, 40, 228, 250, '$hair', { z: 0 }),
    // 腿 + 鞋
    R(134, 396, 36, 116, '$skin', { z: 4, rx: 18 }),
    R(190, 396, 36, 116, '$skin', { z: 4, rx: 18 }),
    E(116, 500, 62, 32, '$acc', { z: 5 }),
    E(182, 500, 62, 32, '$acc', { z: 5 }),
    // 裙子
    E(96, 240, 168, 190, '$main', { z: 8 }),
    R(96, 300, 168, 60, '$main', { z: 9 }),
    // 手臂
    E(76, 258, 34, 148, '$skin', { z: 12, rotate: -8 }),
    E(250, 258, 34, 148, '$skin', { z: 12, rotate: 8 }),
    // 脖子 + 头
    R(166, 226, 28, 34, '$skin', { z: 14 }),
    E(100, 86, 160, 174, '$skin', { z: 20 }),
    // 腮红
    E(116, 206, 32, 19, '$blush', { z: 24, opacity: 0.55 }),
    E(212, 206, 32, 19, '$blush', { z: 24, opacity: 0.55 }),
    // 嘴：口型三档（0.41.0）。part:'mouth' + open 标开口度，渲染层按说话开合挑最近的一张；
    // 没写 open 的普通图层不受影响（老包只有一个嘴也没关系，就是不会动）
    E(172, 224, 16, 4, '$mouth', { z: 26, part: 'mouth', open: 0 }),
    E(172, 224, 16, 10, '$mouth', { z: 26, part: 'mouth', open: 0.5 }),
    E(172, 224, 16, 16, '$mouth', { z: 26, part: 'mouth', open: 1 }),
    // 眼睛（眨眼时换成下面两条线）
    E(136, 170, 18, 26, '$eye', { z: 28, blink: 'open' }),
    E(206, 170, 18, 26, '$eye', { z: 28, blink: 'open' }),
    R(134, 182, 24, 5, '$eye', { z: 28, rx: 2.5, blink: 'closed' }),
    R(202, 182, 24, 5, '$eye', { z: 28, rx: 2.5, blink: 'closed' }),
    // 刘海
    E(94, 62, 172, 104, '$hair', { z: 30 }),
    E(84, 120, 44, 150, '$hair', { z: 31 }),
    E(232, 120, 44, 150, '$hair', { z: 31 }),
    // 发饰（跟着配色走）
    E(236, 96, 26, 26, '$acc', { z: 33 })
  ],
  // 侧身走用的另一套层（走起来时和正脸交叉淡入，往左走再水平镜像）
  views: {
    side: {
      layers: [
        // 后脑头发
        E(70, 40, 210, 250, '$hair', { z: 0 }),
        // 腿：前后各一条，走路时错开
        R(150, 396, 40, 116, '$skin', { z: 4, rx: 18 }),
        R(178, 396, 36, 112, '$skin', { z: 3, rx: 18 }),
        // 鞋
        E(142, 500, 66, 32, '$acc', { z: 5 }),
        E(174, 500, 62, 30, '$acc', { z: 4 }),
        // 裙子（侧面更窄）
        E(120, 240, 130, 190, '$main', { z: 8 }),
        R(120, 300, 130, 60, '$main', { z: 9 }),
        // 手臂：侧面只看见一条
        E(196, 262, 32, 140, '$skin', { z: 12, rotate: 6 }),
        // 脖子 + 头
        R(176, 226, 26, 34, '$skin', { z: 14 }),
        E(112, 86, 156, 174, '$skin', { z: 20 }),
        // 鼻子：侧脸才有的那一块
        E(248, 168, 28, 22, '$skin', { z: 21 }),
        // 腮红
        E(214, 206, 30, 18, '$blush', { z: 24, opacity: 0.55 }),
        // 嘴（同样三档口型）
        E(228, 224, 14, 4, '$mouth', { z: 26, part: 'mouth', open: 0 }),
        E(228, 224, 14, 9, '$mouth', { z: 26, part: 'mouth', open: 0.5 }),
        E(228, 224, 14, 14, '$mouth', { z: 26, part: 'mouth', open: 1 }),
        // 眼睛：侧面只看得见一只
        E(204, 170, 18, 26, '$eye', { z: 28, blink: 'open' }),
        R(202, 182, 24, 5, '$eye', { z: 28, rx: 2.5, blink: 'closed' }),
        // 刘海 + 后发
        E(104, 62, 168, 104, '$hair', { z: 30 }),
        E(78, 120, 44, 150, '$hair', { z: 31 })
      ]
    }
  },
  axes: [
    {
      id: 'hat',
      label: '帽子',
      slot: 'hat',
      options: [
        { id: 'none', label: '不戴' },
        {
          id: 'beret',
          label: '贝雷帽',
          layers: [
            E(92, 30, 176, 66, 'c:main', { z: 40 }),
            E(242, 24, 26, 26, 'c:hat-acc', { z: 41 })
          ],
          vars: { 'c-hat-main': '#6d4aff', 'c-hat-acc': '#ffd166' }
        },
        {
          id: 'straw',
          label: '草帽',
          layers: [
            E(46, 44, 268, 48, 'c:main', { z: 40 }),
            E(118, 24, 124, 36, 'c:hat-acc', { z: 41 })
          ],
          vars: { 'c-hat-main': '#d9b06a', 'c-hat-acc': '#b98b3f' }
        },
        {
          id: 'crown',
          label: '小皇冠',
          layers: [
            R(150, 34, 60, 24, 'c:main', { z: 40, rx: 4 }),
            E(152, 26, 14, 14, 'c:hat-acc', { z: 41 }),
            E(172, 22, 14, 14, 'c:hat-acc', { z: 41 }),
            E(192, 26, 14, 14, 'c:hat-acc', { z: 41 })
          ],
          vars: { 'c-hat-main': '#ffd166', 'c-hat-acc': '#fff3c4' }
        }
      ]
    },
    {
      id: 'glasses',
      label: '眼镜',
      slot: 'glasses',
      options: [
        { id: 'none', label: '不戴' },
        {
          id: 'round',
          label: '圆框',
          layers: [
            E(122, 164, 48, 46, 'rgba(190,215,255,0.14)', { z: 35, stroke: 'c:main', strokeWidth: 3 }),
            E(190, 164, 48, 46, 'rgba(190,215,255,0.14)', { z: 35, stroke: 'c:main', strokeWidth: 3 }),
            R(170, 182, 20, 4, 'c:main', { z: 35 })
          ],
          vars: { 'c-glasses-main': '#3b4054' }
        },
        {
          id: 'square',
          label: '方框',
          layers: [
            R(120, 166, 52, 42, 'rgba(190,215,255,0.14)', { z: 35, stroke: 'c:main', strokeWidth: 3, rx: 9 }),
            R(188, 166, 52, 42, 'rgba(190,215,255,0.14)', { z: 35, stroke: 'c:main', strokeWidth: 3, rx: 9 }),
            R(172, 182, 16, 4, 'c:main', { z: 35 })
          ],
          vars: { 'c-glasses-main': '#3b4054' }
        }
      ]
    },
    {
      id: 'neck',
      label: '颈饰',
      slot: 'neck',
      options: [
        { id: 'none', label: '不戴' },
        {
          id: 'ribbon',
          label: '蝴蝶结',
          layers: [
            E(140, 244, 28, 26, 'c:neck-acc', { z: 36 }),
            E(192, 244, 28, 26, 'c:neck-acc', { z: 36 }),
            E(168, 248, 22, 22, 'c:neck-main', { z: 37 })
          ],
          vars: { 'c-neck-acc': '#ff8ab8', 'c-neck-main': '#e0568f' }
        },
        {
          id: 'bell',
          label: '小铃铛',
          layers: [
            E(166, 246, 28, 28, 'c:neck-acc', { z: 36 }),
            E(176, 254, 8, 8, 'c:neck-main', { z: 37 })
          ],
          vars: { 'c-neck-acc': '#ffd166', 'c-neck-main': '#c99a2e' }
        }
      ]
    }
  ],
  palettes: [
    {
      id: 'light',
      label: '浅色',
      vars: {
        skin: '#f6d7c4',
        hair: '#6b5bd6',
        main: '#7a86ff',
        acc: '#ffb0c8',
        blush: '#ff9eb5',
        mouth: '#e2889a',
        eye: '#2b2b3a'
      }
    },
    {
      id: 'dark',
      label: '深色',
      vars: {
        skin: '#e3b899',
        hair: '#2f2b45',
        main: '#4a53b8',
        acc: '#c76a86',
        blush: '#d9788f',
        mouth: '#c4687a',
        eye: '#1b1b26'
      }
    },
    {
      id: 'mint',
      label: '薄荷',
      vars: {
        skin: '#f7ddc9',
        hair: '#3f8f7a',
        main: '#5fd0b0',
        acc: '#ffe08a',
        blush: '#ffb3a7',
        mouth: '#e08b8b',
        eye: '#26403a'
      }
    }
  ],
  presets: [
    { id: 'daily', label: '日常', axes: { hat: 'none', glasses: 'none', neck: 'ribbon' }, palette: 'light' },
    { id: 'scholar', label: '学者', axes: { hat: 'none', glasses: 'round', neck: 'none' }, palette: 'dark' },
    { id: 'outing', label: '出游', axes: { hat: 'straw', glasses: 'square', neck: 'bell' }, palette: 'mint' },
    { id: 'party', label: '节日', axes: { hat: 'crown', glasses: 'none', neck: 'ribbon' }, palette: 'light' }
  ]
}

/* --------------------------------- 输出 --------------------------------- */

fs.mkdirSync(OUT_DIR, { recursive: true })
const zip = writeZip([
  { name: 'figure.json', data: JSON.stringify(figure, null, 1) },
  { name: 'thumb.png', data: makeThumb(96) },
  { name: 'README.txt', data: '示例形象包（形状声明式，无外部美术资源）。\n把任意 figure.json + 贴图打成 zip 就是形象包，api 必须为 2。\n' }
])
fs.writeFileSync(OUT, zip)
console.log('wrote', OUT, (zip.length / 1024).toFixed(1) + 'KB')
