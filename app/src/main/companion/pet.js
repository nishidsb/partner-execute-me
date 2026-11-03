'use strict'
/**
 * AI 伴侣 · 桌面角色（overlay 内嵌版）
 * 桌宠不再用独立 BrowserWindow——独立透明小窗口在本机被 Chromium 判定遮挡
 * （被全屏透明桌面层覆盖 / GPU 合成挂起，所有开关都救不回来，capturePage 永远
 * 冻结在第 1 帧）。改为把角色渲染进桌面层 overlay 窗口（合成被证实正常）。
 * 本模块只负责：状态维护（当前角色 + 显示开关）+ 向 overlay 广播。
 */
const store = require('../store')
const { log } = require('../logger')
const petlink = require('./petlink')

let patchCfgFnRef = null // registerIpc 注入：配置落盘

let broadcast = null // main 注入：向所有 overlay 窗口发消息
let windowCtl = null // main 注入：{ setInteractive(on) }——拖拽期间让全部桌面层窗口收鼠标
// pos = 角色锚点（stage 底边中点）的全局屏幕坐标（DIP）。跨屏拖拽的核心：
// 位置不再属于某个 overlay 窗口，而是全局状态——哪个屏包含该点，哪个屏渲染角色
let state = { char: null, visible: false, pos: null }
// v0.4.2 主进程驱动拖拽：渲染层指针捕获在「穿透窗口 + 跨屏」下不可靠
// （WS_EX_TRANSPARENT 停发鼠标消息/事件流断裂，日志实证 dragend 缺失），
// 改为主进程 16ms 轮询系统光标全局坐标——拖拽完全不依赖渲染层事件
let drag = null // { offX, offY, timer, vx, vy, last }
/* ---- S2 行为层（走动 / 抛掷惯性 / 全屏让位） ----
 * 位置状态本来就在主进程（跨屏拖拽需要），自主走动与抛掷惯性也在主进程推进，
 * 渲染层只负责按 pet:pos 落位——避免两处各算一套坐标互相打架。 */
let userVisible = false // 用户开关（设置里的「在桌面显示角色」）
let suspended = false // 全屏让位（临时隐藏，不改用户开关）
let walkTimer = null // 下一次起步的定时器
let defaultSitTimer = null // 0.46.0 启动后自动坐下的延迟定时器
let walkAnim = null // 正在走：{ timer }
let walkDir = 0 // 0.33.0 正在走的方向（-1 左 / 1 右），describeActivity 用
let glideTimer = null // 0.45.83 平滑滑动（游戏模式进出）进行中的定时器
/* 0.29.0 卡片联动：坐在 AuraDesk 的卡片上休息 */
const STAGE_H = 520 // .petstage 的 CSS 高度（style.css）
const SIT_HIPS = 0.37 // 坐姿时胯部离舞台底边的高度（占身高比例，跟 vrm-stage 的 -0.15h 对应；0.45.38 再调救脚——「脚踩地」的坐姿脚踝必然压在底边上被裁，改坐高凳式）
let rest = null // { cardId, fromY, timer }
let groundRest = null // 0.45.29 原地坐下休息：{ timer }（不占卡片，就地坐一会儿再站起来）
let inertia = null // 抛掷惯性：{ timer }
// 0.45.90 坐卡资格与防「坐住不挪窝」：起身 90s 冷却内不坐卡/不原地坐，且不重复选上一张卡
let cardCooldownUntil = 0
let lastCardId = ''
function canSitNow () {
  const vis = state.char && state.char.visual
  if (!vis) return false
  if (vis.vrm) return true
  if (vis.mode === 'spine' && vis.spine && vis.spine.sitSkel) return true // 渲染层切坐姿骨架演出
  return false
}
let roamHold = false // 渲染层说「正在对话/悬停」→ 暂停自主走动（免得说着话人走开）
let quietOn = false // S3 模型主动要求安静（pet_quiet）：不走动，到点或 minutes=0 解除
let paused = false // 0.18.0 第一批：右键「暂停」——停掉自主走动，恢复后照原档位继续
/* ---- 5.7 走到窗口顶边（ledge）----
 * 拖拽悬在某个可见窗口顶边附近松手 → 角色坐上「窗台」，之后每 700ms 跟随窗口移动，
 * 窗口关闭/最小化就摔下去。只读窗口几何（koffi EnumWindows），不读内容不注入。 */
const ledgeApi = require('./ledge')
let ledge = null // { hwnd, frac, timer }

function petCfg () {
  const g = store.get()
  return (g.global && g.global.companion) || {}
}

function setBroadcast (fn) { broadcast = fn }
function setWindowCtl (ctl) { windowCtl = ctl }
/** 0.24.0 随身服务：手机上的部位点摸 → 走 grab/drop 同一条广播通道，
 *  桌面角色当场播 motion_touch 反应动作（手机画面流里直接可见） */
function remoteTouchTap (part) {
  try { if (broadcast) broadcast('pet:touch', { kind: 'tap', part: String(part || '').slice(0, 20) }) } catch { }
}

