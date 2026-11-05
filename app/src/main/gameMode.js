'use strict'
/**
 * 游戏模式（S6.5）
 *
 * 打游戏时角色浮在游戏画面之上会挡视线，所以要有一套「陪我玩但不碍事」的模式：
 *  - 缩到屏幕角落（大小可配；0.45.83 起角落可选「不固定」= 原地只缩放不搬家，
 *    角色本来就在副屏的用户不必被拽到主屏游戏右下角）
 *  - 0.46.47 默认不接管摆放：gameModeScale 未配置 = 保持原大小不缩（角色放副屏
 *    不挡视线的用户不该被强制缩小）；要缩的人显式配 gameModeScale（clamp 0.4~1.3）
 *  - 挪窝时走平滑滑动（pet.glideTo），不再一帧瞬移
 *  - 停掉自主走动（setQuiet），不来回溜达
 *  - 0.46.47 默认不静音：gameModeMute 默认 false（气泡/弹幕照常、TTS 照念），
 *    安静令只在显式 gameModeMute=true 时下发；要静音的人在设置里勾
 *  - 记住进入前的位置/大小，退出时原样恢复（corner=none 时没动过就不恢复）
 *
 * 进入途径：角色自己调 game_mode 工具 / 帮她启动游戏（launch_game 自动进）/
 * 托盘菜单手动切 / 设置页按钮。退出：同上任一处再关一次，或 2 小时自动结束。
 */
const store = require('./store')
const { log } = require('./logger')

let bcastFn = null
let active = false
let saved = null // { pos, scale }
let startedAt = 0
let accMs = 0     // 0.45.73 这一场（可能跨多次进出）已经累计玩的时间
let sessionName = ''
let enteredBy = ''
let autoTimer = null
const MAX_MS = 2 * 60 * 60 * 1000
const HISTORY_MAX = 30

let stateCb = null
let memCb = null

function attach ({ bcast } = {}) {
  bcastFn = typeof bcast === 'function' ? bcast : null
}

/** 主进程注入：进入/退出后刷新托盘勾选状态 */
function setStateListener (fn) { stateCb = typeof fn === 'function' ? fn : null }

/** 0.45.76 注入：进出游戏模式都同步给本体记忆（companion.noteGameSession）。
 *  用户 11-01：进入游戏/学习模式后，模式里的事不能退出就忘——
 *  gameHistory 以前只写给设置页看，她自己根本看不见，等于玩一场忘一场。 */
function setMemoryListener (fn) { memCb = typeof fn === 'function' ? fn : null }

function notifyMem (info) {
  try { if (memCb) memCb(info) } catch (e) { log('[gameMode] 记忆同步失败:', e && e.message) }
}

function notifyState () {
  try { if (stateCb) stateCb(active) } catch {}
}

function bcast (ch, data) {
  try { if (bcastFn) bcastFn(ch, data) } catch (e) { log('[gameMode] 广播失败:', e && e.message) }
}

function cfg () {
  const g = store.get()
  return (g.global && g.global.companion) || {}
}

function patch (p) {
  store.patchGlobal({ companion: { ...cfg(), ...p } })
}

function cornerPoint (corner, base) {
  const { screen } = require('electron')
  const anchor = (base && isFinite(base.x) && isFinite(base.y))
    ? base
    : (screen.getCursorScreenPoint ? screen.getCursorScreenPoint() : { x: 0, y: 0 })
  const d = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) })
  const b = d.workArea
  switch (String(corner)) {
    case 'bottom-left': return { x: b.x + 80, y: b.y + b.height - 6 }
    case 'top-right': return { x: b.x + b.width - 80, y: b.y + 150 }
    case 'top-left': return { x: b.x + 80, y: b.y + 150 }
    default: return { x: b.x + b.width - 80, y: b.y + b.height - 6 } // bottom-right
  }
}

function pushHistory (entry) {
  const list = Array.isArray(cfg().gameHistory) ? cfg().gameHistory.slice() : []
  list.push(entry)
  patch({ gameHistory: list.slice(-HISTORY_MAX) })
}

/** 这一场在玩什么（游戏名，auto 进来时由 gameAuto 传入；手动/托盘就没有） */
function sessionLabel () { return sessionName || '' }

