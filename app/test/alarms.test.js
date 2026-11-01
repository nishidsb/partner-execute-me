/** 0.18.0 第一批：闹钟 —— 纯函数 + 持久化 + 到点触发/补发 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseTime, fmtTime, nextFireAt, planDue, createAlarms, MAX_ALARMS } = require('../src/main/companion/alarms')

const at = (h, m, day = 26) => new Date(2026, 9, day, h, m, 0, 0).getTime()

test('parseTime / fmtTime：宽松解析，非法拒绝', () => {
  assert.deepEqual(parseTime('7:05'), { h: 7, m: 5 })
  assert.deepEqual(parseTime('07：30'), { h: 7, m: 30 }) // 全角冒号
  assert.deepEqual(parseTime('23:59'), { h: 23, m: 59 })
  for (const bad of ['', '7', '24:00', '12:60', 'abc', '12:5:6', null]) {
    assert.equal(parseTime(bad), null, '应拒绝: ' + String(bad))
  }
  assert.equal(fmtTime({ h: 7, m: 5 }), '07:05')
})

test('nextFireAt：今天未到=今天；已过+每天=明天；已过+一次性=null', () => {
  const now = at(8, 0)
  assert.equal(nextFireAt({ time: '09:30', daily: true }, now), at(9, 30))
  assert.equal(nextFireAt({ time: '07:00', daily: true }, now), at(7, 0, 27))
  assert.equal(nextFireAt({ time: '07:00', daily: false }, now), null)
  // 关机两天：跳到第一个未来 occurrence，不连炸
  const old = at(7, 0, 20)
  assert.ok(nextFireAt({ time: '07:00', daily: true, nextAt: old }, now) > now)
})

test('planDue：到点触发、推进下次；错过超 15 分钟只推进不补发', () => {
  const now = at(7, 3)
  const due = planDue([{ id: 'a', time: '07:00', daily: true, enabled: true, nextAt: at(7, 0) }], now)
  assert.equal(due.fire.length, 1)
  assert.equal(due.fire[0].late, 3 * 60000)
  assert.equal(due.next[0].nextAt, at(7, 0, 27), 'daily 推进到明天')
  assert.ok(due.next[0].lastFiredAt === now)

  // 晚了 2 小时：不补发，但顺延到明天
  const late = planDue([{ id: 'b', time: '07:00', daily: true, enabled: true, nextAt: at(7, 0) }], at(9, 3))
  assert.equal(late.fire.length, 0)
  assert.equal(late.next[0].nextAt, at(7, 0, 27))

  // 关闭的闹钟不动
  const off = planDue([{ id: 'c', time: '07:00', daily: true, enabled: false, nextAt: at(7, 0) }], now)
  assert.equal(off.fire.length, 0)
  assert.equal(off.changed, false)

  // 一次性到点后 nextAt=null
  const once = planDue([{ id: 'd', time: '07:00', daily: false, enabled: true, nextAt: at(7, 0) }], now)
  assert.equal(once.fire.length, 1)
  assert.equal(once.next[0].nextAt, null)
})

test('createAlarms：增删查持久化 + tick 触发一次并推进', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-alarm-'))
  let now = at(6, 0)
  const fired = []
  const a = createAlarms({ home, now: () => now, onFire: (x) => fired.push(x), log: () => {} })

  const r = a.add({ time: '06:30', label: '喝水', daily: true })
  assert.equal(r.ok, true)
  assert.equal(a.list().length, 1)
  assert.equal(a.list()[0].time, '06:30')
  assert.ok(a.list()[0].nextAt === at(6, 30))

  // 非法时间 / 超上限
  assert.equal(a.add({ time: '25:00' }).ok, false)
  for (let i = 0; i < MAX_ALARMS; i++) a.add({ time: '08:00', label: 'x' + i })
  const over = a.add({ time: '09:00' })
  assert.equal(over.ok, false, '超过上限拒绝')

  // 到点触发
  now = at(6, 31)
  const n = a.tick()
  assert.ok(n >= 1)
  assert.equal(fired[0].label, '喝水')
  assert.equal(fired[0].lateMin, 1)
  assert.equal(a.list().find((x) => x.label === '喝水').nextAt, at(6, 30, 27), '每天 → 明天')

  // 删除 + 重新加载（持久化）
  const id = a.list().find((x) => x.label === '喝水').id
  assert.equal(a.remove(id), true)
  assert.equal(a.remove('nope'), false)
  const b = createAlarms({ home, now: () => now, onFire: () => {}, log: () => {} })
  assert.ok(b.list().every((x) => x.label !== '喝水'))

  // 启停
  const target = b.list()[0]
  assert.equal(b.setEnabled(target.id, false), true)
  assert.equal(b.list().find((x) => x.id === target.id).enabled, false)
  fs.rmSync(home, { recursive: true, force: true })
})
