/**
 * 0.45.93 主动 QQ 消息：时段策略 + 计划队列
 *
 * 用户 11-02 的需求：
 *   「让角色可以主动发 qq 消息」
 *   「需要有选项是谷价可发和全时段可发，这都需要有对应的功能不只是选项」
 *   「在我这边或者角色那边主动提起什么时候会主动给我发 qq 消息的时候也会发。这个不用在意谷价还是峰价」
 *
 * 这里锁住三件事：
 *   ① 两种模式真的改变行为（不是摆设）
 *   ② 谷时窗口跨零点算得对（23:00→08:00 不能变成「永远发不出去」）
 *   ③ 排好的计划到点会被挑出来，过期太久的不会被翻旧账
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const plan = require(path.join(ROOT, 'src', 'main', 'companion', 'reachPlan.js'))
const reach = require(path.join(ROOT, 'src', 'main', 'companion', 'reach.js'))
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const at = (h, m) => { const d = new Date(2026, 10, 2, h, m || 0, 0, 0); return d.getTime() }

test('①全时段：任何时间都能发（默认就是它，别让「能发」变成摆设）', () => {
  const ic = { reachWindowMode: 'all' }
  for (const h of [3, 9, 14, 22, 23]) {
    assert.equal(plan.windowOk(ic, at(h, 30)).ok, true, h + ' 点应该可以发')
  }
  assert.equal(plan.windowOk({}, at(3, 0)).mode, 'all', '没配过就是全时段')
})

test('②谷时：只在窗口内发，跨零点也算得对', () => {
  const ic = { reachWindowMode: 'valley', reachValleyFrom: '23:00', reachValleyTo: '08:00' }
  assert.equal(plan.windowOk(ic, at(23, 30)).ok, true, '23:30 在谷时里')
  assert.equal(plan.windowOk(ic, at(3, 0)).ok, true, '凌晨 3 点也在谷时里（跨零点）')
  assert.equal(plan.windowOk(ic, at(7, 59)).ok, true)
  assert.equal(plan.windowOk(ic, at(8, 0)).ok, false, '8:00 整应该已经出窗口')
  assert.equal(plan.windowOk(ic, at(15, 0)).ok, false, '下午不在谷时里')
  const w = plan.windowOk(ic, at(15, 0))
  assert.equal(w.why, 'outside-window')
  assert.equal(w.window, '23:00–08:00')
})

test('③谷时窗口跨零点时，msUntilWindow 不能给出 0（那是「已经在窗口里」的意思）', () => {
  const ic = { reachWindowMode: 'valley', reachValleyFrom: '23:00', reachValleyTo: '08:00' }
  const ms = plan.msUntilWindow(ic, at(15, 0))
  assert.ok(ms > 7 * 3600e3 && ms <= 9 * 3600e3, '15:00 到 23:00 约 8 小时，实际 ' + Math.round(ms / 3600e3) + 'h')
  assert.equal(plan.msUntilWindow(ic, at(23, 30)), 0, '已经在窗口里就是 0')
})

test('④shouldReach 吃时段策略；「当场承诺」可以绕过窗口', () => {
  const ic = {
    reachOn: true,
    ownerAccounts: ['10001'],
    reachWindowMode: 'valley',
    reachValleyFrom: '23:00',
    reachValleyTo: '08:00'
  }
  const rec = { lastAt: 0, day: '', count: 0 }
  const out = reach.shouldReach(rec, ic, { now: at(15, 0), connected: true })
  assert.equal(out.ok, false)
  assert.equal(out.why, 'outside-window', '下午不该发')
  // 话题被提起→当场发：不吃时段
  const bye = reach.shouldReach(rec, ic, { now: at(15, 0), connected: true, bypassWindow: true })
  assert.equal(bye.ok, true, 'bypassWindow 应该放行')
  assert.equal(bye.uid, '10001')
  // 窗口内正常发
  assert.equal(reach.shouldReach(rec, ic, { now: at(23, 30), connected: true }).ok, true)
  // 节奏照旧（0.45.97：随机 25~90 分钟，不再是配置里的固定 120）
  const sent = reach.onSent(rec, at(23, 30), { rand: () => 0 })
  assert.equal(reach.shouldReach(sent, ic, { now: at(23, 40), connected: true }).why, 'cooldown')
  assert.equal(reach.shouldReach(sent, ic, { now: at(23, 30) + 26 * 60000, connected: true }).ok, true)
  // 没连上 / 没主人号：永远不发
  assert.equal(reach.shouldReach(rec, ic, { now: at(23, 30), connected: false }).why, 'disconnected')
  assert.equal(reach.shouldReach(rec, { ownerAccounts: [] }, { now: at(23, 30), connected: true }).why, 'no-owner')
})

test('⑤排一条计划：时间必须合理，"22:30" 这类由宿主解析', () => {
  const now = at(21, 0)
  const bad = plan.addPlan([], { at: now - 1000, text: '晚了' }, now)
  assert.equal(bad.ok, false, '过去的时间要拒绝')
  const empty = plan.addPlan([], { at: now + 3600e3 }, now)
  assert.equal(empty.ok, false, 'text/note 都没有要拒绝')
  const ok = plan.addPlan([], { at: now + 3600e3, text: '我一会儿找你', ignoreWindow: true }, now)
  assert.equal(ok.ok, true)
  assert.equal(ok.plan.ignoreWindow, true)
  assert.equal(ok.list.length, 1)
  // 排满上限
  let list = []
  for (let i = 0; i < plan.MAX_PLANS; i++) list = plan.addPlan(list, { at: now + (i + 1) * 60000, text: 'x' + i }, now).list
  assert.equal(plan.addPlan(list, { at: now + 999 * 60000, text: 'y' }, now).ok, false)
})

test('⑥到点挑出来发；过期超过两小时的不补发；没到点的留着', () => {
  const now = at(22, 0)
  const list = [
    { id: 'a', at: now - 60e3, text: '到点了' },
    { id: 'b', at: now + 60e3, text: '还早' },
    { id: 'c', at: now - 3 * 3600e3, text: '昨晚的旧账' }
  ]
  const r = plan.duePlans(list, now)
  assert.deepEqual(r.due.map((p) => p.id), ['a'], '只发到点的，且不补发太旧的')
  assert.deepEqual(r.rest.map((p) => p.id), ['b'])
})

test('⑦宿主真的接上了：仓里存在工具/桥/提示词/设置项', () => {
  const comp = read('src/main/companion/index.js')
  assert.match(comp, /async function qqSendNow/, '要有「立刻发」')
  assert.match(comp, /async function qqPlanAdd/, '要有「排一条」')
  assert.match(comp, /function startReachPlans/, '要有到点检查的定时器')
  assert.match(comp, /function qqReachPrompt/, '要给她一份「我能主动发」的说明')

  const bridge = read('src/main/petBridge.js')
  assert.match(bridge, /case 'qq_send'/)
  assert.match(bridge, /case 'qq_plan'/)

  const tool = read('src/assistant/core/tools/reach.js')
  for (const n of ['qq_send', 'qq_plan', 'qq_plan_list', 'qq_plan_cancel']) {
    assert.ok(tool.includes('name: ' + "'" + n + "'"), '缺少工具 ' + n)
  }

  const main = read('src/main/main.js')
  assert.match(main, /addWorldPrompts\(\(\) => require\('\.\/companion'\)\.qqReachPrompt\(\)\)/, '提示词必须注入，否则她还是会去翻目录猜')

  const brain = read('src/main/im/brain.js')
  assert.match(brain, /reachWindowMode: 'all'/, '默认全时段（先保证能发）')
  assert.match(brain, /reachValleyFrom: '23:00'/)
  const html = read('src/renderer/companion/index.html')
  assert.match(html, /id="imReachWindow"/, '设置页要有「什么时候可以主动发」')
  assert.match(html, /value="valley"/, '要有谷时选项')
  assert.match(html, /value="all"/, '要有全时段选项')
})

test('⑤「当场承诺」也免冷却（0.46.67）：屏幕刚开过口，晚安 QQ 不再被共用账本顶掉', () => {
  const ic = { reachOn: true, ownerAccounts: ['10001'], reachWindowMode: 'all' }
  // 11-06 晚实锤复现：屏幕 00:19 刚开口 → nextAt 推到 ~01:00，00:30 主人道晚安
  const rec = { lastAt: at(0, 19), nextAt: at(0, 19) + 45 * 60000, day: new Date(at(0, 30)).toDateString(), count: 3 }
  const blocked = reach.shouldReach(rec, ic, { now: at(0, 30), connected: true })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.why, 'cooldown', '普通路径仍受冷却约束（防滥用）')
  const bye = reach.shouldReach(rec, ic, { now: at(0, 30), connected: true, bypassWindow: true, bypassCooldown: true })
  assert.equal(bye.ok, true, '晚安承诺（bypassCooldown）应该放行')
  assert.equal(bye.uid, '10001')
  // 免冷却不等于免安全边界：掉线/没配主人/关了开关照样拒
  assert.equal(reach.shouldReach(rec, ic, { now: at(0, 30), connected: false, bypassCooldown: true }).why, 'disconnected')
  assert.equal(reach.shouldReach(rec, ic, { now: at(0, 30), connected: true, bypassCooldown: true, }).ok, true)
  assert.equal(reach.shouldReach(rec, { reachOn: false }, { now: at(0, 30), connected: true, bypassCooldown: true }).why, 'off')
})
