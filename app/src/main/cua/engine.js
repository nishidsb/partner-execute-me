/**
 * CUA 引擎子进程（规格 4.3：引擎子进程隔离）
 *
 * 为什么单独开进程：用 koffi 直接调 user32/gdi32 是全进程最容易「炸掉」的地方
 * （非法指针 / 驱动级截图失败 / 某些安全软件挂钩直接异常）。放在子进程里，
 * 崩了只死这一个 worker，主进程 next 次调用自动重启，聊天不会跟着挂。
 *
 * 协议（父子通过 process.send / process.on('message')，启用 advanced 序列化：
 * Buffer 原样传输，截图不做 base64 膨胀）：
 *   父 → 子：{ id, op, args }
 *   子 → 父：{ id, ok: true, result } / { id, ok: false, error }
 *
 * 所有坐标都是**物理像素**的虚拟桌面坐标（等于 Win32 的屏幕坐标）。
 * 高 DPI 必须在启动时声明，否则 GetSystemMetrics / 鼠标坐标会拿到缩放后的逻辑值，
 * 截图与点击就会差一个缩放倍率（125% 时点偏 1/5 个屏幕）。
 */
const koffi = require('koffi')
// 缩放比在 geometry.js 里只写了一份（纯函数、无依赖，子进程也能直接 require）。
// 以前这里自己算了一遍 Math.min(1, maxW/sw, maxH/sh)，两处各改各的迟早不一致——
// 截图缩放和模型坐标换算必须用同一个数，差一点就是「点偏」。
const { fitScale } = require('./geometry')

/* ---------------- 高 DPI ---------------- */
try {
  const user32Dpi = koffi.load('user32.dll')
  // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4（Win10 1703+）
  const SetProcessDpiAwarenessContext = user32Dpi.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t ctx)')
  if (!SetProcessDpiAwarenessContext(-4)) {
    try { user32Dpi.func('bool __stdcall SetProcessDPIAware()')() } catch {}
  }
} catch (e) {
  // 老系统没有这个 API：退回下面的 SetProcessDPIAware
  try { koffi.load('user32.dll').func('bool __stdcall SetProcessDPIAware()')() } catch {}
}

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const kernel32 = koffi.load('kernel32.dll')

/* ---------------- 结构体 ---------------- */
const RECT = koffi.struct('CUA_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
const POINT = koffi.struct('CUA_POINT', { x: 'long', y: 'long' })
const LASTINPUTINFO = koffi.struct('CUA_LII', { cbSize: 'uint32', dwTime: 'uint32' })
const BITMAPINFOHEADER = koffi.struct('CUA_BIH', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32'
})
const BITMAPINFO = koffi.struct('CUA_BMI', { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array('uint32', 3) })

