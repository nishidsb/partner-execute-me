'use strict'
/**
 * Ryza Assistant 主进程（v0.3.0 精简版）
 * 范围 = 三层目标：桌面伙伴（透明桌面层+桌宠）/ 有记忆的 AI 角色（助手核心）/ 个人助手（后续）
 * - 每块屏幕一个透明覆盖层窗口（桌宠 + 气泡对话）
 * - 助手聊天窗（会话/多角色/记忆）+ 设置窗口（显示器/全局）
 * 已移除 AuraDesk 遗留：游戏库/启动器/边缘任务条/音乐播放器/歌词/时钟/控制舱/旧伴侣聊天窗
 */
const {
  app, BrowserWindow, ipcMain, screen, dialog, shell, globalShortcut, protocol, net,
  Tray, Menu, nativeImage, powerSaveBlocker
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const datadir = require('./datadir')
// 数据目录必须在任何模块读 userData 之前定下来（单实例锁、session、日志都以它为基准）。
// 便携版 → <程序目录>/data；否则用指针文件记录的目录；都没有就默认 %APPDATA%。
datadir.applyRoot({ app, log: (m) => { try { require('./logger').log(m) } catch {} } })

const store = require('./store')
const companion = require('./companion') // 仅用其角色资产/语音/ASR 基础设施（聊天窗已移除）
const assistant = require('./assistant')
const gameLib = require('./gameLib')
const gameMode = require('./gameMode')
const { log } = require('./logger')

const CAPTURE = process.argv.includes('--capture')

// 单实例（截图模式例外：不抢正在运行的实例，方便随时出图）
if (!CAPTURE && !app.requestSingleInstanceLock()) {
  app.quit()
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aura',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

const overlayWins = new Map() // key -> win
const winKey = new Map() // webContents.id -> key
// 渲染层上报的热区（key -> [{x,y,width,height,pixel,mask:{w,h,alpha}}]，窗口内 CSS 坐标）。
// 0.6.0 鼠标延迟修复：之前基线是 forward:true（全屏 mousemove 全部转发进渲染层做命中测试，
// 两块屏=两份），这是「开着软件鼠标发飘」的结构性原因。现在改为：
// 渲染层把热区+像素掩码报给主进程，主进程在已有的 80ms 光标轮询里做命中，
// 基线 setIgnoreMouseEvents(true)【不带 forward】—— Windows 光标路径完全不被碰；
// 只有光标落进热区才切可交互。
const hotRectsByWin = new Map()
const overlayInteractive = new Map() // key -> bool（避免重复 SetWindowLong）
let cuaParked = false // CUA 动作执行期间 poll 不得把窗口翻回可交互
let rebuildTimer = null

/** 恢复 overlay 的穿透基线：有热区数据 → 无 forward（由 poll 驱动）；还没有 → 退回老 forward 基线 */
function overlayBaseline (win) {
  let key = null
  for (const [k, w] of overlayWins) if (w === win) key = k
  if (!win || win.isDestroyed()) return
  try {
    if (key && hotRectsByWin.has(key)) win.setIgnoreMouseEvents(true)
    else win.setIgnoreMouseEvents(true, { forward: true })
    if (key) overlayInteractive.set(key, false)
  } catch {}
}

/** 主进程热区命中：与渲染层 maskHit 同逻辑（3x3 邻域容错） */
function hitHotRects (rects, lx, ly) {
  for (const r of rects) {
    if (!(lx >= r.x && lx <= r.x + r.width && ly >= r.y && ly <= r.y + r.height)) continue
    if (r.pixel && r.mask && r.mask.alpha) {
      const mx = Math.floor(((lx - r.x) / r.width) * r.mask.w)
      const my = Math.floor(((ly - r.y) / r.height) * r.mask.h)
      let hit = false
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = mx + dx
          const py = my + dy
          if (px < 0 || py < 0 || px >= r.mask.w || py >= r.mask.h) continue
          if (r.mask.alpha[py * r.mask.w + px] > 16) { hit = true; break }
        }
      }
      if (!hit) continue
    }
    return true
  }
  return false
}

/* ------------------------------------------------------------------ 工具 */

function toUrl (p) {
  if (!p) return ''
  const abs = p.replace(/\\/g, '/')
  if (!/^[a-zA-Z]:\//.test(abs)) return ''
  // 封面 / 壁纸文件被删掉或还没下完时别给渲染进程一个必然 404 的地址，
  // 让它退回文字色块，而不是一块黑
  try {
    if (!fs.existsSync(abs)) return ''
  } catch {
    return ''
  }
  return 'aura://local/' + encodeURI(abs)
}

/* 显示器的配置键必须跨重启稳定：Windows 上 display.id 是枚举时分配的，
   重启后可能变，导致按屏存的设置（主屏隐藏等）对不上号而全部回默认。
   EDID 是显示器硬件身份（厂商/型号/序列号），拔插、重启都不变，
   用它做主键；拿不到 EDID 的极少数情况退回旧的 display.id。 */
const crypto = require('node:crypto')
const displayKeyCache = new Map() // display.id -> 稳定 key（buildOverlays 时填充）

function edidKeyOf (display) {
  const e = display.edid
  if (!e) return null
  const raw = [e.manufacturer, e.productCode, e.serialNumber, e.yearOfManufacture]
    .map((x) => (x == null ? '' : String(x))).join('|')
  if (!raw.replace(/\|/g, '')) return null
  return 'e_' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10)
}

/** 给当前所有显示器分配稳定 key（同一批次内保证唯一、所有调用点一致） */
function assignDisplayKeys (displays) {
  const used = new Map()
  displayKeyCache.clear()
  const sorted = [...displays].sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y))
  for (const d of sorted) {
    let key = edidKeyOf(d) || 'd' + d.id
    const n = used.get(key) || 0
    used.set(key, n + 1)
    if (n > 0) key += '_' + n // 两台完全同型号同序列号的显示器才走这里
    displayKeyCache.set(d.id, key)
  }
}

function displayKey (display) {
  if (displayKeyCache.has(display.id)) return displayKeyCache.get(display.id)
  return edidKeyOf(display) || 'd' + display.id
}

/**
 * 老配置的键是 display.id（跨重启不稳定）。启动时对不上号的屏幕，
 * 按上一次记录的分辨率/几何信息找回旧配置条目并搬到新键下。
 */
function reconcileDisplayKeys () {
  const cfg = store.get()
  const displays = screen.getAllDisplays()
  const curKeys = new Set(displays.map((d) => displayKey(d)))
  const free = Object.keys(cfg.displays).filter((k) => !curKeys.has(k))
  if (!free.length) return
  let moved = 0
  for (const d of displays) {
    const key = displayKey(d)
    if (cfg.displays[key]) continue
    // 先按「分辨率+摆放位置」精确匹配（同分辨率双屏时避免把 A 屏配置安到 B 屏）；
    // 老条目没记位置则退回仅按分辨率
    const withPos = free.find((k) => {
      const lb = cfg.displays[k] && cfg.displays[k].lastBounds
      return lb && lb.x != null && lb.w === d.bounds.width && lb.h === d.bounds.height &&
             lb.x === d.bounds.x && lb.y === d.bounds.y
    })
    const sigOnly = free.find((k) => {
      const lb = cfg.displays[k] && cfg.displays[k].lastBounds
      return lb && (lb.w + 'x' + lb.h) === (d.bounds.width + 'x' + d.bounds.height)
    })
    const hit = withPos || sigOnly
    if (hit) {
      log('[display] 屏幕 ' + d.bounds.width + 'x' + d.bounds.height + '@' + d.bounds.x + ',' + d.bounds.y +
          ' 按' + (withPos ? '分辨率+位置' : '分辨率') + '找回旧配置 ' + hit)
      cfg.displays[key] = cfg.displays[hit]
      delete cfg.displays[hit]
      free.splice(free.indexOf(hit), 1)
      moved++
    }
  }
  if (moved) {
    store.save()
    console.log('[display] 按几何信息迁移了 ' + moved + ' 个屏幕配置')
  }
}

function primaryKey () {
  const p = screen.getPrimaryDisplay()
  return displayKey(p)
}

/* --------------------------------------------------- OBS 画面导出（0.19.0）
 * 抓「已经在屏幕上跑的那个桌面层窗口」的帧，而不是另开一个渲染窗口——
 * 屏幕上什么样，OBS 里就什么样，也不会有第二套渲染逻辑要维护。
 */
const obs = require('./obs')