/** 拖拽开始：anchor=当前锚点全局坐标；抓取偏移 = 锚点 - 光标当前位置 */
function dragStart (anchor) {
  if (!state.visible || drag) return
  leaveLedge() // 从窗台上被拎起来
  leaveCard(false) // 坐在卡片上被拎起来：先站起来、并把卡片还原
  leaveGroundRest(false) // 原地坐着被拎起来：先站起来
  stopWalk() // 被拎起来就停下脚步
  stopInertia()
  cancelGlide() // 0.45.83 滑动中也被拎起来：掐掉滑动，两路不抢坐标
  try {
    const { screen } = require('electron')
    const c = screen.getCursorScreenPoint()
    const a = (anchor && isFinite(anchor.x) && isFinite(anchor.y)) ? anchor : (state.pos || { x: c.x, y: c.y })
    drag = { offX: a.x - c.x, offY: a.y - c.y, timer: null, vx: 0, vy: 0, last: { x: c.x, y: c.y, t: Date.now() } }
    drag.timer = setInterval(() => {
      try {
        const p = screen.getCursorScreenPoint()
        const now = Date.now()
        // 采样速度（DIP/ms），指数平滑掉单帧抖动 → 松手时决定「放下」还是「甩出去」
        if (drag.last) {
          const dt = Math.max(1, now - drag.last.t)
          drag.vx = drag.vx * 0.6 + ((p.x - drag.last.x) / dt) * 0.4
          drag.vy = drag.vy * 0.6 + ((p.y - drag.last.y) / dt) * 0.4
        }
        drag.last = { x: p.x, y: p.y, t: now }
        state.pos = clampPos({ x: p.x + drag.offX, y: p.y + drag.offY })
        pushPos()
        // 跨屏诊断：光标一旦进入另一块显示器就记一行（不刷屏），
        // 排查「拖不过去」时能直接看出是坐标没跟上还是宿主没接管
        const d = screen.getDisplayNearestPoint(p)
        const dispKey = d.id + '@' + d.bounds.x + ',' + d.bounds.y
        if (dispKey !== drag.dispKey) {
          drag.dispKey = dispKey
          log('[pet] 拖拽跨屏 → 显示器 ' + d.bounds.width + 'x' + d.bounds.height + '@' + d.bounds.x + ',' + d.bounds.y +
            ' cursor=' + p.x + ',' + p.y + ' pos=' + Math.round(state.pos.x) + ',' + Math.round(state.pos.y))
        }
      } catch {}
    }, 16)
    armButtonProbe()
    // 5.7 拖拽期间每 700ms 采样一次窗口顶边（只读几何），悬在窗边给渲染层提示
    drag.ledgeCand = null
    drag.ledgeTimer = setInterval(sampleLedgeDuringDrag, 700)
    setTimeout(sampleLedgeDuringDrag, 120)
    // 拖拽期间所有桌面层窗口收鼠标：松手事件由光标所在窗口的渲染层上报（window 级 pointerup）
    try { if (windowCtl && windowCtl.setInteractive) windowCtl.setInteractive(true) } catch {}
    // 触摸语义：被拎起来（渲染层节流播报，不会每次拖都碎碎念）
    try { if (broadcast) broadcast('pet:touch', { kind: 'grab' }) } catch {}
    log('[pet] 主驱拖拽开始 anchor=' + Math.round(a.x) + ',' + Math.round(a.y) + ' cursor=' + c.x + ',' + c.y)
  } catch (e) { log('[pet] dragStart 失败:', e && e.message); dragEnd() }
}

/* v0.4.7 兜底探针：拖拽期间用 user32.GetAsyncKeyState(VK_LBUTTON) 轮询物理左键
 * 状态（PowerShell 子进程，纯 ASCII，零原生依赖）。渲染层 pointerup 在穿透窗口
 * 跨屏场景下实证会丢（粘滞根因），探针保证主进程能自主感知松手，最多延迟约
 * 1 秒（PowerShell 冷启动+Add-Type 编译）。正常松手仍以渲染层上报为准（毫秒级）。 */
function armButtonProbe () {
  try {
    const { spawn } = require('node:child_process')
    const probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -Namespace W -Name N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int k);'; while($true){ if((( [W.N]::GetAsyncKeyState(1)) -band 0x8000) -eq 0){ Write-Output UP; exit }; Start-Sleep -Milliseconds 12 }"
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    probe.stdout.on('data', () => { if (drag) dragEnd() })
    probe.on('error', () => {})
    drag.probe = probe
  } catch {}
}

/** 拖拽结束：停轮询+探针、按松手速度决定「放下 / 甩出去」、位置落盘、恢复穿透 */
function dragEnd (src) {
  let v = null
  let ledgeCand = null
  if (drag) {
    if (drag.timer) clearInterval(drag.timer)
    if (drag.ledgeTimer) clearInterval(drag.ledgeTimer)
    ledgeCand = drag.ledgeCand || null
    if (drag.probe) { try { drag.probe.kill() } catch {} }
    v = { x: drag.vx || 0, y: drag.vy || 0 }
    drag = null
    try { if (windowCtl && windowCtl.setInteractive) windowCtl.setInteractive(false) } catch {}
    log('[pet] 主驱拖拽结束 pos=' + (state.pos ? Math.round(state.pos.x) + ',' + Math.round(state.pos.y) : 'null') +
      ' v=' + Math.round(Math.hypot(v.x, v.y) * 1000) + 'px/s 来源=' + (src || 'unknown'))
  }
  const speed = v ? Math.hypot(v.x, v.y) : 0
  // 5.7 窗台：松手时角色悬在某个窗口顶边附近且没被甩出去 → 坐上去（跟随窗口）
  if (state.pos && ledgeCand && speed <= 0.6 && enterLedge(ledgeCand)) {
    if (patchCfgFnRef) { try { patchCfgFnRef({ petPos: state.pos }) } catch {} }
    return
  }
  try { if (broadcast) broadcast('pet:ledge', { on: false }) } catch {}
  // 甩出去：给一段惯性滑行（快速丢 → 撞边回弹 + 惊慌一句）
  if (state.pos && speed > 0.25) startInertia(v)
  // 触摸语义（对齐参考项目 TOUCH_KINDS）：拎起来放下 / 甩出去
  if (state.pos) {
    try { if (broadcast) broadcast('pet:touch', { kind: speed > 0.75 ? 'throw' : 'drop' }) } catch {}
  }
  if (state.pos) {
    if (patchCfgFnRef) {
      try { patchCfgFnRef({ petPos: state.pos }) } catch (e) { log('[pet] 位置保存失败:', e && e.message) }
    }
    pushPos()
  }
  scheduleWander() // 落地后重新开始自己溜达
}

/* ---------------- 5.7 窗台（ledge）：坐上窗口顶边并跟随 ---------------- */

/** 拖拽期间采样：锚点悬在某个可见窗口顶边附近 → 记住候选并给渲染层画提示线 */
function sampleLedgeDuringDrag () {
  if (!drag || !state.pos) return
  try {
    const cands = ledgeApi.topEdges(process.pid)
    let hit = null
    const minY = ledgeMinTop()
    for (const c of cands) {
      if (c.y < minY) continue // 顶边太靠屏幕上沿：坐上去会大半截出屏
      if (state.pos.y >= c.y - 8 && state.pos.y <= c.y + 80 &&
          state.pos.x >= c.x + 40 && state.pos.x <= c.x + c.w - 40) { hit = c; break }
    }
    drag.ledgeCand = hit
    try {
      if (broadcast) broadcast('pet:ledge', hit ? { on: true, x: hit.x, y: hit.y, w: hit.w, hint: true } : { on: false })
    } catch {}
  } catch { /* ledge 属增强体验，任何失败都静默 */ }
}

