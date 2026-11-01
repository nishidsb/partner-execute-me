'use strict'
/**
 * 游戏弹幕层（0.38.0，对齐 dsh-fish-buddy 的「打游戏」那半边）
 *
 * 打游戏时角色缩在角落喊话，气泡要么太小要么挡画面，所以要有两样东西：
 *   1. 飘的弹幕层：整屏透明、永远穿透鼠标，她的话从右往左横着飞过去
 *   2. 弹幕框：角落一块半透明小面板，攒着最近几句（可拖、可锁）
 *
 * 设计取舍（与参考项目一致的地方 / 不一样的地方）：
 *   - 弹幕只走主屏（跨屏会两边各一半，看着像鬼影）
 *   - 弹幕层永远不进鼠标事件（true click-through），所以「锁」只对弹幕框有意义
 *   - 弹幕框锁上 = 真穿透（连悬停都不接），解锁要靠组合键或设置页按钮——
 *     锁着的时候鼠标穿透过去了，框上根本点不到
 *   - 一条=一句（断句见 danmaku-split.js），不按字数硬切整段话
 *
 * 只在游戏模式里自动开；也可以在设置页手动开关（调试用）。
 */
const { BrowserWindow, screen, globalShortcut } = require('electron')
const path = require('node:path')
const store = require('./store')
const { log } = require('./logger')
const { splitLines } = require('./danmaku-split')

const HOTKEY_EXIT = 'Alt+G'
const HOTKEY_LOCK = 'Alt+H'
const BOX_W = 360
const BOX_H = 250

const state = {
  on: false,
  reason: '',
  fly: null,
  box: null,
  flyReady: false,
  boxReady: false,
  locked: true,
  pending: { fly: [], box: [] },
  hotkeys: [],
  lastLines: [],
  saveTimer: null
}

function cfg () {
  const g = store.get()
  return (g.global && g.global.companion) || {}
}

function patch (p) {
  store.patchGlobal({ companion: { ...cfg(), ...p } })
}

function send (which, ch, payload) {
  const win = state[which]
  const ready = which === 'fly' ? state.flyReady : state.boxReady
  if (win && !win.isDestroyed() && ready) {
    try { win.webContents.send(ch, payload); return true } catch { }
  }
  // 窗口还没加载完：先攒着，did-finish-load 之后补发（否则开局第一句一定丢）
  if (which === 'fly' || which === 'box') state.pending[which].push([ch, payload])
  return false
}

function drain (which) {
  const q = state.pending[which]
  const win = state[which]
  if (!win || win.isDestroyed() || !q.length) return
  for (const [ch, payload] of q.splice(0)) {
    try { win.webContents.send(ch, payload) } catch { }
  }
}

function windowCfg (extra) {
  return {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/danmaku.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    },
    ...extra
  }
}

function createFly () {
  const b = screen.getPrimaryDisplay().bounds
  const win = new BrowserWindow(windowCfg({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    movable: false,
    focusable: false,
    acceptFirstMouse: false
  }))
  state.fly = win
  state.flyReady = false
  win.loadFile(path.join(__dirname, '../renderer/danmaku/fly.html'))
  win.webContents.on('did-finish-load', () => {
    state.flyReady = true
    const c = cfg()
    send('fly', 'dk:config', { fontSize: Number(c.danmakuFontSize) || 30, speed: Number(c.danmakuSpeed) || 1 })
    drain('fly')
  })
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.showInactive()
    // 弹幕层永远不吃鼠标：打游戏时鼠标一秒都不能被抢
    win.setIgnoreMouseEvents(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch { }
    log('[danmaku] 弹幕层已上屏 ' + b.width + 'x' + b.height)
  })
  win.on('closed', () => { state.fly = null; state.flyReady = false })
  return win
}

function createBox () {
  const b = screen.getPrimaryDisplay().bounds
  const saved = cfg().danmakuBox || {}
  const x = Number.isFinite(saved.x) ? Math.round(saved.x) : b.x + 24
  const y = Number.isFinite(saved.y) ? Math.round(saved.y) : b.y + b.height - BOX_H - 40
  const win = new BrowserWindow(windowCfg({
    x,
    y,
    width: BOX_W,
    height: BOX_H,
    movable: true,
    focusable: true,
    acceptFirstMouse: true
  }))
  state.box = win
  state.boxReady = false
  state.locked = cfg().danmakuLock !== false
  win.loadFile(path.join(__dirname, '../renderer/danmaku/box.html'))
  win.webContents.on('did-finish-load', () => {
    state.boxReady = true
    send('box', 'dk:lock', state.locked)
    drain('box')
  })
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
    if (state.locked) win.setIgnoreMouseEvents(true)
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch { }
  })
  win.on('moved', () => {
    clearTimeout(state.saveTimer)
    state.saveTimer = setTimeout(() => {
      if (!state.box || state.box.isDestroyed()) return
      const [bx, by] = state.box.getPosition()
      patch({ danmakuBox: { x: bx, y: by } })
    }, 400)
  })
  win.on('closed', () => { state.box = null; state.boxReady = false })
  return win
}