/** OBS 抓哪块屏：配置指定 → 主屏 → 任意一个已建好的桌面层 */
function obsSource () {
  const g = store.get().global
  const pick = (key) => {
    const w = key && overlayWins.get(key)
    return w && !w.isDestroyed() ? w.webContents : null
  }
  // 0.24.0：优先抓「角色现在所在屏」的 overlay——非宿主屏空闲时会把角色隐藏，
  // 固定抓某块屏拿到的是空壁纸（手机上看就是一片黑）；每帧都取，跨屏自动跟
  try {
    const pos = require('./companion/pet').getPos()
    if (pos && pos.x != null) {
      const d = screen.getAllDisplays().find((dd) =>
        pos.x >= dd.bounds.x && pos.x < dd.bounds.x + dd.bounds.width &&
        pos.y >= dd.bounds.y && pos.y < dd.bounds.y + dd.bounds.height)
      if (d) {
        const w = pick(displayKey(d))
        if (w) return w
      }
    }
  } catch { }
  return pick(g.obsScreen) || pick(primaryKey()) || (() => {
    for (const [, w] of overlayWins) if (w && !w.isDestroyed()) return w.webContents
    return null
  })()
}

/** 随身服务满屏形象：围绕角色的竖屏（9:16）裁剪区域（DIP，相对被抓窗口，frameW 供像素换算）。
 *  角色舞台 = 300×520 × petScale（overlay/pet.js 的 .petstage）；
 *  pos = 舞台锚点 = 底边中点（overlay/pet.js「stage 底边中点」全局 DIP 坐标） */
function obsRegion () {
  try {
    const wc = obsSource()
    if (!wc) return null
    let win = null
    for (const [, w] of overlayWins) {
      if (w && !w.isDestroyed() && w.webContents === wc) { win = w; break }
    }
    if (!win) return null
    const pos = require('./companion/pet').getPos()
    if (!pos || pos.x == null) return null
    const scale = Number((store.get().global.companion || {}).petScale) || 1
    const stH = Math.round(520 * scale)
    const wb = win.getContentBounds()
    const cx = pos.x - wb.x // 锚点 x = 角色水平中心
    const bottom = pos.y - wb.y // 锚点 y = 脚底
    let h = Math.round(stH * 1.35)
    let w = Math.round(h * 9 / 16)
    let x = Math.round(cx - w / 2)
    let y = Math.round(bottom - h * 0.88) // 脚在画面 88% 高度，头上有留白
    if (x < 0) x = 0
    if (y < 0) y = 0
    if (x + w > wb.width) x = Math.max(0, wb.width - w)
    if (y + h > wb.height) y = Math.max(0, wb.height - h)
    if (w > wb.width || h > wb.height) return null // 窗口比目标区域还小（少见），回退整帧
    return { x, y, width: w, height: h, frameW: wb.width }
  } catch { return null }
}

/** 让服务状态跟配置一致（开关、端口、帧率变了才动） */
function syncObs () {
  const g = store.get().global
  const st = obs.status()
  if (!g.obsEnabled) {
    if (st.running) obs.stop()
    return st
  }
  const wantPort = Number(g.obsPort) || 8712
  const wantFps = Math.max(1, Math.min(30, Number(g.obsFps) || 10))
  if (st.running && st.wantedPort === wantPort && st.fps === wantFps) return obs.status()
  if (st.running) obs.stop()
  obs.start({ port: wantPort, fps: wantFps, getWebContents: obsSource, getRegion: obsRegion, log })
  // 0.24.0 随身服务要知道角色画面流在哪个口（手机页面内嵌 iframe 用）
  try { require('./companion').setObsPortGetter(() => { const s = obs.status(); return s.running ? s.port : 0 }) } catch { }
  return obs.status()
}

/** 组装给渲染进程的载荷（路径统一转成 aura:// URL）——精简版：桌面层只剩壁纸/缩放/桌宠 */
function payloadForKey (key) {
  const cfg = store.get()
  const display = key === 'demo'
    ? { id: 'demo', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, primary: true }
    : (screen.getAllDisplays().find((d) => displayKey(d) === key) || screen.getPrimaryDisplay())

  let dcfg = store.displayCfg(key)

  // 跟随主屏：只镜像壁纸，界面开关与缩放任然独立
  const pk = primaryKey()
  if (key !== 'demo' && key !== pk && dcfg.followPrimary && store.get().displays[pk]) {
    const p = store.get().displays[pk]
    dcfg = { ...dcfg, wallpaper: p.wallpaper }
  }

  return {
    key,
    screen: {
      width: display.bounds.width,
      height: display.bounds.height,
      scaleFactor: display.scaleFactor,
      primary: !!display.primary,
      label: display.label || ''
    },
    demo: false,
    cfg: { ...dcfg, wallpaper: { ...dcfg.wallpaper, url: toUrl(dcfg.wallpaper.path) } }
  }
}

/* ------------------------------------------------------------ 覆盖层窗口 */

/* 角色层的窗口层级。
   背景：AuraDesk 的卡片条是 setAlwaysOnTop(true,'screen-saver') 的置顶窗口，
   而角色层以前只是普通窗口 → 重叠部分直接压住角色：鼠标落在卡片上（拖不动
   角色），Windows 还会把被完整覆盖的透明窗口判为遮挡，Chromium 随之挂起
   合成（表现：角色只显示半截 / 画面静止）。
   对策：角色层也用 screen-saver 级。同级的 topmost 窗口之间比的是「最近一次
   SetWindowPos 的先后」，所以创建后、显示后还要定期把角色层排到队首。 */
function applyTopLevel (win) {
  if (!win || win.isDestroyed()) return
  const on = !!store.get().global.alwaysOnTop
  try { win.setAlwaysOnTop(on, on ? 'screen-saver' : 'normal') } catch {}
}

/* 拖拽期间禁止再动窗口层级：SetAlwaysOnTop/SetIgnoreMouseEvents 会改变窗口的
   扩展样式与 Z 序，跨屏那一刻正好在改 → Windows 收走鼠标捕获，浏览器派发
   pointercancel，拖拽断在屏幕边界（用户报的「拖不到另一个屏幕」）。 */
let isPetDragging = () => false

/** 触摸 → 助手核心（懒加载，避免与 assistant init 的顺序耦合） */
function notifyTouch (part) {
  try { require('./assistant').noteTouch(part) } catch { /* 核心没就绪就忽略 */ }
}

function raiseOverlays (force) {
  if (!store.get().global.alwaysOnTop) return
  if (!force && isPetDragging()) return
  for (const [, w] of overlayWins) {
    if (w.isDestroyed() || !w.isVisible()) continue
    // 重复设置同一个层级 = 一次 HWND_TOPMOST 的 SetWindowPos，把窗口提到同级队首
    try { w.setAlwaysOnTop(true, 'screen-saver') } catch {}
  }
}

/* 全屏时整层让位（修「打开应用/浏览器全屏视频黑掉、屏幕闪屏」）：
 * 前台全屏时，全屏大小的透明置顶 overlay 会把前台应用从 MPO/独立翻转
 * 降级回组合合成 → 全屏视频黑帧、屏幕闪。只收起角色（petStage hidden）
 * 救不了——窗口本身还盖在屏幕上。这里把 overlay 整个 hide：
 * backgroundThrottling:false，隐藏后音频/语音/会话照常跑，全屏退出再回来。
 * fsHidden 只记「因全屏让位而隐藏」的窗口，NORMAL 时只放回这些，
 * 不会跟托盘「隐藏桌面层」的手动隐藏打架。 */
const fsHidden = new Set()
let userHidesOverlays = false // 托盘手动隐藏 = true，全屏恢复时别强行顶回去
/** 「全屏游戏/视频时自动隐藏角色」开关（设置 petFullscreenHide，默认开）。
 *  0.22.0 修复：整层让位以前不看这个开关——用户关掉后全屏时角色照样消失，
 *  根因就是 syncOverlaysFullscreen 无条件 hide 整个 overlay 层。 */
function petFullscreenHideOn () {
  try {
    const g = store.get()
    const c = (g.global && g.global.companion) || {}
    return c.petFullscreenHide !== false
  } catch { return true }
}
function syncOverlaysFullscreen (isFull) {
  if (CAPTURE) return
  // 开关关着 → 全屏按 NORMAL 处理；之前因全屏收起的层会走下面的放回分支
  if (isFull && !petFullscreenHideOn()) isFull = false
  if (isPetDragging()) return // 拖拽铁律：期间禁动窗口层级（收起/放回都一样）
  let restored = false
  for (const [key, w] of overlayWins) {
    if (!w || w.isDestroyed()) continue
    try {
      if (isFull) {
        if (fsHidden.has(key)) continue
        fsHidden.add(key)
        if (w.isVisible()) {
          log('[fullscreen] overlay 整层让位 key=' + key + '（防全屏视频黑帧/闪屏）')
          w.hide()
        }
      } else if (fsHidden.has(key)) {
        fsHidden.delete(key)
        if (!userHidesOverlays) {
          restored = true
          w.showInactive()
          // v0.22.1 修复「全屏切回来后角色摸不到」：这里原来硬编码
          // setIgnoreMouseEvents(true, { forward: true })，是 0.6.0 之前的
          // 老基线残留。forward 穿透窗口点击会直接落到下层；而 80ms 光标轮询
          // 的翻转条件是 overlayInteractive.get(key) !== hot——若隐藏前刚好
          // 摸着角色（interactive=true）或 rects 恰好为空被 continue，这条
          // forward 穿透就永远没机会被翻转 → 恢复显示后点角色全部穿透。
          // 改走 overlayBaseline：重置 interactive=false + 按 0.6.0 基线设穿透。
          overlayBaseline(w)
          applyTopLevel(w)
          try { require('./companion/pet').pushTo(w) } catch { }
        }
      }
    } catch (e) { log('[fullscreen] overlay 让位失败:', e && e.message) }
  }
  if (restored) raiseOverlays(true)
}

