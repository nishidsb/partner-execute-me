/**
 * CUA（电脑操作）主进程桥
 *
 * 分层：
 *   核心工具（src/assistant/core/tools/cua.js，纯声明）
 *     → 本文件 invoke(name, args)
 *       → engine.js 子进程（koffi / Win32，崩溃隔离）
 *
 * 本文件负责主进程才做得了的三件事：
 *   1. 截图编码：引擎给 BGRA 原始像素，这里换成 PNG + dataURL（有 Electron 的 nativeImage）
 *   2. 坐标映射：模型看到的是「截图里的坐标」，这里换算成真实屏幕坐标（规格 4.5）
 *   3. 用户让位：动作前看用户是否正在用电脑（2 秒内有输入就让位，最多让 15 秒，规格 4.4）
 *   另外动作执行期间把桌宠窗口整体设为穿透，避免角色挡住要点的地方。
 */
'use strict'
const path = require('path')
const fs = require('fs')
const { fork, execFile } = require('child_process')
const { app, nativeImage } = require('electron')
const { log } = require('../logger')
const { unpackedPath } = require('../util')
const G = require('./geometry')

/* ---------------- OCR（读屏幕正文） ---------------- */
const OCR_PS = unpackedPath(path.join(__dirname, 'resources', 'ocr.ps1'))
/** OCR 一张 PNG（Windows.Media.Ocr，无外部依赖）。失败返回空串。 */
function ocrFile (file) {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS, '-Path', file],
        { timeout: 25000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => resolve(err ? '' : String(stdout || '').trim()))
    } catch { resolve('') }
  })
}

/* ---------------- 引擎进程 ---------------- */
const ENGINE = path.join(__dirname, 'engine.js')
const CALL_TIMEOUT = 25000

let child = null
let starting = null
let seq = 0
let restarts = 0
let lastFatal = ''
const pending = new Map() // id → { resolve, reject, timer, op }

function startEngine () {
  if (child && child.connected) return Promise.resolve(true)
  if (starting) return starting
  starting = new Promise((resolve) => {
    let done = false
    const finish = (ok) => { if (!done) { done = true; starting = null; resolve(ok) } }
    try {
      child = fork(ENGINE, [], {
        // 子进程只跑 Win32 调用，不需要 Electron 的 node 集成
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // Buffer 原样走 IPC：截图不做 base64（4K 全屏 base64 会多出 12MB）
        serialization: 'advanced'
      })
    } catch (e) {
      lastFatal = e.message
      log('[cua] 引擎启动失败:', e.message)
      finish(false)
      return
    }
    child.stdout.on('data', (b) => {
      const s = String(b).trim()
      if (s) log('[cua:engine]', s.slice(0, 400))
    })
    child.stderr.on('data', (b) => {
      const s = String(b).trim()
      if (s) log('[cua:engine:err]', s.slice(0, 400))
    })
    child.on('message', (msg) => {
      if (!msg) return
      if (msg.event === 'ready') {
        log('[cua] 引擎就绪 pid=' + child.pid + ' 桌面=' + JSON.stringify(msg.metrics || {}))
        finish(true)
        return
      }
      if (msg.event === 'fatal') {
        lastFatal = String(msg.error || '').slice(0, 400)
        log('[cua] 引擎致命错误:', lastFatal)
        return
      }
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error || '引擎返回失败'))
    })
    child.on('exit', (code, signal) => {
      pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('引擎进程已退出（' + (signal || code) + '）')) })
      pending.clear()
      if (!done) { log('[cua] 引擎启动即退出 code=' + code); finish(false) }
      else { restarts++; log('[cua] 引擎进程退出 code=' + code + ' signal=' + signal + '（下次调用自动重启）') }
      child = null
    })
    // 就绪握手超时：DLL 加载卡住时不要让整个工具调用一直挂着
    setTimeout(() => {
      if (done) return
      lastFatal = lastFatal || '引擎启动超时'
      log('[cua] 引擎启动超时')
      try { if (child) child.kill() } catch {}
      finish(false)
    }, 12000)
  })
  return starting
}

