'use strict'
/**
 * 0.18.0 M10 · IM 主人专属电脑工具（在 QQ/微信里遥控这台电脑）
 *
 * 用户目的：让角色像人一样活动、能真正帮上手 —— 主人发消息说「看看电脑在干嘛」「帮我关机」，
 * 她能直接查、直接做。**只有主人名单里的人**才有这组工具（brain.js 按 perm.isOwner 挂载，
 * 名单为空 = 谁都没有，默认全关）。
 *
 * 工具一览：
 *   pc_status     整体状况（CPU/内存/开机时长/电量/进程数）
 *   pc_processes  在跑什么进程（可带窗口标题 = 在做什么）
 *   pc_screenshot 截屏发回给主人（仅 QQ 端，微信 UI 自动化发不了图片段）
 *   pc_run        执行命令（Git Bash 优先、UTF-8，同 assistant core shell 组思路）
 *   pc_power      关机/重启/睡眠/锁定（shutdown 带 30 秒缓冲，cancel 可撤销）
 *   pc_kill       结束进程（按 PID 或映像名）
 *
 * 纯逻辑与 IO 分离：parseTasklist / parseCsvLine / pickShell 可直接 node:test。
 * 铁律：工具参数一律 string（部分端点不收 type 数组/anyOf，会 400）。
 */

const { execFile, spawn } = require('node:child_process')
const os = require('node:os')

const MAX_OUT = 8000

/* ---------------- bash 探测（同 assistant core shell 组的发现链，简化版） ---------------- */

let bashCache
const BASH_HINTS = [
  () => process.env.RYZA_BASH_PATH || null,
  () => 'C:\\Program Files\\Git\\bin\\bash.exe',
  () => 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  () => process.env.LOCALAPPDATA ? require('node:path').join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : null
]

function findBash () {
  if (bashCache !== undefined) return bashCache
  bashCache = null
  for (const hint of BASH_HINTS) {
    try {
      const p = hint()
      if (p && require('node:fs').existsSync(p)) { bashCache = p; break }
    } catch { }
  }
  return bashCache
}

/** shell 选择：Git Bash 优先（UTF-8 少转义），没有回退 cmd */
function pickShell () {
  const bash = findBash()
  return bash
    ? { file: bash, args: ['--noprofile', '--norc', '-c'], kind: 'bash' }
    : { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], kind: 'cmd' }
}

/* ---------------- 解析（纯函数，可测） ---------------- */

/** 一行 CSV → 字段数组（处理引号内逗号/双引号转义） */
function parseCsvLine (line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out
}

/** tasklist /fo csv 输出 → 进程列表（无 /v：5 列；带 /v：9 列，含窗口标题）。纯函数。 */
function parseTasklist (csv, withTitles) {
  const out = []
  for (const line of String(csv || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || !t.startsWith('"')) continue
    const f = parseCsvLine(t)
    if (f.length < 5) continue
    const item = {
      name: f[0] || '',
      pid: Number(f[1]) || 0,
      memMB: Math.round((Number(String(f[4]).replace(/[^\d]/g, '')) || 0) / 1024)
    }
    if (withTitles && f.length >= 9) {
      item.status = f[5] || ''
      item.user = f[6] || ''
      item.title = (f[8] || '').replace(/^(N\/A|无|n\/a)\s*$/, '')
    }
    out.push(item)
  }
  return out
}

/** 秒 → 「x 天 y 小时 z 分」 */
function fmtUptime (sec) {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return (d ? d + ' 天 ' : '') + (h ? h + ' 小时 ' : '') + m + ' 分钟'
}

/** 输出封顶 */
const cap = (s, max = MAX_OUT) => {
  const t = String(s || '')
  return t.length > max ? t.slice(0, max) + `\n…[截断，共 ${t.length} 字符]` : t
}

