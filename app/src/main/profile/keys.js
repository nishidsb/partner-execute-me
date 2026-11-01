'use strict'
/**
 * 电脑画像 · 键盘与输入内容（0.44.0）
 *
 * 用户 2026-10-29 23:52 的原话：「可以记按键可以记内容，但是必须保存在本地」。
 * 之前我明确拒绝了键盘钩子（见 usage.js 顶部注释），理由是不够准且不该记。现在按他的
 * 要求做，但把「准确」和「不该记」这两件事分别解决：
 *
 *   准确：纯键盘钩子拿不到中文（输入法上屏后只剩拼音键码），所以加了一条 UI Automation
 *         采样——直接读焦点输入框里的**文本值**，做前后差分，得到真正打出来的字。
 *         两条通道互补：钩子给「打了多少、在哪个程序打」，UIA 给「打出了什么」。
 *
 *   不该记：密码框一律不记。三道闸——
 *         ① UIA 读到 IsPasswordProperty 就进入「遮挡期」，期间所有按键和文本直接丢弃；
 *         ② 进程黑名单（密码管理器 / 她自己的窗口）；
 *         ③ 窗口标题带无痕/InPrivate 字样的整窗丢弃。
 *
 * 本地性（用户唯一的硬要求）：
 *   - 只写 <wsDir>/pc/keys/YYYY-MM-DD.jsonl，权限 0600；
 *   - **永远不进 logger**：所有日志只写「条数/字节数/失败原因」，不写内容本身；
 *   - 不联网。唯一会离开这个文件的地方是拼进 prompt（她要「知道」的前提），
 *     那部分在 today.js 里另外做长度与敏感词裁剪。
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const KEEP_DAYS = 21
const FLUSH_MS = 60 * 1000          // 按键计数落盘间隔
const PW_SHIELD_MS = 90 * 1000      // 读不到 UIA 时的保护期（保守）
const TEXT_MIN_GAP_MS = 8 * 1000    // 同一窗口两条文本记录的最小间隔
const TEXT_MAX_ADD = 120            // 单次新增超过这个长度，当「换文档」而不是「打字」

/* 密码管理器 + 她自己：整窗不记 */
const DENY = new Set([
  '1password', 'keepass', 'keepassxc', 'keepass2', 'bitwarden', 'lastpass', 'dashlane',
  'enpass', 'roboform', 'stickypassword', 'nordpass', 'protonpass', 'buttercup',
  'ryza assistant', 'ryza-assistant', 'ryza-assistant-app', 'electron'
])
/* 窗口标题里出现这些就整窗丢弃（浏览器无痕 / 隐私模式） */
const PRIVATE_TITLE = /inprivate|incognito|private browsing|无痕|無痕|隐私浏览|隱私瀏覽/i

let proc = null
let buf = ''
let filePath = ''      // <pcDir>/keys 目录
let logFn = () => {}
let ready = false
let stopping = false
let retryTimer = null
let retryCount = 0
let flushTimer = null

/* ---- 内存态（重启即丢，落盘的是事实） ---- */
const counts = new Map()   // app -> { n, ch, first, last }
const prevText = new Map() // app + '|' + ctrlType -> 上次读到的文本
const lastTextAt = new Map() // app -> 上次写文本记录的时间
let snippets = []          // 最近文本片段（环形，仅内存，给「刚刚在写什么」用）
let pwUntil = 0            // 遮挡期截止时间
let keysTotal = 0          // 本进程内收到的按键总数（含未落盘）
let charsTotal = 0
let lastErr = ''
let startedAt = 0

function dateKey (d = new Date()) {
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function fileFor (day) {
  return path.join(filePath, day + '.jsonl')
}

function append (obj) {
  if (!filePath) return
  try {
    const line = JSON.stringify(obj) + '\n'
    fs.appendFileSync(fileFor(dateKey()), line, { mode: 0o600 })
  } catch (e) {
    // 只记失败原因，绝不带内容
    if (lastErr !== e.code) { lastErr = e.code; logFn('[keys] 写入失败: ' + (e.code || e.message)) }
  }
}

function pruneOld () {
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(filePath)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
      if (!m) continue
      if (now - new Date(m[1] + 'T00:00:00').getTime() > KEEP_DAYS * 86400000) {
        try { fs.unlinkSync(path.join(filePath, f)) } catch { }
      }
    }
  } catch { }
}

