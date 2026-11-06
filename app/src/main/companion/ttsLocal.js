/**
 * 0.22.0 本地回退语音：GPT-SoVITS（快）→ IndexTTS-2.5（兜底），都失败才系统语音
 *
 * Fish 合成失败/超时时按上面的顺序试本地引擎（音色都是角色参考音色，
 * 比系统语音强得多）。两个后端进程都是懒启动：Fish 一次都没失败过就
 * 完全不占内存；拉起后常驻（模型只加载一次），应用退出时一并结束。
 *
 * SoVITS 后端（0.22.0 补丁⑤）：E 盘 GPT-SoVITS-v2pro 整包自带的 api_v2.py
 * （runtime 里的 python，模型加载完才监听端口 → TCP 能连上就=就绪）：
 *   POST /tts {text, text_lang, ref_audio_path, prompt_text, prompt_lang, ...}
 *     -> 完整 wav（非流式，Response 带 Content-Length）
 *   CPU（tts_infer.yaml custom 段已定 device:cpu / is_half:false / v2Pro），
 *   一句 5~20 秒，比 IndexTTS 的扩散快一个数量级。
 *
 * IndexTTS 后端：复用 Documents/index-tts 里现成的 indextts_sovits_adapter.py：
 *   POST /tts {text, text_lang, ref_audio_path} -> 32kHz/16bit/mono 裸 PCM
 *
 * IndexTTS 速度现实（本机 12 核 CPU，实测）：模型加载约 30-60 秒（只在首次
 * 回退时发生），每句合成 30~100 秒（扩散 12 步）。语音会迟到但不会不到——
 * 字幕总是先出来的。
 *
 * 0.46.39 长句分片：11-02 真机实锤 499 字长句在 CPU 上（RTF 15+）必然撞死
 * 240s 超时、从未产出过音频。改为按标点拆成 ≤50 字的片、逐片合成（每片各自
 * 受 SYNTH_TIMEOUT_MS 约束）、PCM 同格式顺序拼接。片数上限 8（约 400 字）——
 * 更长的语音既没有意义也占着串行队列。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { pathToFileURL } = require('node:url')

/** 默认部署目录（设置里可改） */
const DEFAULT_DIR = path.join(require('node:os').homedir(), 'Documents', 'index-tts')
/** GPT-SoVITS 整包目录（0.22.0 补丁⑤；设置里可改） */
const DEFAULT_SOVITS_DIR = 'E:\\GPT-SoVITS-v2pro-20250604'
/** 参考音频的台词（零样本克隆的提示文本；设置里可改） */
const DEFAULT_PROMPT_TEXT = 'いいよ……一突き、いっかい……'
/**
 * SoVITS 专用默认参考：GPT-SoVITS 只收 3~10 秒的参考音频（实测「语音」目录里
 * 那个 Ryza_hires 全长 mp3 会被 400 拒掉），所以用 ffmpeg 切好的 6 秒版；
 * 文件不存在再退回目录扫描。
 */
const DEFAULT_SOVITS_REF = path.join(require('node:os').homedir(), 'Documents', '语音', 'ryza-ref-6s.wav')
/** 起服务时从这些端口里找空闲的（避开 DSH 语音后端的 9880） */
const PORT_CANDIDATES = [9891, 9892, 9893]
/** SoVITS api_v2 端口候选（避开 9880/DSH 和 IndexTTS 的 9891~9893） */
const SOVITS_PORT_CANDIDATES = [9894, 9895, 9896]
/** 等模型就绪的上限（首次加载 30-60s，留足余量） */
const READY_TIMEOUT_MS = 150 * 1000
/** SoVITS 就绪上限（CPU 上 v2Pro 全家桶加载约 30~90s） */
const SOVITS_READY_TIMEOUT_MS = 180 * 1000
/** 单句合成上限（CPU 上长句可到 100s+） */
const SYNTH_TIMEOUT_MS = 240 * 1000
/** SoVITS 单句上限（CPU 5~20s，cut5 分段的长段留足余量） */
const SOVITS_SYNTH_TIMEOUT_MS = 180 * 1000
/** 扩散步数：实测 8 步崩坏、10 步是安全下限、12 步保守 */
const STEPS = 12
/** 0.46.39 分片上限：≤50 字的片在本机实测约 100~150s（RTF 15），稳在 240s 内 */
const INDEX_TTS_CHUNK_MAX = 50
/** 0.46.39 片数上限：约 400 字。CPU 上 8 片要十几分钟，再长不如不念 */
const INDEX_TTS_CHUNK_LIMIT = 8

