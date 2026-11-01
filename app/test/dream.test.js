/**
 * 做梦门槛（dream.shouldDream）回归
 *
 * 0.45.0 真机踩中：判重用 toISOString()（UTC 日期），GMT+8 凌晨 0 点后
 * 本地日期已经是「明天」而 UTC 还是「今天」，already-today 永远拦不住，
 * 加上 sleepWantedAt 不清零 → 每分钟连环做一场梦、连发好几条「我做了个梦」。
 */
const test = require('node:test')
const assert = require('node:assert')

const dream = require('../src/main/companion/dream')

function pad (n) { return String(n).padStart(2, '0') }
function localDate (ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 找一个「本地日期 ≠ UTC 日期」的时刻（UTC 时区永远找不到，返回 0 跳过用例） */
function findTzMismatch (from) {
  let t = from
  for (let i = 0; i < 36 * 60; i++) {
    t += 60 * 1000
    if (localDate(t) !== new Date(t).toISOString().slice(0, 10)) return t
  }
  return 0
}

test('dream: 同一个本地日已经做过 → sleep/idle/boot 都不再做', () => {
  const now = Date.now()
  const last = now - 60 * 1000
  for (const reason of ['sleep', 'idle', 'boot']) {
    const r = dream.shouldDream({
      now, lastDreamAt: last, today: localDate(last), reason,
      cfg: {}, evCount: 5, idleMs: 0,
      sleepWantedAt: now - 11 * 60 * 1000, bootAt: now - 60 * 60 * 1000
    })
    assert.equal(r.why, 'already-today', reason + ' 也要被「今天做过」拦住')
  }
})

test('dream: 凌晨时区错位（本地日期≠UTC日期）也不许连环做梦', () => {
  const t = findTzMismatch(Date.now())
  if (!t) return // UTC 时区没有错位窗口，本用例不适用
  const last = t - 60 * 1000
  const r = dream.shouldDream({
    now: t, lastDreamAt: last, today: localDate(last), reason: 'sleep',
    cfg: {}, evCount: 5, idleMs: 0, sleepWantedAt: t - 11 * 60 * 1000
  })
  assert.equal(r.why, 'already-today', 'UTC 日期还停在「昨天」也必须拦住（0.45.0 连环做梦回归）')
})

test('dream: 说过晚安安静满 10 分钟 → 做睡前梦（今天没做过时）', () => {
  const now = Date.now()
  const r = dream.shouldDream({
    now, lastDreamAt: 0, today: localDate(now), reason: 'sleep',
    cfg: {}, evCount: 5, idleMs: 0, sleepWantedAt: now - 11 * 60 * 1000
  })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'sleep')
})

test('dream: manual 手动重试不受「今天做过」限制', () => {
  const now = Date.now()
  const last = now - 60 * 1000
  const r = dream.shouldDream({
    now, lastDreamAt: last, today: localDate(last), reason: 'manual',
    cfg: {}, evCount: 5, idleMs: 0
  })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'manual')
})
