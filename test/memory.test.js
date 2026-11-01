import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDataDir } from '../src/config.js'
import { memory, tokenize, searchFacts } from '../src/memory/memoryStore.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-test-'))
initDataDir(path.join(tmp, 'data'))

test('tokenize 覆盖英文与 CJK', () => {
  assert.ok(tokenize('Hello World').includes('hello'))
  const zh = tokenize('炼金工房')
  assert.ok(zh.length >= 2, 'CJK 拆 2-gram: ' + JSON.stringify(zh))
})

test('记忆增删查与持久化', () => {
  const f1 = memory.add('t_role', '用户的项目 deadline 是周五')
  assert.ok(f1.id)
  memory.add('t_role', '用户喜欢喝美式咖啡')
  assert.equal(memory.list('t_role').length, 2)

  const hits = memory.search('t_role', '周五之前 deadline')
  assert.ok(hits.length >= 1 && hits[0].text.includes('周五'))

  assert.equal(memory.remove('t_role', f1.id), true)
  assert.equal(memory.remove('t_role', 'nonexistent'), false)
  // 持久化：重新 list 从磁盘读
  assert.equal(memory.list('t_role').length, 1)
})

test('检索不跨角色泄漏', () => {
  memory.add('role_a', '秘密配方是蜂蜜糖浆')
  assert.equal(memory.search('role_b', '配方').length, 0)
})

test('searchFacts 打分排序', () => {
  const facts = [
    { id: '1', text: '苹果是水果', at: 1 },
    { id: '2', text: '苹果手机很贵', at: 2 },
    { id: '3', text: '今天下雨', at: 3 }
  ]
  const hits = searchFacts(facts, '苹果', 2)
  assert.equal(hits.length, 2)
  assert.ok(hits.every((f) => f.text.includes('苹果')))
})

test('clear 与空内容校验', () => {
  memory.clear('t_role')
  assert.equal(memory.list('t_role').length, 0)
  assert.throws(() => memory.add('t_role', '   '))
})