function call (op, args = {}, timeoutMs = CALL_TIMEOUT) {
  return new Promise((resolve, reject) => {
    startEngine().then((ok) => {
      if (!ok) { reject(new Error('电脑操作引擎不可用：' + (lastFatal || '启动失败'))); return }
      if (!child || !child.connected) { reject(new Error('电脑操作引擎未连接')); return }
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('电脑操作超时（' + Math.round(timeoutMs / 1000) + ' 秒无响应）：' + op))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer, op })
      try {
        child.send({ id, op, args })
      } catch (e) {
        clearTimeout(timer)
        pending.delete(id)
        reject(new Error('给引擎发消息失败：' + e.message))
      }
    })
  })
}

function stop () {
  try { if (child) child.disconnect() } catch {}
  try { if (child) child.kill() } catch {}
  child = null
}

/* ---------------- 截图 → PNG ---------------- */
/** 4K 整屏 BGRA 是 33MB；缩到 1280 宽后 4MB，编码 PNG 只留几十毫秒 */
function toPNG (bgra, width, height) {
  // BitBlt 出来的 32 位像素 alpha 通道是 0（GDI 不填），直接交给 nativeImage
  // 会得到全透明图 → 手动补 255
  const buf = Buffer.from(bgra)
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255
  const img = nativeImage.createFromBitmap(buf, { width, height })
  const png = img.toPNG()
  return { img, png, dataURL: 'data:image/png;base64,' + png.toString('base64') }
}

/** 截图落盘（模型看到的是 dataURL，但用户/排障需要能翻出原图） */
function saveShot (png, tag) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs', 'cua')
    fs.mkdirSync(dir, { recursive: true })
    const name = 'shot-' + Date.now() + (tag ? '-' + String(tag).replace(/[^\w-]/g, '').slice(0, 20) : '') + '.png'
    const p = path.join(dir, name)
    fs.writeFileSync(p, png)
    return p
  } catch { return '' }
}

/* ---------------- 坐标映射（规格 4.5） ---------------- */
let lastView = null
let prevView = null   // 0.45.14：上一张图的坐标系（zoom 换图时留着，模型拿旧坐标也能点对）

function viewToScreen (x, y) {
  const p = G.viewToScreen(lastView, x, y)
  return p
}

/**
 * 0.45.14 坐标系自动换算：模型 zoom 之后忘了坐标已经切到新图，还拿旧图的像素坐标
 * 来点 —— 以前直接报错（一场活动卡死在「请重新 screenshot」）。现在先按当前图换算，
 * 超界就回退用上一张图换算（旧坐标 → 屏幕点），命中的话动作照做，并在结果里提示
 * 「已按放大前的图换算」，模型自己就能对齐坐标系。
 */
function resolvePoint (x, y) {
  try { return { p: viewToScreen(x, y), via: 'current' } } catch (err) {
    if (prevView && prevView !== lastView) {
      try {
        const p = G.viewToScreen(prevView, x, y)
        return { p, via: 'prev' }
      } catch { }
    }
    throw err
  }
}

