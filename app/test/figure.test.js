'use strict'
/**
 * 形象包（figure pack）API 2 回归测试
 * 只测纯逻辑与落盘行为（不启 Electron）：manifest 校验 / zip 安全 / 原子安装 / 装扮解析
 * 夹具包在这里现造（仓库不放美术资源），同时充当「冷冻夹具」的替身
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const pack = require('../src/main/figures/pack')
const { readZip } = require('../src/main/figures/zip')

/* ------------------------------ 最小 zip 写入器 ------------------------------ */

function crc32 (buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/** files: [{name, data:Buffer|string}]，compress=true 时用 deflate */
function makeZip (files, compress) {
  const locals = []
  const central = []
  let off = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8')
    const data = compress ? zlib.deflateRawSync(raw) : raw
    const method = compress ? 8 : 0
    const crc = crc32(raw)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0x800, 6)
    lfh.writeUInt16LE(method, 8)
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
    cd.writeUInt16LE(method, 10)
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

/* --------------------------------- 夹具 --------------------------------- */

const BASE_FIGURE = {
  api: 2,
  manifest: { name: '测试形象', author: 'test', version: '1.0.0' },
  size: [360, 560],
  thumbnail: 'thumb.png',
  layers: [
    { z: 0, type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 300, h: 300, fill: '$skin' },
    { z: 10, type: 'shape', shape: 'rect', x: 20, y: 60, w: 100, h: 100, fill: '$hair' }
  ],
  axes: [
    {
      id: 'hat',
      label: '帽子',
      slot: 'hat',
      options: [
        { id: 'none', label: '无' },
        { id: 'beret', label: '贝雷帽', layer: { z: 30, type: 'shape', shape: 'ellipse', x: 0, y: -20, w: 200, h: 100, fill: 'c:main' }, vars: { 'c-hat-main': '#6d4aff' } }
      ]
    },
    {
      id: 'neck',
      label: '颈饰',
      slot: 'neck',
      options: [{ id: 'none', label: '无' }, { id: 'ribbon', label: '蝴蝶结', vars: { 'c-neck-acc': '#ff5577' } }]
    }
  ],
  palettes: [
    { id: 'light', label: '浅色', vars: { skin: '#f6d7c4', hair: '#6b4b3a', main: '#7a86ff', acc: '#ffb0c8' } },
    { id: 'dark', label: '深色', vars: { skin: '#e0b79c', hair: '#2b2b33', main: '#4a53b8', acc: '#c76a86' } }
  ],
  presets: [
    { id: 'casual', label: '日常', axes: { hat: 'beret' }, palette: 'light', console: { light: { accent: '#7a86ff' }, dark: { accent: '#4a53b8' } } }
  ]
}

function fixtureFiles (over) {
  const fig = over ? Object.assign({}, BASE_FIGURE, over) : BASE_FIGURE
  return [
    { name: 'figure.json', data: JSON.stringify(fig, null, 1) },
    { name: 'thumb.png', data: Buffer.alloc(64, 7) }
  ]
}

function tmpRoot () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-fig-'))
  pack.setBaseDir(path.join(dir, 'figures'))
  return dir
}

/* --------------------------------- 用例 --------------------------------- */

test('zip 读取：store 与 deflate 都能解，路径穿越被拦', () => {
  const a = readZip(makeZip([{ name: 'a.txt', data: 'hello' }], false))
  assert.equal(a.ok, true)
  assert.equal(a.entries[0].data.toString(), 'hello')

  const b = readZip(makeZip([{ name: 'dir/b.txt', data: 'x'.repeat(5000) }], true))
  assert.equal(b.ok, true)
  assert.equal(b.entries[0].data.length, 5000)

  const bad = readZip(makeZip([{ name: '../evil.exe', data: 'x' }], false))
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /非法路径/)

  const abs = readZip(makeZip([{ name: 'C:/Windows/x.dll', data: 'x' }], false))
  assert.equal(abs.ok, false)
})

test('manifest：缺 api 或 api=1 一律 skipped 并给原因', () => {
  const v1 = pack.validateFigure({ api: 1, name: 'old', layers: [] }, null)
  assert.equal(v1.ok, false)
  assert.match(v1.reason, /API 1/)
  const none = pack.validateFigure({ name: 'x' }, null)
  assert.equal(none.ok, false)
  assert.match(none.reason, /api/)
  const empty = pack.validateFigure({ api: 2, manifest: { name: '空' }, layers: [] }, null)
  assert.equal(empty.ok, false)
  assert.match(empty.reason, /layers/)
  const ok = pack.validateFigure(BASE_FIGURE, null)
  assert.equal(ok.ok, true)
  assert.equal(ok.fig.axes.length, 2)
  assert.equal(ok.fig.presets[0].console.light.accent, '#7a86ff')
})