/* ------------------------------------------------------------ 敏感判定 */

function denied (exe, title) {
  const e = String(exe || '').toLowerCase().replace(/\.exe$/, '')
  if (!e) return true                       // 拿不到进程名就当敏感，宁可不记
  if (DENY.has(e)) return true
  if (PRIVATE_TITLE.test(String(title || ''))) return true
  return false
}

function shielded () {
  return Date.now() < pwUntil
}

/* ------------------------------------------------------------ 文本差分 */

/**
 * 算出「这次比上次多了什么」。
 * 只看公共前后缀，因为不同控件的文本结构差得远：
 *   记事本/输入框   → 纯追加，公共前缀就是旧文本
 *   VS Code / 终端  → 可见区域，光标不在末尾，插入发生在中间
 * 超过 TEXT_MAX_ADD 的跳变一律当换文档（不记），否则会把整篇代码当「刚打的字」。
 */
function diffText (prev, cur) {
  const p = prev == null ? '' : String(prev)
  const c = cur == null ? '' : String(cur)
  if (c === p) return { add: '', del: 0 }
  if (c.startsWith(p)) return { add: c.slice(p.length), del: 0 }
  if (p.startsWith(c)) return { add: '', del: p.length - c.length }

  let i = 0
  const n = Math.min(p.length, c.length)
  while (i < n && p[i] === c[i]) i++
  let j = 0
  while (j < n - i && p[p.length - 1 - j] === c[c.length - 1 - j]) j++

  const add = c.slice(i, c.length - j)
  const del = p.slice(i, p.length - j).length
  if (add.length > TEXT_MAX_ADD || del > TEXT_MAX_ADD) return { add: '', del: 0, reset: true }
  return { add, del }
}

/** 值得记的新增内容？空白、单个标点不进档案；括号分号这种是代码的高频内容，要留 */
function worthRecording (add) {
  const t = String(add || '')
  if (!t) return false
  const solid = t.replace(/[\s\u3000]/g, '')
  if (!solid) return false
  // 只挡「单个纯标点」：退格连打最容易产出这种，两三个字符的片段可能是 ()、{}、。。，
  // 在代码和聊天里都有语义，丢掉会让「他在写什么」断成一截一截。
  if (/^[^\w\u4e00-\u9fa5]+$/.test(solid) && solid.length < 2) return false
  return true
}

/* ------------------------------------------------------------ 事件处理 */

function onKey (p) {
  // E|<ts>|<vk>|<sc>|<char>|<exe>|<title...>
  const ts = Number(p[1]) || Date.now()
  const vk = Number(p[2]) || 0
  const ch = p[4] || ''
  const exe = String(p[5] || '').toLowerCase().replace(/\.exe$/, '')
  const title = p.slice(6).join('|')

  if (shielded()) return
  if (denied(exe, title)) return

  const app = exe || 'unknown'
  const rec = counts.get(app) || { n: 0, ch: 0, first: ts, last: ts }
  rec.n++
  // 可打印键：字符非空；或者退格/回车/空格这类也算「在打字」
  if (ch || vk === 8 || vk === 13 || vk === 32) rec.ch++
  rec.last = ts
  counts.set(app, rec)
  keysTotal++
  if (ch) charsTotal++
}

function onFocus (json) {
  let o = null
  try { o = JSON.parse(json) } catch { return }
  if (!o) return

  const app = String(o.a || '').toLowerCase().replace(/\.exe$/, '')
  const title = String(o.w || '')

  if (o.pw) {
    /* 密码框：进入遮挡期，并且**清掉这个窗口的文本基线**。
       不清的话，离开密码框后第一次差分会把密码框里的旧值当成「新增内容」，
       这才是真正会泄漏的地方。 */
    pwUntil = Date.now() + PW_SHIELD_MS
    prevText.clear()
    return
  }
  /* UIA 明确说「现在不是密码框」，遮挡立刻解除。
     只在读不到 UIA 时才靠 PW_SHIELD_MS 自然过期——否则离开密码框后 90 秒内的
     正常输入会被白吞，用户会觉得「她有时候记不到」。 */
  pwUntil = 0
  if (denied(app, title)) { prevText.clear(); return }

  const text = o.x == null ? null : String(o.x)
  if (text == null) return

  const key = app + '|' + (o.ct || '')
  const prev = prevText.get(key)
  prevText.set(key, text)
  if (prev == null) return                    // 第一次只建立基线，不产出内容

  const d = diffText(prev, text)
  if (d.reset || !worthRecording(d.add)) return

  const now = Date.now()
  const lastAt = lastTextAt.get(app) || 0
  if (now - lastAt < TEXT_MIN_GAP_MS) {
    // 节流窗口内：并到上一条，而不是丢（否则快速连打会只剩每 8 秒最后一小段）
    const last = snippets[snippets.length - 1]
    if (last && last.a === app && now - last.t < TEXT_MIN_GAP_MS * 3) {
      last.x = (last.x + d.add).slice(-TEXT_MAX_ADD * 2)
      last.t = now
      return
    }
    return
  }
  lastTextAt.set(app, now)

  append({ t: now, a: app, w: title.slice(0, 80), x: d.add.slice(0, 400) })

  snippets.push({ t: now, a: app, w: title.slice(0, 60), x: d.add.slice(0, 200) })
  if (snippets.length > 60) snippets = snippets.slice(-40)
}

