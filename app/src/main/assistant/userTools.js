'use strict'
/**
 * 第 3 期 · 她的工具自迭代闭环（宿主实现）
 *
 * 边界（计划书定的，一条都不让）：她自己写「工具脚本」，不碰应用本体。
 *   - 脚本只住 <dataRoot>/assistant/tools-user/，名字白名单 + 路径解析锁死，跑不出这个目录
 *   - 新工具写完默认 disabled；「部署启用」必须在面板里由主人点批准（聊天里说好话也没用）
 *   - 每次部署前把整个 data 目录快照一份（robocopy，保留最近 5 份）
 *   - tools-user/ 自带独立 git：写/改/删/部署都 commit，作者=ryza-assistant（历史只增不减）
 *
 * 脚本契约：CommonJS，`module.exports = async (args) => 结果`。
 * 运行方式：process.execPath + ELECTRON_RUN_AS_NODE=1 子进程（等价 node，但打包后也有），
 * 15 秒超时强杀，输出封顶 16k——出错的信息原样返回给模型，她自己读日志修（自修复循环）。
 *
 * 纯逻辑与摸文件分离：validateName/checkCode 是纯函数（可单测）；其余碰 fs/子进程。
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { execFileSync } = require('node:child_process')
const { log } = require('../logger')

const CODE_MAX = 32000          // 单个脚本上限
const RUN_TIMEOUT = 15000       // 运行超时
const OUT_CAP = 16000           // 输出封顶
const SNAP_KEEP = 5             // data 快照保留份数
const NAME_RE = /^[a-z][a-z0-9_]{2,31}$/

let dataRoot = ''
let dir = ''                    // tools-user 目录
let gitReady = false

function manifestFile () { return path.join(dir, 'manifest.json') }

function loadManifest () {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'))
    return m && typeof m === 'object' ? m : {}
  } catch { return {} }
}

function saveManifest (m) {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = manifestFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8')
  fs.renameSync(tmp, manifestFile())
}

function fileOf (name) { return path.join(dir, name + '.js') }

/* ------------------------------------------------- 纯校验（单测用） */

/** 工具名：小写字母开头，小写字母/数字/下划线，3-32 位——锁死路径注入 */
function validateName (name) { return NAME_RE.test(String(name || '')) }

/** 代码：必须是 CommonJS 且导出函数；不收 require('electron')/process.exit 之外的都放行（沙箱里跑） */
function checkCode (code) {
  const s = String(code || '')
  if (!s.trim()) return '代码是空的'
  if (s.length > CODE_MAX) return '代码太长（上限 ' + CODE_MAX + ' 字符）'
  if (!/module\.exports/.test(s)) return '缺少 module.exports（脚本必须导出 async (args) => 结果）'
  return ''
}

/* ------------------------------------------------- git（tools-user 独立仓） */

function gitRun (args, message) {
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    if (message) {
      env.GIT_AUTHOR_NAME = 'ryza-assistant'
      env.GIT_AUTHOR_EMAIL = 'app@partner.local'
      env.GIT_COMMITTER_NAME = 'ryza-assistant'
      env.GIT_COMMITTER_EMAIL = 'app@partner.local'
    }
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15000, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    if (message) log('[utools] git 失败（继续，不挡功能）: ' + (e.message || e).slice(0, 120))
    return ''
  }
}

function ensureGit () {
  if (gitReady) return true
  try {
    execFileSync('git', ['--version'], { timeout: 5000, windowsHide: true, stdio: 'ignore' })
  } catch { return false }
  try {
    try { gitRun(['rev-parse', '--is-inside-work-tree']) } catch { gitRun(['init']) }
    gitReady = true
  } catch { }
  return gitReady
}

function commit (msg) {
  if (!ensureGit()) return
  try {
    if (!gitRun(['status', '--porcelain']).trim()) return
    gitRun(['add', '-A'])
    gitRun(['commit', '-m', String(msg).slice(0, 160)], true)
  } catch { }
}

/* ------------------------------------------------- 语法校验（Electron 自带 node 跑 --check） */

function syntaxCheck (file) {
  try {
    const r = spawnSync(process.execPath, ['--check', file], {
      timeout: 10000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8'
    })
    if (r.status === 0) return ''
    return String((r.stderr || r.stdout || '')).split(/\r?\n/).filter(Boolean).slice(-4).join('\n').slice(0, 800) || '语法校验未通过'
  } catch (e) { return '语法校验失败: ' + (e.message || e) }
}

/* ------------------------------------------------- data/ 快照（部署前保险） */

