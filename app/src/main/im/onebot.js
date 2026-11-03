/**
 * S11 群聊接入 · OneBot 11 客户端（正向 WebSocket，对接 NapCatQQ 等协议端）。
 * 参考 NapCatQQ 文档的 OneBot 11 标准：事件上行 + { action, params, echo } API 下行。
 * 只说标准协议，不碰任何逆向 —— 协议端（NapCatQQ）由用户自行安装登录。
 *
 * Node 22 全局 WebSocket（undici）不带自定义 header，access_token 走 URL query
 * （NapCatQQ 支持两种传法之一），这是本机部署最常见的姿势。
 */
const CRYPTO = require('crypto')

let seq = 0
const nextEcho = () => `im-${Date.now().toString(36)}-${++seq}`

/**
 * OneBot message「段」数组 → 人类可读纯文本（喂给 LLM 用）。
 * text 原样；at 段 → @昵称（自己 → @我）；图片/表情/其它 → 占位符。
 * 同时接受老式 CQ 码字符串（NapCat 兼容输出），粗拆即可，别较真。
 */
function segmentsToText (message, selfId = '') {
  if (typeof message === 'string') {
    return message
      .replace(/\[CQ:at,qq=(\d+)[^\]]*\]/g, (m, q) => (String(q) === String(selfId) ? '@我' : '@某人'))
      .replace(/\[CQ:[^\]]*\]/g, (m) => cqPlaceholder(m))
      .trim()
  }
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    switch (seg.type) {
      case 'text': parts.push(String(seg.data && seg.data.text || '')); break
      case 'at': parts.push(String(seg.data && seg.data.qq) === String(selfId) ? '@我' : '@某人'); break
      case 'image': parts.push('[图片]'); break
      case 'face': case 'mface': parts.push('[表情]'); break
      case 'record': parts.push('[语音]'); break
      case 'video': parts.push('[视频]'); break
      case 'reply': break // 引用关系在正文里通常已带文本，不重复占位
      case 'forward': parts.push('[合并转发]'); break
      case 'json': parts.push('[卡片]'); break
      case 'xml': parts.push('[卡片]'); break
      default: parts.push(cqPlaceholder(seg.type))
    }
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').trim()
}

function cqPlaceholder (cq) {
  if (/CQ:(image|flashimage)/i.test(cq)) return '[图片]'
  if (/CQ:(face|mface)/i.test(cq)) return '[表情]'
  if (/CQ:record/i.test(cq)) return '[语音]'
  if (/CQ:video/i.test(cq)) return '[视频]'
  if (/CQ:forward/i.test(cq)) return '[合并转发]'
  if (/CQ:(json|xml)/i.test(cq)) return '[卡片]'
  return ''
}

/**
 * 提取消息里的图片段（0.18.0 M1 视觉透传）：返回 [{ url, file }]。
 * url 可能缺（协议端不给直链）→ 只有 file 时由调用方走 get_image 换本地路径。
 * 段数组和老式 CQ 码字符串都认；flashimage（闪照）也算图。
 */
function imageSegmentsOf (message) {
  const out = []
  const push = (url, file) => {
    // CQ 码里的 & 会写成 &amp;，还原成真实 url
    const u = String(url || '').replace(/&amp;/g, '&')
    if (u || file) out.push({ url: u, file: String(file || '') })
  }
  if (typeof message === 'string') {
    const re = /\[CQ:(?:image|flashimage),([^\]]*)\]/g
    let m
    while ((m = re.exec(message))) {
      const kv = {}
      m[1].split(',').forEach((p) => {
        const i = p.indexOf('=')
        if (i > 0) kv[p.slice(0, i).trim()] = p.slice(i + 1).trim()
      })
      push(kv.url, kv.file)
    }
    return out
  }
  if (!Array.isArray(message)) return out
  for (const seg of message) {
    if (seg && (seg.type === 'image' || seg.type === 'flashimage') && seg.data) {
      push(seg.data.url, seg.data.file)
    }
  }
  return out
}

/** 这条消息是否 @ 了机器人（段数组或 CQ 码都认） */
function isAtMe (message, selfId) {
  if (!selfId) return false
  if (Array.isArray(message)) {
    return message.some((s) => s && s.type === 'at' && String(s.data && s.data.qq) === String(selfId))
  }
  return typeof message === 'string' && new RegExp(`\\[CQ:at,qq=${selfId}[\\],]`).test(message)
}

/**
 * 建一个 OneBot 11 正向 WS 客户端。
 * transport 可注入做测试（默认 Node 全局 WebSocket）。
 */