let state = {
  proc: null,        // 常驻 python 进程
  port: 0,           // 实际端口
  logFile: '',       // python 输出日志
  starting: null,    // Promise：起服务中（防并发拉起）
  queue: [],         // 串行队列（模型端有锁，但排队更稳，避免请求堆一起全超时）
  draining: false,
  current: null      // 0.46.48 正在跑的任务（cancelPending 打断它用）
}

/** SoVITS 后端独立状态（进程/端口/队列与 IndexTTS 互不干扰） */
const svState = {
  proc: null,
  port: 0,
  logFile: '',
  starting: null,
  queue: [],
  draining: false,
  current: null   // 0.46.48
}

function logTo (file, msg) {
  try {
    const line = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + msg
    console.log('[tts-local] ' + msg)
    if (file) {
      try { fs.appendFileSync(file, line + '\n', 'utf8') } catch { }
    }
  } catch { }
}

function log (msg) { logTo(state.logFile, msg) }

/** 台词语种猜测：replyLang=auto 时 speakWithCurrentConfig 拿不到确定语种，按字符判断 */
function guessLang (text, fallback) {
  const t = String(text || '')
  if (/[\u3040-\u30ff]/.test(t)) return 'ja'   // 假名 → 日语
  if (/[\u4e00-\u9fff]/.test(t)) return 'zh'   // 汉字（无假名）→ 中文
  if (/[a-zA-Z]/.test(t)) return 'en'
  return ({ zh: 'zh', en: 'en', ja: 'ja' })[fallback] || 'zh'
}

/** 参考音频目录（设置里 indexTtsRef 为空时扫这里取第一个音频） */
const DEFAULT_REF_DIR = path.join(require('node:os').homedir(), 'Documents', '语音')

/** 默认参考：扫语音目录拿第一个 mp3/wav */
function defaultRef () {
  try {
    const files = fs.readdirSync(DEFAULT_REF_DIR)
      .filter((f) => /\.(mp3|wav|flac)$/i.test(f))
      .sort()
    return files.length ? path.join(DEFAULT_REF_DIR, files[0]) : ''
  } catch { return '' }
}

function pythonExe (dir) {
  return path.join(dir, '.venv', 'Scripts', 'python.exe')
}
function adapterPy (dir) {
  return path.join(dir, 'indextts_sovits_adapter.py')
}

/** 环境是否齐备（部署目录 + venv + 适配器脚本 + checkpoints） */
function available (dir) {
  const d = dir || DEFAULT_DIR
  try {
    return fs.existsSync(pythonExe(d)) &&
      fs.existsSync(adapterPy(d)) &&
      fs.existsSync(path.join(d, 'checkpoints', 'config.yaml'))
  } catch { return false }
}

/** 找空闲端口 */
function freePort (candidates) {
  const net = require('net')
  return new Promise((resolve) => {
    let i = 0
    const tryNext = () => {
      if (i >= candidates.length) return resolve(0)
      const p = candidates[i++]
      const srv = net.createServer()
      srv.once('error', () => tryNext())
      srv.once('listening', () => srv.close(() => resolve(p)))
      srv.listen(p, '127.0.0.1')
    }
    tryNext()
  })
}

function health (port, timeoutMs = 1500) {
  const net = require('net')
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    const done = (ok) => { try { s.destroy() } catch { } resolve(ok) }
    s.setTimeout(timeoutMs)
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.once('timeout', () => done(false))
  })
}