/** 窗台顶边的最低可用高度：虚拟桌面最上沿 + 180 DIP（给角色留露全身的空间） */
function ledgeMinTop () {
  try {
    const { screen } = require('electron')
    let minY = Infinity
    for (const d of screen.getAllDisplays()) minY = Math.min(minY, d.workArea.y)
    return (isFinite(minY) ? minY : 0) + 180
  } catch { return 180 }
}

/** 坐上窗台：x 按松手点在窗口宽度里的比例固定，y = 窗口顶边；每 700ms 跟随 */
function enterLedge (cand) {
  if (!cand || !state.pos) return false
  stopWalk()
  stopInertia()
  clearTimeout(walkTimer)
  walkTimer = null
  const frac = Math.max(0.08, Math.min(0.92, (state.pos.x - cand.x) / Math.max(1, cand.w)))
  ledge = { hwnd: cand.hwnd, frac, timer: null }
  state.pos = { x: Math.round(cand.x + frac * cand.w), y: Math.round(cand.y) }
  pushPos()
  try { if (broadcast) broadcast('pet:ledge', { on: true, seated: true }) } catch {}
  ledge.timer = setInterval(followLedge, 700)
  log('[pet] 坐上窗台:', cand.title, '@', Math.round(state.pos.x) + ',' + Math.round(state.pos.y))
  return true
}

/** 跟随：窗口挪了角色跟着挪；窗口没了/最小化 → 摔下去 */
function followLedge () {
  if (!ledge) return
  const r = ledgeApi.rectOf(ledge.hwnd)
  if (!r || r.h < 120 || r.w < 200) return fallOffLedge('窗口没了')
  const x = Math.round(Math.max(r.x + 40, Math.min(r.x + r.w - 40, r.x + ledge.frac * r.w)))
  const y = Math.round(r.y)
  if (!state.pos || state.pos.x !== x || state.pos.y !== y) {
    state.pos = { x, y }
    pushPos()
  }
}

/** 摔下窗台：顺一段惯性滑到底（startInertia 收尾会落盘 + 重新排走动） */
function fallOffLedge (why) {
  if (!ledge) return
  if (ledge.timer) clearInterval(ledge.timer)
  ledge = null
  try { if (broadcast) broadcast('pet:ledge', { on: false }) } catch {}
  log('[pet] 从窗台掉落:', why || '')
  if (state.pos) {
    startInertia({ x: 0, y: 0.35 })
  } else {
    scheduleWander()
  }
}

/** 静默离开窗台（走路/拎起/摆位/隐藏前调用） */
function leaveLedge () {
  if (!ledge) return
  if (ledge.timer) clearInterval(ledge.timer)
  ledge = null
  try { if (broadcast) broadcast('pet:ledge', { on: false }) } catch {}
}

/** 悬停按钮「溜达」：立刻起步走一段（坐窗台时先下来） */
function roamNow () {
  if (!state.visible || !state.pos) return
  leaveLedge()
  stopInertia()
  clearTimeout(walkTimer)
  walkTimer = null
  startWander()
}

/* ---------------- 抛掷惯性：松手后角色自己滑一段，撞到屏边轻轻回弹 ---------------- */
function startInertia (v) {
  stopInertia()
  // 限速：太快的甩动不做成炮弹（视觉上会瞬移出屏）
  const cap = 3.2 // DIP/ms
  let vx = Math.max(-cap, Math.min(cap, v.x))
  let vy = Math.max(-cap, Math.min(cap, v.y))
  let crashed = false
  const timer = setInterval(() => {
    if (!state.pos || drag || !state.visible) { stopInertia(); return }
    const step = 16
    const raw = { x: state.pos.x + vx * step, y: state.pos.y + vy * step }
    const c = clampPos(raw)
    const hitX = Math.round(c.x) !== Math.round(raw.x)
    const hitY = Math.round(c.y) !== Math.round(raw.y)
    if (hitX) vx = -vx * 0.45 // 撞到左右边 → 回弹
    if (hitY) vy = -vy * 0.35 // 撞地/撞天 → 弹一下就趴住
    state.pos = { x: Math.round(c.x), y: Math.round(c.y) }
    pushPos()
    // 快撞上时算一次「摔倒」，让角色惊呼一句（每轮只播一次）
    if (!crashed && (hitX || hitY) && Math.hypot(vx, vy) > 0.5) {
      crashed = true
      try { if (broadcast) broadcast('pet:touch', { kind: 'crash' }) } catch {}
    }
    vx *= 0.9
    vy *= 0.9
    if (Math.hypot(vx, vy) < 0.02) {
      stopInertia()
      if (patchCfgFnRef && state.pos) {
        try { patchCfgFnRef({ petPos: state.pos }) } catch {}
      }
      scheduleWander()
    }
  }, 16)
  inertia = { timer }
}

function stopInertia () {
  if (inertia) { clearInterval(inertia.timer); inertia = null }
}

/* ---------------- 走 动（三档：关 / 悠闲 / 活跃） ---------------- */
function walkMode () {
  const m = petCfg().petWalk
  // 0.46.0 默认从 calm 改 off（用户 11-02：现在的 spine 只有坐姿素材，
  // 默认就坐在卡片/未关闭的程序上，不用来回溜达）；显式配了 calm/lively 照旧尊重。
  if (m === 'calm' || m === 'lively') return m
  return 'off'
}

function scheduleWander () {
  clearTimeout(walkTimer)
  walkTimer = null
  if (walkMode() === 'off' || !state.visible || drag || inertia || roamHold || quietOn || ledge || paused || rest || groundRest) return
  // 悠闲：半分钟到一分钟挪一小段；活跃：十秒上下就来回走
  const wait = walkMode() === 'lively' ? 6000 + Math.random() * 9000 : 24000 + Math.random() * 26000
  walkTimer = setTimeout(startWander, wait)
}

