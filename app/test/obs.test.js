'use strict'
/**
 * OBS 导出（0.19.0）：本地 HTTP 服务 + 拉帧。
 * 这里用假的 webContents（只实现 capturePage）跑真实 HTTP 请求，验证协议层行为。
 */
const test = require('node:test')
const assert = require('node:assert')
const obs = require('../src/main/obs')

const FAKE_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452fakepng', 'hex')

function fakeWc () {
  let n = 0
  return {
    isDestroyed: () => false,
    capturePage: async () => {
      n++
      return {
        getSize: () => ({ width: 64, height: 64 }),
        toPNG: () => Buffer.concat([FAKE_PNG, Buffer.from(String(n))])
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('开启后本地页面可访问，/frame 返回 PNG 字节', async () => {
  const r = await obs.start({ port: 8891, fps: 20, getWebContents: () => fakeWc() })
  assert.equal(r.ok, true)
  try {
    const st = obs.status()
    assert.equal(st.running, true)
    assert.equal(st.port, 8891)
    assert.match(st.url, /^http:\/\/127\.0\.0\.1:8891\/$/)

    const page = await fetch(st.url)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /\/frame/, '页面自己来拉帧')
    assert.match(html, /background:transparent/, '页面必须透明，否则 OBS 里是白底')

    const fr = await fetch(st.url + 'frame')
    assert.equal(fr.status, 200)
    assert.equal(fr.headers.get('content-type'), 'image/png')
    const buf = Buffer.from(await fr.arrayBuffer())
    assert.ok(buf.length > FAKE_PNG.length, '要拿到真正的帧数据')

    const health = await (await fetch(st.url + 'health')).json()
    assert.equal(health.ok, true)
    assert.equal(health.fps, 20)
  } finally {
    obs.stop()
  }
  assert.equal(obs.status().running, false)
})

test('端口被别的程序占用时自动顺延，而不是启动失败', async () => {
  // 用一个独立 http server 占住端口，模拟「别的程序已经在用」
  const http = require('node:http')
  const blocker = http.createServer((req, res) => res.end('busy'))
  await new Promise((r) => blocker.listen(8892, '127.0.0.1', r))
  try {
    const r = await obs.start({ port: 8892, fps: 5, getWebContents: () => fakeWc() })
    assert.equal(r.ok, true)
    assert.ok(r.port > 8892, '要换端口，不能抢别人的')
  } finally {
    obs.stop()
    await new Promise((r) => blocker.close(r))
  }
})

test('没人看的时候不截图（省 CPU），有请求才抓', async () => {
  let shots = 0
  const wc = {
    isDestroyed: () => false,
    capturePage: async () => {
      shots++
      return { getSize: () => ({ width: 8, height: 8 }), toPNG: () => FAKE_PNG }
    }
  }
  const r = await obs.start({ port: 8894, fps: 30, getWebContents: () => wc })
  assert.equal(r.ok, true)
  await sleep(200)
  const idle = shots
  assert.ok(idle <= 1, '空闲时不该一直截，实际=' + idle)
  await fetch('http://127.0.0.1:8894/frame')
  await sleep(150)
  assert.ok(shots > idle, '有客户端请求后要开始抓帧')
  obs.stop()
})

test('页面 HTML 里的帧率占位被替换成真实值', () => {
  const html = obs.pageHtml(15)
  assert.match(html, /var FPS = 15/)
  assert.ok(html.indexOf('__FPS__') === -1)
})

test('关闭后端口释放，可以再次开启', async () => {
  await obs.start({ port: 8895, fps: 5, getWebContents: () => fakeWc() })
  obs.stop()
  const again = await obs.start({ port: 8895, fps: 5, getWebContents: () => fakeWc() })
  assert.equal(again.ok, true, '端口应该已经释放')
  obs.stop()
})

/* ---- 0.24.0 补丁㉕：渲染层画布快帧通道 ---- */

/** 在纯 node 测试里给 obs.js 的懒加载 require('electron') 注入 nativeImage 桩 */
function injectElectron (createFromDataURL) {
  const p = require.resolve('electron', { paths: [__dirname] })
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { nativeImage: { createFromDataURL } } }
  return () => { delete require.cache[p] }
}

test('executeJavaScript 返回 null → 回退 capturePage，帧照常出', async () => {
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: async () => null, // 渲染层还没有钩子（角色加载中）
    capturePage: async () => ({
      getSize: () => ({ width: 64, height: 64 }),
      toPNG: () => Buffer.concat([FAKE_PNG, Buffer.from(String(Date.now()))])
    })
  }
  const r = await obs.start({ port: 8896, fps: 20, getWebContents: () => wc })
  assert.equal(r.ok, true)
  try {
    const fr = await fetch('http://127.0.0.1:8896/frame')
    assert.equal(fr.status, 200, '快通道没钩子时要回退 capturePage，不能断流')
    await sleep(120)
    assert.equal(obs.status().mode, 'capturePage')
  } finally { obs.stop() }
})

test('executeJavaScript 抛异常 → 不炸，回退 capturePage', async () => {
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: () => { throw new Error('页面还没起来') },
    capturePage: async () => ({
      getSize: () => ({ width: 64, height: 64 }),
      toPNG: () => Buffer.concat([FAKE_PNG, Buffer.from(String(Date.now()))])
    })
  }
  const r = await obs.start({ port: 8897, fps: 20, getWebContents: () => wc })
  assert.equal(r.ok, true)
  try {
    const fr = await fetch('http://127.0.0.1:8897/frame')
    assert.equal(fr.status, 200)
  } finally { obs.stop() }
})

test('画布快通道：dataURL PNG 直接入库（不重编码），mode=canvas', async () => {
  // 造一张 >30KB 的合法 PNG（zlib 手工拼 + 随机噪声像素防压缩），过空帧体积闸
  const zlib = require('node:zlib')
  const w = 128, h = 128
  let seed = 0x12345678
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 16) & 0xff }
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 4) + 1 + x * 4
      raw[o] = rnd(); raw[o + 1] = rnd(); raw[o + 2] = rnd(); raw[o + 3] = 255
    }
  }
  const crc32 = (buf) => {
    let c, table = []
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
    let crc = 0xffffffff
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8bit RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
  assert.ok(png.length > 30 * 1024, '测试 PNG 要过体积闸，实际 ' + png.length)
  const dataUrl = 'data:image/png;base64,' + png.toString('base64')
  let url = ''
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: async () => dataUrl, // 模拟 window.__ryzaObsFrame()
    capturePage: async () => { throw new Error('快通道在用就不该走到 capturePage') }
  }
  const restore = injectElectron(() => ({
    getSize: () => ({ width: w, height: h }),
    toPNG: () => { throw new Error('画布模式不该重编码 PNG') }
  }))
  const r = await obs.start({ port: 8898, fps: 20, getWebContents: () => wc })
  assert.equal(r.ok, true)
  try {
    const fr = await fetch('http://127.0.0.1:8898/frame')
    assert.equal(fr.status, 200)
    assert.equal(fr.headers.get('content-type'), 'image/png')
    const buf = Buffer.from(await fr.arrayBuffer())
    assert.ok(buf.equals(png), '帧字节要和渲染层交来的一致（零重编码）')
    await sleep(120)
    assert.equal(obs.status().mode, 'canvas')
    const health = await (await fetch('http://127.0.0.1:8898/health')).json()
    assert.equal(health.mode, 'canvas')
  } finally { obs.stop(); restore() }
})