/** 拉起常驻适配器（幂等；并发调用共用同一次启动） */
async function ensureServer (cfgGet) {
  if (state.proc && state.port && await health(state.port)) return state.port
  const c = cfgGet() || {}
  const dir = c.indexTtsDir || DEFAULT_DIR
  if (!available(dir)) throw new Error('index-tts 未找到（' + dir + '）')
  const ref = c.indexTtsRef || defaultRef()
  if (!ref || !fs.existsSync(ref)) throw new Error('参考音频不存在（' + (ref || DEFAULT_REF_DIR + ' 下没有音频') + '）')
  if (state.starting) return state.starting

  state.starting = (async () => {
    const port = await freePort(PORT_CANDIDATES)
    if (!port) throw new Error('找不到空闲端口（' + PORT_CANDIDATES.join('/') + '）')
    const logFile = path.join(os.tmpdir(), 'ryza-indextts.log')
    try { fs.writeFileSync(logFile, '', 'utf8') } catch { }
    state.logFile = logFile
    log('拉起本地 IndexTTS（端口 ' + port + '，首次加载模型约 30-60 秒）…')
    const py = pythonExe(dir)
    const args = [adapterPy(dir), '--port', String(port), '--ref', ref, '--steps', String(STEPS)]
    const proc = spawn(py, args, {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' })
    })
    const tail = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) if (line.trim()) log('py: ' + line.trim())
    }
    proc.stdout.on('data', tail)
    proc.stderr.on('data', tail)
    proc.once('exit', (code) => {
      log('进程退出 code=' + code)
      if (state.proc === proc) { state.proc = null; state.port = 0 }
    })
    proc.once('error', (err) => {
      log('进程错误: ' + err.message)
      if (state.proc === proc) { state.proc = null; state.port = 0 }
    })
    state.proc = proc
    state.port = port

    // 轮询 /health：连接被拒 = 模型还在加载
    const t0 = Date.now()
    while (Date.now() - t0 < READY_TIMEOUT_MS) {
      if (state.proc !== proc) throw new Error('IndexTTS 进程提前退出（详见 ' + logFile + '）')
      if (await health(port)) {
        log('就绪（用时 ' + Math.round((Date.now() - t0) / 1000) + 's，端口 ' + port + '）')
        return port
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    stopServer()
    throw new Error('模型加载超时（' + Math.round(READY_TIMEOUT_MS / 1000) + 's），详见 ' + logFile)
  })()
  try {
    return await state.starting
  } finally {
    state.starting = null
  }
}

/** 32kHz/16bit/mono 裸 PCM → wav 文件（44 字节头）→ file:// URL（与 tts.js 同目录统一清理） */
function pcmToWavUrl (pcm, sampleRate = 32000) {
  let dir
  try { dir = require('./tts').tmpDir() } catch { dir = path.join(os.tmpdir(), 'ryza-tts') }
  try { fs.mkdirSync(dir, { recursive: true }) } catch { }
  const file = path.join(dir, 'local_' + crypto.createHash('md5').update(pcm).digest('hex').slice(0, 12) + '.wav')
  const header = Buffer.alloc(44)
  const dataLen = pcm.length
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataLen, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)          // fmt 块长
  header.writeUInt16LE(1, 20)           // PCM
  header.writeUInt16LE(1, 22)           // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32)           // block align
  header.writeUInt16LE(16, 34)          // bits
  header.write('data', 36)
  header.writeUInt32LE(dataLen, 40)
  fs.writeFileSync(file, Buffer.concat([header, pcm]))
  // 0.46.63 口型包络（参考项目同款：wav→20ms 帧振幅）
  let env = null
  try { env = require('./envelope').envelopeFromWav(Buffer.concat([header, pcm])) } catch { }
  return { url: pathToFileURL(file).href, env }
}

