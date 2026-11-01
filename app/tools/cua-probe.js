/**
 * CUA 引擎自检（不启动 Electron，直接 node 跑）：
 *   node tools/cua-probe.js
 *
 * 逐项验证 Win32 能力是否可用，并打印数字，便于「桌面上不动」时先确认
 * 是引擎坏了还是模型没按坐标点。任何一项 FAIL 都会让退出码非 0。
 */
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const kernel32 = koffi.load('kernel32.dll')

const GetSystemMetrics = user32.func('int GetSystemMetrics(int)')
const GetCursorPos = user32.func('bool GetCursorPos(_Out_ void *pt)')
const GetLastInputInfo = user32.func('bool GetLastInputInfo(_Inout_ void *plii)')
const GetTickCount64 = kernel32.func('uint64 GetTickCount64()')
const EnumWindows = user32.func('bool EnumWindows(void *cb, intptr_t param)')
const IsWindowVisible = user32.func('bool IsWindowVisible(void *hwnd)')
const GetWindowTextW = user32.func('int GetWindowTextW(void *hwnd, void *buf, int max)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)')
const GetWindowRect = user32.func('bool GetWindowRect(void *hwnd, _Out_ void *rect)')
const GetWindowLongPtr = user32.func('intptr_t GetWindowLongPtrW(void *hwnd, int idx)')
const GetDC = user32.func('void *GetDC(void *hwnd)')
const ReleaseDC = user32.func('int ReleaseDC(void *hwnd, void *hdc)')
const CreateCompatibleDC = gdi32.func('void *CreateCompatibleDC(void *hdc)')
const CreateCompatibleBitmap = gdi32.func('void *CreateCompatibleBitmap(void *hdc, int w, int h)')
const SelectObject = gdi32.func('void *SelectObject(void *hdc, void *obj)')
const BitBlt = gdi32.func('bool BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32 rop)')
const GetDIBits = gdi32.func('int GetDIBits(void *hdc, void *hbmp, uint32 start, uint32 lines, void *bits, void *bmi, uint32 usage)')
const DeleteObject = gdi32.func('bool DeleteObject(void *obj)')
const DeleteDC = gdi32.func('bool DeleteDC(void *hdc)')

const RECT = koffi.struct('PROBE_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
const POINT = koffi.struct('PROBE_POINT', { x: 'long', y: 'long' })
const LASTINPUTINFO = koffi.struct('PROBE_LII', { cbSize: 'uint32', dwTime: 'uint32' })
const BITMAPINFOHEADER = koffi.struct('PROBE_BIH', {
  biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
  biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32', biClrImportant: 'uint32'
})
const BITMAPINFO = koffi.struct('PROBE_BMI', { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array('uint32', 3) })

let failed = 0
function check (name, fn) {
  try {
    const r = fn()
    console.log('OK   ' + name + (r === undefined ? '' : '  → ' + r))
  } catch (e) {
    failed++
    console.log('FAIL ' + name + '  → ' + (e && e.message))
  }
}

check('版本', () => 'koffi ' + koffi.version + ' / node ' + process.versions.node)
check('虚拟桌面', () => {
  const vx = GetSystemMetrics(76); const vy = GetSystemMetrics(77)
  const vw = GetSystemMetrics(78); const vh = GetSystemMetrics(79)
  const mw = GetSystemMetrics(0); const mh = GetSystemMetrics(1)
  return `origin=${vx},${vy} size=${vw}x${vh} primary=${mw}x${mh}`
})
check('光标位置', () => {
  const p = { x: 0, y: 0 }
  const ok = GetCursorPos(p)
  return ok + ' ' + JSON.stringify(p)
})
check('用户空闲毫秒', () => {
  const li = { cbSize: 8, dwTime: 0 }
  const ok = GetLastInputInfo(li)
  return ok + ' idle=' + (GetTickCount64() - Number(li.dwTime)) + 'ms'
})
check('枚举可见顶层窗口', () => {
  const out = []
  const proto = koffi.proto('bool __stdcall ProbeEnumProc(void *hwnd, intptr_t lParam)')
  const cb = koffi.register((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true
    const title = Buffer.alloc(512)
    GetWindowTextW(hwnd, title, 256)
    const t = title.toString('utf16le').replace(/\0.*$/, '')
    if (!t) return true
    const pid = [0]
    GetWindowThreadProcessId(hwnd, pid)
    const r = { left: 0, top: 0, right: 0, bottom: 0 }
    GetWindowRect(hwnd, r)
    out.push({ t, pid: pid[0], r })
    return true
  }, koffi.pointer(proto))
  EnumWindows(cb, 0)
  koffi.unregister(cb)
  if (!out.length) throw new Error('一个窗口都没枚举到')
  const ex = out[0]
  return `${out.length} 个，例如「${ex.t.slice(0, 16)}」pid=${ex.pid} rect=${ex.r.left},${ex.r.top},${ex.r.right},${ex.r.bottom}`
})
check('BitBlt 截图 320x200', () => {
  const w = 320; const h = 200
  const screen = GetDC(null)
  const mem = CreateCompatibleDC(screen)
  const bmp = CreateCompatibleBitmap(screen, w, h)
  SelectObject(mem, bmp)
  const ok = BitBlt(mem, 0, 0, w, h, screen, 0, 0, 0x00CC0020 | 0x40000000)
  const bmi = { bmiHeader: { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 }, bmiColors: [0, 0, 0] }
  const buf = Buffer.alloc(w * h * 4)
  const lines = GetDIBits(mem, bmp, 0, h, buf, bmi, 0)
  SelectObject(mem, null)
  DeleteObject(bmp); DeleteDC(mem); ReleaseDC(null, screen)
  let nonZero = 0
  for (let i = 3; i < buf.length; i += 400) if (buf[i]) nonZero++
  if (!ok) throw new Error('BitBlt 返回 false')
  return `ok=${ok} lines=${lines} 非零像素抽样=${nonZero}`
})

process.exit(failed ? 1 : 0)
