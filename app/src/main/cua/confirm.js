/**
 * 电脑操作确认窗（规格 4.2 的「允许 / 30 分钟内都允许 / 拒绝」+ 60 秒超时）
 *
 * 为什么不用系统 dialog：
 *   1. showMessageBoxSync 会阻塞整个主进程（模型在那里 await，界面也卡住）
 *   2. 系统对话框没法在超时后自己关掉 —— 人不在电脑前就会一直挂着
 * 自绘一个小窗，倒计时到点自动当「拒绝」处理并关掉，界面始终可操作。
 *
 * 同时只显示一个：后到的请求排队，避免模型连着调三个工具时弹出三个窗。
 */
'use strict'
const path = require('path')
const { BrowserWindow, ipcMain, screen } = require('electron')
const { log } = require('../logger')

const TIMEOUT_MS = 60000

let win = null
let loaded = false // 页面是否已 loadFile 完成（没完成就 send 会丢）
let current = null // { resolve, timer, payload }
const queue = []

function finish (index, remember) {
  if (!current) return
  const { resolve, timer } = current
  clearTimeout(timer)
  current = null
  try {
    resolve({ index, remember: !!remember, timeout: index < 0 })
  } catch {}
  try { if (win && !win.isDestroyed()) win.hide() } catch {}
  setTimeout(pump, 60)
}

function pump () {
  if (current || !queue.length) return
  const job = queue.shift()
  const payload = job.payload
  current = { resolve: job.resolve, timer: null, payload }
  ensureWindow()
  const timer = setTimeout(() => {
    log('[cua:confirm] 60 秒没人应答 → 视为拒绝')
    finish(-1, false)
  }, Number(payload.timeoutMs) || TIMEOUT_MS)
  current.timer = timer
  try {
    const w = win
    w.setSize(payload.width || 440, payload.height || 280)
    centerOnCursorScreen(w)
    w.setAlwaysOnTop(true, 'screen-saver')
    w.show()
    w.focus()
    // 首次弹出时页面可能还没加载完（loadFile 是异步的），
    // 这时 send 会丢 → did-finish-load 里再补发一次（current 还在就重发）
    if (loaded) w.webContents.send('cua-confirm:payload', payload)
  } catch (e) {
    log('[cua:confirm] 显示确认窗失败:', e.message)
    finish(-1, false)
  }
}

function centerOnCursorScreen (w) {
  try {
    const { screen: electronScreen } = require('electron')
    const pt = electronScreen.getCursorScreenPoint()
    const d = electronScreen.getDisplayNearestPoint(pt)
    const [cw, ch] = w.getSize()
    w.setPosition(
      Math.round(d.workArea.x + (d.workArea.width - cw) / 2),
      Math.round(d.workArea.y + (d.workArea.height - ch) / 2)
    )
  } catch {}
}

function ensureWindow () {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 440,
    height: 280,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#1b1e26',
    title: '电脑操作确认',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/confirm.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(__dirname, '../../renderer/confirm/index.html'))
  loaded = false
  win.webContents.on('did-finish-load', () => {
    loaded = true
    // 页面加载完成后补发一次当前请求（首次弹出时那次 send 通常已经丢了）
    if (current) {
      try { win.webContents.send('cua-confirm:payload', current.payload) } catch {}
    }
  })
  win.on('closed', () => { win = null; loaded = false })
  // 用户直接关窗 = 拒绝
  win.on('close', (e) => {
    if (current) {
      e.preventDefault()
      finish(-1, false)
    }
  })
  return win
}

let ipcReady = false
function registerIpc () {
  if (ipcReady) return
  ipcReady = true
  ipcMain.handle('cua-confirm:answer', (_e, ans) => {
    const a = ans || {}
    log('[cua:confirm] 用户选择 index=' + a.index + (a.remember ? '（记住）' : ''))
    finish(Number(a.index), a.remember)
    return { ok: true }
  })
}

/**
 * @param {object} o
 * @param {string} o.message   主标题，例如「角色想在你桌上点一下鼠标」
 * @param {string} o.detail    细节（工具参数等）
 * @param {string[]} o.buttons 按钮文字，最后一个视为「拒绝」
 * @param {string} o.rememberLabel 可选：额外复选框文字（「以后这个程序都不问」）
 * @param {string} o.image     可选：dataURL 截图。给了就在窗里显示（让用户自己当眼睛，
 *                             规格上很重要：模型不能读图时，只能靠人看一眼再放行）
 * @param {number} o.timeoutMs 超时（默认 60 秒）
 * @returns {Promise<{index:number, remember:boolean, timeout:boolean}>}
 *          index = -1 表示超时或关窗
 */
function ask (o = {}) {
  registerIpc()
  const hasImage = typeof o.image === 'string' && o.image.startsWith('data:image/')
  return new Promise((resolve) => {
    queue.push({
      resolve,
      payload: {
        message: String(o.message || '角色想操作你的电脑'),
        detail: String(o.detail || '').slice(0, 1200),
        buttons: Array.isArray(o.buttons) && o.buttons.length ? o.buttons.slice(0, 4) : ['允许', '拒绝'],
        rememberLabel: o.rememberLabel || '',
        // 哪个按钮带「记住」语义（例如「30 分钟内都允许」）
        rememberIndex: Number.isFinite(Number(o.rememberIndex)) ? Number(o.rememberIndex) : -1,
        icon: o.icon === 'warning' ? 'warning' : 'question',
        // 带图时窗口默认放大：图要能看清，不然「看得见再放行」就没意义
        image: hasImage ? o.image : '',
        timeoutMs: Number(o.timeoutMs) || TIMEOUT_MS,
        width: o.width || (hasImage ? 640 : 440),
        height: o.height || (hasImage ? 660 : 280)
      }
    })
    pump()
  })
}

function destroy () {
  try { if (win && !win.isDestroyed()) win.destroy() } catch {}
  win = null
  if (current) { clearTimeout(current.timer); current = null }
  queue.length = 0
}

module.exports = { ask, destroy, TIMEOUT_MS }
