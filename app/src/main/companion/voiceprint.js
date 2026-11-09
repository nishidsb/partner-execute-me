'use strict'
/**
 * 声纹识别（0.48.0）——「这句话是谁在说」。
 *
 * 用户想法（2026-11-09）：「语音识别不能只停留在说话转文字，我要的是能识别音色」。
 * 拍板（同日 AskUserQuestion）：认人（是不是主人），三个口都要接——
 * 语音输入 / QQ 语音消息 / 环境声 hear 通道。本模块是引擎核心，先接语音输入。
 *
 * 引擎：sherpa-onnx-node（npm 预编译二进制，免 python 免 torch）+ 3D-Speaker ERes2Net
 * 中文说话人验证模型（一次性下载到 userData/voiceprint/eres2net.onnx，~40MB）。
 * 嵌入 = 512 维向量；比对 = 与模板各条嵌入的余弦相似度取最大。
 *
 * 阈值（ERes2Net 余弦经验值，待真机标定——对着日志迭代，别拍脑袋改）：
 *   ≥ same(0.72)  → owner  是主人的声音
 *   ≥ maybe(0.55) → maybe  像是主人（不确定）
 *   else          → other  不是主人的声音
 *
 * 隐私红线（与画像三约束同构：只存本机 / 不出网 / 可撤回）：
 * - 模板 = userData/voiceprint/template.json，只有嵌入向量（512 个数字），永不存原声
 * - 音频 PCM 只在内存瞬时用于算嵌入，算完即弃，不落盘不出网
 * - deleteTemplate() 一键撤回；没模板时 verify 诚实返回 ok:false，绝不猜
 *
 * 模型下载：github 直连 → gh 代理 → gh 代理备胎，逐个试（真机网络环境各异）。
 * 下载在主进程 fetch，流式写盘；失败留 reason，上层诚实降级。
 */
const fs = require('fs')
const path = require('path')

const TARGET_SR = 16000
const MIN_SEC = 1.2 // 0.48.8：1.0 → 1.2（0.29~0.53 全 other 的教训：短语音嵌入方差大到同人都能算出 0.4）
const ENROLL_MIN_SEC = 1.5 // 注册样本修剪后最少有效语音
const ENROLL_COHESIVE = 0.45 // 注册样本与已有模板段的最低余弦（自洽闸）
const SAME_DEFAULT = 0.72
const MAYBE_DEFAULT = 0.55
const BLOCK_TTL = 3 * 60 * 1000 // 「刚这句话的声音」注入保质期

const MODEL_URLS = [
  'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
  'https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'
]

let modelPath = ''
let templatePath = ''
let cfg = { on: true, enroll: false, same: SAME_DEFAULT, maybe: MAYBE_DEFAULT }
let extractor = null
let tmpl = null // { dim, embs: [[..]], n, updatedAt }
let lastEvent = null // { label, sim, at, via }
let log = () => { }

function configure (o) {
  if (!o) return
  if (o.modelPath !== undefined) modelPath = String(o.modelPath || '')
  if (o.templatePath !== undefined) templatePath = String(o.templatePath || '')
  if (o.on !== undefined) cfg.on = o.on === true
  if (o.enroll !== undefined) cfg.enroll = o.enroll === true
  if (o.same !== undefined && Number.isFinite(o.same)) cfg.same = o.same
  if (o.maybe !== undefined && Number.isFinite(o.maybe)) cfg.maybe = o.maybe
  if (typeof o.log === 'function') log = o.log
  if (templatePath && tmpl === null) loadTemplate()
}

function status () {
  return {
    on: cfg.on, enroll: cfg.enroll,
    modelReady: !!extractor, modelPath,
    enrolled: !!tmpl, samples: tmpl ? tmpl.n : 0, dim: extractor ? extractor.dim : 0,
    last: lastEvent
  }
}

function resetForTest () {
  modelPath = ''
  templatePath = ''
  cfg = { on: true, enroll: false, same: SAME_DEFAULT, maybe: MAYBE_DEFAULT }
  extractor = null
  tmpl = null
  lastEvent = null
}

/* ---------------- 纯函数（测试直接打这里） ---------------- */

function cosine (a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
  let s = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (na <= 0 || nb <= 0) return 0
  return s / Math.sqrt(na * nb)
}

