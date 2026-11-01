'use strict'
/**
 * 数据目录：便携隔离 + 继承询问（0.19.0）
 *
 * 以前 portable 构建仍然写 %APPDATA% —— 「复制文件夹 = 另一只桌宠」做不到。
 * 现在的解析优先级（从高到低）：
 *   1. 便携版：electron-builder 的 portable target 会注入 PORTABLE_EXECUTABLE_DIR，
 *      数据落在 <程序所在目录>/data（连同程序一起拷走就是另一只，互不影响）
 *   2. 指针文件里记录的目录（用户上次「更换数据目录」的选择，跨启动有效）
 *   3. 默认 %APPDATA%/ryza-assistant-app
 *
 * 指针文件固定放在 %APPDATA%/ryza-assistant-app/data-root.json —— 这个位置**不随数据目录变化**，
 * 否则换完目录就再也找不到「旧数据在哪」，继承询问无从谈起。
 *
 * 顺序很重要：`applyRoot()` 必须在 app ready 之前调用（Electron 的单实例锁、session 缓存、
 * 日志目录都以 userData 为基准，ready 之后再改会出现「一半新一半旧」）。
 * 需要弹窗的继承询问只能在 ready 之后，所以它走「处理完 → app.relaunch()」的路子：
 * 用户选完重启一次，下次启动就在正确的目录里，不存在半途切换的残留。
 */
const fs = require('node:fs')
const path = require('node:path')

const APP_DIR_NAME = 'ryza-assistant-app'
const POINTER_NAME = 'data-root.json'
const MAX_KNOWN = 10

/** 复制数据时跳过的东西：都能重建，且往往几百 MB～几 GB（venv / 模型 / 缩略图缓存） */
const COPY_SKIP = [
  path.join('cache'),
  path.join('logs'),
  path.join('bili-duty', '.venv'),
  path.join('bili-duty', 'models'),
  path.join('bili-duty', 'asr'),
  path.join('companion', 'tts'),
  path.join('Crashpad')
]

function appDataDirOf (app) {
  return path.join(app.getPath('appData'), APP_DIR_NAME)
}

function pointerFileOf (app) {
  return path.join(appDataDirOf(app), POINTER_NAME)
}

function readPointer (app) {
  try {
    const j = JSON.parse(fs.readFileSync(pointerFileOf(app), 'utf8'))
    return {
      root: typeof j.root === 'string' ? j.root : '',
      known: Array.isArray(j.known) ? j.known.filter(x => typeof x === 'string').slice(0, MAX_KNOWN) : []
    }
  } catch {
    return { root: '', known: [] }
  }
}