/* ---------------- 用户让位（规格 4.4） ---------------- */
async function waitForUserIdle () {
  const begin = Date.now()
  for (;;) {
    let idle = 0
    try {
      const r = await call('idle', {}, 3000)
      idle = Number(r && r.idleMs) || 0
    } catch { return { ok: true, waitedMs: 0 } } // 读不到空闲就当空闲，别把功能卡死
    if (G.canAct(idle)) return { ok: true, waitedMs: Date.now() - begin, idleMs: idle }
    if (G.yieldExpired(Date.now() - begin)) return { ok: false, waitedMs: Date.now() - begin, idleMs: idle }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/* ---------------- 桌宠让位 ---------------- */
let overlayGuard = null // 主进程注入：动作期间让角色窗口不接鼠标
function setOverlayGuard (fn) { overlayGuard = typeof fn === 'function' ? fn : null }

async function withOverlayParked (fn) {
  if (!overlayGuard) return fn()
  try { overlayGuard(true) } catch {}
  try { return await fn() } finally { try { overlayGuard(false) } catch {} }
}

/* ---------------- 截图（可指定区域） ---------------- */
/**
 * @param {object} o  { x, y, w, h, maxW, maxH, tag }
 * @param {boolean} updateView 是否用这张图重置坐标系（默认是）
 */
async function shoot (o = {}, updateView = true) {
  const raw = await call('shot', {
    x: o.x, y: o.y, w: o.w, h: o.h,
    maxW: o.maxW || 1280, maxH: o.maxH || 800
  }, 20000)
  const { png, dataURL, img } = toPNG(raw.buffer, raw.outW, raw.outH)
  const size = img.getSize()
  const view = G.makeView({
    srcX: raw.srcX, srcY: raw.srcY, srcW: raw.srcW, srcH: raw.srcH,
    outW: size.width, outH: size.height
  })
  if (updateView) {
    // 0.45.14：换坐标系前把旧的留着（resolvePoint 的回退换算用）
    if (lastView && view !== lastView) prevView = lastView
    lastView = view
  }
  return {
    image: dataURL,
    file: saveShot(png, o.tag),
    width: size.width,
    height: size.height,
    view,
    screen: { x: raw.srcX, y: raw.srcY, w: raw.srcW, h: raw.srcH }
  }
}

/**
 * 动作后补图：**必须按当前坐标系同一区域截**，否则模型看到新图、
 * 却仍用旧坐标 → 第二下就点偏。同区域同缩放 = 图与坐标一一对应。
 */
async function followShot () {
  const v = lastView
  try {
    const s = await shoot(v
      ? { x: v.srcX, y: v.srcY, w: v.srcW, h: v.srcH, maxW: 1280, maxH: 800, tag: 'after' }
      : { tag: 'after' }, false)
    // updateView=false 时坐标系不变，但要保证新图的缩放与旧坐标系一致；
    // 区域相同、上限相同 → fitScale 结果相同（scale 差 1px 以内）
    return { image: s.image, file: s.file, width: s.width, height: s.height, screen: s.screen }
  } catch (e) {
    return { error: '补图失败（不影响动作本身）：' + e.message }
  }
}

/** 动作后等界面安定（规格 4.5 的 settle 500ms），再补一张图给模型看结果 */
const SETTLE_MS = 500
async function settle () { await new Promise((r) => setTimeout(r, SETTLE_MS)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)))

/* ---------------- 微信发送（不需要模型看得见的定点流程） ---------------- */
/**
 * 为什么单独做这一个工具：
 *   「帮我在微信回某人的消息」是最常见的请求，但它需要模型先看见聊天窗口才能点。
 *   很多国内端点（DeepSeek 等）根本不接受图片 → 模型拿不到截图 → 靠猜坐标必然点错。
 *   所以这里走**纯键盘的固定路径**：Ctrl+F 搜联系人 →（人看一眼截图确认是这个人）→ 回车进会话 → 打字 → 回车发送。
 *   唯一需要"眼睛"的一步交给用户：确认窗里直接显示搜索结果截图，用户点「对，发送」才真的发。
 *   顺序不能颠倒：确认必须在第一次回车**之前**，否则名字已经被发出去了，撤不回来。
 */
const WECHAT_SKIP = /微信输入法|WeChat ?Input|小程序|WeChatApp/i

async function findWechat () {
  // includeHidden：微信关到托盘时主窗口还在、只是隐藏 —— 0.6.0 真实事故：
  // 之前枚举跳过隐藏窗口 → 明明在跑却报「微信没开着」，模型只好再开一次微信
  const list = await call('windows', { includeMinimized: true, includeHidden: true })
  const cands = list.filter((w) => {
    if (w.hidden && !/微信|WeChat|Weixin/i.test(String(w.title || '') + String(w.cls || ''))) return false
    const t = String(w.title || '')
    if (!t || WECHAT_SKIP.test(t)) return false
    return /微信/.test(t) || /WeChat|Weixin/i.test(t)
  })
  if (!cands.length) return null
  // 优先「可见 + 没最小化 + 面积大」：隐藏/最小化的兜底（focus 会先还原再聚焦）
  cands.sort((a, b) => (Number(a.hidden) - Number(b.hidden)) ||
    (Number(a.minimized) - Number(b.minimized)) || (b.w * b.h - a.w * a.h))
  return cands[0]
}

async function wechatSend ({ contact, text } = {}) {
  const who = String(contact || '').trim()
  const body = String(text || '').trim()
  if (!who) throw new Error('要发给谁？contact 不能为空（填联系人在微信里显示的名字）')
  if (!body) throw new Error('要发什么？text 不能为空')

  const win = await findWechat()
  if (!win) {
    return {
      sent: false,
      reason: '微信现在没开着。先用 open_app（名字填「微信」）把它打开，等窗口出来再调一次这个工具。'
    }
  }

  await call('focus', { hwnd: win.hwnd }, 8000)
  await sleep(450)

  // 1) 搜索联系人。微信 Windows 版的搜索快捷键是 Ctrl+F
  await call('key', { keys: 'ctrl+f' })
  await sleep(300)
  await call('type', { text: who }, 20000)
  await sleep(750)

  // 2) 先把「搜到的人对不对」交给用户看一眼 —— **必须在按回车之前**。
  //    万一这版微信不认 Ctrl+F，字会落在当前聊天的输入框里；这时截图一眼就能看出来，
  //    用户取消就没事。反过来先回车再问，就已经把名字发出去、撤不回来了。
  let shot = null
  try {
    shot = await shoot({ maxW: 900, maxH: 560, tag: 'wechat-search' }, false)
  } catch { /* 截不到图不让整个流程失败：退化成纯文字确认 */ }
  const ans = await require('./confirm').ask({
    message: '要发给这个人吗？',
    detail: '发给：' + who + '\n内容：' + body +
      '\n\n' + (shot
        ? '看截图：搜索框里是「' + who + '」，列表第一条要是 TA。不对就点取消。'
        : '（这次截不到图）请确认微信里搜出来的是 TA。'),
    image: shot ? shot.image : '',
    buttons: ['对，发送', '取消'],
    icon: 'warning',
    width: shot ? 660 : 460,
    height: shot ? 690 : 300
  })
  if (ans.index !== 0) {
    try { await call('key', { keys: 'esc' }) } catch {}
    return {
      sent: false,
      reason: ans.timeout
        ? '确认窗等了 60 秒没人点，按「没有发送」处理（对方可能不在电脑前）'
        : '用户取消了，没有发送任何内容'
    }
  }

  // 3) 回车进入会话（焦点落到输入框），再输入正文、回车发送
  await call('key', { keys: 'enter' })
  await sleep(950)
  await call('type', { text: body }, 40000)
  await sleep(320)
  await call('key', { keys: 'enter' })
  await sleep(650)

  let after = null
  try {
    after = await shoot({ maxW: 900, maxH: 560, tag: 'wechat-sent' }, true)
  } catch {}

  return {
    sent: true,
    to: who,
    text: body,
    files: [shot && shot.file, after && after.file].filter(Boolean),
    ...(after ? { image: after.image } : {}),
    note: '已经按回车发出去了。截图在 files 里；如果对方头像/名字不对，立刻告诉用户，别自己再补发。'
  }
}

/* ---------------- 工具实现 ---------------- */
const ACT_OPS = new Set(['click', 'move', 'drag', 'scroll', 'type', 'key', 'wechat_send'])

async function exec (name, a) {
  switch (name) {
    case 'screenshot': {
      // 默认只截「当前活动的那块屏」，双屏时不要把 5120 宽全塞进 1280 像素：
      // 判据先看前台窗口的中心在哪块屏（用户正在看的），再看光标在哪块屏
      let region = null
      if (a.all !== true && a.all !== 'true') {
        try {
          const wins = await call('windows')
          const fg = wins.find((w) => w.focused)
          const c = await call('cursor')
          const pick = fg
            ? await call('monitorAt', { x: Math.round(fg.x + fg.w / 2), y: Math.round(fg.y + fg.h / 2) })
            : null
          region = pick || await call('monitorAt', { x: c.x, y: c.y })
        } catch { /* 拿不到就退回整桌面 */ }
      }
      const s = await shoot({
        x: region ? region.x : undefined,
        y: region ? region.y : undefined,
        w: region ? region.w : undefined,
        h: region ? region.h : undefined,
        maxW: 1280, maxH: 800, tag: 'screen'
      }, true)
      return {
        image: s.image,
        file: s.file,
        width: s.width,
        height: s.height,
        screen: s.screen,
        note: `${region ? '当前这块屏幕' : '全部屏幕'}的截图：${s.width}x${s.height} 像素，对应屏幕区域 x=${s.screen.x} y=${s.screen.y} ${s.screen.w}x${s.screen.h}。` +
          `点击/拖拽/滚动请直接用这张图的像素坐标（左上角 0,0，右下角 ${s.width - 1},${s.height - 1}）。` +
          '要操作另一块屏上的窗口，先 focus 它再 screenshot。'
      }
    }
    case 'read_text': {
      // 0.45.10 读正文：模型看截图常「看得见图看不清字」（网页正文、聊天记录），
      // 这个工具把当前屏用更高分辨率截下来交给 Windows 自带 OCR，直接给出文字。
      let file = ''
      try {
        const s = await shoot({ maxW: 1600, maxH: 1000, tag: 'ocr' }, false)  // 不动 lastView：坐标框架保持模型上次那张
        file = s.file
      } catch (e) { return { text: '截屏失败: ' + (e && e.message) } }
      if (!file) return { text: '截屏落盘失败，无法识别文字' }
      const txt = await ocrFile(file)
      return {
        text: txt
          ? '屏幕上识别出的文字（OCR，小字可能有错，按大意理解）：\n' + txt.slice(0, 3000)
          : '没识别出文字（可能是纯图片桌面，或系统缺少对应语言的 OCR 包）'
      }
    }
    case 'zoom': {
      if (!lastView) throw new Error('还没截过图：请先 screenshot 再放大局部')
      const { p } = resolvePoint(a.x, a.y)
      const w = Math.max(120, Math.round(Number(a.w) || 400))
      const h = Math.max(100, Math.round(Number(a.h) || 300))
      const s = await shoot({ x: p.x - w / 2, y: p.y - h / 2, w, h, maxW: 1024, maxH: 1024, tag: 'zoom' }, true)
      return {
        image: s.image,
        file: s.file,
        width: s.width,
        height: s.height,
        screen: s.screen,
        note: `这是以 (${a.x},${a.y}) 为中心放大的局部图（屏幕 ${s.screen.w}x${s.screen.h}）。坐标已切换为这张图的像素坐标。`
      }
    }
    case 'click': {
      const rp = resolvePoint(a.x, a.y)
      const p = rp.p
      const r = await call('click', { x: p.x, y: p.y, button: a.button || 'left', count: Math.min(2, Math.max(1, Number(a.count) || 1)) })
      await settle()
      if (rp.via === 'prev') return { note: '坐标按放大前的旧图自动换算了（你 zoom 后坐标系已切到新图，下次直接用新图的坐标）', clicked: { screen: p, view: { x: Number(a.x), y: Number(a.y) }, label: a.label || '' }, ...r, after: await followShot() }
      return { clicked: { screen: p, view: { x: Number(a.x), y: Number(a.y) }, label: a.label || '' }, ...r, after: await followShot() }
    }
    case 'move': {
      const p = resolvePoint(a.x, a.y).p
      return await call('move', { x: p.x, y: p.y })
    }
    case 'drag': {
      const p1 = resolvePoint(a.x, a.y).p
      const p2 = resolvePoint(a.toX != null ? a.toX : a.x2, a.toY != null ? a.toY : a.y2).p
      const r = await call('drag', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, durationMs: Number(a.durationMs) || 500 })
      await settle()
      return { ...r, after: await followShot() }
    }
    case 'scroll': {
      const at = (a.x != null && a.y != null) ? resolvePoint(a.x, a.y).p : null
      const r = await call('scroll', { x: at && at.x, y: at && at.y, dy: Number(a.dy) || 0, dx: Number(a.dx) || 0 })
      await settle()
      return { ...r, after: await followShot() }
    }
    case 'type': {
      const r = await call('type', { text: String(a.text == null ? '' : a.text) }, 40000)
      await settle()
      return { ...r, after: await followShot() }
    }
    case 'key': {
      const r = await call('key', { keys: a.keys })
      await settle()
      return { ...r, after: await followShot() }
    }
    case 'windows': {
      const list = await call('windows', { includeMinimized: !!a.includeMinimized })
      // 模型只需要前 20 个：多了浪费 tokens，还会挤掉截图
      return {
        count: list.length,
        windows: list.slice(0, 20).map((w) => ({
          hwnd: w.hwnd, title: w.title, cls: w.cls, pid: w.pid,
          x: w.x, y: w.y, w: w.w, h: w.h, focused: w.focused, minimized: w.minimized
        }))
      }
    }
    case 'focus': {
      let hwnd = Number(a.hwnd) || 0
      if (!hwnd && a.title) {
        const list = await call('windows', { includeMinimized: true })
        const q = String(a.title).toLowerCase()
        const hit = list.find((w) => w.title.toLowerCase().includes(q))
        if (!hit) {
          return {
            ok: false,
            error: '没找到标题包含「' + a.title + '」的窗口',
            candidates: list.slice(0, 12).map((w) => w.title)
          }
        }
        hwnd = hit.hwnd
      }
      if (!hwnd) throw new Error('focus 需要 hwnd 或 title')
      const r = await call('focus', { hwnd })
      await settle()
      return { ...r, after: await followShot() }
    }
    case 'wait': {
      const ms = Math.max(0, Math.min(10000, Number(a.ms) || 800))
      await call('wait', { ms })
      return { waited: ms }
    }
    case 'wechat_send':
      return await wechatSend(a)
    case 'idle':
      return await call('idle')
    default:
      throw new Error('未知 CUA 操作: ' + name)
  }
}