function createOverlay (key, display, opts = {}) {
  if (overlayWins.has(key)) return overlayWins.get(key)

  const b = display.bounds
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: CAPTURE ? 1600 : b.width,
    height: CAPTURE ? 900 : b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true
    }
  })

  winKey.set(win.webContents.id, key)
  overlayWins.set(key, win)

  win.loadFile(path.join(__dirname, '../renderer/overlay/index.html'), {
    query: { key, capture: CAPTURE ? '1' : '' }
  })

  // 诊断全链路：overlay 渲染层的日志/报错必须留痕（桌面层曾因无转发成盲区，
  // pet.js 语法错误导致整层空白都查不到）
  {
    const owc = win.webContents
    const short = (u) => String(u || '').split('/').pop()
    owc.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 1) log('[overlay] 渲染层:', message, '@', short(sourceId) + ':' + line)
    })
    owc.on('did-fail-load', (_e, code, desc, url) => log('[overlay] 加载失败', code, desc, url))
    owc.on('preload-error', (_e, p, err) => log('[overlay] preload 报错:', p, err && err.message))
    // v0.4.3 关键修复：渲染层就绪后补发全量桌宠状态（角色/位置/缩放）。
    // 此前第二块屏的渲染层比 boot 广播慢，永远错过角色卡 → 跨屏拖过去角色消失
    owc.on('did-finish-load', () => {
      try { require('./companion/pet').pushTo(win) } catch (e) { log('[overlay] 补发桌宠状态失败:', e.message) }
    })
  }

  win.once('ready-to-show', () => {
    // 启动防黑屏闸：首轮全屏检测结果（最多等 4s，探测进程挂了也能等到超时）
    // 出来之前不上屏——开机瞬间前台正全屏的话，直接进让位集合等 NORMAL 再放，
    // 避免「打开应用 → 全屏透明层立刻踢 MPO → 全屏视频黑一下」
    const fsMod = require('./fullscreen')
    const showNow = () => {
      if (win.isDestroyed()) return
      if (!CAPTURE && fsMod.isFull()) { fsHidden.add(key); return }
      win.showInactive()
      // 默认整窗穿透 + 转发鼠标事件：渲染层判断光标是否在热元素上，动态切换穿透
      // （v0.3.38 弃用 setShape——SetWindowRgn 裁剪视觉，导致角色灰框/拖动裁剪）
      win.setIgnoreMouseEvents(true, { forward: true })
      // screen-saver 级：与 AuraDesk 卡片条同级，再靠 raiseOverlays 排到队首，
      // 否则卡片会盖住角色（拖不动 + 合成被挂起 → 角色显示不全）
      applyTopLevel(win)
      if (CAPTURE) win.setAlwaysOnTop(true, 'screen-saver')
      raiseOverlays()
      // 合成兜底：周期性强制触发一次合成帧调度。透明常驻窗口被 Chromium 判为
      // 「无自主上屏需求」时，invalidate 是把 BeginFrame 叫醒的最直接手段。
      // 频率必须很低：invalidate 是全窗重画，40ms 一次 × 每块屏会把 GPU/DWM 打满，
      // 系统光标开始发飘（0.5.2 实测 GPU 进程占 64%）。1s 一次足够，动画帧由渲染层
      // 自己的 setInterval 驱动；窗口不可见/最小化时跳过。
      setInterval(() => {
        try {
          if (!win.isDestroyed() && win.isVisible() && !win.isMinimized()) win.webContents.invalidate()
        } catch {}
      }, 1000)
    }
    Promise.race([fsMod.whenChecked(), new Promise((ok) => setTimeout(ok, 4000))]).then(showNow)
  })
  // 从托盘/快捷键重新显示后也要抢回队首（期间可能被卡片条或其它置顶窗压下去）
  win.on('show', () => setTimeout(raiseOverlays, 30))

  win.on('closed', () => {
    overlayWins.delete(key)
    hotRectsByWin.delete(key)
    overlayInteractive.delete(key)
  })

  // 用户按 Win+D 显示桌面时，把覆盖层重新叫到桌面之上
  win.on('blur', () => {
    if (!win.isDestroyed() && win.isVisible()) {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isFocused()) win.setSkipTaskbar(true)
      }, 50)
    }
  })

  return win
}

/* v4 及以前只有一个「只在主屏显示」的总开关。现在改成每屏独立开关，
   这里把老配置换算过去：原来被这个开关藏掉的副屏，标记为本屏不显示。 */
function migratePrimaryOnly () {
  const cfg = store.get()
  if (!cfg.global.primaryOnly) return
  const pKey = primaryKey()
  for (const [key, d] of Object.entries(cfg.displays)) {
    if (key === pKey || !d || !d.ui) continue
    d.ui.enabled = false
  }
  cfg.global.primaryOnly = false
  store.save()
  console.log('[migrate] 「只在主屏显示」已拆成每屏开关')
}

function buildOverlays () {
  const displays = screen.getAllDisplays()
  assignDisplayKeys(displays)
  reconcileDisplayKeys()
  const pKey = primaryKey()
  const present = new Set()

  for (const d of displays) {
    const key = displayKey(d)
    const cfg = store.ensureDisplay(key, { primary: key === pKey, primaryKey: pKey })
    // 记录几何信息（含摆放位置），供 EDID 变化/拿不到 EDID（display.id 漂移）后
    // 按分辨率+位置找回配置。只记 w/h 会让同分辨率双屏的重对变成掷硬币
    const lb = { w: d.bounds.width, h: d.bounds.height, x: d.bounds.x, y: d.bounds.y }
    if (!cfg.lastBounds || cfg.lastBounds.w !== lb.w || cfg.lastBounds.h !== lb.h ||
        cfg.lastBounds.x !== lb.x || cfg.lastBounds.y !== lb.y) {
      cfg.lastBounds = lb
      store.save()
    }
    // 每屏独立开关：关掉的那块屏不建窗口，连透明覆盖层都没有。
    // 必须留痕——2026-10-20 跨屏拖拽查了四版，最后发现是这块屏的开关被关了
    if (cfg.ui && cfg.ui.enabled === false) {
      log('[overlay] 屏幕 key=' + key + ' 显示开关=关 → 不创建窗口（config.json 里 ui.enabled）')
      continue
    }
    present.add(key)
    log('[overlay] 屏幕 key=' + key + ' ' + d.bounds.width + 'x' + d.bounds.height + '@' + d.bounds.x + ',' + d.bounds.y + ' → 创建窗口')
    createOverlay(key, d)
  }

  for (const [key, win] of [...overlayWins]) {
    if (!present.has(key)) {
      if (!win.isDestroyed()) win.destroy()
      overlayWins.delete(key)
      hotRectsByWin.delete(key)
      overlayInteractive.delete(key)
    }
  }

  syncBounds()
}

function syncBounds () {
  for (const [key, win] of overlayWins) {
    if (key === 'demo' || win.isDestroyed()) continue
    const d = screen.getAllDisplays().find((x) => displayKey(x) === key)
    if (!d) continue
    win.setBounds(d.bounds)
  }
}

function refreshAllOverlays () {
  for (const [, win] of overlayWins) {
    if (win.isDestroyed()) continue
    win.webContents.send('overlay:config', payloadForKey(winKey.get(win.webContents.id)))
  }
}

/* -------------------------------------------------------------- 设置窗口
 * 0.22.0 补丁⑥：AuraDesk 遗留的独立设置窗口已删除（显示器壁纸/游戏库/音乐库
 * 这些桌面启动器时代的面板在 Ryza 里根本没有对应功能），真功能（她的记录 /
 * 负反馈 / 快捷键 / 数据目录 / OBS 导出）全部迁进角色设置窗口
 * （renderer/companion，data-sp="mind" 分页 + general/pet 分页）。
 * 全局配置的写入仍走 settings:patch-global 既有通道。
 */

function displayList () {
  const pKey = primaryKey()
  return screen.getAllDisplays()
    .sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y))
    .map((d, i) => {
      const key = displayKey(d)
      const cfg = store.ensureDisplay(key, { primary: key === pKey, primaryKey: pKey })
      return {
        key,
        index: i + 1,
        label: cfg.label || (key === pKey ? '主屏' : `显示器 ${i + 1}`),
        primary: key === pKey,
        width: d.bounds.width,
        height: d.bounds.height,
        x: d.bounds.x,
        y: d.bounds.y,
        scaleFactor: d.scaleFactor,
        cfg: { ...cfg, wallpaper: { ...cfg.wallpaper, url: toUrl(cfg.wallpaper.path) } }
      }
    })
}