/**
 * 进入游戏模式。
 * @param reason 来源（manual / auto:ffxiv / launch_game …）
 * @param opt { resume:true } = 0.45.73「又回到同一款游戏」：接着上一场计时，
 *            不重播开场白、不重置「玩了多久」。切屏刷视频回来不再从 0 开始。
 */
function enter (reason, opt) {
  const c = cfg()
  const resume = !!(opt && opt.resume) && accMs > 0
  if (c.gameMode === false) return { on: false, reason: '游戏模式在设置里被关掉了（角色 → 设置 → 游戏）' }
  if (active) {
    return { on: true, already: true, minutes: Math.round((accMs + (Date.now() - startedAt)) / 60000) }
  }
  const pet = require('./companion/pet')
  if (typeof pet.isDragging === 'function' && pet.isDragging()) {
    return { on: false, reason: '你正在拖动角色，松手后再开游戏模式' }
  }
  const prevPos = pet.getPos ? pet.getPos() : null
  const corner = c.gameModeCorner || 'bottom-right'
  // 0.45.83 corner='none'：不挪窝（角色本来就在副屏，进出只缩放不搬家）；
  // 其余角启用平滑滑动（glideTo），滑动失败兜底瞬移。
  saved = { pos: prevPos, scale: c.petScale != null ? Number(c.petScale) : 1, moved: corner !== 'none' }
  active = true
  startedAt = Date.now() - (resume ? accMs : 0)
  if (!resume) { accMs = 0; sessionName = '' }
  // 0.45.76 游戏名跟随进入来源：自动进入带真名（ffxiv/原神…），手动进就留空
  const oName = String((opt && opt.name) || '').trim()
  if (oName) sessionName = oName
  enteredBy = reason || 'manual'
  // 0.46.20 修：Number(undefined)=NaN 但 NaN != null 为 true → 配置缺省时 scale 直接变 NaN
  //（真机 16:17 进入日志 `scale=NaN` 实锤）。Number.isFinite 才认。
  // 0.46.47 默认不缩：未配置 gameModeScale = 保持进入前大小（副屏用户不被强制 0.7），
  // 显式配置才 clamp（0.4~1.2）。
  const scaleRaw = Number(c.gameModeScale)
  const scale = Number.isFinite(scaleRaw)
    ? Math.max(0.4, Math.min(1.3, scaleRaw))
    : (saved && Number.isFinite(saved.scale) ? saved.scale : 1)
  const mute = c.gameModeMute === true // 0.46.47 默认不静音（原默认 true 强加给副屏用户）
  if (corner !== 'none') {
    const target = cornerPoint(corner, prevPos)
    const glided = typeof pet.glideTo === 'function' ? pet.glideTo(target, { ms: 700 }) : false
    if (!glided) { try { pet.placeAt(target) } catch (e) { log('[gameMode] 挪位置失败:', e.message) } }
  }
  try { pet.setQuiet(true) } catch {}
  bcast('pet:config', { scale, gameMode: true })
  if (mute) {
    saved.muted = true
    bcast('pet:cmd', { kind: 'quiet', on: true })
  }
  // 0.38.0 游戏弹幕层：进游戏模式就把「飘的弹幕 + 弹幕框」拉起来，
  // 她的话改从弹幕走（气泡在工作娱乐里够用，打游戏时挡视线）
  if (c.danmakuOn !== false) {
    try { require('./danmaku').start('game') } catch (e) { log('[gameMode] 弹幕层启动失败:', e && e.message) }
  }
  if (c.gameModeGreet !== false && !resume) {
    // 走 petBridge 而不是直接 bcast：这样开场白也会进弹幕（直接 bcast 只到气泡）
    try {
      const r = require('./petBridge').invoke('pet_say', {
        script: String(c.gameModeGreetText || '那我到角落待着，玩得开心～'),
        speech: !mute
      })
      if (r && typeof r.catch === 'function') r.catch((e) => log('[gameMode] 开场白失败:', e && e.message))
    } catch (e) { log('[gameMode] 开场白失败:', e && e.message) }
  }
  clearTimeout(autoTimer)
  autoTimer = setTimeout(() => { exit('timeout') }, Math.max(60 * 1000, MAX_MS - accMs))
  log('[gameMode] 进入 reason=' + enteredBy + ' scale=' + scale + ' mute=' + mute +
    (sessionName ? ' game=' + sessionName : '') +
    (resume ? ' · 续上一场（已 ' + Math.round(accMs / 60000) + ' 分钟）' : ''))
  if (!resume) notifyMem({ ev: 'enter', name: sessionName, by: enteredBy })
  notifyState()
  return { on: true, scale, corner: c.gameModeCorner || 'bottom-right', mute, minutes: Math.round((accMs + (Date.now() - startedAt)) / 60000) }
}

