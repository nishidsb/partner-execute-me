/**
 * QQ 主动找主人（0.45.12）——reach.js 节流判定
 *
 * 红线全部硬编码：只发主人名单、最小间隔、每日上限、凌晨静默。
 * 没配主人账号 = 永远不发（这是安全边界，不是 bug）。
 */
const test = require('node:test')
const assert = require('node:assert')

const reach = require('../src/main/companion/reach')

const NOW = 1000000000000       // 挑个白天时刻（new Date(NOW).getHours() 在 8~23 之间才稳）

test('shouldReach：没配主人账号就永远不发（安全边界）', () => {
  const r = reach.shouldReach({ lastAt: 0, day: '', count: 0 }, { reachOn: true, ownerAccounts: [] }, { now: NOW, connected: true })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'no-owner')
})

test('shouldReach：正常放行，目标默认取主人名单第一个', () => {
  const ic = { reachOn: true, ownerAccounts: ['10086', '10000'], connected: true }
  const r = reach.shouldReach({ lastAt: 0, day: '', count: 0 }, ic, { now: NOW, connected: true })
  assert.equal(r.ok, true)
  assert.equal(r.uid, '10086', '默认发给名单第一个')
  // 指定了 reachAccount 就用指定的
  const r2 = reach.shouldReach({ lastAt: 0, day: '', count: 0 }, { ...ic, reachAccount: '12345' }, { now: NOW, connected: true })
  assert.equal(r2.uid, '12345')
})

test('shouldReach：断线/关闭/冷却/每日上限/凌晨全部拦下', () => {
  const ic = { reachOn: true, ownerAccounts: ['10086'] }
  assert.equal(reach.shouldReach({}, ic, { now: NOW, connected: false }).why, 'disconnected', '没连上不发')
  assert.equal(reach.shouldReach({}, { ...ic, reachOn: false }, { now: NOW, connected: true }).why, 'off', '关了不发')
  // 冷却：默认 120 分钟
  assert.equal(
    reach.shouldReach({ lastAt: NOW - 60 * 60000, day: '', count: 0 }, ic, { now: NOW, connected: true }).why,
    'cooldown', '1 小时前刚找过，不再找')
  assert.equal(
    reach.shouldReach({ lastAt: NOW - 121 * 60000, day: '', count: 0 }, ic, { now: NOW, connected: true }).ok,
    true, '过了 2 小时可以再找')
  // 每日上限：默认 3 次
  const day = new Date(NOW).toDateString()
  assert.equal(
    reach.shouldReach({ lastAt: 0, day, count: 3 }, ic, { now: NOW, connected: true }).why,
    'daily-max', '今天已经找过 3 次')
  assert.equal(
    reach.shouldReach({ lastAt: 0, day: '昨天', count: 99 }, ic, { now: NOW, connected: true }).ok,
    true, '昨天找多少次都不占今天额度')
})

test('shouldReach：凌晨 1~8 点静默（想他也等到早上）', () => {
  const ic = { reachOn: true, ownerAccounts: ['10086'] }
  // 找一个确定落在凌晨 3 点的时刻
  const d = new Date(NOW)
  d.setHours(3, 0, 0, 0)
  const night = d.getTime()
  assert.equal(reach.shouldReach({}, ic, { now: night, connected: true }).why, 'quiet-hours', '凌晨不找')
  d.setHours(9, 0, 0, 0)
  assert.equal(reach.shouldReach({}, ic, { now: d.getTime(), connected: true }).ok, true, '早上 9 点正常')
})

test('onSent：滚动计数，跨天归零', () => {
  const now = 1000000000000
  const day = new Date(now).toDateString()
  let rec = reach.onSent({ lastAt: 0, day: '', count: 0 }, now)
  assert.equal(rec.count, 1)
  assert.equal(rec.day, day)
  rec = reach.onSent(rec, now + 60000)
  assert.equal(rec.count, 2, '同天累加')
  const tomorrow = now + 24 * 3600 * 1000
  rec = reach.onSent(rec, tomorrow)
  assert.equal(rec.count, 1, '新的一天从 1 开始')
})
