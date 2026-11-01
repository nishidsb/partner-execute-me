'use strict'
/**
 * 形象包 0.41.0：侧身走 + 口型 + needs（包对宿主的要求）
 *
 * 三个能力都是「包可选声明」，老包不给就退回原样。所以每组用例都成对写：
 * 声明了 → 生效；没声明 → 行为与 0.40 一致（防止把老包弄坏）。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const vm = require('node:vm')

const pack = require('../src/main/figures/pack')

/* ------------------------------ 小工具 ------------------------------ */

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

/** 最小 zip：store 模式即可（测试不关心压缩率） */
function makeZip (files) {
  const locals = []
  const central = []
  let off = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8')
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(0, 8)
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(0, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, name, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(0, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(0, 38)
    ch.writeUInt32LE(off, 42)
    central.push(ch, name)
    off += lh.length + name.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, end])
}

function tmpRoot () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-side-'))
  pack.setBaseDir(path.join(dir, 'figures'))
  return dir
}

function loadFigureLib () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'shared', 'figure-render.js'), 'utf8')
  const sandbox = { console }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  return sandbox.AuraFigure
}
const F = loadFigureLib()

const FRONT = { z: 0, type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 360, h: 560, fill: '#8ab' }
const SIDE = { z: 0, type: 'shape', shape: 'ellipse', x: 40, y: 0, w: 280, h: 560, fill: '#a8b' }

function figWith (over) {
  return Object.assign({
    api: 2,
    manifest: { name: '侧身测试' },
    size: [360, 560],
    layers: [FRONT]
  }, over)
}

/* ------------------------------ needs ------------------------------ */

test('needs：不给就是默认值（老包行为不变）', () => {
  const r = pack.validateFigure(figWith({}), null)
  assert.equal(r.ok, true, r.reason)
  assert.deepStrictEqual(r.fig.needs, { facing: 'right', views: ['front'], stage: null, anchor: 'bottom' })
  assert.deepStrictEqual(r.fig.views, {})
})

test('needs：facing / stage / anchor 会规整，非法值回默认', () => {
  const r = pack.validateFigure(figWith({
    needs: { facing: 'up', stage: [200, 400], anchor: 'center' }
  }), null)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.fig.needs.facing, 'right', 'facing 只认 left/right，其他当 right')
  assert.deepStrictEqual(r.fig.needs.stage, [200, 400])
  assert.equal(r.fig.needs.anchor, 'center')

  const bad = pack.validateFigure(figWith({ needs: { stage: [-1, 0] } }), null)
  assert.equal(bad.fig.needs.stage, null, 'stage 非法就该是 null，不能塞个负数进去')
})

test('views.side：给了侧身层就自动把自己登记进 needs.views', () => {
  const r = pack.validateFigure(figWith({ views: { side: { layers: [SIDE] } } }), null)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.fig.views.side.layers.length, 1)
  assert.ok(r.fig.needs.views.includes('side'), '侧身层存在却没登记 side，渲染层就不会走侧身')
})

test('views.side：侧身层引用不存在的图片 → 整包拒绝并说明是侧身', () => {
  const r = pack.validateFigure(figWith({
    views: { side: { layers: [{ z: 0, type: 'image', src: 'img/none.png', x: 0, y: 0, w: 10, h: 10 }] } }
  }), new Set(['figure.json']))
  assert.equal(r.ok, false)
  assert.match(r.reason, /侧身/)
})

/* ------------------------------ 口型 ------------------------------ */

test('口型：part:mouth 的层保留 open，其他层的 open 是 null', () => {
  const r = pack.validateFigure(figWith({
    layers: [
      FRONT,
      { z: 5, type: 'shape', shape: 'ellipse', x: 170, y: 240, w: 24, h: 8, fill: '#a44', part: 'mouth', open: 0 },
      { z: 6, type: 'shape', shape: 'ellipse', x: 170, y: 240, w: 24, h: 18, fill: '#a44', part: 'mouth', open: 1 }
    ]
  }), null)
  assert.equal(r.ok, true, r.reason)
  const mouths = r.fig.layers.filter((l) => l.part === 'mouth')
  assert.equal(mouths.length, 2)
  assert.deepStrictEqual(mouths.map((m) => m.open), [0, 1])
  assert.equal(r.fig.layers[0].open, null, '普通图层的 open 必须是 null，否则会被当成口型层藏起来')
})