/** HTTP POST 一句，返回 PCM */
function postTts (port, text, lang, ref) {
  const net = require('net')
  const body = JSON.stringify({ text, text_lang: lang, ref_audio_path: ref })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error('合成超时（' + Math.round(SYNTH_TIMEOUT_MS / 1000) + 's）'))
    }, SYNTH_TIMEOUT_MS)
    const s = net.connect(port, '127.0.0.1')
    const chunks = []
    s.on('connect', () => {
      s.write('POST /tts HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n' +
        'Content-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body)
    })
    s.on('data', (d) => chunks.push(d))
    s.on('end', () => {
      clearTimeout(timer)
      try {
        const raw = Buffer.concat(chunks)
        const sep = raw.indexOf('\r\n\r\n')
        const head = raw.slice(0, sep).toString('utf8')
        const payload = raw.slice(sep + 4)
        const m = /HTTP\/1\.[01] (\d+)/.exec(head)
        const code = m ? Number(m[1]) : 0
        // chunked 之外一律按 Content-Length 整体给（适配器固定发 Content-Length）
        if (code === 200) return resolve(payload)
        let msg = 'HTTP ' + code
        try { msg += ' ' + (JSON.parse(payload.toString('utf8')).error || '') } catch { }
        reject(new Error(msg))
      } catch (err) { reject(err) }
    })
    s.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/** 测试注入点：默认走真 postTts / 真 ensureServer */
let postTtsImpl = postTts
let ensureServerImpl = ensureServer
function _setPostTts (fn) { postTtsImpl = fn || postTts }
function _setEnsureServer (fn) { ensureServerImpl = fn || ensureServer }

/**
 * 0.46.39 长句拆分：优先在句末标点（。！？…）后断句，一段超长再按逗号级
 * （，、；：）断，仍超长才硬切。unit 贪心合并到 ≤ max，内容一字不丢。
 */
function splitForIndexTts (text, maxLen) {
  const max = maxLen || INDEX_TTS_CHUNK_MAX
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return []
  if (t.length <= max) return [t]
  const units = []
  for (const seg of t.split(/(?<=[。！？!?…])|(?<=\n)/)) {
    if (!seg) continue
    if (seg.length <= max) { units.push(seg); continue }
    for (const seg2 of seg.split(/(?<=[，、,；;：:])/)) {
      if (seg2.length <= max) { if (seg2) units.push(seg2); continue }
      for (let i = 0; i < seg2.length; i += max) units.push(seg2.slice(i, i + max))
    }
  }
  const out = []
  let cur = ''
  for (const u of units) {
    if (!cur) cur = u
    else if (cur.length + u.length <= max) cur += u
    else { out.push(cur); cur = u }
  }
  if (cur) out.push(cur)
  return out
}

/** 串行执行队列（IndexTTS 与 SoVITS 各挂自己的 state，pump 通用） */
async function drain (st) {
  if (st.draining) return
  st.draining = true
  while (st.queue.length) {
    const job = st.queue.shift()
    st.current = job
    try {
      if (job.cancelled) { job.reject(new Error('朗读已被新的打断（未开始即取消）')); continue }
      job.resolve(await job.run())
    } catch (err) { job.reject(err) }
    st.current = null
  }
  st.draining = false
}

/** 0.46.48 取消本地合成：排队中未开始的直接作废；正在跑的标记 cancelled
 *  （分片合成每片之间检查，下一样本前停手——IndexTTS CPU 一跑几分钟，
 *  聊天都到后面了它还在合成前面那句话就是白烧）。 */
function cancelPending (reason) {
  const msg = reason || '朗读已被新的打断'
  for (const job of state.queue) {
    job.cancelled = true
    try { job.reject(new Error(msg)) } catch { }
  }
  state.queue = []
  if (state.current) state.current.cancelled = true
  // SoVITS 同样处理（独立队列）
  for (const job of svState.queue) {
    job.cancelled = true
    try { job.reject(new Error(msg)) } catch { }
  }
  svState.queue = []
  if (svState.current) svState.current.cancelled = true
}

/**
 * 合成一句。返回 { ok:true, url, local:true } 或 throw。
 * cfgGet 提供 indexTtsDir / indexTtsRef。
 * 0.46.39：长句拆成 ≤INDEX_TTS_CHUNK_MAX 字的片逐片合成（每片各自受
 * SYNTH_TIMEOUT_MS 约束），PCM 同格式顺序拼接；片数超 INDEX_TTS_CHUNK_LIMIT
 * 截断并留痕——CPU 兜底场景下「迟到但不会不到」的上限就是 8 片。
 */
async function synthesize (text, langHint, cfgGet) {
  const c = cfgGet() || {}
  const lang = guessLang(text, langHint)
  const ref = c.indexTtsRef || defaultRef()
  let chunks = splitForIndexTts(text)
  if (chunks.length > INDEX_TTS_CHUNK_LIMIT) {
    log('超长截断：' + text.length + ' 字 -> 前 ' + INDEX_TTS_CHUNK_LIMIT + ' 片（约 ' + INDEX_TTS_CHUNK_LIMIT * INDEX_TTS_CHUNK_MAX + ' 字）')
    chunks = chunks.slice(0, INDEX_TTS_CHUNK_LIMIT)
  }
  return new Promise((resolve, reject) => {
    const job = {
      run: async () => {
        const port = await ensureServerImpl(cfgGet)
        const t0 = Date.now()
        if (chunks.length <= 1) {
          log('合成中（' + lang + '，' + text.length + ' 字）…')
          const pcm = await postTtsImpl(port, chunks[0] || text, lang, ref)
          if (!pcm || pcm.length < 2000) throw new Error('合成结果为空')
          log('完成（' + Math.round((Date.now() - t0) / 1000) + 's，' + Math.round(pcm.length / 64000) + 's 音频）')
          const w1 = pcmToWavUrl(pcm); return { ok: true, url: w1.url, env: w1.env, local: true }
        }
        log('长句分片合成（' + lang + '，' + text.length + ' 字 -> ' + chunks.length + ' 片）…')
        const pcms = []
        for (let i = 0; i < chunks.length; i++) {
          if (job.cancelled) throw new Error('朗读已被新的打断（分片 ' + (i + 1) + ' 前取消）')
          const ct0 = Date.now()
          const pcm = await postTtsImpl(port, chunks[i], lang, ref)
          if (!pcm || pcm.length < 2000) throw new Error('第 ' + (i + 1) + '/' + chunks.length + ' 片合成结果为空')
          pcms.push(pcm)
          log('  片 ' + (i + 1) + '/' + chunks.length + ' 完成（' + Math.round((Date.now() - ct0) / 1000) + 's，' + Math.round(pcm.length / 64000) + 's 音频）')
        }
        const all = Buffer.concat(pcms)
        log('完成（共 ' + Math.round((Date.now() - t0) / 1000) + 's，' + Math.round(all.length / 64000) + 's 音频）')
        const w2 = pcmToWavUrl(all); return { ok: true, url: w2.url, env: w2.env, local: true }
      },
      resolve,
      reject
    }
    state.queue.push(job)
    drain(state).catch(() => { })
  })
}

/* ==================== SoVITS 后端（0.22.0 补丁⑤） ==================== */

function sovitsPythonExe (dir) {
  return path.join(dir, 'runtime', 'python.exe')
}
function sovitsApiPy (dir) {
  return path.join(dir, 'api_v2.py')
}

/** SoVITS 环境是否齐备（runtime python + api_v2 + 配置 yaml + 参考音频） */
function sovitsAvailable (dir) {
  const d = dir || DEFAULT_SOVITS_DIR
  try {
    return fs.existsSync(sovitsPythonExe(d)) &&
      fs.existsSync(sovitsApiPy(d)) &&
      fs.existsSync(path.join(d, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'))
  } catch { return false }
}

/** 拉起 SoVITS api_v2（幂等；并发调用共用同一次启动） */
async function ensureSovits (cfgGet) {
  if (svState.proc && svState.port && await health(svState.port)) return svState.port
  const c = cfgGet() || {}
  const dir = c.sovitsDir || DEFAULT_SOVITS_DIR
  if (!sovitsAvailable(dir)) throw new Error('GPT-SoVITS 未找到（' + dir + '）')
  if (svState.starting) return svState.starting

  svState.starting = (async () => {
    const port = await freePort(SOVITS_PORT_CANDIDATES)
    if (!port) throw new Error('找不到空闲端口（' + SOVITS_PORT_CANDIDATES.join('/') + '）')
    const logFile = path.join(os.tmpdir(), 'ryza-sovits.log')
    try { fs.writeFileSync(logFile, '', 'utf8') } catch { }
    svState.logFile = logFile
    log('拉起本地 GPT-SoVITS api_v2（端口 ' + port + '，首次加载模型约 30~90 秒）…')
    // api_v2.py 里模型加载完才 uvicorn 监听 → 端口能连上就等于模型就绪。
    // HF 离线 + NO_PROXY：模型全在 pretrained_models，别让它碰网/被系统代理拦 127.0.0.1
    const proc = spawn(sovitsPythonExe(dir), [
      sovitsApiPy(dir), '-a', '127.0.0.1', '-p', String(port),
      '-c', 'GPT_SoVITS/configs/tts_infer.yaml'
    ], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost'
      })
    })
    const tail = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) if (line.trim()) logTo(logFile, 'sovits: ' + line.trim())
    }
    proc.stdout.on('data', tail)
    proc.stderr.on('data', tail)
    proc.once('exit', (code) => {
      log('sovits 进程退出 code=' + code)
      if (svState.proc === proc) { svState.proc = null; svState.port = 0 }
    })
    proc.once('error', (err) => {
      log('sovits 进程错误: ' + err.message)
      if (svState.proc === proc) { svState.proc = null; svState.port = 0 }
    })
    svState.proc = proc
    svState.port = port

    const t0 = Date.now()
    while (Date.now() - t0 < SOVITS_READY_TIMEOUT_MS) {
      if (svState.proc !== proc) throw new Error('SoVITS 进程提前退出（详见 ' + logFile + '）')
      if (await health(port)) {
        log('SoVITS 就绪（用时 ' + Math.round((Date.now() - t0) / 1000) + 's，端口 ' + port + '）')
        return port
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    stopSovits()
    throw new Error('SoVITS 模型加载超时（' + Math.round(SOVITS_READY_TIMEOUT_MS / 1000) + 's），详见 ' + logFile)
  })()
  try {
    return await svState.starting
  } finally {
    svState.starting = null
  }
}