test('zip 导入 → 列表 → 解析 → 删除', () => {
  tmpRoot()
  const zip = path.join(os.tmpdir(), 'fig-' + Date.now() + '.zip')
  fs.writeFileSync(zip, makeZip(fixtureFiles(), true))
  const r = pack.importZip(zip)
  assert.equal(r.ok, true, r.reason)
  assert.ok(r.id)

  const list = pack.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '测试形象')
  assert.ok(list[0].thumb.startsWith('aura://local/'))
  assert.equal(list[0].axes[0].id, 'hat')

  // 默认装扮：帽子取第一个选项（none），调色盘取 light
  const d = pack.defaultDress(r.id)
  assert.deepEqual(d.axes, { hat: 'none', neck: 'none' })
  assert.equal(d.palette, 'light')

  // 指定贝雷帽：配件层进 layers，双色通道 c-hat-main 被解析成具体颜色
  const res = pack.resolve(r.id, { axes: { hat: 'beret' }, palette: 'dark' })
  assert.equal(res.layers.length, 3)
  const hat = res.layers.find((l) => l.z === 30)
  assert.equal(hat.fill.kind, 'var')
  assert.equal(hat.fill.value, '#6d4aff')
  // 基础层的 $skin 跟着调色盘走
  const skin = res.layers.find((l) => l.z === 0)
  assert.equal(skin.fill.value, '#e0b79c')

  // 预设：palette 与 axes 一起生效
  const pre = pack.resolve(r.id, { preset: 'casual' })
  assert.equal(pre.dress.palette, 'light')
  assert.equal(pre.dress.axes.hat, 'beret')

  assert.equal(pack.remove(r.id), true)
  assert.equal(pack.list().length, 0)
  fs.rmSync(zip, { force: true })
})

test('解压到顶层目录的包也能装（zip 整个文件夹）', () => {
  tmpRoot()
  const files = fixtureFiles().map((f) => ({ name: 'MyFigure/' + f.name, data: f.data }))
  const zip = path.join(os.tmpdir(), 'fig2-' + Date.now() + '.zip')
  fs.writeFileSync(zip, makeZip(files, false))
  const r = pack.importZip(zip)
  assert.equal(r.ok, true, r.reason)
  fs.rmSync(zip, { force: true })
})

test('非法包不落盘：API 1 / 缺 figure.json / 缩略图超 1MB', () => {
  const root = tmpRoot()
  const z1 = path.join(os.tmpdir(), 'bad1-' + Date.now() + '.zip')
  fs.writeFileSync(z1, makeZip(fixtureFiles({ api: 1 }), false))
  const r1 = pack.importZip(z1)
  assert.equal(r1.ok, false)
  assert.equal(r1.skipped, true)
  fs.rmSync(z1, { force: true })

  const z2 = path.join(os.tmpdir(), 'bad2-' + Date.now() + '.zip')
  fs.writeFileSync(z2, makeZip([{ name: 'readme.txt', data: 'no figure' }], false))
  assert.equal(pack.importZip(z2).ok, false)
  fs.rmSync(z2, { force: true })

  const z3 = path.join(os.tmpdir(), 'bad3-' + Date.now() + '.zip')
  fs.writeFileSync(z3, makeZip([
    { name: 'figure.json', data: JSON.stringify(BASE_FIGURE) },
    { name: 'thumb.png', data: Buffer.alloc(1024 * 1024 + 10, 1) }
  ], false))
  const r3 = pack.importZip(z3)
  assert.equal(r3.ok, false)
  assert.match(r3.reason, /缩略图/)
  fs.rmSync(z3, { force: true })

  // 暂存目录要清干净，别留垃圾
  const leftovers = fs.readdirSync(path.join(root, 'figures')).filter((n) => n.startsWith('.staging'))
  assert.deepEqual(leftovers, [])
  assert.equal(pack.list().length, 0)
})

test('同名包重复导入不覆盖，自动加后缀', () => {
  tmpRoot()
  const files = fixtureFiles()
  const zip = path.join(os.tmpdir(), 'fig3-' + Date.now() + '.zip')
  fs.writeFileSync(zip, makeZip(files, false))
  const a = pack.importZip(zip)
  const b = pack.importZip(zip)
  assert.equal(a.ok && b.ok, true)
  assert.notEqual(a.id, b.id)
  assert.equal(pack.list().length, 2)
  fs.rmSync(zip, { force: true })
})