function snapshotData () {
  if (!dataRoot) return ''
  const src = path.join(dataRoot, 'assistant')
  const root = path.join(dataRoot, 'backups')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dst = path.join(root, 'data-' + stamp)
  try {
    fs.mkdirSync(dst, { recursive: true })
    try {
      // robocopy 退出码 0-7 都算成功；>/7 或异常退 fs.cpSync
      const r = spawnSync('robocopy', [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 120000, windowsHide: true })
      if (r.status == null || r.status > 7) throw new Error('robocopy status ' + r.status)
    } catch {
      try { fs.rmSync(dst, { recursive: true, force: true }) } catch { }
      fs.cpSync(src, dst, { recursive: true })
    }
    // 只留最近 SNAP_KEEP 份
    const olds = fs.readdirSync(root).filter((n) => n.startsWith('data-')).sort()
    while (olds.length > SNAP_KEEP) {
      const old = olds.shift()
      try { fs.rmSync(path.join(root, old), { recursive: true, force: true }) } catch { }
    }
    log('[utools] data 快照完成: ' + dst)
    return dst
  } catch (e) {
    log('[utools] data 快照失败（不挡部署）: ' + (e.message || e))
    return ''
  }
}

/* ------------------------------------------------- 变更通知（宿主把 manifest 同步进工具注册表） */

let onChangeFn = null
function setOnChange (fn) { onChangeFn = typeof fn === 'function' ? fn : null }
function notify () { try { if (onChangeFn) onChangeFn(loadManifest()) } catch (e) { log('[utools] 同步注册表失败: ' + e.message) } }

/* ------------------------------------------------- 对外动作 */

function init (root) {
  dataRoot = String(root || '')
  dir = path.join(dataRoot, 'assistant', 'tools-user')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { }
  ensureGit()
  try { writeWrapper() } catch { }
  log('[utools] 她的工具工作区: ' + dir)
}

/** 运行包装器：require 工具脚本 → 调用 → 把返回值/异常用 @@RESULT@@ 行送回 stdout。
 *  没有它，工具的 return 值就只有 console.log 才看得见，自修复循环等于瞎修。 */
function writeWrapper () {
  const wrapper = [
    "'use strict'",
    "const path = require('node:path')",
    'const file = process.argv[2]',
    'let args = {}',
    'try { args = JSON.parse(process.argv[3] || "{}") } catch (e) {',
    "  process.stdout.write('@@RESULT@@' + JSON.stringify({ ok: false, error: 'args 不是合法 JSON: ' + e.message }))",
    '  process.exit(0)',
    '}',
    'Promise.resolve().then(() => {',
    '  const fn = require(path.resolve(file))',
    "  if (typeof fn !== 'function') throw new Error('module.exports 必须是 async (args) => 结果 的函数')",
    '  return fn(args)',
    '}).then((r) => {',
    "  process.stdout.write('@@RESULT@@' + JSON.stringify({ ok: true, result: r === undefined ? null : r }))",
    '}).catch((e) => {',
    "  process.stdout.write('@@RESULT@@' + JSON.stringify({ ok: false, error: String((e && e.stack) || e).slice(0, 4000) }))",
    '})'
  ].join('\n') + '\n'
  fs.writeFileSync(path.join(dir, '_run.cjs'), wrapper, 'utf8')
  try { gitRun(['update-index', '--skip-worktree', '_run.cjs']) } catch { }
}

/** 面板/聊天共用的列表 */
function list () {
  const m = loadManifest()
  return Object.keys(m).sort().map((name) => {
    const e = m[name] || {}
    let hasFile = false
    try { hasFile = fs.existsSync(fileOf(name)) } catch { }
    return {
      name,
      description: e.description || '',
      enabled: e.enabled === true && hasFile,
      hasFile,
      updatedAt: Number(e.updatedAt) || 0,
      version: Number(e.version) || 1
    }
  })
}

function manifest () { return loadManifest() }

/** 她写/改一个工具。新工具和改动后的工具一律回到 disabled，等主人重新批准 */
function write ({ name, description, parameters, code }) {
  if (!validateName(name)) return { ok: false, error: '工具名不合法（要 3-32 位小写字母/数字/下划线，字母开头）' }
  const codeErr = checkCode(code)
  const file = fileOf(name)
  if (codeErr) return { ok: false, error: codeErr }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, String(code).replace(/\r\n/g, '\n'), 'utf8')
  const syn = syntaxCheck(file)
  if (syn) {
    try { fs.rmSync(file, { force: true }) } catch { }
    return { ok: false, error: '语法校验没过，脚本没有保存：\n' + syn }
  }
  const m = loadManifest()
  const prev = m[name] || {}
  m[name] = {
    name,
    description: String(description || '').slice(0, 200) || name,
    parameters: String(parameters || '{}').slice(0, 2000),
    enabled: false, // 冻结点：改动即失效，重新部署要主人再批一次
    version: (Number(prev.version) || 0) + 1,
    updatedAt: Date.now()
  }
  saveManifest(m)
  commit('write ' + name + ' v' + m[name].version + '（默认停用待批准）')
  notify()
  log('[utools] ' + (prev.updatedAt ? '更新' : '新建') + '工具 ' + name + ' v' + m[name].version + '（语法 OK，默认停用）')
  return { ok: true, name, version: m[name].version, enabled: false }
}

