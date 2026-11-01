#!/usr/bin/env node
/* 0.45.66 视觉能力实测工具（别再靠文档猜模型能不能看图）
 *
 * 背景：0.45.64 我把 deepseek-flash 判成「无视觉」，理由是模型名没命中视觉白名单。
 * 但官方 vision 文档写的是「deepseek-flash accepts images alongside text」——
 * 也就是说白名单猜错了，她本来能看见，被我按瞎了。
 *
 * 这个工具做两件事：
 *   1. 生成一张内容完全确定的探针图（黑底，青色 "VISION PROBE" + 黄色大字数字）
 *   2. 把图按 OpenAI 兼容格式发给当前配置的模型，看它能不能读出那个数字
 *
 * 用法：node tools/vision-probe.js            # 用 config.json 里的 apiBaseUrl/apiKey/apiModel
 *      node tools/vision-probe.js --model xxx
 * 退出码：0 = 能收图且读对了；2 = 能收图但没读对（可能是小字精度问题）；
 *        3 = 网关/模型拒收图片（返回 400 之类）；1 = 其他错误
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const zlib = require('zlib')

/* ---------------- 5x7 点阵字体（只要字母和数字，够写探针文案） ---------------- */
const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
}

const PROBE_NUMBER = '7392'

/* ---------------- 极简 PNG 编码（8-bit RGB，无滤波） ---------------- */
function crc32 (buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = []
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })())
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng (w, h, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function drawText (canvas, w, h, text, x0, y0, scale, color) {
  let x = x0
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch] || GLYPHS[' ']
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (g[gy][gx] !== '1') continue
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x + gx * scale + sx
            const py = y0 + gy * scale + sy
            if (px < 0 || px >= w || py < 0 || py >= h) continue
            const i = (py * w + px) * 3
            canvas[i] = color[0]
            canvas[i + 1] = color[1]
            canvas[i + 2] = color[2]
          }
        }
      }
    }
    x += 6 * scale
  }
}

function makeProbe (file) {
  const w = 640
  const h = 260
  const rgb = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = 24
    rgb[i * 3 + 1] = 26
    rgb[i * 3 + 2] = 34
  }
  drawText(rgb, w, h, 'VISION PROBE', 32, 28, 4, [120, 230, 255])
  drawText(rgb, w, h, PROBE_NUMBER, 32, 120, 10, [255, 200, 80])
  fs.writeFileSync(file, encodePng(w, h, rgb))
  return file
}

/* ---------------- 读配置（跟应用同一份 config.json） ---------------- */
function loadCfg (overrideModel) {
  const p = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'ryza-assistant-app', 'config.json')
  let g = {}
  try { g = (JSON.parse(fs.readFileSync(p, 'utf8')).global || {}).companion || {} } catch (e) {
    console.error('读不到 config.json: ' + p)
  }
  return {
    baseUrl: (g.apiBaseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: g.apiKey || process.env.DEEPSEEK_API_KEY || '',
    model: overrideModel || g.apiModel || 'deepseek-flash'
  }
}

async function main () {
  const argv = process.argv.slice(2)
  const mi = argv.indexOf('--model')
  const cfg = loadCfg(mi >= 0 ? argv[mi + 1] : '')
  const png = path.join(os.tmpdir(), 'vision-probe-' + PROBE_NUMBER + '.png')
  makeProbe(png)
  const b64 = fs.readFileSync(png).toString('base64')
  console.log('探针图: ' + png + '（' + Math.round(b64.length / 1024) + 'KB base64）')
  console.log('目标: ' + cfg.model + ' @ ' + cfg.baseUrl)
  if (!cfg.apiKey) {
    console.error('没有 apiKey，放弃')
    process.exit(1)
  }

  const body = {
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图里有一行大号数字，把它原样读出来。只回答数字，不要解释。' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }
      ]
    }],
    max_tokens: 200,
    stream: false
  }

  let res
  try {
    res = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(body)
    })
  } catch (e) {
    console.error('请求失败（网络/代理）: ' + e.message)
    process.exit(1)
  }

  const text = await res.text()
  console.log('HTTP ' + res.status)
  if (!res.ok) {
    console.log(text.slice(0, 600))
    if (res.status === 400 || res.status === 422) {
      console.log('\n→ 这个模型/网关不收图。她只能走 screen_now（窗口标题）那条路。')
      process.exit(3)
    }
    process.exit(1)
  }

  let json
  try { json = JSON.parse(text) } catch { console.log(text.slice(0, 600)); process.exit(1) }
  const msg = (json.choices && json.choices[0] && json.choices[0].message) || {}
  const answer = String(msg.content || '').trim()
  console.log('模型回答: ' + (answer || '(空)'))
  if (json.usage) console.log('usage: ' + JSON.stringify(json.usage))

  if (answer.includes(PROBE_NUMBER)) {
    console.log('\n→ 能收图，而且真读懂了（' + PROBE_NUMBER + '）。她本来就该看得见。')
    process.exit(0)
  }
  console.log('\n→ 能收图，但没读出 ' + PROBE_NUMBER + '。可能是图太小/模型读数字弱，建议用真实截图再测一次。')
  process.exit(2)
}

if (require.main === module) main()
module.exports = { makeProbe, PROBE_NUMBER }
