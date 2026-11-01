/**
 * S11-M2 微信接入：UI 自动化（个人微信无官方接口，iPad 协议有封号风险 → 弃）。
 *
 * 原理（用户 2026-10-23 拍板的方案）：
 *   1. 找到微信电脑版窗口（复用 CUA 的 findWechat，含托盘隐藏态）
 *   2. 定期截窗口图 → DeepSeek V4.1 Flash（1017 起原生看图）读出会话名 + 左右两侧消息
 *   3. 对方（左侧）有新话 → 交给群聊大脑（人设/记忆/私聊白名单全套复用）
 *   4. 回复走键鼠：聚焦微信 → 点输入框 → 打字 → 回车
 *
 * 测试闭环 = 「自己跟自己聊」：手机上给自己的微信（或文件传输助手）发消息，
 * 电脑端窗口里出现消息，她回复后手机立刻收到 —— 不需要第二个微信号。
 * 注意：手机发的消息在电脑端也在**右侧**（都是机主本人），所以自聊会话
 * （chatName 含「文件传输」等）不做「右侧永不回」，改为剔除她自己的回声
 * （filterBotEchoes：文本与最近回复吻合的右侧消息不算输入）。
 *
 * 安全阀：
 *   - 用户 2 秒内在动键鼠 → 本轮让位（绝不跟人抢鼠标）
 *   - 配了 chatName 就只盯这个会话（防止切到别的聊天窗口乱回话）
 *   - 私聊白名单 / privateEnabled 开关照常生效（brain.shouldReply）
 *   - 右侧（机主自己/机器人）的发言永远不回，防自我循环
 */
'use strict'
const fs = require('fs')
const path = require('path')
const cua = require('../cua')
// 剪贴板（主进程才有；纯 node 测试环境没有 electron，降级回逐字打字）
let clipboard = null
try { clipboard = require('electron').clipboard } catch { }

const DEFAULTS = {
  enabled: false,
  pollSec: 30,          // 轮询间隔（秒）
  chatName: '',         // 只盯这个会话（如「文件传输助手」）；空 = 当前打开的会话都算
  maxReplyLen: 300
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)))

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2), 'utf8') }

function clampCfg (patch) {
  const out = { ...DEFAULTS }
  const p = patch && typeof patch === 'object' ? patch : {}
  out.enabled = !!p.enabled
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d }
  out.pollSec = n(p.pollSec, 10, 600, DEFAULTS.pollSec)
  if (typeof p.chatName === 'string') out.chatName = p.chatName.trim().slice(0, 60)
  out.maxReplyLen = n(p.maxReplyLen, 50, 1000, DEFAULTS.maxReplyLen)
  return out
}

/** 从模型回复里抠 JSON（有的模型爱包 ```json 围栏） */
function extractJson (text) {
  const s = String(text || '')
  const m = s.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

const normText = (s) => String(s || '').replace(/\s+/g, '').slice(0, 200)

/** 回声判定：完全相同，或互相包含且长度相近（视觉模型转写她原话的小出入）。
 *  用户的长消息里哪怕包含她说过的短语，也不算回声（否则她会「看不见」用户的字）。 */
function isEchoText (msg, reply) {
  const a = normText(msg)
  const b = normText(reply)
  if (!a || !b) return false
  if (a === b) return true
  return (a.includes(b) || b.includes(a)) && Math.abs(a.length - b.length) <= 2
}

/** 自聊会话判定：文件传输助手（手机发的消息在电脑端也在右侧，见 filterBotEchoes） */
const isSelfChat = (chatName) => !!chatName && /文件传输|file ?transfer|传输助手/i.test(chatName)

/**
 * 自聊模式专用：剔除机器人自己刚回复过的消息。
 * 「右侧=机主、永不回」的防循环闸在自聊场景会把手机发来的消息一起吞掉
 * （手机发到文件传输助手的消息，电脑端也显示在右侧——都是机主本人）。
 * 自聊模式的判据改为：找到机器人最后一次发言（文本与最近回复吻合的右侧消息），
 * 只保留它**之后**的消息 —— 之前的都已答过，之后的右侧消息 = 机主发来的新输入。
 */
function filterBotEchoes (msgs, lastReplies) {
  if (!lastReplies.length) return msgs
  let lastEcho = -1
  msgs.forEach((m, i) => {
    if (m.side !== 'right') return
    if (lastReplies.some((r) => isEchoText(m.text, r))) lastEcho = i
  })
  return msgs.slice(lastEcho + 1)
}

/** 取末尾连续一串「用户发的」消息（自聊=右侧，普通=左侧），按时间顺序拼接 */
function pickUserRun (msgs, selfChat) {
  const side = selfChat ? 'right' : 'left'
  const run = []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].side !== side) break
    run.unshift(msgs[i].text)
  }
  return run.join('\n')
}