test('口型：pickMouth 挑开口度最接近的那张', () => {
  const mouth = [{ open: 0 }, { open: 0.5 }, { open: 1 }]
  assert.equal(F.pickMouth(mouth, 0), mouth[0])
  assert.equal(F.pickMouth(mouth, 0.45), mouth[1])
  assert.equal(F.pickMouth(mouth, 0.9), mouth[2])
  assert.equal(F.pickMouth(mouth, 5), mouth[2], '超出 0~1 要夹紧')
  assert.equal(F.pickMouth([], 0.5), null)
  assert.equal(F.pickMouth(null, 0.5), null)
})

/* ------------------------------ 编译与朝向 ------------------------------ */

test('compile：声明 side 才有 hasSide；没声明就是纯正脸', () => {
  const plain = F.compile({ layers: [FRONT], size: [360, 560] })
  assert.equal(plain.hasSide, false)
  assert.equal(plain.side, null)

  const sided = F.compile({
    layers: [FRONT],
    size: [360, 560],
    needs: { views: ['front', 'side'], facing: 'left' },
    views: { side: { layers: [SIDE] } }
  })
  assert.equal(sided.hasSide, true)
  assert.equal(sided.side.layers.length, 1)

  // 有侧身层但 needs.views 没声明 side → 不启用（避免包里放了图却没打算走侧身）
  const half = F.compile({ layers: [FRONT], views: { side: { layers: [SIDE] } } })
  assert.equal(half.hasSide, false)
})

test('flipFor：往左走要镜像，除非包声明自己本来就朝左', () => {
  assert.equal(F.flipFor(1, { facing: 'right' }), 1)
  assert.equal(F.flipFor(-1, { facing: 'right' }), -1)
  assert.equal(F.flipFor(-1, { facing: 'left' }), 1, '朝左的立绘往左走不该再翻')
  assert.equal(F.flipFor(1, { facing: 'left' }), -1)
  assert.equal(F.flipFor(0, { facing: 'right' }), 1, '站着不翻')
})

test('compile：侧身层的口型也能用（两套各自挑嘴）', () => {
  const c = F.compile({
    layers: [FRONT, { part: 'mouth', open: 0, type: 'shape', shape: 'ellipse', w: 10, h: 4, fill: '#a44' }],
    needs: { views: ['front', 'side'] },
    views: { side: { layers: [SIDE, { part: 'mouth', open: 1, type: 'shape', shape: 'ellipse', w: 10, h: 12, fill: '#a44' }] } }
  })
  assert.equal(c.mouth.length, 1)
  assert.equal(c.side.mouth.length, 1)
})

/* ------------------------------ 端到端：安装后 resolve 的载荷 ------------------------------ */

test('安装后 resolve 的载荷带上 needs 与侧身层', () => {
  tmpRoot()
  const fig = figWith({
    needs: { facing: 'left', views: ['front', 'side'], stage: [200, 400] },
    layers: [FRONT, { z: 5, type: 'shape', shape: 'ellipse', x: 170, y: 240, w: 24, h: 8, fill: '#a44', part: 'mouth', open: 0.5 }],
    views: { side: { layers: [SIDE] } }
  })
  const zip = path.join(os.tmpdir(), 'fig-side-' + Date.now() + '.zip')
  fs.writeFileSync(zip, makeZip([
    { name: 'figure.json', data: JSON.stringify(fig) },
    { name: 'thumb.png', data: Buffer.alloc(64, 7) }
  ]))
  const r = pack.importZip(zip)
  assert.equal(r.ok, true, r.reason)

  const payload = pack.resolve(r.id, {})
  assert.ok(payload, 'resolve 返回空')
  assert.equal(payload.needs.facing, 'left')
  assert.deepStrictEqual(payload.needs.stage, [200, 400])
  assert.ok(payload.views && payload.views.side, '载荷里没有 views.side，渲染层就永远是正脸')
  assert.equal(payload.views.side.layers.length, 1)

  const mouth = payload.layers.find((l) => l.part === 'mouth')
  assert.ok(mouth, '载荷丢了口型层')
  assert.equal(mouth.open, 0.5)

  // 渲染层拿到这份载荷能编译出侧身
  const c = F.compile(payload)
  assert.equal(c.hasSide, true)
})