function createClient ({ url, token = '', onEvent, onStatus, transport } = {}) {
  let ws = null
  let closedByUs = false
  let reconnectTimer = null
  let attempts = 0
  const pending = new Map() // echo → { resolve, reject, timer }
  // 0.45.91：phase 必须落进 state —— 原来只塞进 onStatus 的回调参数，
  // 于是 client.status().phase 永远是 undefined，任何按「phase === 'ready'」判连上的调用方
  // （main.js 注入的 QQ 主动找人桥接）就永远认为断线，QQ 主动消息一发都发不出去。
  const state = { connected: false, selfId: 0, nickname: '', lastError: '', attempts: 0, phase: 'idle' }

  const notify = (s) => { state.phase = s; try { onStatus && onStatus({ ...state }) } catch { } }

  const rawSend = (obj) => {
    if (!ws || ws.readyState !== 1) throw new Error('WebSocket 未连接')
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj))
  }

  const handleMessage = async (raw) => {
    let data = null
    try { data = JSON.parse(String(raw)) } catch { return }
    // API 响应（带 echo）
    if (data.echo !== undefined && pending.has(data.echo)) {
      const p = pending.get(data.echo)
      pending.delete(data.echo)
      clearTimeout(p.timer)
      if (data.retcode === 0) p.resolve(data.data)
      else p.reject(new Error(`OneBot ${data.action || ''} retcode=${data.retcode}: ${data.msg || data.wording || ''}`))
      return
    }
    // 事件上行
    if (data.post_type) {
      if (data.post_type === 'meta_event' && data.meta_event_type === 'lifecycle' && data.sub_type === 'connect') {
        state.connected = true
        notify('connected')
      }
      try { onEvent && await onEvent(data) } catch (e) { state.lastError = e.message }
    }
  }

  const connect = () => new Promise((resolve) => {
    closedByUs = false
    let settled = false // 连接结果只落定一次：open=成功，close/error/超时=失败（否则调用方永远卡「连接中」）
    const settle = (ok) => { if (!settled) { settled = true; clearTimeout(guard); resolve(ok) } }
    // 握手兜底：对端既不 open 也不 close（防火墙静默丢包等）时 12s 必须给个答案
    const guard = setTimeout(() => { state.lastError = state.lastError || '连接超时'; try { ws && ws.close() } catch { }; settle(false) }, 12000)
    // 主进程的 Node（Electron 32 = Node 20）没有全局 WebSocket（真机踩过 ReferenceError）→
    // 测试注入 transport 优先，其次全局（Node 22+/渲染层），最后落到 ws 包
    const WS = transport || (typeof WebSocket !== 'undefined' ? WebSocket : require('ws'))
    if (!WS) { clearTimeout(guard); state.lastError = '环境没有 WebSocket'; resolve(false); return }
    let full = String(url || '')
    if (token) full += (full.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token)
    try { ws = new WS(full) } catch (e) { clearTimeout(guard); state.lastError = e.message; resolve(false); return }
    ws.onopen = async () => {
      attempts = 0
      state.attempts = 0
      state.lastError = ''
      notify('opened')
      try {
        const me = await call('get_login_info', {})
        state.selfId = Number(me && me.user_id) || 0
        state.nickname = String((me && me.nickname) || '')
        state.connected = true
        notify('ready')
      } catch (e) {
        // 拿不到自己账号也先算连上（有的端点限流），atMe 判定退化为纯文本匹配
        state.connected = true
        state.lastError = 'get_login_info 失败：' + e.message
        notify('ready')
      }
      settle(true)
    }
    ws.onmessage = (ev) => { Promise.resolve(handleMessage(ev.data)).catch(() => { }) }
    ws.onclose = () => {
      clearTimeout(guard)
      state.connected = false
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('连接已断开')) }
      pending.clear()
      notify('closed')
      if (!closedByUs) scheduleReconnect()
      settle(false) // 握手没完成就断（token 不对/端口没开）→ 明确告诉调用方失败
    }
    ws.onerror = () => { state.lastError = 'WebSocket 连接失败（地址不通或 token 不对）' }
  })

  function scheduleReconnect () {
    if (closedByUs || reconnectTimer) return
    const delay = Math.min(30000, 2000 * Math.pow(2, Math.min(attempts++, 4)))
    state.attempts = attempts
    notify('reconnecting')
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect().catch(() => { }) }, delay)
  }

  /** 调一个 OneBot action；未连接直接抛错（brain 侧自己兜） */
  function call (action, params = {}) {
    const echo = nextEcho()
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(echo)
        reject(new Error('OneBot 调用超时: ' + action))
      }, 15000)
      pending.set(echo, { resolve, reject, timer })
    })
    rawSend({ action, params, echo })
    return p
  }

  const disconnect = () => {
    closedByUs = true
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    try { ws && ws.close() } catch { }
    state.connected = false
    notify('closed')
  }

  return { connect, disconnect, call, status: () => ({ ...state }), _rawSend: rawSend, _handleMessage: handleMessage }
}

/** 短随机串（测试/日志用） */
const randId = () => CRYPTO.randomBytes(4).toString('hex')

module.exports = { createClient, segmentsToText, isAtMe, cqPlaceholder, imageSegmentsOf, randId }
