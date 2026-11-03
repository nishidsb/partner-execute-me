/**
 * QQ 主动找主人（0.45.12；0.45.97 改随机节奏 + 两边只算一次）
 *
 * 红线全部硬编码：只发主人名单、随机间隔、时段策略。
 * 没配主人账号 = 永远不发（这是安全边界，不是 bug）。
 *
 * 0.45.97 用户 11-02：
 *   「这个主动发的属于多余的设计，随机发就可以了，不用在意多少条」
 *   「这两个地方只要有一边发了都算发」
 * → 没有 reachMinGapMin / reachDailyMax 了，间隔每次随机抽；当天发多少条都不算超限。
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

test('shouldReach：断线 / 关闭 / 随机间隔内全部拦下', () => {
  const ic = { reachOn: true, ownerAccounts: ['10086'] }
  assert.equal(reach.shouldReach({}, ic, { now: NOW, connected: false }).why, 'disconnected', '没连上不发')
  assert.equal(reach.shouldReach({}, { ...ic, reachOn: false }, { now: NOW, connected: true }).why, 'off', '关了不发')
  // 间隔：由 nextAt 决定（随机 25~90 分钟），不再读任何配置
  const sent = reach.onSent({ lastAt: 0, day: '', count: 0 }, NOW, { rand: () => 0 })   // 抽最短
  assert.equal(sent.nextAt, NOW + reach.GAP_MIN_MS, 'rand=0 → 取下限')
  assert.equal(reach.shouldReach(sent, ic, { now: NOW + 5 * 60000, connected: true }).why, 'cooldown', '刚说完不追')
  assert.equal(reach.shouldReach(sent, ic, { now: NOW + 26 * 60000, connected: true }).ok, true, '过了最短间隔就放行')
  // 老记录没有 nextAt：退回「至少 GAP_MIN_MS」
  assert.equal(reach.shouldReach({ lastAt: NOW - 60e3 }, ic, { now: NOW, connected: true }).why, 'cooldown')
  assert.equal(reach.shouldReach({ lastAt: NOW - 30 * 60000 }, ic, { now: NOW, connected: true }).ok, true)
})

test('没有「每天最多几条」：今天已经发了很多次，照发', () => {
  const ic = { reachOn: true, ownerAccounts: ['10086'] }
  const day = new Date(NOW).toDateString()
  assert.equal(
    reach.shouldReach({ lastAt: 0, nextAt: 0, day, count: 99 }, ic, { now: NOW, connected: true }).ok,
    true, '用户 11-02：不用在意多少条')
})

test('随机间隔在区间内，且不是固定值（随机发，不是闹钟）', () => {
  for (let i = 0; i < 200; i++) {
    const g = reach.randomGap()
    assert.ok(g >= reach.GAP_MIN_MS && g <= reach.GAP_MAX_MS, '间隔跑出区间了：' + g)
  }
  const seen = new Set()
  for (let i = 0; i < 50; i++) seen.add(reach.randomGap())
  assert.ok(seen.size > 20, '50 次只抽到 ' + seen.size + ' 种间隔，看起来不像随机')
  assert.equal(reach.randomGap(() => 0), reach.GAP_MIN_MS)
  assert.equal(reach.randomGap(() => 1), reach.GAP_MAX_MS)
  assert.equal(reach.randomGap(() => NaN), Math.round((reach.GAP_MIN_MS + reach.GAP_MAX_MS) / 2), '坏随机源兜底成中间值')
})

test('shouldReach：时段改由「全时段 / 谷时」策略决定（0.45.93 取代硬编码的凌晨静默）', () => {
  const base = { reachOn: true, ownerAccounts: ['10086'] }
  const d = new Date(NOW)
  d.setHours(3, 0, 0, 0)
  const night = d.getTime()
  // 全时段（默认）：凌晨 3 点也能发 —— 用户 11-02 明确要「全时段可发」
  assert.equal(reach.shouldReach({}, base, { now: night, connected: true }).ok, true, '全时段模式下凌晨也可以')
  // 谷时：窗口外不发，窗口内照发（跨零点）
  const valley = { ...base, reachWindowMode: 'valley', reachValleyFrom: '23:00', reachValleyTo: '08:00' }
  assert.equal(reach.shouldReach({}, valley, { now: night, connected: true }).ok, true, '凌晨 3 点属于谷时窗口')
  d.setHours(23, 30, 0, 0)
  assert.equal(reach.shouldReach({}, valley, { now: d.getTime(), connected: true }).ok, true, '23:30 在谷时窗口里')
  d.setHours(9, 0, 0, 0)
  assert.equal(reach.shouldReach({}, valley, { now: d.getTime(), connected: true }).why, 'outside-window', '早上 9 点已经出了谷时窗口')
  d.setHours(15, 0, 0, 0)
  assert.equal(reach.shouldReach({}, valley, { now: d.getTime(), connected: true }).why, 'outside-window')
  // 当场承诺（晚安 / 被问「几点发」）不吃窗口
  assert.equal(reach.shouldReach({}, valley, { now: d.getTime(), connected: true, bypassWindow: true }).ok, true)
})

test('onSent：滚动计数，跨天归零（计数只用于面板，不再当上限）', () => {
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
