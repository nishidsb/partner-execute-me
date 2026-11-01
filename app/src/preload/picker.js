'use strict'
const { contextBridge, ipcRenderer } = require('electron')

/**
 * 框字幕选区层的 preload（0.34.0）
 * 只开三个口子：拿显示器信息 / 交回选区 / 取消。
 */
contextBridge.exposeInMainWorld('pickerAPI', {
  onInit: (fn) => ipcRenderer.on('picker:init', (_e, d) => fn(d)),
  done: (rect) => ipcRenderer.send('picker:done', rect),
  cancel: () => ipcRenderer.send('picker:cancel')
})
