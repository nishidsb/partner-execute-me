/**
 * 健康记录（0.24.0）：时间/心情解析、跨午夜时长、同日期合并、统计与上下文摘要。
 * 全部走临时 dataRoot，不碰真实数据。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const health = require('../src/main/health')

function fresh () {
  const dir = path.join(os.tmpdir(), 'ryza-health-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8))
  health.init({ dataRoot: dir, log: () => { } })
  return dir
}

test('health: 时间解析认中英文各种说法', () => {
  const cases = [
    ['1:30', '01:30'],
    ['凌晨两点半', '02:30'],
    ['0230', '02:30'],
    ['晚上十点二十', '22:20'],
    ['下午3点', '15:00'],
    ['半夜12点', '00:00'],
    ['中午12点', '12:00'],
    ['早上七点一刻', '07:15'],
    ['八点三刻', '08:45'],
    ['昨晚 23:40', '23:40'],
    ['abc', ''],
    ['', '']
  ]
  for (const [input, want] of cases) {
    assert.equal(health.normClock(input), want, '解析 ' + JSON.stringify(input))
  }
})

test('health: 跨午夜算时长（01:30 → 09:00 = 7.5）', () => {
  assert.equal(health.hoursBetween('01:30', '09:00'), 7.5)
  assert.equal(health.hoursBetween('23:30', '07:00'), 7.5)
  assert.equal(health.hoursBetween('', '07:00'), 0)
})

test('health: 心情口语转分数', () => {
  assert.equal(health.normMood('很好'), 9)
  assert.equal(health.normMood('还行'), 7)
  assert.equal(health.normMood('一般'), 5)
  assert.equal(health.normMood('累'), 3)
  assert.equal(health.normMood('很差'), 1)
  assert.equal(health.normMood('7'), 7)
  assert.equal(health.normMood(''), null)
})

test('health: 记一条能算出睡眠时长与心情，空记录被拒', () => {
  fresh()
  const r = health.record({ date: '2026-10-27', sleepBed: '01:30', sleepWake: '09:00', mood: '还行', bpSys: 128, bpDia: 82, pulse: 72 })
  assert.equal(r.ok, true)
  assert.equal(r.entry.sleep.hours, 7.5)
  assert.equal(r.entry.mood.score, 7)
  assert.equal(r.entry.bp.sys, 128)

  const empty = health.record({ date: '2026-10-27' })
  assert.equal(empty.ok, false, '什么都没有时必须拒绝，不能写脏数据')
})

test('health: 同一天记多次会合并字段', () => {
  fresh()
  health.record({ date: '2026-10-28', sleepBed: '02:15', sleepWake: '10:00' })
  health.record({ date: '2026-10-28', bpSys: 135, bpDia: 88 })
  health.record({ date: '2026-10-28', mood: '累' })
  const rows = health.list({ days: 7 })
  assert.equal(rows.length, 1, '同一天只有一条')
  assert.equal(rows[0].sleep.hours, 7.8)
  assert.equal(rows[0].bp.sys, 135)
  assert.equal(rows[0].mood.score, 3)
})

test('health: 统计出均值、晚睡天数、偏高次数', () => {
  fresh()
  health.record({ date: '2026-10-26', sleepBed: '01:10', sleepWake: '08:30', bpSys: 150, bpDia: 95 })
  health.record({ date: '2026-10-27', sleepBed: '00:30', sleepWake: '08:00', bpSys: 120, bpDia: 78 })
  const st = health.stats({ days: 14 })
  assert.equal(st.ok, true)
  assert.equal(st.recordedDays, 2)
  assert.equal(st.sleep.nights, 2)
  assert.ok(st.sleep.avgHours > 7 && st.sleep.avgHours < 8)
  assert.equal(st.sleep.lateNights, 1, '01:10 算晚睡，00:30 不算')
  assert.equal(st.bp.highCount, 1, '150/95 偏高')
  assert.equal(st.bp.maxSys, 150)
})

test('health: 上下文摘要包含睡眠与最近一次', () => {
  fresh()
  health.record({ date: '2026-10-27', sleepBed: '02:00', sleepWake: '09:30', mood: '一般' })
  const block = health.promptBlock({ days: 7 })
  assert.ok(block.includes('睡眠'), '摘要里要有睡眠')
  assert.ok(block.includes('7.5'), '要带小时数')
  assert.ok(block.length <= 900, '摘要不能无限长')
})

test('health: 数据落在 dataRoot/health/log.jsonl', () => {
  const dir = fresh()
  health.record({ date: '2026-10-27', mood: '还行' })
  const f = path.join(dir, 'health', 'log.jsonl')
  assert.ok(fs.existsSync(f), '要写到约定路径')
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
})

test('health: 清空后统计为空', () => {
  fresh()
  health.record({ date: '2026-10-27', mood: '还行' })
  health.clear()
  assert.equal(health.stats({ days: 30 }).ok, false)
})
