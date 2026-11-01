'use strict'
const test = require('node:test')
const assert = require('node:assert')

// typewriter.js 是渲染层 script（挂 window），这里 stub 一个 window 再 require
global.window = {}
require('../src/renderer/shared/typewriter.js')
const TW = global.window.RyzaTyper

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

test('typewriter: 首口立即出（最多 12 字），不等定时器', () => {
  let shown = ''
  const tw = TW.create({ setText: (t) => { shown = t } })
  tw.push('0123456789ABCDEFGHIJ')
  assert.equal(shown, '0123456789AB', '首口 12 字立即上屏')
})

test('typewriter: 小步排出直到追平，finish 补完最终内容', async () => {
  let shown = ''
  const tw = TW.create({ setText: (t) => { shown = t } })
  tw.push('你好。今天天气不错，我们出去走走吧。')
  assert.ok(shown.length < '你好。今天天气不错，我们出去走走吧。'.length, '没有一口气全出')
  await sleep(450)
  assert.equal(shown, '你好。今天天气不错，我们出去走走吧。', '400ms 内基本追平')
  tw.finish('最终稿：说完这句就收。')
  assert.equal(shown, '最终稿：说完这句就收。', 'finish 以最终内容为准')
})

test('typewriter: reset 清空；finish 后 push 不再生效', async () => {
  let shown = ''
  const tw = TW.create({ setText: (t) => { shown = t } })
  tw.push('第一轮的话……')
  tw.reset()
  assert.equal(shown, '', 'reset 立即清空')
  tw.push('第二轮开始了。')
  tw.finish()
  assert.equal(shown, '第二轮开始了。', 'finish 无 final 时用已排+缓冲')
  tw.push('迟到的不算。')
  assert.equal(shown, '第二轮开始了。', 'finish 后 push 丢弃')
})

test('typewriter: 句末标点后有明显换气（排出速度变慢）', async () => {
  let shown = ''
  const tw = TW.create({ setText: (t) => { shown = t } })
  tw.push('好。好。好。好。好。好。')  // 每句都是句末标点
  await sleep(60)
  const early = shown.length
  await sleep(120)
  const mid = shown.length
  assert.ok(mid - early <= 2, '120ms 里只多排 1~2 字（换气中），实际 ' + (mid - early))
})
