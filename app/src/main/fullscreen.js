'use strict'
/**
 * 全屏让位探测（S2）：前台窗口是否为「无边框全屏」。
 *
 * Electron 没有前台窗口 API，这里用一个常驻 PowerShell 子进程轮询 user32：
 *  - GetForegroundWindow / GetWindowRect / MonitorFromWindow / GetMonitorInfo
 *  - 判据：窗口矩形盖满所在显示器 **且** 没有 WS_CAPTION（标题栏）
 *    只看「盖满屏幕」会把任务栏自动隐藏时的最大化窗口误判成全屏，
 *    加上「无标题栏」后 F11 全屏浏览器、全屏游戏、全屏视频都能命中，
 *    而普通最大化窗口不会。
 *
 * 脚本用 -EncodedCommand（UTF-16LE base64）传入，彻底绕开引号/换行转义；
 * 子进程只在状态变化时输出一行，主进程据此回调。失败（无 PowerShell 等）
 * 一律静默降级为「从不让位」，绝不影响桌宠本身。
 */
const { spawn } = require('node:child_process')
const { log } = require('./logger')

const PS_SCRIPT = `
Add-Type -Namespace Ryza -Name Full -MemberDefinition '
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
'
$last = ''
$lastH = ''
$fgName = ''
$fgTitle = ''
while ($true) {
  $state = 'NORMAL'
  $fgPid = 0
  $mon = ''
  try {
    $h = [Ryza.Full]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      [Ryza.Full]::GetWindowThreadProcessId($h, [ref]$fgPid) | Out-Null
      # 0.37.0：进程名与窗口标题对「NORMAL」也要 —— 她自己待着时要知道主人在用什么
      # （她只有这个和屏幕上的字可以「看」）。句柄没变就不重复查，省得每秒一次 Get-Process。
      # 标题走 MainWindowTitle，不再加 P/Invoke：这段逻辑挂了只该让她「看不见」，
      # 绝不能把整个全屏探测（Add-Type）一起拖下水。
      $hKey = $h.ToString()
      if ($hKey -ne $lastH) {
        $lastH = $hKey
        $fgName = ''
        $fgTitle = ''
        try {
          $p = Get-Process -Id $fgPid -ErrorAction Stop
          $fgName = $p.ProcessName
          $fgTitle = $p.MainWindowTitle
        } catch { }
      }
      $r = New-Object Ryza.Full+RECT
      if ([Ryza.Full]::GetWindowRect($h, [ref]$r)) {
        $mi = New-Object Ryza.Full+MONITORINFO
        $mi.cbSize = 40
        $mon = [Ryza.Full]::MonitorFromWindow($h, 2)
        [Ryza.Full]::GetMonitorInfo($mon, [ref]$mi) | Out-Null
        $style = [Ryza.Full]::GetWindowLong($h, -16)
        $covers = ($r.Left -le $mi.rcMonitor.Left) -and ($r.Top -le $mi.rcMonitor.Top) -and ($r.Right -ge $mi.rcMonitor.Right) -and ($r.Bottom -ge $mi.rcMonitor.Bottom)
        $caption = ($style -band 0x00C00000) -ne 0
        if ($covers -and (-not $caption)) { $state = 'FULL' }
      }
    } else {
      $lastH = ''
      $fgName = ''
      $fgTitle = ''
    }
  } catch { }
  # FULL 时带上显示器原点（rcMonitor 的 Left,Top = 该显示器 bounds 原点），
  # 主进程据此知道「哪块屏在全屏」；NORMAL 不带（没有前台全屏窗口可言）
  if ($state -ne 'FULL') { $mon = '' }
  else { $mon = $mi.rcMonitor.Left + ',' + $mi.rcMonitor.Top }
  # 标题里可能有竖线/换行：抹掉，免得把行协议撑散（不用正则，免得 JS 模板串把 \n 变成真换行）
  $title = $fgTitle.Replace('|', ' ').Replace([char]13, ' ').Replace([char]10, ' ').Replace([char]9, ' ')
  $line = $state + '|' + $fgPid + '|' + $fgName + '|' + $mon + '|' + $title
  if ($line -ne $last) { $last = $line; Write-Output $line }
  Start-Sleep -Milliseconds 1000
}
`