/** POST JSON 一句，返回完整响应体（SoVITS 非流式 = 一个带头 wav；失败 = JSON） */
function postSovits (port, bodyObj, timeoutMs) {
  const net = require('net')
  const body = JSON.stringify(bodyObj)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error('合成超时（' + Math.round(timeoutMs / 1000) + 's）'))
    }, timeoutMs)
    const s = net.connect(port, '127.0.0.1')
    const chunks = []
    s.on('connect', () => {
      s.write('POST /tts HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n' +
        'Content-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body)
    })
    s.on('data', (d) => chunks.push(d))
    s.on('end', () => {
      clearTimeout(timer)
      try {
        const raw = Buffer.concat(chunks)
        const sep = raw.indexOf('\r\n\r\n')
        const head = raw.slice(0, sep).toString('utf8')
        const payload = raw.slice(sep + 4)
        // chunked 传输要手动拼帧
        const te = /transfer-encoding:\s*chunked/i.test(head)
        const body2 = te ? dechunk(payload) : payload
        const m = /HTTP\/1\.[01] (\d+)/.exec(head)
        const code = m ? Number(m[1]) : 0
        if (code === 200) return resolve(body2)
        let msg = 'HTTP ' + code
        try { msg += ' ' + (JSON.parse(body2.toString('utf8')).message || '') } catch { }
        reject(new Error(msg))
      } catch (err) { reject(err) }
    })
    s.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/** HTTP chunked 解帧（uvicorn 对动态长度响应可能走 chunked） */
function dechunk (buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i)
    if (nl < 0) break
    const size = parseInt(buf.slice(i, nl).toString('utf8').trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    out.push(buf.slice(nl + 2, nl + 2 + size))
    i = nl + 2 + size + 2 // 跳过帧尾 \r\n
  }
  return Buffer.concat(out)
}

