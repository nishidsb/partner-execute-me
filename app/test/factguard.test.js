'use strict'
/**
 * 「关于他」的事实去重闸（画像 → 长期记忆的路上唯一的防重复）。
 * 做梦是周期性的：同一场考试、同一个作息会被反复梦到，
 * 没有这道闸，PARTNER.md 的「长期事实」几周后就全是同义句。
 */
const test = require('node:test')
const assert = require('node:assert')
const guard = require('../src/main/factGuard')

const DOC = [
  '# PARTNER',
  '## 长期事实',
  '- 用户在准备广东省的公务员考试',
  '- 他常玩原神和崩坏',
  '## 近期日志',
  '- 2026-10-27 换了壁纸'
].join('\n')

test('factGuard：同一条事实换个说法也算重复', () => {
  assert.equal(guard.hasSimilarFact(DOC, '他在准备广东省公务员考试'), true)
  assert.equal(guard.hasSimilarFact(DOC, '用户在准备广东省的公务员考试。'), true)
})

test('factGuard：不同的事不误杀（哪怕有同样的词）', () => {
  assert.equal(guard.hasSimilarFact(DOC, '他最近在看房子，想搬出去住'), false)
  assert.equal(guard.hasSimilarFact(DOC, '他夜里一点半才离开电脑'), false)
})

test('factGuard：只看条目行，不吃标题和正文', () => {
  // 「近期日志」是标题行，不该参与比对
  assert.equal(guard.hasSimilarFact('## 近期日志\n', '近期日志'), false)
})

test('factGuard：空文本/空文档不炸', () => {
  assert.equal(guard.hasSimilarFact('', '随便一条'), false)
  assert.equal(guard.hasSimilarFact(DOC, ''), false)
  assert.equal(guard.hasSimilarFact(null, '他常玩原神'), false)   // 文档还没建 = 没有可比的，直接放行
  assert.equal(guard.hasSimilarFact(DOC, '他常玩原神'), true)      // 但文档里有，就得挡
})