function startWander () {
  walkTimer = null
  if (!state.visible || drag || inertia || roamHold || quietOn || ledge || paused || rest || groundRest || !state.pos) { scheduleWander(); return }
  try {
    const { screen } = require('electron')
    // 只在角色当前所在屏的可用区域里走，不跨屏（跨屏拖拽是用户的事）
    const d = screen.getDisplayNearestPoint({ x: Math.round(state.pos.x), y: Math.round(state.pos.y) })
    const b = d.workArea
    const minX = b.x + 90
    const maxX = b.x + b.width - 90
    if (maxX - minX < 120) { scheduleWander(); return } // 屏太窄，不走
    // 先问问 AuraDesk 有没有卡片可坐（走过去 → 坐下 → 它把卡片放大）
    // 资格：3D 模型，或 Spine 且角色卡配了坐姿骨架（渲染层切骨架演出）
    const canSit = canSitNow()
    const sitAllowed = Date.now() > cardCooldownUntil // 0.45.90 起身冷却：强制先溜达
    if (canSit && sitAllowed && Math.random() < 0.55) {
      // 0.45.29：AuraDesk 上报文件（%TEMP%\auradesk-cards.json）一直没出现——
      // 它的渲染层 publishCards 从未发出（真机验证过文件不存在）。兜底：用窗台
      // 枚举找 AuraDesk 的窗口，把它的顶边当成一张「卡片」坐上去（视觉一致）
      let cards = visibleCards(petlink.readCards())
      if (!cards.length) cards = visibleCards(auraDeskWindowsAsCards())
      if (cards.length > 1) cards = cards.filter((c) => String(c.id) !== lastCardId) // 别老坐同一张
      const card = petlink.pickCard(cards, state.pos.x, state.pos.y, d)
      if (card) { restOnCard(card); return }
    }
    // 0.45.29 原地坐下休息：用户反馈「坐下/躺下这些动作从没见过」——坐卡联动没数据、
    // pet_act 模型很少主动用，那就让她自己偶尔坐一会儿（坐下→发呆→起身接着溜达）
    if (canSit && sitAllowed && Math.random() < 0.3) { restInPlace(); return }
    /* 0.45.54 站着待机（真根因修复）：自主活动以前只有「坐卡片 / 原地坐 / 走路」三种，
       从不出现「站着发呆」这个状态 → 渲染层待机 VRMA 池（7 条外采动作）自装进去后
       一次都没播过，用户看到的就是「动作还是一样」。这里给她 8~18s 站立停留，
       渲染层站住 2.2s 就会自己挑一条池内动作播。 */
    if (Math.random() < 0.35) { standIdle(8000 + Math.random() * 10000); return }
    const lively = walkMode() === 'lively'
    const dir = Math.random() < 0.5 ? -1 : 1
    const dist = (lively ? 160 : 80) + Math.random() * (lively ? 300 : 180)
    let target = state.pos.x + dir * dist
    target = Math.max(minX, Math.min(maxX, target))
    if (Math.abs(target - state.pos.x) < 40) {
      // 已经在边上 → 掉头走
      target = Math.max(minX, Math.min(maxX, state.pos.x - dir * dist))
    }
    // 0.30.0：慢下来。0.29.0 的 52/105px/s 配上渲染层 3 步/秒的步频 = 小跑，
    // 现在渲染层按「1.16~1.55 步/秒」算步频，位移速度也一起降一点才不显得赶。
    walkTo(target, lively ? 76 : 46) // px/s
  } catch { scheduleWander() }
}

function walkTo (targetX, speed, onDone) {
  leaveLedge() // 走路 = 离开窗台
  leaveGroundRest(false) // 0.45.35 坐着被叫走：先站起来
  leaveCard(false) // 0.45.35 坐卡片上被叫走：先下来再走
  stopWalk()
  const from = state.pos.x
  const t0 = Date.now()
  const dur = Math.max(320, (Math.abs(targetX - from) / speed) * 1000)
  // 带上速度：渲染层按「步幅 ÷ 速度」算步频，活跃档步子迈得明显比悠闲档快
  walkDir = Math.sign(targetX - from) || 1
  try { if (broadcast) broadcast('pet:walk', { on: true, dir: walkDir, speed }) } catch {}
  const timer = setInterval(() => {
    if (!state.pos || drag || !state.visible || inertia) { stopWalk(); return }
    const p = Math.min(1, (Date.now() - t0) / dur)
    // 缓入缓出：起步和收步都轻一点，看起来像迈步而不是被拖动
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
    state.pos = { x: Math.round(from + (targetX - from) * e), y: state.pos.y }
    pushPos()
    if (p >= 1) {
      stopWalk()
      // 自己走到哪就记到哪：下次启动从这继续，不会回到上次拖拽的位置
      if (patchCfgFnRef && state.pos) { try { patchCfgFnRef({ petPos: state.pos }) } catch {} }
      if (typeof onDone === 'function') onDone()
      else scheduleWander()
    }
  }, 16) // 0.45.50：33→16ms，配渲染层亚像素+过渡插值，走路不再 1~2px 顿挫
  walkAnim = { timer }
}

/* ---------------- 卡片联动：走过去坐到卡片上（0.29.0） ---------------- */
function stageHeight () {
  const sc = Number(petCfg().petScale)
  return STAGE_H * (sc > 0 ? sc : 1)
}

function restOnCard (card, opt) {
  leaveLedge()
  leaveGroundRest(false)
  const cx = Math.round(Number(card.x) + Number(card.w) / 2)
  // 记住坐卡前的地面高度：坐上卡片时窗口会抬到卡片顶边，
  // 起身时必须落回来，否则之后待机/溜达一直悬在半空（0.31.0 用户报的「角色像漂浮的」）
  const fromY = state.pos ? state.pos.y : 0
  walkTo(cx, 46, () => {
    if (!state.pos) return
    // 锚点是「舞台底边中点」：坐姿胯部在底边上方 0.37 身高处，对齐卡片顶边
    state.pos = { x: cx, y: Math.round(Number(card.y) + stageHeight() * SIT_HIPS) }
    pushPos()
    if (patchCfgFnRef && state.pos) { try { patchCfgFnRef({ petPos: state.pos }) } catch {} }
    try { if (broadcast) broadcast('pet:pose', { pose: 'sit' }) } catch {}
    petlink.writePet({ cardId: String(card.id || ''), mode: 'rest' })
    // 0.45.35 命令坐下 = 持续坐姿：不设自动起身闹钟，一直坐着直到被打断
    // （拎起来 / 叫她走路 / 命令站起来）。自主随机休息照旧 18~36s 自动起身。
    const persistent = !!(opt && opt.persistent)
    const stay = 18000 + Math.random() * 18000
    rest = {
      cardId: String(card.id || ''), fromY, sitY: Math.round(Number(card.y) + stageHeight() * SIT_HIPS),
      timer: persistent ? null : setTimeout(leaveCard, stay), persistent
    }
    log('[petlink] 坐到卡片', card.name || card.id, persistent ? '（持续坐，等叫起）' : '休息 ' + Math.round(stay / 1000) + 's')
  })
}

