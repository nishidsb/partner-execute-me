/**
 * S10.5 Shell 工具组（移植 dsh-ops + windows-bash 的核心思路到 Ryza）：
 *  - bash 优先路由：Windows 上不再用 cmd/PowerShell 当默认 shell（GBK 乱码 / 转义地狱 = token 黑洞），
 *    Git Bash 探测链（env → where 过滤 WSL 假 bash → 常见安装位）失败才回退 ComSpec；
 *  - exec_command v2：长脚本走 script_path（免 heredoc 塞 JSON）、超时不杀而晋升后台作业（promoteOnTimeout）；
 *  - 后台作业三件套：job_output / job_list / job_kill（对应 dsh-ops-background）；
 *  - 文件四件套：file_read / file_grep / file_glob / file_replace（对应 dsh-ops-file，纯 Node 实现）。
 * 输出一律截断封顶 —— 省 token 是这组工具的第一设计目标。
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { register } from './registry.js'

const pexec = promisify(execFile)

/* ---------------- bash 探测（windows-bash 的发现链） ---------------- */

let bashCache = undefined // undefined=没查过，null=查过没有，字符串=路径

const BASH_HINTS = [
  () => process.env.RYZA_BASH_PATH || null,
  () => 'C:\\Program Files\\Git\\bin\\bash.exe',
  () => 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  () => process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : null,
  () => 'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  () => 'C:\\Git\\bin\\bash.exe'
]

function existsFile (p) {
  try { return !!p && fs.statSync(p).isFile() } catch { return false }
}

/** where bash 的结果要过滤：WindowsApps 里的 bash.exe 是 WSL/商店占位符，跑了会弹商店 */
function pickFromWhere (lines) {
  for (const line of String(lines || '').split(/\r?\n/)) {
    const p = line.trim()
    if (!p || /WindowsApps/i.test(p)) continue
    if (existsFile(p)) return p
  }
  return null
}

async function probeBash () {
  if (bashCache !== undefined) return bashCache
  for (const hint of BASH_HINTS) {
    const p = hint()
    if (existsFile(p)) { bashCache = p; return p }
  }
  try {
    const r = await pexec('where', ['bash'], { timeout: 5000, windowsHide: true })
    bashCache = pickFromWhere(r.stdout)
  } catch { bashCache = null }
  return bashCache
}

/** 当前生效的 shell 信息（诊断用） */
export async function shellInfo () {
  const bash = await probeBash()
  return { bash: bash || null, kind: bash ? 'bash' : 'cmd' }
}

/* ---------------- 输出解码与封顶 ---------------- */

const MAX_OUT_CHARS = 16000

function decode (buf, kind) {
  try {
    if (kind === 'bash') return buf.toString('utf8')
    // cmd 回退：中文 Windows 默认 GBK 输出
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return buf.toString('utf8')
  }
}

function cap (s, max = MAX_OUT_CHARS) {
  const t = String(s || '')
  if (t.length <= max) return t
  return t.slice(0, max) + `\n…[截断，共 ${t.length} 字符]`
}

/* ---------------- 后台作业注册表（dsh-ops-background） ---------------- */

const JOBS = new Map() // id -> { id, cmd, kind, pid, file, startedAt, done, exitCode }
const JOBS_DIR = path.join(os.tmpdir(), 'ryza-jobs')
let jobSeq = 0

function newJob (cmd, kind) {
  fs.mkdirSync(JOBS_DIR, { recursive: true })
  const id = 'j' + Date.now().toString(36) + (++jobSeq)
  const file = path.join(JOBS_DIR, id + '.log')
  fs.writeFileSync(file, '')
  const job = { id, cmd: String(cmd).slice(0, 200), kind, pid: 0, file, startedAt: Date.now(), done: false, exitCode: null }
  JOBS.set(id, job)
  return job
}


async function killJob (job, exitCode = 1) {
  if (job.done || !job.pid) { job.done = true; return true }
  try {
    if (process.platform === 'win32') {
      await pexec('taskkill', ['/pid', String(job.pid), '/T', '/F'], { timeout: 8000, windowsHide: true })
    } else {
      try { process.kill(-job.pid, 'SIGKILL') } catch { try { process.kill(job.pid, 'SIGKILL') } catch { } }
    }
  } catch { /* 已退出就算了 */ }
  job.done = true
  if (job.exitCode === null) job.exitCode = exitCode
  return true
}

