const { contextBridge, ipcRenderer } = require('electron')

/**
 * 助手聊天窗 preload：assistant:* 命名空间，独立于 companion。
 * 事件：assistant:delta / assistant:tool / assistant:done / assistant:error
 */
contextBridge.exposeInMainWorld('assistantAPI', {
  send: (text, images) => ipcRenderer.invoke('assistant:send', text, images),
  state: () => ipcRenderer.invoke('assistant:state'),
  usage: (opts) => ipcRenderer.invoke('assistant:usage', opts),
  context: () => ipcRenderer.invoke('assistant:context'),
  switchRole: (id) => ipcRenderer.invoke('assistant:switch-role', id),
  saveRole: (def) => ipcRenderer.invoke('assistant:save-role', def),
  deleteRole: (id) => ipcRenderer.invoke('assistant:delete-role', id),
  history: () => ipcRenderer.invoke('assistant:history'),
  clearHistory: () => ipcRenderer.invoke('assistant:clear-history'),
  memoryList: (roleId) => ipcRenderer.invoke('assistant:memory-list', roleId),
  memoryAdd: (roleId, text) => ipcRenderer.invoke('assistant:memory-add', roleId, text),
  memoryRemove: (roleId, factId) => ipcRenderer.invoke('assistant:memory-remove', roleId, factId),
  memoryClear: (roleId) => ipcRenderer.invoke('assistant:memory-clear', roleId),
  providerGet: () => ipcRenderer.invoke('assistant:provider-get'),
  providerSet: (patch) => ipcRenderer.invoke('assistant:provider-set', patch),
  vendors: () => ipcRenderer.invoke('assistant:vendors'),
  extras: () => ipcRenderer.invoke('assistant:provider-extras'),
  // 0.45.37 动作测试面板：手动点播动作词（主进程转 petBridge pet_act）
  petAct: (words) => ipcRenderer.invoke('pet:test-act', words),
  // 1.3 ChatGPT 账号登录
  chatgptLogin: () => ipcRenderer.invoke('assistant:chatgpt-login'),
  chatgptLogout: () => ipcRenderer.invoke('assistant:chatgpt-logout'),
  chatgptStatus: () => ipcRenderer.invoke('assistant:chatgpt-status'),
  importCreds: () => ipcRenderer.invoke('assistant:import-creds'),
  // S6：电脑操作开关 / 风险确认 / 引擎自检
  cuaState: () => ipcRenderer.invoke('assistant:cua-state'),
  cuaSet: (patch) => ipcRenderer.invoke('assistant:cua-set', patch),
  cuaSelftest: () => ipcRenderer.invoke('assistant:cua-selftest'),
  onDelta: (fn) => ipcRenderer.on('assistant:delta', (_e, d) => fn(d)),
  onTool: (fn) => ipcRenderer.on('assistant:tool', (_e, d) => fn(d)),
  onDone: (fn) => ipcRenderer.on('assistant:done', (_e, d) => fn(d)),
  onError: (fn) => ipcRenderer.on('assistant:error', (_e, d) => fn(d)),
  // 工具 open_computer_panel：模型把「电脑」面板带路弹出来
  onOpenCuaPanel: (fn) => ipcRenderer.on('assistant:open-cua-panel', () => fn())
})
