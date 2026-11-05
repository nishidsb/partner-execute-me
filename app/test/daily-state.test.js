'use strict'
/**
 * 0.46.28 她自己的作息 + 相识仪式感（daily-state.js）防回归
 * 时段划分（工作日/周末不同）、isAsleep、相识天数、里程碑判定。
 */
const test = require('node:test')
const assert = require('node:assert')
const { phase, isAsleep, isWeekend, daysTogether, isMilestone } = require('../src/main/companion/daily-state')

// 2026-11-03 是周二；2026-11-07 是周六
const at = (day, h, m) => new Date(2026, 10, day, h, m, 0).getTime()

test('时段划分：工作日', () => {
  assert.equal(phase(at(3, 3, 0)), 'asleep')       // 凌晨 3 点
  assert.equal(phase(at(3, 1, 0)), 'sleepy')       // 凌晨 1 点，还没到 1:30
  assert.equal(phase(at(3, 8, 0)), 'waking')       // 工作日 7:30 起，8 点刚起
  assert.equal(phase(at(3, 12, 0)), 'awake')
  assert.equal(phase(at(3, 19, 0)), 'evening')
  assert.equal(phase(at(3, 23, 30)), 'sleepy')
})

test('周末赖床：周六 8 点还在睡，10 点才醒', () => {
  assert.equal(isWeekend(at(7, 10, 0)), true)
  assert.equal(phase(at(7, 8, 0)), 'asleep')       // 周末睡到 9 点
  assert.equal(phase(at(7, 9, 30)), 'waking')
  assert.equal(phase(at(3, 8, 0)), 'waking')       // 工作日 8 点已起
})

test('isAsleep：主动开口门控用', () => {
  assert.equal(isAsleep(at(3, 2, 0)), true)
  assert.equal(isAsleep(at(3, 15, 0)), false)
  assert.equal(isAsleep(at(7, 8, 30)), true)       // 周六 8:30 还没起
})

test('相识天数：第 1 天是当天，跨天 +1', () => {
  const create = at(3, 14, 0)
  assert.equal(daysTogether(create, at(3, 20, 0)), 1)   // 当天
  assert.equal(daysTogether(create, at(4, 9, 0)), 2)    // 次日
  assert.equal(daysTogether(create, at(3, 9, 0)), 1)    // 当天凌晨也算第 1 天
  assert.equal(daysTogether(0, Date.now()), 0)          // 没有创建时间 → 0
})

test('里程碑：整百/365/730/1000', () => {
  for (const n of [100, 200, 365, 500, 730, 1000]) assert.equal(isMilestone(n), true, n)
  for (const n of [1, 99, 101, 364, 366, 999]) assert.equal(isMilestone(n), false, n)
  assert.equal(isMilestone(0), false)
})