/* ---------------- 角色设定保护闸（0.18.0 M10 补丁，用户铁律） ----------------
 * 「角色设定是最基本的根基，无论如何都不可以通过 QQ/微信聊天去修改。」
 * pc_run 是任意命令口子，必须在工具层硬拦「写 Ryza 自身设定文件」的命令。
 * 只拦**写**：纯读（cat/ls 查看设定）放行。纯函数，node:test 可测。 */

/** 受保护目标：命中任意一个 + 带写操作词 → 拒绝 */
const PROTECTED_MARKERS = [
  'ryza-assistant-app',   // userData 数据目录（companion/characters.json 都在里面）
  'characters.json',      // 角色卡本体（persona/世界书/音色/自设）
  'roles/',               // assistant 人设角色目录（正反斜杠都算）
  'roles\\',
  'persona',              // 人设文件
  'partner.md'            // 用户画像文档（设定侧，不是普通记忆）
]

/** 常见写操作词（小写匹配） */
const WRITE_TOKENS = [
  '>', '>>', 'tee ', 'sed -i', 'rm ', 'del ', 'erase ', 'rd ', 'rmdir ',
  'move ', 'ren ', 'rename ', 'copy ', 'cp ', 'mv ', 'touch ', 'truncate ',
  'set-content', 'out-file', 'add-content', 'remove-item', 'new-item', 'clear-content',
  'writealltext', 'writeallbytes', 'reg add', 'reg delete', 'reg import',
  'echo ', 'printf ', 'dd ', 'format '
]

/**
 * pc_run 守卫：命令涉及受保护的设定文件且带写操作词 → 拒绝。
 * @returns {{ok: boolean, reason?: string}}
 */
function guardRun (cmd) {
  const t = String(cmd || '').toLowerCase()
  const hit = PROTECTED_MARKERS.find((m) => t.includes(m))
  if (!hit) return { ok: true }
  const w = WRITE_TOKENS.find((m) => t.includes(m))
  if (w) {
    return {
      ok: false,
      reason: `这条命令要修改 Ryza 自己的设定/数据（命中「${hit}」）。角色设定是根基，聊天里改不了——请主人在 Ryza 设置界面手动修改。`
    }
  }
  return { ok: true }
}

/**
 * 0.18.0 第二批 · 终端单独询问：判断一条命令是否「破坏性强」。
 * 这类命令即使主人关掉了「终端命令都先问一句」，也仍然要二次确认。
 * 宁可多问一句，也不要替主人把桌面清了。
 * @param {string} cmd
 * @returns {boolean}
 */
const DANGER_PATTERNS = [
  /\brm\s+-[a-z]*[rf]/i, // rm -rf / -fr
  /\b(rd|rmdir)\s+\/s/i, // rd /s 递归删目录
  /\bdel\s+\/[a-z]/i, // del /f /s /q
  /\b(erase|format|diskpart|bcdedit|takeown|icacls|cipher)\b/i,
  /\bshutdown\b|\breboot\b/i,
  /\breg\s+(add|delete|import)\b/i,
  /\b(net\s+user|netsh|sc\s+(create|delete|config|stop))\b/i,
  /\b(certutil|bitsadmin|wmic)\b/i,
  /\b(taskkill|stop-process|killall)\b/i,
  /\b(remove-item|set-content|out-file|add-content|new-item)\b/i,
  /\b(curl|wget|invoke-webrequest|invoke-restmethod)\b[^\n]*\s(-o|--output|-outfile)\b/i,
  /\bchmod\s+[0-7]*7[0-7]*\b/i,
  /(^|[^>|])>{1,2}\s*[^\s>]/, // 重定向覆盖/追加（> file / >> file）
  /\|\s*(sh|bash|cmd|powershell|pwsh)\b/i, // 管道进解释器
  /\b(eval|exec)\s+\(/i
]

function isDangerousCmd (cmd) {
  const t = String(cmd || '')
  if (!t.trim()) return false
  return DANGER_PATTERNS.some((re) => re.test(t))
}

/** GBK 解码（中文系统的 tasklist 输出）；无 full-icu 就退 utf8 */function decodeOem (buf) {
  try { return new TextDecoder('gbk').decode(buf) } catch { return buf.toString('utf8') }
}

const pexec = (file, args, timeout = 15000) => new Promise((resolve) => {
  execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
    resolve({ err, text: stdout ? decodeOem(stdout) : '' })
  })
})

