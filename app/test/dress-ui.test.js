'use strict'
/**
 * 装扮窗口（renderer/dress）UI 回归：jsdom 跑真实 app.js，
 * 用假的 figureAPI 顶替主进程，验证「列表 → 装扮 → 配色 → 方案 → 应用」这条链路。
 * 画布像素不在这里验（jsdom 没有 canvas），渲染逻辑在 figure.test.js 用假 ctx 覆盖。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM, VirtualConsole } = require('jsdom')

const ROOT = path.join(__dirname, '..')

const PAYLOAD = {
  id: 'pack-a',
  name: '测试形象',
  size: [360, 560],
  layers: [{ z: 0, type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 360, h: 560, opacity: 1, rotate: 0, fill: { kind: 'var', key: 'skin', value: '#f6d7c4' } }],
  axes: [
    { id: 'hat', label: '帽子', slot: 'hat', options: [{ id: 'none', label: '不戴' }, { id: 'beret', label: '贝雷帽' }] },
    { id: 'glasses', label: '眼镜', slot: 'glasses', options: [{ id: 'none', label: '不戴' }, { id: 'round', label: '圆框' }] }
  ],
  palettes: [
    { id: 'light', label: '浅色', vars: { skin: '#f6d7c4', hair: '#6b4b3a' } },
    { id: 'dark', label: '深色', vars: { skin: '#e0b79c', hair: '#2b2b33' } }
  ],
  presets: [
    { id: 'daily', label: '日常', axes: { hat: 'beret' }, palette: 'light', vars: {}, console: { dark: { accent: '#123456' } } },
    { id: 'mine', label: '我的方案', axes: {}, palette: 'dark', vars: {}, custom: true }
  ],
  dress: { axes: { hat: 'none', glasses: 'none' }, palette: 'light', vars: {}, preset: null },
  vars: { skin: '#f6d7c4', hair: '#6b4b3a' }
}

function build () {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/dress/index.html'), 'utf8')
    .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')

  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => errors.push(String(e.detail || e.message)))
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')))

  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc })
  const { window } = dom

  const calls = { resolve: [], apply: [], clear: 0, savePalette: [], savePreset: [], remove: [] }
  window.figureAPI = {
    state: async () => ({
      packs: [{ id: 'pack-a', name: '测试形象', axes: PAYLOAD.axes, palettes: PAYLOAD.palettes, presets: PAYLOAD.presets, thumb: '' }],
      figure: null,
      resolved: null,
      hasMode: false
    }),
    list: async () => [],
    importPack: async () => ({ ok: false, canceled: true }),
    importPath: async () => ({ ok: false, reason: 'no' }),
    remove: async (id) => { calls.remove.push(id); return true },
    resolve: async (id, dress) => { calls.resolve.push({ id, dress }); return Object.assign({}, PAYLOAD, { dress: { axes: dress.axes, palette: dress.palette, vars: dress.vars, preset: dress.preset } }) },
    defaultDress: async () => ({ pack: 'pack-a', axes: { hat: 'none', glasses: 'none' }, palette: 'light', vars: {}, preset: null }),
    apply: async (dress) => { calls.apply.push(dress); return { ok: true, char: { visual: { figure: { pack: dress.pack } } } } },
    clear: async () => { calls.clear++; return { ok: true } },
    savePalette: async (packId, pal) => { calls.savePalette.push({ packId, pal }); window.__savedPalette = pal; return pal },
    savePreset: async (packId, preset) => { calls.savePreset.push({ packId, preset }); return preset },
    delCustom: async () => true,
    openDress: async () => true,
    close: async () => true,
    min: async () => true,
    pathOf: () => '',
    onChanged: () => {}
  }
  // jsdom 的 canvas 没有 2d 实现：给一个空上下文，渲染层只会在里面调用 API 而不产出像素
  window.HTMLCanvasElement.prototype.getContext = function () {
    const noop = () => {}
    return {
      clearRect: noop, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
      beginPath: noop, ellipse: noop, rect: noop, roundRect: noop, drawImage: noop, fillRect: noop,
      fill: noop, stroke: noop, globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1
    }
  }
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', { get () { return 300 } })
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', { get () { return 520 } })

  window.eval(fs.readFileSync(path.join(ROOT, 'src/renderer/shared/figure-render.js'), 'utf8'))
  window.eval(fs.readFileSync(path.join(ROOT, 'src/renderer/dress/app.js'), 'utf8'))
  return { window, dom, calls, errors }
}

test('装扮窗：列表 / 装扮位 / 配色 / 方案 / 应用', async () => {
  const { window, dom, calls, errors } = build()
  await new Promise((r) => setTimeout(r, 120))
  const d = window.document
  const $ = (id) => d.getElementById(id)

  assert.deepEqual(errors, [], '不该有运行时报错')
  assert.equal($('packList').children.length, 1, '形象包列表要有 1 项')
  assert.equal($('axes').querySelectorAll('.axis-label').length, 2, '两个装扮维度')
  assert.equal($('axes').querySelectorAll('.chip').length, 4, '2 维度 × 2 选项')
  assert.equal($('paletteSel').options.length, 2, '两套调色盘')
  assert.ok($('swatches').querySelectorAll('input[type="color"]').length >= 2, '色板要列出变量')
  assert.equal($('presets').querySelectorAll('.chip').length, 2, '两个方案（含自定义）')
  assert.equal($('stageEmpty').hidden, true, '有包时不显示空态')

  // 点第一个维度的第二个选项（贝雷帽）
  const hatChips = $('axes').querySelectorAll('.axis-label')[0].parentElement.querySelectorAll('.chip')
  hatChips[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  const last = calls.resolve[calls.resolve.length - 1]
  assert.equal(last.dress.axes.hat, 'beret', '点击部件要进 resolve 的参数')

  // 切换调色盘
  $('paletteSel').value = 'dark'
  $('paletteSel').dispatchEvent(new window.Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(calls.resolve[calls.resolve.length - 1].dress.palette, 'dark')

  // 方案：点「日常」应带出 hat=beret 与浅色盘，并把 console.accent 写进 --accent
  const presetChips = $('presets').querySelectorAll('.chip')
  presetChips[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(calls.resolve[calls.resolve.length - 1].dress.preset, 'daily')
  assert.equal(d.documentElement.style.getPropertyValue('--accent').trim(), '#123456', '方案自带主题色要生效')

  // 应用到桌宠
  $('btnApply').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(calls.apply.length, 1)
  assert.equal(calls.apply[0].pack, 'pack-a')
  assert.equal(calls.apply[0].axes.hat, 'beret')

  // 改色：内置盘不直接改，自动复制成自定义盘
  const colorInput = $('swatches').querySelector('input[type="color"]')
  colorInput.value = '#112233'
  colorInput.dispatchEvent(new window.Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(window.__savedPalette, '改内置配色要先落一个自定义盘')
  assert.match(window.__savedPalette.id, /^custom-/, '新盘 id 用 custom- 前缀')
  assert.equal(window.__savedPalette.vars.skin, '#112233', '改的颜色要写进自定义盘')

  // 渲染层用 setInterval 常驻画帧：不关掉 DOM，测试进程会一直不退出
  dom.window.close()
})
