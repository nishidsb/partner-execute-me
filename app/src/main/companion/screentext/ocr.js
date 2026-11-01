'use strict'
/**
 * 屏幕字幕 OCR 的常驻服务壳（照 `bili/asr-service.js` 那套写法，别另起一套）
 *
 * 为什么常驻：模型检测 9.5MB + 识别 21MB，每次现加载要多花 0.5~0.9 秒；
 * 陪看是每 1.2 秒读一帧的长期活，必须一次加载、之后只推理（框一条字 20~60ms）。
 *
 * 三个必须照做的地方：
 *   1. **脚本和模型都要从 asar 拷到家目录** —— asar 内的文件 python 读不了（同 asr.py 的坑）；
 *   2. **严格一问一答串行** —— 进程是单线程读 stdin 的，并发发两条会串号；
 *   3. **空闲 10 分钟自动退出** —— 别为了陪看常驻一个占 100MB 的 python。
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const READY_TIMEOUT = 90000
const REQ_TIMEOUT = 20000
const IDLE_MS = 10 * 60 * 1000

const DET_FILE = 'PP-OCRv6_det_small.onnx'
const REC_FILE = 'PP-OCRv6_rec_small.onnx'

let svc = null
let chain = Promise.resolve()

/**
 * 找到 python 真能读到的脚本和模型目录。
 *
 * 优先用**解包后的路径**（package.json 里 asarUnpack 了 resources/screen/**）——
 * 这样 python 直接读安装目录里的 31MB 模型，不用往用户目录再拷一份。
 * 万一没解包（老包/自己改的构建），退回到「拷到家目录」那条路（同 asr.py 的做法）。
 */
function resolveAssets (home, srcDir) {
  let unpacked = (p) => p
  try { unpacked = require('../../util').unpackedPath || unpacked } catch { }
  const scriptPacked = path.join(srcDir, 'ocr_serve.py')
  const modelsPacked = path.join(srcDir, 'models')
  const scriptDirect = unpacked(scriptPacked)
  const modelsDirect = unpacked(modelsPacked)
  if (fs.existsSync(scriptDirect) && fs.existsSync(path.join(modelsDirect, DET_FILE))) {
    return { script: scriptDirect, models: modelsDirect }
  }
  // 兜底：从（可能还在 asar 里的）源拷到家目录
  const dir = path.join(home, 'models')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(home, 'ocr_serve.py')
  const src = fs.readFileSync(scriptPacked, 'utf8')
  let cur = ''
  try { cur = fs.readFileSync(script, 'utf8') } catch { }
  if (cur !== src) fs.writeFileSync(script, src, 'utf8')
  for (const f of [DET_FILE, REC_FILE]) {
    const dst = path.join(dir, f)
    if (fs.existsSync(dst) && fs.statSync(dst).size > 1024 * 1024) continue
    fs.copyFileSync(path.join(modelsPacked, f), dst)
  }
  return { script, models: dir }
}

/**
 * 复用本地转写那套 venv（<userData>/bili-duty/.venv）—— onnxruntime + numpy 已经装在里面了，
 * 不再单独建第二个环境（30MB 模型 + 80MB 运行库，装两套没意义）。
 */
function pythonFor (venvHome) {
  const venv = process.platform === 'win32'
    ? path.join(venvHome, '.venv', 'Scripts', 'python.exe')
    : path.join(venvHome, '.venv', 'bin', 'python')
  return fs.existsSync(venv) ? venv : ''
}

function destroy (why) {
  const cur = svc
  svc = null
  if (!cur) return
  try { clearTimeout(cur.idleTimer) } catch { }
  for (const w of cur.pending) {
    try {
      clearTimeout(w.timer)
      w.resolve({ ok: false, error: why || 'OCR 服务已关闭' })
    } catch { }
  }
  cur.pending = []
  try { if (cur.proc && !cur.proc.killed) cur.proc.kill() } catch { }
}

function armIdle () {
  if (!svc) return
  try { clearTimeout(svc.idleTimer) } catch { }
  svc.idleTimer = setTimeout(() => destroy('空闲超时'), IDLE_MS)
  try { svc.idleTimer.unref && svc.idleTimer.unref() } catch { }
}