test('颜色引用：变量缺失的图层直接不画，不会变成黑块', () => {
  const vars = { main: '#123456' }
  assert.equal(pack.colorRef('$missing', { vars }), null)
  assert.equal(pack.colorRef('#fff', { var: 1 }).value, '#fff')
  assert.equal(pack.colorRef('javascript:alert(1)', { vars }), null)
  // c:main 没配通道时退回调色盘 main
  const fallback = pack.colorRef('c:main', { slot: 'hat', vars })
  assert.equal(fallback.value, '#123456')
})

test('损坏的包目录出现在列表里但标 broken，不炸整页', () => {
  const root = tmpRoot()
  fs.mkdirSync(path.join(root, 'figures', 'broken-pack'), { recursive: true })
  fs.writeFileSync(path.join(root, 'figures', 'broken-pack', 'figure.json'), '{ not json')
  const list = pack.list()
  assert.equal(list.length, 1)
  assert.match(list[0].broken, /读取失败/)
})

test('配件多层 + 显式通道名 c:hat-acc + 描边', () => {
  tmpRoot()
  const fig = JSON.parse(JSON.stringify(BASE_FIGURE))
  fig.axes = [
    {
      id: 'hat',
      label: '帽子',
      slot: 'hat',
      options: [
        { id: 'none', label: '无' },
        {
          id: 'beret',
          label: '贝雷帽',
          // 一个部件的两层：帽体走 c:main（按 slot 推导），球球走显式通道名
          layers: [
            { z: 30, type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 100, h: 50, fill: 'c:main' },
            { z: 31, type: 'shape', shape: 'ellipse', x: 60, y: -10, w: 20, h: 20, fill: 'c:hat-acc' },
            { z: 32, type: 'shape', shape: 'ellipse', x: 10, y: 10, w: 60, h: 30, fill: null, stroke: '#222', strokeWidth: 2 }
          ],
          vars: { 'c-hat-main': '#6d4aff', 'c-hat-acc': '#ffd166' }
        }
      ]
    }
  ]
  const zip = path.join(os.tmpdir(), 'fig-multi-' + Date.now() + '.zip')
  fs.writeFileSync(zip, makeZip([
    { name: 'figure.json', data: JSON.stringify(fig) },
    { name: 'thumb.png', data: Buffer.alloc(32, 3) }
  ], false))
  const r = pack.importZip(zip)
  assert.equal(r.ok, true, r.reason)
  const res = pack.resolve(r.id, { axes: { hat: 'beret' } })
  const hat = res.layers.filter((l) => l.z >= 30)
  assert.equal(hat.length, 3, '三层都要画出来')
  assert.equal(hat[0].fill.value, '#6d4aff')
  assert.equal(hat[1].fill.value, '#ffd166', '显式通道名要能命中 c-hat-acc')
  assert.equal(hat[2].stroke.value, '#222')
  assert.equal(hat[2].fill, undefined, '只描边不填色的层，fill 可以为空')
  fs.rmSync(zip, { force: true })
})

test('自定义配色：复制后叠加在内置之上，删包不留悬空引用', () => {
  tmpRoot()
  const zip = path.join(os.tmpdir(), 'fig-custom-' + Date.now() + '.zip')
  fs.writeFileSync(zip, makeZip(fixtureFiles(), false))
  const r = pack.importZip(zip)
  assert.equal(r.ok, true, r.reason)

  const saved = pack.saveCustomPalette(r.id, { id: 'custom-1', label: '我的配色', vars: { skin: '#123456', bogus: 'javascript:alert(1)' } })
  assert.ok(saved)
  assert.equal(saved.vars.skin, '#123456')
  assert.equal(saved.vars.bogus, undefined, '非法色值要清掉')

  const res = pack.resolve(r.id, { palette: 'custom-1' })
  assert.equal(res.palettes.length, 3, '内置两套 + 自定义一套')
  const skin = res.layers.find((l) => l.z === 0)
  assert.equal(skin.fill.value, '#123456')
  // 内置调色盘没被改动
  const light = res.palettes.find((p) => p.id === 'light')
  assert.equal(light.vars.skin, '#f6d7c4')

  const preset = pack.saveCustomPreset(r.id, { id: 'custom-p', label: '我的方案', axes: { hat: 'beret', ghost: 'x' }, palette: 'custom-1' }, ['hat', 'neck'])
  assert.ok(preset)
  assert.equal(preset.axes.ghost, undefined, '不存在的维度要过滤')
  const before = pack.resolve(r.id, { preset: 'custom-p' })
  assert.equal(before.dress.axes.hat, 'beret')
  assert.equal(before.dress.palette, 'custom-1')

  assert.equal(pack.delCustom(r.id, 'preset', 'custom-p'), true)
  assert.equal(pack.resolve(r.id, { preset: 'custom-p' }).dress.preset, null)

  assert.equal(pack.remove(r.id), true)
  assert.equal(fs.existsSync(path.join(pack.base(), r.id)), false)
  fs.rmSync(zip, { force: true })
})

