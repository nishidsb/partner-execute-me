'use strict'
/**
 * NapCat 自动守护（0.45.21）——「她自己连 QQ，不用主人伺候」的最后一块
 *
 * ── 背景 ────────────────────────────────────────────────────────
 * reach.js 让她能主动在 QQ 上找主人，im.js 是 OneBot 客户端，连本机
 * ws://127.0.0.1:3001。但 OneBot 只是个协议，中间需要一个「协议端」
 * （NapCat）真正挂着 QQ 号收发消息。之前协议端要主人手动开——断了就断
 * 了，她永远够不着 QQ。本模块让她自己把桥拉起来。
 *
 * ── 行为 ────────────────────────────────────────────────────────
 * im 连接失败时调 ensureSpawned()：
 *   1. 3001 端口已通 → 有人挂着（可能是主人手动开的），不碰
 *   2. 配置了 napcatCmd 且 napcatAutoStart → 以 detached 方式拉起
 *      NapCatWinBootMain.exe（带 quick 登录号参数，登录过一次就免扫码）
 *   3. 自己记录 pid，进程还活着就不重复拉；应用退出不杀它（detached），
 *      下次开机她照常自己拉（若已死）
 *
 * 一次性准备（主人的部分，只做一次）：
 *   ① 跑一次 napcat.bat 扫码登录 ② NapCat WebUI 里开正向 WS 端口 3001
 *   ③ 之后 quick 登录参数 = QQ 号，全部交给守护
 */

const net = require('node:net')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const STATE_FILE = () => {
  try { return path.join(require('electron').app.getPath('userData'), 'napcat-guard.json') } catch { return '' }
}

/** pid 活着但端口不通超过这么久 → 认为是僵尸（QQ 重登换了进程），允许重拉 */
const STALE_MS = 10 * 60 * 1000

function portOpen (host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (ok) => { try { s.destroy() } catch { } resolve(!!ok) }
    s.setTimeout(Number(timeoutMs) || 1500)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

/** 从 ws://127.0.0.1:3001/x 解析 host/port（非本机地址不守护——remote 的桥不该由我们拉） */
function parseLocalWs (wsUrl) {
  try {
    const u = new URL(String(wsUrl || ''))
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    const host = u.hostname
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return null
    const port = Number(u.port) || (u.protocol === 'wss:' ? 443 : 80)
    return { host, port }
  } catch { return null }
}

function readState () {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) } catch { return { pid: 0 } }
}
function writeState (st) {
  try { const f = STATE_FILE(); if (f) fs.writeFileSync(f, JSON.stringify(st), 'utf8') } catch { }
}
function pidAlive (pid) {
  const p = Number(pid) || 0
  if (!p) return false
  try { process.kill(p, 0); return true } catch { return false }
}

/**
 * 单步判定（纯逻辑，供测试）：该不该拉起
 * @returns {'skip-port-open'|'skip-no-cmd'|'skip-autostart-off'|'skip-alive'|'skip-not-local'|'spawn'|'spawn-stale'}
 *
 * 0.45.72 `spawn-stale`：进程活着 ≠ 服务活着。
 * 11-01 实测：NapCat 引导器 pid 一直活着，但它注入的 QQ 在凌晨 4:55 重登换了进程，
 * 3001 端口直接 ECONNREFUSED；而状态文件里 pid 还在 → 以前永远 skip-alive，
 * 于是「她说了要去 QQ 找他」这件事物理上根本发不出去。现在按上次拉起时间兜底：
 * 活着但超过 10 分钟还端口不通，就再拉一次。
 */
function decide ({ wsUrl, napcatCmd, napcatAutoStart, portReachable, state, now }) {
  const local = parseLocalWs(wsUrl)
  if (!local) return 'skip-not-local'
  if (portReachable) return 'skip-port-open'
  if (!napcatCmd) return 'skip-no-cmd'
  if (napcatAutoStart === false) return 'skip-autostart-off'
  const st = state || {}
  const at = Number(st.at) || 0
  const alive = pidAlive(st.pid)
  const stale = at > 0 && (Number(now) || Date.now()) - at > STALE_MS
  if (alive && !stale) return 'skip-alive'
  if (alive && stale) return 'spawn-stale'
  return 'spawn'
}

function create ({ getCfg, log = () => { } }) {
  let spawning = false
  return {
    /** im 连接失败时调用：需要就拉起 NapCat（幂等，不会重复 spawn） */
    async ensureSpawned () {
      const c = getCfg() || {}
      const local = parseLocalWs(c.wsUrl)
      const portReachable = local ? await portOpen(local.host, local.port, 1200) : false
      const state = readState()
      const verdict = decide({
        wsUrl: c.wsUrl, napcatCmd: c.napcatCmd, napcatAutoStart: c.napcatAutoStart,
        portReachable, state
      })
      if (verdict !== 'spawn' && verdict !== 'spawn-stale') return { ok: false, why: verdict }
      if (verdict === 'spawn-stale') {
        log('[napcat] 进程活着但 3001 不通超过 10 分钟（QQ 大概重登过），重新拉起协议端')
      }
      if (spawning) return { ok: false, why: 'skip-spawning' }
      spawning = true
      try {
        const args = String(c.napcatArgs || '').split(' ').filter(Boolean)
        const child = spawn(c.napcatCmd, args, {
          cwd: path.dirname(c.napcatCmd),
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
        child.unref()
        writeState({ pid: child.pid, at: Date.now() })
        log('[napcat] 已拉起协议端 pid=' + child.pid + '（首次需在 NapCat 里扫码登录并开 3001 正向 WS）')
        return { ok: true, pid: child.pid }
      } catch (err) {
        log('[napcat] 拉起失败: ' + (err && err.message))
        return { ok: false, why: 'spawn-error', err: err && err.message }
      } finally {
        spawning = false
      }
    },
    status () {
      const c = getCfg() || {}
      const st = readState()
      return { cmd: c.napcatCmd || '', autoStart: c.napcatAutoStart !== false, pidAlive: pidAlive(st.pid), pid: st.pid || 0 }
    }
  }
}

module.exports = { decide, parseLocalWs, portOpen, pidAlive, create, readState, writeState }