/**带头 wav 原样落盘 → file:// URL（采样率在头里，不用管） */
function wavToFileUrl (wav) {
  let dir
  try { dir = require('./tts').tmpDir() } catch { dir = path.join(os.tmpdir(), 'ryza-tts') }
  try { fs.mkdirSync(dir, { recursive: true }) } catch { }
  const file = path.join(dir, 'sovits_' + crypto.createHash('md5').update(wav).digest('hex').slice(0, 12) + '.wav')
  fs.writeFileSync(file, wav)
  // 0.46.63 口型包络
  let env = null
  try { env = require('./envelope').envelopeFromWav(wav) } catch { }
  return { url: pathToFileURL(file).href, env }
}

/** SoVITS 参考音频：优先专用 6 秒参考（3~10s 限制），没有再退目录扫描 */
function sovitsDefaultRef () {
  try { if (fs.existsSync(DEFAULT_SOVITS_REF)) return DEFAULT_SOVITS_REF } catch { }
  return defaultRef()
}

/**
 * SoVITS 合成一句。返回 { ok:true, url, local:true } 或 throw。
 * cfgGet 提供 sovitsDir / sovitsRef / sovitsPromptText。
 */
async function synthesizeSovits (text, langHint, cfgGet) {
  const c = cfgGet() || {}
  const lang = guessLang(text, langHint)
  const ref = c.sovitsRef || sovitsDefaultRef()
  if (!ref || !fs.existsSync(ref)) throw new Error('参考音频不存在（' + (ref || DEFAULT_REF_DIR + ' 下没有音频') + '）')
  const promptText = c.sovitsPromptText != null && String(c.sovitsPromptText).trim() !== ''
    ? String(c.sovitsPromptText).trim()
    : DEFAULT_PROMPT_TEXT
  const promptLang = guessLang(promptText, 'ja')
  return new Promise((resolve, reject) => {
    svState.queue.push({
      run: async () => {
        const port = await ensureSovits(cfgGet)
        const t0 = Date.now()
        log('SoVITS 合成中（' + lang + '，' + text.length + ' 字）…')
        const wav = await postSovits(port, {
          text: String(text),
          text_lang: lang,
          ref_audio_path: ref,
          prompt_text: promptText,
          prompt_lang: promptLang,
          text_split_method: 'cut5',
          media_type: 'wav',
          streaming_mode: false
        }, SOVITS_SYNTH_TIMEOUT_MS)
        if (!wav || wav.length < 2000) throw new Error('合成结果为空')
        log('SoVITS 完成（' + Math.round((Date.now() - t0) / 1000) + 's，' + Math.round(wav.length / 64000) + 's 音频）')
        const w3 = wavToFileUrl(wav); return { ok: true, url: w3.url, env: w3.env, local: true }
      },
      resolve,
      reject
    })
    drain(svState).catch(() => { })
  })
}

