'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('companion', {
  init: () => ipcRenderer.invoke('companion:init'),
  send: (text) => ipcRenderer.invoke('companion:send', text),
  stop: () => ipcRenderer.invoke('companion:stop'),
  clearHistory: (id) => ipcRenderer.invoke('companion:clear-history', id),
  models: (baseUrl, apiKey) => ipcRenderer.invoke('companion:models', baseUrl, apiKey),
  settings: () => ipcRenderer.invoke('companion:settings'),
  // 0.45.14 今日互动统计
  interactStats: () => ipcRenderer.invoke('companion:interact-stats'),
  petAct: (words) => ipcRenderer.invoke('pet:test-act', words),
  petListActs: () => ipcRenderer.invoke('pet:list-acts'),
  patchSettings: (patch) => ipcRenderer.invoke('companion:patch-settings', patch),
  // 0.34.0 陪看字幕（OCR 读屏幕字幕 → 提示词）
  screenTextStatus: () => ipcRenderer.invoke('screentext:status'),
  screenTextStart: () => ipcRenderer.invoke('screentext:start'),
  screenTextStop: () => ipcRenderer.invoke('screentext:stop'),
  screenTextRect: (rect) => ipcRenderer.invoke('screentext:rect', rect),
  screenTextOnce: () => ipcRenderer.invoke('screentext:once'),
  screenTextPick: () => ipcRenderer.invoke('screentext:pick'),
  // 0.24.0 电脑画像（只读）：看状态 / 立即采 / 读某段 / 清空
  pcStatus: () => ipcRenderer.invoke('profile:status'),
  pcCollect: (opts) => ipcRenderer.invoke('profile:collect', opts),
  pcRead: (section) => ipcRenderer.invoke('profile:read', section),
  pcClear: () => ipcRenderer.invoke('profile:clear'),
  // 0.44.0 只清键盘/输入记录（不含画像档案）
  keysClear: () => ipcRenderer.invoke('keys:clear'),
  // 0.24.0 健康记录：记一条 / 看历史 / 看统计 / 清空
  healthLog: (entry) => ipcRenderer.invoke('health:log', entry),
  healthList: (days) => ipcRenderer.invoke('health:list', days),
  healthStats: (days) => ipcRenderer.invoke('health:stats', days),
  healthClear: () => ipcRenderer.invoke('health:clear'),
  setActive: (id) => ipcRenderer.invoke('companion:set-active', id),
  saveCharacter: (c) => ipcRenderer.invoke('companion:save-character', c),
  newCharacter: (name) => ipcRenderer.invoke('companion:new-character', name),
  delCharacter: (id) => ipcRenderer.invoke('companion:del-character', id),
  importAsset: (charId, kind) => ipcRenderer.invoke('companion:import-asset', charId, kind),
  assetUrl: (p) => ipcRenderer.invoke('companion:asset-url', p),
  assetData: (p) => ipcRenderer.invoke('companion:asset-data', p),
  logImage: (name, dataUrl) => ipcRenderer.invoke('companion:log-image', name, dataUrl),
  transcribe: (b64, mime) => ipcRenderer.invoke('companion:transcribe', b64, mime),
  tts: (text) => ipcRenderer.invoke('companion:tts', text),
  fishVoices: () => ipcRenderer.invoke('companion:fish-voices'),
  exportBackup: () => ipcRenderer.invoke('companion:export-backup'),
  importBackup: () => ipcRenderer.invoke('companion:import-backup'),
  win: (action) => ipcRenderer.invoke('companion:win', action),
  // 桌面角色
  petShow: () => ipcRenderer.invoke('pet:show'),
  petHide: () => ipcRenderer.invoke('pet:hide'),
  petWin: (action) => ipcRenderer.invoke('pet:win', action),
  // 长期记忆账本
  memoryList: () => ipcRenderer.invoke('companion:memory-list'),
  memoryDel: (seq) => ipcRenderer.invoke('companion:memory-del', seq),
  // S6.5 游戏：模式开关 / 库扫描导入 / 启动
  gameState: () => ipcRenderer.invoke('game:state'),
  gameToggle: (on) => ipcRenderer.invoke('game:toggle', on),
  gameScan: (which) => ipcRenderer.invoke('game:scan', which),
  gameImport: (source) => ipcRenderer.invoke('game:import', source),
  gameImportStartMenu: (ids) => ipcRenderer.invoke('game:import-startmenu', ids),
  gameAddFile: () => ipcRenderer.invoke('game:add-file'),
  gameLaunch: (id) => ipcRenderer.invoke('game:launch', id),
  gameRemove: (id) => ipcRenderer.invoke('game:remove', id),
  gameList: () => ipcRenderer.invoke('game:list'),
  gameConfig: (patch) => ipcRenderer.invoke('game:config', patch),
  // 0.38.0 游戏弹幕层：状态 / 手动开关 / 锁弹幕框 / 试一条
  dmStatus: () => ipcRenderer.invoke('dm:status'),
  dmToggle: (on) => ipcRenderer.invoke('dm:toggle', on),
  dmLock: (v) => ipcRenderer.invoke('dm:lock', v),
  dmTest: () => ipcRenderer.invoke('dm:test'),
  // S8 刷B站：值班轮（搜索/字幕/判断/报告/评论/扫码登录）
  biliStatus: () => ipcRenderer.invoke('bili:status'),
  biliConfig: (patch) => ipcRenderer.invoke('bili:config-patch', patch),
  // 0.39.0：只有 save 没有 get，设置页永远读不到已存的值（改一项 → 其它字段被默认值覆盖）
  biliConfigGet: () => ipcRenderer.invoke('bili:config-get'),
  biliRun: () => ipcRenderer.invoke('bili:run'),
  biliLoginStart: () => ipcRenderer.invoke('bili:login-start'),
  biliLoginPoll: (key) => ipcRenderer.invoke('bili:login-poll', key),
  biliWhoami: () => ipcRenderer.invoke('bili:whoami'),
  biliReport: (day) => ipcRenderer.invoke('bili:report', day),
  biliVerify: () => ipcRenderer.invoke('bili:verify'),
  biliAsrSetup: () => ipcRenderer.invoke('bili:asr-setup'),
  biliAsrStatus: () => ipcRenderer.invoke('bili:asr-status'),
  biliOpenDir: (what) => ipcRenderer.invoke('bili:open-dir', what),
  // S9-M4 自动收藏
  biliFavFolders: () => ipcRenderer.invoke('bili:fav-folders'),
  biliFavToday: () => ipcRenderer.invoke('bili:fav-today'),
  // S10 World 扩展体系
  worldList: () => ipcRenderer.invoke('world:list'),
  worldSetEnabled: (id, enabled) => ipcRenderer.invoke('world:set-enabled', { id, enabled }),
  worldUninstall: (id) => ipcRenderer.invoke('world:uninstall', { id }),
  worldInstallZip: () => ipcRenderer.invoke('world:install-zip'),
  worldInstallUrl: (url) => ipcRenderer.invoke('world:install-url', { url }),
  worldMarket: (url) => ipcRenderer.invoke('world:market', { url }),
  worldConfig: (id, patch) => ipcRenderer.invoke('world:config', { id, patch }),
  worldOpenPanel: (id) => ipcRenderer.invoke('world:open-panel', { id }),
  // S11 群聊接入（OneBot 11 / NapCatQQ）
  imStatus: () => ipcRenderer.invoke('im:status'),
  imConfig: (patch) => ipcRenderer.invoke('im:config-patch', patch),
  imConnect: () => ipcRenderer.invoke('im:connect'),
  imDisconnect: () => ipcRenderer.invoke('im:disconnect'),
  imListRoles: () => ipcRenderer.invoke('im:list-roles'),
  imClearHistory: () => ipcRenderer.invoke('im:clear-history'),
  imSendTest: (args) => ipcRenderer.invoke('im:send-test', args),
  imListChats: () => ipcRenderer.invoke('im:list-chats'),
  // 0.18.0 屏幕监控陪伴
  watchStatus: () => ipcRenderer.invoke('watch:status'),
  watchPatch: (patch) => ipcRenderer.invoke('watch:patch', patch),
  // 0.22.0 补丁⑥：AuraDesk 残留设置窗口删除，真功能迁入这里——
  // 她的记录（日记/负反馈）、快捷键/OBS/数据目录（这些存的还是全局配置，
  // 所以走 settings:patch-global 既有通道，不用新增一套）
  mindSnapshot: () => ipcRenderer.invoke('mind:snapshot'),
  mindWriteNow: () => ipcRenderer.invoke('mind:write-now'),
  mindDistillNow: () => ipcRenderer.invoke('mind:distill-now'),
  mindFeedback: () => ipcRenderer.invoke('mind:feedback'),
  mindCuriosity: () => ipcRenderer.invoke('mind:curiosity'),
  mindFeedbackReset: () => ipcRenderer.invoke('mind:feedback-reset'),
  mindFeedbackRollback: (hours) => ipcRenderer.invoke('mind:feedback-rollback', hours),
  mindRecall: (q, k) => ipcRenderer.invoke('mind:recall', q, k),
  // 0.39.0 学习模式：主进程一直有这三条通道，preload 却从没暴露 → 设置页只能填时长，
  // 没有任何地方能开始（只能靠托盘菜单或跟她说「陪我学习」）。审计第 ④ 类扫出来的。
  studyStart: () => ipcRenderer.invoke('study:start'),
  studyStop: () => ipcRenderer.invoke('study:stop'),
  studyStatus: () => ipcRenderer.invoke('study:status'),
  // 第 1 期：做梦 + 审查队列
  dreamNow: () => ipcRenderer.invoke('mind:dream-now'),
  dreamStatus: () => ipcRenderer.invoke('mind:dream-status'),
  // 0.45.2 自主活动：状态 + 测试跑
  autonomyStatus: () => ipcRenderer.invoke('autonomy:status'),
  autonomyRunNow: () => ipcRenderer.invoke('autonomy:run-now'),
  reviewList: () => ipcRenderer.invoke('mind:review-list'),
  reviewDecide: (id, action) => ipcRenderer.invoke('mind:review-decide', id, action),
  reviewRollback: (id) => ipcRenderer.invoke('mind:review-rollback', id),
  // 第 3 期：她的工具（面板批准部署/停用/删除）
  utList: () => ipcRenderer.invoke('mind:ut-list'),
  utDecide: (name, action) => ipcRenderer.invoke('mind:ut-decide', name, action),
  patchGlobal: (patch) => ipcRenderer.invoke('settings:patch-global', patch),
  globalConfig: () => ipcRenderer.invoke('app:global-config'),
  displays: () => ipcRenderer.invoke('app:displays'),
  dataDirInfo: () => ipcRenderer.invoke('datadir:info'),
  dataDirOpen: () => ipcRenderer.invoke('datadir:open'),
  dataDirPick: () => ipcRenderer.invoke('datadir:pick'),
  obsStatus: () => ipcRenderer.invoke('obs:status'),
  obsOpen: () => ipcRenderer.invoke('obs:open'),
  // 0.18.0 第一批：闹钟 + 暂停
  alarmList: () => ipcRenderer.invoke('companion:alarm-list'),
  alarmAdd: (a) => ipcRenderer.invoke('companion:alarm-add', a),
  alarmDel: (id) => ipcRenderer.invoke('companion:alarm-del', id),
  alarmToggle: (id, on) => ipcRenderer.invoke('companion:alarm-toggle', id, on),
  petSetPaused: (on) => ipcRenderer.invoke('pet:set-paused', on),
  // S11-M2 微信 UI 自动化
  wxStatus: () => ipcRenderer.invoke('wx:status'),
  wxConfig: (patch) => ipcRenderer.invoke('wx:config-patch', patch),
  wxProbe: () => ipcRenderer.invoke('wx:probe'),
  // 形象包（API 2）：装扮窗口 / 导入 / 解析
  figureState: () => ipcRenderer.invoke('figure:state'),
  figureResolve: (id, dress) => ipcRenderer.invoke('figure:resolve', id, dress),
  figureImport: (kind) => ipcRenderer.invoke('figure:import', kind),
  figureOpen: () => ipcRenderer.invoke('figure:open-dress'),
  figureClear: () => ipcRenderer.invoke('figure:clear'),
  onFigureChanged: (cb) => ipcRenderer.on('figure:changed', (_e, st) => cb(st)),
  onDelta: (cb) => ipcRenderer.on('companion:delta', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('companion:done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('companion:error', (_e, d) => cb(d)),
  // 主窗视图切换（聊天 / 角色）：主进程决定打开哪个视图
  onView: (cb) => ipcRenderer.on('companion:view', (_e, v) => cb(v)),
  // 托盘/桌宠切换了角色：主窗要跟着换显示的角色
  onCharSwitched: (cb) => ipcRenderer.on('companion:char-switched', (_e, c) => cb(c))
})

