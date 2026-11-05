'use strict'
/**
 * 0.46.28 生活线账本（goals.js）防回归
 * add/progress/close 流转、7 天卡住标记、promptBlock 组装、上限。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createGoals, STUCK_MS } = require('../src/main/companion/goals')

function tmpWs () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'goals-test-'))
}

test('目标全生命周期：add → progress → done', () => {
  const ws = tmpWs()
  const g = createGoals({ wsDir: ws })
  const r = g.add({ title: '看完那部纪录片', detail: '他说好看' })
  assert.equal(r.ok, true)
  const id = r.goal.id
  assert.equal(g.progress({ id, note: '看到第 2 集' }).ok, true)
  const done = g.close({ id, note: '看完了，最后一集哭了' })
  assert.equal(done.ok, true)
  const list = g.listRaw()
  assert.equal(list[0].status, 'done')
  assert.equal(list[0].progress.length, 2)
})

test('空标题拒绝、进展空句拒绝、未知 id 拒绝', () => {
  const g = createGoals({ wsDir: tmpWs() })
  assert.equal(g.add({ title: '  ' }).ok, false)
  const r = g.add({ title: '学做舒芙蕾' })
  assert.equal(g.progress({ id: r.goal.id, note: '' }).ok, false)
  assert.equal(g.progress({ id: '不存在', note: 'x' }).ok, false)
  assert.equal(g.close({ id: '不存在' }).ok, false)
})

test('7 天没动静自动标记卡住，记进展解除', () => {
  let t = Date.now()
  const g = createGoals({ wsDir: tmpWs(), now: () => t })
  const r = g.add({ title: '每天拉伸' })
  t += STUCK_MS + 1000
  const list = g.listRaw()
  assert.equal(list[0].stuck, true)
  // 记进展解除卡住（progress 内部用同一个 now）
  assert.equal(g.progress({ id: r.goal.id, note: '今天拉了' }).ok, true)
  assert.equal(g.listRaw()[0].stuck, false)
})

test('promptBlock：无目标空串，有目标含标题与卡住提示，刚完成的进回味期', () => {
  let t = Date.now()
  const g = createGoals({ wsDir: tmpWs(), now: () => t })
  assert.equal(g.promptBlock(), '')
  const r = g.add({ title: '整理照片墙' })
  assert.ok(g.promptBlock().includes('整理照片墙'))
  t += STUCK_MS + 1000
  assert.ok(g.promptBlock().includes('卡住'))
  t += 1000
  g.close({ id: r.goal.id, note: '贴满了' })
  const block = g.promptBlock()
  assert.ok(block.includes('刚完成'))
  assert.ok(block.includes('回味'))
})

test('目标数上限 12', () => {
  const g = createGoals({ wsDir: tmpWs() })
  for (let i = 0; i < 12; i++) assert.equal(g.add({ title: '目标' + i }).ok, true)
  assert.equal(g.add({ title: '第 13 个' }).ok, false)
})

test('落盘位置在工作区根 goals.json', () => {
  const ws = tmpWs()
  const g = createGoals({ wsDir: ws })
  g.add({ title: 'x' })
  assert.ok(fs.existsSync(path.join(ws, 'goals.json')))
})
