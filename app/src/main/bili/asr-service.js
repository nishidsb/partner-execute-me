/**
 * 本地转写常驻服务客户端（0.18.0）。
 *
 * 为什么需要：一次性 asr.py 每句都要重新加载 whisper 模型，CPU 上冷启动 4~6 秒，
 * 常开麦克风下用户每句话等 8~15 秒，看起来就像「识别坏了」。这里起一个常驻 python
 * 进程（resources/bili/asr_serve.py），模型只加载一次，之后每句只做推理（1~3 秒）。
 *
 * 设计要点：
 * - 单例：同一时刻只保留一个进程（换模型会重建）；请求严格串行（服务端也是一问一答）
 * - 空闲 10 分钟自动退出，不长期占 200~300MB 内存；下次说话再拉起来
 * - ready 握手：模型加载完才发 {"ready":true}，之前的请求先排队
 * - 任何异常（启动失败/超时/进程退出）都返回 ok:false，让上层回退到一次性 asr.py
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const HF_MIRROR = 'https://hf-mirror.com'
const READY_TIMEOUT = 180000 // 首次可能要下模型
const REQ_TIMEOUT = 90000
const IDLE_MS = 10 * 60 * 1000

let svc = null // { key, proc, alive, ready, readyWaiters, outBuf, pending, idleTimer }
let chain = Promise.resolve() // 进程级串行

function bundledScript () {
  return path.join(__dirname, '..', '..', '..', 'resources', 'bili', 'asr_serve.py')
}

function venvPython (home) {
  return process.platform === 'win32'
    ? path.join(home, '.venv', 'Scripts', 'python.exe')
    : path.join(home, '.venv', 'bin', 'python')
}

/** 把 asar 里的脚本同步到家目录（asar 内文件不能直接给 python 执行） */
function syncScript (home) {
  const dst = path.join(home, 'asr_serve.py')
  const src = fs.readFileSync(bundledScript(), 'utf8')
  let cur = ''
  try { cur = fs.readFileSync(dst, 'utf8') } catch { }
  if (cur !== src) fs.writeFileSync(dst, src, 'utf8')
  return dst
}

function destroy (why) {
  const cur = svc
  svc = null
  if (!cur) return
  try { clearTimeout(cur.idleTimer) } catch { }
  // 排队的请求必须当场返回失败，否则它们要等到自己的 90 秒超时才醒
  for (const w of cur.pending) {
    try {
      clearTimeout(w.timer)
      w.resolve({ ok: false, error: why || '转写服务已关闭' })
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

function handleLine (line) {
  const cur = svc
  if (!cur) return
  let msg = null
  try { msg = JSON.parse(line) } catch { return } // 模型下载进度之类的噪声行，忽略
  if (msg.ready) {
    cur.ready = true
    for (const w of cur.readyWaiters) { try { w() } catch { } }
    cur.readyWaiters = []
    return
  }
  if (msg.fatal) {
    destroy('服务启动失败：' + (msg.error || '未知'))
    return
  }
  const w = cur.pending.shift()
  if (!w) return
  clearTimeout(w.timer)
  if (msg.ok) w.resolve({ ok: true, text: String(msg.text || ''), durationSec: Number(msg.durationSec) || 0, language: String(msg.language || '') })
  else w.resolve({ ok: false, error: String(msg.error || '转写失败') })
}

function ensureProc (home, model) {
  const key = home + '|' + model
  if (svc && svc.key === key && svc.alive) return Promise.resolve(svc)
  if (svc) destroy('换模型/换目录')

  const script = syncScript(home)
  const py = venvPython(home)
  if (!fs.existsSync(py)) return Promise.reject(new Error('本地转写环境还没装好'))

  const proc = spawn(py, [script, String(model)], {
    windowsHide: true,
    // HF_HUB_DISABLE_XET：新版 huggingface_hub 默认走 Xet 协议，国内镜像不支持会 401，
    // 表现为「换模型后模型加载失败」。关掉它走普通 HTTP，下载才稳。
    env: { ...process.env, HF_ENDPOINT: HF_MIRROR, HF_HUB_DISABLE_XET: '1', PYTHONIOENCODING: 'utf-8' }
  })

  const cur = {
    key, proc, alive: true, ready: false, readyWaiters: [],
    outBuf: '', pending: [], idleTimer: null
  }
  svc = cur

  const onData = (chunk) => {
    cur.outBuf += chunk.toString('utf8')
    let idx
    while ((idx = cur.outBuf.indexOf('\n')) >= 0) {
      const line = cur.outBuf.slice(0, idx).trim()
      cur.outBuf = cur.outBuf.slice(idx + 1)
      if (line) handleLine(line)
    }
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', (c) => {
    // 模型下载进度/警告；只在真出问题时才有用，避免刷日志
    const s = c.toString('utf8').trim()
    if (s && /error|Traceback|失败/i.test(s)) console.warn('[asr-svc]', s.slice(0, 300))
  })
  proc.on('error', (e) => { cur.alive = false; destroy('进程启动失败：' + e.message) })
  proc.on('close', () => {
    cur.alive = false
    if (svc === cur) destroy('转写进程已退出')
  })

  const readyPromise = new Promise((resolve, reject) => {
    cur.readyWaiters.push(resolve)
    setTimeout(() => {
      if (cur.ready) return
      destroy('转写服务启动超时')
      reject(new Error('转写服务启动超时（首次加载模型较慢）'))
    }, READY_TIMEOUT)
  })
  return readyPromise.then(() => cur)
}

/** 发一条请求（内部串行，保证一问一答不串号） */
function request (home, model, filePath, language) {
  chain = chain.then(async () => {
    const cur = await ensureProc(home, model)
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = cur.pending.findIndex((x) => x.timer === timer)
        if (i >= 0) cur.pending.splice(i, 1)
        destroy('转写超时')
        resolve({ ok: false, error: '转写超时（' + Math.round(REQ_TIMEOUT / 1000) + ' 秒）' })
      }, REQ_TIMEOUT)
      cur.pending.push({ resolve, timer })
      try {
        cur.proc.stdin.write(JSON.stringify({ audio: filePath, language: language || 'auto' }) + '\n')
      } catch (e) {
        clearTimeout(timer)
        resolve({ ok: false, error: '写入转写进程失败：' + e.message })
      }
      armIdle()
    })
  }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
  return chain
}

/**
 * 转写一个本地音频文件（常驻服务）。
 * 返回 { ok:true, text, durationSec } / { ok:false, error }
 * 调用方拿到 ok:false 时应回退到一次性 transcribeAudioFile。
 */
async function transcribe (home, filePath, { model = 'small', language = 'auto' } = {}) {
  const r = await request(home, model, filePath, language)
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '本地转写服务不可用' }
  return r
}

/** 预热：用户开麦/启动时调一下，把模型加载的时间藏起来（失败无所谓） */
function warmup (home, model = 'small') {
  ensureProc(home, model).then(() => armIdle()).catch(() => { })
}

function shutdown () { destroy('应用退出') }

module.exports = { transcribe, warmup, shutdown, _destroy: destroy }