test('示例形象包（冷冻夹具）能被解析且装扮位齐全', () => {
  const root = tmpRoot()
  const seedZip = path.join(__dirname, '..', 'resources', 'figures', 'ryza-example.zip')
  assert.equal(fs.existsSync(seedZip), true, '示例包要先 npm run figure:example 生成')
  const r = pack.importZip(seedZip)
  assert.equal(r.ok, true, r.reason)
  const list = pack.list()
  const fig = list.find((p) => p.id === r.id)
  assert.ok(fig)
  assert.equal(fig.id, r.id)
  assert.ok(fig.axes.length >= 3, '至少帽子/眼镜/颈饰三个维度')
  const d = pack.defaultDress(r.id)
  assert.ok(d && d.palette, '要有默认调色盘')
  const dressed = pack.resolve(r.id, { axes: { hat: 'beret', glasses: 'round', neck: 'ribbon' }, palette: 'mint' })
  assert.ok(dressed.layers.length > 24)
  // 配色不同，画出来的皮肤色不同（证明变量真的生效）
  const light = pack.resolve(r.id, { palette: 'light' })
  const skinLight = light.layers.find((l) => l.fill && l.fill.key === 'skin')
  const skinMint = dressed.layers.find((l) => l.fill && l.fill.key === 'skin')
  assert.notEqual(skinLight.fill.value, skinMint.fill.value)
  fs.rmSync(root, { recursive: true, force: true })
})

test('渲染器：颜色/缩放/眨眼层按预期落到 canvas（假 ctx 记录绘制）', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/shared/figure-render.js'), 'utf8')

  const fills = []
  const ctx = {
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    clearRect () {},
    save () {},
    restore () {},
    translate () {},
    rotate () {},
    scale () {},
    beginPath () {},
    ellipse () {},
    rect () {},
    roundRect () {},
    drawImage () {},
    fillRect () {},
    fill () { fills.push(this.fillStyle) },
    stroke () {}
  }
  const canvas = {
    clientWidth: 200,
    clientHeight: 400,
    width: 0,
    height: 0,
    getContext: () => ctx
  }
  const fakeWindow = {
    devicePixelRatio: 1,
    Image: class { set src (v) { this._src = v; if (this.onload) this.onload() } get src () { return this._src } },
    ResizeObserver: null
  }
  const AuraFigure = new Function('window', code + '\n;return window.AuraFigure')(fakeWindow)
  assert.ok(AuraFigure)

  const payload = {
    size: [100, 100],
    layers: [
      { z: 0, type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 100, h: 100, opacity: 1, rotate: 0, fill: { kind: 'lit', value: '#123456' } },
      { z: 1, type: 'shape', shape: 'rect', x: 0, y: 0, w: 20, h: 20, opacity: 1, rotate: 0, rx: 3, fill: { kind: 'lit', value: '#abcdef' } },
      { z: 2, type: 'shape', shape: 'rect', x: 0, y: 0, w: 20, h: 4, opacity: 1, rotate: 0, rx: 2, blink: 'closed', fill: { kind: 'lit', value: '#ff0000' } }
    ]
  }
  const compiled = AuraFigure.compile(payload)
  assert.equal(compiled.layers.length, 3)

  // 睁眼：闭眼层不画
  AuraFigure.draw(ctx, compiled, { w: 200, h: 400, time: 0, blink: false })
  assert.deepEqual(fills.slice(), ['#123456', '#abcdef'])

  // 眨眼：闭眼层出现
  fills.length = 0
  AuraFigure.draw(ctx, compiled, { w: 200, h: 400, time: 0, blink: true })
  assert.deepEqual(fills.slice(), ['#123456', '#abcdef', '#ff0000'])

  // startLoop：自动按 DPR 设置画布尺寸并绘制
  fills.length = 0
  const loop = AuraFigure.startLoop(canvas, payload, { interval: 10000 })
  assert.equal(canvas.width, 200)
  assert.equal(canvas.height, 400)
  assert.ok(fills.length >= 2, '启动即画一帧')
  loop.stop()
})
