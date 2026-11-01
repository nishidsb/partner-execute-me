'use strict'
/** 0.22.0 补丁⑧ 学习模式状态机测试 */
const test = require('node:test')
const assert = require('node:assert')
const study = require('../src/main/companion/study.js')

const M = 60 * 1000
const T0 = 1730000000000 // 固定时钟起点

test('start：默认节奏 45+10×3，第 1 轮学习中，开口说开场', () => {
  const st = study.start({}, T0)
  assert.equal(st.phase, 'study')
  assert.equal(st.round, 1)
  assert.equal(st.rounds, 3)
  assert.equal(st.lenMin, 45)
  assert.equal(st.brkMin, 10)
  assert.equal(st.phaseEndsAt - T0, 45 * M)
  assert.equal(st.say, 'start')
  assert.equal(study.active(st), true)
})

test('normCfg：数字越界收拢，非法回默认（可自由调但有护栏）', () => {
  const c = study.normCfg({ studyMinutes: 999, studyBreak: -3, studyRounds: 'abc' })
  assert.equal(c.studyMinutes, 240)
  assert.equal(c.studyBreak, 1)
  assert.equal(c.studyRounds, study.DEFAULTS.studyRounds)
  assert.deepEqual(study.normCfg(null), study.DEFAULTS)
})

test('tick：查岗 15 分钟一问，misses 升级 normal→worried，说话清零（60 分轮次才有第 3 次机会）', () => {
  const cfg = { studyMinutes: 60, studyBreak: 5, studyRounds: 2 }
  let st = study.start(cfg, T0)
  // 15 分钟到点 → 第 1 次（normal）
  st = study.tick(st, cfg, T0 + 15 * M)
  assert.equal(st.say, 'check_normal')
  assert.equal(st.misses, 1)
  // 30 分钟 → worried
  st = study.tick(st, cfg, T0 + 30 * M)
  assert.equal(st.say, 'check_worried')
  assert.equal(st.misses, 2)
  // 主人回应 → 清零，再过 15 分钟又是 normal
  st = study.onUserTalk(st, T0 + 31 * M)
  assert.equal(st.misses, 0)
  st = study.tick(st, cfg, T0 + 46 * M)
  assert.equal(st.say, 'check_normal')
})

test('tick：查岗避让本轮结束前 10 分钟（问了白问）', () => {
  // 45 分钟的轮次：40 分处 due 早已过，但 40+10 ≥ 45 → 忍着不查
  const st0 = study.start({}, T0)
  const st = study.tick(st0, {}, T0 + 40 * M)
  assert.equal(st, null)
  // 但到 45 分 → 休息（break_start）
  const brk = study.tick(st0, {}, T0 + 45 * M)
  assert.equal(brk.phase, 'break')
  assert.equal(brk.say, 'break_start')
})

test('tick：轮次流转 study→break→study→…→最后一轮结束 done', () => {
  const cfg = { studyMinutes: 25, studyBreak: 5, studyRounds: 2 }
  let st = study.start(cfg, T0)
  // 第 1 轮结束 → 休息
  st = study.tick(st, cfg, T0 + 25 * M)
  assert.equal(st.phase, 'break')
  assert.equal(st.round, 1)
  assert.equal(st.phaseEndsAt - (T0 + 25 * M), 5 * M)
  // 休息中不查岗
  assert.equal(study.tick(st, cfg, T0 + 28 * M), null)
  // 休息结束 → 第 2 轮
  st = study.tick(st, cfg, T0 + 30 * M)
  assert.equal(st.phase, 'study')
  assert.equal(st.round, 2)
  assert.equal(st.say, 'study_resume')
  // 第 2 轮结束 → 收工
  st = study.tick(st, cfg, T0 + 55 * M)
  assert.equal(st.phase, 'done')
  assert.equal(st.say, 'all_done')
  // done 后 tick 永远无事
  assert.equal(study.tick(st, cfg, T0 + 60 * M), null)
  assert.equal(study.active(st), false)
})

test('防翻车：退避期不说话；失败退避、成功清退避', () => {
  let st = study.start({}, T0)
  st = study.tick(st, {}, T0 + 15 * M)
  assert.equal(st.say, 'check_normal')
  const failed = study.onFail(st, T0 + 15 * M)
  assert.equal(failed.nextTryAt, T0 + 15 * M + 5 * M)
  // 退避期内即使查岗到点也不说
  assert.equal(study.tick(failed, {}, T0 + 18 * M), null)
  // 成功 → 清退避，下一次查岗到点恢复说话
  const ok = study.onSent(failed, T0 + 20 * M)
  const again = study.tick(ok, {}, T0 + 30 * M)
  assert.ok(again && again.say)
})

test('stop：中途退出温柔收场，done 后再 stop 无事', () => {
  let st = study.start({}, T0)
  st = study.stop(st, T0 + 20 * M)
  assert.equal(st.phase, 'done')
  assert.equal(st.say, 'quit')
  assert.equal(study.stop(st, T0 + 21 * M), st) // 原样返回
})

test('fillHint：占位符全填上，quit 的 mins 按 roundStartedAt 算', () => {
  const cfg = { studyMinutes: 25, studyBreak: 5, studyRounds: 2 }
  let st = study.start(cfg, T0)
  st = study.stop(st, T0 + 20 * M)
  const hint = study.fillHint('quit', st)
  assert.ok(hint.includes('20'), 'quit 提示含本轮已学 20 分钟')
  assert.ok(hint.includes('2'), '含轮次')
  // check 用当前时间（60 分轮次避开结束前避让窗口）
  const cfg2 = { studyMinutes: 60, studyBreak: 5, studyRounds: 2 }
  st = study.start(cfg2, T0)
  st = study.tick(st, cfg2, T0 + 15 * M)
  assert.ok(study.fillHint('check_normal', st, T0 + 15 * M).includes('15'))
})

test('会话互斥接口：active 只在 study/break 为真', () => {
  assert.equal(study.active(null), false)
  assert.equal(study.active({}), false)
  assert.equal(study.active({ phase: 'study' }), true)
  assert.equal(study.active({ phase: 'break' }), true)
  assert.equal(study.active({ phase: 'done' }), false)
})