/** 结束 SoVITS 常驻进程 */
function stopSovits () {
  const p = svState.proc
  svState.proc = null
  svState.port = 0
  svState.queue.length = 0
  if (p) {
    try { p.kill() } catch { }
    try {
      if (p.pid) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true })
    } catch { }
  }
}

/** 结束两个本地后端的常驻进程（应用退出时调用） */
function stopServer () {
  stopSovits()
  const p = state.proc
  state.proc = null
  state.port = 0
  state.queue.length = 0
  if (p) {
    try { p.kill() } catch { }
    // Windows 上 python 可能带子进程，兜底 taskkill /T
    try {
      if (p.pid) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true })
    } catch { }
  }
}

module.exports = {
  synthesize,
  synthesizeSovits,
  cancelPending,
  stopServer,
  available,
  sovitsAvailable,
  guessLang,
  splitForIndexTts,
  DEFAULT_DIR,
  DEFAULT_SOVITS_DIR,
  DEFAULT_SOVITS_REF,
  DEFAULT_PROMPT_TEXT,
  STEPS,
  INDEX_TTS_CHUNK_MAX,
  INDEX_TTS_CHUNK_LIMIT,
  /** 测试注入用 */
  _state: state,
  _sovitsState: svState,
  _setPostTts,
  _setEnsureServer
}
