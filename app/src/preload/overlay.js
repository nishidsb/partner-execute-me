'use strict'
const { contextBridge, ipcRenderer } = require('electron')
// 桌宠依赖持续自主上屏：渲染层层面再兜底关闭后台节流（rAF/timer/合成）
try {
  const { webFrame } = require('electron')
  if (webFrame && webFrame.setBackgroundThrottling) webFrame.setBackgroundThrottling(false)
} catch (e) { console.warn('[overlay preload] webFrame 节流关闭失败', e && e.message) }

/**
 * 桌面层 preload（v0.3.0 精简版）：
 * 只保留三层目标需要的通道——桌宠资产/交互、气泡 AI 对话（助手核心）、
 * 语音（TTS 反应语 + ASR 捕捉）、窗口控制。
 * 已移除：游戏卡片/游戏库/播放器/时钟/控制舱/launcher 相关通道。
 */
contextBridge.exposeInMainWorld('aura', {
  init: () => ipcRenderer.invoke('overlay:init'),
  // v0.3.38：弃用 setShape（裁剪视觉）。动态穿透：渲染层判断光标在热元素上时关穿透
  ignoreMouse: (on) => ipcRenderer.send('overlay:ignore-mouse', on),
  // 0.6.0 鼠标延迟修复：热区+像素掩码上报主进程，由主进程 80ms poll 判定穿透，
  // 基线不再 forward 全屏 mousemove（转发进渲染层是「鼠标发飘」的根源）
  setHotRects: (rects) => ipcRenderer.send('overlay:hot-rects', rects),
  // 角色层提层：光标靠近角色时立即排到置顶队首（不用等 8s 周期），
  // 否则 AuraDesk 卡片条这类同级置顶窗口会压住角色，重叠处拖不动
  raise: () => ipcRenderer.send('overlay:raise'),
  reportError: (kind, msg, stack) => ipcRenderer.send('overlay:renderer-error', kind, msg, stack),
  openSettings: () => ipcRenderer.send('overlay:open-settings'),
  openAssistant: () => ipcRenderer.send('overlay:open-assistant'),
  // v0.3.1：角色管理面板（伴侣窗口：Spine/VRM/语音资产导入、TTS、记忆）
  openCompanion: () => ipcRenderer.send('overlay:open-companion'),
  hide: () => ipcRenderer.send('overlay:hide'),
  quit: () => ipcRenderer.send('overlay:quit'),
  onConfig: (cb) => ipcRenderer.on('overlay:config', (_e, p) => cb(p)),
  // ---- 桌宠（overlay 内嵌渲染）：角色状态 + 资产加载 ----
  petState: () => ipcRenderer.invoke('pet:state'),
  assetUrl: (p) => ipcRenderer.invoke('companion:asset-url', p),
  assetData: (p) => ipcRenderer.invoke('companion:asset-data', p),
  onPetState: (cb) => ipcRenderer.on('pet:state', (_e, s) => cb(s)),
  // v0.4.2 主驱拖拽：渲染层只报开始（带当前锚点）/结束，位置由主进程 16ms 轮询光标驱动
  petDragStart: (anchor) => ipcRenderer.send('pet:drag-start', anchor),
  petDragEnd: (src) => ipcRenderer.send('pet:drag-end', src || ''),
  // S4/3.5：部位触摸上报（主进程按 2.5s 窗口合并后注入上下文）
  petTap: (part) => ipcRenderer.send('pet:tap-report', String(part || '')),
  // 0.33.0 自主动作上报：渲染层自播的长待机小彩蛋 → 让她「自己知道」刚做了什么
  petSelfAct: (kind) => ipcRenderer.send('pet:self-report', String(kind || '')),
  // v0.4.0 兼容残留（主驱后渲染层不再流式上报）
  petDragMove: (x, y) => ipcRenderer.send('pet:drag-move', x, y),
  onPetPos: (cb) => ipcRenderer.on('pet:pos', (_e, p) => cb(p)),
  petSnapshot: (tag) => ipcRenderer.invoke('pet:snapshot', tag),
  // S2：对话中/悬停中暂停自主走动
  petRoamHold: (on) => ipcRenderer.send('pet:roam-hold', !!on),
  // 5.5 悬停按钮：立刻溜达一段 / 隐藏角色 / 改外观配置 / 开装扮窗口
  petRoamNow: () => ipcRenderer.send('pet:roam-now'),
  petHide: () => ipcRenderer.invoke('pet:hide'),
  petCfgPatch: (patch) => ipcRenderer.invoke('companion:patch-settings', patch || {}),
  // 0.18.0 第一批：暂停/继续（右键菜单）+ 闹钟到点广播
  petSetPaused: (on) => ipcRenderer.invoke('pet:set-paused', !!on),
  onPetAlarm: (cb) => ipcRenderer.on('pet:alarm', (_e, d) => cb(d)),
  figureOpenDress: () => ipcRenderer.invoke('figure:open-dress'),
  logImage: (name, dataUrl) => ipcRenderer.invoke('companion:log-image', name, dataUrl),
  // ---- 桌宠增强：视觉跟踪光标 / 气泡聊天 / 语音捕捉 / 角色大小 ----
  onCursor: (cb) => ipcRenderer.on('overlay:cursor', (_e, p) => cb(p)),
  // 0.45.29 光标离开热区（主进程 poll 翻回穿透）：穿透窗口收不到 pointerleave，
  // 渲染层的悬停 UI（聊天输入条/右键菜单）必须靠这条通知收起
  onHotLost: (cb) => ipcRenderer.on('overlay:hot-lost', () => cb()),
  petSettings: () => ipcRenderer.invoke('companion:settings'),
  // 气泡聊天走助手核心（assistant:send），回复经 assistant:delta/done 回流到气泡
  petChatSend: (text) => ipcRenderer.invoke('assistant:send', text),
  // 聊天记录：桌宠面板显示最近对话（与助手聊天窗同源，都是会话历史）
  petHistory: () => ipcRenderer.invoke('assistant:history'),
  petClearHistory: () => ipcRenderer.invoke('assistant:clear-history'),
  // 聊天面板显示时让 overlay 窗口可聚焦（收键盘），隐藏时切回不可聚焦
  petChatFocus: (on) => ipcRenderer.invoke('pet:chat-focus', on),
  petChatStop: () => ipcRenderer.invoke('companion:stop'),
  petTranscribe: (b64, mime, pcmB64, via) => ipcRenderer.invoke('companion:transcribe', b64, mime, pcmB64, via),
  // 0.46.54 听觉：每秒一条声音特征摘要（响度/频段/起伏，几十字节数字，不是音频）
  hearSample: (f) => ipcRenderer.send('overlay:hear-sample', f),
  // 0.46.54 听觉开关状态（ hearOn=false 时渲染层不开听觉轻量流）
  hearState: () => ipcRenderer.invoke('companion:hear-state'),
  // 触摸反应语音：用当前 TTS 档位合成一句反应语（{ok,url,speed} 或 {fallback}）
  petSpeak: (text) => ipcRenderer.invoke('companion:tts', String(text || '').slice(0, 200)),
  // AI 回复朗读：整段回复合成（不做 200 字截断），未配 API TTS 时主进程回 {fallback:true} → 渲染层系统语音
  speakReply: (text) => ipcRenderer.invoke('companion:speak', String(text || '').slice(0, 800)),
  // 旧 companion 管线事件（ dormant：气泡聊天已改走助手核心，保留兼容）
  onPetDelta: (cb) => ipcRenderer.on('companion:delta', (_e, d) => cb(d)),
  onPetDone: (cb) => ipcRenderer.on('companion:done', (_e, d) => cb(d)),
  onPetError: (cb) => ipcRenderer.on('companion:error', (_e, d) => cb(d)),
  // 助手核心事件：气泡联动主通道
  onAssistantDelta: (cb) => ipcRenderer.on('assistant:delta', (_e, d) => cb(d)),
  onAssistantTool: (cb) => ipcRenderer.on('assistant:tool', (_e, d) => cb(d)),
  onAssistantDone: (cb) => ipcRenderer.on('assistant:done', (_e, d) => cb(d)),
  onAssistantError: (cb) => ipcRenderer.on('assistant:error', (_e, d) => cb(d)),
  // S2 桌宠行为：触摸语义（grab/drop/throw/crash）与自主走动状态
  onPetTouch: (cb) => ipcRenderer.on('pet:touch', (_e, d) => cb(d)),
  onPetWalk: (cb) => ipcRenderer.on('pet:walk', (_e, d) => cb(d)),
  // 0.29.0 卡片联动：坐/站（'sit' | 'stand'）
  onPetPose: (cb) => ipcRenderer.on('pet:pose', (_e, d) => cb(d)),
  // 5.7 窗台：拖拽悬在窗口顶边的提示 / 坐上后的状态
  onPetLedge: (cb) => ipcRenderer.on('pet:ledge', (_e, d) => cb(d)),
  onPetConfig: (cb) => ipcRenderer.on('pet:config', (_e, c) => cb(c)),
  // S3：模型控制桌宠（pet_say/pet_ask/pet_act/pet_quiet → pet:cmd）
  onPetCmd: (cb) => ipcRenderer.on('pet:cmd', (_e, d) => cb(d)),
  petAskAnswer: (payload) => ipcRenderer.send('pet:ask-answer', payload || {}),
  // 0.46.77 语音播完回传：voiceSettle（onended/onerror/被打断）触发时发给主进程，
  // 多句独白/自语靠它等「真播完」再接下一句（估时不准——没算 Fish 合成延迟）
  petVoiceDone: (payload) => ipcRenderer.send('pet:voice-done', payload || {}),
  // 0.18.0 第二批：把骨架里的动画名回报给主进程（设置页「动作」用）
  petAnimReport: (d) => ipcRenderer.send('pet:anim-report', d || {}),
  // 形象包（API 2）：主进程把 figure.json 解析成「图层 + 具体色值 + aura:// 贴图地址」
  figureResolve: (id, dress) => ipcRenderer.invoke('figure:resolve', id, dress)
})
