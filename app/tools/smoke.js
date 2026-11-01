/**
 * 覆盖层冒烟测试（jsdom）——v0.3.0 精简版
 * 跑真实 app.js，验证精简后的桌面层：
 *   1) 遗留 UI（游戏库/播放器/时钟/控制舱/桌面坞）确已移除
 *   2) 桌宠舞台 + 气泡 + 输入条结构完整
 *   3) 缩放/壁纸渲染入口生效
 *   4) 热区动态穿透命中切换链路正常
 */
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM, VirtualConsole } = require('jsdom')

const root = path.resolve(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'src/renderer/overlay/index.html'), 'utf8')
  .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
  // 只保留 app.js：pet.js 依赖 spine 运行时（jsdom 无 WebGL），单独有桌面验证
  .replace(/<script src="\.\.\/companion\/libs.js"><\/script>/, '')
  .replace(/<script src="pet.js"><\/script>/, '')

const errors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail || e.message)))
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')))

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc })
const { window } = dom

let fail = 0
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  → ' + extra : ''))
  if (!ok) fail++
}

window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 300, bottom: 10, width: 300, height: 10, x: 0, y: 0 }
}

const calls = []
const hotCalls = [] // setHotRects 独立收集：calls 会在各分段前被清空，而热区上报有去重、清空后不会重发
window.aura = {
  init: async () => ({ cfg: { ui: { scale: 1 }, wallpaper: { type: 'desktop', dim: 0.06 } } }),
  ignoreMouse: (on) => calls.push(['ignoreMouse', !!on]),
  setHotRects: (rects) => { calls.push(['setHotRects', rects]); hotCalls.push(['setHotRects', rects]) },
  rendererError: (kind, msg) => calls.push(['rerr', kind, msg]),
  openSettings: () => calls.push(['settings']),
  openAssistant: () => calls.push(['assistant']),
  hide: () => calls.push(['hide']),
  quit: () => calls.push(['quit']),
  petState: async () => ({ visible: false }),
  petSettings: async () => ({}),
  onConfig: () => {},
  onCursor: () => {},
  onPetState: () => {},
  onPetConfig: () => {}
}

try {
  window.eval(fs.readFileSync(path.join(root, 'src/renderer/overlay/app.js'), 'utf8'))
} catch (err) {
  errors.push('app.js 执行失败: ' + err.stack)
}

setTimeout(async () => {
  const d = window.document

  console.log('--- 遗留功能确已移除 ---')
  for (const id of ['dock', 'library', 'player', 'ctrl', 'clockbox', 'ctlbox', 'lyrics', 'ctx', 'rails', 'gridL', 'gridR']) {
    check('已移除 #' + id, d.getElementById(id) === null)
  }

  console.log('\n--- 桌宠结构完整 ---')
  check('桌宠舞台存在', !!d.getElementById('petStage'))
  check('立绘/Spine/VRM/Fallback 四种渲染位齐全',
    !!d.getElementById('petStill') && !!d.getElementById('petSpineCanvas') &&
    !!d.getElementById('petVrmCanvas') && !!d.getElementById('petFallback'))
  check('回复气泡存在', !!d.getElementById('petBubble'))
  check('悬停输入条存在', !!d.getElementById('petChat') && !!d.getElementById('petChatInput'))
  check('输入条带麦克风与发送按钮', !!d.getElementById('petMic') && !!d.getElementById('petSendBtn'))
  check('提示条存在', !!d.getElementById('toast'))

  console.log('\n--- 渲染入口 ---')
  check('缩放变量已写入', /[\d.]+/.test(d.documentElement.style.getPropertyValue('--ui')))
  check('壁纸模式标记', d.body.dataset.wall === 'desktop')
  check('压暗变量已写入', /0\.06/.test(d.documentElement.style.getPropertyValue('--dim') || ''))
  check('启动无报错', !calls.some((c) => c[0] === 'rerr'), JSON.stringify(calls.filter((c) => c[0] === 'rerr')))

  console.log('\n--- 热区动态穿透（0.6.0：上报主进程，poll 判定；渲染层不再自己切 forward） ---')
  calls.length = 0
  d.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 150, clientY: 5, bubbles: true }))
  check('热区+掩码已上报主进程（setHotRects）', hotCalls.some((c) => Array.isArray(c[1]) && c[1].length >= 1), JSON.stringify(hotCalls.map((c) => c[0])))
  check('渲染层不再直呼 ignoreMouse（穿透切换归主进程 poll）', !calls.some((c) => c[0] === 'ignoreMouse'), JSON.stringify(calls.filter((c) => c[0] === 'ignoreMouse')))
  const reported = (hotCalls.find((c) => Array.isArray(c[1]) && c[1].length) || [])[1] || []
  check('上报的 rect 带坐标尺寸', reported.length >= 1 && reported.every((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && r.width >= 2), JSON.stringify(reported).slice(0, 120))
  const hotEls = [...d.querySelectorAll('[data-hot]')].filter((el) => !el.closest('[hidden]'))
  check('存在可见热区元素（桌宠舞台+输入条）', hotEls.length >= 1, hotEls.length)

  console.log('\n报错 :', errors.length ? '\n  ' + errors.join('\n  ') : '无')
  console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
  process.exit(fail || errors.length ? 1 : 0)
}, 600)
