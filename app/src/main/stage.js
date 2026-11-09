'use strict'
/**
 * 她的小屏幕（0.51.0，主人拍板「两者共存」）
 *
 * 主人拍板：活人感不能只靠对话体现——挂机/主人玩游戏时她要有自己看得见的
 * 活动（看B站、翻文件、写字），活动过程与思考全程可见，且绝不占用主人的
 * 鼠标键盘，两边同时进行。
 *
 * 形态：一块 380×300 的半透明小面板（「莱莎的小屏幕」），仿 danmaku 弹幕框：
 *   - focusable:false + 永真 setIgnoreMouseEvents(true) —— 鼠标键盘永远穿透，
 *     主人在打字在玩游戏它都不接输入，控制权 100% 在主人手里（硬保证，见测试）
 *   - alwaysOnTop screen-saver + visibleOnAllWorkspaces({visibleOnFullScreen:true})
 *     —— 全屏游戏里也浮着（弹幕层 0.38.0 真机验证过的参数）
 *   - 内容由主进程 stageRunner 推送（真实B站热门/真实文件/她真写的字），
 *     渲染层只负责画，跟弹幕层同款「主进程是唯一说话来源」
 *   - 永不 shell.openExternal、永不碰 cua —— 她的「打开文件/看B站」都在这块
 *     小屏幕里演，真实数据、零控制权
 *
 * 她的自语不在这里出——走 sayNarration（气泡+低音量+字幕+入账，一本账原则）；
 * 小屏幕底部只回显她刚说过的那句，方便主人边看活动边看话。
 */
const { BrowserWindow, screen } = require('electron')
const path = require('node:path')
const store = require('./store')
const { log } = require('./logger')

const W = 380
const H = 300

const state = {
  win: null,
  ready: false,
  on: false,
  pending: [],
  scene: null,
  lastLine: ''
}

function cfg () {
  const g = store.get()
  return (g.global && g.global.companion) || {}
}

function patch (p) {
  store.patchGlobal({ companion: { ...cfg(), ...p } })
}

function send (ch, payload) {
  if (state.win && !state.win.isDestroyed() && state.ready) {
    try { state.win.webContents.send(ch, payload); return true } catch { }
  }
  // 窗口还没加载完：先攒着，did-finish-load 之后补发（danmaku 同款，防开局第一帧丢失）
  state.pending.push([ch, payload])
  return false
}

function drain () {
  const win = state.win
  if (!win || win.isDestroyed() || !state.pending.length) return
  for (const [ch, payload] of state.pending.splice(0)) {
    try { win.webContents.send(ch, payload) } catch { }
  }
}

/** 默认位置：主屏右下、弹幕框上方那一片；cfg.petPos 有的话往它右侧贴（她坐在旁边看） */
function defaultPos () {
  const b = screen.getPrimaryDisplay().workArea
  const pet = cfg().petPos || {}
  if (Number.isFinite(pet.x) && Number.isFinite(pet.y)) {
    return {
      x: Math.min(Math.max(b.x, Math.round(pet.x) + 220), b.x + b.width - W - 12),
      y: Math.min(Math.max(b.y, Math.round(pet.y) - H + 80), b.y + b.height - H - 12)
    }
  }
  return { x: b.x + b.width - W - 24, y: b.y + b.height - H - 120 }
}

function create () {
  const pos = defaultPos()
  const win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: W,
    height: H,
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
    movable: false,
    focusable: false,          // 硬保证①：永远不抢焦点
    acceptFirstMouse: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/stage.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  state.win = win
  state.ready = false
  win.loadFile(path.join(__dirname, '../renderer/stage/index.html'))
  win.webContents.on('did-finish-load', () => {
    state.ready = true
    drain()
  })
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.showInactive()
    // 硬保证②：鼠标永真穿透——主人点它等于点它后面的东西，控制权一分不占
    win.setIgnoreMouseEvents(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch { }
    log('[stage] 她的小屏幕已上屏 ' + W + 'x' + H + ' @' + pos.x + ',' + pos.y)
  })
  win.on('closed', () => { state.win = null; state.ready = false })
  return win
}

function start () {
  if (cfg().stageOn === false) return { on: false, why: 'off' }
  if (state.on && state.win && !state.win.isDestroyed()) return { on: true, already: true }
  // 半开兜底（上次异常退出残留）：先收干净再建
  if (state.win && !state.win.isDestroyed()) { try { state.win.destroy() } catch { } }
  state.win = null
  state.ready = false
  try {
    create()
  } catch (e) {
    log('[stage] 建窗失败: ' + (e && e.message))
    return { on: false, error: (e && e.message) || '建窗失败' }
  }
  state.on = true
  if (state.scene) send('st:scene', state.scene)
  if (state.lastLine) send('st:line', state.lastLine)
  log('[stage] 开')
  return { on: true }
}

function stop (reason) {
  state.on = false
  state.pending.length = 0
  if (state.win && !state.win.isDestroyed()) { try { state.win.destroy() } catch { } }
  state.win = null
  state.ready = false
  log('[stage] 关 reason=' + (reason || 'manual'))
  return { on: false }
}

/* ---------------- 场景推送（stageRunner 调用） ---------------- */

/** 推一个场景骨架：{ kind:'bili'|'files'|'write'|'daze', title, items?, detail? } */
function scene (payload) {
  state.scene = payload || null
  return send('st:scene', payload)
}

/** 小屏幕顶栏的动作行（「正在打开B站热门…」）——这是屏幕 UI 不是她的话 */
function thinking (text) {
  return send('st:thinking', String(text || ''))
}

/** 写字场景逐字上屏 */
function appendText (t) {
  return send('st:append', String(t || ''))
}

/** files 场景打开某份文件的阅读视图：{ name, body } */
function fileView (payload) {
  return send('st:fileview', payload)
}

/** 她刚说的一句话回显在屏幕底部（她的自语本体走气泡/弹幕，这里只是回显） */
function line (text) {
  const t = String(text || '').trim()
  if (t) state.lastLine = t
  return send('st:line', t)
}

/** 淡出收场（场景结束保留最后画面，下一场覆盖——主人回头还能看到她刚才在干嘛） */
function done (text) {
  return send('st:done', String(text || ''))
}

function status () {
  return {
    on: state.on && !!(state.win && !state.win.isDestroyed()),
    enabled: cfg().stageOn !== false,
    scene: state.scene ? state.scene.kind : '',
    title: state.scene ? state.scene.title : ''
  }
}

/** 设置页开关 stageOn 变化：立即生效 */
function configure (p) {
  patch(p)
  if (cfg().stageOn === false) return stop('setting')
  return start()
}

module.exports = { start, stop, scene, thinking, appendText, fileView, line, done, status, configure }