function onLine (line) {
  if (line.startsWith('E|')) { onKey(line.split('|')); return }
  if (line.startsWith('X|')) { onFocus(line.slice(2)); return }
  if (line.startsWith('R|')) { ready = true; retryCount = 0; logFn('[keys] 采集已就绪（' + line.slice(2) + '）'); return }
  if (line.startsWith('P|')) return
  if (line.startsWith('Z|')) {
    // worker 自己的报错，只可能是类型名/错误码，不会有输入内容
    const msg = line.slice(2)
    if (msg !== lastErr) { lastErr = msg; logFn('[keys] worker: ' + msg) }
  }
}

/* ------------------------------------------------------------ 落盘 */

function flushCounts () {
  if (!counts.size) return
  const now = Date.now()
  for (const [app, r] of counts) {
    if (!r.n) continue
    append({ t: now, a: app, n: r.n, c: r.ch, f: r.first, l: r.last })
    r.n = 0; r.ch = 0; r.first = now
  }
  // 保留条目（key 数量有限），只清计数
}

/* ------------------------------------------------------------ 生命周期 */

function start ({ pcDir, log } = {}) {
  if (!pcDir) return false
  filePath = path.join(pcDir, 'keys')
  if (typeof log === 'function') logFn = log
  try { fs.mkdirSync(filePath, { recursive: true }) } catch { }
  pruneOld()
  if (proc) return true
  stopping = false
  startedAt = Date.now()
  spawnWorker()
  clearInterval(flushTimer)
  flushTimer = setInterval(flushCounts, FLUSH_MS)
  if (flushTimer.unref) flushTimer.unref()
  return true
}

function spawnWorker () {
  if (proc || stopping) return
  const { unpackedPath } = require('../util')
  const ps = unpackedPath(path.join(__dirname, '..', 'resources', 'keys.ps1'))
  try {
    proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps
    ], { windowsHide: true })
  } catch (e) {
    proc = null
    logFn('[keys] worker 启动失败: ' + (e && e.message))
    scheduleRetry()
    return
  }
  logFn('[keys] worker 已启动 pid=' + proc.pid)

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (line) onLine(line)
    }
    if (buf.length > 64 * 1024) buf = ''   // 防畸形输出把内存撑爆
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (d) => {
    const s = String(d).trim()
    if (s && lastErr !== s) { lastErr = s; logFn('[keys-stderr] ' + s.slice(0, 200)) }
  })
  const restart = (why) => {
    if (!proc) return
    proc = null
    ready = false
    if (stopping) return
    logFn('[keys] worker 退出（' + why + '），稍后重启')
    scheduleRetry()
  }
  proc.on('error', (e) => restart('error ' + (e && e.message)))
  proc.on('exit', (code) => restart('exit ' + code))
}

function scheduleRetry () {
  clearTimeout(retryTimer)
  const wait = Math.min(5000 * (++retryCount), 60000)
  retryTimer = setTimeout(() => { spawnWorker() }, wait)
  if (retryTimer.unref) retryTimer.unref()
}

function stop () {
  stopping = true
  clearTimeout(retryTimer)
  clearInterval(flushTimer)
  flushTimer = null
  flushCounts()
  if (proc) {
    try { proc.stdin.write('quit\n') } catch { }
    try { proc.kill() } catch { }
    proc = null
  }
  ready = false
  counts.clear()
  prevText.clear()
  snippets = []
}

function running () { return !!proc }

