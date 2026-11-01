'use strict'
/**
 * 学习账本测试（0.45.69）
 *
 * 真实使用反馈：学习模式里发生过的事都要进记忆、退出后不能什么都不记得，
 * 这是底层逻辑。这组测试守的就是这条：账本必须落盘、跨天、能补收、数字是真的。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const L = require('../src/main/companion/studyLedger')

const M = 60000
/** 固定起点：2026-10-31 10:00 本地时间（跨天测试要用真实日期，不能用随机戳） */
const T0 = new Date(2026, 9, 31, 10, 0, 0).getTime()

function tmpDir () {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'study-ledger-'))
  return d
}

test('开一场 → 记抽查 → 收场：时长与计数都是真的', () => {
  const dir = tmpDir()
  const db = L.load(dir)
  L.open(db, T0, { goal: '行测、申论', targetMin: 90 })
  L.noteCheck(db, T0 + 10 * M, { v: 'study', what: '资料分析', subj: '资料分析' })
  L.noteCheck(db, T0 + 20 * M, { v: 'fun', what: 'B站番剧' })
  L.noteCheck(db, T0 + 30 * M, { v: 'idle', what: '桌面' })
  const sess = L.close(db, T0 + 45 * M)

  assert.equal(sess.min, 45, '45 分钟后收场就是 45 分钟')
  assert.equal(sess.checks, 3)
  assert.equal(sess.focus, 1)
  assert.equal(sess.fun, 1)
  assert.equal(sess.idle, 1)

  const sum = L.summary(db, T0 + 46 * M)
  assert.match(sum, /45 分钟/)
  assert.match(sum, /行测、申论/)
  assert.match(sum, /查了 3 次/)
  assert.match(sum, /在玩 1 次/)
})

test('落盘：换一个进程/重新 load 还在（这是「退出后还记得」的物理基础）', () => {
  const dir = tmpDir()
  const db = L.load(dir)
  L.open(db, T0, { goal: '申论', targetMin: 60 })
  L.noteCheck(db, T0 + 10 * M, { v: 'fun', what: '在打游戏' })
  L.close(db, T0 + 30 * M)

  const again = L.load(dir)          // 相当于下次启动重新读文件
  const sum = L.summary(again, T0 + 31 * M)
  assert.match(sum, /30 分钟/)
  assert.match(sum, /在玩 1 次/)
  assert.ok(fs.existsSync(L.file(dir)))
})

test('跨天分桶：昨天的不会被今天的覆盖', () => {
  const dir = tmpDir()
  const db = L.load(dir)
  L.open(db, T0, { goal: '行测', targetMin: 60 })
  L.close(db, T0 + 50 * M)

  const nextDay = T0 + 24 * 60 * M
  L.open(db, nextDay, { goal: '申论', targetMin: 120 })
  L.close(db, nextDay + 70 * M)

  const d1 = db.days['2026-10-31']
  const d2 = db.days['2026-11-01']
  assert.ok(d1 && d2, '两天各一个桶')
  assert.equal(d1.studyMin, 50)
  assert.equal(d2.studyMin, 70)
  const recent = L.recentText(db, nextDay + M, 3)
  assert.match(recent, /2026-10-31/)
  assert.match(recent, /2026-11-01/)
})

test('补时：累加到当天目标里，也记在当天账上', () => {
  const dir = tmpDir()
  const db = L.load(dir)
  L.open(db, T0, { goal: '行测', targetMin: 90 })
  L.addPenalty(db, T0 + 10 * M, 5)
  L.addPenalty(db, T0 + 20 * M, 5)
  const d = L.day(db, T0)
  assert.equal(d.penaltyMin, 10)
  assert.equal(d.targetMin, 100, '90 + 两次补时 = 100')
  assert.equal(d.active.targetMin, 100, '正在进行的这场也要跟着延')
  assert.match(L.summary(db, T0 + 21 * M), /补了 10 分钟/)
})

test('申论字数：记次数与最近一次字数', () => {
  const dir = tmpDir()
  const db = L.load(dir)
  L.open(db, T0, { goal: '申论' })
  L.noteEssay(db, T0 + 5 * M, { words: 320, target: 1000, short: true })
  L.noteEssay(db, T0 + 25 * M, { words: 480, target: 1000, short: true })
  const d = L.day(db, T0)
  assert.equal(d.essay.checks, 2)
  assert.equal(d.essay.short, 2)
  assert.equal(d.essay.words, 480)
  assert.match(L.summary(db, T0 + 26 * M), /申论字数不够 2 次/)
})

test('上一场没收场就开新场：旧的按最后一次抽查结算，不能凭空消失', () => {
  const dir = tmpDir()
  const db = L.load(dir)
  L.open(db, T0, { goal: '行测', targetMin: 60 })
  L.noteCheck(db, T0 + 20 * M, { v: 'study' })
  // 没 close，直接再开一场
  L.open(db, T0 + 60 * M, { goal: '申论', targetMin: 90 })

  const d = L.day(db, T0)
  assert.equal(d.sessions.length, 1)
  assert.equal(d.sessions[0].aborted, true)
  assert.equal(d.sessions[0].min, 20, '结算到「最后一次抽查」那一刻')
  assert.equal(d.studyMin, 20)
  assert.equal(d.active.goal, '申论')
})

test('dangling：跨天也能找到没结束的那一场（昨晚关机、今早启动）', () => {
  const dir = tmpDir()
  const db = L.load(dir)
  L.open(db, T0, { goal: '行测', targetMin: 60 })
  L.noteCheck(db, T0 + 40 * M, { v: 'study' })

  const nextDay = T0 + 24 * 60 * M
  const dg = L.dangling(db)
  assert.ok(dg, '昨天那场必须能找回来')
  assert.equal(dg.goal, '行测')
  assert.equal(dg.checks, 1)

  // 补收：按 lastAt 结算（不能按「现在」算成 24 小时）
  const sess = L.close(db, dg.lastAt)
  assert.equal(sess.min, 40)
  assert.equal(L.dangling(db), null)
})

test('summary：没学过的一天不瞎报', () => {
  const dir = tmpDir()
  const db = L.load(dir)
  assert.equal(L.summary(db, T0), '', '什么都没发生就不该有账')
})

test('明细最多留 MAX_CHECKS 条（文件不会无限长）', () => {
  const dir = tmpDir()
  const db = L.load(dir)
  L.open(db, T0, { goal: '行测' })
  for (let i = 0; i < L.MAX_CHECKS + 30; i++) L.noteCheck(db, T0 + i * 1000, { v: 'study' })
  const d = L.day(db, T0)
  assert.equal(d.checks.length, L.MAX_CHECKS)
  assert.equal(d.active.checks, L.MAX_CHECKS + 30, '计数不能跟着截断')
})
