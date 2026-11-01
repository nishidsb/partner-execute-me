'use strict'
/**
 * 「像不像话」过滤（0.38.0）
 * 目标只有一个：静音时识别出来的碎片别进对话。反过来也要保住真话——
 * 「不去。」「嗯嗯。」这种虽然短，但确实是话，不能拦。
 */
const test = require('node:test')
const assert = require('node:assert')
const { looksLikeSpeech, core } = require('../src/renderer/shared/speech-filter')

test('正常中文句子放行', () => {
  for (const s of ['帮我看下这个报错', '不去。', '嗯嗯。', '我回来了', '这是什么情况？']) {
    assert.strictEqual(looksLikeSpeech(s).ok, true, '应该放行：' + s)
  }
})

test('正常英文放行', () => {
  for (const s of ['hello there', 'ok', 'what is this']) {
    assert.strictEqual(looksLikeSpeech(s).ok, true, '应该放行：' + s)
  }
})

test('单个语气词/单字母碎片拦掉（静音时最爱冒的）', () => {
  for (const s of ['嗯。', '啊', '呃。', '그.', 'えー', 'a.']) {
    assert.strictEqual(looksLikeSpeech(s).ok, false, '应该拦掉：' + s)
  }
})

test('纯标点 / 纯符号不算话', () => {
  for (const s of ['。', '……', '！？', '。。。']) {
    assert.strictEqual(looksLikeSpeech(s).ok, false, '应该拦掉：' + s)
  }
})

test('空串 / 纯空格不算话', () => {
  assert.strictEqual(looksLikeSpeech('').ok, false)
  assert.strictEqual(looksLikeSpeech('   ').ok, false)
  assert.strictEqual(looksLikeSpeech(null).ok, false)
})

test('符号比字还多的乱识别不算话', () => {
  assert.strictEqual(looksLikeSpeech('※★☆○●◇◆').ok, false)
  assert.strictEqual(looksLikeSpeech('。。。好。。。').ok, false)
})

test('同一个字卡带 5 次以上拦掉（识别卡住）', () => {
  assert.strictEqual(looksLikeSpeech('啊啊啊啊啊').ok, false)
  // 三连笑是正常表达
  assert.strictEqual(looksLikeSpeech('哈哈哈').ok, true)
})

test('返回值带原文本（调用方直接用，不用自己 trim）', () => {
  const r = looksLikeSpeech('  我回来了  ')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.text, '我回来了')
})

test('core 只留实字', () => {
  assert.strictEqual(core('好，的。（笑）'), '好的笑')
})