/* ---------------- 工具定义（OpenAI function 格式；参数一律 string） ---------------- */

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'pc_status',
      description: '看一眼这台电脑的整体状况：内存占用、开机时长、CPU 核数、进程数、电量（如果有）。主人问「电脑什么情况」先用它。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pc_processes',
      description: '看这台电脑正在跑什么进程。with_titles 填 true 会带每个进程的窗口标题（=主人正在做什么）。主人问「我在电脑前干嘛呢/在运行什么」就用它，挑重点说人话。',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: '只看名字/标题含这个关键词的进程（可选）' },
          with_titles: { type: 'string', description: '是否带窗口标题（true/false，默认 false）' },
          limit: { type: 'string', description: '最多返回几个（默认 15）' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pc_run',
      description: '【主人专属·高风险·必须确认】在这台电脑上执行一条命令（如开软件、查文件、改设置）。注意：第一次调用不会执行，只会返回 needConfirm —— 你必须把命令原文告诉主人，等主人亲口回复「确认」，再用同一条命令调用一次才会真的跑。执行完把结果用人话汇报。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeout: { type: 'string', description: '超时毫秒数（默认 60000）' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pc_power',
      description: '电源操作：shutdown=30 秒后关机（cancel 可撤销）、reboot=重启、sleep=睡眠、lock=锁屏、cancel=撤销已定的关机/重启。主人说关电脑就直接关，做完告知。',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', description: 'shutdown / reboot / sleep / lock / cancel 之一' } },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pc_kill',
      description: '【高风险】结束一个进程（按 PID 或映像名，如 chrome.exe）。整棵进程树一起结束。',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'string', description: '进程 PID' },
          name: { type: 'string', description: '映像名（如 notepad.exe），与 pid 二选一' }
        },
        required: []
      }
    }
  }
]

const SCREENSHOT_DEF = {
  type: 'function',
  function: {
    name: 'pc_screenshot',
    description: '截一张主屏幕的画面发到这个聊天里（这是你真正的眼睛）。主人问「看得到吗/看不到吗/屏幕上是什么/帮我看」或任何需要确认画面的时候，必须先调用本工具、看了再回答，禁止凭印象说看不到。发完简单说一句画面里有什么。',
    parameters: { type: 'object', properties: {} }
  }
}

/* ---------------- 执行 ---------------- */