let proc = null
let callback = null
let lastFull = false
let lastInfo = null // { pid, name, monitor:{x,y} }（FULL 时有）
let lastFg = null // 0.37.0：前台窗口（不分全屏与否）{ pid, name, title, at }
let stopped = false
/* 首轮检测结果 Promise：overlay ready-to-show 等它——启动时前台正全屏的话，
 * 窗口直接进让位集合不上屏，避免「开机即全屏透明层踢 MPO → 视频黑一下」 */
let firstResolve = null
const firstChecked = new Promise((ok) => { firstResolve = ok })

/** 这些进程的窗口即使铺满屏幕也不算「全屏应用」：
 *  - Ryza Assistant：自家桌面层 overlay 本来就是铺满屏幕的无边框透明窗口
 *  - explorer：点桌面时前台是 Progman/WorkerW（桌面），它天然铺满且无标题栏
 *  - 开始菜单/搜索/输入法候选等系统外壳：Win11 上同样是全屏无边框浮层
 */
const IGNORED = /^(ryza|world\.execute|partner\.execute|startmenuexperiencehost|shellexperiencehost|searchhost|searchapp|textinputhost|applicationframehost)$/i

function isOwnProcess (pid, name) {
  try {
    if (name && IGNORED.test(String(name).trim())) return true
    if (pid) {
      const { app } = require('electron')
      const metrics = app.getAppMetrics() || []
      if (metrics.some((m) => m.pid === pid)) return true
    }
  } catch {}
  return false
}

function handleLine (line) {
  const s = String(line || '').trim()
  if (!s) return
  const parts = s.split('|')
  const raw = parts[0]
  if (raw !== 'FULL' && raw !== 'NORMAL') return
  const pid = Number(parts[1]) || 0
  const pname = parts[2] || ''
  // FULL 行第 4 段是显示器原点「x,y」（老脚本没有这段，容错为 null）
  let monitor = null
  if (parts[3] && /^\-?\d+,\-?\d+$/.test(parts[3])) {
    const [mx, my] = parts[3].split(',').map(Number)
    monitor = { x: mx, y: my }
  }
  lastInfo = raw === 'FULL' ? { pid, name: pname, monitor } : null
  // 0.37.0：标题在第 5 段（老脚本没有，容错为空）；标题里就算有竖线也被 PS 抹过了
  const title = String(parts.length > 4 ? parts.slice(4).join('|') : '').trim()
  if (pid || title) lastFg = { pid, name: String(pname || '').trim(), title, at: Date.now() }
  else lastFg = null
  // 首轮结果必须先兑现（去重早退在后面，别让它把启动闸卡死）
  if (firstResolve) { try { firstResolve() } catch { } firstResolve = null }
  const own = raw === 'FULL' && isOwnProcess(pid, pname)
  const full = raw === 'FULL' && !own
  if (own) log('[fullscreen] 前台是系统外壳/自家窗口(' + (pname || pid) + ')，不计入全屏')
  if (full === lastFull) return
  lastFull = full
  log('[fullscreen] 前台全屏状态 →', full ? ('FULL(' + (pname || pid) + (monitor ? ' @' + monitor.x + ',' + monitor.y : '') + ')（角色让位）') : 'NORMAL（角色回来）')
  try { if (callback) callback(full, lastInfo) } catch (e) { log('[fullscreen] 回调失败:', e && e.message) }
}

/** 启动探测；cb(isFullscreen)。重复调用无副作用。 */
function start (cb) {
  if (cb) callback = cb
  if (proc || stopped) return
  try {
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let buf = ''
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      for (const l of lines) handleLine(l)
    })
    proc.on('error', (e) => { log('[fullscreen] 探测进程启动失败（降级为不让位）:', e && e.message); proc = null })
    proc.on('exit', () => { proc = null })
    log('[fullscreen] 全屏探测已启动')
  } catch (e) {
    log('[fullscreen] 启动异常（降级为不让位）:', e && e.message)
    proc = null
  }
}

function stop () {
  stopped = true
  if (proc) { try { proc.kill() } catch {} proc = null }
}

/**
 * 0.37.0：此刻前台在跑什么（不限全屏）。
 * 「她自己待着」要知道主人在用什么程序——她只有这个和屏幕上的字可以「看」。
 * 超过 30 秒没更新（探测进程死了 / 刚启动）就当没有，返回 null。
 */
function foreground () {
  if (!lastFg) return null
  if (Date.now() - (Number(lastFg.at) || 0) > 30000) return null
  return { pid: lastFg.pid, name: lastFg.name, title: lastFg.title }
}

module.exports = { start, stop, isFull: () => lastFull, info: () => lastInfo, foreground, whenChecked: () => firstChecked }
