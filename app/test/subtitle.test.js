'use strict'
/**
 * 字幕判定单测（0.18.0）
 * 用户报：「ねえ、GPUが98%も動いてるよ…」这句气泡里没有翻译。
 * 根因是主动台词（看屏陪伴/时间观念/闹钟）压根没走字幕链路，不是翻译失败。
 */
const test = require('node:test')
const assert = require('node:assert')
const { subtitleTarget, langMismatch, LANG_NAME } = require('../src/main/companion/subtitle')

const JA_LINE = 'ねえ、GPUが98%も動いてるよ。動画を見てるだけなのに、ちょっと熱くなりすぎじゃない？'

test('日语台词 + 字幕中文 → 要翻成中文（用户报的那句）', () => {
  assert.equal(subtitleTarget(JA_LINE, 'zh'), '中文')
})

test('台词本来就是字幕语言 → 不翻（省一次调用）', () => {
  assert.equal(subtitleTarget('主人，GPU 都 98% 了', 'zh'), '')
  assert.equal(subtitleTarget(JA_LINE, 'ja'), '')
  assert.equal(subtitleTarget('Time to rest, Master', 'en'), '')
})

test('不看 replyLang：时间观念台词固定日语，也照翻（回复语言=中文时同样生效）', () => {
  // 时间观念/闹钟台词写死日语（TTS 音色原因），与 replyLang 无关 → 必须按实际语种判断
  assert.equal(subtitleTarget('もうこんな時間……おやすみ、また明日ね。', 'zh'), '中文')
  assert.equal(subtitleTarget('もうこんな時間……おやすみ、また明日ね。', 'ja'), '')
})

test('字幕关闭 / 空台词 → 不翻', () => {
  assert.equal(subtitleTarget(JA_LINE, 'off'), '')
  assert.equal(subtitleTarget(JA_LINE, ''), '')
  assert.equal(subtitleTarget('   ', 'zh'), '')
  assert.equal(subtitleTarget(null, 'zh'), '')
})

test('中→日 / 中→英 也走同一条判断', () => {
  assert.equal(subtitleTarget('主人，该休息了', 'ja'), '日文')
  assert.equal(subtitleTarget('主人，该休息了', 'en'), '英文')
  assert.equal(subtitleTarget('Time to rest, Master', 'zh'), '中文')
})

test('日文汉字为主的句子（无假名）按中文算 → 字幕 zh 时不翻', () => {
  assert.equal(langMismatch('休憩時間', 'ja'), true)
  assert.equal(subtitleTarget('休憩時間', 'zh'), '')
})

test('LANG_NAME 只有三种语言（主人 2026-10-26：只要中英日）', () => {
  assert.deepEqual(Object.keys(LANG_NAME).sort(), ['en', 'ja', 'zh'])
})