const READ_PROMPT = `你是微信电脑版窗口的读屏器。看这张微信截图，只输出一个 JSON（不要 markdown 围栏、不要解释）：
{"chat":"当前打开的会话名字","messages":[{"side":"left","text":"消息内容"}]}
规则：
- side=right 表示机主自己（含代替机主说话的助手）发的消息；side=left 表示对方发来的
- messages 按时间先后，最多保留最后 6 条
- ⭐ 每个气泡单独一条，**逐字照抄原文**：不要合并、不要总结、不要改写、不要漏掉中间的消息；一条气泡里有多行就带换行放在同一个 text 里
- 文字消息照抄内容
- 图片消息：**先仔细看窗口里那张图本身** —— 能看清就把 text 写成「[图片] 你看到的内容的具体描述（物体/文字/人物/画面）」；确实还没加载出来（空白/灰色占位块/转圈）才写「[图片未加载]」
- 语音/表情按 [语音][表情] 占位；系统提示（时间、撤回等）跳过
- 看不清或不是聊天窗口就输出 {"chat":"","messages":[]}`

function createWx ({ home, getProvider, getContext, brain, log = () => { } }) {
  const cfgFile = path.join(home, 'wx.json')
  let cfg = clampCfg(readJson(cfgFile, {}))
  const state = { lastError: '', lastPollAt: 0, lastChat: '', polls: 0, replies: 0, skipped: 0 }
  let lastSig = ''      // 最近一次看到的消息签名（变化检测）
  const lastReplies = [] // 机器人最近回复的文本（自聊模式剔除自己的回声用）
  let lastChatLogged = ''
  let busy = false
  let timer = null

  const loadCfg = () => { cfg = clampCfg(readJson(cfgFile, {})); return cfg }
  const saveCfg = (patch) => { cfg = clampCfg({ ...cfg, ...(patch || {}) }); writeJson(cfgFile, cfg); schedule(); return cfg }
  const status = () => ({ ok: true, config: cfg, ...state })

  /* ---------------- 视觉读屏 ---------------- */
  async function readWindow () {
    const win = await cua._findWechat()
    if (!win) return { error: '微信没开着（或找不到主窗口）' }
    const shot = await cua._shoot({
      x: win.x, y: win.y, w: win.w, h: win.h,
      maxW: 1000, maxH: 1200, tag: 'wx'   // 窗口通常 800 多像素高：别缩太小，图里的图才看得清
    }, false) // updateView=false：不动 CUA 自己的坐标系，那套是给桌面助手用的
    const provider = getProvider && getProvider()
    if (!provider) throw new Error('模型服务不可用')
    const res = await provider.chat({
      messages: [
        { role: 'system', content: READ_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '读这个微信窗口，输出 JSON。' },
            { type: 'image_url', image_url: { url: shot.image } }
          ]
        }
      ]
    })
    const parsed = extractJson(res && res.content)
    if (!parsed) throw new Error('读屏模型没吐出 JSON')
    return { win, parsed }
  }

  /* ---------------- 键鼠回复 ---------------- */
  async function typeReply (win, text) {
    await cua._call('focus', { hwnd: win.hwnd }, 8000)
    await sleep(420)
    // 输入框在窗口右下 2/3 区域：横向取 58%，纵向取 91%（微信 PC 通用布局）
    const ix = Math.round(win.x + win.w * 0.58)
    const iy = Math.round(win.y + win.h * 0.91)
    await cua._call('click', { x: ix, y: iy }, 8000)
    await sleep(260)
    // 剪贴板粘贴（Ctrl+V）：KEYEVENTF_UNICODE 批量注入会被微信输入框把标点打重（，→，，），弃用
    let pasted = false
    if (clipboard) {
      try {
        const prev = clipboard.readText()
        clipboard.writeText(text)
        await cua._call('key', { keys: 'ctrl+v' }, 8000)
        await sleep(400)
        // 尽力还原用户剪贴板（粘贴已完成）
        try { if (prev && prev !== text) clipboard.writeText(prev) } catch { }
        pasted = true
      } catch { }
    }
    if (!pasted) await cua._call('type', { text }, 40000)
    await sleep(320)
    await cua._call('key', { keys: 'enter' }, 8000)
    await sleep(420)
  }

  /* ---------------- 单次轮询 ---------------- */
  async function pollOnce (manual = false) {
    if (busy) return { ok: false, skip: 'busy' }
    if (!cfg.enabled && !manual) return { ok: false, skip: 'off' }
    busy = true
    try {
      state.lastPollAt = Date.now()
      state.polls++
      const r = await readWindow()
      if (r.error) { state.lastError = r.error; return { ok: false, error: r.error } }
      const { win, parsed } = r
      state.lastChat = parsed.chat || ''
      // 自聊判定看实际会话：配置了 chatName 用配置的；没配（盯当前会话模式）就用当前窗口名，
      // 否则文件传输助手在「盯当前会话」模式下会被防循环闸整窗静默吞掉（21:55 真机事故）
      const selfChat = isSelfChat(cfg.chatName || state.lastChat)
      // 每轮都留痕：读到哪些消息一目了然（排障关键，别删）
      const brief = (Array.isArray(parsed.messages) ? parsed.messages : [])
        .slice(-6).map((m) => `${m.side === 'right' ? '右' : '左'}:${String(m.text || '').replace(/\s+/g, ' ').slice(0, 24)}`).join(' | ')
      log(`[wx] 读到「${state.lastChat}」${selfChat ? '(自聊)' : ''} ${brief || '(空)'}`)
      if (state.lastChat !== lastChatLogged) {
        lastChatLogged = state.lastChat
        log(`[wx] 会话切换 →「${state.lastChat}」窗口 ${win.w}x${win.h}`)
      }
      if (cfg.chatName && state.lastChat && !state.lastChat.includes(cfg.chatName)) {
        state.skipped++
        state.lastError = ''
        log(`[wx] 轮询跳过：当前会话「${state.lastChat}」不是要盯的「${cfg.chatName}」`)
        return { ok: true, skip: 'chat-mismatch', chat: state.lastChat }
      }
      let msgs = (Array.isArray(parsed.messages) ? parsed.messages : []).filter((m) => m && m.text)
      if (selfChat) msgs = filterBotEchoes(msgs, lastReplies)
      if (!msgs.length) { state.skipped++; return { ok: true, skip: 'empty' } }
      const sig = JSON.stringify(msgs.slice(-3).map((m) => [m.side, m.text]))
      if (sig === lastSig) { return { ok: true, skip: 'no-change' } }
      const last = msgs[msgs.length - 1]
      if (last.side === 'right' && !selfChat) {
        // 普通会话：右侧=机主自己（或上一轮机器人）说的，不回 —— 防自我循环的关键闸
        lastSig = sig
        return { ok: true, skip: 'mine' }
      }
      // 用户正在用电脑就不动手（空闲 2 秒以内都算在用）；签名不更新，下一轮重来
      const idle = await cua._call('idle', {}, 3000)
      if (!cua._canAct(idle && idle.idleMs)) {
        state.skipped++
        log('[wx] 轮询跳过：用户正在用电脑（2 秒内动过键鼠），下一轮再来')
        return { ok: true, skip: 'user-busy' }
      }
      lastSig = sig
      // 走大脑：私聊开关 / 白名单 / 人设 / 记忆全部复用 QQ 那套
      const userText = pickUserRun(msgs, selfChat) || String(last.text)
      const wxEv = {
        platform: 'wechat',
        post_type: 'message',
        message_type: 'private',
        // user_id = 会话名：私聊白名单/主人名单在微信侧按会话名匹配（填「文件传输助手」或对方备注）
        user_id: String(parsed.chat || '微信').slice(0, 60),
        self_id: 'me',
        // 自聊会话点明对面是机主本人，不然她会把「文件传输助手」当成聊天对象人名
        sender: { nickname: selfChat ? '机主本人（这是主人在文件传输助手里的自聊测试窗口）' : String(parsed.chat || '微信好友').slice(0, 60), card: '' },
        message: [{ type: 'text', data: { text: userText } }]
      }
      // 现读配置：微信路径不经过 handleEvent（热读在那边），不刷的话 brain 的白名单
      // 停在启动那一刻，设置页/外部改配置都不生效（22:44 真机事故）
      if (typeof brain.loadCfg === 'function') brain.loadCfg()
      const verdict = brain.shouldReply(wxEv, { atMe: false })
      if (!verdict.reply) {
        state.skipped++
        log(`[wx] 轮询跳过：大脑判定不回（${verdict.why}）`)
        return { ok: true, skip: verdict.why }
      }
      const reply = await brain.generate(wxEv, userText, false)
      const cut = reply.slice(0, cfg.maxReplyLen)
      await typeReply(win, cut)
      state.replies++
      state.lastError = ''
      lastReplies.push(cut)
      if (lastReplies.length > 4) lastReplies.shift()
      log(`[wx] 自聊回复 → ${cut.slice(0, 60)}`)
      return { ok: true, replied: cut, chat: state.lastChat }
    } catch (e) {
      state.lastError = e && e.message ? e.message : String(e)
      log('[wx] 轮询失败：' + state.lastError)
      return { ok: false, error: state.lastError }
    } finally {
      busy = false
    }
  }

  function schedule () {
    if (timer) { clearInterval(timer); timer = null }
    if (cfg.enabled) {
      timer = setInterval(() => { pollOnce().catch(() => { }) }, Math.max(10, cfg.pollSec) * 1000)
      if (timer.unref) timer.unref()
    }
  }

  return { pollOnce, status, loadCfg, saveCfg, schedule, _state: state, _setSig: (s) => { lastSig = s } }
}

module.exports = { createWx, clampCfg, extractJson, READ_PROMPT, DEFAULTS, isSelfChat, filterBotEchoes, pickUserRun, normText, isEchoText }
