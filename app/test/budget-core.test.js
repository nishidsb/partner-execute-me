import test from 'node:test'
import assert from 'node:assert'
import { estTokens, wantFixed, FIXED_INDEX, trimHistory, historyBudget } from '../src/assistant/core/core/budget.js'

test('核心 estTokens：CJK 一字一 token，英文四字符一 token', () => {
  assert.equal(estTokens('abcd'), 1)
  assert.equal(estTokens('你好世界'), 4)
})

test('核心 wantFixed：首轮必发 / 周期复述 / 提到相关词补发', () => {
  assert.equal(wantFixed('petTools', { turn: 1 }), true)
  assert.equal(wantFixed('petTools', { turn: 3, userText: '随便聊聊' }), false)
  assert.equal(wantFixed('petTools', { turn: 3, userText: '过来摸摸头' }), true)
  assert.equal(wantFixed('petTools', { turn: 12, userText: '' }), true)
})

test('核心 FIXED_INDEX：三种说明书都有极短索引（不发全文时兜底）', () => {
  for (const k of ['petTools', 'sysTools', 'cua']) {
    assert.ok(FIXED_INDEX[k] && FIXED_INDEX[k].length < 120, k + ' 索引必须短')
  }
})

test('核心 trimHistory：从最新往回装，至少留底，超预算就断', () => {
  const h = Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: 'y'.repeat(80) + i }))
  const out = trimHistory(h, 300, 4)
  assert.ok(out.length >= 4)
  assert.ok(out.length < 15)
  assert.equal(out[out.length - 1].content.slice(-2), '14', '必须保住最新的那条（下标 14）')
  assert.equal(trimHistory(h, 0).length, 15, '预算 0 = 不裁')
})

test('核心 historyBudget：无上限给保守默认，有上限按 40% 反推并夹区间', () => {
  assert.equal(historyBudget(0), 24000)
  const b = historyBudget(131072)
  assert.ok(b >= 8000 && b <= 60000)
})
