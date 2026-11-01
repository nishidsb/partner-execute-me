'use strict'
/**
 * 桌面状态与系统动作（launcher）—— AuraDesk 迁移到 Ryza 时丢掉的模块，0.24.0 补回。
 *
 * 为什么需要它：companion/tools.js 的 4 个工具（list_running / launch_program /
 * set_volume / show_desktop）都靠这里，而旧代码把 launcher 传成了 null：
 *   - set_volume / show_desktop 直接回「助手未就绪」
 *   - list_running 永远说「没有检测到运行中的窗口」
 *   - launch_program 最糟：什么也不做，却回答「正在启动「X」」（假装成功）
 *
 * 实现方式：常驻 PowerShell worker（resources/launcher.ps1，纯 ASCII，理由见该文件
 * 头部注释：PS 5.1 无 BOM 的 .ps1 按 ANSI 解析，一格非 ASCII 就会乱码/语法错）。
 * 主进程按需发一行命令，worker 回一行 JSON：
 *   scan           -> {type:'windows', list:[{h,t,pn,pp,min,fg,r}], procs:[...]}
 *   toggle <hwnd>  -> {ok, act}      激活（已在前台则最小化，任务栏习惯）
 *   vol <0-100>    -> {type:'vol', v, m}
 *   mute           -> {type:'vol', v, m}
 *   desk           -> {ok:true}      显示/还原桌面（Win+D 等价）
 *
 * 扫描是**按需**的（不挂 1.5s 常驻定时器）：模型问「开了什么」才扫，1.2 秒内复用上次
 * 结果。桌面工具没人用时零 CPU，powershell 进程只在第一次需要时才拉起。
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const { log } = require('./logger')
const { unpackedPath } = require('./util')
const store = require('./store')
const match = require('./match')

const PS = unpackedPath(path.join(__dirname, 'resources', 'launcher.ps1'))

let helper = null
let buf = ''
let retryTimer = null
let retryCount = 0
let readyPromise = null
let readyResolve = null
let readyTimer = null

let latestWindows = []
let latestProcs = []
let latestApps = {}
let latestVol = { v: null, m: false }
let lastScanAt = 0
let scanning = null
const scanWaiters = []
const volWaiters = []

/* ------------------------------------------------------------- worker 进程 */

function helperCmd (line, tag) {
  if (!helper || !helper.stdin.writable) {
    if (tag) log('[launcher] 写入失败（worker 不在）: ' + String(line).slice(0, 120))
    return false
  }
  try {
    helper.stdin.write(line + '\n')
    return true
  } catch (err) {
    log('[launcher] 写入异常: ' + (err && err.message))
    return false
  }
}

/** 启动 worker（幂等）。resolve(true) 表示脚本已编译完并出了第一行输出 */
function start () {
  if (helper) return Promise.resolve(true)
  if (readyPromise) return readyPromise
  readyPromise = new Promise((resolve) => { readyResolve = resolve })
  const done = (ok) => {
    clearTimeout(readyTimer)
    if (readyResolve) { readyResolve(ok); readyResolve = null }
  }
  // Add-Type 现场编译 C# 要 1~3 秒；超过 8 秒还没吐第一行就当它废了
  readyTimer = setTimeout(() => { done(false) }, 8000)

  try {
    helper = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS
    ], { windowsHide: true, env: { ...process.env, AURA_PID: String(process.pid) } })
  } catch (err) {
    helper = null
    log('[launcher] worker 启动失败: ' + (err && err.message))
    readyPromise = null
    done(false)
    scheduleRetry()
    return Promise.resolve(false)
  }
  log('[launcher] worker 已启动 pid=' + helper.pid)

  helper.stdout.setEncoding('utf8')
  helper.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      if (line.startsWith('{')) { done(true); onLine(line) } else log('[launcher-out] ' + line.slice(0, 200))
    }
  })
  helper.stderr.setEncoding('utf8')
  helper.stderr.on('data', (d) => {
    const s = String(d).trim()
    if (s) log('[launcher-stderr] ' + s.slice(0, 400))
  })
  const restart = (why) => {
    if (!helper) return
    log('[launcher] worker 退出（' + why + '），稍后重启')
    helper = null
    readyPromise = null
    done(false)
    scheduleRetry()
  }
  helper.on('error', (err) => restart('error ' + (err && err.message)))
  helper.on('exit', (code) => restart('exit ' + code))
  return readyPromise
}