function registerHotkeys () {
  unregisterHotkeys()
  const want = [[HOTKEY_EXIT, exitByHotkey], [HOTKEY_LOCK, toggleLock]]
  for (const [key, fn] of want) {
    try {
      if (globalShortcut.isRegistered(key)) continue
      if (globalShortcut.register(key, fn)) state.hotkeys.push(key)
      else log('[danmaku] 组合键被占用：' + key)
    } catch (e) { log('[danmaku] 注册组合键失败 ' + key + ': ' + (e && e.message)) }
  }
  if (state.hotkeys.length) log('[danmaku] 组合键：' + state.hotkeys.join(' / ') + '（退出游戏模式 / 锁弹幕框）')
}

function unregisterHotkeys () {
  for (const k of state.hotkeys.splice(0)) {
    try { globalShortcut.unregister(k) } catch { }
  }
}

function exitByHotkey () {
  try { require('./gameMode').toggle(false, 'hotkey') } catch (e) { log('[danmaku] 组合键退出失败: ' + (e && e.message)) }
}

function toggleLock () {
  setLock(!state.locked)
  log('[danmaku] 弹幕框 ' + (state.locked ? '锁上（鼠标穿透）' : '解锁（可拖动）'))
}

function setLock (v) {
  state.locked = !!v
  patch({ danmakuLock: state.locked })
  if (state.box && !state.box.isDestroyed()) {
    try { state.box.setIgnoreMouseEvents(state.locked) } catch { }
  }
  send('box', 'dk:lock', state.locked)
  return state.locked
}

/** 她说一句：按句切开，飘的弹幕和弹幕框各收一份 */
function say (text) {
  const c = cfg()
  const lines = splitLines(text, { max: 44 })
  if (!lines.length) return 0
  state.lastLines = lines
  send('fly', 'dk:lines', lines)
  send('box', 'dk:lines', lines)
  return lines.length
}

/** 译文补丁（主动台词先按原语言说出、再换成字幕）：改掉最近一条的显示文字 */
function replaceLast (text) {
  const t = String(text || '').trim()
  if (!t) return false
  send('fly', 'dk:replace', t)
  send('box', 'dk:replace', t)
  return true
}

function start (reason) {
  if (state.on) {
    // 已经开着（例如设置页刚「试一条」）：只更新理由，别把窗口重建一遍
    if (reason) state.reason = reason
    return { on: true, already: true }
  }
  // 半开状态兜底（上次异常退出留下的窗口）：先收干净再建
  for (const k of ['fly', 'box']) {
    const w = state[k]
    state[k] = null
    if (k === 'fly') state.flyReady = false
    else state.boxReady = false
    if (w && !w.isDestroyed()) { try { w.destroy() } catch { } }
  }
  try {
    createFly()
    createBox()
  } catch (e) {
    log('[danmaku] 建窗口失败: ' + (e && e.message))
    stop('build-failed')
    return { on: false, error: (e && e.message) || '建窗口失败' }
  }
  state.on = true
  state.reason = reason || 'manual'
  registerHotkeys()
  log('[danmaku] 开 reason=' + state.reason)
  return { on: true }
}

function stop (reason) {
  if (!state.on && !state.fly && !state.box) return { on: false, already: true }
  state.on = false
  state.reason = ''
  unregisterHotkeys()
  clearTimeout(state.saveTimer)
  for (const k of ['fly', 'box']) {
    const w = state[k]
    state[k] = null
    if (k === 'fly') state.flyReady = false
    else state.boxReady = false
    if (w && !w.isDestroyed()) { try { w.destroy() } catch { } }
  }
  state.pending.fly.length = 0
  state.pending.box.length = 0
  log('[danmaku] 关 reason=' + (reason || 'manual'))
  return { on: false }
}

function toggle (on, reason) {
  const want = on == null ? !state.on : !!on
  return want ? start(reason) : stop(reason)
}

function status () {
  const c = cfg()
  return {
    on: state.on,
    reason: state.reason,
    // 窗口没建过时按配置报：否则重启后设置页会显示「锁着」而实际配置是解锁
    locked: state.box ? state.locked : c.danmakuLock !== false,
    lines: state.lastLines.length,
    fontSize: Number(c.danmakuFontSize) || 30,
    speed: Number(c.danmakuSpeed) || 1,
    enabled: c.danmakuOn !== false,
    hotkeys: state.hotkeys.slice()
  }
}

/** 设置页改字号/速度：窗口开着就立刻生效 */
function config (p) {
  patch(p)
  const c = cfg()
  const payload = { fontSize: Number(c.danmakuFontSize) || 30, speed: Number(c.danmakuSpeed) || 1 }
  send('fly', 'dk:config', payload)
  return payload
}

function test () {
  const wasOn = state.on
  if (!wasOn) start('test')
  const sample = cfg().danmakuTestText || '弹幕是这么飘过去的，看清楚了。一条就是一句！'
  say(sample)
  if (!wasOn) {
    // 只是试一条：9 秒后自己关掉，别留在桌面上。
    // 但如果这中间进了游戏模式（游戏模式会调用 start('game') 把 reason 改掉），
    // 就绝不能关——否则打游戏打到一半弹幕层忽然消失，人会以为程序崩了。
    setTimeout(() => {
      let gaming = false
      try { gaming = require('./gameMode').isActive() } catch { }
      if (state.on && state.reason === 'test' && !gaming) stop('test-done')
    }, 9000)
  }
  return { ok: true, lines: splitLines(sample).length }
}

module.exports = {
  start,
  stop,
  toggle,
  say,
  replaceLast,
  setLock,
  toggleLock,
  status,
  config,
  test,
  isOn: () => state.on,
  HOTKEY_EXIT,
  HOTKEY_LOCK
}
