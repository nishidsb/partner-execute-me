/**
 * 本地转写（S9-M3，参考 dsh-bili-scroll 的 asr 思路，重写）：
 * faster-whisper 独立 venv + yt-dlp 下音频 + hf-mirror 下模型。
 *
 * 设计取舍：
 * - venv 建在 <home>/.venv（bili-duty 家目录），不碰系统 Python；
 * - ⚠️ ctranslate2/faster-whisper 没有 3.14 的 wheel（参考仓实测）⇒ 找 python 时只收 3.10–3.13；
 * - 「建环境」起完立刻返回（安装要几分钟），进度看 <home>/asr-install.log；
 * - 音频不转码（没有 ffmpeg）：yt-dlp 直接拉 bestaudio（m4a/webm），faster-whisper 内置 PyAV 能解；
 * - 模型经 HF_ENDPOINT=https://hf-mirror.com 下载（国内网络）；
 * - asr.py 从 asar 里拷到家目录再执行（asar 内文件不能直接 spawn）。
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const HF_MIRROR = 'https://hf-mirror.com'
const PIP_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple'
const MODELS = ['tiny', 'base', 'small', 'medium']

const venvPythonOf = (home) => process.platform === 'win32'
  ? path.join(home, '.venv', 'Scripts', 'python.exe')
  : path.join(home, '.venv', 'bin', 'python')
const ytDlpOf = (home) => process.platform === 'win32'
  ? path.join(home, '.venv', 'Scripts', 'yt-dlp.exe')
  : path.join(home, '.venv', 'bin', 'yt-dlp')
const sitePkgsOf = (home) => process.platform === 'win32'
  ? path.join(home, '.venv', 'Lib', 'site-packages')
  : path.join(home, '.venv', 'lib')

const run = (cmd, args, { timeout = 15000, env } = {}) => new Promise((resolve) => {
  let out = ''
  let done = false
  const finish = (r) => { if (!done) { done = true; resolve(r) } }
  try {
    const p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, ...(env || {}) } })
    p.stdout.on('data', (c) => { out += c })
    p.stderr.on('data', (c) => { out += c })
    p.on('error', (e) => finish({ code: -1, out: out + String(e.message) }))
    p.on('close', (code) => finish({ code, out }))
    setTimeout(() => { try { p.kill() } catch { } finish({ code: -2, out: out + '\n[timeout]' }) }, timeout)
  } catch (e) { finish({ code: -1, out: String(e && e.message ? e.message : e) }) }
})

const parsePyVer = (out) => {
  const m = /Python\s+(\d+)\.(\d+)/.exec(String(out || ''))
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}

/**
 * 找一个能装 faster-whisper 的 python（3.10–3.13）。
 * 依次试 cfg.pythonPath / python / python3 / py -3.13 …（py launcher 逐版本探测）。
 */
async function findPython (pythonPath = '', log = () => { }) {
  const candidates = []
  const pp = String(pythonPath || '').trim()
  if (pp) candidates.push({ cmd: pp, args: [] })
  for (const c of ['python', 'python3']) candidates.push({ cmd: c, args: [] })
  for (const minor of [13, 12, 11, 10]) candidates.push({ cmd: 'py', args: ['-3.' + minor] })
  for (const c of candidates) {
    const r = await run(c.cmd, [...c.args, '--version'], { timeout: 8000 })
    const v = parsePyVer(r.out)
    const ok = v && v.major === 3 && v.minor >= 10 && v.minor <= 13
    log(`探测 ${c.cmd} ${c.args.join(' ')} → ${v ? v.major + '.' + v.minor : (r.out || '').trim().slice(0, 60)}${ok ? ' ✓' : '（不要）'}`)
    if (ok) return { ...c, version: `${v.major}.${v.minor}` }
  }
  return null
}

/** 环境状态：venv 在不在、依赖装没装（看 site-packages 目录，比 pip show 快得多） */
function asrStatus (home) {
  const py = venvPythonOf(home)
  const venvReady = fs.existsSync(py)
  const sp = sitePkgsOf(home)
  const depsReady = venvReady && fs.existsSync(path.join(sp, 'faster_whisper'))
  const ytDlpReady = venvReady && fs.existsSync(ytDlpOf(home))
  const installing = fs.existsSync(path.join(home, 'asr-installing'))
  return { venvReady, depsReady, ytDlpReady, installing, venvPython: py, logFile: path.join(home, 'asr-install.log') }
}