/* ---------------------------------------------------------------- 托盘 */

let tray = null

function toggleOverlays () {
  const anyVisible = [...overlayWins.values()].some((w) => !w.isDestroyed() && w.isVisible())
  for (const [, w] of overlayWins) {
    if (w.isDestroyed()) continue
    if (anyVisible) w.hide()
    else w.showInactive()
  }
  userHidesOverlays = !!anyVisible // 手动全藏了：全屏让位恢复时别强行顶回去
  refreshTrayMenu()
  return !anyVisible
}

function refreshTrayMenu () {
  if (!tray || tray.isDestroyed()) return
  const g = store.get().global
  const visible = [...overlayWins.values()].some((w) => !w.isDestroyed() && w.isVisible())
  tray.setContextMenu(Menu.buildFromTemplate([
    // 只有一个界面：聊天和角色是同一窗口的两个视图（不再分「角色管理」和「助手聊天」两个窗）
    { label: '打开 Partner.execute(me);（聊天）…', click: () => companion.createWindow('chat') },
    // 电脑操作入口直接放托盘：不用再找聊天窗右上角的小按钮
    { label: '电脑操作（看屏幕/点按钮）…', click: () => { try { assistant.openCuaPanel() } catch (e) { log('[tray] 电脑面板打不开：' + e.message) } } },
    { label: '角色 / 形象 / 语音…', click: () => companion.createWindow('char') },
    {
      label: '切换角色',
      submenu: assistant.trayRoles().map((r) => ({
        label: r.name,
        type: 'checkbox',
        checked: r.current,
        click: () => {
          // 形象与人格一起切：桌宠/主窗里显示的角色和聊天人格始终是同一个
          companion.switchChar(r.id)
          assistant.switchRole(r.id)
        }
      })).concat(assistant.trayRoles().length ? [] : [{ label: '（助手核心启动中…）', enabled: false }])
    },
    { label: '角色设置…', click: () => companion.createWindow('settings') },
    {
      // 0.22.0 补丁⑧：学习中显示「结束学习」，没学显示「开始学习」；点击后刷新菜单态
      label: companion.studyActive() ? '结束学习（她在陪你学）' : '开始学习（让她陪你）',
      click: async () => {
        try {
          const r = companion.studyActive() ? await companion.studyStop() : await companion.studyStart()
          if (!r.ok && r.reason === 'no-api') log('[tray] 学习模式开不了：还没配置 AI 服务')
        } catch (e) { log('[tray] 学习模式切换失败：' + e.message) }
        setTimeout(refreshTrayMenu, 60)
      }
    },
    { label: visible ? '隐藏桌面层' : '显示桌面层', accelerator: g.hotkeyToggle || undefined, click: toggleOverlays },
    {
      label: '游戏模式（角色躲到角落）',
      type: 'checkbox',
      checked: gameMode.isActive(),
      click: (item) => {
        const r = gameMode.toggle(item.checked, 'tray')
        if (r && r.on === false && r.reason) log('[tray] 游戏模式未开启：' + r.reason)
        setTimeout(refreshTrayMenu, 60)
      }
    },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: !!g.autoLaunch,
      click: (item) => {
        store.patchGlobal({ autoLaunch: item.checked })
        try {
          app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: ['--silent'] })
        } catch {}
        refreshTrayMenu()
      }
    },
    { label: '打开配置目录', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    {
      label: '退出 Partner.execute(me);',
      click: () => {
        store.flush()
        app.quit()
      }
    }
  ]))
}

function createTray () {
  if (tray && !tray.isDestroyed()) return
  try {
    const dir = path.join(__dirname, 'resources')
    let img = nativeImage.createFromPath(path.join(dir, 'tray-32.png'))
    if (img.isEmpty()) img = nativeImage.createFromPath(path.join(dir, 'tray-64.png'))
    tray = new Tray(img)
    tray.setToolTip('Partner.execute(me);')
    // 左键图标 = 打开主界面（聊天）；不再跳去「桌面层设置」那套 AuraDesk 风格的界面
    tray.on('click', () => companion.createWindow('chat'))
    tray.on('double-click', () => companion.createWindow('chat'))
    // 学习模式开/收时托盘菜单文案联动（companion 侧 studyTrayPoke 回调这里）
    try { companion.setStudyTrayRefresh(() => refreshTrayMenu()) } catch { }
    refreshTrayMenu()
  } catch (err) {
    console.warn('[tray] 创建失败', err)
    tray = null
  }
}

function registerShortcuts () {
  globalShortcut.unregisterAll()
  const g = store.get().global
  try {
    if (g.hotkeyToggle) globalShortcut.register(g.hotkeyToggle, toggleOverlays)
    // 0.18.0 第二批：全局说话键 / 打字键。桌宠被别的窗口挡着、人在游戏里，
    // 也不用先去找角色 —— 按一下就能说话或打字。
    // 注意：Electron 的 globalShortcut 只有 keydown 没有 keyup，
    // 所以「按住说话」在这里是「按一下开始录、再按一下结束」，不是真正的按住。
    if (g.hotkeyType) {
      const ok = globalShortcut.register(g.hotkeyType, () => {
        showOverlaysIfHidden()
        bcastOverlay('pet:cmd', { kind: 'open-input' })
      })
      if (!ok) console.warn('[hotkey] 打字键注册失败（可能被别的软件占用）：' + g.hotkeyType)
    }
    if (g.hotkeyTalk) {
      const ok = globalShortcut.register(g.hotkeyTalk, () => {
        showOverlaysIfHidden()
        bcastOverlay('pet:cmd', { kind: 'mic-toggle' })
      })
      if (!ok) console.warn('[hotkey] 说话键注册失败（可能被别的软件占用）：' + g.hotkeyTalk)
    }
  } catch (err) {
    console.warn('[hotkey] 注册失败', err)
  }
  refreshTrayMenu()
}

/** 把命令发给所有覆盖层（桌宠只在角色所在那块屏执行，多余的会自己忽略） */
function bcastOverlay (channel, payload) {
  for (const [, w] of overlayWins) {
    if (!w || w.isDestroyed()) continue
    try { w.webContents.send(channel, payload) } catch {}
  }
}

/** 热键触发时如果桌面层被藏起来了，先放出来（否则录了音也看不见反应） */
function showOverlaysIfHidden () {
  let anyHidden = false
  for (const [, w] of overlayWins) {
    if (!w || w.isDestroyed() || w.isVisible()) continue
    anyHidden = true
    try { w.showInactive() } catch {}
  }
  if (anyHidden) { userHidesOverlays = false; refreshTrayMenu() }
}

// Windows 原生遮挡计算会把置底/透明/穿透窗口判定为「被遮挡」而暂停其合成帧，
// 桌宠等常驻透明窗口的 rAF/渲染会被冻结在第一帧。禁用该特性才能让画面持续刷新
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
// 同类问题第二层：窗口被判遮挡后 renderer 会整体被挂起（上屏停住）。
// 实测 renderer 在产帧（canvas 位图在变）但屏幕不动，必须再禁掉这个
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
// 同类问题第三层：renderer 进程整体「后台化」降级（timer/rAF/合成全被节流）。
// 0.3.25 心跳证实：动画时间在涨、GL 在画，但屏幕冻结在第一帧 → renderer 呈现被节流
app.commandLine.appendSwitch('disable-renderer-backgrounding')
// 2D canvas 走 CPU 光栅化：本机 GPU 合成对透明窗口中的 canvas 纹理层有 bug
// （角色区域灰框/薄纱，内容位图实测干净）。canvas 变软件位图后合成路径不同可绕开；
// 桌宠画布仅 300x520，CPU 光栅化无压力。注意：不可用 disable-gpu-compositing
// （0.3.20 实测会把透明窗口整体变灰）
app.commandLine.appendSwitch('disable-accelerated-2d-canvas')
// 注意：不要加 disable-gpu-compositing——软件合成会把透明窗口底色变灰
// （0.3.20 实测翻车）。桌宠已改为渲染进 overlay 窗口，不再依赖独立透明小窗口