function writePointer (app, next) {
  try {
    const dir = appDataDirOf(app)
    fs.mkdirSync(dir, { recursive: true })
    const prev = readPointer(app)
    const merged = {
      root: next.root !== undefined ? String(next.root) : prev.root,
      known: next.known || prev.known
    }
    fs.writeFileSync(pointerFileOf(app), JSON.stringify(merged, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 数据目录「算有数据」的判定：有 config.json 才算，空目录/只有 cache 不算 */
function hasData (dir) {
  if (!dir) return false
  try {
    return fs.existsSync(path.join(dir, 'config.json'))
  } catch {
    return false
  }
}

function portableRoot (env) {
  const dir = (env || process.env).PORTABLE_EXECUTABLE_DIR
  return dir ? path.join(dir, 'data') : ''
}

function defaultRoot (app) {
  return path.join(app.getPath('appData'), APP_DIR_NAME)
}

/**
 * ready 之前决定这次启动用哪个目录（纯计算，不碰 app.setPath，方便单测）
 * @returns {{ root: string, portable: boolean, source: 'portable'|'pointer'|'default' }}
 */
function planStartup ({ app, env }) {
  const p = portableRoot(env)
  if (p) return { root: p, portable: true, source: 'portable' }
  const ptr = readPointer(app)
  if (ptr.root) return { root: ptr.root, portable: false, source: 'pointer' }
  return { root: defaultRoot(app), portable: false, source: 'default' }
}

/** ready 前调用：建目录 + app.setPath('userData') */
function applyRoot ({ app, log, env }) {
  const plan = planStartup({ app, env })
  try { fs.mkdirSync(plan.root, { recursive: true }) } catch {}
  try {
    app.setPath('userData', plan.root)
  } catch (err) {
    if (log) log('[datadir] setPath 失败: ' + (err && err.message))
  }
  if (log) log('[datadir] 数据目录=' + plan.root + '（' + plan.source + '）')
  return plan
}

/** 复制数据目录（跳过可重建的大件），返回 { ok, copied, skipped } */
function copyData (from, to, log) {
  let copied = 0
  let skipped = 0
  const walk = (src, dst) => {
    let entries = []
    try { entries = fs.readdirSync(src, { withFileTypes: true }) } catch { return }
    try { fs.mkdirSync(dst, { recursive: true }) } catch {}
    for (const e of entries) {
      const s = path.join(src, e.name)
      const d = path.join(dst, e.name)
      const rel = path.relative(from, s)
      if (COPY_SKIP.some(k => rel === k || rel.startsWith(k + path.sep))) { skipped++; continue }
      if (e.isDirectory()) {
        walk(s, d)
      } else if (e.isFile()) {
        try { fs.copyFileSync(s, d); copied++ } catch (err) {
          if (log) log('[datadir] 复制失败 ' + rel + ': ' + (err && err.message))
        }
      }
      // 符号链接不管（配置里没有，遇到就跳过）
    }
  }
  walk(from, to)
  return { ok: true, copied, skipped }
}

/** 在已知目录里找「有数据」的旧目录（排除当前） */
function findLegacy ({ current, pointer, fallback }) {
  const seen = new Set([current])
  const out = []
  for (const c of (pointer && pointer.known) || []) {
    if (!seen.has(c)) { seen.add(c); out.push(c) }
  }
  if (fallback && !seen.has(fallback)) out.push(fallback)
  return out.filter(hasData)
}

/**
 * ready 之后调用：登记本次目录；若当前目录是空的但附近有旧数据 → 询问怎么处理。
 * 除了「新建空数据」都会重启应用（换目录必须重启才干净）。
 * @returns {Promise<{restarted:boolean, root:string}>}
 */
async function ensureData ({ app, dialog, log }) {
  const current = app.getPath('userData')
  const ptr = readPointer(app)
  const known = [current, ...(ptr.known || []).filter(x => x !== current)].slice(0, MAX_KNOWN)
  writePointer(app, { root: current, known })

  if (hasData(current)) return { restarted: false, root: current }

  const legacy = findLegacy({ current, pointer: ptr, fallback: defaultRoot(app) })[0]
  if (!legacy) return { restarted: false, root: current } // 首次运行，安静新建

  if (!dialog || typeof dialog.showMessageBoxSync !== 'function') {
    return { restarted: false, root: current }
  }

  const btn = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['继承旧数据', '新建空数据', '选择其他目录…', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: '数据目录',
    message: '当前数据目录是空的',
    detail: '当前：' + current + '\n之前的数据：' + legacy +
      '\n\n「继承」会把旧数据（不含日志、缓存、语音模型）复制到当前目录。'
  })

  if (btn === 1) return { restarted: false, root: current } // 新建空数据
  if (btn === 3) { app.quit(); return { restarted: true, root: current } }

  if (btn === 0) {
    const r = copyData(legacy, current, log)
    if (log) log('[datadir] 继承完成：复制 ' + r.copied + ' 个文件，跳过 ' + r.skipped + ' 个')
    writePointer(app, { root: current, known })
    relaunch(app)
    return { restarted: true, root: current }
  }

  // btn === 2 选择其他目录
  let picked = ''
  try {
    const res = dialog.showOpenDialogSync({
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current
    })
    picked = (res && res[0]) || ''
  } catch {}
  if (!picked) { app.quit(); return { restarted: true, root: current } }

  if (hasData(picked)) {
    if (log) log('[datadir] 切换到我已有数据的目录：' + picked)
  } else {
    const r = copyData(legacy, picked, log)
    if (log) log('[datadir] 复制旧数据到新目录：' + r.copied + ' 个文件')
  }
  writePointer(app, { root: picked, known: [picked, ...known].slice(0, MAX_KNOWN) })
  relaunch(app)
  return { restarted: true, root: picked }
}

/** 用户从设置页更换数据目录：写指针后立刻重启 */
function switchTo ({ app, target, log }) {
  if (!target) return { ok: false, error: '未选择目录' }
  const known = [target, ...(readPointer(app).known || []).filter(x => x !== target)].slice(0, MAX_KNOWN)
  writePointer(app, { root: target, known })
  if (log) log('[datadir] 用户更换数据目录 → ' + target + '（即将重启）')
  relaunch(app)
  return { ok: true, restart: true }
}

function relaunch (app) {
  try {
    app.relaunch()
    app.exit(0)
  } catch {}
}

module.exports = {
  APP_DIR_NAME,
  COPY_SKIP,
  appDataDirOf,
  pointerFileOf,
  readPointer,
  writePointer,
  hasData,
  portableRoot,
  defaultRoot,
  planStartup,
  applyRoot,
  copyData,
  findLegacy,
  ensureData,
  switchTo
}