function judge (sim) {
  if (!Number.isFinite(sim)) return 'other'
  if (sim >= cfg.same) return 'owner'
  if (sim >= cfg.maybe) return 'maybe'
  return 'other'
}

/** 线性插值重采样（声纹嵌入对重采样质量不敏感，线性足够） */
function resampleLinear (samples, from, to) {
  const src = Array.isArray(samples) ? Float32Array.from(samples) : samples
  if (!src || !src.length || !Number.isFinite(from) || !Number.isFinite(to) || from === to) return src
  const n = Math.max(1, Math.floor(src.length * to / from))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * (src.length - 1) / Math.max(1, n - 1)
    const i0 = Math.floor(p)
    const i1 = Math.min(src.length - 1, i0 + 1)
    out[i] = src[i0] + (src[i1] - src[i0]) * (p - i0)
  }
  return out
}

/* ---------------- 模板（只存嵌入向量，永不存原声） ---------------- */

function loadTemplate () {
  try {
    const j = JSON.parse(fs.readFileSync(templatePath, 'utf8'))
    if (j && Array.isArray(j.embs) && j.embs.length && Number.isFinite(j.dim)) {
      tmpl = { dim: j.dim, embs: j.embs, n: j.n || j.embs.length, updatedAt: j.updatedAt || 0 }
      return true
    }
  } catch { }
  tmpl = null
  return false
}

function saveTemplate () {
  try {
    fs.mkdirSync(path.dirname(templatePath), { recursive: true })
    fs.writeFileSync(templatePath, JSON.stringify(tmpl), 'utf8')
    return true
  } catch (e) {
    log('[voiceprint] 模板写盘失败：' + (e && e.message))
    return false
  }
}

function deleteTemplate () {
  tmpl = null
  lastEvent = null
  try { fs.rmSync(templatePath, { force: true }) } catch { }
  log('[voiceprint] 声纹模板已删除（主人撤回）')
}

/* ---------------- 引擎（懒加载 + 模型按需下载） ---------------- */

async function ensureModel (fetchFn) {
  try {
    if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1024 * 1024) return { ok: true }
  } catch { }
  const f = fetchFn || (typeof fetch === 'function' ? fetch : null)
  if (!f) return { ok: false, reason: '环境没有 fetch，无法下载声纹模型' }
  fs.mkdirSync(path.dirname(modelPath), { recursive: true })
  for (const url of MODEL_URLS) {
    try {
      log('[voiceprint] 下载声纹模型：' + url.slice(8, 60) + '…')
      const res = await f(url)
      if (!res.ok) continue
      const ab = await res.arrayBuffer()
      if (ab.byteLength < 1024 * 1024) continue
      const tmp = modelPath + '.part'
      fs.writeFileSync(tmp, Buffer.from(ab))
      fs.renameSync(tmp, modelPath)
      log('[voiceprint] 声纹模型就绪（' + Math.round(ab.byteLength / 1024 / 1024) + 'MB）')
      return { ok: true }
    } catch (e) {
      log('[voiceprint] 下载失败（' + url.slice(8, 40) + '）：' + (e && e.message))
    }
  }
  return { ok: false, reason: '模型下载全部失败（网络不通），声纹暂不可用' }
}

async function ensureEngine (fetchFn) {
  if (extractor) return { ok: true }
  let sherpa = null
  try { sherpa = require('sherpa-onnx-node') } catch (e) {
    return { ok: false, reason: 'sherpa-onnx-node 没装上（' + (e && e.message).slice(0, 60) + '）' }
  }
  const m = await ensureModel(fetchFn)
  if (!m.ok) return m
  try {
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 2, debug: 0, provider: 'cpu' })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: '声纹引擎加载失败：' + (e && e.message).slice(0, 80) }
  }
}

/** 测试注入假引擎 */
function _setExtractor (ext) { extractor = ext }

/** 0.48.8 头尾静音修剪：静音污染嵌入（旧模板三段互相只有 0.43~0.76 的教训之一）。
 * 阈值 = 峰值振幅的 3%（自适应增益，避免低音量说话被整段剪掉）。 */