app.whenReady().then(async () => {
  // 数据目录继承：换过目录/丢了数据时，当前目录是空的但附近有旧数据 → 先问主人
  // 除「新建空数据」外都会 app.relaunch()，所以这里的 return 就是让本轮直接结束
  if (!CAPTURE) {
    try {
      const dd = await datadir.ensureData({ app, dialog, log })
      if (dd.restarted) return
    } catch (e) { log('[datadir] 继承询问异常: ' + (e && e.message)) }
  }
  // 常驻透明桌面层依赖持续合成上屏：阻止系统/Chromium 出于节能挂起渲染
  try {
    const psbId = powerSaveBlocker.start('prevent-app-suspension')
    log('[boot] powerSaveBlocker prevent-app-suspension started, id=' + psbId)
  } catch (e) { log('[boot] powerSaveBlocker 启动失败: ' + e.message) }
  protocol.handle('aura', async (request) => {
    const u = new URL(request.url)
    const abs = decodeURIComponent(u.pathname.replace(/^\//, ''))
    const res = await net.fetch(pathToFileURL(abs).toString())
    // spine 贴图走 Image + crossOrigin=anonymous，Chromium 要求 CORS 头，否则 Couldn't load image
    const headers = new Headers({ 'access-control-allow-origin': '*' })
    const ct = res.headers.get('content-type')
    if (ct) headers.set('content-type', ct)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  })

  if (CAPTURE) return runCaptureMinimal()

  log('[boot] 显示器: ' + JSON.stringify(screen.getAllDisplays().map((d) => ({ w: d.bounds.width, h: d.bounds.height, primary: d.id === screen.getPrimaryDisplay().id }))))
  migratePrimaryOnly()
  // S2 全屏让位必须在 buildOverlays 之前启动：ready-to-show 的启动防黑屏闸
  // 要等首轮检测结果；探测进程是 PowerShell 子进程，spawn+首轮要 1s 上下
  const fullscreen = require('./fullscreen')
  // 0.45.13 游戏模式自动进入：前台是全屏游戏/已知游戏进程 → 像她「自己发现」一样
  // 缩到角落；全屏结束自动恢复。判定纯函数在 gameAuto.js（可单测），这里只接线。
  const gameAuto = require('./gameAuto')
  const gameModeMod = require('./gameMode')
  let gameAutoSt = gameAuto.freshState(Date.now())
  let gameAwayLogged = false
  const gameAutoTick = () => {
    try {
      const cc = (store.get().global && store.get().global.companion) || {}
      const info = fullscreen.info()
      const fg = fullscreen.foreground() || {}
      // 0.45.73 离开宽限：打游戏时会切出去回消息/刷视频/查攻略，宽限期内不算离开
      const leaveMin = Number(cc.gameAutoLeaveMin)
      const r = gameAuto.tick(gameAutoSt, {
        now: Date.now(),
        full: fullscreen.isFull() && !!info,
        pname: (info && info.name) || fg.name || '',
        gameActive: gameModeMod.isActive(),
        gameEnteredBy: gameModeMod.state().by,
        enabled: cc.gameMode !== false && cc.gameAutoOn !== false,
        leaveMs: (leaveMin > 0 ? Math.min(60, leaveMin) : 3) * 60 * 1000,
        knownGames: ['ffxiv_dx11', 'ffxiv', 'starrail', 'yuanshen', 'genshinimpact', 'zenlesszonezero', 'honkaistarrail'].concat(Array.isArray(cc.gameAutoProcesses) ? cc.gameAutoProcesses : [])
      })
      gameAutoSt = r.st
      if (r.action === 'enter') {
        const res = gameModeMod.enter(r.reason, { resume: !!r.resume, name: String(r.name || '') })
        log('[gameAuto] 自动进入游戏模式 ' + (r.detail || r.reason) + ' → ' + JSON.stringify(res))
        if (r.resume) log('[gameAuto] 续上一场：累计 ' + Math.round(gameModeMod.sessionMs() / 60000) + ' 分钟')
        try { refreshTrayMenu() } catch { }
      } else if (r.action === 'exit') {
        // 0.45.73：因为「切出去太久」而退出的，别说「起来伸个懒腰」——他多半还在电脑前
        gameModeMod.exit(r.reason, { quiet: /游戏外超过/.test(String(r.reason)) })
        log('[gameAuto] 自动退出游戏模式: ' + r.reason)
        try { refreshTrayMenu() } catch { }
      } else if (r.reason === 'away-start') {
        log('[gameAuto] 切出游戏了（窗还在，' + Math.max(1, Math.round((leaveMin > 0 ? leaveMin : 3))) + ' 分钟内回来不算离开）')
      }
    } catch (e) { log('[gameAuto] tick 失败: ' + (e && e.message)) }
  }
  fullscreen.start((isFull) => {
    try { require('./companion/pet').setSuspended(isFull) } catch { }
    try { syncOverlaysFullscreen(isFull) } catch (e) { log('[fullscreen] 整层让位失败:', e && e.message) }
    // 全屏状态变化时也评一次（延迟半秒等探测进程把进程名吐出来）
    setTimeout(gameAutoTick, 600)
  })
  setInterval(gameAutoTick, 30 * 1000)
  buildOverlays()
  // OBS 导出要在桌面层建好之后才拿得到窗口；开关关着时这里什么也不做
  try { syncObs() } catch (e) { log('[obs] 初始化失败: ' + (e && e.message)) }
  /** 向所有覆盖层广播（助手/桌宠事件） */
  const broadcastAll = (ch, data) => {
    for (const [, w] of overlayWins) {
      if (!w.isDestroyed()) w.webContents.send(ch, data)
    }
    // 主窗口也在聊同一场对话：它必须收到流式增量，否则界面里没有回话
    const mw = companion.getWindow && companion.getWindow()
    if (mw && !mw.isDestroyed()) { try { mw.webContents.send(ch, data) } catch {} }
  }
  // AI 伴侣模块：仅保留角色资产/语音/ASR 基础设施 IPC（聊天窗已移除）
  companion.registerIpc()
  companion.setOverlayBroadcast(broadcastAll)
  // 0.22.0：设置里改「全屏自动隐藏角色」时，让伴侣模块回调重排 overlay 整层
  companion.setFullscreenSync(syncOverlaysFullscreen)
  // 自查用：带环境变量 RYZA_OPEN_PANEL=1 启动会自动打开伴侣面板，
  // 方便量 CPU / 看渲染层日志；正常双击启动不受影响
  // （命令行 --panel 会被 Chromium 当成未知开关拒掉，所以走环境变量）
  if (process.env.RYZA_OPEN_PANEL) setTimeout(() => companion.createWindow('chat'), 1500)
  // AI 助手核心：会话/多角色/记忆
  assistant.init({
    logDir: path.join(app.getPath('userData'), 'logs'),
    dataRoot: app.getPath('userData'),
    bcast: broadcastAll
  }).then(() => {
    // S8：刷B站（值班轮复用助手的厂商配置；core 没就绪时 getProvider 返回 null，duty 自己兜）
    try { require('./bili').init({ dataRoot: app.getPath('userData'), getProvider: assistant.getProvider }) } catch (e) { log('[bili] 挂载失败:', e.message) }
    // S11：群聊接入（OneBot 11 ← NapCatQQ 协议端；人设走 assistant.getContext，跟桌面同一个她）
    try {
      const imMod = require('./im').init({ dataRoot: app.getPath('userData'), log, assistant })
      // 0.45.12 桥接：她不在电脑前时可以主动在 QQ 上找主人（companion 的 reach 通道）
      try {
        require('./companion').setImApi({
          connected: () => !!(imMod && imMod.client && imMod.client.status && imMod.client.status().phase === 'ready'),
          cfg: () => (imMod && imMod.brain ? imMod.brain.loadCfg() : null),
          sendPrivate: async (uid, text) => {
            if (!imMod || !imMod.client) throw new Error('还没连接')
            await imMod.client.call('send_private_msg', { user_id: Number(uid), message: [{ type: 'text', data: { text } }] })
          }
        })
      } catch (e) { log('[im] QQ 主动找人桥接失败:', e.message) }
    } catch (e) { log('[im] 挂载失败:', e.message) }
    // S10：World 扩展体系（装载在 assistant 之后：工具表/提示词桥需要 core 就绪）
    try { require('./world/ipc').init({ dataRoot: app.getPath('userData') }) } catch (e) { log('[world] 挂载失败:', e.message) }
  }).catch((e) => log('[assistant] 初始化失败:', e.message, e.stack))
  /* S6：电脑操作（CUA）的两个进程级接线
   * ① 引擎是独立子进程，退出必须收掉，否则留下一个抓着屏幕 DC 的孤儿
   * ② 动作执行期间把所有桌面层窗口设成完全穿透：否则她要点的地方正好被
   *    角色挡着（角色层是 screen-saver 级置顶），点击会落到角色身上 */
  const cuaMod = require('./cua')
  cuaMod.setOverlayGuard((on) => {
    cuaParked = !!on // 动作期间 poll 不得翻转穿透，否则她要点的窗口会被抢回可交互
    for (const [, w] of overlayWins) {
      if (!w || w.isDestroyed()) continue
      try {
        if (on) w.setIgnoreMouseEvents(true, { forward: false })
        else overlayBaseline(w) // 0.6.0 修复：之前恢复成了【可交互】，全屏隐形窗会吃掉所有点击
      } catch {}
    }
  })
  // 排障入口：RYZA_CUA_SELFTEST=1 启动后跑一次引擎自检并写日志，
  // 用来确认「安装版能否加载 koffi / 能否截图」——不然只能等模型第一次调用才知道坏
  if (process.env.RYZA_CUA_SELFTEST) {
    setTimeout(async () => {
      try {
        const idle = await cuaMod.invoke('idle', {})
        const wins = await cuaMod.invoke('windows', {})
        log('[cua] 自检通过 空闲=' + (idle && idle.idleMs) + 'ms 窗口=' + (wins && wins.count) + '个')
      } catch (e) {
        log('[cua] 自检失败:', e.message)
      }
    }, 3000)
  }
  // 桌宠（overlay 内嵌版）：注入向 overlay 广播的通道，再启动拉初始角色
  const petMod = require('./companion/pet')
  petMod.setBroadcast((ch, data) => {
    for (const [, w] of overlayWins) if (!w.isDestroyed()) w.webContents.send(ch, data)
    // S4/3.5：触摸事件 2.5 秒合并后注入上下文（否则「一直摸」会把上下文刷爆）
    // kind=tap（手机远程点摸）不走这里：bridges.touch 已经直接 noteTouch(part)，别记成「tap」
    if (ch === 'pet:touch' && data && data.kind && data.kind !== 'tap') {
      notifyTouch(data.kind)
    }
  })
  // v0.4.2 主驱拖拽：拖拽期间全部桌面层窗口收鼠标（松手事件由光标所在窗口上报），
  // 结束后恢复「整窗穿透 + 转发」基线，热区逻辑随后的 mousemove 会自动重新校正
  petMod.setWindowCtl({
    setInteractive (on) {
      for (const [, w] of overlayWins) {
        if (w.isDestroyed()) continue
        try {
          if (on) w.setIgnoreMouseEvents(false)
          else overlayBaseline(w) // 拖拽结束回基线（poll 随后按光标位置接管）
        } catch {}
      }
    }
  })
  petMod.boot()
  // 拖拽状态：raiseOverlays / 定期提层都靠它让路，避免打断指针捕获
  isPetDragging = () => { try { return !!petMod.isDragging() } catch { return false } }
  // S3：桌宠六工具的宿主实现（模型能主动说话/走过来/做动作/改外观/安静）
  const petBridge = require('./petBridge')
  petBridge.attach({
    bcast: (ch, data) => {
      for (const [, w] of overlayWins) if (!w.isDestroyed()) { try { w.webContents.send(ch, data) } catch {} }
    }
  })
  petBridge.registerIpc()
  // 0.45.37 动作测试面板：控制台「动作」面板手动点播（走同一条 pet_act 链路，
  // 坐/站词照样被 act() 状态机接住）。纯手动验证入口，不影响她自主动作的选择。
  ipcMain.handle('pet:test-act', (_e, words) => {
    try {
      const list = Array.isArray(words) ? words : [words]
      return petBridge.invoke('pet_act', { actions: list, manual: true })
    } catch (e) { return { ok: false, error: e && e.message } }
  })
  // S5：形象包（API 2）—— zip 导入 / 装扮 / 独立装扮窗；结果存在角色卡 visual.figure
  const figures = require('./figures')
  figures.registerIpc()
  figures.seed()
  // S2 全屏让位：已提前到 buildOverlays 之前启动（启动防黑屏闸依赖首轮检测）
  // S6.5 游戏模式：状态/开关走 IPC 与托盘，overlay 自己的表现靠广播（与 petBridge 同一通道）
  gameMode.attach({
    bcast: (ch, data) => {
      for (const [, w] of overlayWins) if (!w.isDestroyed()) { try { w.webContents.send(ch, data) } catch {} }
    }
  })
  gameMode.setStateListener(() => { try { refreshTrayMenu() } catch {} })
  // 0.45.76 进出游戏模式同步进本体记忆：用户「就算离开也不会把对应模式里面的事忘记」——
  // 以前 gameHistory 只给设置页看，她自己从没见过，玩一场忘一场
  gameMode.setMemoryListener((info) => {
    try { require('./companion').noteGameSession(info) } catch (e) { log('[gameMode] 记忆同步失败: ' + (e && e.message)) }
  })
  // 聊天输入需要键盘：overlay 窗口 focusable:false（不抢焦点设计），输入时动态切换。
  // v0.4.7 闪红修复：focus() 只在真正未持焦点时调用——后台进程反复 SetForegroundWindow
  // 被 Windows 拒绝会让任务栏按钮闪橙红（「一直弹红」根因）；且调用方已改为用户手势
  ipcMain.handle('pet:chat-focus', (_e, on) => {
    for (const [, w] of overlayWins) {
      if (w.isDestroyed()) continue
      try {
        w.setFocusable(!!on)
        if (on && !w.isFocused()) w.focus()
      } catch {}
    }
    return true
  })
  companion.bootPet()
  // 视觉跟踪：主进程轮询全局光标（overlay 窗口穿透收不到桌面移动），广播给渲染层。
  // 0.6.0 兼职热区命中：光标在不在角色/气泡上由这里判定并切换穿透（见 hotRectsByWin），
  // 渲染层不再依赖 forward 转发的 mousemove —— 全屏鼠标消息不再进 Electron。
  {
    let lastX = -1
    let lastY = -1
    setInterval(() => {
      try {
        const p = screen.getCursorScreenPoint()
        if (p.x !== lastX || p.y !== lastY) {
          lastX = p.x
          lastY = p.y
          for (const [, w] of overlayWins) if (!w.isDestroyed()) w.webContents.send('overlay:cursor', { x: p.x, y: p.y })
        }
        // 命中判定每 tick 都跑：光标不动但角色走过来/走过去时也要能翻转
        if (cuaParked || isPetDragging()) return
        for (const [k, w] of overlayWins) {
          if (w.isDestroyed()) continue
          const rects = hotRectsByWin.get(k)
          if (!rects || !rects.length) {
            // v0.22.1 诊断：热区为空时窗口的穿透状态没人管（continue 跳过）。
            // 若此时窗口不穿透，整窗都会挡住下层点击；出现频繁说明渲染层没上报。
            if (overlayInteractive.get(k) === true) {
              log('[hot] 警告：key=' + k + ' 热区为空但窗口仍处于可交互态（可能渲染层未上报）')
              overlayInteractive.set(k, false)
              try { w.setIgnoreMouseEvents(true) } catch {}
            }
            continue
          }
          const b = w.getBounds()
          const hot = hitHotRects(rects, p.x - b.x, p.y - b.y)
          if (overlayInteractive.get(k) !== hot) {
            overlayInteractive.set(k, hot)
            // 热：收鼠标（可点）；不热：穿透且【不带 forward】，光标路径不进本进程
            w.setIgnoreMouseEvents(!hot)
            log('[hot] key=' + k + ' → ' + (hot ? '可交互' : '穿透'))
            if (hot) {
              // 0.45.29 可交互的瞬间立刻提层：AuraDesk 卡片条这类同级 screen-saver 窗口
              // 靠自己的周期重设层级压回来（8s 的 raiseOverlays 赶不上），重叠时
              // 按钮按下会落到卡片上（用户报的「拖角色点到卡片」就是这一瞬间）
              try { raiseOverlays(true) } catch {}
            } else {
              // 0.45.29 翻回穿透必须通知渲染层：WS_EX_TRANSPARENT 一开，
              // Windows 就停发鼠标消息，渲染层的 pointerleave 永远不来——
              // 悬停工具条/聊天输入条会永远挂着（用户报的「不悬停也存在」）。
              try { w.webContents.send('overlay:hot-lost') } catch {}
            }
          }
        }
      } catch {}
    }, 80)
  }
  registerShortcuts()
  createTray()
  startGpuWatchdog()
  // 层级保持：AuraDesk 卡片条等 screen-saver 级窗口会在我们之后重建/重设，
  // 同层级只看 SetWindowPos 先后 → 定期把角色层重新排到队首，重叠时才拖得动
  setInterval(raiseOverlays, 8000)

  screen.on('display-added', () => queueRebuild())
  screen.on('display-removed', () => queueRebuild())
  screen.on('display-metrics-changed', () => queueRebuild())

  // 首次启动（还没有配置文件）：自动打开角色设置，引导导入角色素材
  if (!fs.existsSync(path.join(app.getPath('userData'), 'config.json'))) {
    setTimeout(() => companion.createWindow('settings'), 1200)
  }
  }).catch((err) => {
    // whenReady 流程里任何一步抛异常都必须留痕——否则整个桌面层静默消失
    log('[boot] 启动流程异常:', err && (err.stack || err.message))
  })

/* ---- 开机白屏治理 ----
   开机自启动时 GPU 进程经常还没就绪甚至先崩一次，透明窗口一旦在
   GPU 不可用状态下渲染就会变成一块不透明白底，之后一直挂着。
   对策：GPU 崩溃重启完成后、以及 GPU 状态从不可用恢复可用时，
   把覆盖层窗口重载一遍，透明合成即恢复正常。 */
let gpuWasBad = false

function reloadOverlays () {
  for (const [, w] of overlayWins) {
    if (!w.isDestroyed() && w.isVisible()) w.webContents.reload()
  }
}

function startGpuWatchdog () {
  // GPU 进程崩溃：等它自己重启完再重载
  app.on('child-process-gone', (_e, details) => {
    if (String(details.type).toUpperCase() !== 'GPU') return
    setTimeout(reloadOverlays, 2500)
  })
  // 开机初期 GPU 状态反复横跳：变好之后重载一次
  const timer = setInterval(() => {
    try {
      const s = app.getGPUFeatureStatus()
      const bad = !!s.gpu && !/enable/i.test(s.gpu)
      if (gpuWasBad && !bad) {
        gpuWasBad = false
        setTimeout(reloadOverlays, 1200)
      } else if (bad) {
        gpuWasBad = true
      }
    } catch { /* 忽略 */ }
  }, 2000)
  // 90 秒后 GPU 稳定，不再轮询
  setTimeout(() => clearInterval(timer), 90000)
}

function queueRebuild () {
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    buildOverlays()
    refreshAllOverlays()
  }, 400)
}

