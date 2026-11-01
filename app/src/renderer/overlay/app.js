'use strict'
/* ============================================================
   Ryza Assistant 桌面层（v0.3.0 精简版）
   范围收缩到三层目标的第一层「桌面伙伴」：
   - 伙伴渲染 / 动画 / 触摸 / 拖动 / 视线（pet.js 自举）
   - 回复气泡 + 悬停输入条（AI 对话走助手核心 assistant:send）
   - 缩放 / 壁纸调暗 / 悬停热区动态穿透 / 提示
   已移除 AuraDesk 遗留产品功能：游戏卡片、游戏库、音乐播放器、
   歌词、时钟天气、控制舱、桌面坞（设置/隐藏入口在系统托盘）。
   ============================================================ */

const $ = (s) => document.querySelector(s)

let S = null

/* ------------------------------ 错误上报（诊断链路） */
window.addEventListener('error', (e) => {
  try { window.aura.reportError('overlay', e.message + ' @' + e.filename + ':' + e.lineno) } catch {}
})
window.addEventListener('unhandledrejection', (e) => {
  try { window.aura.reportError('overlay', 'unhandledrejection: ' + (e.reason && e.reason.message || e.reason)) } catch {}
})

/* -------------------------------------------------------- 缩放与壁纸 */

function applyScale () {
  const h = window.innerHeight || 1080
  const w = window.innerWidth || 1920
  let ui = h / 1080
  ui = Math.min(1.34, Math.max(0.76, ui))
  // 超宽屏不要跟着高度无限放大
  ui = Math.min(ui, (w / 1920) * 1.15)
  ui *= (S && S.cfg.ui.scale) || 1
  document.documentElement.style.setProperty('--ui', ui.toFixed(3))
}

function applyWallpaper () {
  const wp = (S && S.cfg.wallpaper) || {}
  const type = wp.type || 'desktop'
  // desktop：整窗透明，壁纸交给桌面（Wallpaper Engine / 系统壁纸），我们只画组件
  document.body.dataset.wall = type
  const dim = wp.dim == null ? 0.06 : wp.dim
  document.documentElement.style.setProperty('--dim', dim)
}

/* ---------------------------------------------------------------- 提示 */

let toastTimer = null
function toast (msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200)
}

/* ------------------------------------------------------- 输入热区上报 */

/* 窗口整窗穿透 + forward 转发鼠标事件，这里维护热区矩形并在 mousemove
   里判断光标是否落在热区内，动态切换穿透（状态变化才 IPC）。 */

let shapeRaf = 0
let hotRects = []
let mouseHot = false
const lastMouse = { x: -1, y: -1 }

/* 角色像素掩码：角色层置顶后，整块 petStage 矩形（300x520）会连同透明背景一起
   吃掉下面窗口的点击（AuraDesk 卡片就被挡住了）。这里每 500ms 把当前角色帧缩成
   低分辨率 alpha 掩码，命中判定查掩码 → 只有角色本体接鼠标，空白处照常穿透。
   采样失败（WebGL 未保帧、图片被污染）时热区收缩到中央躯干区（0.45.29）——
   旧策略「宁可挡」会让 450×780 的死区压在桌面挂机游戏身上全都点不动。 */
const MASK_W = 48
const MASK_H = 84
let petMask = null
let maskCanvas = null

function samplePetMask () {
  const stage = document.getElementById('petStage')
  if (!stage || stage.hidden) { petMask = null; return }
  const el = [...stage.querySelectorAll('img, canvas')].find((n) => !n.hidden && n.offsetWidth > 2)
  if (!el) { petMask = null; return }
  try {
    if (!maskCanvas) { maskCanvas = document.createElement('canvas'); maskCanvas.width = MASK_W; maskCanvas.height = MASK_H }
    const g = maskCanvas.getContext('2d', { willReadFrequently: true })
    g.clearRect(0, 0, MASK_W, MASK_H)
    g.drawImage(el, 0, 0, MASK_W, MASK_H)
    const data = g.getImageData(0, 0, MASK_W, MASK_H).data
    const alpha = new Uint8Array(MASK_W * MASK_H)
    let solid = 0
    for (let i = 0; i < alpha.length; i++) {
      const a = data[i * 4 + 3]
      alpha[i] = a
      if (a > 16) solid++
    }
    petMask = solid > alpha.length * 0.01 ? { w: MASK_W, h: MASK_H, alpha } : null
  } catch { petMask = null }
}

function maskHit (x, y, r) {
  if (!petMask) return true
  const mx = Math.floor(((x - r.x) / r.width) * petMask.w)
  const my = Math.floor(((y - r.y) / r.height) * petMask.h)
  // 3x3 邻域容错：角色边缘抖动/动画帧差异不该让手抖一下就没命中
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = mx + dx
      const py = my + dy
      if (px < 0 || py < 0 || px >= petMask.w || py >= petMask.h) continue
      if (petMask.alpha[py * petMask.w + px] > 16) return true
    }
  }
  return false
}

function hitHot (x, y) {
  for (const r of hotRects) {
    if (!(x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)) continue
    // 只有角色舞台做像素级收紧；气泡/输入条这些实心小面板照旧整块可点
    if (r.pixel && !maskHit(x, y, r)) continue
    return true
  }
  return false
}

