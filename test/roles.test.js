import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDataDir } from '../src/config.js'
import { roles } from '../src/roles/roleManager.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-roles-'))
initDataDir(path.join(tmp, 'data'))

test('内置角色 seed 不覆盖已有文件', () => {
  roles.seedBuiltin()
  const first = roles.get('assistant')
  assert.ok(first && first.id === 'assistant')
  // 用户改动后再次 seed 不被覆盖
  roles.save({ ...first, persona: '改动过的人格' })
  roles.seedBuiltin()
  assert.equal(roles.get('assistant').persona, '改动过的人格')
})

test('角色创建/切换互不混淆', () => {
  roles.save({ id: 'r1', name: '一号', persona: '一号人格', worldInfo: [{ keywords: ['茶'], text: '一号爱喝茶' }] })
  roles.save({ id: 'r2', name: '二号', persona: '二号人格', replyLang: 'ja' })
  const a = roles.get('r1')
  const b = roles.get('r2')
  assert.notEqual(a.persona, b.persona)
  assert.equal(b.replyLang, 'ja')
  assert.equal(a.replyLang, '')
  assert.ok(a.worldInfo.length === 1 && b.worldInfo.length === 0)
})

test('非法 id 被拒绝，内置角色不可删', () => {
  assert.throws(() => roles.save({ id: '', persona: 'x' }))
  assert.throws(() => roles.remove('assistant'), /内置/)
})

test('导出导入角色', () => {
  const dest = path.join(tmp, 'exported.json')
  roles.export('r1', dest)
  assert.ok(fs.existsSync(dest))
  const imported = roles.import(dest, 'r1_copy')
  assert.equal(imported.id, 'r1_copy')
  assert.equal(imported.persona, '一号人格')
})