/** 读作业输出尾部 */
function jobTail (job, maxBytes = 12000) {
  let text = ''
  let size = 0
  try {
    const st = fs.statSync(job.file)
    size = st.size
    const want = Math.min(size, maxBytes * 4) // utf8/gbk 都按 4 字节上限留余量
    const fh = fs.openSync(job.file, 'r')
    const buf = Buffer.alloc(want)
    fs.readSync(fh, buf, 0, want, size - want)
    fs.closeSync(fh)
    text = decode(buf, job.kind)
  } catch { text = '(输出读不到)' }
  if (size > maxBytes * 4) text = '…[前段截断]\n' + text
  return cap(text, maxBytes)
}

/* ---------------- 前台执行（bash 优先 + 超时晋升） ---------------- */

/**
 * 跑一条命令：bash 优先、UTF-8、封顶截断。
 * 超时不杀进程而是晋升为后台作业（winbash promoteOnTimeout），返回 { promoted, jobId }。
 */
function runForeground (cmd, kind, { timeoutMs = 60000, promoteOnTimeout = true } = {}) {
  return new Promise((resolve) => {
    const bash = kind === 'bash' ? bashCache : null
    const argv = bash ? [bash, '--noprofile', '--norc', '-c', cmd] : [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', cmd]
    const job = promoteOnTimeout ? newJob(cmd, kind) : null
    if (job) job._pending = true
    const chunks = []
    const child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false
    let timer = null
    const finish = (payload) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(payload) } }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        if (promoteOnTimeout && job && child.pid) {
          // 晋升：进程留着继续跑，输出从这刻起转投作业文件
          job.pid = child.pid
          job._pending = false
          const tail = Buffer.concat(chunks)
          try { fs.appendFileSync(job.file, decode(tail, kind)) } catch { }
          child.stdout.removeAllListeners(); child.stderr.removeAllListeners()
          child.stdout.on('data', (d) => { try { fs.appendFileSync(job.file, d) } catch { } })
          child.stderr.on('data', (d) => { try { fs.appendFileSync(job.file, d) } catch { } })
          child.on('close', (code) => {
            job.done = true; job.exitCode = code
            try { fs.appendFileSync(job.file, `\n[exit code: ${code}]\n`) } catch { }
          })
          finish({ promoted: true, jobId: job.id, pid: child.pid, note: `超时未结束：已转入后台作业 ${job.id}（继续跑，用 job_output 收结果）` })
          return
        }
        try { child.kill() } catch { }
        finish({ promoted: false, timedOut: true, error: `命令超过 ${timeoutMs}ms 被终止（要长跑用后台作业）` })
      }, timeoutMs)
    }
    child.stdout.on('data', (d) => { if (chunks.length < 64) chunks.push(Buffer.from(d)) })
    child.stderr.on('data', (d) => { if (chunks.length < 64) chunks.push(Buffer.from(d)) })
    child.on('error', (e) => finish({ promoted: false, error: String(e && e.message ? e.message : e) }))
    child.on('close', (code) => {
      if (job) { job.done = true; job.exitCode = code; job._pending = false }
      finish({
        promoted: false,
        exitCode: code,
        stdout: cap(decode(Buffer.concat(chunks), kind))
      })
    })
  })
}

/* ---------------- 工具注册 ---------------- */

register({
  name: 'exec_command',
  description: '【高风险】在本机执行命令。Windows 上默认走随应用找到的 Git Bash（UTF-8、少转义），没装才回退 cmd。' +
    '短命令用 command；长脚本建议先用 file_replace/其它方式落盘再用 script_path 指脚本文件，避免转义地狱。' +
    '命令超过时限不会白跑：自动转入后台作业并返回 jobId，用 job_output 收结果。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令（与 script_path 二选一，优先 command）' },
      script_path: { type: 'string', description: '脚本文件路径：内容整体交给 bash 执行（长脚本用这个）' },
      timeout: { type: 'string', description: '前台超时毫秒数（默认 60000，填数字）' }
    },
    required: []
  },
  risk: 'high',
  // 终端类：权限档位管不到它，永远单独问一次（0.18.0 第二批）
  terminal: true,
  exec: async (args) => {
    const scriptPath = String(args.script_path || '').trim()
    let cmd = String(args.command || '').trim()
    if (scriptPath) {
      if (!existsFile(scriptPath)) throw new Error('script_path 文件不存在：' + scriptPath)
      cmd = fs.readFileSync(scriptPath, 'utf8')
    }
    if (!cmd) throw new Error('command 和 script_path 至少给一个')
    const info = await shellInfo()
    const timeout = Math.min(Math.max(Number(args.timeout) || 60000, 1000), 600000)
    const r = await runForeground(cmd, info.kind, { timeoutMs: timeout })
    if (r.promoted) return { stdout: '', ...r }
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout || '', ...(r.error ? { error: r.error } : {}) }
  }
})