function scheduleRetry () {
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => { start() }, Math.min(3000 * (++retryCount), 30000))
  if (retryTimer.unref) retryTimer.unref()
}

function stop () {
  clearTimeout(retryTimer)
  clearTimeout(readyTimer)
  if (helper) {
    try { helper.stdin.write('quit\n') } catch { /* 已断开就无所谓 */ }
    try { helper.kill() } catch { /* 同上 */ }
    helper = null
  }
  readyPromise = null
  readyResolve = null
}

/* ------------------------------------------------------------- 输出解析 */

function onLine (line) {
  let msg
  try { msg = JSON.parse(line) } catch { log('[launcher] 非 JSON 输出: ' + line.slice(0, 200)); return }
  if (msg.type === 'windows' && Array.isArray(msg.list)) {
    latestWindows = msg.list
    latestProcs = Array.isArray(msg.procs) ? msg.procs : []
    lastScanAt = Date.now()
    rebuildApps()
    flush(scanWaiters)
    return
  }
  if (msg.type === 'vol') {
    latestVol = { v: Number.isFinite(Number(msg.v)) ? Number(msg.v) : null, m: !!msg.m }
    flush(volWaiters, latestVol)
    return
  }
  // toggle / desk 的回包没有 type（{ok, act}），只在需要时打日志
  if (msg.ok === false && msg.err) log('[launcher] worker 报错: ' + String(msg.err).slice(0, 200))
}

function flush (list, arg) {
  while (list.length) {
    const fn = list.shift()
    try { fn(arg) } catch { /* 单个等待者出错不影响其他人 */ }
  }
}

/* ------------------------------------------------------------- 卡片运行状态 */

function cards () {
  try {
    const lib = store.get().global.library
    return Array.isArray(lib) ? lib : []
  } catch { return [] }
}

function entryCands (g) {
  const out = []
  if (g.exe) out.push(String(g.exe).toLowerCase())
  if (g.target && /\.exe$/i.test(String(g.target))) out.push(String(g.target).toLowerCase())
  return out
}

let lastAppsSig = ''
function rebuildApps () {
  const entries = []
  for (const g of cards()) {
    if (!g || !g.id) continue
    // 协议类（ms-settings:）和文件夹没有可执行文件，也没有窗口可认，不参与匹配
    if (g.kind === 'url' || g.kind === 'folder') continue
    entries.push({ id: g.id, name: String(g.name || ''), cands: entryCands(g) })
  }
  const { map } = match.matchApps(entries, latestWindows, latestProcs)
  latestApps = map
  const sig = JSON.stringify(map)
  if (sig !== lastAppsSig) {
    lastAppsSig = sig
    log('[launcher] 卡片运行状态: ' + (sig === '{}' ? '（没有卡片匹配到运行中的程序）' : sig))
  }
}

/* ------------------------------------------------------------- 对外接口 */

function snapshot () {
  return { windows: latestWindows, procs: latestProcs, apps: latestApps, vol: latestVol, at: lastScanAt }
}

/**
 * 拿一份窗口表。maxAge 内扫过就直接复用（模型连续问两次不用扫两遍）。
 * worker 起不来时返回缓存（可能是空的），调用方据此降级说话，不要卡死。
 */
function scan ({ maxAge = 1200 } = {}) {
  if (lastScanAt && Date.now() - lastScanAt < maxAge) return Promise.resolve(snapshot())
  if (scanning) return scanning
  scanning = (async () => {
    const ok = await start()
    if (!ok) { scanning = null; return snapshot() }
    const r = await new Promise((resolve) => {
      let settled = false
      const finish = () => { if (settled) return; settled = true; clearTimeout(to); resolve(snapshot()) }
      const to = setTimeout(() => {
        log('[launcher] scan 超时（worker 没回包）')
        const i = scanWaiters.indexOf(finish)
        if (i >= 0) scanWaiters.splice(i, 1)
        finish()
      }, 3000)
      scanWaiters.push(finish)
      if (!helperCmd('scan', 'scan')) finish()
    })
    scanning = null
    return r
  })()
  return scanning
}

