import test from 'node:test'
import assert from 'node:assert/strict'
import '../src/tools/builtin.js'
import { get, exec, listDefs, list } from '../src/tools/registry.js'

test('calc 白名单与求值', async () => {
  const calc = get('calc')
  assert.equal(await calc.exec({ expression: '(12+8)*2' }), '40')
  assert.equal(await calc.exec({ expression: '10/4' }), '2.5')
  await assert.rejects(() => calc.exec({ expression: 'process.exit(1)' }))
  await assert.rejects(() => calc.exec({ expression: '1+' }))
})

test('高风险工具未经确认被拒、确认后执行', async () => {
  const cmd = { command: 'echo hello' }
  await assert.rejects(
    () => exec('exec_command', cmd, { confirmFn: async () => false }),
    (e) => e.code === 'TOOL_DENIED'
  )
  const r = await exec('exec_command', cmd, { confirmFn: async () => true })
  assert.ok(r.ok)
  assert.ok(String(r.result.stdout).includes('hello'))
})

test('listDefs 符合 OpenAI tools 格式', () => {
  const defs = listDefs()
  assert.ok(defs.length >= 4)
  for (const d of defs) {
    assert.equal(d.type, 'function')
    assert.ok(d.function.name && d.function.description && d.function.parameters)
  }
  const names = list().map((t) => t.name)
  assert.ok(names.includes('exec_command'))
  assert.equal(list().find((t) => t.name === 'exec_command').risk, 'high')
})
