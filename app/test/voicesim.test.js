'use strict'
/**
 * 台词相似度（0.45.85）：同一刺激物的 LLM 变体必须被拦下，无关句必须放行。
 * 用例全部取自 2026-11-01 真机日志（用户实锤：同一行屏幕残留文字被嘀咕 6 遍）。
 */
const test = require('node:test')
const assert = require('node:assert')
const { tokenize, similarity, overlapCoef, isRepeat } = require('../src/main/companion/voicesim')

/** 真机时间线：19:24 watch 说了第 1 句，之后 chatter 每 5~15 分钟换着花样再来一遍 */
const TRACKID_SERIES = [
  '画面还开着好多呢。睡前只关一个，明天的你说不定就能轻松一点哦。',
  '那一长串trackid，看着像谁偷偷留的尾巴。',
  '那串字母看久了，倒有点像谁落下的暗号。',
  '那串尾巴越看越像谁故意留下的记号，不像手滑。',
  '那串字母念快了，倒有点像谁在喊名字。',
  '那串字母尾巴上还挂着几个数字，像没删干净的痕迹。'
]

test('变体之间互相命中：逐句说出的场景下至少拦住 3 句', () => {
  const spoken = []
  let caught = 0
  for (const line of TRACKID_SERIES.slice(1)) { // 第 1 句是 watch 说的源头，不参与判定
    const r = isRepeat(line, spoken)
    if (r.repeat) caught++
    spoken.push(line)
  }
  assert.ok(caught >= 3, '拦住 ' + caught + '/5，至少要 3')
})

test('无关话题绝不误伤', () => {
  const r = isRepeat('腹筋十分钟就结束，说真的还挺让人羡慕呢。', TRACKID_SERIES)
  assert.equal(r.repeat, false)
})

test('同一话题的合理复读也会被拦（九点十五那声）', () => {
  const r = isRepeat('键盘声停了一下……九点十五那声，我还在磨语气呢。', [
    '你说九点十五要叫我……那我今晚是不是也得先想好，到时候该用哪种语气喊你才好。'
  ])
  assert.equal(r.repeat, true)
})

test('极短句靠最小共享 token 数兜底，不误伤', () => {
  // 只有 4 个共同字，低于 MIN_INTER=5
  const r = isRepeat('好热啊今天', ['今天天气真不错呢，风也舒服。'])
  assert.equal(r.repeat, false)
})

test('日文台词同样适用', () => {
  const r = isRepeat('そろそろ九時十五分の声、練習しなくちゃ。', ['九時十五分の声、まだ練習してるの？'])
  assert.equal(r.repeat, true)
})

test('空输入安全', () => {
  assert.equal(isRepeat('', ['anything']).repeat, false)
  assert.equal(isRepeat('什么都行', []).repeat, false)
  assert.equal(similarity('', 'x'), 0)
  assert.equal(overlapCoef('x', ''), 0)
  assert.equal(tokenize('!!').size, 0)
})