app.on('window-all-closed', () => {
  // 桌面层是常驻的：设置窗口关掉、或按快捷键隐藏了桌面层，都不应该退出，
  // 否则托盘图标跟着消失，用户就再也找不回来了。退出统一走托盘菜单。
  if (process.platform === 'darwin') return
  store.flush()
  if (!tray || tray.isDestroyed()) app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  store.flush()
  // OBS 导出服务占用本地端口，退出时关掉；顺带把还没返回的 /frame 请求放掉
  try { obs.stop() } catch {}
  // 本地 IndexTTS 回退服务的常驻 python 进程也一起收
  try { require('./companion/ttsLocal').stopServer() } catch {}
  // 全屏探测是常驻 PowerShell 子进程，退出必须收掉，否则会留孤儿进程
  try { require('./fullscreen').stop() } catch {}
  // 桌面状态 worker（launcher.ps1，窗口扫描/音量/显示桌面）同样是常驻子进程
  try { require('./launcher').stop() } catch {}
  // 电脑操作引擎同样是常驻子进程（还抓着屏幕 DC），必须一起收
  try { require('./cua').stop() } catch {}
  try { require('./cua/confirm').destroy() } catch {}
  if (tray && !tray.isDestroyed()) tray.destroy()
})

/* -------------------------------------------------------------------- IPC */

