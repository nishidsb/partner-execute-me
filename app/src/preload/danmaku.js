'use strict'
/**
 * 弹幕窗口的桥（0.38.0）
 * 两个窗口（飘的弹幕 / 弹幕框）共用这一个 preload，只往下发，不往上收：
 * 主进程是唯一的说话来源，渲染层只负责画。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dk', {
  onLines: (cb) => ipcRenderer.on('dk:lines', (_e, v) => { try { cb(v) } catch { } }),
  onReplace: (cb) => ipcRenderer.on('dk:replace', (_e, v) => { try { cb(v) } catch { } }),
  onLock: (cb) => ipcRenderer.on('dk:lock', (_e, v) => { try { cb(v) } catch { } }),
  onConfig: (cb) => ipcRenderer.on('dk:config', (_e, v) => { try { cb(v) } catch { } })
})
