/**
 * S11 群聊接入：OneBot 11 客户端（NapCatQQ 协议端由用户安装）+ 群聊大脑 + IPC。
 * 微信侧 M2 另行接入（个人微信无官方接口，方案待定：iPad 协议付费 / UI 自动化）。
 */
const fs = require('fs')
const path = require('path')
const { ipcMain } = require('electron')
const { createClient } = require('./onebot')
const { createBrain } = require('./brain')
const { createWx } = require('./wx')

let home = null
let outerLog = () => { }
let client = null
let brain = null
let wxMod = null
let ctx = null // assistant 模块注入 { getContext, getProvider }

function maskToken (t) {
  const s = String(t || '')
  return s ? s.slice(0, 3) + '***' : ''
}

/** 未绑定角色槽时记忆落到当前桌面角色（懒加载，测试环境无 Electron 不受影响） */
function currentCharId () {
  try { return require('../companion/character').get().id } catch { return null }
}

function init ({ dataRoot, log, assistant }) {
  home = path.join(dataRoot, 'im')
  fs.mkdirSync(home, { recursive: true })
  outerLog = log || outerLog
  ctx = assistant

  // 灰机wiki 走 Electron net.fetch（Chromium TLS 指纹，绕开对 Node fetch 的 Cloudflare 拦截）
  try {
    const { net } = require('electron')
    if (net && net.fetch) require('../ff14').setWikiFetch((url, opts) => net.fetch(url, opts))
  } catch { }

  brain = createBrain({
    home,
    getProvider: () => ctx.getProvider(),
    // 人设上下文：generate 内部按平台选好 roleId 再传过来（QQ/微信各是各的人设）
    // 0.18.0 M8：带上本轮用户发言做查询，把长期记忆账本的召回拼进 ctx.memoryText
    getContext: (roleId, query) => {
      const c = ctx.getContext(roleId) || {}
      try {
        const a = ctx
        const id = roleId || currentCharId()
        const mem = a.memoryRecallText ? a.memoryRecallText(id, query || '', 5) : ''
        if (mem) c.memoryText = mem
      } catch { }
      // 0.18.0 M8 修正：自设（用户资料）跟角色卡走——按本轮 roleId 取该卡的自设，全局只兜底
      try {
        if (!c.userProfile) c.userProfile = require('../companion').userProfileText(id).replace(/^用户资料：/, '')
      } catch { }
      return c
    },
    // 0.18.0 M8：自设（用户资料）注入 IM 提示词
    getUserProfile: () => {
      try { return require('../companion').userProfileText().replace(/^用户资料：/, '') } catch { return '' }
    },
    // 0.18.0 M8：每轮完整回复后写长期记忆账本（ roleId 为空 = 当前桌面角色）
    // 0.45.99 只记主人：meta.isOwner === false（群友 / 白名单里别人的号）→ 不入长期记忆。
    // 她照样回话，只是「别人的话」不会被当成发生过的事实记下来。
    onMemoryTurn: (roleId, userText, reply, meta) => {
      try {
        if (meta && meta.isOwner === false) return
        const a = ctx
        if (a && typeof a.memoryExtract === 'function') a.memoryExtract(roleId || currentCharId(), userText, reply)
      } catch { }
    },
    // 0.18.0 M1：图片透传需要调 OneBot API（get_image）；client 此时还没建，闭包读最新值
    callApi: (action, params) => {
      if (!client) return Promise.reject(new Error('还没连接'))
      return client.call(action, params)
    },
    // 0.18.0 M2：QQ 语音（复用桌宠角色的 TTS 设置）与表情包发送；懒加载伴侣模块，测试环境无 Electron 不受影响
    synthVoice: async (text, roleId) => {
      try { return require('../companion').imSynthesize(text, roleId) } catch (e) { return { ok: false, reason: 'unavailable', error: e.message } }
    },
    sendMedia: async (ev, segments) => {
      if (!client) throw new Error('还没连接')
      if (ev.message_type === 'group') await client.call('send_group_msg', { group_id: ev.group_id, message: segments })
      else await client.call('send_private_msg', { user_id: ev.user_id, message: segments })
    },
    // 0.18.0 M10：主人 pc_screenshot 工具的截屏（懒加载 cua，测试环境无 Electron 不受影响）
    shootPc: async () => {
      try {
        const { screen } = require('electron')
        const cua = require('../cua')
        const b = screen.getPrimaryDisplay().bounds
        return await cua._shoot({ x: b.x, y: b.y, w: b.width, h: b.height, maxW: 1280, maxH: 1280, tag: 'im-pc' }, false)
      } catch { return null }
    },
    send: async (ev, text) => {
      if (!client) throw new Error('还没连接')
      if (ev.message_type === 'group') await client.call('send_group_msg', { group_id: ev.group_id, message: [{ type: 'text', data: { text } }] })
      else await client.call('send_private_msg', { user_id: ev.user_id, message: [{ type: 'text', data: { text } }] })
    },
    // 0.45.12 主人在 QQ 上开口 → 桌面侧同步（清黏人计时/在场判定）。只认主人名单，见 brain.permOf
    onOwnerMessage: (text) => {
      try { require('../companion').onUserSpoke(String(text || '')) } catch { }
    },
    // 0.45.23 QQ 与本体同一本账：主人私聊用本体聊天史当上下文，往来回写本体
    getOwnerHistory: () => {
      try { return require('../companion').desktopHistoryTail(24) } catch { return null }
    },
    onOwnerExchange: (userText, reply) => {
      try { require('../companion').qqNote({ user: String(userText || ''), assistant: String(reply || '') }) } catch { }
    },
    log: (m) => outerLog(m)
  })

  const cfg = brain.loadCfg()
  // 0.45.27 QQ 场合说明进主账本 sys：告诉她「你在 QQ 上有号、带（QQ）标注的往来就是 QQ 上发生的」。
  // 追加式（addWorldPrompts），不跟 world 扩展抢 setWorldPrompts 的单槽；每轮现取，配置改了即时生效。
  try { require('../assistant').addWorldPrompts(() => require('./brain').qqWorldBlock(brain.loadCfg())) } catch { }
  // 0.45.21 NapCat 自动守护：连不上时她自己去拉协议端（detached，一次配置扫码后零操作）
  let napcat = null
  try {
    napcat = require('./napcat-guard').create({ getCfg: () => brain.loadCfg(), log: (m) => outerLog(m) })
  } catch { }
  const guardNapcat = () => { try { napcat && napcat.ensureSpawned() } catch { } }
  client = createClient({
    url: cfg.wsUrl,
    token: cfg.token,
    onEvent: (ev) => brain.handleEvent(ev),
    onStatus: (s) => { if (s.phase === 'ready') outerLog(`[im] OneBot 已连接 self=${s.selfId}(${s.nickname})`) }
  })
  if (cfg.enabled) {
    // 开机自连；失败会走指数退避重连（0.45.21 起失败时顺手拉 NapCat，重连就能接上）
    client.connect().then((ok) => {
      if (!ok) {
        outerLog('[im] OneBot 首连失败：' + client.status().lastError)
        guardNapcat()
      }
    })
    // 0.45.21 周期守护：断着就每 5 分钟检查一次该不该拉 NapCat
    const guardTimer = setInterval(() => {
      try { if (client && client.status() && !client.status().connected) guardNapcat() } catch { }
    }, 5 * 60 * 1000)
    if (guardTimer.unref) guardTimer.unref()
  }

  ipcMain.handle('im:status', () => ({
    ...brain.status(),
    conn: client ? client.status() : null,
    tokenMasked: maskToken(brain.status().config.token)
  }))
  ipcMain.handle('im:config-patch', (_e, patch) => {
    const prev = brain.loadCfg()
    const next = brain.saveCfg(patch || {})
    const needReconnect = client && (
      next.wsUrl !== prev.wsUrl || next.token !== prev.token ||
      (next.enabled !== prev.enabled)
    )
    if (needReconnect) {
      if (next.enabled) {
        client.disconnect()
        client = createClient({ url: next.wsUrl, token: next.token, onEvent: (ev) => brain.handleEvent(ev) })
        client.connect().then((ok) => {
          if (!ok) {
            outerLog('[im] 重连失败：' + client.status().lastError)
            guardNapcat()
          }
        })
      } else client.disconnect()
    }
    return { ok: true, config: { ...next, token: maskToken(next.token) } }
  })
  ipcMain.handle('im:connect', async () => {
    const c = brain.loadCfg()
    if (client) client.disconnect()
    client = createClient({
      url: c.wsUrl, token: c.token,
      onEvent: (ev) => brain.handleEvent(ev),
      onStatus: (s) => { if (s.phase === 'ready') outerLog(`[im] OneBot 已连接 self=${s.selfId}(${s.nickname})`) }
    })
    const ok = await client.connect()
    return { ok, status: client.status(), error: ok ? '' : client.status().lastError }
  })
  ipcMain.handle('im:disconnect', () => { if (client) client.disconnect(); return { ok: true } })
  ipcMain.handle('im:clear-history', () => {
    try { fs.rmSync(path.join(home, 'history.json'), { force: true }) } catch { }
    // 内存历史也清（brain 的 _history 是引用，逐 key 删）
    for (const k of Object.keys(brain._history)) delete brain._history[k]
    return { ok: true }
  })
  ipcMain.handle('im:list-roles', () => ({ ok: true, roles: (ctx && ctx.listRoles && ctx.listRoles()) || [] }))
  // 测试消息选择器用：拉好友/群列表（只读），让用户点选而不是手输 group:123 格式
  ipcMain.handle('im:list-chats', async () => {
    try {
      const [groups, friends] = await Promise.all([
        client.call('get_group_list', {}).catch(() => []),
        client.call('get_friend_list', {}).catch(() => [])
      ])
      return {
        ok: true,
        groups: (Array.isArray(groups) ? groups : []).map((g) => ({ id: g.group_id, name: g.group_name || g.group_id })).sort((a, b) => a.id - b.id),
        friends: (Array.isArray(friends) ? friends : []).map((f) => ({ id: f.user_id, name: f.remark || f.nickname || f.user_id })).sort((a, b) => a.id - b.id)
      }
    } catch (e) { return { ok: false, error: e.message, groups: [], friends: [] } }
  })
  ipcMain.handle('im:send-test', async (_e, { chatId, text }) => {
    try {
      // chatId 形如 group:123 / private:456
      const [kind, id] = String(chatId || '').split(':')
      if (!id || !text) return { ok: false, error: '参数不完整' }
      outerLog(`[im] 测试消息 → ${kind}:${id} 「${String(text).slice(0, 30)}」`)
      if (kind === 'group') await client.call('send_group_msg', { group_id: Number(id), message: [{ type: 'text', data: { text } }] })
      else await client.call('send_private_msg', { user_id: Number(id), message: [{ type: 'text', data: { text } }] })
      return { ok: true }
    } catch (e) { outerLog('[im] 测试消息失败：' + e.message); return { ok: false, error: e.message } }
  })

  // ---- 微信 M2：UI 自动化（自聊闭环）----
  wxMod = createWx({
    home,
    getProvider: () => ctx.getProvider(),
    getContext: (roleId, query) => {
      const c = ctx.getContext(roleId) || {}
      try {
        const id = roleId || currentCharId()
        const mem = ctx.memoryRecallText ? ctx.memoryRecallText(id, query || '', 5) : ''
        if (mem) c.memoryText = mem
      } catch { }
      return c
    },
    brain,
    log: (m) => outerLog(m)
  })
  wxMod.loadCfg()
  wxMod.schedule()
  ipcMain.handle('wx:status', () => wxMod.status())
  ipcMain.handle('wx:config-patch', (_e, patch) => ({ ok: true, config: wxMod.saveCfg(patch || {}) }))
  ipcMain.handle('wx:probe', async () => await wxMod.pollOnce(true))

  outerLog('[im] 群聊接入模块就绪 home=' + home)
  // 0.45.91：client 用 getter 暴露 —— 原来这里返回的是 init 那一刻的快照，
  // 一旦走 im:connect 重建客户端，外部（main.js 的 QQ 主动找人桥接）拿到的还是旧对象，
  // 状态永远停在断开，主动消息全哑。
  return {
    brain,
    wx: wxMod,
    get client () { return client }
  }
}

module.exports = { init }