async function exec (name, args = {}) {
  const s = args && typeof args === 'object' ? args : {}
  if (name === 'pc_status') {
    const task = await pexec('tasklist', ['/fo', 'csv', '/nh'])
    const procs = parseTasklist(task.text, false)
    const totalMemMB = Math.round(os.totalmem() / 1048576)
    const freeMemMB = Math.round(os.freemem() / 1048576)
    const out = {
      host: os.hostname(),
      cpu: (os.cpus()[0] && os.cpus()[0].model.trim()) || '',
      cores: os.cpus().length,
      memUsed: `${totalMemMB - freeMemMB}/${totalMemMB} MB（${Math.round((totalMemMB - freeMemMB) / totalMemMB * 100)}%）`,
      uptime: fmtUptime(os.uptime()),
      processCount: procs.length,
      processMemTotalMB: procs.reduce((a, p) => a + p.memMB, 0)
    }
    // 电量（可选，笔记本才有）
    try {
      const { err, text } = await pexec('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery).EstimatedChargeRemaining'], 10000)
      const pct = Number(String(text).trim())
      if (!err && Number.isFinite(pct) && pct > 0) out.battery = pct + '%'
    } catch { }
    return out
  }
  if (name === 'pc_processes') {
    const withTitles = String(s.with_titles || '').toLowerCase() === 'true'
    const limit = Math.min(Math.max(Number(s.limit) || 15, 1), 60)
    const task = await pexec('tasklist', withTitles ? ['/fo', 'csv', '/nh', '/v'] : ['/fo', 'csv', '/nh'], withTitles ? 30000 : 15000)
    let list = parseTasklist(task.text, withTitles)
    const kw = String(s.filter || '').trim().toLowerCase()
    if (kw) list = list.filter((p) => p.name.toLowerCase().includes(kw) || (p.title || '').toLowerCase().includes(kw))
    list.sort((a, b) => b.memMB - a.memMB)
    return { count: list.length, processes: list.slice(0, limit) }
  }
  if (name === 'pc_run') {
    const cmd = String(s.command || '').trim()
    if (!cmd) return { ok: false, error: 'command 是空的' }
    // 角色设定保护闸：聊天（包括主人）不许写设定文件（用户 2026-10-26 铁律）
    const g = guardRun(cmd)
    if (!g.ok) return { ok: false, error: g.reason }
    const timeout = Math.min(Math.max(Number(s.timeout) || 60000, 1000), 300000)
    const sh = pickShell()
    return await new Promise((resolve) => {
      const child = spawn(sh.file, [...sh.args, cmd], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks = []
      let settled = false
      const finish = (payload) => { if (!settled) { settled = true; resolve(payload) } }
      const timer = setTimeout(() => {
        try { child.kill() } catch { }
        finish({ ok: false, error: `命令超过 ${timeout}ms 被终止` })
      }, timeout)
      timer.unref && timer.unref()
      child.stdout.on('data', (d) => { if (chunks.length < 64) chunks.push(d) })
      child.stderr.on('data', (d) => { if (chunks.length < 64) chunks.push(d) })
      child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: String(e && e.message ? e.message : e) }) })
      child.on('close', (code) => {
        clearTimeout(timer)
        const text = sh.kind === 'bash' ? Buffer.concat(chunks).toString('utf8') : decodeOem(Buffer.concat(chunks))
        resolve({ ok: true, exitCode: code ?? 0, output: cap(text.trim() || '（无输出）') })
      })
    })
  }
  if (name === 'pc_power') {
    const action = String(s.action || '').trim().toLowerCase()
    const run = (file, argv) => pexec(file, argv, 15000)
    if (action === 'shutdown') {
      await run('shutdown', ['/s', '/t', '30'])
      return { ok: true, note: '30 秒后关机（期间 pc_power cancel 可撤销）' }
    }
    if (action === 'reboot') {
      await run('shutdown', ['/r', '/t', '30'])
      return { ok: true, note: '30 秒后重启（期间 pc_power cancel 可撤销）' }
    }
    if (action === 'cancel') {
      const r = await run('shutdown', ['/a'])
      return r.err ? { ok: false, error: '没有待撤销的关机/重启' } : { ok: true, note: '已撤销关机/重启' }
    }
    if (action === 'lock') {
      await run('rundll32.exe', ['user32.dll,LockWorkStation'])
      return { ok: true, note: '已锁屏' }
    }
    if (action === 'sleep') {
      await run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'])
      return { ok: true, note: '已进入睡眠' }
    }
    return { ok: false, error: 'action 只能是 shutdown/reboot/sleep/lock/cancel' }
  }
  if (name === 'pc_kill') {
    const pid = Number(s.pid)
    const nm = String(s.name || '').trim()
    if (!pid && !nm) return { ok: false, error: 'pid 和 name 至少给一个' }
    const r = pid
      ? await pexec('taskkill', ['/pid', String(pid), '/T', '/F'])
      : await pexec('taskkill', ['/im', nm, '/T', '/F'])
    return r.err ? { ok: false, error: '结束失败（进程可能不存在）' } : { ok: true, note: pid ? `已结束 PID ${pid}` : `已结束 ${nm}` }
  }
  return { ok: false, error: '未知工具 ' + name }
}

module.exports = { TOOL_DEFS, SCREENSHOT_DEF, exec, parseCsvLine, parseTasklist, pickShell, fmtUptime, cap, guardRun, isDangerousCmd, PROTECTED_MARKERS, WRITE_TOKENS }
