'use strict'
/** 第 1 期：审查队列 + 做梦触发/解析 + 风格样本池（纯函数部分） */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const review = require('../src/main/companion/review')
const dream = require('../src/main/companion/dream')
const styleMod = require('../src/main/companion/style')

const T0 = new Date('2026-10-27T10:00:00').getTime()
const M = 60 * 1000

/* ---------------- review ---------------- */

test('review：入队/去重（同键 pending 票数+1 不重复）', () => {
  let items = []
  const r1 = review.enqueue(items, { kind: 'habit', what: '陪主人熬夜', payload: '陪主人熬夜' }, T0)
  assert.equal(r1.dup, false)
  items = r1.items
  const r2 = review.enqueue(items, { kind: 'habit', what: '陪主人熬夜 ', payload: '陪主人熬夜' }, T0 + M)
  assert.equal(r2.dup, true)
  assert.equal(r2.item.votes, 2)
  assert.equal(items.length, 1)
})

test('review：批准→落地登记→按条回滚（真实文件快照还原）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-review-'))
  const target = path.join(dir, 'self', 'habits.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify([{ desc: '旧习惯', strength: 0.5 }]), 'utf8')
  let items = review.enqueue([], { kind: 'habit', what: '新习惯', payload: '新习惯' }, T0).items
  const d = review.decide(items, items[0].id, 'approve', T0 + M)
  assert.equal(d.item.status, 'approved')
  items = review.markApplied(d.items, items[0].id, [{ path: target, content: fs.readFileSync(target, 'utf8') }], T0 + 2 * M).items
  assert.equal(items[0].status, 'applied')
  // 模拟落地后文件变了
  fs.writeFileSync(target, JSON.stringify([{ desc: '旧习惯', strength: 0.5 }, { desc: '新习惯' }]), 'utf8')
  const rb = review.rollback(items, items[0].id, T0 + 3 * M)
  assert.ok(!rb.error)
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).length, 1)
  assert.equal(rb.item.status, 'rolled')
  // 再滚一次：不是 applied 了，拒绝
  assert.ok(review.rollback(rb.items, items[0].id).error)
})

test('review：pending 只列 pending，recent 排序 applied 在前', () => {
  let items = review.enqueue([], { kind: 'habit', what: 'A' }, T0).items
  items = review.enqueue(items, { kind: 'taste', what: 'B' }, T0 + M).items
  items = review.enqueue(items, { kind: 'memory', what: 'C' }, T0 + 2 * M).items
  items = review.decide(items, items[0].id, 'approve').items
  items = review.markApplied(items, items[0].id, [], T0).items
  items = review.decide(items, items[1].id, 'reject').items
  assert.equal(review.pending(items).length, 1)
  const rec = review.recent(items, 10)
  assert.equal(rec[0].status, 'applied')
  assert.equal(rec[rec.length - 1].status, 'rejected')
})

/* ---------------- dream ---------------- */

const cfgOk = { dreamOn: true, dreamIdleHours: 3 }

test('dream：触发判定（手动/闲置/开机补偿/睡前/防重）', () => {
  const base = { today: '2026-10-27', now: T0, cfg: cfgOk, evCount: 10, hasDiary: false, busy: false, dreaming: false, lastDreamAt: 0 }
  assert.equal(dream.shouldDream({ ...base, reason: 'manual' }).ok, true)
  assert.equal(dream.shouldDream({ ...base, idleMs: 3 * 3600 * 1000 + 1 }).ok, true)
  assert.equal(dream.shouldDream({ ...base, idleMs: 2 * 3600 * 1000 }).ok, false) // 没到 3h
  // 开机补偿：开机 30 分钟 + 距上次做梦 ≥24h
  assert.equal(dream.shouldDream({ ...base, bootAt: T0 - 31 * M, lastDreamAt: T0 - 25 * 3600 * 1000 }).ok, true)
  assert.equal(dream.shouldDream({ ...base, bootAt: T0 - 10 * M, lastDreamAt: T0 - 25 * 3600 * 1000 }).ok, false) // 开机不够 30 分
  // 睡前：说过晚安 10 分钟后
  assert.equal(dream.shouldDream({ ...base, sleepWantedAt: T0 - 11 * M }).ok, true)
  assert.equal(dream.shouldDream({ ...base, sleepWantedAt: T0 - 5 * M }).ok, false)
  // 今天做过了（非手动）
  assert.equal(dream.shouldDream({ ...base, lastDreamAt: T0 - 1 * M, idleMs: 9 * 3600 * 1000 }).ok, false)
  assert.equal(dream.shouldDream({ ...base, reason: 'manual', lastDreamAt: T0 - 1 * M }).ok, true) // 手动可以再做
  // 学习中/聊天中/关掉
  assert.equal(dream.shouldDream({ ...base, reason: 'idle', idleMs: 9 * 3600 * 1000, busy: true }).ok, false)
  assert.equal(dream.shouldDream({ ...base, reason: 'idle', idleMs: 9 * 3600 * 1000, cfg: { ...cfgOk, dreamOn: false } }).ok, false)
})

