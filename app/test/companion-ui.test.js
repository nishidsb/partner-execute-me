'use strict'
/**
 * 伴侣窗（renderer/companion）UI 回归：jsdom 跑真实 index.html + app.js，
 * 主进程 / 助手核心全部用假实现顶替。
 *
 * 存在意义：app.js 是「一个顶层脚本从头跑到底」，任何一层顶层抛错都会让
 * 后面的绑定（最小化 / 关闭 / tab / 初始化）全部不执行，表现就是
 * 「窗口出来了，但点哪儿都没反应」。0.5.1 就踩过这个坑：
 * 游戏模式那段残留了未定义的标识符 `C`，整页按钮全哑。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM, VirtualConsole } = require('jsdom')

const ROOT = path.join(__dirname, '..')

const CHAR = {
  id: 'c1',
  name: 'Aura',
  persona: '你是 Aura。',
  visual: { mode: 'still', image: '' },
  worldBook: []
}

/** 未知方法一律给个 async 空实现，避免测试因为某个新接口而脆断 */
function stub (overrides) {
  return new Proxy(overrides, {
    get (t, k) {
      if (k in t) return t[k]
      if (k === 'then') return undefined
      return async () => null
    }
  })
}

function build () {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/companion/index.html'), 'utf8')
    .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')

  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => errors.push(String(e.detail || e.message)))
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')))

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc })
  const { window } = dom

  const calls = { win: [], drawer: [] }

  window.companion = stub({
    init: async () => ({ characters: [CHAR], history: [], settings: { apiBaseUrl: 'http://127.0.0.1:1' } }),
    assetUrl: async () => '',
    figureResolve: async () => null,
    saveCharacter: async (c) => c,
    win: async (what) => { calls.win.push(what); return true },
    gameState: async () => ({ on: false, minutes: 0, scale: 0.7, corner: 'bottom-right', mute: true }),
    gameList: async () => [],
    settings: async () => ({ gameModeAuto: true, gameModeGreet: true }),
    gameConfig: async () => true,
    gameToggle: async () => ({ on: true }),
    // 列表类接口真机一定返回数组，桩里不能给 null，否则渲染层 .length 会炸
    memoryList: async () => [],
    memoryDel: async () => true,
    history: async () => []
  })

  window.assistantAPI = stub({
    state: async () => ({ currentRole: 'c1' }),
    history: async () => [],
    syncRole: async () => true,
    switchRole: async () => true,
    clearHistory: async () => true,
    partnerGet: async () => ({ ok: true, content: '# 关于你\n', history: [], dir: '/tmp/ws', git: true })
  })

  // jsdom 没有 2d/webgl 实现：给空上下文，渲染层只调 API 不看像素
  window.HTMLCanvasElement.prototype.getContext = function (kind) {
    if (kind && String(kind).startsWith('webgl')) return null
    const noop = () => {}
    return {
      clearRect: noop, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
      beginPath: noop, ellipse: noop, rect: noop, roundRect: noop, drawImage: noop, fillRect: noop,
      fill: noop, stroke: noop, clip: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1
    }
  }

  // S7：app.js 顶部就依赖 AuraI18n（界面多语言），先按真实加载顺序注入 i18n 与语言文件
  for (const f of [
    'src/renderer/shared/i18n.js',
    'src/renderer/shared/i18n/strings.zh.js',
    'src/renderer/shared/i18n/strings.zh-Hant.js',
    'src/renderer/shared/i18n/strings.en.js',
    'src/renderer/shared/i18n/strings.ja.js'
  ]) {
    window.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'))
  }
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/companion/app.js'), 'utf8')
  try {
    window.eval(src)
  } catch (e) {
    errors.push('顶层执行失败: ' + (e && e.stack ? e.stack.split('\n')[0] : e))
  }
  return { window, errors, calls, dom }
}

const tick = () => new Promise((r) => setTimeout(r, 30))

test('伴侣窗顶层脚本能跑完：按钮 / tab 全部绑上，点得动', async () => {
  const { window, errors, calls, dom } = build()
  const $ = (id) => window.document.getElementById(id)
  await tick()

  assert.deepEqual(errors, [], '顶层脚本不应抛错')

  // 0.5.1 的回归点：游戏模式块必须真的把监听挂上（曾经因为 `C` 未定义整页哑火）
  assert.equal(typeof $('gmToggle').onclick, 'function', '游戏模式按钮应已绑定')

  // 顶部 tab：聊天 → 角色
  $('tabChar').click()
  assert.equal($('charDrawer').hidden, false, '点「角色」应打开抽屉')
  assert.equal($('tabChar').classList.contains('on'), true)

  // 抽屉内五个分页逐个点一遍，不能抛错
  for (const t of ['persona', 'visual', 'memory', 'game', 'settings']) {
    const btn = [...$('drawerTabs').children].find((b) => b.dataset.t === t)
    assert.ok(btn, '缺少分页按钮 ' + t)
    btn.click()
    const panel = { persona: 'tabPersona', visual: 'tabVisual', memory: 'tabMemory', game: 'tabGame', settings: 'tabSettings' }[t]
    assert.equal($(panel).hidden, false, '分页未打开: ' + t)
  }
  await tick()

  // 「记忆」「模型」两个顶栏按钮 → 跳角色抽屉的对应分页
  $('btnMemory').click()
  assert.equal($('tabMemory').hidden, false, '点「记忆」应打开记忆分页')
  $('btnModel').click()
  assert.equal($('tabSettings').hidden, false, '点「模型」应打开设置分页')

  $('tabChat').click()
  assert.equal($('charDrawer').hidden, true)

  // 窗口控制：最小化 / 关闭 要走 IPC
  $('btnMin').click()
  $('btnClose').click()
  assert.deepEqual(calls.win, ['min', 'close'])

  assert.deepEqual(errors, [], '交互过程中不应有报错')
  dom.window.close()
})
