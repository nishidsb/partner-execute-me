'use strict'
/**
 * 品牌图标生成（不参与应用运行）
 *   npx electron tools/brand-icon.js
 *
 * 「Partner.execute(me);」图标：深灰竖条纹噪点底 + 白色电源符号（对齐 MV 视觉）。
 * 一次渲染 1024px 母版，页面内 canvas 缩到各尺寸导出 PNG：
 *   build/icon.ico（PNG 条目 ICO 容器，16/32/48/64/128/256）
 *   build/branding/icon.png (512) / icon-256.png / tray-{16,32,64}.png
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 生成竖条纹背景（确定性伪随机，可重复构建） */
function stripes (seed) {
  let s = seed >>> 0
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff }
  const rects = []
  let x = 0
  while (x < 1024) {
    const w = 2 + Math.floor(rnd() * 14)
    const v = 10 + Math.floor(rnd() * 26) // 10~36 灰度
    rects.push(`<rect x="${x}" y="0" width="${w}" height="1024" fill="rgb(${v},${v},${v + 2})"/>`)
    x += w
  }
  return rects.join('')
}

const SVG = (glow) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <filter id="g" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="${glow ? 14 : 0}"/>
  </filter>
</defs>
<rect width="1024" height="1024" fill="#0b0b0c"/>
${stripes(20261031)}
<rect width="1024" height="1024" fill="url(#fade)" opacity="0"/>
<g filter="url(#g)" opacity="${glow ? 0.55 : 1}">
  <circle cx="512" cy="540" r="270" fill="none" stroke="#ffffff" stroke-width="76"
    stroke-dasharray="1275 424" stroke-dashoffset="-212" stroke-linecap="round" transform="rotate(-90 512 540)"/>
  <line x1="512" y1="176" x2="512" y2="520" stroke="#ffffff" stroke-width="76" stroke-linecap="round"/>
</g>
<circle cx="512" cy="540" r="270" fill="none" stroke="#ffffff" stroke-width="76"
  stroke-dasharray="1275 424" stroke-dashoffset="-212" stroke-linecap="round" transform="rotate(-90 512 540)"/>
<line x1="512" y1="176" x2="512" y2="520" stroke="#ffffff" stroke-width="76" stroke-linecap="round"/>
</svg>`

/* ICO 容器：PNG 条目（Vista+ 支持）。目录项 16 字节 + 各 PNG 原样嵌入 */
function buildIco (pngs) { // pngs: [{size, buf}]
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2); e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12)
    entries.push(e); offset += buf.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 1100, show: false, frame: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<body style="margin:0"></body>')
  // 母版（带辉光）+ 无辉光小尺寸版
  const render = async (svg) => {
    const b64 = await win.webContents.executeJavaScript(`new Promise((ok) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = 1024; c.height = 1024
        c.getContext('2d').drawImage(img, 0, 0)
        ok(c.toDataURL('image/png').split(',')[1])
      }
      img.onerror = () => ok('')
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(${JSON.stringify(svg)})))
    })`)
    return Buffer.from(b64 || '', 'base64')
  }
  const master = await render(SVG(true))
  if (!master.length) { console.error('[brand-icon] SVG 渲染失败'); app.exit(1) }
  const plain = await render(SVG(false))

  const root = path.join(__dirname, '..')
  const branding = path.join(root, 'build', 'branding')
  fs.mkdirSync(branding, { recursive: true })
  fs.writeFileSync(path.join(branding, 'icon-master.png'), master)
  // 小尺寸用无辉光版（缩到 16px 辉光会糊成一团）
  const sizes = [256, 128, 64, 48, 32, 16]
  const pngs = []
  for (const size of sizes) {
    const b64 = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image()
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = 'data:image/png;base64,${plain.toString('base64')}' })
      const c = document.createElement('canvas')
      c.width = ${size}; c.height = ${size}
      const g = c.getContext('2d')
      g.imageSmoothingQuality = 'high'
      g.drawImage(img, 0, 0, ${size}, ${size})
      return c.toDataURL('image/png').split(',')[1]
    })()`)
    const buf = Buffer.from(b64, 'base64')
    pngs.push({ size, buf })
    fs.writeFileSync(path.join(branding, `icon-${size}.png`), buf)
  }
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(pngs))
  fs.writeFileSync(path.join(branding, 'icon.png'), pngs.find((p) => p.size === 256).buf)
  for (const s of [16, 32, 64]) fs.writeFileSync(path.join(branding, `tray-${s}.png`), pngs.find((p) => p.size === s).buf)
  console.log('[brand-icon] 完成: build/icon.ico + build/branding/*')
  app.exit(0)
})
