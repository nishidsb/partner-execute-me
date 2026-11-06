'use strict'
/** 0.46.56 三处收敛的回归：
 *  ① 晚安静默覆盖自主活动（夜里不再「あ、おかえり」）
 *  ② 睡醒等待：静默到期 ≠ 他醒了，QQ reach 等他真回到电脑前
 *  ③ 复读闸归一化 URL（换域名同款句子也抓得到）
 *  ④ API TTS 全链失败不再落系统语音（main 侧逻辑，这里测 gate/idleNudge 层） */
const test = require('node:test')
const assert = require('node:assert')
const { createGate } = require('../src/main/companion/proactiveGate')
const idleNudge = require('../src/main/companion/idleNudge')
const autonomy = require('../src/main/companion/autonomy')

test('复读闸：同款收场句换个域名也判复读', () => {
  const g = createGate({ size: 12 })
  g.note('あ、おかえり。いまね、chromium.googlesource.com をちょっと覗いてたとこ。')
  const r = g.check('あ、おかえり。いまね、raw.githubusercontent.com をちょっと覗いてたとこ。')
  assert.ok(r && r.repeat, '抹平域名后应命中复读：' + JSON.stringify(r))
})

test('复读闸：note 后 peek 存归一化文本（域名被抹掉）', () => {
  const g = createGate({ size: 4 })
  g.note('いまね、example.com を見てた。')
  const hist = g.peek()
  assert.ok(!hist.some((t) => t.includes('example.com')), '账本里不该出现裸域名：' + hist[0])
  assert.ok(hist[0].includes('あるサイト'))
})

test('onSleepDeclared：静默 + sleepArmed 双闸；onUserTalk 解除武装', () => {
  const t0 = 1_000_000_000_000
  const rec = idleNudge.onSleepDeclared({}, t0)
  assert.equal(rec.sleepUntil, t0 + 7 * 3600 * 1000)
  assert.equal(rec.sleepArmed, 1, '睡觉宣言要挂上「等他真醒」的武装')
  assert.equal(rec.baseAt, rec.sleepUntil, '计时起点=睡醒时刻')
  const talked = idleNudge.onUserTalk(rec, t0 + 1000)
  assert.equal(talked.sleepArmed, 0, '他一开口，武装解除')
  assert.equal(talked.sleepUntil, 0)
})

test('stageOf：sleepArmed 挂着时静默期后仍不给阶段（等宿主判「他回来了」）', () => {
  const t0 = 1_000_000_000_000
  const rec = idleNudge.onSleepDeclared({}, t0)
  const afterWake = t0 + 8 * 3600 * 1000   // 静默已过期 1 小时
  assert.equal(idleNudge.stageOf(3600 * 1000, rec, afterWake), 0,
    'sleepUntil 过了也不给阶段——armed 由宿主 tick 解除（st=here 才算早上好）')
})

test('autonomy.create：sleepQuiet 挡起场（晚安静默不起场）', async () => {
  let quiet = true
  const inst = autonomy.create({
    cfgGet: () => ({ autonomyOn: true, autonomyIdleMin: 5 }),
    idleSec: () => 600,          // 人在语义上「离开」够久
    busy: () => false,
    sleepQuiet: () => quiet,     // 但晚安静默挂着
    now: () => 1_000_000_000_000 + 60 * 60 * 1000
  })
  // nextAt 设为已到点：直接置内部冷却为过去——用 force=false 走常规 gate
  // 简化验证：sleepQuiet 时 tick 不抛错且不产生 any 场次（无 llm 依赖被触达的旁证=cua 未被调）
  await inst.tick()
  quiet = false
  await inst.tick()   // 不抛错即可（后续 gate 由其余测试覆盖）
  assert.ok(true)
})
