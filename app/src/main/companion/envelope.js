// 0.46.63 说话口型包络：从 TTS wav 提取 20ms 帧振幅。
// 算法忠实移植参考项目 AgentAtelierR 的 audio_envelope.dart（tryParseWav + fromRms）：
// 95 分位=peak、12 分位=noise（再与 peak*0.15 取小）、归一后 ^0.72 幂、
// attack 0.85 / release 0.65 单极平滑、近零静音清零。
// 渲染层按播放位置采样它来 scrub 嘴型动画（character_lipsync.dart 同款）。
'use strict'
const LOG_PREFIX = '[lipsync-env]'

/** 解析 wav → { frameMs, values, rawRms }；非 wav/解析失败返回 null */
function envelopeFromWav (buf) {
  try {
    if (!buf || buf.length < 44) return null
    if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null
    // 遍历 RIFF chunk 找 fmt / data
    let format = null; let channels = null; let sampleRate = null; let bits = null
    let dataOffset = -1; let dataLength = 0
    let offset = 12
    while (offset + 8 <= buf.length) {
      const id = buf.toString('latin1', offset, offset + 4)
      const len = buf.readUInt32LE(offset + 4)
      const start = offset + 8
      const end = Math.min(start + len, buf.length)
      if (id === 'fmt ' && end - start >= 16) {
        format = buf.readUInt16LE(start)
        channels = buf.readUInt16LE(start + 2)
        sampleRate = buf.readUInt32LE(start + 4)
        bits = buf.readUInt16LE(start + 14)
      } else if (id === 'data') {
        dataOffset = start
        dataLength = end - start
      }
      offset = start + len + (len % 2)
    }
    if (!format || !channels || channels <= 0 || !sampleRate || sampleRate <= 0 ||
      bits == null || dataOffset < 0 || dataLength <= 0 || (format !== 1 && format !== 3)) return null
    const bytesPerSample = Math.ceil(bits / 8)
    if (bytesPerSample <= 0 || bytesPerSample > 4) return null
    const bytesPerFrame = bytesPerSample * channels
    const sampleFrames = Math.floor(dataLength / bytesPerFrame)
    const frameMs = 20
    const samplesPerEnvFrame = Math.max(1, Math.round(sampleRate * frameMs / 1000))
    // 逐帧 RMS
    const raw = []
    for (let f = 0; f < sampleFrames; f += samplesPerEnvFrame) {
      const fEnd = Math.min(f + samplesPerEnvFrame, sampleFrames)
      let sumSq = 0; let count = 0
      for (let i = f; i < fEnd; i++) {
        const base = dataOffset + i * bytesPerFrame
        for (let ch = 0; ch < channels; ch++) {
          const s = readSample(buf, base + ch * bytesPerSample, format, bits)
          if (s == null) return null
          sumSq += s * s
          count++
        }
      }
      raw.push(count ? Math.sqrt(sumSq / count) : 0)
    }
    if (!raw.length) return null
    // 归一（fromRms 同款）
    const sorted = [...raw].sort((a, b) => a - b)
    const peak = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    const noise = Math.min(peak * 0.15, sorted[Math.floor(sorted.length * 0.12)])
    const range = Math.max(peak - noise, 0.000001)
    const norm = raw.map((v) => Math.pow(Math.min(1, Math.max(0, (v - noise) / range)), 0.72))
    // 快攻慢放平滑
    let sm = 0
    const values = norm.map((v) => {
      sm += (v - sm) * (v > sm ? 0.85 : 0.65)
      if (v < 0.02 && sm < 0.08) sm = 0
      return Math.min(1, Math.max(0, sm))
    })
    // 边车体积控制：保留 4 位小数足够口型用
    const r4 = (arr) => arr.map((v) => Math.round(v * 10000) / 10000)
    return { frameMs, values: r4(values), rawRms: r4(raw) }
  } catch (e) {
    console.warn(LOG_PREFIX, '解析失败:', e.message)
    return null
  }
}

function readSample (buf, off, format, bits) {
  if (off + Math.ceil(bits / 8) > buf.length) return null
  if (format === 3 && bits === 32) return Math.max(-1, Math.min(1, buf.readFloatLE(off)))
  if (format !== 1) return null
  switch (bits) {
    case 8: return (buf.readUInt8(off) - 128) / 128
    case 16: return buf.readInt16LE(off) / 32768
    case 24: {
      let v = buf.readUInt8(off) | (buf.readUInt8(off + 1) << 8) | (buf.readUInt8(off + 2) << 16)
      if (v & 0x800000) v |= ~0xffffff // 符号扩展
      return v / 8388608
    }
    case 32: return buf.readInt32LE(off) / 2147483648
    default: return null
  }
}

module.exports = { envelopeFromWav }
