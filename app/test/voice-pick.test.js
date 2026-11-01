/** 0.18.0 M2 修正：TTS 音色跟角色卡走，不共用（主人 2026-10-25 指出） */
const test = require('node:test')
const assert = require('node:assert')
const { cardVoiceParams, UUID_RE, HEX32_RE, isFishVoiceId } = require('../src/main/companion/voice-pick')

test('卡上音色优先，全局 ttsVoice 只兜底（旧实现顺序反了）', () => {
  const c = { ttsVoice: 'global-voice', fishVoiceId: 'fish-global' }
  // 卡有音色 → 卡赢
  const r1 = cardVoiceParams(c, { voice: { apiVoice: 'card-voice' } })
  assert.equal(r1.voice, 'card-voice')
  // 卡没配音色 → 全局兜底
  const r2 = cardVoiceParams(c, { voice: {} })
  assert.equal(r2.voice, 'global-voice')
  const r3 = cardVoiceParams(c, null)
  assert.equal(r3.voice, 'global-voice')
  // 双双没有 → alloy
  const r4 = cardVoiceParams({}, null)
  assert.equal(r4.voice, 'alloy')
})

test('Fish：卡上写 UUID 音色 id → 映射为 fishVoiceId；openai 语音名不映射', () => {
  const fid = '12345678-90ab-4cde-8f01-234567890abc'
  assert.ok(UUID_RE.test(fid))
  const c = { ttsProvider: 'fish', fishVoiceId: 'fish-global' }
  // 卡上是 UUID → 用卡的
  const r1 = cardVoiceParams(c, { voice: { apiVoice: fid } })
  assert.equal(r1.voiceId, fid)
  // 卡上是 openai 名字（alloy）→ fishVoiceId 仍走全局
  const r2 = cardVoiceParams(c, { voice: { apiVoice: 'alloy' } })
  assert.equal(r2.voiceId, 'fish-global')
  // 非 fish 供应商 → 不映射
  const r3 = cardVoiceParams({ ttsProvider: 'openai', fishVoiceId: 'fish-global' }, { voice: { apiVoice: fid } })
  assert.equal(r3.voiceId, 'fish-global')
  // 没配 fishVoiceId 且卡是普通名 → undefined（tts 层自己处理）
  const r4 = cardVoiceParams({ ttsProvider: 'fish' }, { voice: { apiVoice: 'alloy' } })
  assert.equal(r4.voiceId, undefined)
})

test('Fish：32 位无横线音色 ID 也认（真机抓雷：主人卡上就是无横线形态，旧正则漏判=永远回退全局）', () => {
  // 主人真机数据原样：古·拉哈·提亚卡的 Fish 音色（无横线）
  const nodash = '1cdd4184139f4ecba15f2a5c961b5513'
  assert.ok(HEX32_RE.test(nodash))
  assert.ok(isFishVoiceId(nodash))
  assert.ok(isFishVoiceId('1cdd4184-139f-4ecb-a15f-2a5c961b5513'), '带横线同样认')
  assert.ok(!isFishVoiceId('nova'), 'openai 音色名不算')
  assert.ok(!isFishVoiceId(''), '空串不算')
  const c = { ttsProvider: 'fish', fishVoiceId: '57c45a3aa7b34a62af8eb27137f092c8' }
  // 卡上无横线 ID → 用卡的（修前这里会错回退全局）
  const r1 = cardVoiceParams(c, { voice: { apiVoice: nodash } })
  assert.equal(r1.voiceId, nodash)
  // 卡没配 → 全局兜底
  const r2 = cardVoiceParams(c, { voice: { apiVoice: 'alloy' } })
  assert.equal(r2.voiceId, '57c45a3aa7b34a62af8eb27137f092c8')
})
