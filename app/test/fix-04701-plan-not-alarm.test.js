'use strict'
/**
 * 0.47.1 · 定时硬触发设计全退役（主人 20:0x 拍板）
 *
 * 原话：「我觉得这些闹钟也不该设置，因为人是多变的，情况一般都赶不上变化，
 *        设置闹钟这个行为挺蠢的。可以口头提醒，但闹钟这种是个弱智设计」
 *       +「所有类似的这种闹钟设计都不该有」。
 *
 * 语义裁定（§1.0 底层要求落地方）：
 *   闹钟/排期 = 把计划固化成硬触发 = 把她变回「被调用的 API」。
 *   时间相关一律 = 约定进记忆（带绝对日期锚点）+ 到点看情况（duePlan 供料，她自己判断提不提）。
 *
 * 这里锁四件事：
 *   ① 模型侧端口全关（alarm 三工具 + qq_plan 三工具 + QQ 大脑白名单）
 *   ② 到点不直接开口（no pet:alarm / no Notification / no sayProactive，只入账 duePlan）
 *   ③ duePlan 两个消费端接好（chatter decide 自主判断 + 回复 [ctx] 顺路看），
 *      说出口即收账；窗口过期咽回去进念头池（想说说没说）
 *   ④ QQ 排期定时器退役 + 旧数据启动清账
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('①模型侧定时端口全关', () => {
  for (const f of ['src/assistant/core/tools/reach.js', 'src/assistant/core/tools/index.js']) {
    const s = read(f)
    for (const bad of ["name: 'alarm_set'", "name: 'alarm_list'", "name: 'alarm_cancel'",
      "name: 'qq_plan'", "name: 'qq_plan_list'", "name: 'qq_plan_cancel'"]) {
      assert.ok(!s.includes(bad), f + ' 不许再有 ' + bad)
    }
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'src/assistant/core/tools/alarm.js')), 'alarm.js 工具文件已删')
  const brain = read('src/main/im/brain.js')
  for (const bad of ['alarm_set', 'alarm_list', 'alarm_cancel']) {
    assert.ok(!brain.includes(bad), 'QQ 大脑白名单不含 ' + bad)
  }
})

test('②到点不直接开口：闹钟的仪式感全撤（气泡/通知/强制说话）', () => {
  const host = read('src/main/companion/index.js')
  assert.ok(!/async function alarmLine /.test(host), 'alarmLine 已退役')
  assert.ok(!host.includes("bcast('pet:alarm'"), '不再弹 ⏰ 气泡')
  const fire = host.slice(host.indexOf('onFire: (a) => {'), host.indexOf('alarmAdd'))
  assert.ok(fire.includes('setDuePlan(a)'), '到点只入账约定候选')
  assert.ok(!fire.includes('sayProactive') && !fire.includes('Notification'), 'onFire 里不许有开口/通知')
  // 引擎本身（parseTime/nextFireAt/planDue）保留——约定还是要知道「什么时候到点」
  const eng = read('src/main/companion/alarms.js')
  assert.ok(eng.includes('function planDue'), '引擎保留（到点判定仍需要）')
})

test('③duePlan 两个消费端 + 收账闭环', () => {
  const host = read('src/main/companion/index.js')
  // chatter 端：供料 + 说出口收账
  assert.ok(/duePlan: \(\) => \{ try \{ return duePlanBlock\('chatter'\)/.test(host), 'chatter deps 有 duePlan')
  assert.ok(/consumeDuePlan: \(why\) => \{ try \{ clearDuePlan\(why/.test(host), 'chatter deps 有 consumeDuePlan')
  // 回复端：mode='reply' 注入即消费（不 nag）
  assert.ok(/duePlanBlock\('reply'\)/.test(host), '回复链注入约定')
  assert.ok(host.includes("if (mode === 'reply') duePlan.consumed = true"), '回复看过即消费')
  // 过期收账：咽回去进念头池
  assert.ok(/function sweepDuePlan [\s\S]*?noteSuppress/.test(host), '过期咽回去进念头池')
  assert.ok(/sweepDuePlan\(\)\s+\/\/ 0\.47\.1/.test(host) || host.includes('sweepDuePlan() '), 'nudge 定时器里挂了扫账')
  // 一本账红线：duePlan 不许自开说话出口（只允许在 chatter/回复里被消费）
  assert.ok(!/sayProactive\([^)]*due/i.test(host), 'duePlan 不许直连 sayProactive（开口只走 rhythm 一本账）')
  const chatter = read('src/main/companion/chatter.js')
  assert.ok(chatter.includes('const duePlan = deps.duePlan ||'), 'chatter 接了 duePlan dep')
  assert.ok(/consumeDuePlan\('decide-speak'\)/.test(chatter), '她开口了 → 约定收账')
})

test('④QQ 排期定时器退役 + 旧数据清账', () => {
  const host = read('src/main/companion/index.js')
  assert.ok(!host.includes('tickReachPlans'), '到点发排期的定时循环已删')
  assert.ok(!host.includes('startReachPlans'), '启动挂载已删')
  assert.ok(!host.includes('qqPlanAdd'), '排一条的入口已删')
  assert.ok(host.includes('function migrateRetiredPlans'), '旧排期数据启动清账（留 .bak-0.47.1）')
  assert.ok(/qqReachPrompt[\s\S]*?没有定时任务替你兑现/.test(host), '她的提示词明确「不许排定时任务」')
})
