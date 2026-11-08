/** 0.18.0 第一批：闹钟 —— 纯函数 + 持久化 + 到点触发/补发 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseTime, parseDate, fmtTime, nextFireAt, planDue, createAlarms, MAX_ALARMS } = require('../src/main/companion/alarms')

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

/* ---------------- 0.46.23 date（某天一次性）——用户 11-03「跟角色说明天的事，会在今天的闹钟提醒我」 ---------------- */

test('parseDate：YYYY-MM-DD 严格校验（含日历真实性）', () => {
  assert.equal(parseDate('2026-11-04'), '2026-11-04')
  assert.equal(parseDate('2026-2-3'), null, '要补零的两位')
  assert.equal(parseDate('2026-02-30'), null, '2 月 30 日不存在')
  assert.equal(parseDate('2026-13-01'), null)
  for (const bad of ['', '明天', '11-04', '2026/11/04', null]) assert.equal(parseDate(bad), null)
})

test('nextFireAt + date：就是那一天；过了就是过了（daily 不救）', () => {
  const now = at(8, 0) // 2026-10-26 08:00
  assert.equal(nextFireAt({ time: '09:30', date: '2026-10-26' }, now), at(9, 30), '当天未到=当天')
  assert.equal(nextFireAt({ time: '07:00', date: '2026-10-26' }, now), null, '当天已过=null')
  assert.equal(nextFireAt({ time: '07:00', date: '2026-10-27' }, now), at(7, 0, 27), '明天=明天')
  assert.equal(nextFireAt({ time: '07:00', date: '2026-10-25' }, now), null, '过去的日子=null')
  assert.equal(nextFireAt({ time: '07:00', date: '2026-10-27', daily: true }, now), at(7, 0, 27), 'daily 不改变 date 语义')
})

test('createAlarms.add：date 落盘 + 已过时间拒绝（不再静默死掉）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-d-'))
  const a = createAlarms({ home: dir, now: () => at(8, 0), onFire: () => { } })
  // 明天的一次性：正常入账，date 强制、daily 强制 false
  const ok = a.add({ time: '07:30', date: '2026-10-27', label: '明天的会', daily: true })
  assert.equal(ok.ok, true)
  assert.equal(ok.alarm.date, '2026-10-27')
  assert.equal(ok.alarm.daily, false, '给了 date 就不是每天')
  assert.equal(ok.alarm.nextAt, at(7, 30, 27))
  // 今天已过的一次性：拒绝并说明（旧版会存一个 nextAt=null 的死闹钟）
  const dead = a.add({ time: '07:00', date: '', daily: false })
  assert.equal(dead.ok, false)
  assert.match(dead.error, /已经过了/)
  assert.match(dead.error, /date/, '错误信息要教模型给 date')
  // 过去的 date：拒绝
  const past = a.add({ time: '07:00', date: '2026-10-20' })
  assert.equal(past.ok, false)
  assert.match(past.error, /已经过了/)
  // 坏 date：拒绝
  assert.equal(a.add({ time: '07:00', date: 'tomorrow' }).ok, false)
  // list 带出 date
  const l = a.list()
  assert.equal(l[0].date, '2026-10-27')
})

test('0.46.76 同窗去重：一次性闹钟 ±15 分钟内已有就不加第二个（13:45/13:55 双催实锤）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-alarm-dup-'))
  const now = at(11, 0)
  const a = createAlarms({ home, now: () => now, onFire: () => {}, log: () => {} })
  const first = a.add({ time: '13:45', label: '午後の準備', daily: false })
  assert.equal(first.ok, true)
  const second = a.add({ time: '13:55', label: '休憩おわり(泛化)', daily: false })
  assert.equal(second.ok, false, '同窗一次性闹钟应拒绝')
  assert.equal(second.duplicate, true)
  assert.ok(/13:45/.test(second.error), '报错里要点名已有闹钟: ' + second.error)
  assert.equal(a.list().length, 1, '拒绝的闹钟不落盘')
  const daily = a.add({ time: '13:50', label: '再叫一次', daily: true })
  assert.equal(daily.ok, true, '每天的闹钟不去重（snooze 是合理用法）')
  const far = a.add({ time: '14:05', label: '另一件事', daily: false })
  assert.equal(far.ok, true, '15 分钟窗外放行')
})
