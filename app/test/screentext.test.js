'use strict'
/**
 * 陪看字幕（0.34.0）纯逻辑测试
 *
 * 覆盖两块「改坏了会静默烧 token」的地方：
 *   1. 断句：同一句被 OCR 读到七八次只能定稿一次；淡入残影要削掉；换行不算定稿；
 *   2. 白板：没有新字幕必须是空串；同一轮取两次不能把内容吃掉；游标只在 commit 时推进。
 */
const test = require('node:test')
const assert = require('node:assert')

const S = require('../src/main/companion/screentext/segment')
const B = require('../src/main/companion/screentext/board')

/* ---------------- 断句：清洗 ---------------- */

test('清洗：淡入那帧的前导 0 要削掉', () => {
  assert.equal(S.clean('0那你就赶快回去'), '那你就赶快回去')
})

test('清洗：只有标点的帧当没字', () => {
  assert.equal(S.clean('……，。'), '')
  assert.equal(S.clean('  '), '')
})

test('清洗：首尾括号保留，杂符号剥掉', () => {
  assert.equal(S.clean('「有道理」'), '「有道理」')
  assert.equal(S.clean('*有道理*'), '有道理')
})

test('清洗：一个字的碎片不算句子', () => {
  assert.equal(S.clean('好'), '')
})

test('日文判定：假名占比够才算日文', () => {
  assert.equal(S.isJapanese('アルトアル王国の皆さん'), true)
  assert.equal(S.isJapanese('通过魔法影像向大众公布结果'), false)
})

/* ---------------- 断句：三条规矩 ---------------- */

test('断句：连续 3 帧同文才算出现', () => {
  const g = S.createSegmenter()
  assert.equal(g.feed('这就是魔境的原因吗'), '')
  assert.equal(g.feed('这就是魔境的原因吗'), '')
  // 第 3 帧开始进候选，但还没消失 → 不定稿
  assert.equal(g.feed('这就是魔境的原因吗'), '')
  assert.equal(g.feed('这就是魔境的原因吗'), '')
})

test('断句：字幕消失 2 帧才定稿，且只定一次', () => {
  const g = S.createSegmenter()
  for (let i = 0; i < 4; i++) g.feed('这就是魔境的原因吗')
  assert.equal(g.feed(''), '')
  assert.equal(g.feed(''), '这就是魔境的原因吗')
  assert.equal(g.feed(''), '')   // 不能再来一次
  assert.equal(g.feed(''), '')
})

test('断句：相似的三版算同一句，留最完整的那版', () => {
  const g = S.createSegmenter()
  for (let i = 0; i < 3; i++) g.feed('你是人精灵')
  for (let i = 0; i < 3; i++) g.feed('你是人精灵2')
  for (let i = 0; i < 3; i++) g.feed('你是人精灵？一')
  g.feed('')
  const done = g.feed('')
  assert.ok(done.startsWith('你是人精灵'), '应该是同一句：' + done)
  assert.ok(done.length >= 5)
})

test('断句：换了一句就先把上一句交出去', () => {
  const g = S.createSegmenter()
  for (let i = 0; i < 3; i++) g.feed('有道理')
  let done = ''
  for (let i = 0; i < 3 && !done; i++) done = g.feed('マジックビジョンで世に訴えよう')
  assert.equal(done, '有道理')
})

test('断句：收尾能把手里那句交出来', () => {
  const g = S.createSegmenter()
  for (let i = 0; i < 3; i++) g.feed('还没说完的一句')
  assert.equal(g.flush(), '还没说完的一句')
  assert.equal(g.flush(), '')
})

test('断句：reset 之后当全新开始', () => {
  const g = S.createSegmenter()
  for (let i = 0; i < 4; i++) g.feed('这句话会被丢掉')
  g.reset()
  assert.equal(g.feed(''), '')
  assert.equal(g.flush(), '')
})

/* ---------------- 白板：游标 ---------------- */

test('白板：没字幕时是空串（不占上下文）', () => {
  const b = B.createBoard()
  assert.equal(b.render(1000), '')
})

test('白板：拼出来的那段带来源说明和相对时间', () => {
  const b = B.createBoard()
  b.add('这就是魔境的原因吗', 10000)
  const out = b.render(22000)
  assert.ok(out.includes('你正在看的'))
  assert.ok(out.includes('12 秒前'))
  assert.ok(out.includes('这就是魔境的原因吗'))
  assert.ok(out.includes('片子里的字幕'))
})

test('白板：同一轮取两次内容一样（游标不能提前推）', () => {
  const b = B.createBoard()
  b.add('第一句', 1000)
  const a = b.render(2000)
  const c = b.render(2000)
  assert.equal(a, c)
  assert.ok(a.length > 0)
})

test('白板：commit 之后才不重复发', () => {
  const b = B.createBoard()
  b.add('第一句', 1000)
  assert.ok(b.render(2000).length > 0)
  assert.equal(b.commit(), true)
  assert.equal(b.render(3000), '')
  b.add('第二句', 4000)
  const out = b.render(5000)
  assert.ok(out.includes('第二句'))
  assert.ok(!out.includes('第一句'))
})

test('白板：只 commit 没渲染过的轮次不动游标', () => {
  const b = B.createBoard()
  b.add('挂着的句子', 1000)
  assert.equal(b.commit(), false)
  assert.ok(b.render(2000).includes('挂着的句子'))
})

test('白板：连续重复的同一句不写两条', () => {
  const b = B.createBoard()
  b.add('同一句', 1000)
  assert.equal(b.add('同一句', 2000), false)
  assert.equal(b.stats().total, 1)
})

test('白板：一轮最多贴 80 句，并标明前面还有几句', () => {
  const b = B.createBoard()
  for (let i = 1; i <= 100; i++) b.add('第 ' + i + ' 句', 1000 + i)
  const out = b.render(2000)
  assert.ok(out.includes('前面还有 20 句'))
  assert.ok(out.includes('第 100 句'))
  assert.ok(!out.includes('第 19 句'))
})

test('白板：队列上限 400，被挤掉且没发过的要记数', () => {
  const b = B.createBoard()
  for (let i = 1; i <= 450; i++) b.add('句子 ' + i, 1000 + i)
  const st = b.stats()
  assert.equal(st.total, 400)
  assert.equal(st.dropped, 50)
  assert.ok(b.render(5000).includes('再早还有 50 句被挤掉了'))
})

test('白板：停掉陪看清空攒的，游标推到队尾不回头', () => {
  const b = B.createBoard()
  b.add('没发出去的', 1000)
  assert.equal(b.reset(), 1)
  assert.equal(b.render(2000), '')
  b.add('停了以后又来一句', 3000)
  assert.ok(b.render(4000).includes('停了以后又来一句'))
})

test('相对时间：刚刚 / 秒 / 分钟 / 小时', () => {
  assert.equal(B.howLongAgo(1000, 2500), '刚刚')
  assert.equal(B.howLongAgo(1000, 13000), '12 秒前')
  assert.equal(B.howLongAgo(0, 120000), '2 分钟前')
  assert.equal(B.howLongAgo(0, 7200000), '2 小时前')
})