ipcMain.handle('overlay:init', (e) => {
  const key = winKey.get(e.sender.id) || 'demo'
  return payloadForKey(key)
})

/* 输入穿透：v0.3.38 起弃用 setShape（SetWindowRgn 会裁剪视觉——热区矩形同时是
   可见区域，导致角色区域灰框、拖动时被裁）。改为标准桌宠方案：窗口整窗穿透
   + {forward:true} 转发鼠标事件给渲染层，渲染层判断光标是否在热元素上，
   动态切换穿透。窗口始终是完整矩形，无 region 裁剪。 */
ipcMain.on('overlay:hot-rects', (e, rects) => {
  const key = winKey.get(e.sender.id)
  const win = key && overlayWins.get(key)
  if (!win || win.isDestroyed()) return
  const first = !hotRectsByWin.has(key)
  hotRectsByWin.set(key, Array.isArray(rects) ? rects : [])
  // 首次收到热区 → 从「forward 全屏转发」基线切到「无 forward + poll 驱动」。
  // 0.45.29：只在首次强制回穿透——角色走路时掩码每帧都在变，渲染层 33ms 就重报一次，
  // 每次都把可交互态打回穿透会让 poll 反复翻转（光标明明停在角色上却点不中/闪烁）。
  if (first) {
    try { win.setIgnoreMouseEvents(true) } catch {}
    overlayInteractive.set(key, false)
  }
})

ipcMain.on('overlay:ignore-mouse', (e, on) => {
  const key = winKey.get(e.sender.id)
  const win = key && overlayWins.get(key)
  if (!win || win.isDestroyed()) return
  // 热区上报已接管的窗口：穿透切换归 80ms poll 管，渲染层的老请求直接忽略
  // （否则 mousemove 一到又把 forward 全屏转发开回来，延迟原样复发）
  if (hotRectsByWin.has(key)) return
  try { win.setIgnoreMouseEvents(!!on, { forward: !!on }) } catch {}
})

/* 光标进入角色热区时立即提层（渲染层只在「未命中 → 命中」翻转时发一次） */
ipcMain.on('overlay:raise', () => raiseOverlays())

/* S4/3.5：部位触摸上报（宿主屏才发）→ 与拖拽类事件一起合并注入上下文 */
ipcMain.on('pet:tap-report', (_e, part) => {
  if (part) notifyTouch(part)
})

/* 0.33.0 自主动作上报（渲染层自播的长待机小彩蛋）→ 她自己「知道」刚做了什么 */
ipcMain.on('pet:self-report', (_e, kind) => {
  try { require('./assistant').noteSelfAct(kind) } catch { /* 核心没就绪就忽略 */ }
})

/* 渲染层未捕获异常：boot 挂掉 / 按钮没绑上这类问题，只有这里能看到 */
ipcMain.on('overlay:renderer-error', (_e, kind, msg, stack) => {
  log('[renderer] ' + kind + ':', String(msg || '').slice(0, 500), String(stack || '').slice(0, 800))
})

ipcMain.on('overlay:open-settings', () => companion.createWindow('settings'))
// 桌宠悬停面板的两个入口都指向同一个主窗口，只是落在不同视图
ipcMain.on('overlay:open-assistant', () => companion.createWindow('chat'))
ipcMain.on('overlay:open-companion', () => companion.createWindow('char'))

ipcMain.on('overlay:hide', () => {
  for (const [, w] of overlayWins) if (!w.isDestroyed()) w.hide()
  refreshTrayMenu()
})

ipcMain.on('overlay:quit', () => app.quit())

/* ------------------------------------------------------------------ 设置 */

ipcMain.handle('settings:patch-global', (e, patch) => {
  store.patchGlobal(patch)
  if ('alwaysOnTop' in patch) {
    for (const [, w] of overlayWins) if (!w.isDestroyed()) applyTopLevel(w)
    if (patch.alwaysOnTop) setTimeout(raiseOverlays, 30)
  }
  if ('autoLaunch' in patch) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!patch.autoLaunch, path: process.execPath, args: ['--silent'] })
    } catch (err) {
      console.warn('[autoLaunch] 设置失败', err)
    }
  }
  if ('hotkeyToggle' in patch || 'hotkeySettings' in patch || 'hotkeyTalk' in patch || 'hotkeyType' in patch) registerShortcuts()
  if ('obsEnabled' in patch || 'obsPort' in patch || 'obsFps' in patch || 'obsScreen' in patch) {
    try { syncObs() } catch (err) { log('[obs] 配置变更后重启失败: ' + (err && err.message)) }
  }
  refreshTrayMenu()
  refreshAllOverlays()
  return { ok: true }
})

// 0.22.0 补丁⑥：角色设置里的「她的记录 / 快捷键 / OBS」要读全局配置与屏幕清单
// （旧的 settings:init 随 AuraDesk 设置窗口一起删了，这两个是给 companion 的只读版）
ipcMain.handle('app:global-config', () => ({ global: store.get().global, primaryKey: primaryKey() }))
ipcMain.handle('app:displays', () => ({ displays: displayList() }))

/* --------------------------------------------------- 数据目录（0.19.0）
 * 便携版把数据放程序旁边，复制整个文件夹就是另一只桌宠；
 * 「更换目录」写入指针后重启（换 userData 必须重启才干净）。
 */
ipcMain.handle('datadir:info', () => {
  const root = app.getPath('userData')
  const ptr = datadir.readPointer(app)
  let hasCfg = false
  try { hasCfg = fs.existsSync(path.join(root, 'config.json')) } catch { }
  return {
    root,
    portable: !!datadir.portableRoot(),
    portableDir: datadir.portableRoot(),
    defaultRoot: datadir.defaultRoot(app),
    pointer: ptr.root,
    known: ptr.known,
    hasConfig: hasCfg
  }
})

ipcMain.handle('datadir:open', () => shell.openPath(app.getPath('userData')))

ipcMain.handle('datadir:pick', async () => {
  const res = await dialog.showOpenDialog(companion.getWindow() || undefined, {
    title: '选择数据目录',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('userData')
  })
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true }
  const target = res.filePaths[0]
  if (path.resolve(target) === path.resolve(app.getPath('userData'))) {
    return { ok: false, error: '这就是当前目录' }
  }
  const hasData = datadir.hasData(target)
  const btn = dialog.showMessageBoxSync(companion.getWindow() || undefined, {
    type: 'question',
    buttons: ['切换并重启', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: '更换数据目录',
    message: hasData ? '这个目录已有数据，直接切换过去？' : '这个目录是空的，切换过去？',
    detail: '目标：' + target + '\n\n切换会立即重启应用。' +
      (hasData ? '' : '\n空目录 = 全新开始（角色、记忆、配置都要重新设置）。')
  })
  if (btn !== 0) return { ok: false, canceled: true }
  return datadir.switchTo({ app, target, log })
})