// INPUT 联合体：x64 下 sizeof(INPUT) = 40（DWORD type + 4 padding + 32 union）
const MOUSEINPUT = koffi.struct('CUA_MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t'
})
const KEYBDINPUT = koffi.struct('CUA_KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t'
})
const HARDWAREINPUT = koffi.struct('CUA_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
const INPUTUNION = koffi.union('CUA_INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT })
const INPUT = koffi.struct('CUA_INPUT', { type: 'uint32', u: INPUTUNION })

/* ---------------- 函数 ---------------- */
const GetSystemMetrics = user32.func('int GetSystemMetrics(int)')
const GetCursorPos = user32.func('bool GetCursorPos(_Out_ CUA_POINT *pt)')
const SetCursorPos = user32.func('bool SetCursorPos(int x, int y)')
const GetLastInputInfo = user32.func('bool GetLastInputInfo(_Inout_ CUA_LII *p)')
const GetTickCount64 = kernel32.func('uint64 GetTickCount64()')
const SendInput = user32.func('uint32 SendInput(uint32 n, CUA_INPUT *inputs, int size)')
const EnumWindows = user32.func('bool EnumWindows(void *cb, intptr_t p)')
const IsWindowVisible = user32.func('bool IsWindowVisible(void *hwnd)')
const IsIconic = user32.func('bool IsIconic(void *hwnd)')
const GetWindowTextW = user32.func('int GetWindowTextW(void *hwnd, void *buf, int max)')
const GetClassNameW = user32.func('int GetClassNameW(void *hwnd, void *buf, int max)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)')
const GetWindowRect = user32.func('bool GetWindowRect(void *hwnd, _Out_ CUA_RECT *r)')
const IsWindow = user32.func('bool IsWindow(void *hwnd)')
const ShowWindow = user32.func('bool ShowWindow(void *hwnd, int cmd)')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(void *hwnd)')
const BringWindowToTop = user32.func('bool BringWindowToTop(void *hwnd)')
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32 a, uint32 b, bool attach)')
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()')
const GetWindowThreadProcessId2 = user32.func('uint32 GetWindowThreadProcessId(void *hwnd, void *pid)')
const GetForegroundWindow = user32.func('void *GetForegroundWindow()')
const GetDC = user32.func('void *GetDC(void *hwnd)')
const ReleaseDC = user32.func('int ReleaseDC(void *hwnd, void *hdc)')
const CreateCompatibleDC = gdi32.func('void *CreateCompatibleDC(void *hdc)')
const CreateCompatibleBitmap = gdi32.func('void *CreateCompatibleBitmap(void *hdc, int w, int h)')
const SelectObject = gdi32.func('void *SelectObject(void *hdc, void *obj)')
const StretchBlt = gdi32.func('bool StretchBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, int sw, int sh, uint32 rop)')
const SetStretchBltMode = gdi32.func('int SetStretchBltMode(void *hdc, int mode)')
const GetDIBits = gdi32.func('int GetDIBits(void *hdc, void *hbmp, uint32 start, uint32 lines, void *bits, _Inout_ CUA_BMI *bmi, uint32 usage)')
const DeleteObject = gdi32.func('bool DeleteObject(void *obj)')
const DeleteDC = gdi32.func('bool DeleteDC(void *hdc)')

/* ---------------- 常量 ---------------- */
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79
const SRCCOPY = 0x00cc0020
const CAPTUREBLT = 0x40000000
const HALFTONE = 4
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_MIDDLEDOWN = 0x0020
const MOUSEEVENTF_MIDDLEUP = 0x0040
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_HWHEEL = 0x1000
const MOUSEEVENTF_ABSOLUTE = 0x8000
const MOUSEEVENTF_VIRTUALDESK = 0x4000
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004
const INPUT_SIZE = 40

const BUTTONS = {
  left: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  right: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
  middle: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(60000, ms | 0))))

/* ---------------- 基础 ---------------- */
function metrics () {
  const vx = GetSystemMetrics(SM_XVIRTUALSCREEN)
  const vy = GetSystemMetrics(SM_YVIRTUALSCREEN)
  const vw = GetSystemMetrics(SM_CXVIRTUALSCREEN)
  const vh = GetSystemMetrics(SM_CYVIRTUALSCREEN)
  return { vx, vy, vw, vh, primaryW: GetSystemMetrics(0), primaryH: GetSystemMetrics(1) }
}

function cursor () {
  const p = { x: 0, y: 0 }
  GetCursorPos(p)
  return { x: Number(p.x), y: Number(p.y) }
}

function idleMs () {
  const li = { cbSize: 8, dwTime: 0 }
  if (!GetLastInputInfo(li)) return 0
  const now = Number(GetTickCount64())
  const t = Number(li.dwTime)
  // dwTime 是 32 位、约 49.7 天回绕；GetTickCount64 没有。用低 32 位相减避免负数
  let d = (now & 0xffffffff) - t
  if (d < 0) d += 0x100000000
  return Math.max(0, d)
}

/** 绝对坐标 → SendInput 归一化坐标（0..65535 映射到整个虚拟桌面） */
function toAbs (x, y, m) {
  const nx = Math.round(((x - m.vx) * 65535) / Math.max(1, m.vw - 1))
  const ny = Math.round(((y - m.vy) * 65535) / Math.max(1, m.vh - 1))
  return { nx, ny }
}

