/**
 * 0.25.0 用量页数据层（reportFromDays 纯函数）。
 * 这里只喂构造数据，不碰磁盘——记账落盘那部分由 session 侧覆盖。
 */
import test from 'node:test'
import assert from 'node:assert'
import { reportFromDays, bucketKeyOf } from '../src/assistant/core/core/usage.js'

/** 造一天：每模型一笔，可选按角色拆分 */
function day ({ model = 'm-a', prompt = 0, completion = 0, cached = 0, calls = 1, role = 'ryza' } = {}) {
  const d = {
    calls,
    prompt,
    completion,
    cached,
    byModel: { [model]: { calls, prompt, completion } },
    byRole: { [role]: { calls, prompt, completion, cached, byModel: { [model]: { calls, prompt, completion } } } }
  }
  return d
}

const PRICE_A = { inp: 2, out: 8 } // ¥/百万 tokens

test('用量报表：按日桶补齐空日，区间外的天不算进来', () => {
  const days = {
    '2026-10-01': day({ prompt: 1000000, completion: 0 }),
    '2026-10-03': day({ prompt: 0, completion: 1000000 }),
    '2026-09-30': day({ prompt: 5000000, completion: 0 }) // 区间外
  }
  const r = reportFromDays(days, {
    from: '2026-10-01', to: '2026-10-03', granularity: 'day', price: PRICE_A, currency: 'CNY'
  })
  assert.equal(r.rangeDays, 3)
  assert.equal(r.buckets.length, 3)
  assert.deepEqual(r.buckets.map((b) => b.key), ['2026-10-01', '2026-10-02', '2026-10-03'])
  assert.equal(r.buckets[1].tokens, 0, '空日要占位，不能缺格')
  assert.equal(r.totals.tokens, 2000000)
  // 100万 prompt × 2 + 100万 completion × 8 = 2 + 8 = 10 元
  assert.equal(r.totals.cost, 10)
  assert.equal(r.heat.length, 3)
})

test('用量报表：周桶落在周一，月桶按自然月合并', () => {
  // 2026-10-05 是周一
  const days = {
    '2026-10-05': day({ prompt: 100, completion: 0 }),
    '2026-10-11': day({ prompt: 200, completion: 0 }), // 同一周的周日
    '2026-10-12': day({ prompt: 400, completion: 0 }) // 下一周
  }
  const w = reportFromDays(days, { from: '2026-10-05', to: '2026-10-12', granularity: 'week' })
  assert.deepEqual(w.buckets.map((b) => b.key), ['2026-10-05', '2026-10-12'])
  assert.equal(w.buckets[0].tokens, 300)
  assert.equal(w.buckets[1].tokens, 400)

  const m = reportFromDays(days, { from: '2026-10-05', to: '2026-10-12', granularity: 'month' })
  assert.deepEqual(m.buckets.map((b) => b.key), ['2026-10'])
  assert.equal(m.buckets[0].tokens, 700)
})

test('用量报表：按模型分组，每个模型用自己那档单价算钱', () => {
  const days = {
    '2026-10-10': {
      calls: 2,
      prompt: 1000000, completion: 0, cached: 0,
      byModel: {
        cheap: { calls: 1, prompt: 1000000, completion: 0 },
        pricey: { calls: 1, prompt: 0, completion: 1000000 }
      },
      byRole: {}
    }
  }
  const r = reportFromDays(days, {
    from: '2026-10-10', to: '2026-10-10', groupBy: 'model',
    price: { inp: 999, out: 999 }, // 当前模型单价应该是最后一档兜底，不该被用到
    modelPrices: { cheap: { inp: 1, out: 1 }, pricey: { inp: 10, out: 10 } }
  })
  const byKey = Object.fromEntries(r.groups.map((g) => [g.key, g]))
  assert.equal(byKey.cheap.cost, 1)
  assert.equal(byKey.pricey.cost, 10)
  assert.equal(r.totals.cost, 11, '总额 = 各模型按各自单价相加')
  assert.equal(r.groups[0].key, 'cheap', '默认按 token 从多到少（同量时保持稳定顺序）')
})

test('用量报表：按角色分组，取角色自己的模型明细算钱', () => {
  const days = {
    '2026-10-10': {
      calls: 2, prompt: 0, completion: 0, cached: 0,
      byModel: { 'm-a': { calls: 2, prompt: 1000000, completion: 1000000 } },
      byRole: {
        ryza: { calls: 1, prompt: 500000, completion: 0, cached: 0, byModel: { 'm-a': { calls: 1, prompt: 500000, completion: 0 } } },
        ff14: { calls: 1, prompt: 0, completion: 1000000, cached: 0, byModel: { 'm-a': { calls: 1, prompt: 0, completion: 1000000 } } }
      }
    }
  }
  const r = reportFromDays(days, {
    from: '2026-10-10', to: '2026-10-10', groupBy: 'role', price: PRICE_A
  })
  const byKey = Object.fromEntries(r.groups.map((g) => [g.key, g]))
  assert.equal(byKey.ryza.cost, 1)
  assert.equal(byKey.ff14.cost, 8)
  assert.equal(byKey.ryza.tokens, 500000)
  assert.equal(byKey.ff14.tokens, 1000000)
})

test('用量报表：老数据没有 byRole 时不报错，也不丢总量', () => {
  const days = {
    '2026-10-10': {
      calls: 1, prompt: 1000000, completion: 0,
      byModel: { 'm-a': { calls: 1, prompt: 1000000, completion: 0 } }
    }
  }
  const r = reportFromDays(days, { from: '2026-10-10', to: '2026-10-10', groupBy: 'role', price: PRICE_A })
  assert.equal(r.groups.length, 0, '0.25.0 之前的数据没有角色维度，分组为空但不崩')
  assert.equal(r.totals.tokens, 1000000)
  assert.equal(r.totals.cost, 2)
})

test('用量报表：币种换算只影响显示，不改 token 与调用次数', () => {
  const days = { '2026-10-10': day({ prompt: 1000000, completion: 0 }) }
  const cny = reportFromDays(days, { from: '2026-10-10', to: '2026-10-10', price: PRICE_A })
  const usd = reportFromDays(days, {
    from: '2026-10-10', to: '2026-10-10', price: PRICE_A, currency: 'USD', rate: 7.2
  })
  assert.equal(cny.totals.cost, 2)
  assert.equal(usd.totals.cost, +(2 / 7.2).toFixed(3))
  assert.equal(usd.totals.tokens, cny.totals.tokens)
  assert.equal(usd.currency, 'USD')
})

test('用量报表：没有单价时 cost 一律 0（不编造金额）', () => {
  const days = { '2026-10-10': day({ prompt: 1000000, completion: 0 }) }
  const r = reportFromDays(days, { from: '2026-10-10', to: '2026-10-10' })
  assert.equal(r.totals.cost, 0)
  assert.equal(r.totals.tokens, 1000000)
})

test('桶键：周一为周起点，月桶截到年月', () => {
  assert.equal(bucketKeyOf('2026-10-05', 'week'), '2026-10-05')
  assert.equal(bucketKeyOf('2026-10-11', 'week'), '2026-10-05')
  assert.equal(bucketKeyOf('2026-10-31', 'month'), '2026-10')
  assert.equal(bucketKeyOf('2026-10-31', 'day'), '2026-10-31')
})