/** 按句柄激活窗口；句柄必须出现在最近一次扫描里（防 HWND 复用误激活别的窗口） */
function toggleByHandle (h) {
  const n = Math.trunc(Number(h))
  if (!Number.isFinite(n) || n <= 0 || n > 0x7fffffff) return false
  if (!latestWindows.some((w) => Math.trunc(Number(w.h)) === n)) {
    log('[launcher] toggle 拒绝：句柄 ' + n + ' 不在最近扫描的窗口列表里')
    return false
  }
  return helperCmd('toggle ' + n, 'toggle')
}

/** 白名单式的助手指令（vol / mute / desk）。模型拿不到这条路，只给宿主内部用 */
function helperCmdPublic (line) {
  const s = String(line || '').trim()
  if (/^vol\s+\d{1,3}$/i.test(s)) {
    const n = Number(s.split(/\s+/)[1])
    if (!(n >= 0 && n <= 100)) {
      log('[launcher] 拒绝越界音量: ' + s)
      return false
    }
    return helperCmd(s, 'cmd')
  }
  if (/^(mute|desk)$/i.test(s)) return helperCmd(s, 'cmd')
  log('[launcher] 拒绝未知指令: ' + s.slice(0, 80))
  return false
}

/** 等一次音量回包（worker 会回实际值与静音态），超时给缓存值 */
function waitVol (ms = 900) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      clearTimeout(to)
      const i = volWaiters.indexOf(finish)
      if (i >= 0) volWaiters.splice(i, 1)
      resolve(v || latestVol)
    }
    const to = setTimeout(() => finish(latestVol), ms)
    volWaiters.push(finish)
  })
}

/** 启动一张卡片（走 gameLib.launchEntry：exe 走 ShellExecute，协议走 openExternal） */
function launchCard (id) {
  const g = cards().find((x) => x && x.id === id)
  if (!g) return { ok: false, msg: '卡片不存在' }
  try {
    const r = require('./gameLib').launchEntry(g)
    log('[launcher] 启动卡片「' + g.name + '」→ ' + JSON.stringify(r))
    return { ok: true, card: g, result: r }
  } catch (err) {
    const msg = (err && err.message) || String(err)
    log('[launcher] 启动卡片「' + g.name + '」失败: ' + msg)
    return { ok: false, msg, card: g }
  }
}

/** 按名字找卡片（精确 → 包含名字 → 包含路径），给「帮我开 QQ」用 */
function findCard (q) {
  const s = String(q || '').trim().toLowerCase()
  if (!s) return null
  const lib = cards()
  return lib.find((x) => String(x.name || '').toLowerCase() === s) ||
    lib.find((x) => String(x.name || '').toLowerCase().includes(s)) ||
    lib.find((x) => String(x.target || '').toLowerCase().includes(s)) ||
    null
}

/**
 * 某个 exe 是否已经有窗口在跑（「打开QQ」在它已经开着时应该切前台，而不是再拉一个实例，
 * QQ/微信这类第二实例只会弹一句「已经在运行」）。
 * 只认 exe 全路径/同目录同名（matchScore ≥ 2），且通用名（launcher.exe 之类）一律不认。
 */
function findWindowForExe (exePath) {
  const c = String(exePath || '').toLowerCase()
  if (!c || !/\.exe$/i.test(c)) return null
  const base = c.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
  if (match.GENERIC_EXE.test(base)) return null
  let best = null
  let bs = 0
  for (const w of latestWindows) {
    const s = match.matchScore(w, [c])
    if (s > bs) { bs = s; best = w }
  }
  return bs >= 2 ? best : null
}

module.exports = {
  start,
  stop,
  scan,
  get latestWindows () { return latestWindows },
  get latestApps () { return latestApps },
  get latestVol () { return latestVol },
  get isAlive () { return !!(helper && helper.stdin.writable) },
  toggleByHandle,
  helperCmdPublic,
  waitVol,
  launchCard,
  findCard,
  findWindowForExe,
  cards,
  // 单测注入：直接喂窗口表，跳过真跑 powershell
  _setWindows (list, procs) {
    latestWindows = Array.isArray(list) ? list : []
    latestProcs = Array.isArray(procs) ? procs : []
    lastScanAt = Date.now()
    rebuildApps()
    return snapshot()
  }
}
