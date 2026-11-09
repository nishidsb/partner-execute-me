'use strict'
/* 0.49.2 背景响度闸：21:02~21:03 真机实锤——Whisper 对着 rms 0.004~0.025 的环境噪音
 * 幻觉出「中文字幕组」「我没有声音，多少次」等字，五连进对话、她回了五句（主人：
 * 「我没有说过这些话」）。修法：主进程在 ASR 之前算分段响度（100ms 帧 p90），
 * 低于 0.045 直接返回 quiet，不进 ASR 不进对话；渲染层接住 quiet 留痕静默。
 * 主人真声 0.077~0.19（3 倍以上间距），注册模式豁免。 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')

test('主进程：ASR 之前有背景响度闸（p90 < 0.045 返回 quiet，不进 ASR）', () => {
  const src = R('../src/main/companion/index.js')
  assert.ok(src.includes('speakLevel'), '有分段响度计算函数')
  assert.ok(src.includes('lvl < 0.045'), '闸阈值 0.045（与 pet.js startVad 说话判定同标准）')
  assert.ok(src.includes("quiet: true"), '安静段返回 quiet 标记')
  assert.ok(src.includes('不进 ASR 不进对话'), '闸命中留痕')
  // 闸必须放在 transcribeBase 之前（省掉幻觉段占用的 whisper 队列）
  const gateAt = src.indexOf("quiet: true")
  const asrAt = src.indexOf('await transcribeBase(base64, mime)')
  assert.ok(gateAt > 0 && asrAt > gateAt, '响度闸在 ASR 之前（防队列被幻觉段堵死）')
  // 注册模式豁免：收样本永远不拦
  assert.ok(src.includes('voiceprintEnroll !== true'), '注册模式豁免（收样本不被闸拦截）')
})

test('主进程：p90 口径——取最响的第 90 百分位帧，不受停顿拉低', () => {
  const src = R('../src/main/companion/index.js')
  assert.ok(src.includes('Math.floor(lv.length * 0.9)'), 'p90 取帧：说话断续，均值会被停顿拉低')
  assert.ok(src.includes('const frame = 1600'), '100ms 帧 @16k')
})

test('渲染层：接住 quiet 返回——静默留痕，不冒泡不进对话', () => {
  const src = R('../src/renderer/overlay/pet.js')
  assert.ok(src.includes('r.quiet'), 'flushRecording 有 quiet 分支')
  assert.ok(src.includes('背景响度，不进对话'), 'quiet 留痕')
  const quietAt = src.indexOf('r.quiet')
  const voiceSendAt = src.indexOf('petChatSend(verdict.text || r.text, true)')
  assert.ok(quietAt > 0 && voiceSendAt > quietAt, 'quiet 分支在语音消息发起对话之前（安静段根本不发起对话）')
})

/* 单元：p90 逻辑的行为复刻（与 index.js speakLevel 同实现），验证判别力 */
function speakLevel (f32) {
  const n = f32.length
  const frame = 1600
  const lv = []
  for (let i = 0; i + frame <= n; i += frame) {
    let s = 0
    for (let j = i; j < i + frame; j++) s += f32[j] * f32[j]
    lv.push(Math.sqrt(s / frame))
  }
  if (!lv.length) return n ? Math.abs(f32[0]) : 0
  lv.sort((a, b) => a - b)
  return lv[Math.min(lv.length - 1, Math.floor(lv.length * 0.9))]
}

test('p90 行为：噪音段（真机 21:02 口径）被拦，真声段（主人 20:45 口径）放行', () => {
  const sr = 16000
  const noise = new Float32Array(2 * sr) // 2 秒环境噪音：p90 rms≈0.013（真机 rms=0.013）
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.018
  assert.ok(speakLevel(noise) < 0.045, '噪音 p90=' + speakLevel(noise).toFixed(3) + ' < 0.045 → 拦')
  const speech = new Float32Array(2 * sr) // 2 秒说话：响帧 0.12、停顿帧 0.01（断续真人）
  for (let f = 0; f < 20; f++) {
    const loud = f % 2 === 0 // 一半帧响一半帧静：模拟断续说话
    for (let i = f * 1600; i < (f + 1) * 1600; i++) speech[i] = (Math.random() * 2 - 1) * (loud ? 0.12 : 0.01)
  }
  assert.ok(speakLevel(speech) >= 0.045, '真声 p90=' + speakLevel(speech).toFixed(3) + ' ≥ 0.045 → 放行（均值口径会被停顿拉低，p90 不会）')
})

/* 0.49.4 聋流看门狗：21:44~22:51 实锤——重启后自动开麦（无用户手势）→
 * Chromium 自动播放策略把 AudioContext 挂起 → analyser 恒读 128 → rms 恒 0，
 * VAD 永不触发且零日志（静默失败一小时）。修=开麦 resume+state 留痕 + tick 内
 * 连续全零看门狗（恢复+reportError）。0.48.9 只给 hearCtx 加过——链路×2 又犯。 */
test('0.49.4 vp 音频上下文：suspended 必 resume 并留痕（state 日志）', () => {
  const src = R('../src/renderer/overlay/pet.js')
  assert.ok(src.includes("petDiagOnce('vp-ctx-resume'"), '挂起时 resume 并留痕')
  assert.ok(src.includes("petDiagOnce('vp-ctx-state'"), '上下文 state 无条件留痕')
  const createAt = src.indexOf('audioCtx = new AudioContext()')
  const resumeAt = src.indexOf("petDiagOnce('vp-ctx-resume'")
  assert.ok(createAt > 0 && resumeAt > createAt, 'resume 在创建之后')
})

test('0.49.4 startVad 聋流看门狗：连续全零→恢复+reportError，有声归零', () => {
  const src = R('../src/renderer/overlay/pet.js')
  assert.ok(src.includes('vadZeroRun'), '全零计数')
  assert.ok(src.includes('vadZeroRun >= 84'), '连续 ~10s（120ms×84）触发')
  assert.ok(src.includes("reportError('vp-deaf'"), '聋流留痕（主进程 main.log 可见）')
  assert.ok(src.includes('vadZeroRun = 0'), '有声即归零')
  const watchdogAt = src.indexOf('vadZeroRun >= 84')
  const hearTickAt = src.indexOf('hearTick(rms)')
  assert.ok(watchdogAt > 0 && hearTickAt > watchdogAt, '看门狗与 hearTick 同 tick（感知同源同护）')
})