function trimSilence (samples, rate) {
  const n = samples.length
  if (!n) return { samples, sec: 0, trimmedSec: 0 }
  let peak = 0
  for (let i = 0; i < n; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a }
  if (peak === 0) return { samples: new Float32Array(0), sec: 0, trimmedSec: n / rate } // 纯静音：peak=0 时阈值恒 0，循环剪不动
  const th = peak * 0.03
  let s = 0, e = n - 1
  while (s < n && Math.abs(samples[s]) < th) s++
  while (e > s && Math.abs(samples[e]) < th) e--
  const out = samples.slice(s, e + 1)
  return { samples: out, sec: out.length / rate, trimmedSec: (n - out.length) / rate }
}

function embedFromPcm (samples, sr) {
  if (!samples || !samples.length) return { ok: false, reason: '没有音频' }
  const rate = Number(sr) || TARGET_SR
  const sec = samples.length / rate
  if (sec < MIN_SEC) return { ok: false, reason: '音频太短（' + sec.toFixed(1) + ' 秒 < ' + MIN_SEC + ' 秒）' }
  if (!extractor) return { ok: false, reason: '声纹引擎没就绪' }
  const w0 = rate === TARGET_SR ? samples : resampleLinear(samples, rate, TARGET_SR)
  const tr = trimSilence(w0, TARGET_SR)
  const w = tr.samples
  const validSec = tr.sec
  if (validSec < MIN_SEC) return { ok: false, reason: '有效语音太短（' + validSec.toFixed(1) + ' 秒，静音剪掉 ' + tr.trimmedSec.toFixed(1) + ' 秒）' }
  try {
    const st = extractor.createStream()
    st.acceptWaveform({ sampleRate: TARGET_SR, samples: w })
    st.inputFinished()
    // Electron ≥21 V8 内存笼拒绝 external buffer，必须第二参 false（官方 FAQ 要求）
    const emb = extractor.compute(st, false)
    if (!emb || !emb.length) return { ok: false, reason: '嵌入提取为空' }
    const norm = Math.sqrt(emb.reduce((s, x) => s + x * x, 0))
    // 查询侧响度：和注册样本对口径（注册 norm=29.5/33.0；查询侧异常小=采集音量变了）
    let se = 0
    for (let i = 0; i < w.length; i++) se += w[i] * w[i]
    const rms = Math.sqrt(se / Math.max(1, w.length))
    return { ok: true, emb: Array.from(emb), dim: emb.length, sec, validSec, norm, rms }
  } catch (e) {
    return { ok: false, reason: '嵌入计算失败：' + (e && e.message).slice(0, 80) }
  }
}

/* ---------------- 对外主入口 ---------------- */

/**
 * 验声纹。samples = Float32Array（-1~1）或 Int16Array，sr = 采样率。
 * 返回 { ok:true, speaker:'owner'|'maybe'|'other', sim, via } 或 { ok:false, reason }。
 */
/**
 * 模板质心：各段嵌入逐维平均。0.48.11 实锤需要它——2 秒短句的嵌入噪声大，
 * 三段互相只有 0.52~0.62，max 匹配下主人真声只得 0.66（maybe）；各段对质心
 * 却有 0.82~0.88（噪声互相抵消）。质心作为额外参考项，owner 得分实质抬升，
 * 陌生人不受影响（质心仍是同一张嘴的声音）。
 */
function centroidOf (embs) {
  if (!embs || !embs.length) return null
  const dim = embs[0].length
  const c = new Array(dim).fill(0)
  for (const e of embs) { for (let i = 0; i < dim; i++) c[i] += e[i] / embs.length }
  return c
}

function verifyPcm (samples, sr, via) {
  if (!cfg.on) return { ok: false, reason: '声纹开关没开' }
  lastEvent = null
  const e = embedFromPcm(samples, sr)
  if (!e.ok) return e
  // 注册模式优先：enroll 开着时每段声音都收进模板（攒满 3 段由宿主收闸）
  if (cfg.enroll) return _enrollEmb(e)
  if (!tmpl) {
    return { ok: false, reason: '还没注册声纹模板（config global.companion.voiceprintEnroll: true 后对麦说几句即可注册）', dim: e.dim }
  }
  // 0.48.11 质心参考项：单段匹配 + 质心匹配取最高
  const refs = tmpl.embs.slice()
  if (tmpl.embs.length > 1) refs.push(centroidOf(tmpl.embs))
  let best = -1
  let bestRef = -1
  for (let i = 0; i < refs.length; i++) {
    const c = cosine(e.emb, refs[i])
    if (c > best) { best = c; bestRef = i }
  }
  const refTag = bestRef >= tmpl.embs.length ? '质心' : '段' + (bestRef + 1)
  const label = judge(best)
  lastEvent = { label, sim: best, at: Date.now(), via: via || 'mic' }
  // 0.48.12 查询侧诊断：有效时长/响度/嵌入范数和注册时对口径，判定暴跌时能定位是
  // 采集问题（norm/rms 异常）还是特征问题
  log('[voiceprint] ' + (via || 'mic') + ' → ' + label + '（相似度 ' + best.toFixed(3) + ' 靠' + refTag +
    '，阈值 ' + cfg.same + '/' + cfg.maybe + '；有效 ' + (e.validSec || e.sec).toFixed(1) + 's rms=' +
    (e.rms || 0).toFixed(3) + ' norm=' + (e.norm || 0).toFixed(1) + '）')
  return { ok: true, speaker: label, sim: best, via: via || 'mic' }
}