function handleLine (line, onLog) {
  const cur = svc
  if (!cur) return
  let msg = null
  try { msg = JSON.parse(line) } catch { return }
  if (msg.ready) {
    cur.ready = true
    const ws = cur.readyWaiters
    cur.readyWaiters = []
    for (const w of ws) { try { w() } catch { } }
    return
  }
  if (msg.ok === false && msg.ready === false) {
    destroy('OCR 服务起不来：' + (msg.error || '未知'))
    return
  }
  const w = cur.pending.shift()
  if (!w) return
  clearTimeout(w.timer)
  if (msg.ok) w.resolve({ ok: true, text: String(msg.text || ''), lines: Number(msg.lines) || 0, ms: Number(msg.ms) || 0 })
  else w.resolve({ ok: false, error: String(msg.error || '识别失败') })
  if (onLog) onLog(msg)
}

function ensureProc ({ home, venvHome, srcDir, log = () => { } }) {
  if (svc && svc.alive && svc.home === home) return Promise.resolve(svc)
  if (svc) destroy('换目录')

  const py = pythonFor(venvHome || home)
  if (!py) {
    return Promise.reject(new Error('本地识别环境还没装好（设置 → 语音 → 建立本地转写环境，装完这里就能用）'))
  }
  const assets = resolveAssets(home, srcDir)
  const proc = spawn(py, [assets.script, assets.models], {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  })

  const cur = {
    home, proc, alive: true, ready: false, readyWaiters: [],
    outBuf: '', pending: [], idleTimer: null
  }
  svc = cur

  const onData = (chunk) => {
    cur.outBuf += chunk.toString('utf8')
    let idx
    while ((idx = cur.outBuf.indexOf('\n')) >= 0) {
      const line = cur.outBuf.slice(0, idx).trim()
      cur.outBuf = cur.outBuf.slice(idx + 1)
      if (line) handleLine(line, log)
    }
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', (c) => {
    const s = c.toString('utf8').trim()
    if (s && /error|Traceback|失败/i.test(s)) log('[ocr] ' + s.slice(0, 300))
  })
  proc.on('error', (e) => { cur.alive = false; destroy('进程启动失败：' + e.message) })
  proc.on('close', () => {
    cur.alive = false
    if (svc === cur) destroy('OCR 进程已退出')
  })

  const ready = new Promise((resolve, reject) => {
    cur.readyWaiters.push(resolve)
    setTimeout(() => {
      if (cur.ready) return
      destroy('OCR 服务启动超时')
      reject(new Error('OCR 服务启动超时（首次要读 30MB 模型）'))
    }, READY_TIMEOUT)
  })
  return ready.then(() => cur)
}

/**
 * 读一帧。
 * @param {object} o
 * @param {string} o.home     用户数据目录（screen-text 的父级）
 * @param {string} o.srcDir   随程序分发的 resources/screen
 * @param {Buffer} o.bgra     GDI/Electron 的原始像素（BGRA8888）
 * @param {number} o.w
 * @param {number} o.h
 */
function readFrame ({ home, venvHome, srcDir, bgra, w, h, log }) {
  chain = chain.then(async () => {
    const cur = await ensureProc({ home, venvHome, srcDir, log })
    return await new Promise((resolve) => {
      const job = {
        resolve,
        timer: setTimeout(() => {
          const i = cur.pending.indexOf(job)
          if (i >= 0) cur.pending.splice(i, 1)
          resolve({ ok: false, error: 'OCR 超时' })
        }, REQ_TIMEOUT)
      }
      cur.pending.push(job)
      try {
        cur.proc.stdin.write(JSON.stringify({ cmd: 'read', w, h, bgra: bgra.toString('base64') }) + '\n')
      } catch (err) {
        clearTimeout(job.timer)
        const i = cur.pending.indexOf(job)
        if (i >= 0) cur.pending.splice(i, 1)
        resolve({ ok: false, error: String(err && err.message) })
      }
      armIdle()
    })
  }).catch((err) => ({ ok: false, error: String(err && err.message) }))
  return chain
}

/** 提前把模型读进内存（进陪看前调一次，第一帧就不用等 0.9 秒） */
function warm (opts) {
  return ensureProc(opts).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message }))
}

function stop () { destroy('主动停止') }

const status = () => ({
  running: !!(svc && svc.alive),
  ready: !!(svc && svc.ready),
  pending: svc ? svc.pending.length : 0
})

module.exports = { readFrame, warm, stop, status, resolveAssets, pythonFor }