const appendLog = (file, s) => { try { fs.appendFileSync(file, s, 'utf8') } catch { } }

/**
 * 建环境（异步起跑，立刻返回）：找 python → venv → pip install faster-whisper yt-dlp。
 * 进度/结果全部写 <home>/asr-install.log；装完删 asr-installing 标记。
 */
function asrSetup (home, { pythonPath = '', log = () => { } } = {}) {
  const logFile = path.join(home, 'asr-install.log')
  const marker = path.join(home, 'asr-installing')
  if (fs.existsSync(marker)) return { ok: true, already: true, logFile }
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(marker, String(Date.now()), 'utf8')
  } catch (e) { return { ok: false, error: e.message } }
  appendLog(logFile, `\n${new Date().toISOString()}  ===== 开始建本地转写环境 =====\n`)
  ;(async () => {
    try {
      const py = await findPython(pythonPath, (s) => appendLog(logFile, s + '\n'))
      if (!py) throw new Error('没找到 3.10–3.13 的 Python（faster-whisper 在 3.14 上没有 wheel）。装一个 Python 3.13 后再点。')
      appendLog(logFile, `用 ${py.cmd} ${py.args.join(' ')}（Python ${py.version}）\n`)
      await new Promise((resolve) => {
        const p = spawn(py.cmd, [...py.args, '-m', 'venv', path.join(home, '.venv')], { windowsHide: true })
        p.stdout.on('data', (c) => appendLog(logFile, c))
        p.stderr.on('data', (c) => appendLog(logFile, c))
        p.on('error', (e) => { appendLog(logFile, 'venv 创建失败：' + e.message + '\n'); resolve() })
        p.on('close', (code) => { appendLog(logFile, `venv 创建 ${code === 0 ? '完成' : '失败 code=' + code}\n`); resolve() })
      })
      if (!fs.existsSync(venvPythonOf(home))) throw new Error('venv 没建起来（看上面日志）')
      const r = await run(venvPythonOf(home), ['-m', 'pip', 'install', '--upgrade', 'pip', '-i', PIP_MIRROR], { timeout: 300000 })
      appendLog(logFile, r.out + '\n')
      const inst = await run(venvPythonOf(home),
        ['-m', 'pip', 'install', 'faster-whisper', 'yt-dlp', '-i', PIP_MIRROR],
        { timeout: 900000, env: { HF_ENDPOINT: HF_MIRROR, HF_HUB_DISABLE_XET: '1' } })
      appendLog(logFile, inst.out + '\n')
      const st = asrStatus(home)
      if (!st.depsReady || !st.ytDlpReady) throw new Error('依赖没装全（faster_whisper=' + st.depsReady + ' yt-dlp=' + st.ytDlpReady + '），看上面日志找报错')
      appendLog(logFile, '✓ 本地转写环境就绪\n')
      log('[bili] 本地转写环境就绪')
    } catch (e) {
      appendLog(logFile, `✗ 建环境失败：${e && e.message ? e.message : e}\n`)
      log('[bili] 本地转写建环境失败：' + (e && e.message ? e.message : e))
    } finally {
      try { fs.rmSync(marker, { force: true }) } catch { }
    }
  })()
  return { ok: true, logFile }
}

/**
 * 转写一个视频：yt-dlp 下 bestaudio → asr.py（faster-whisper）→ 文本。
 * asr.py 打包后躺在 asar 里 ⇒ 先拷到家目录再跑。
 * 返回 { ok, text, durationSec } 或 { ok:false, error }（错误给人看，也让模型能读懂原因）。
 */