function _enrollEmb (e) {
  // 0.48.8 注册质量闸：旧模板三段互相 0.43~0.76（「对。」1 秒样本污染），
  // 判定端全是 other。两道闸：①修剪后有效语音 ≥1.5s；②与已有模板段余弦 ≥0.45（自洽）
  if (e.validSec < ENROLL_MIN_SEC) {
    return { ok: false, reason: '注册样本有效语音太短（' + e.validSec.toFixed(1) + ' 秒 < ' + ENROLL_MIN_SEC + ' 秒，请说完整一句话）' }
  }
  if (!tmpl) tmpl = { dim: e.dim, embs: [], n: 0, updatedAt: 0 }
  if (tmpl.embs.length) {
    let best = -1
    for (const ref of tmpl.embs) { const c = cosine(e.emb, ref); if (c > best) best = c }
    if (best < ENROLL_COHESIVE) {
      return { ok: false, reason: '这段声音跟已收样本差异太大（余弦 ' + best.toFixed(2) + ' < ' + ENROLL_COHESIVE + '，请用平常音量再说一句）' }
    }
  }
  tmpl.embs.push(e.emb)
  tmpl.n = tmpl.embs.length
  tmpl.updatedAt = Date.now()
  const done = saveTemplate()
  log('[voiceprint] 注册声纹样本 #' + tmpl.n + '（有效 ' + e.validSec.toFixed(1) + 's norm=' + (e.norm || 0).toFixed(1) + '）' + (done ? '（已落盘）' : '（写盘失败，只在内存）'))
  lastEvent = { label: 'owner', sim: 1, at: Date.now(), via: 'enroll' }
  return { ok: true, speaker: 'owner', sim: 1, enrolled: true, samples: tmpl.n }
}

/** 注入行（chatter decide）：最近 3 分钟内验过 → 一句话；否则空串不浪费预算 */
function block () {
  if (!lastEvent) return ''
  if (Date.now() - lastEvent.at > BLOCK_TTL) return ''
  const v = lastEvent
  const who = v.via === 'enroll' ? ''
    : v.label === 'owner' ? '刚说话的声音就是他（声纹匹配主人，相似度 ' + v.sim.toFixed(2) + '）'
      : v.label === 'maybe' ? '刚说话的声音有点像他，但不确定（相似度 ' + v.sim.toFixed(2) + '，别把话说死）'
        : '刚说话的声音不是他（声纹不匹配，相似度只有 ' + v.sim.toFixed(2) + '——可能是别人/视频里的人声，别当成他在跟你说话）'
  return who
}

/**
 * base64(16bit PCM) → Float32Array(-1~1)。
 * 0.48.3 单测固化：不能用 Int16Array.from(buf.buffer)——ArrayBuffer 没有 .length，
 * from() 会产出长度 0 的空数组（15:57 真机「跳过：没有音频」的根因）；要用 byteOffset/length 切视图。
 */
function pcmFromB64 (b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64')
  if (buf.length < 2) return new Float32Array(0)
  const i16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
  return Float32Array.from(i16, (v) => v / 32768)
}

module.exports = {
  configure, status, resetForTest, ensureEngine,
  cosine, judge, resampleLinear, trimSilence, centroidOf,
  embedFromPcm, verifyPcm, pcmFromB64, deleteTemplate, block,
  _setExtractor,
  TARGET_SR, MIN_SEC, SAME_DEFAULT, MAYBE_DEFAULT
}
