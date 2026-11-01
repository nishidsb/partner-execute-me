'use strict'
/**
 * 0.18.0 第二批 · 形象包管理（卸载 + 动作清单）
 * - list() 要带占用大小（卸载前让人看见有多大）
 * - 删除是不可逆的：界面必须两段确认
 * - 动作清单：渲染层上报 → 主进程缓存 → 设置页拉取/预览（接线级断言）
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pack = require('../src/main/figures/pack')

const SRC = path.join(__dirname, '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

function tmpRoot () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-figsize-'))
  pack.setBaseDir(path.join(dir, 'figures'))
  return dir
}

const FIG = {
  api: 2,
  manifest: { name: '夹具小人', author: 'test', version: '1.0.0' },
  size: [360, 560],
  thumbnail: 'thumb.png',
  layers: [
    { z: 0, type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 300, h: 300, fill: '$skin' },
    { z: 10, type: 'shape', shape: 'rect', x: 20, y: 60, w: 100, h: 100, fill: '$hair' }
  ],
  axes: [
    { id: 'hat', label: '帽子', slot: 'hat', options: [{ id: 'none', label: '无' }, { id: 'beret', label: '贝雷帽' }] }
  ],
  palettes: [
    { id: 'light', label: '浅色', vars: { skin: '#f6d7c4', hair: '#6b4b3a' } }
  ],
  presets: [{ id: 'casual', label: '日常', axes: { hat: 'beret' }, palette: 'light' }]
}

test('list() 带 sizeBytes：包目录里的文件都算进去', () => {
  const root = tmpRoot()
  const srcDir = path.join(root, 'src')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'figure.json'), JSON.stringify(FIG))
  fs.writeFileSync(path.join(srcDir, 'thumb.png'), Buffer.alloc(64, 7))
  fs.writeFileSync(path.join(srcDir, 'big.bin'), Buffer.alloc(4096, 3))
  const r = pack.importDir(srcDir)
  assert.equal(r.ok, true)
  const list = pack.list()
  const one = list.find((p) => p.id === r.id)
  assert.ok(one, '导入后应出现在列表里')
  assert.ok(one.sizeBytes >= 4096 + JSON.stringify(FIG).length - 10, 'sizeBytes 要包含包内文件：' + one.sizeBytes)
  fs.rmSync(root, { recursive: true, force: true })
})

test('删除形象包：目录真的没了，列表不再有它', () => {
  const root = tmpRoot()
  const srcDir = path.join(root, 'src2')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'figure.json'), JSON.stringify(FIG))
  fs.writeFileSync(path.join(srcDir, 'thumb.png'), Buffer.alloc(64, 7))
  const r = pack.importDir(srcDir)
  assert.equal(r.ok, true)
  const dirBefore = path.join(pack.base(), r.id)
  assert.ok(fs.existsSync(dirBefore))
  assert.equal(pack.remove(r.id), true)
  assert.equal(fs.existsSync(dirBefore), false, '包目录必须整棵删掉')
  assert.ok(!pack.list().some((p) => p.id === r.id))
  fs.rmSync(root, { recursive: true, force: true })
})

test('界面：删除要点两下（3 秒内），并显示占用大小', () => {
  const ui = read('renderer/dress/app.js')
  assert.match(ui, /delArm/, '要有确认状态')
  assert.match(ui, /确认删除/, '要有确认提示')
  assert.match(ui, /fn.*fmtSize|function fmtSize/, '要格式化大小')
  assert.match(ui, /fmtSize\(p\.sizeBytes\)/, '列表里要显示占用')
})

test('动作清单：渲染层上报 → 主进程缓存 → preload 暴露 → 设置页可点播', () => {
  const pet = read('renderer/overlay/pet.js')
  assert.match(pet, /case 'anim-list'/, '渲染层要响应动作清单请求')
  assert.match(pet, /case 'anim-play'/, '渲染层要能预览播放')
  assert.match(pet, /spineAnimCtx\.anims/, '从骨架里取动画名')
  assert.match(pet, /petAnimReport/, '要把清单回报给主进程')

  const ovPre = read('preload/overlay.js')
  assert.match(ovPre, /petAnimReport/, 'preload 要暴露上报通道')

  const main = read('main/companion/index.js')
  assert.match(main, /pet:anim-report/, '主进程要接上报')
  assert.match(main, /pet:anim-list/, '主进程要有查询通道')
  assert.match(main, /pet:anim-play/, '主进程要有预览通道')

  const pre = read('preload/companion.js')
  assert.match(pre, /animList/, '设置页要能拉清单')
  assert.match(pre, /animPlay/, '设置页要能点播')

  const app = read('renderer/companion/app.js')
  assert.match(app, /btnAnimList/, '界面要有读取按钮')
  assert.match(app, /animPlay\(a\.name\)/, '点名字要能预览')

  const html = read('renderer/companion/index.html')
  assert.match(html, /id="animList"/, '要有动作列表容器')
})