/* --------------------------------------------------- OBS 导出（0.19.0） */
ipcMain.handle('obs:status', () => obs.status())
ipcMain.handle('obs:open', () => {
  const st = obs.status()
  if (st.url) shell.openExternal(st.url)
  return st
})

/* --------------------------------------------------- 游戏库 / 游戏模式（S6.5）

   AuraDesk 时代的游戏库导入 IPC 随启动器一起被删了，设置页那几个按钮点了
   没有任何反应。这里按「角色要能开游戏」的需求重建一套最小可用集合：
   扫描（Steam / Epic / 开始菜单）→ 导入 → 列表 → 启动 → 删除。
   启动游戏自动进游戏模式（角色缩到角落，不挡画面）。 */

function hueOf (s) {
  let h = 0
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360
  return h
}

function libEntries () {
  const g = store.get()
  return Array.isArray(g.global.library) ? g.global.library.slice() : []
}

/** 合并导入（按 name+target 去重），返回新增数 */
function libMerge (items) {
  const cur = libEntries()
  const seen = new Set(cur.map((g) => String(g.name || '').toLowerCase() + '|' + String(g.target || '')))
  let added = 0
  for (const it of items) {
    if (!it || !it.name || !it.target) continue
    const key = String(it.name).toLowerCase() + '|' + String(it.target)
    if (seen.has(key)) continue
    seen.add(key)
    cur.push({
      id: it.id || ('g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      name: it.name,
      kind: it.kind || 'exe',
      target: it.target,
      source: it.source || 'other',
      hue: it.hue != null ? it.hue : hueOf(it.name),
      cover: ''
    })
    added++
  }
  if (added) store.patchGlobal({ library: cur })
  return added
}

let smCache = [] // 最近一次开始菜单扫描（勾选导入要用 id 反查）

ipcMain.handle('game:state', () => gameMode.state())

/* 0.38.0 游戏弹幕层（飘的弹幕 + 弹幕框） */
ipcMain.handle('dm:status', () => require('./danmaku').status())
ipcMain.handle('dm:toggle', (_e, on) => {
  const dk = require('./danmaku')
  const r = dk.toggle(on == null ? null : !!on, 'ui')
  return { ...r, status: dk.status() }
})
ipcMain.handle('dm:lock', (_e, v) => ({ ok: true, locked: require('./danmaku').setLock(!!v) }))
ipcMain.handle('dm:test', () => require('./danmaku').test())

ipcMain.handle('game:toggle', (_e, on) => {
  const r = gameMode.toggle(on == null ? null : !!on, 'ui')
  refreshTrayMenu()
  return r
})

/** 扫描（force=true 一定重扫）。只回给界面需要展示的字段 */
ipcMain.handle('game:scan', (_e, which) => {
  const d = gameLib.discover(true)
  smCache = d.startmenu.map((s, i) => ({
    id: 'sm' + i, name: s.name, lnk: s.lnk, isUrl: s.isUrl
  }))
  const slim = (g) => ({ id: g.id, name: g.name, source: g.source, kind: g.kind, target: g.target, hue: g.hue })
  if (which === 'steam') return { ok: true, steam: d.steam.map(slim) }
  if (which === 'epic') return { ok: true, epic: d.epic.map(slim) }
  if (which === 'startmenu') return { ok: true, startmenu: smCache.map((s) => ({ id: s.id, name: s.name, exe: s.lnk })) }
  return {
    ok: true,
    steam: d.steam.map(slim),
    epic: d.epic.map(slim),
    startmenu: smCache.map((s) => ({ id: s.id, name: s.name, exe: s.lnk }))
  }
})

ipcMain.handle('game:import', (_e, source) => {
  const d = gameLib.discover(false)
  let items = []
  if (source === 'steam') items = d.steam
  else if (source === 'epic') items = d.epic
  else if (source === 'startmenu') {
    if (!smCache.length) {
      smCache = d.startmenu.map((s, i) => ({ id: 'sm' + i, name: s.name, lnk: s.lnk, isUrl: s.isUrl }))
    }
    items = smCache.map((s) => ({ name: s.name, kind: s.isUrl ? 'url' : 'lnk', target: s.lnk, source: 'startmenu' }))
  } else items = [...d.steam, ...d.epic]
  const added = libMerge(items)
  log('[game] 导入 ' + source + '：扫描 ' + items.length + '，新增 ' + added)
  return { ok: true, scanned: items.length, added }
})

ipcMain.handle('game:import-startmenu', (_e, ids) => {
  const set = new Set(Array.isArray(ids) ? ids : [])
  const items = smCache.filter((s) => set.has(s.id))
    .map((s) => ({ name: s.name, kind: s.isUrl ? 'url' : 'lnk', target: s.lnk, source: 'startmenu' }))
  return { ok: true, scanned: items.length, added: libMerge(items) }
})

ipcMain.handle('game:add-file', async () => {
  const res = await dialog.showOpenDialog(companion.getWindow() || undefined, {
    title: '添加程序 / 游戏',
    properties: ['openFile'],
    filters: [
      { name: '程序或快捷方式', extensions: ['exe', 'lnk', 'url', 'bat'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true }
  const p = res.filePaths[0]
  const name = path.basename(p).replace(/\.(exe|lnk|url|bat)$/i, '')
  const added = libMerge([{ name, kind: /\.(lnk|url)$/i.test(p) ? 'lnk' : 'exe', target: p, source: 'other' }])
  return { ok: true, added, name }
})

ipcMain.handle('game:launch', (_e, id) => {
  const hit = libEntries().find((g) => g.id === id)
  if (!hit) return { ok: false, error: '库里没有这一项' }
  try {
    const r = gameLib.launchEntry(hit)
    const gm = store.get().global.companion && store.get().global.companion.gameModeAuto === false
      ? null
      : gameMode.enter('ui')
    refreshTrayMenu()
    log('[game] 启动 ' + hit.name + ' via=' + r.via + (gm && gm.on ? '（游戏模式）' : ''))
    return { ok: true, name: hit.name, gameMode: !!(gm && gm.on) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('game:remove', (_e, id) => {
  store.patchGlobal({ library: libEntries().filter((g) => g.id !== id) })
  return { ok: true }
})

ipcMain.handle('game:list', () => libEntries().map((g) => ({
  id: g.id, name: g.name, source: g.source || 'other', kind: g.kind, target: g.target,
  hue: g.hue != null ? g.hue : hueOf(g.name), coverUrl: toUrl(g.cover)
})))

/** 游戏模式设置项（缩放到多少 / 躲哪个角 / 要不要静音 / 进出提示语） */
ipcMain.handle('game:config', (_e, patch) => {
  const g = store.get().global
  const cur = (g.companion) || {}
  const next = { ...cur }
  if (patch && typeof patch === 'object') {
    for (const k of ['gameMode', 'gameModeAuto', 'gameModeMute', 'gameModeGreet', 'gameModeGreetText',
      'gameModeScale', 'gameModeCorner', 'permMode', 'permAllowApps', 'gameAutoOn', 'gameAutoProcesses',
      'gameAutoLeaveMin',
      'danmakuOn', 'danmakuFontSize', 'danmakuSpeed', 'danmakuLock']) {
      if (patch[k] !== undefined) next[k] = patch[k]
    }
  }
  store.patchGlobal({ companion: next })
  // 0.38.0：弹幕相关项改完立刻生效（窗还开着就不用等下次进游戏模式）
  if (patch && ['danmakuOn', 'danmakuFontSize', 'danmakuSpeed', 'danmakuLock'].some((k) => patch[k] !== undefined)) {
    try {
      const dk = require('./danmaku')
      if (patch.danmakuOn === false) dk.stop('setting-off')
      else if (patch.danmakuOn === true && gameMode.isActive()) dk.start('game')
      if (patch.danmakuLock !== undefined) dk.setLock(patch.danmakuLock !== false)
      if (patch.danmakuFontSize !== undefined || patch.danmakuSpeed !== undefined) dk.config({})
    } catch (e) { log('[danmaku] 配置生效失败:', e && e.message) }
  }
  return { ok: true, state: gameMode.state(), config: next }
})


/* --------------------------------------------------------------- 截图模式（精简） */

/** CAPTURE=1：截一张精简桌面层用于预览（旧的游戏库/播放器截图流程已随功能移除） */
async function runCaptureMinimal () {
  setTimeout(() => {
    console.error('[capture] 超时退出')
    app.quit()
  }, 15000)

  const win = createOverlay('demo', {
    id: 'demo',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    primary: true
  })

  const outDir = path.join(app.getAppPath(), 'captures')
  fs.mkdirSync(outDir, { recursive: true })
  win.showInactive()

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await wait(2600)
  try {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, 'overlay.png'), img.toPNG())
    console.log('[capture] overlay.png ' + JSON.stringify(img.getSize()))
  } catch (err) {
    console.error('[capture] 失败', err)
  }
  const cw = companion.createWindow('settings')
  await wait(2200)
  try {
    const img = await cw.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, 'settings.png'), img.toPNG())
  } catch {}
  setTimeout(() => app.quit(), 200)
}