/* ---------------- 0.45.35 命令坐下/站起来（主人 2026-10-31：坐下是持续动作，还要找卡片联动） ----------------
 * 与 restInPlace（自主随机休息，10~25s 自动起身）的区别：
 *  1. 优先找卡片联动：AuraDesk 卡片文件 → 窗口顶边兜底 → 走过去坐下，都不行才原地坐
 *  2. 持续坐：不设自动起身闹钟，一直坐着直到被打断（拎起来/叫她走路/命令站起来） */
function sitOnCommand () {
  if (!state.visible) return { ok: false, reason: '角色当前没有显示' }
  if (drag) return { ok: false, reason: '正被拎着，放下再坐' }
  if (!canSitNow()) return { ok: false, reason: '当前形象没有坐姿（3D 模型，或配了坐姿骨架的 Spine 才能坐）' }
  if (rest) return { ok: true, on: 'card', already: true, note: '已经坐在卡片上了' }
  if (groundRest && groundRest.persistent) return { ok: true, on: 'ground', already: true, note: '已经坐着了' }
  // 0.46.0 撤掉挂着的溜达定时器：不撤的话，boot 自动坐下后定时器到点会
  // startWander → leaveCard 把她从卡片上拽下来（真机 0.46.0 首启实测踩到）。
  clearTimeout(walkTimer); walkTimer = null
  try {
    const { screen } = require('electron')
    const d = screen.getDisplayNearestPoint({ x: Math.round(state.pos.x), y: Math.round(state.pos.y) })
    let cards = visibleCards(petlink.readCards())
    if (!cards.length) cards = visibleCards(auraDeskWindowsAsCards())
    const card = petlink.pickCard(cards, state.pos.x, state.pos.y, d)
    if (card) { restOnCard(card, { persistent: true }); return { ok: true, on: 'card', name: card.name || card.id } }
  } catch (e) { log('[pet] sitOnCommand 找卡片失败:', e && e.message) }
  // 没有可坐的卡片 → 原地持续坐
  if (groundRest) { clearTimeout(groundRest.timer); groundRest.persistent = true; groundRest.timer = null; return { ok: true, on: 'ground', already: true } }
  groundRest = { timer: null, persistent: true }
  try { if (broadcast) broadcast('pet:pose', { pose: 'sit', style: 'ground' }) } catch { }
  log('[pet] 命令坐下（持续坐，附近没有可坐的卡片）')
  return { ok: true, on: 'ground' }
}

function standOnCommand () {
  const a = leaveGroundRest(false)
  const b = leaveCard(false)
  if (a || b) scheduleWander()
  return { ok: !!(a || b) }
}

/** 0.45.29 兜底：AuraDesk 的卡片上报文件一直没出现（真机验证 %TEMP%\auradesk-cards.json
 *  不存在，它的渲染层 publishCards 从未发出）。从窗口枚举里找 AuraDesk 的窗口，
 *  把窗口顶边当一张「卡片」——坐上去的视觉与坐卡片一致（胯部贴顶边）。 */
function auraDeskWindowsAsCards () {
  try {
    return ledgeApi.topEdges(process.pid)
      .filter((w) => /auradesk/i.test(w.title))
      .map((w) => ({ id: 'auradesk-win-' + w.hwnd, name: 'AuraDesk', x: w.x, y: w.y, w: w.w, h: w.h }))
  } catch { return [] }
}

/**
 * 0.45.31 卡片可见性筛：只坐「顶边看得见」的卡片。
 * 用户 10-30 实测：他的任务栏在屏幕顶部，AuraDesk 窗口顶边≈0，她坐上去头和身子
 * 全在屏幕外、只剩腿垂在任务栏下面（外观=走走着突然瞬移到屏幕顶端）。
 * 规则：顶边要离工作区顶边足够远（头顶不伸出屏幕），顶边不能贴着工作区底边
 * （脚会伸进任务栏），近乎全屏的窗口不是卡片（那是桌面本身）。
 */
function visibleCards (cards) {
  try {
    const { screen } = require('electron')
    const needHeadroom = stageHeight() * 0.5 // 头顶在胯上 0.78 身高，留半舞台高做净空
    return (cards || []).filter((c) => {
      const x = Number(c.x); const y = Number(c.y)
      const w = Number(c.w); const h = Number(c.h)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return false
      for (const d of screen.getAllDisplays()) {
        const wa = d.workArea
        if (x + w < wa.x || x > wa.x + wa.width) continue // 横向不在这块屏
        if (y < wa.y + needHeadroom) continue             // 顶边太高=坐上去头出屏
        if (y > wa.y + wa.height - 60) continue           // 顶边贴底=脚垂进任务栏
        if (h > wa.height * 0.85) continue                // 最大化/全屏窗口不是卡片
        return true
      }
      return false
    })
  } catch { return cards || [] }
}

/** 0.45.54 站着待机：纯站立停留 8~18s（不坐、不走），给渲染层待机 VRMA 腾出窗口。
 *  渲染层的逻辑是「站住满 2.2s 播一条池内动作」，所以这段停留必然看得到动作。 */
let standTimer = null
function standIdle (ms) {
  if (drag || ledge || rest || groundRest || !state.visible) { scheduleWander(); return }
  clearTimeout(standTimer)
  try { if (broadcast) broadcast('pet:pose', { pose: 'stand' }) } catch { }
  log('[pet] 站着待机 ' + Math.round(ms / 1000) + 's')
  standTimer = setTimeout(() => { standTimer = null; scheduleWander() }, ms)
}

/** 0.45.29 原地坐下休息：不占卡片，就地坐下发呆 10~25s 再起身。
 *  渲染层 setPose('sit') 是程序化姿势（能无限保持），比一次性官方 clip 更像「坐着歇会儿」。 */
function restInPlace () {
  if (groundRest || drag || ledge || rest || !state.visible) return
  try { if (broadcast) broadcast('pet:pose', { pose: 'sit', style: 'ground' }) } catch { }
  const stay = 10000 + Math.random() * 15000
  groundRest = { timer: setTimeout(() => leaveGroundRest(true), stay) }
  log('[pet] 原地坐下休息 ' + Math.round(stay / 1000) + 's')
}