function mouseInput (flags, data) {
  return { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: data | 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

function keyInput (vk, flags) {
  return { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

function send (inputs) {
  if (!inputs.length) return 0
  const n = SendInput(inputs.length, inputs, INPUT_SIZE)
  if (n !== inputs.length) throw new Error('SendInput 被系统拦截（发 ' + inputs.length + ' 条，实际 ' + n + ' 条）')
  return n
}

function moveTo (x, y) {
  const px = Math.round(x)
  const py = Math.round(y)
  if (!SetCursorPos(px, py)) {
    // 极少数情况 SetCursorPos 被拒（某些全屏独占程序），退到 SendInput 绝对坐标
    const { nx, ny } = toAbs(px, py, metrics())
    send([{
      type: INPUT_MOUSE,
      u: { mi: { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, time: 0, dwExtraInfo: 0 } }
    }])
  }
  return cursor()
}

/* ---------------- 截图 ---------------- */
/**
 * StretchBlt 抓屏并直接在 GDI 里缩放到目标尺寸：
 * - 原始 4K 屏 BGRA 是 33MB，缩到 1280 宽只有几 MB，父子传输和 PNG 编码都省
 * - 抓的是屏幕合成结果（BitBlt 的屏幕 DC），硬件加速窗口、透明窗口都能拍到
 */
function shot ({ x, y, w, h, maxW = 1280, maxH = 800 } = {}) {
  const m = metrics()
  const sx = Number.isFinite(x) ? Math.round(x) : m.vx
  const sy = Number.isFinite(y) ? Math.round(y) : m.vy
  const sw = Math.max(1, Math.round(Number.isFinite(w) ? w : m.vw))
  const sh = Math.max(1, Math.round(Number.isFinite(h) ? h : m.vh))
  const scale = fitScale(sw, sh, maxW, maxH)
  const ow = Math.max(1, Math.round(sw * scale))
  const oh = Math.max(1, Math.round(sh * scale))

  const screen = GetDC(null)
  if (!screen) throw new Error('拿不到屏幕 DC（可能被安全软件拦截）')
  const mem = CreateCompatibleDC(screen)
  const bmp = CreateCompatibleBitmap(screen, ow, oh)
  const old = SelectObject(mem, bmp)
  SetStretchBltMode(mem, HALFTONE)
  let ok = false
  try {
    ok = StretchBlt(mem, 0, 0, ow, oh, screen, sx, sy, sw, sh, SRCCOPY | CAPTUREBLT)
  } finally {
    if (!ok) {
      // CAPTUREBLT 在某些驱动上失败，退到普通 SRCCOPY 再试一次
      ok = StretchBlt(mem, 0, 0, ow, oh, screen, sx, sy, sw, sh, SRCCOPY)
    }
  }
  const bmi = {
    bmiHeader: {
      biSize: 40, biWidth: ow, biHeight: -oh, biPlanes: 1, biBitCount: 32, biCompression: 0,
      biSizeImage: ow * oh * 4, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0
    },
    bmiColors: [0, 0, 0]
  }
  const buf = Buffer.alloc(ow * oh * 4)
  const lines = GetDIBits(mem, bmp, 0, oh, buf, bmi, 0)
  SelectObject(mem, old)
  DeleteObject(bmp)
  DeleteDC(mem)
  ReleaseDC(null, screen)
  if (!ok) throw new Error('截图失败（StretchBlt 返回 false）')
  if (lines !== oh) throw new Error('截图取像素失败（GetDIBits 行数 ' + lines + '/' + oh + '）')
  return { buffer: buf, srcX: sx, srcY: sy, srcW: sw, srcH: sh, outW: ow, outH: oh, scale: ow / sw }
}

/* ---------------- 显示器 ---------------- */
const MONITOR_PROTO = koffi.proto('bool __stdcall CUAMonitorProc(void *hMon, void *hdc, CUA_RECT *rect, intptr_t data)')
const EnumDisplayMonitors = user32.func('bool EnumDisplayMonitors(void *hdc, void *clip, void *cb, intptr_t data)')

/**
 * 显示器列表。截图默认只截「光标所在那一块」：
 * 双屏加起来 5120 宽时整桌面缩到 1280 宽是 0.25 倍，字全糊；
 * 单屏 2560 宽缩到 1280 是 0.5 倍，模型才看得清按钮上的字。
 */
function monitors () {
  const out = []
  const cb = koffi.register((hMon, _hdc, rect) => {
    try {
      const r = koffi.decode(rect, RECT)
      out.push({
        x: Number(r.left), y: Number(r.top),
        w: Number(r.right) - Number(r.left),
        h: Number(r.bottom) - Number(r.top)
      })
    } catch {}
    return true
  }, koffi.pointer(MONITOR_PROTO))
  try { EnumDisplayMonitors(null, null, cb, 0) } finally { koffi.unregister(cb) }
  // 主显示器 = 左上角 (0,0) 的那块
  const primary = out.find((m) => m.x === 0 && m.y === 0) || out[0] || null
  return { count: out.length, primary, monitors: out }
}

function monitorAt (x, y) {
  const ms = monitors().monitors
  return ms.find((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) || null
}

/* ---------------- 窗口 ---------------- */
const WIN_PROTO = koffi.proto('bool __stdcall CUAEnumProc(void *hwnd, intptr_t lParam)')
// 枚举出来的窗口句柄指针按数值缓存：模型只能看到 / 传数字，
// 这里再把它换回原生指针（不做数值→指针的强行转换，避免地址空间不一致时乱指）
const winCache = new Map()

function windowTitle (hwnd) {
  const b = Buffer.alloc(1024)
  GetWindowTextW(hwnd, b, 512)
  return b.toString('utf16le').replace(/\0[\s\S]*$/, '')
}
function windowClass (hwnd) {
  const b = Buffer.alloc(512)
  GetClassNameW(hwnd, b, 256)
  return b.toString('utf16le').replace(/\0[\s\S]*$/, '')
}

function listWindows ({ includeMinimized = false, includeHidden = false } = {}) {
  const fg = GetForegroundWindow()
  const out = []
  const cb = koffi.register((hwnd) => {
    try {
      const visible = !!IsWindowVisible(hwnd)
      if (!visible && !includeHidden) return true
      const title = windowTitle(hwnd).trim()
      // 隐藏窗口（微信收托盘就是这样）允许空 title 进表，靠 class 找回
      if (!title && visible) return true
      const r = { left: 0, top: 0, right: 0, bottom: 0 }
      if (!GetWindowRect(hwnd, r)) return true
      const w = r.right - r.left
      const h = r.bottom - r.top
      if (!visible) {
        // 隐藏窗口只保留有名字/有类名的，尺寸放宽（恢复前 GetWindowRect 可能是 0）
        if (!title && w < 40 && h < 30) return true
      } else {
        if (w < 40 || h < 30) return true
      }
      const mini = IsIconic(hwnd)
      if (mini && !includeMinimized) return true
      const pid = [0]
      GetWindowThreadProcessId(hwnd, pid)
      const key = Number(koffi.address(hwnd))
      winCache.set(key, hwnd)
      out.push({
        hwnd: key,
        title: title.slice(0, 120),
        cls: windowClass(hwnd).slice(0, 60),
        pid: Number(pid[0]),
        x: r.left, y: r.top, w, h,
        minimized: !!mini,
        hidden: !visible,
        focused: hwnd === fg
      })
    } catch { /* 单个窗口读失败不影响整表 */ }
    return true
  }, koffi.pointer(WIN_PROTO))
  try { EnumWindows(cb, 0) } finally { koffi.unregister(cb) }
  // 前台窗口排最前，其余按面积倒序（大窗口通常是用户正在用的主窗口）
  out.sort((a, b) => (Number(b.focused) - Number(a.focused)) || (b.w * b.h - a.w * a.h))
  return out
}

/**
 * 激活窗口。后台进程直接 SetForegroundWindow 会被 Windows 拒绝，
 * 必须临时 AttachThreadInput 到前台窗口线程才能抢到前台（AuraDesk 同款做法）。
 */
function focusWindow ({ hwnd } = {}) {
  const key = Number(hwnd)
  const h = winCache.get(key)
  if (!h) throw new Error('未知窗口句柄 ' + hwnd + '：请先用 windows 工具拿最新的 hwnd 列表')
  if (!IsWindow(h)) throw new Error('窗口已关闭：' + hwnd)
  // SW_RESTORE：最小化要还原；隐藏窗口（微信收托盘）也要叫回来，否则聚焦不到
  if (IsIconic(h) || !IsWindowVisible(h)) ShowWindow(h, 9)
  const fg = GetForegroundWindow()
  const fgThread = GetWindowThreadProcessId2(fg, null)
  const myThread = GetCurrentThreadId()
  let attached = false
  if (fgThread && fgThread !== myThread) attached = !!AttachThreadInput(myThread, fgThread, true)
  try {
    BringWindowToTop(h)
    SetForegroundWindow(h)
  } finally {
    if (attached) AttachThreadInput(myThread, fgThread, false)
  }
  return { ok: GetForegroundWindow() === h, hwnd }
}

/* ---------------- 鼠标 / 键盘 ---------------- */
async function click ({ x, y, button = 'left', count = 1, delay = 60 } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click 需要 x / y')
  const [down, up] = BUTTONS[button] || BUTTONS.left
  moveTo(x, y)
  const n = Math.max(1, Math.min(3, Number(count) || 1))
  for (let i = 0; i < n; i++) {
    send([mouseInput(down, 0)])
    await sleep(delay)
    send([mouseInput(up, 0)])
    if (i < n - 1) await sleep(delay)
  }
  return { x: Math.round(x), y: Math.round(y), button, count: n }
}

async function drag ({ x1, y1, x2, y2, button = 'left', durationMs = 500 } = {}) {
  const [down, up] = BUTTONS[button] || BUTTONS.left
  const dur = Math.max(80, Math.min(5000, Number(durationMs) || 500))
  moveTo(x1, y1)
  await sleep(60)
  send([mouseInput(down, 0)])
  const steps = Math.max(6, Math.min(40, Math.round(dur / 25)))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    moveTo(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
    await sleep(dur / steps)
  }
  await sleep(60)
  send([mouseInput(up, 0)])
  return { from: [Math.round(x1), Math.round(y1)], to: [Math.round(x2), Math.round(y2)], ms: dur }
}

function scroll ({ x, y, dy = 0, dx = 0 } = {}) {
  if (Number.isFinite(x) && Number.isFinite(y)) moveTo(x, y)
  const v = Math.round(dy)
  const h = Math.round(dx)
  const inputs = []
  if (v) inputs.push(mouseInput(MOUSEEVENTF_WHEEL, -v * 120))
  if (h) inputs.push(mouseInput(MOUSEEVENTF_HWHEEL, h * 120))
  send(inputs)
  return { dy: v, dx: h }
}

/** 逐字符输入（KEYEVENTF_UNICODE 走扫描码，中文/emoji 也能打进去） */
async function typeText ({ text, delay = 8 } = {}) {
  const s = String(text == null ? '' : text)
  if (!s) return { chars: 0 }
  const units = []
  for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i))
  const chunk = 32
  for (let i = 0; i < units.length; i += chunk) {
    const inputs = []
    for (const code of units.slice(i, i + chunk)) {
      inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } } })
      inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } })
    }
    send(inputs)
    if (delay) await sleep(delay)
  }
  return { chars: units.length }
}

