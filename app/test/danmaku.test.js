'use strict'
/**
 * 弹幕断句（0.38.0）
 * 这些用例是照参考项目踩过的坑反向写的：括号被劈开、颜文字被吞、
 * 收尾括号单独成条、长句没人管横穿整个屏幕。
 */
const test = require('node:test')
const assert = require('node:assert')
const { splitLines, chunkLong } = require('../src/main/danmaku-split')

test('一句一条：整段话按句号切开', () => {
  assert.deepStrictEqual(splitLines('好，我知道了。你玩吧！那我先看着。'), ['好，我知道了。', '你玩吧！', '那我先看着。'])
})

test('括号里的标点不断句（颜文字不能被劈开）', () => {
  const out = splitLines('（笑）这也能过？（眼泪都出来了。）真厉害。')
  assert.deepStrictEqual(out.slice(0, 2), ['（笑）这也能过？', '（眼泪都出来了。）'])
  assert.ok(out.includes('真厉害。'))
})

test('收尾括号不单独成条：引号里说完一句就算一句', () => {
  assert.deepStrictEqual(splitLines('「这也太强了吧。」她说。'), ['这也太强了吧。', '她说。'])
})

test('引号在句中被吞进同一句（「等一下」不算结尾）', () => {
  assert.deepStrictEqual(splitLines('他说「等一下」然后走了。'), ['他说「等一下」然后走了。'])
})

test('换行也算断点，空行不产生空条', () => {
  assert.deepStrictEqual(splitLines('第一行\n\n第二行\n'), ['第一行', '第二行'])
})

test('只有标点的碎片不成条', () => {
  assert.deepStrictEqual(splitLines('……'), [])
  assert.deepStrictEqual(splitLines('（笑）（哭）').length >= 1, true)
})

test('markdown 装饰去掉（弹幕里星号只会变成噪点）', () => {
  assert.deepStrictEqual(splitLines('**注意**：这里有 `代码`。'), ['注意：这里有 代码。'])
})

test('超长句优先在逗号断，不硬切', () => {
  const long = '这是一句非常非常长的话，长到必须在逗号这里断开才行，不然弹幕会横穿整个屏幕看着很累，所以要先在逗号断。'
  const out = splitLines(long)
  assert.ok(out.length >= 2, '长句必须被拆成多条')
  for (const s of out) assert.ok(s.length <= 44, '每条不超过 44 字：' + s)
  assert.ok(out[0].endsWith('，'), '第一条应该断在逗号上：' + out[0])
})

test('英文长句在空格断，不劈单词', () => {
  const out = splitLines('this is a fairly long english sentence that will not fit in one danmaku line at all my friend')
  for (const s of out) assert.ok(s.length <= 44)
  assert.ok(out.every((s) => !/^[a-z]/.test(s) || s.split(' ').length >= 1))
  // 每条都应是完整单词开头（不是从半个单词开始）
  const joined = out.join(' ')
  assert.strictEqual(joined.replace(/\s+/g, ' ').trim(), 'this is a fairly long english sentence that will not fit in one danmaku line at all my friend')
})

test('chunkLong 在没有标点时按字数切', () => {
  const out = chunkLong('啊'.repeat(100), 40)
  assert.deepStrictEqual(out.map((s) => s.length), [40, 40, 20])
})

test('空输入返回空数组（别往弹幕层推空串）', () => {
  assert.deepStrictEqual(splitLines(''), [])
  assert.deepStrictEqual(splitLines('   '), [])
  assert.deepStrictEqual(splitLines(null), [])
})