function leaveGroundRest (thenWander) {
  if (!groundRest) return false
  clearTimeout(groundRest.timer)
  groundRest = null
  cardCooldownUntil = Date.now() + 90000 // 0.45.90 起身冷却
  try { if (broadcast) broadcast('pet:pose', { pose: 'stand' }) } catch { }
  if (thenWander !== false) scheduleWander()
  return true
}

function leaveCard (thenWalk) {
  if (!rest) return false
  clearTimeout(rest.timer)
  cardCooldownUntil = Date.now() + 90000 // 0.45.90 起身冷却：先溜达再考虑坐下一次
  lastCardId = String(rest.cardId || '')
  // 落回坐卡前的地面高度（x 保持当前位置）：不还原 y 角色就会悬空待机。
  // 边界：记住的高度不比卡片锚点低（上次悬空时配置里存的就是卡片高度 y）→
  // 说明那不是地面，回落到当前屏幕工作区底边自愈
  if (state.pos) {
    let fy = Number.isFinite(rest.fromY) ? rest.fromY : -Infinity
    if (!(fy > rest.sitY)) {
      try {
        const { screen } = require('electron')
        const d = screen.getDisplayNearestPoint({ x: Math.round(state.pos.x), y: Math.round(state.pos.y) })
        fy = d.workArea.y + d.workArea.height - stageHeight()
      } catch { fy = -Infinity }
    }
    if (Number.isFinite(fy)) state.pos = { x: state.pos.x, y: Math.round(fy) }
  }
  rest = null
  try { if (broadcast) broadcast('pet:pose', { pose: 'stand' }) } catch {}
  petlink.writePet(null)
  if (thenWalk !== false) scheduleWander()
  return true
}

function stopWalk () {
  if (walkAnim) { clearInterval(walkAnim.timer); walkAnim = null }
  walkDir = 0
  try { if (broadcast) broadcast('pet:walk', { on: false }) } catch {}
}

/** 0.33.0 自我状态感知：把「她此刻正在做什么」讲给会话层。
 *  主人每次开口时由 assistant 侧调用并注入上下文——
 *  以前走动/坐卡片/被拎着只是状态机在转，她自己完全不知道自己在干嘛。
 *  返回 null = 普通待机，没什么值得说的（不占通知额度）。 */
function describeActivity () {
  if (!state.visible) return null
  if (drag) return '正被主人拎在手里'
  if (inertia) return '刚被甩出去，正滑行减速'
  if (rest) return '正坐在一张卡片上休息'
  if (groundRest) return '正坐在地上休息'
  if (ledge) return '正趴在某个窗口的顶边（窗台）上'
  if (walkAnim) return walkDir < 0 ? '正在屏幕上往左走（自己溜达）' : '正在屏幕上往右走（自己溜达）'
  if (quietOn) return '正在安静模式里待着（不走动、不主动出声）'
  if (paused) return '活动被暂停了（主人按了暂停）'
  return null
}

/** 设置变更（走动档位/全屏让位）后重排行为 */
function refreshBehavior () {
  stopWalk()
  scheduleWander()
}

/* ---------------- S3：模型驱动走动（pet_move_to）/ 安静（pet_quiet） ---------------- */

/** 目标解析：数字(0~1 屏宽比例) / left / center / right / cursor → 全局 x 坐标 */
function resolveTargetX (to) {
  const { screen } = require('electron')
  if (!state.pos) return null
  const d = screen.getDisplayNearestPoint({ x: Math.round(state.pos.x), y: Math.round(state.pos.y) })
  const b = d.workArea
  let x = null
  if (typeof to === 'number' && isFinite(to)) x = b.x + b.width * Math.min(1, Math.max(0, to))
  else if (to === 'cursor') x = screen.getCursorScreenPoint().x
  else if (to === 'left') x = b.x + 80
  else if (to === 'right') x = b.x + b.width - 80
  else if (to === 'center') x = b.x + b.width / 2
  if (x == null) return null
  // 夹到整个虚拟桌面（不是当前屏）：模型说「走到鼠标那边」时鼠标可能在另一块屏，
  // 之前按本屏 left/right 夹会把目标压回原屏 → 看起来「永远走不过去」。
  let minX = b.x + 60, maxX = b.x + b.width - 60
  try {
    const all = screen.getAllDisplays()
    if (all.length > 1) {
      let lo = Infinity, hi = -Infinity
      for (const t of all) { lo = Math.min(lo, t.workArea.x); hi = Math.max(hi, t.workArea.x + t.workArea.width) }
      minX = lo + 60; maxX = hi - 60
    }
  } catch {}
  return Math.round(Math.max(minX, Math.min(maxX, x)))
}

/**
 * 走到指定位置；返回 Promise：
 *  { ok:true, x, ms } 到位 / { ok:false, reason, x?, interrupted? } 被打断或没走到
 * 最多等 30 秒（拖动、隐藏、崩溃都算打断）。
 */
function moveToFraction (to, run) {
  return new Promise((resolve) => {
    if (!state.visible) return resolve({ ok: false, reason: '角色当前没有显示在桌面上' })
    if (!state.pos) return resolve({ ok: false, reason: '角色位置还没就绪' })
    const target = resolveTargetX(typeof to === 'string' && /^-?\d+(\.\d+)?$/.test(to) ? Number(to) : to)
    if (target == null) return resolve({ ok: false, reason: '不支持的目标：' + String(to) })
    const from = state.pos.x
    const dist = Math.abs(target - from)
    if (dist < 6) return resolve({ ok: true, x: Math.round(from), ms: 0 })
    const speed = run ? 190 : 62 // px/s：跑三倍多，但不会瞬移
    clearTimeout(walkTimer)
    walkTimer = null
    walkTo(target, speed)
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (!state.pos) { clearInterval(timer); return resolve({ ok: false, reason: '角色消失了' }) }
      const arrived = Math.abs(state.pos.x - target) <= 6
      const interrupted = drag || !walkAnim
      const timeout = Date.now() - t0 > 30000
      if (arrived || interrupted || timeout) {
        clearInterval(timer)
        if (arrived) return resolve({ ok: true, x: Math.round(state.pos.x), ms: Date.now() - t0 })
        return resolve({
          ok: false,
          interrupted: !!interrupted,
          reason: timeout ? '30 秒内没走到' : (drag ? '被拖拽打断' : '走动被打断'),
          x: Math.round(state.pos.x)
        })
      }
    }, 100)
  })
}

