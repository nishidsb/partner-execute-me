'use strict'
/**
 * 回应模式（0.19.0）：active 当场回应 / quiet 记着等下次 / custom 按类别勾选。
 * 最后一条断言「主进程与渲染层的部位映射一致」——两边各存一份表，不一致会出现
 * 「主进程记了、渲染层不出声」这种查不出来的错位。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const reaction = require('../src/main/companion/reaction')

test('积极模式：任何互动都当场回应', () => {
  for (const p of ['head', 'body', 'grab', 'throw', 'crash', 'unknown']) {
    assert.equal(reaction.decide('active', null, p), 'now')
  }
})

test('安静模式：只记着，不当场出声（但也不算忽略）', () => {
  assert.equal(reaction.decide('quiet', null, 'head'), 'later')
  assert.equal(reaction.decide('quiet', null, 'throw'), 'later')
})

test('自定义模式：勾了当场回应，没勾的留到下次开口', () => {
  assert.equal(reaction.decide('custom', ['pet'], 'head'), 'now')
  assert.equal(reaction.decide('custom', ['pet'], 'body'), 'later')
  assert.equal(reaction.decide('custom', ['throw'], 'crash'), 'now')
  // 空数组 = 没选任何类别 → 退回默认全选（避免「怎么碰都没反应」）
  assert.equal(reaction.decide('custom', [], 'head'), 'now')
})

test('部位归类：抚摸/戳/拎放/扔四类', () => {
  assert.equal(reaction.categoryOf('head'), 'pet')
  assert.equal(reaction.categoryOf('body'), 'poke')
  assert.equal(reaction.categoryOf('weast'), 'poke')
  assert.equal(reaction.categoryOf('grab'), 'drop')
  assert.equal(reaction.categoryOf('crash'), 'throw')
  assert.equal(reaction.categoryOf('no_such_part'), 'poke', '未知部位按戳处理，不乱丢')
})

test('设置值规范化：非法模式回落 active，非法类别被过滤', () => {
  assert.deepEqual(reaction.normalize('crazy', ['pet', 'nope']), { mode: 'active', types: ['pet'] })
  assert.deepEqual(reaction.normalize(undefined, undefined), { mode: 'active', types: ['pet', 'poke', 'throw', 'drop'] })
})

test('渲染层与主进程的部位映射必须一致', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/renderer/overlay/pet.js'), 'utf8')
  const m = src.match(/const TAP_CATEGORY = \{([\s\S]*?)\n\}/)
  assert.ok(m, '渲染层应该有 TAP_CATEGORY 映射表')
  const renderer = {}
  for (const pair of m[1].split(',')) {
    const mm = pair.match(/([a-z_]+)\s*:\s*'([a-z]+)'/)
    if (mm) renderer[mm[1]] = mm[2]
  }
  assert.deepEqual(renderer, reaction.PART_CATEGORY)
})
