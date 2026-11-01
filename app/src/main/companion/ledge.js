'use strict'
/**
 * 5.7 走到窗口顶边（ledge）：拖拽时/坐上后每 700ms 读一次可见窗口的矩形几何。
 * 只读几何（EnumWindows + GetWindowRect + DWM cloak），不读内容、不注入、不拦截。
 * koffi 缺失或调用失败时一律返回空表 → ledge 功能自动停用，不影响其它功能。
 * 物理像素 → DIP：除以「矩形中心点所在显示器」的 scaleFactor。
 */
let koffi = null
try { koffi = require('koffi') } catch {}

let api = null // 惰性初始化的 Win32 函数集；false = 不可用

const hwndCache = new Map() // number → koffi hwnd 指针对象（跨调用保活，rectOf 用）

function init () {
  if (api === false) return false
  if (api) return true
  if (!koffi) { api = false; return false }
  try {
    const user32 = koffi.user32 || koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')
    koffi.struct('LEDGE_PT', { x: 'long', y: 'long' })
    koffi.struct('LEDGE_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    api = {
      EnumWindows: user32.func('bool EnumWindows(void *cb, intptr_t p)'),
      IsWindowVisible: user32.func('bool IsWindowVisible(void *hwnd)'),
      IsIconic: user32.func('bool IsIconic(void *hwnd)'),
      GetWindowRect: user32.func('bool GetWindowRect(void *hwnd, _Out_ LEDGE_RECT *r)'),
      GetWindowTextW: user32.func('int GetWindowTextW(void *hwnd, void *buf, int max)'),
      GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
      DwmGetWindowAttribute: dwmapi.func('int DwmGetWindowAttribute(void *hwnd, uint32 attr, _Out_ uint32 *val, uint32 cb)'),
      proto: koffi.proto('bool __stdcall LEDGEEnumProc(void *hwnd, intptr_t lp)')
    }
    return true
  } catch { api = false; return false }
}

/** DWMWA_CLOAKED：被 shell 隐形的 UWP/虚拟桌面窗口要剔除，不然「坐在空气上」 */
function cloaked (hwnd) {
  try {
    const v = [0]
    if (api.DwmGetWindowAttribute(hwnd, 14, v, 4) === 0 && v[0]) return true
  } catch {}
  return false
}

function titleOf (hwnd) {
  try {
    const buf = Buffer.alloc(512)
    const n = api.GetWindowTextW(hwnd, buf, 256)
    return n > 0 ? buf.toString('utf16le', 0, n * 2) : ''
  } catch { return '' }
}

/** 物理像素 → DIP（按矩形中心点所在屏的缩放） */
function toDip (r) {
  try {
    const { screen } = require('electron')
    const cx = (r.left + r.right) / 2
    const cy = (r.top + r.bottom) / 2
    const sf = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) }).scaleFactor || 1
    return {
      x: r.left / sf, y: r.top / sf,
      w: (r.right - r.left) / sf, h: (r.bottom - r.top) / sf
    }
  } catch {
    return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
  }
}

/**
 * 可见、非最小化、非隐形、有标题、够大的顶层窗口列表（DIP）。
 * selfPid = 本应用进程号（自己的 overlay 窗口不算「别人的窗台」）。
 */
function topEdges (selfPid) {
  if (!init() || !api) return []
  const out = []
  const seen = new Set()
  const cb = koffi.register((hwnd) => {
    try {
      const key = Number(koffi.address(hwnd))
      if (seen.has(key)) return true
      seen.add(key)
      if (!api.IsWindowVisible(hwnd) || api.IsIconic(hwnd) || cloaked(hwnd)) return true
      const t = titleOf(hwnd).trim()
      if (!t) return true // 无标题工具窗口不坐
      const pid = [0]
      api.GetWindowThreadProcessId(hwnd, pid)
      if (selfPid && Number(pid[0]) === selfPid) return true
      const r = { left: 0, top: 0, right: 0, bottom: 0 }
      if (!api.GetWindowRect(hwnd, r)) return true
      const pw = r.right - r.left
      const ph = r.bottom - r.top
      if (pw < 340 || ph < 220) return true // 物理像素太小的不算窗台
      hwndCache.set(key, hwnd)
      const d = toDip(r)
      if (d.w < 200 || d.h < 120) return true
      out.push({ hwnd: key, title: t.slice(0, 60), x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.w), h: Math.round(d.h) })
    } catch { /* 单窗失败不影响整表 */ }
    return true
  }, koffi.pointer(api.proto))
  try { api.EnumWindows(cb, 0) } finally { try { koffi.unregister(cb) } catch {} }
  out.sort((a, b) => (b.w * b.h) - (a.w * a.h))
  return out
}

/** 按 hwnd 读单个窗口当前矩形（DIP）；窗口没了/最小化/隐形 → null（角色该摔下去了） */
function rectOf (hwndKey) {
  if (!init() || !api) return null
  const h = hwndCache.get(Number(hwndKey))
  if (!h) return null
  try {
    if (!api.IsWindowVisible(h) || api.IsIconic(h)) return null
    const r = { left: 0, top: 0, right: 0, bottom: 0 }
    if (!api.GetWindowRect(h, r)) return null
    if (r.right - r.left < 100) return null
    return toDip(r)
  } catch { return null }
}

module.exports = { topEdges, rectOf }