test('dream：素材门槛（事件 ≥5 / 有日记 / 有电脑画像）', () => {
  assert.ok(dream.materialEnough(5, false))
  assert.ok(dream.materialEnough(2, true))
  assert.ok(!dream.materialEnough(4, false))
  /* 有画像也算：聊得少的日子，那份观察也得有机会变成她的记忆 */
  assert.ok(dream.materialEnough(0, false, true))
  assert.ok(!dream.materialEnough(0, false, false))
})

test('dream：解析产出（四类标记 + [无] + 容忍废话）', () => {
  const p = dream.parseDream([
    '好的，让我想想。',
    '[习惯] 睡前会跟主人说晚安',
    '[喜欢] 热咖啡｜早上喝会开心',
    '[不喜欢] 被突然关掉｜会害怕',
    '[记] 主人答应周末一起看电影｜5',
    '[记] 主人喜欢在深夜写代码｜3',
    '以上。'
  ].join('\n'))
  assert.deepEqual(p.habits, ['睡前会跟主人说晚安'])
  assert.equal(p.likes[0].what, '热咖啡')
  assert.equal(p.likes[0].why, '早上喝会开心')
  assert.equal(p.dislikes.length, 1)
  assert.equal(p.memories.length, 2)
  assert.equal(p.memories[0].importance, 5)
  assert.equal(p.memories[1].importance, 3)
  const none = dream.parseDream('[无]')
  assert.equal(none.habits.length + none.likes.length + none.dislikes.length + none.memories.length, 0)
})

test('dream：[他] 是独立通道，不和 [记] 混在一起', () => {
  const p = dream.parseDream([
    '[他] 他在准备广东省的公务员考试｜5',
    '[他] 夜里一点半才离开电脑',
    '[记] 他答应带我出门｜5'
  ].join('\n'))
  assert.equal(p.hisFacts.length, 2)
  assert.equal(p.memories.length, 1)          // 不能把「关于他」算成共同经历
  assert.equal(p.hisFacts[0].fact, '他在准备广东省的公务员考试')
  assert.equal(p.hisFacts[0].importance, 5)
  assert.equal(p.hisFacts[1].importance, 3)   // 没写重要度时给中间值，不默认重要
  // 提示词必须把「关于他」讲清楚，否则模型只写自己的习惯（实测踩过）
  assert.ok(dream.DREAM_PROMPT.includes('[他]'))
  assert.ok(dream.DREAM_PROMPT.includes('你在他电脑上注意到的'))
})

/* ---------------- style ---------------- */

test('style：入池去重/封顶/按语言取样/组段封顶 800 字符', () => {
  let pool = []
  for (let i = 0; i < 250; i++) {
    pool = styleMod.addSample(pool, { user: 'u' + i, reply: '她的回复 ' + i, lang: 'ja', at: T0 + i }).pool
  }
  assert.equal(pool.length, 200)
  const dup = styleMod.addSample(pool, { user: 'u249', reply: '她的回复 249' })
  assert.equal(dup.dup, true)
  const picked = styleMod.pick(pool, 'zh', 4)
  assert.equal(picked.length, 4) // 没有中文样本，拿日语凑
  assert.ok(picked.every((x) => x.at >= T0 + 50)) // 都是最近的
  const sec = styleMod.buildSection(styleMod.pick(pool, '', 4))
  assert.ok(sec.length <= 800)
  assert.ok(sec.includes('她：'))
  // 无效样本拒收
  assert.ok(!styleMod.valid('', '很长很长的回复'))
  assert.ok(!styleMod.valid('好', '短'))
  assert.ok(!styleMod.valid('正常问题', '{"tool":true}'))
})