/* ------------------------------------------------------------ 对外读取 */

/**
 * 最近 minutes 分钟他在打什么。
 * 读当天的 jsonl（用户可能刚重启，早上的记录只在文件里），再并上内存里的片段。
 *
 * @returns {{ok:boolean, keys:number, chars:number, apps:Array<{app:string,keys:number}>,
 *            snippets:Array<{t:number, app:string, text:string}>, shielded:boolean}}
 */
function recent ({ minutes = 30 } = {}) {
  const now = Date.now()
  const from = now - minutes * 60000
  const byApp = new Map()
  const sn = []
  let keys = 0
  let chars = 0

  if (filePath) {
    let raw = ''
    try { raw = fs.readFileSync(fileFor(dateKey()), 'utf8') } catch { raw = '' }
    for (const line of raw.split('\n')) {
      if (!line) continue
      let o = null
      try { o = JSON.parse(line) } catch { continue }
      const t = Number(o.t) || 0
      if (t < from) continue
      if (o.n) {
        keys += o.n
        chars += Number(o.c) || 0
        byApp.set(o.a, (byApp.get(o.a) || 0) + o.n)
      } else if (o.x) {
        sn.push({ t, app: o.a, text: o.x })
      }
    }
  }

  // 内存里还没落盘的那部分（最近一分钟的按键、最近几秒的文本）
  for (const [app, r] of counts) {
    if (!r.n) continue
    keys += r.n
    chars += r.ch
    byApp.set(app, (byApp.get(app) || 0) + r.n)
  }
  for (const s of snippets) {
    if (s.t >= from) sn.push({ t: s.t, app: s.a, text: s.x })
  }

  sn.sort((a, b) => a.t - b.t)
  const tail = sn.slice(-12)
  const apps = [...byApp.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, 5).map(([app, n]) => ({ app, keys: n }))

  return { ok: keys > 0 || sn.length > 0, keys, chars, apps, snippets: tail, shielded: shielded() }
}

/** 今天一共敲了多少（给 today.js 的「打了多少」那一句） */
function todayTotals () {
  let keys = 0
  let chars = 0
  const byApp = new Map()
  if (!filePath) return { ok: false, keys: 0, chars: 0, apps: [] }
  let raw = ''
  try { raw = fs.readFileSync(fileFor(dateKey()), 'utf8') } catch { }
  // 文件不存在（今天还没 flush 过）也继续：counts 里还有最近一分钟没落盘的
  for (const line of raw.split('\n')) {
    if (!line) continue
    let o = null
    try { o = JSON.parse(line) } catch { continue }
    if (!o.n) continue
    keys += o.n
    chars += Number(o.c) || 0
    byApp.set(o.a, (byApp.get(o.a) || 0) + o.n)
  }
  for (const [app, r] of counts) {
    if (!r.n) continue
    keys += r.n
    chars += r.ch
    byApp.set(app, (byApp.get(app) || 0) + r.n)
  }
  const apps = [...byApp.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, 5).map(([app, n]) => ({ app, keys: n }))
  return { ok: keys > 0, keys, chars, apps }
}

/** 清空全部记录（设置页的「立即清空」） */
function clearAll () {
  const removed = { files: 0, bytes: 0 }
  if (!filePath) return removed
  try {
    for (const f of fs.readdirSync(filePath)) {
      if (!/\.jsonl$/.test(f)) continue
      const p = path.join(filePath, f)
      try {
        removed.bytes += fs.statSync(p).size
        fs.unlinkSync(p)
        removed.files++
      } catch { }
    }
  } catch { }
  snippets = []
  counts.clear()
  prevText.clear()
  return removed
}

module.exports = {
  start, stop, running, recent, todayTotals, clearAll,
  diffText, worthRecording, denied, dateKey,
  /* 测试用：只设置落盘目录，不拉起 PowerShell worker（测试机上不该真装钩子） */
  _init: (dir, log) => { filePath = path.join(dir, 'keys'); if (typeof log === 'function') logFn = log; try { fs.mkdirSync(filePath, { recursive: true }) } catch { } },
  _onKey: onKey,
  _onFocus: onFocus,
  _flush: flushCounts,
  _reset: () => { counts.clear(); prevText.clear(); snippets = []; pwUntil = 0; lastTextAt.clear() },
  _state: () => ({ counts, prevText, snippets, pwUntil, keysTotal, charsTotal, ready, startedAt })
}