const VK = {
  ctrl: 0x11, control: 0x11, alt: 0x12, menu: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b, cmd: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, back: 0x08,
  delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, caps: 0x14, printscreen: 0x2c, pause: 0x13, app: 0x5d,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b
}
const VK_SYMBOL = {
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde
}

function keyCode (name) {
  const k = String(name || '').trim().toLowerCase()
  if (!k) return 0
  if (VK[k]) return VK[k]
  if (VK_SYMBOL[k]) return VK_SYMBOL[k]
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0)
  if (/^vk[_-]?[0-9a-f]{1,4}$/.test(k)) return parseInt(k.replace(/^vk[_-]?/, ''), 16)
  return 0
}

/** 组合键：'ctrl+shift+s' / 'alt+f4' / 'Enter' */
async function pressKeys ({ keys, delay = 40 } = {}) {
  const list = String(keys || '').split('+').map((s) => s.trim()).filter(Boolean)
  if (!list.length) throw new Error('keys 为空')
  const codes = list.map((k) => {
    const c = keyCode(k)
    if (!c) throw new Error('不认识的按键：' + k)
    return c
  })
  const downs = codes.map((c) => keyInput(c, 0))
  send(downs)
  await sleep(delay)
  send(codes.slice().reverse().map((c) => keyInput(c, KEYEVENTF_KEYUP)))
  return { keys: list.join('+') }
}