async function invoke (name, args = {}) {
  const a = args || {}
  // 需要动键鼠的操作：先让位（用户在动就不动手），再让桌宠别接鼠标
  const needsYield = ACT_OPS.has(name)
  if (needsYield) {
    const y = await waitForUserIdle()
    if (!y.ok) {
      return {
        deferred: true,
        reason: `用户正在使用电脑（最近 ${Math.round(y.idleMs / 100) / 10} 秒内有输入，等了 ${Math.round(y.waitedMs / 1000)} 秒仍在动），已让位，没有执行「${name}」。稍后再试，或先问对方什么时候方便。`
      }
    }
  }
  if (needsYield) return await withOverlayParked(() => exec(name, a))
  return await exec(name, a)
}

module.exports = {
  start: startEngine,
  stop,
  invoke,
  setOverlayGuard,
  isRunning: () => !!(child && child.connected),
  // S11-M2 微信接入：给 im/wx 复用底层原语（引擎调用 / 定区截图 / 找微信窗口）。
  // 不走 invoke()：invoke 的用户让位/确认窗是给「模型操作电脑」用的，
  // 监控循环要自己控节奏（wx 侧有自己的空闲检测，不在用户打字时动手）
  _call: call,
  _shoot: shoot,
  _findWechat: findWechat,
  _canAct: (idleMs) => G.canAct(idleMs)
}