register({
  name: 'job_output',
  description: '读取后台作业的输出（尾部）。超时晋升 / job_run_background 启动的作业都用它收结果。',
  parameters: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: '作业 id（如 jxyz123）' },
      max_chars: { type: 'string', description: '最多返回多少字符（默认 12000，填数字）' }
    },
    required: ['job_id']
  },
  risk: 'low',
  exec: async ({ job_id, max_chars }) => {
    const job = JOBS.get(String(job_id || ''))
    if (!job) throw new Error('没有这个作业：' + job_id)
    return {
      jobId: job.id, running: !job.done, exitCode: job.exitCode,
      startedAt: new Date(job.startedAt).toLocaleString('zh-CN', { hour12: false }),
      cmd: job.cmd,
      output: jobTail(job, Math.min(Math.max(Number(max_chars) || 12000, 200), 60000))
    }
  }
})

register({
  name: 'job_list',
  description: '列出本会话所有后台作业（含已完成）。',
  parameters: { type: 'object', properties: {}, required: [] },
  risk: 'low',
  exec: async () => {
    const list = []
    for (const job of JOBS.values()) {
      list.push({ jobId: job.id, running: !job.done, exitCode: job.exitCode, pid: job.pid, cmd: job.cmd, startedAt: new Date(job.startedAt).toLocaleString('zh-CN', { hour12: false }) })
    }
    return { count: list.length, jobs: list.reverse() }
  }
})

register({
  name: 'job_kill',
  description: '【高风险】终止一个还在跑的后台作业（整棵进程树）。',
  parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
  risk: 'high',
  terminal: true,
  exec: async ({ job_id }) => {
    const job = JOBS.get(String(job_id || ''))
    if (!job) throw new Error('没有这个作业：' + job_id)
    if (job.done) return { ok: true, note: '作业已结束' }
    await killJob(job)
    return { ok: true, jobId: job.id }
  }
})

/* ---------------- 文件四件套（dsh-ops-file 的纯 Node 版） ---------------- */

function normAbs (p) {
  const s = String(p || '').trim()
  if (!s) throw new Error('路径为空')
  if (/[<>|?*\u0000]/.test(s) || /^\/(dev|proc|sys)\//i.test(s)) throw new Error('路径含不允许的字符')
  return path.resolve(s)
}

register({
  name: 'file_read',
  description: '读文本文件的一段（带行号，可指定起始行/行数）。比 exec cat 省得多——默认只回 200 行、16000 字符封顶。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      offset: { type: 'string', description: '起始行号（1 起，默认 1，填数字）' },
      limit: { type: 'string', description: '读几行（默认 200，最大 1000，填数字）' }
    },
    required: ['path']
  },
  risk: 'low',
  exec: async ({ path: p, offset, limit }) => {
    const abs = normAbs(p)
    const raw = fs.readFileSync(abs, 'utf8')
    const lines = raw.split(/\r?\n/)
    const off = Math.max(1, Math.floor(Number(offset) || 1))
    const lim = Math.min(Math.max(1, Math.floor(Number(limit) || 200)), 1000)
    const slice = lines.slice(off - 1, off - 1 + lim)
    const body = slice.map((l, i) => `${off + i}: ${l}`).join('\n')
    return {
      file: abs, totalLines: lines.length, offset: off, returned: slice.length,
      truncatedHint: off - 1 + lim < lines.length ? `还有后续行（下次用 offset=${off + lim}）` : null,
      content: cap(body)
    }
  }
})