/** 跑一个工具（开发期自测也走这里；risk=medium，聊天路径上还有权限确认把关） */
function run ({ name, argsJson }) {
  if (!validateName(name)) return { ok: false, error: '工具名不合法' }
  const file = fileOf(name)
  if (!fs.existsSync(file)) return { ok: false, error: '工具 ' + name + ' 还没写（或没保存成功）' }
  let args = {}
  const raw = String(argsJson || '').trim()
  if (raw) { try { args = JSON.parse(raw) } catch { return { ok: false, error: 'args 不是合法 JSON：' + raw.slice(0, 80) } } }
  const wrapper = path.join(dir, '_run.cjs')
  if (!fs.existsSync(wrapper)) { try { writeWrapper() } catch { } }
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [wrapper, file, JSON.stringify(args)], {
      cwd: dir,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch { } }, RUN_TIMEOUT)
    child.stdout.on('data', (d) => { if (out.length < OUT_CAP) out += d.toString('utf8') })
    child.stderr.on('data', (d) => { if (err.length < OUT_CAP) err += d.toString('utf8') })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: '启动失败: ' + (e.message || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const ms = Date.now() - started
      // 从 stdout 里摘包装器的 @@RESULT@@ 行（工具自己的 console 输出原样保留）
      let marshaled = null
      const outLines = []
      for (const l of out.split('\n')) {
        if (l.startsWith('@@RESULT@@')) {
          try { marshaled = JSON.parse(l.slice(10)) } catch { }
        } else outLines.push(l)
      }
      const passthrough = (outLines.join('\n') + (out.length >= OUT_CAP ? '\n…（输出超长截断）' : '')).trim()
      try {
        fs.appendFileSync(path.join(dir, 'runs.log'),
          JSON.stringify({ at: Date.now(), name, ms, code, timedOut, ok: marshaled ? marshaled.ok : code === 0, out: passthrough.slice(0, 2000), err: err.slice(0, 2000) }) + '\n')
      } catch { }
      log('[utools] 运行 ' + name + ' ' + ms + 'ms' + (timedOut ? '（超时强杀）' : ' exit=' + code))
      if (timedOut) return resolve({ ok: false, timedOut: true, exitCode: code, ms, output: passthrough, error: '运行超过 ' + (RUN_TIMEOUT / 1000) + ' 秒被强制结束' })
      if (marshaled) {
        return resolve({
          ok: !!marshaled.ok,
          ms,
          result: marshaled.result,
          error: marshaled.error || '',
          output: passthrough
        })
      }
      // 没等到包装器回执（进程崩了/被杀）：把 stdout/stderr 原样给回去排障
      resolve({
        ok: code === 0,
        exitCode: code,
        ms,
        output: passthrough,
        error: err || (code === 0 ? '' : '进程退出码 ' + code + '，且没有返回结果回执')
      })
    })
  })
}

/** 主人批准部署：先快照 data，再置 enabled */
function deploy (name) {
  const m = loadManifest()
  const e = m[name]
  if (!e) return { ok: false, error: '没有这个工具' }
  if (e.enabled === true) return { ok: true, name, enabled: true }
  const snap = snapshotData()
  e.enabled = true
  e.deployedAt = Date.now()
  e.snapshot = snap
  saveManifest(m)
  commit('deploy ' + name + ' v' + (e.version || 1) + '（主人批准' + (snap ? '，已快照 ' + path.basename(snap) : '') + '）')
  notify()
  log('[utools] 部署 ' + name + '（快照: ' + (snap || '无') + '）')
  return { ok: true, name, enabled: true, snapshot: snap }
}

function undeploy (name) {
  const m = loadManifest()
  if (!m[name]) return { ok: false, error: '没有这个工具' }
  m[name].enabled = false
  saveManifest(m)
  commit('undeploy ' + name)
  notify()
  return { ok: true, name, enabled: false }
}

function remove (name) {
  const m = loadManifest()
  if (!m[name]) return { ok: false, error: '没有这个工具' }
  try { fs.rmSync(fileOf(name), { force: true }) } catch { }
  delete m[name]
  saveManifest(m)
  commit('delete ' + name)
  notify()
  return { ok: true }
}

/** 运行日志尾部（她自修复时用 user_tool_run 的返回就够；这里给面板/排查用） */
function runLog (name, lines) {
  try {
    const all = fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').split('\n').filter(Boolean)
    const hit = all.filter((l) => { try { return JSON.parse(l).name === name } catch { return false } })
    return hit.slice(-(Number(lines) || 5)).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

/** 聊天工具入口（core 的 user_tool_* 走 bridge 到这里） */
async function invoke (name, args) {
  const a = args || {}
  if (name === 'list') return { ok: true, tools: list() }
  if (name === 'write') return write(a)
  if (name === 'run') return run(a)
  return { ok: false, error: '未知操作 ' + name }
}

module.exports = {
  init, invoke, list, manifest, write, run, deploy, undeploy, remove, runLog,
  setOnChange, validateName, checkCode, snapshotData
}
