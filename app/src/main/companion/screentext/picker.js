'use strict'
/**
 * 框字幕的选区层（0.34.0）
 *
 * 每块显示器盖一层全屏透明窗，拖动出一个矩形，松手就把 **DIP 坐标** 交回去。
 * 为什么不用 Python 那边 tkinter 的遮罩（鱼搭子那样）：Electron 本来就能开透明全屏窗，
 * 而且 DIP 坐标直接就是 screen.getDisplay* 那套口径 —— 少一层换算少一个坑。
 */
const path = require('node:path')
const { BrowserWindow, screen, ipcMain } = require('electron')

const ROOT = path.join(__dirname, '..', '..', '..', '..')
const PAGE = path.join(ROOT, 'src', 'renderer', 'picker', 'index.html')
const PRELOAD = path.join(ROOT, 'src', 'preload', 'picker.js')

let open = null

/**
 * @param {(rect:{x:number,y:number,w:number,h:number}|null) => void} onDone
 */
function pick (onDone) {
  if (open) { try { onDone(null) } catch { } return }
  const wins = []
  const finish = (rect) => {
    const cb = open
    open = null
    try { ipcMain.removeListener('picker:done', onDoneHandler) } catch { }
    try { ipcMain.removeListener('picker:cancel', onCancelHandler) } catch { }
    for (const w of wins) { try { if (!w.isDestroyed()) w.destroy() } catch { } }
    if (cb) { try { cb(rect) } catch { } }
  }
  const onDoneHandler = (_e, rect) => {
    const r = rect || null
    if (!r) return finish(null)
    const w = Math.round(Number(r.w) || 0)
    const h = Math.round(Number(r.h) || 0)
    if (w < 40 || h < 12) return finish(null)
    finish({ x: Math.round(Number(r.x) || 0), y: Math.round(Number(r.y) || 0), w, h })
  }
  const onCancelHandler = () => finish(null)

  open = onDone
  for (const d of screen.getAllDisplays()) {
    const win = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    wins.push(win)
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch { }
    win.setMenuBarVisibility(false)
    win.loadFile(PAGE)
    win.webContents.on('did-finish-load', () => {
      try {
        win.webContents.send('picker:init', {
          display: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height },
          scale: d.scaleFactor || 1
        })
      } catch { }
    })
    win.on('closed', () => { if (open) finish(null) })
  }
  ipcMain.on('picker:done', onDoneHandler)
  ipcMain.on('picker:cancel', onCancelHandler)
  if (wins[0]) wins[0].focus()
}

const isOpen = () => !!open

module.exports = { pick, isOpen }