function applyMouseHot (hot) {
  // 拖拽期间（发起窗口的 __petDragging / 全局广播的 __petDragActive）必须保持可交互：
  // 穿透（WS_EX_TRANSPARENT）会让 Windows 停发鼠标消息，拖拽/松手事件全部丢失
  if (window.__petDragging || window.__petDragActive) hot = true
  if (hot === mouseHot) return
  mouseHot = hot
  // 0.6.0：不再从这里发 ignoreMouse —— 穿透切换归主进程 80ms poll（热区已上报）。
  // 这里只维护本地状态 + 提层。
  if (hot) { try { window.aura.raise && window.aura.raise() } catch {} }
}

let lastReport = '' // 上报去重：内容没变不发 IPC（走路时 33ms 一次 computeShape）

function computeShape () {
  const rects = []
  for (const el of document.querySelectorAll('[data-hot]')) {
    if (el.closest('[hidden]')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    // 角色舞台按像素掩码收紧热区（透明背景不挡下面窗口）
    const pixel = el.id === 'petStage'
    let x = Math.max(0, Math.floor(r.left))
    let y = Math.max(0, Math.floor(r.top))
    let w = Math.ceil(Math.min(r.width, window.innerWidth))
    let h = Math.ceil(Math.min(r.height, window.innerHeight))
    if (pixel && !petMask) {
      // 0.45.29 掩码采样失败（WebGL 丢帧/画布被污染）时不再退回「整块矩形宁可挡」——
      // 1.5× 缩放下那是 450×780 的一块死区，压在桌面挂机游戏（桌面破坏神）身上
      // 全都点不动。收缩到角色躯干所在的中央 56% 宽、自 6% 高往下，贴身但不误挡。
      const insetX = Math.floor(w * 0.22)
      const insetY = Math.floor(h * 0.06)
      x += insetX
      y += insetY
      w -= insetX * 2
      h -= insetY
    }
    rects.push({ x, y, width: w, height: h, pixel })
  }
  hotRects = rects
  // 0.6.0 鼠标延迟修复：热区 + 像素掩码上报给主进程，由主进程 80ms 光标轮询
  // 直接判定并切换穿透 —— 基线不再 forward 全屏 mousemove（那是「鼠标发飘」的根源）。
  // 走路时每 33ms 都会进来，内容没变化就不发。
  const payload = rects.map((r) => (r.pixel && petMask
    ? { ...r, mask: { w: petMask.w, h: petMask.h, alpha: Array.from(petMask.alpha) } }
    : r))
  const sig = JSON.stringify(payload)
  if (sig !== lastReport) {
    lastReport = sig
    try { window.aura.setHotRects && window.aura.setHotRects(payload) } catch {}
  }
  // 布局变化后光标命中状态可能翻转（如面板弹出/收起），立即校正一次
  applyMouseHot(hitHot(lastMouse.x, lastMouse.y))
}

function scheduleShape () {
  if (shapeRaf) return
  shapeRaf = requestAnimationFrame(() => {
    shapeRaf = 0
    computeShape()
  })
}

function bindShape () {
  // 气泡/聊天条显隐都会改热区；rAF 合并
  new MutationObserver(scheduleShape).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'class', 'style']
  })
  window.addEventListener('resize', scheduleShape)
  window.addEventListener('contextmenu', (e) => e.preventDefault())

  // 穿透状态下 forward 仍转发 mousemove；可点状态下窗口正常收。两种状态都能走到这
  document.addEventListener('mousemove', (e) => {
    lastMouse.x = e.clientX
    lastMouse.y = e.clientY
    applyMouseHot(hitHot(e.clientX, e.clientY))
  }, { passive: true })

  // 0.45.29 主进程 poll 翻回穿透 → 渲染层 mouseHot 必须归零：
  // 否则光标再次进热区时 applyMouseHot(true) 被去重挡掉，raise() 不触发，
  // 又回到「AuraDesk 卡片压在上面、点击落到卡片」的老问题
  if (window.aura.onHotLost) window.aura.onHotLost(() => { mouseHot = false })

  computeShape()
  // 角色会播动画/换装，掩码跟着低频刷新（0.5s 一次足够跟手）；
  // 掩码变了热区 payload 也变 → computeShape 里的去重会自动把新掩码报给主进程
  samplePetMask()
  setInterval(() => {
    samplePetMask()
    computeShape()
    applyMouseHot(hitHot(lastMouse.x, lastMouse.y))
  }, 500)
}

/* ------------------------------------------------------------------ 启动 */

function render () {
  applyScale()
  applyWallpaper()
  document.body.classList.toggle('lowfx', !!(S.cfg.ui && S.cfg.ui.lowFx))
}

async function boot () {
  S = await window.aura.init()
  S.cfg = S.cfg || {}
  S.cfg.ui = S.cfg.ui || {}
  S.cfg.wallpaper = S.cfg.wallpaper || {}

  await new Promise((r) => requestAnimationFrame(r))
  render()
  bindShape()

  window.addEventListener('resize', () => { applyScale() })
}

boot().catch((err) => {
  // 通道名必须和 preload 里暴露的一致（reportError → overlay:renderer-error）。
  // 0.40.0 之前这里写的是 rendererError，preload 没有这个 key → TypeError 被下面的 catch 吞掉，
  // 启动失败时主进程日志一片空白，只剩一个没反应的桌宠。
  try { window.aura.reportError('overlay', 'boot: ' + (err && err.message), err && err.stack) } catch {}
  console.error('[overlay boot]', err)
})
