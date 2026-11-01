/**
 * World 扩展面板窗口的 preload：只暴露一个受控 invoke 通道。
 * 面板代码拿不到 Node/Electron；主进程按 e.sender 反查扩展 id，冒充不了别人。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('worldApi', {
  invoke: (fn, args) => ipcRenderer.invoke('world:invoke', fn, args)
})