/** 安静开关：关掉自主走动（不影响用户设置的档位，解除后照原档位继续） */
function setQuiet (on) {
  const next = !!on
  if (next === quietOn) return
  quietOn = next
  if (next) {
    stopWalk()
    clearTimeout(walkTimer)
    walkTimer = null
  } else {
    scheduleWander()
  }
}

/** 暂停/继续（右键菜单、托盘）：暂停期间不自主走动，也不接主动行为；恢复后照原档位继续 */
function setPaused (on) {
  const next = !!on
  if (next === paused) return
  paused = next
  log('[pet] ' + (next ? '暂停' : '继续') + '（自主走动' + (next ? '停止' : '恢复') + '）')
  if (next) {
    stopWalk()
    stopInertia()
    clearTimeout(walkTimer)
    walkTimer = null
  } else {
    scheduleWander()
  }
}

const isPaused = () => paused

/** 全屏让位：全屏游戏/视频时暂时收起角色，退出全屏自动回来（不动用户开关） */
function setSuspended (v) {
  const on = petCfg().petFullscreenHide !== false
  const next = !!(v && on)
  if (next === suspended) return
  suspended = next
  log('[pet] 全屏让位 →', suspended ? '收起角色' : '恢复显示')
  applyVisible()
}

/** 当前锚点（全局坐标深拷贝）；还没正位时返回 null */
function getPos () {
  return state.pos ? { x: Math.round(state.pos.x), y: Math.round(state.pos.y) } : null
}

/** 0.45.83 平滑滑动到目标锚点（游戏模式进出不再瞬移）：
 * easeInOut 分步推位置（~30fps），被拖拽就停在当前步；
 * 结束调 placeAt 收口（落盘 petPos + 全量广播 + 恢复自主走动调度）。
 * 滑动过程不写配置，只有终点落盘——避免 30 次配置写入。 */
function glideTo (p, opt) {
  if (!p || !isFinite(p.x) || !isFinite(p.y)) return false
  if (drag) return false
  const from = getPos()
  const to = clampPos({ x: Number(p.x), y: Number(p.y) })
  if (!from) return placeAt(to)
  const dist = Math.hypot(to.x - from.x, to.y - from.y)
  if (dist < 8) return placeAt(to)
  const ms = Math.max(200, Math.min(1200, Number(opt && opt.ms) || 700))
  leaveLedge()
  stopWalk()
  stopInertia()
  clearTimeout(walkTimer)
  walkTimer = null
  clearTimeout(glideTimer)
  const steps = Math.max(8, Math.round(ms / 33))
  let i = 0
  const step = () => {
    if (drag || !state.visible) { glideTimer = null; return } // 被拖拽/隐藏：停在当前步
    i++
    const t = Math.min(1, i / steps)
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 // easeInOutQuad
    state.pos = clampPos({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e })
    pushPos()
    if (t < 1) {
      glideTimer = setTimeout(step, ms / steps)
    } else {
      glideTimer = null
      placeAt(to)
    }
  }
  step()
  return true
}

/** 拖拽/手动 placeAt 时顺手掐掉进行中的滑动，避免两路抢坐标 */
function cancelGlide () {
  clearTimeout(glideTimer)
  glideTimer = null
}

/**
 * 外部（游戏模式）把角色摆到指定锚点：夹回屏内 + 立即广播 + 落盘，
 * 拖拽中直接拒绝——否则会和主驱拖拽抢坐标。
 */
function placeAt (p) {
  if (!p || !isFinite(p.x) || !isFinite(p.y)) return false
  if (drag) return false
  cancelGlide() // 0.45.83 外部落点优先于进行中的滑动
  leaveLedge()
  stopWalk()
  stopInertia()
  clearTimeout(walkTimer)
  walkTimer = null
  state.pos = clampPos({ x: Number(p.x), y: Number(p.y) })
  pushPos()
  if (patchCfgFnRef) { try { patchCfgFnRef({ petPos: state.pos }) } catch {} }
  scheduleWander()
  return true
}

function push () {
  try { if (broadcast) broadcast('pet:state', state) } catch (e) { log('[pet] 广播失败:', e && e.message) }
}

function pushPos () {
  try {
    if (broadcast && state.pos) broadcast('pet:pos', Object.assign({}, state.pos, { dragging: !!drag }))
  } catch {}
}

/** v0.4.3 关键修复：向单个（刚加载完的）overlay 推送全量当前状态。
 * 此前依赖 boot 时的全局广播，但 overlay 渲染层加载比广播慢——第二块屏永远
 * 错过角色卡/缩放配置，petState() 拉到 char=null → 该屏永远无法显示角色，
 * 跨屏拖过去就是「角色消失」。did-finish-load 后逐窗补发。 */
function pushTo (win) {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('pet:state', state)
    if (state.pos) win.webContents.send('pet:pos', Object.assign({}, state.pos, { dragging: !!drag }))
    const c = petCfg()
    if (c.petScale != null || c.replyLang != null) {
      win.webContents.send('pet:config', { scale: c.petScale, replyLang: c.replyLang })
    }
  } catch (e) { log('[pet] pushTo 失败:', e && e.message) }
}

/** 虚拟桌面并集边界，把锚点夹回屏内（x 留 60px 边距，y 是底边：上留 140px 露出头部，下贴任务栏上方 6px） */
function clampPos (p) {
  const { screen } = require('electron')
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const d of screen.getAllDisplays()) {
    const b = d.bounds
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height)
  }
  if (!isFinite(minX)) return p
  return {
    x: Math.round(Math.max(minX + 60, Math.min(maxX - 60, p.x))),
    y: Math.round(Math.max(minY + 140, Math.min(maxY - 6, p.y)))
  }
}

/** 显隐的唯一出口：用户开关 ∩ 非全屏让位 */
function applyVisible () {
  const vis = userVisible && !suspended
  if (state.visible === vis) { push(); return }
  state.visible = vis
  if (!vis) {
    // 收起时把所有自主行为停掉（否则定时器还会在看不见的地方推位置）
    leaveLedge()
    stopWalk()
    stopInertia()
    clearTimeout(walkTimer)
    walkTimer = null
  } else {
    scheduleWander()
  }
  push()
}

function show () {
  userVisible = true
  applyVisible()
}

function hide () {
  userVisible = false
  applyVisible()
}

/** 角色保存/切换后通知刷新（把最新角色卡带给 overlay） */
function refresh (char) {
  state.char = char
  push()
}

