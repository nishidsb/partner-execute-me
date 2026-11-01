'use strict'
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('figureAPI', {
  state: () => ipcRenderer.invoke('figure:state'),
  list: () => ipcRenderer.invoke('figure:list'),
  importPack: (kind) => ipcRenderer.invoke('figure:import', kind),
  importPath: (p) => ipcRenderer.invoke('figure:import-path', p),
  remove: (id) => ipcRenderer.invoke('figure:remove', id),
  resolve: (id, dress) => ipcRenderer.invoke('figure:resolve', id, dress),
  defaultDress: (id) => ipcRenderer.invoke('figure:default-dress', id),
  // 配色 / 方案 / 自定义三项要写盘（主进程 saveXXXCustom），窗口里的「保存」按钮走这里
  savePalette: (packId, pal) => ipcRenderer.invoke('figure:save-palette', packId, pal),
  savePreset: (packId, preset) => ipcRenderer.invoke('figure:save-preset', packId, preset),
  delCustom: (packId, kind, cid) => ipcRenderer.invoke('figure:del-custom', packId, kind, cid),
  apply: (dress) => ipcRenderer.invoke('figure:apply', dress),
  clear: () => ipcRenderer.invoke('figure:clear'),
  openDress: () => ipcRenderer.invoke('figure:open-dress'),
  close: () => ipcRenderer.invoke('figure:close-dress'),
  min: () => ipcRenderer.invoke('figure:min-dress'),
  // 拖入文件 → 真实磁盘路径（Electron 32 起 File.path 已移除，必须走 webUtils）
  pathOf: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },
  onChanged: (cb) => ipcRenderer.on('figure:changed', (_e, st) => cb(st))
})