/**
 * 助手核心通道：主窗口的聊天走这里（与桌宠气泡/托盘同一套会话与角色）。
 * 之前这个窗挂着一套旧的 companion 聊天（后端已随 AI 移除而删除），
 * 同时另有一个 assistant 聊天窗 → 两个窗都能"聊天"但互不相通，改为单一通道。
 */
contextBridge.exposeInMainWorld('assistantAPI', {
  send: (text, images) => ipcRenderer.invoke('assistant:send', text, images),
  state: () => ipcRenderer.invoke('assistant:state'),
  // 0.18.0 第一批：上下文占用（对话页圆环）
  context: () => ipcRenderer.invoke('assistant:context'),
  switchRole: (id) => ipcRenderer.invoke('assistant:switch-role', id),
  saveRole: (def) => ipcRenderer.invoke('assistant:save-role', def),
  syncRole: (def) => ipcRenderer.invoke('assistant:sync-role', def),
  deleteRole: (id) => ipcRenderer.invoke('assistant:delete-role', id),
  history: () => ipcRenderer.invoke('assistant:history'),
  clearHistory: () => ipcRenderer.invoke('assistant:clear-history'),
  memoryList: (roleId) => ipcRenderer.invoke('assistant:memory-list', roleId),
  memoryAdd: (roleId, text) => ipcRenderer.invoke('assistant:memory-add', roleId, text),
  memoryRemove: (roleId, factId) => ipcRenderer.invoke('assistant:memory-remove', roleId, factId),
  memoryClear: (roleId) => ipcRenderer.invoke('assistant:memory-clear', roleId),
  // S4：记忆工作区（PARTNER.md 查看/编辑 + Git 历史回滚）
  partnerGet: () => ipcRenderer.invoke('assistant:partner-get'),
  partnerSave: (text) => ipcRenderer.invoke('assistant:partner-save', text),
  partnerShow: (hash) => ipcRenderer.invoke('assistant:partner-show', hash),
  partnerRevert: (hash) => ipcRenderer.invoke('assistant:partner-revert', hash),
  providerGet: () => ipcRenderer.invoke('assistant:provider-get'),
  providerSet: (patch) => ipcRenderer.invoke('assistant:provider-set', patch),
  providerExtras: () => ipcRenderer.invoke('assistant:provider-extras'),
  // 0.18.0 第二批：系统提示词预览（只读）
  previewSystem: (roleId) => ipcRenderer.invoke('assistant:preview-system', roleId),
  // 0.18.0 第二批：Spine 动作清单 / 预览播放
  animList: () => ipcRenderer.invoke('pet:anim-list'),
  animPlay: (name) => ipcRenderer.invoke('pet:anim-play', name),
  // 0.18.0 第二批：联网搜索后端配置（web_search）
  webGet: () => ipcRenderer.invoke('assistant:web-get'),
  webSet: (patch) => ipcRenderer.invoke('assistant:web-set', patch),
  vendors: () => ipcRenderer.invoke('assistant:vendors'),
  // 1.3 ChatGPT 账号登录（设置页模型子页）
  chatgptLogin: () => ipcRenderer.invoke('assistant:chatgpt-login'),
  chatgptLogout: () => ipcRenderer.invoke('assistant:chatgpt-logout'),
  chatgptStatus: () => ipcRenderer.invoke('assistant:chatgpt-status'),
  usage: (opts) => ipcRenderer.invoke('assistant:usage', opts),
  autostartGet: () => ipcRenderer.invoke('assistant:autostart-get'),
  autostartSet: (on) => ipcRenderer.invoke('assistant:autostart-set', on),
  onDelta: (fn) => ipcRenderer.on('assistant:delta', (_e, d) => fn(d)),
  onTool: (fn) => ipcRenderer.on('assistant:tool', (_e, d) => fn(d)),
  onDone: (fn) => ipcRenderer.on('assistant:done', (_e, d) => fn(d)),
  onError: (fn) => ipcRenderer.on('assistant:error', (_e, d) => fn(d))
})
