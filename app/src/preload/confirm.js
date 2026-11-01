const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('confirmAPI', {
  onPayload: (fn) => ipcRenderer.on('cua-confirm:payload', (_e, d) => fn(d)),
  answer: (ans) => ipcRenderer.invoke('cua-confirm:answer', ans),
  close: () => window.close()
})
