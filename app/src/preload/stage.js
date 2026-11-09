'use strict'
/**
 * 她的小屏幕的桥（0.51.0）
 * 主进程是唯一的说话来源，渲染层只负责画——只往下发，不往上收。
 * （小屏幕永真鼠标穿透，渲染层本来也收不到任何点击）
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('stg', {
  onScene: (cb) => ipcRenderer.on('st:scene', (_e, v) => { try { cb(v) } catch { } }),
  onThinking: (cb) => ipcRenderer.on('st:thinking', (_e, v) => { try { cb(v) } catch { } }),
  onAppend: (cb) => ipcRenderer.on('st:append', (_e, v) => { try { cb(v) } catch { } }),
  onFileView: (cb) => ipcRenderer.on('st:fileview', (_e, v) => { try { cb(v) } catch { } }),
  onLine: (cb) => ipcRenderer.on('st:line', (_e, v) => { try { cb(v) } catch { } }),
  onDone: (cb) => ipcRenderer.on('st:done', (_e, v) => { try { cb(v) } catch { } })
})