/* ---------------- 分发 ---------------- */
const OPS = {
  ping: () => ({ pid: process.pid, engine: 'koffi-uwp', koffi: koffi.version }),
  metrics,
  cursor,
  idle: () => ({ idleMs: idleMs() }),
  shot,
  monitors,
  monitorAt: ({ x, y }) => monitorAt(x, y),
  windows: listWindows,
  focus: focusWindow,
  move: ({ x, y }) => moveTo(x, y),
  click,
  drag,
  scroll,
  type: typeText,
  key: pressKeys,
  wait: async ({ ms }) => { await sleep(ms); return { waited: ms } }
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object' || !msg.id) return
  const fn = OPS[msg.op]
  if (!fn) {
    process.send({ id: msg.id, ok: false, error: '未知操作: ' + msg.op })
    return
  }
  try {
    const result = await fn(msg.args || {})
    process.send({ id: msg.id, ok: true, result })
  } catch (e) {
    process.send({ id: msg.id, ok: false, error: (e && e.message) || String(e) })
  }
})

process.on('uncaughtException', (e) => {
  try { process.send({ event: 'fatal', error: (e && e.stack) || String(e) }) } catch {}
  process.exit(1)
})

// 父进程没了就自己退，避免留下孤儿进程抓着屏幕 DC
process.on('disconnect', () => process.exit(0))
process.send({ event: 'ready', dpiAware: true, metrics: metrics() })