register({
  name: 'file_grep',
  description: '在文件或目录里按正则搜文本（含中文）。返回 file:line: 内容，最多 80 条。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件或目录绝对路径' },
      pattern: { type: 'string', description: '正则表达式' },
      recursive: { type: 'string', description: '目录时是否递归子目录（true/false，默认 false）' },
      glob: { type: 'string', description: '只搜匹配该通配符的文件名，如 *.js' }
    },
    required: ['path', 'pattern']
  },
  risk: 'low',
  exec: async ({ path: p, pattern, recursive, glob }) => {
    const abs = normAbs(p)
    let re
    try { re = new RegExp(String(pattern), 'i') } catch (e) { throw new Error('正则不合法：' + e.message) }
    const rec = String(recursive) === 'true'
    const globRe = glob ? new RegExp('^' + String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$', 'i') : null
    const SKIP = new Set(['node_modules', '.git', 'dist', 'out'])
    const hits = []
    const st = fs.statSync(abs)
    const textLike = (p2) => /\.(txt|md|json|js|cjs|mjs|ts|tsx|jsx|css|html|xml|yml|yaml|ini|cfg|conf|py|ps1|bat|sh|log|csv)$/i.test(p2) || !path.extname(p2)
    const walk = (dir, depth) => {
      if (hits.length >= 80 || depth > 6) return
      let ents = []
      try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (hits.length >= 80) return
        const fp = path.join(dir, e.name)
        if (e.isDirectory()) { if (rec && !SKIP.has(e.name)) walk(fp, depth + 1); continue }
        if (!e.isFile() || !textLike(e.name)) continue
        if (globRe && !globRe.test(e.name)) continue
        try {
          if (fs.statSync(fp).size > 2 * 1024 * 1024) continue
          const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/)
          for (let i = 0; i < lines.length && hits.length < 80; i++) {
            if (re.test(lines[i])) hits.push({ file: fp, line: i + 1, text: lines[i].slice(0, 300) })
          }
        } catch { /* 跳过读不了的 */ }
      }
    }
    if (st.isDirectory()) walk(abs, 0)
    else {
      if (st.size > 2 * 1024 * 1024) throw new Error('文件超过 2MB，先分段 file_read')
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length && hits.length < 80; i++) {
        if (re.test(lines[i])) hits.push({ file: abs, line: i + 1, text: lines[i].slice(0, 300) })
      }
    }
    return { pattern: String(pattern), count: hits.length, hits }
  }
})

register({
  name: 'file_glob',
  description: '按通配符找文件（** 可跨目录）。最多回 100 条，按修改时间新→旧。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '从哪个目录开始（绝对路径）' },
      pattern: { type: 'string', description: '通配符，如 **/*.exe、logs/*.log' }
    },
    required: ['dir', 'pattern']
  },
  risk: 'low',
  exec: async ({ dir, pattern }) => {
    const root = normAbs(dir)
    const pat = String(pattern || '*').replace(/\\/g, '/')
    const re = new RegExp('^' + pat.split('/').map((seg) => seg === '**' ? '.*' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.')).join('/') + '$', 'i')
    const out = []
    const SKIP = new Set(['node_modules', '.git'])
    const walk = (dir2, depth) => {
      if (out.length >= 100 || depth > 8) return
      let ents = []
      try { ents = fs.readdirSync(dir2, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        if (out.length >= 100) return
        const fp = path.join(dir2, e.name)
        const rel = path.relative(root, fp).replace(/\\/g, '/')
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(fp, depth + 1); continue }
        if (e.isFile() && re.test(rel)) {
          let m = 0
          try { m = fs.statSync(fp).mtimeMs } catch { }
          out.push({ file: fp, rel, mtimeMs: m })
        }
      }
    }
    walk(root, 0)
    out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return { dir: root, pattern: pat, count: out.length, files: out.slice(0, 100).map((x) => ({ file: x.file, rel: x.rel })) }
  }
})

register({
  name: 'file_replace',
  description: '【高风险】在文本文件里做查找替换（可正则）。返回替换次数；不落临时文件，直接改原文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      find: { type: 'string', description: '要找的内容（regex=true 时是正则）' },
      replace: { type: 'string', description: '替换成什么（可用 $1 引用捕获组）' },
      regex: { type: 'string', description: 'find 是不是正则（true/false，默认 false）' },
      max_edits: { type: 'string', description: '最多替换几处（默认全部，填数字）' }
    },
    required: ['path', 'find', 'replace']
  },
  risk: 'high',
  exec: async ({ path: p, find, replace, regex, max_edits }) => {
    const abs = normAbs(p)
    if (!find) throw new Error('find 为空')
    const raw = fs.readFileSync(abs, 'utf8')
    const useRe = String(regex) === 'true'
    const capN = Math.max(1, Math.floor(Number(max_edits) || Infinity))
    let count = 0
    let out
    if (useRe) {
      const re = new RegExp(String(find), 'g')
      out = raw.replace(re, (...as) => {
        count++
        if (count > capN) return as[0]
        const rep = String(replace)
        return rep.replace(/\$(\d)/g, (_, d) => as[Number(d)] ?? '')
      })
      if (count > capN) count = capN
    } else {
      let idx = raw.indexOf(String(find))
      out = raw
      while (idx !== -1 && count < capN) {
        out = out.slice(0, idx) + String(replace) + out.slice(idx + String(find).length)
        count++
        idx = out.indexOf(String(find), idx + String(replace).length)
      }
    }
    if (count > 0) fs.writeFileSync(abs, out, 'utf8')
    return { file: abs, replaced: count, note: count === 0 ? '没找到要替换的内容' : null }
  }
})