function exit (reason, opt) {
  if (!active) return { on: false, already: true }
  active = false
  clearTimeout(autoTimer)
  autoTimer = null
  const c = cfg()
  const pet = require('./companion/pet')
  // 0.45.83 只恢复真的挪过窝的（corner=none 进来的本来就没动过位置，
  // 退出再「恢复」反而会把她拽回进模式前的老地方）
  if (saved && saved.moved && saved.pos) {
    const target = saved.pos
    const glided = typeof pet.glideTo === 'function' ? pet.glideTo(target, { ms: 700 }) : false
    if (!glided) { try { pet.placeAt(target) } catch (e) { log('[gameMode] 恢复位置失败:', e.message) } }
  }
  try { pet.setQuiet(false) } catch {}
  // 0.38.0：先收弹幕层，再让「玩了多久」那句回到气泡上（否则它会掉进已经关掉的弹幕框）
  try { require('./danmaku').stop('game-exit') } catch {}
  bcast('pet:config', { scale: saved && saved.scale != null ? saved.scale : (c.petScale != null ? c.petScale : 1), gameMode: false })
  // 0.46.47 只在进入时真的下过安静令才解除（没静音进场时别把别处的安静状态顺手清了）
  if (saved && saved.muted) bcast('pet:cmd', { kind: 'quiet', on: false })
  // 0.45.73 累计：切出去过一次再回来，这一场的总时长接着算，不是从 0 开始
  accMs += Math.max(0, Date.now() - startedAt)
  const minutes = Math.max(0, Math.round(accMs / 60000))
  pushHistory({ at: Date.now(), minutes, by: enteredBy, reason: reason || 'manual', name: sessionName })
  notifyMem({ ev: 'exit', minutes, name: sessionName, by: enteredBy, reason: reason || 'manual' })
  if (minutes >= 5 && c.gameModeGreet !== false && !(opt && opt.quiet)) {
    bcast('pet:cmd', {
      kind: 'say',
      text: '玩了 ' + (minutes >= 60 ? Math.round(minutes / 60) + ' 个多小时' : minutes + ' 分钟') + '，起来伸个懒腰吧',
      speak: c.gameModeMute !== true
    })
  }
  log('[gameMode] 退出 reason=' + (reason || 'manual') + ' 时长=' + minutes + ' 分钟')
  notifyState()
  saved = null
  return { on: false, minutes }
}

function toggle (on, reason) {
  const want = on == null ? !active : !!on
  return want ? enter(reason || 'manual') : exit(reason || 'manual')
}

function state () {
  const c = cfg()
  return {
    on: active,
    since: active ? startedAt : 0,
    minutes: active ? Math.round((accMs + (Date.now() - startedAt)) / 60000) : Math.round(accMs / 60000),
    by: enteredBy,
    name: sessionName,
    scale: c.gameModeScale != null ? c.gameModeScale : (c.petScale != null ? c.petScale : 1),
    corner: c.gameModeCorner || 'bottom-right',
    mute: c.gameModeMute === true,
    enabled: c.gameMode !== false,
    history: Array.isArray(c.gameHistory) ? c.gameHistory.slice(-10) : []
  }
}

/** 0.45.73：这一场（可能中途切出去过）已经累计多少毫秒 —— 供 gameAuto 判断「续场」 */
function sessionMs () { return accMs + (active ? Math.max(0, Date.now() - startedAt) : 0) }

module.exports = {
  attach, setStateListener, setMemoryListener, enter, exit, toggle, state, sessionMs, sessionLabel,
  isActive: () => active, cornerPoint
}