async function transcribeBvid (home, bvid, cred, { model = 'small', log = () => { } } = {}) {
  const st = asrStatus(home)
  if (st.installing) return { ok: false, error: '本地转写环境正在安装（看 ' + st.logFile + '），装好再用' }
  if (!st.depsReady || !st.ytDlpReady) {
    return { ok: false, error: '本地转写环境还没装好：设置页「刷B站」里点「建本地转写环境」' }
  }
  const asrDir = path.join(home, 'asr')
  fs.mkdirSync(asrDir, { recursive: true })
  const audio = path.join(asrDir, `${bvid}.audio`)
  const script = path.join(home, 'asr.py')
  try {
    // asar 里拷出来（dev 模式下 resources/bili/asr.py 直接存在也能拷）
    const bundled = path.join(__dirname, '..', '..', '..', 'resources', 'bili', 'asr.py')
    const src = fs.readFileSync(bundled, 'utf8')
    let cur = ''
    try { cur = fs.readFileSync(script, 'utf8') } catch { }
    if (cur !== src) fs.writeFileSync(script, src, 'utf8')

    log(`[asr] ${bvid} 下音频（${model}）`)
    const dl = await run(ytDlpOf(home), [
      '-f', 'bestaudio', '-o', audio, '--no-playlist', '--quiet', '--noprogress',
      '--add-headers', `Cookie: SESSDATA=${cred?.sessdata || ''}; buvid3=${cred?.buvid3 || ''}`,
      '--add-headers', `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36`,
      '--add-headers', 'Referer: https://www.bilibili.com/',
      `https://www.bilibili.com/video/${bvid}`
    ], { timeout: 600000 })
    const dlOk = fs.existsSync(audio) && fs.statSync(audio).size > 10000
    if (!dlOk) {
      const tail = String(dl.out || '').trim().split('\n').slice(-3).join(' ').slice(0, 300)
      return { ok: false, error: '音频没下下来（可能要登录/会员/地区限制）' + (tail ? '：' + tail : '') }
    }
    log(`[asr] ${bvid} 音频 ${(fs.statSync(audio).size / 1048576).toFixed(1)}MB，开始转写`)
    const r = await run(venvPythonOf(home), [script, audio, String(model)], {
      timeout: 15 * 60_000,
      env: { HF_ENDPOINT: HF_MIRROR }
    })
    const lines = String(r.out || '').trim().split('\n').filter(Boolean)
    const last = lines[lines.length - 1] || ''
    let parsed = null
    try { parsed = JSON.parse(last) } catch { }
    if (!parsed || parsed.ok !== true) {
      return { ok: false, error: '转写失败：' + (parsed && parsed.error ? parsed.error : (r.out || r.code).toString().slice(-300)) }
    }
    log(`[asr] ${bvid} 转写完成 ${parsed.durationSec ?? '?'}s`)
    return { ok: true, text: String(parsed.text || ''), durationSec: parsed.durationSec || 0, via: 'asr', model }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  } finally {
    try { fs.rmSync(audio, { force: true }) } catch { }
  }
}

/**
 * 转写一个本地音频文件（2.1 语音输入复用：麦克风录音直接喂 faster-whisper）。
 * 返回 { ok, text, durationSec } 或 { ok:false, error }。
 */
async function transcribeAudioFile (home, filePath, { model = 'small', language = 'auto', log = () => { } } = {}) {
  const st = asrStatus(home)
  if (st.installing) return { ok: false, error: '本地转写环境正在安装，装好再用' }
  if (!st.depsReady) return { ok: false, error: '本地转写环境还没装好：设置页「刷B站」里点「建本地转写环境」' }
  const script = path.join(home, 'asr.py')
  try {
    const bundled = path.join(__dirname, '..', '..', '..', 'resources', 'bili', 'asr.py')
    const src = fs.readFileSync(bundled, 'utf8')
    let cur = ''
    try { cur = fs.readFileSync(script, 'utf8') } catch { }
    if (cur !== src) fs.writeFileSync(script, src, 'utf8')
    log(`[asr] 本地转写 ${path.basename(filePath)}（${model}）`)
    // 第三个参数 = 语言（auto/zh/ja/en…）：不传就只能靠自动检测，中文短句常被误判成英语
    // HF_HUB_DISABLE_XET：新版 huggingface_hub 走 Xet 协议，国内镜像 401 → 换模型就下不动
    const r = await run(venvPythonOf(home), [script, filePath, String(model), String(language || 'auto')], {
      timeout: 120000,
      env: { HF_ENDPOINT: HF_MIRROR, HF_HUB_DISABLE_XET: '1' }
    })
    const lines = String(r.out || '').trim().split('\n').filter(Boolean)
    const last = lines[lines.length - 1] || ''
    let parsed = null
    try { parsed = JSON.parse(last) } catch { }
    if (!parsed || parsed.ok !== true) {
      return { ok: false, error: '转写失败：' + (parsed && parsed.error ? parsed.error : (r.out || r.code).toString().slice(-300)) }
    }
    return { ok: true, text: String(parsed.text || ''), durationSec: parsed.durationSec || 0 }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

module.exports = { MODELS, findPython, asrStatus, asrSetup, transcribeBvid, transcribeAudioFile, venvPythonOf, ytDlpOf, parsePyVer }
