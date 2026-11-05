'use strict'
const test = require('node:test')
const assert = require('node:assert')

test('0.46.21 看门狗：首包超时触发 abort 且 fired 可辨', async () => {
  const { chatWatchdog } = await import('../src/assistant/core/models/watchdog.js')
  const wd = chatWatchdog(null, { firstMs: 50, idleMs: 50 })
  let aborted = false
  wd.signal.addEventListener('abort', () => { aborted = true })
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(aborted, '首包超时应 abort')
  assert.ok(wd.fired(), 'fired 标记可辨（用于把错误翻成人话）')
  wd.done()
})

test('0.46.21 看门狗：touch 续命 / done 清理 / 外部 signal 联动', async () => {
  const { chatWatchdog } = await import('../src/assistant/core/models/watchdog.js')
  const outer = new AbortController()
  const wd = chatWatchdog(outer.signal, { firstMs: 40, idleMs: 40 })
  // 每 15ms touch 一次，撑过 100ms（远超 40ms 预算）→ 不应触发
  for (let i = 0; i < 7; i++) {
    await new Promise((r) => setTimeout(r, 15))
    wd.touch()
  }
  assert.equal(wd.fired(), false, '持续有数据就不触发')
  wd.done()
  // 外部断开 → 内部联动触发
  const wd2 = chatWatchdog(outer.signal, { firstMs: 10000 })
  outer.abort()
  assert.ok(wd2.fired(), '外部 signal 断开联动触发')
  wd2.done()
})