function boot () {
  const c = petCfg()
  // petOn 未配置过时默认显示
  userVisible = c.petOn !== false
  state.visible = userVisible && !suspended
  // 恢复上次的全局位置（v0.3.2 跨屏拖拽）；没有则留 null，由渲染层迁移旧 localStorage 位置或取默认
  if (c.petPos && isFinite(c.petPos.x) && isFinite(c.petPos.y)) state.pos = clampPos(c.petPos)
  // 0.45.31：启动时把「头顶出屏」的坏位置托回来——坐上过隐形卡片/窗台的位置会被持久化，
  // 重启后原地复现（用户 10-30 实测：卡在屏幕顶只剩腿）。拖拽路径不动：拖的时候用户看得见，自己会放好。
  if (state.pos) {
    try {
      const { screen } = require('electron')
      const minY = Math.min(...screen.getAllDisplays().map((d) => d.bounds.y))
      const minYok = minY + stageHeight() * 0.85 // 站立角色≈0.85 舞台高，低于这条线头必然出屏
      if (state.pos.y < minYok) state.pos = { x: state.pos.x, y: Math.round(minYok) }
    } catch { }
  }
  log('[pet] overlay 模式启动, visible =', state.visible, 'pos =', JSON.stringify(state.pos),
    'walk =', c.petWalk || 'off', 'fullscreenHide =', c.petFullscreenHide !== false)
  scheduleWander()
  // 0.46.0 默认坐下（用户 11-02：「现在的 spine 只有坐姿，所以应该默认坐在某一张卡片上
  // 或者坐在某个还未关闭的程序上。不用移动」）：启动几秒后自动执行一次 sitOnCommand——
  // 优先坐 AuraDesk 卡片 → AuraDesk 窗口顶边兜底 → 都没有就原地持续坐。
  // 只在启动时做这一次，之后主人拎起来 / 叫她走 / 命令站起，就不再自动摁回去。
  clearTimeout(defaultSitTimer)
  defaultSitTimer = setTimeout(() => {
    defaultSitTimer = null
    try {
      if (!state.visible || drag || rest || (groundRest && groundRest.persistent)) return
      const r = sitOnCommand()
      if (r && r.ok) log('[pet] 默认坐下 →', r.on, r.name || '')
    } catch (e) { log('[pet] 默认坐下失败:', e && e.message) }
  }, 4000)
}

function registerIpc (getChar, patchCfgFn) {
  const { ipcMain } = require('electron')
  patchCfgFnRef = patchCfgFn || null
  ipcMain.handle('pet:show', () => {
    show()
    if (patchCfgFn) patchCfgFn({ petOn: true })
    return true
  })
  ipcMain.handle('pet:hide', () => {
    hide()
    if (patchCfgFn) patchCfgFn({ petOn: false })
    return true
  })
  // 兼容旧 pet:win（pet 窗口的关闭按钮）
  ipcMain.handle('pet:win', (_e, action) => {
    if (action === 'close') { hide(); if (patchCfgFn) patchCfgFn({ petOn: false }) }
    return true
  })
  // overlay 启动时拉取初始状态
  ipcMain.handle('pet:state', () => state)
  // ---- v0.4.2 主进程驱动拖拽 ----
  // 渲染层 pointerdown 上报开始（带当前锚点）；主进程 16ms 轮询光标全局坐标跟随
  ipcMain.on('pet:drag-start', (_e, anchor) => dragStart(anchor))
  // 松手：任意一个 overlay 渲染层 window 级 pointerup 都会上报（拖拽期间全部窗口收鼠标）
  ipcMain.on('pet:drag-end', (_e, src) => dragEnd(src))
  // 对话中/悬停中：暂停自主走动（说完话、移开鼠标再继续溜达）
  ipcMain.on('pet:roam-hold', (_e, on) => {
    roamHold = !!on
    if (roamHold) { leaveCard(false); stopWalk(); clearTimeout(walkTimer); walkTimer = null } else scheduleWander()
  })
  // 5.5 悬停按钮「溜达」：立刻走一段
  ipcMain.on('pet:roam-now', () => roamNow())
  // 兼容：渲染层流式上报（v0.4.0 方案残留，主驱后不再使用，保留防旧包误调）
  ipcMain.on('pet:drag-move', (_e, x, y) => {
    if (!drag && state.visible) {
      state.pos = clampPos({ x: Number(x) || 0, y: Number(y) || 0 })
      pushPos()
    }
  })
  // 截屏取证：把屏幕真实画面存成 png（排查灰框等渲染问题，不用用户手动截图）
  const fs = require('fs')
  const path = require('path')
  const { screen, desktopCapturer } = require('electron')
  let snapSeq = 0
  ipcMain.handle('pet:snapshot', async (_e, tag) => {
    try {
      const d = screen.getPrimaryDisplay()
      const th = {
        width: Math.min(3840, Math.round(d.size.width * d.scaleFactor)),
        height: Math.min(2160, Math.round(d.size.height * d.scaleFactor))
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: th })
      if (!sources || !sources.length) return false
      snapSeq++
      const { app } = require('electron')
      const p = path.join(app.getPath('userData'), 'logs', 'pet-snap-' + (tag || snapSeq) + '.png')
      fs.writeFileSync(p, sources[0].thumbnail.toPNG())
      log('[pet] 截屏已保存:', p)
      return true
    } catch (e) { log('[pet] 截屏失败:', e && e.message); return false }
  })
}

module.exports = {
  show, hide, refresh, registerIpc, boot, setBroadcast, setWindowCtl, dragStart, dragEnd, pushTo, petCfg, remoteTouchTap,
  // S2 行为层
  setSuspended, refreshBehavior,
  // S3 模型驱动
  moveToFraction, setQuiet, resolveTargetX, walkMode,
  // 0.45.35 命令坐下/站起来（pet_act 的坐下=持续坐姿+卡片联动）
  sitOnCommand, standOnCommand,
  // 0.33.0 自我状态感知：当前活动快照
  describeActivity,
  // 0.18.0 第一批：暂停/继续
  setPaused, isPaused,
  // S6.5 游戏模式：摆位 / 取位（0.45.83 加 glideTo 平滑滑动）
  getPos, placeAt, glideTo,
  // 拖拽中：层级/穿透这些会打断指针捕获的操作必须让路
  isDragging: () => !!drag,
  // 0.46.14 动作测试面板诚实列词用：当前角色卡的 visual 配置
  currentVisual: () => (state.char && state.char.visual) || null
}
