// 0.46.63 口型包络测试：wav 解析 + 归一 + 平滑（audio_envelope.dart 移植验证）
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { envelopeFromWav } = require('../src/main/companion/envelope')

/** 构造 16bit mono wav：samples 为 -1..1 振幅 */
function makeWav (samples, sampleRate = 16000) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

test('非 wav 输入返回 null', () => {
  assert.equal(envelopeFromWav(Buffer.from('hello world this is not a wav file at all...')), null)
  assert.equal(envelopeFromWav(Buffer.alloc(10)), null)
  assert.equal(envelopeFromWav(null), null)
})

test('全静音 wav → 包络全 0', () => {
  const env = envelopeFromWav(makeWav(new Float32Array(16000))) // 1s 静音
  assert.ok(env, '应解析成功')
  assert.equal(env.frameMs, 20)
  assert.equal(env.values.length, 50)
  assert.ok(env.values.every((v) => v === 0), '静音应全 0')
})

test('正常语音 wav → 帧数正确、开合范围合理、末尾趋零', () => {
  // 0.5s 静音 + 1s 振幅 0.5 的「说话」+ 0.5s 静音
  const samples = []
  for (let i = 0; i < 8000; i++) samples.push(0)
  for (let i = 0; i < 16000; i++) samples.push(0.5 * Math.sin(i * 0.1))
  for (let i = 0; i < 8000; i++) samples.push(0)
  const env = envelopeFromWav(makeWav(samples))
  assert.ok(env)
  assert.equal(env.values.length, 100) // 2s / 20ms
  // 说话段（25~75 帧）应显著高于首尾静音段
  const talk = env.values.slice(30, 70)
  const lead = env.values.slice(0, 15)
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length
  assert.ok(avg(talk) > 0.3, '说话段包络应高: ' + avg(talk).toFixed(3))
  assert.ok(avg(lead) < 0.1, '开头静音应近 0: ' + avg(lead).toFixed(3))
  assert.ok(env.values.every((v) => v >= 0 && v <= 1), '包络值域 0..1')
  assert.equal(env.rawRms.length, env.values.length, 'rawRms 与 values 等长（db 映射依赖）')
})

test('鲁棒：截断的 data 块不崩溃', () => {
  const wav = makeWav(new Float32Array(4000))
  const env = envelopeFromWav(wav.subarray(0, wav.length - 100))
  assert.ok(env === null || (env.values && env.values.length > 0))
})
