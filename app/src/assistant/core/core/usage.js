/**
 * 1.9 用量/成本统计（纯数据层，可单测）：
 * 每次模型调用记一笔（prompt/completion tokens），落 data/usage.json。
 * 成本为「估算」：按 vendors 表人民币/百万 tokens 单价 × 当天用量，仅量级参考。
 *
 * 0.25.0 用量页升级（对齐 Coopanion #15）：
 * - 记账补 byRole/角色×模型（按角色分组、按角色算钱要靠它）
 * - 新增 reportFromDays()：纯函数，任意区间 × 日/周/月粒度 × 按模型/角色分组 × 币种汇率
 * - usageSummary() 原样保留（assistant 窗口 10s 轮询还在用它的 today/days 结构）
 */
import fs from 'node:fs'
import { dataPath } from '../config.js'

function todayKey (d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 'YYYY-MM-DD' → 当地零点的 Date（不用 new Date(str)，避免 UTC 偏移把日期挪一天） */
function keyToDate (key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function shiftKey (key, days) {
  const d = keyToDate(key) || new Date()
  d.setDate(d.getDate() + days)
  return todayKey(d)
}

/** 区间内每一天的 key（含首含尾），上限 366 天防手滑 */
function listDays (from, to) {
  const out = []
  let cur = from
  let guard = 0
  while (cur <= to && guard++ < 400) {
    out.push(cur)
    cur = shiftKey(cur, 1)
  }
  return out
}

/** 周桶 = 那一周的周一；月桶 = YYYY-MM */
function bucketKeyOf (dateKey, granularity) {
  if (granularity === 'month') return dateKey.slice(0, 7)
  if (granularity === 'week') {
    const d = keyToDate(dateKey)
    if (!d) return dateKey
    const dow = (d.getDay() + 6) % 7 // 周一=0
    d.setDate(d.getDate() - dow)
    return todayKey(d)
  }
  return dateKey
}

function bucketLabel (key, granularity) {
  if (granularity === 'month') return key.slice(2).replace('-', '/')
  if (granularity === 'week') return key.slice(5) + '周'
  return key.slice(5)
}

function emptyBucket (key, granularity) {
  return { key, label: bucketLabel(key, granularity), calls: 0, prompt: 0, completion: 0, cached: 0, tokens: 0, cost: 0 }
}

function emptyDay () {
  return { calls: 0, prompt: 0, completion: 0, cached: 0, byModel: {}, byRole: {} }
}

function loadAll () {
  try {
    const j = JSON.parse(fs.readFileSync(dataPath('usage.json'), 'utf8'))
    return j && typeof j === 'object' && j.days ? j : { days: {} }
  } catch { return { days: {} } }
}

function saveAll (all) {
  fs.mkdirSync(dataPath(), { recursive: true })
  // 只留 90 天，防文件无限膨胀
  const keys = Object.keys(all.days).sort()
  while (keys.length > 90) delete all.days[keys.shift()]
  fs.writeFileSync(dataPath('usage.json'), JSON.stringify(all, null, 2))
}

function num (v) { return Math.max(0, Number(v) || 0) }

/** 往一个计数盒子里塞一笔（byModel 只记 prompt/completion，够算钱就行） */
function bumpBox (box, { prompt, completion, cached }) {
  box.calls = (box.calls || 0) + 1
  box.prompt = (box.prompt || 0) + prompt
  box.completion = (box.completion || 0) + completion
  box.cached = (box.cached || 0) + cached
  return box
}

/** 记一笔。token 数缺失/非法按 0 处理（有的端点不给 usage）。role=用哪个角色花的钱 */
export function recordUsage ({ model = '', role = '', prompt = 0, completion = 0, cached = 0 } = {}) {
  const all = loadAll()
  const key = todayKey()
  if (!all.days[key]) all.days[key] = emptyDay()
  const day = all.days[key]
  const p = num(prompt)
  const c = num(completion)
  const hit = num(cached)
  const m = String(model || 'unknown').slice(0, 80)
  const r = String(role || 'unknown').slice(0, 80)

  bumpBox(day, { prompt: p, completion: c, cached: hit })

  if (!day.byModel[m]) day.byModel[m] = { calls: 0, prompt: 0, completion: 0, cached: 0 }
  bumpBox(day.byModel[m], { prompt: p, completion: c, cached: hit })

  if (!day.byRole) day.byRole = {}
  if (!day.byRole[r]) day.byRole[r] = { calls: 0, prompt: 0, completion: 0, cached: 0, byModel: {} }
  bumpBox(day.byRole[r], { prompt: p, completion: c, cached: hit })
  const rb = day.byRole[r]
  if (!rb.byModel) rb.byModel = {}
  if (!rb.byModel[m]) rb.byModel[m] = { calls: 0, prompt: 0, completion: 0, cached: 0 }
  bumpBox(rb.byModel[m], { prompt: p, completion: c, cached: hit })

  saveAll(all)
  return day
}

/** 单价：优先按模型查表（modelPrices 可以是函数或对象），查不到退回当前模型单价 */
function priceFor (model, price, modelPrices) {
  if (modelPrices) {
    let hit = null
    if (typeof modelPrices === 'function') { try { hit = modelPrices(model) } catch { hit = null } } else hit = modelPrices[model]
    if (hit && hit.inp != null && hit.out != null) return hit
  }
  if (price && price.inp != null && price.out != null) return price
  return null
}

/** ¥ → 目标币种（rate = 1 美元兑多少人民币） */
function convert (cny, currency, rate) {
  const c = String(currency || 'CNY').toUpperCase()
  if (c === 'CNY' || !rate || rate <= 0) return cny
  return cny / rate
}

/**
 * 纯函数：从 days 映射生成报表（不读盘，方便单测）。
 * @param {object} daysMap  { 'YYYY-MM-DD': day }
 * @param {object} opts { from, to, granularity:'day|week|month', groupBy:'none|model|role',
 *                        price:{inp,out}, modelPrices: object|fn, currency:'CNY|USD', rate }
 */
export function reportFromDays (daysMap, {
  from, to, granularity = 'day', groupBy = 'none',
  price = null, modelPrices = null, currency = 'CNY', rate = 7.2
} = {}) {
  const all = daysMap || {}
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? to : todayKey()
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? from : shiftKey(end, -6)
  const gran = granularity === 'week' || granularity === 'month' ? granularity : 'day'
  const group = groupBy === 'model' || groupBy === 'role' ? groupBy : 'none'
  const keys = listDays(start, end)

  // 先按区间把桶排好（空桶也占位，柱状图才不会缺格）
  const bucketMap = new Map()
  const groupsMap = new Map()
  for (const k of keys) {
    const bk = bucketKeyOf(k, gran)
    if (!bucketMap.has(bk)) bucketMap.set(bk, emptyBucket(bk, gran))
  }
  const ensureGroup = (gk) => {
    if (!groupsMap.has(gk)) {
      groupsMap.set(gk, {
        key: gk,
        label: gk,
        calls: 0, prompt: 0, completion: 0, cached: 0, tokens: 0, cost: 0,
        buckets: new Map([...bucketMap.keys()].map((bk) => [bk, emptyBucket(bk, gran)]))
      })
    }
    return groupsMap.get(gk)
  }

  const totals = { calls: 0, prompt: 0, completion: 0, cached: 0, tokens: 0, cost: 0 }
  const heat = []

  // 逐日累加（sum 只加区间内的天）
  for (const k of keys) {
    const d = all[k]
    const heatCell = { date: k, calls: 0, tokens: 0, cost: 0 }
    if (d) {
      const bk = bucketKeyOf(k, gran)
      const bucket = bucketMap.get(bk)
      bucket.calls += num(d.calls)
      bucket.prompt += num(d.prompt)
      bucket.completion += num(d.completion)
      bucket.cached += num(d.cached)
      bucket.tokens += num(d.prompt) + num(d.completion)
      heatCell.calls += num(d.calls)
      heatCell.tokens += num(d.prompt) + num(d.completion)

      // 钱要按「当天每个模型各自的单价」算，不能拿当前模型单价乘全部
      for (const [model, mv] of Object.entries(d.byModel || {})) {
        const pr = priceFor(model, price, modelPrices)
        const cny = pr ? (num(mv.prompt) * pr.inp + num(mv.completion) * pr.out) / 1000000 : 0
        bucket.cost += cny
        heatCell.cost += cny
        if (group === 'model') {
          const g = ensureGroup(model || 'unknown')
          g.calls += num(mv.calls); g.prompt += num(mv.prompt); g.completion += num(mv.completion)
          g.tokens += num(mv.prompt) + num(mv.completion); g.cost += cny
          const gb = g.buckets.get(bk)
          if (gb) { gb.calls += num(mv.calls); gb.tokens += num(mv.prompt) + num(mv.completion); gb.cost += cny }
        }
      }
      if (group === 'role') {
        for (const [role, rv] of Object.entries(d.byRole || {})) {
          const g = ensureGroup(role || 'unknown')
          // 老数据没有 byRole.byModel 时退回角色总量 × 当天模型单价（精度略差但不丢数）
          const rbm = rv.byModel && Object.keys(rv.byModel).length ? rv.byModel : null
          let cny = 0
          if (rbm) {
            for (const [model, mv] of Object.entries(rbm)) {
              const pr = priceFor(model, price, modelPrices)
              if (pr) cny += (num(mv.prompt) * pr.inp + num(mv.completion) * pr.out) / 1000000
            }
          } else {
            const pr = priceFor('', price, null)
            if (pr) cny = (num(rv.prompt) * pr.inp + num(rv.completion) * pr.out) / 1000000
          }
          g.calls += num(rv.calls); g.prompt += num(rv.prompt); g.completion += num(rv.completion)
          g.cached += num(rv.cached); g.tokens += num(rv.prompt) + num(rv.completion); g.cost += cny
          const gb = g.buckets.get(bk)
          if (gb) { gb.calls += num(rv.calls); gb.tokens += num(rv.prompt) + num(rv.completion); gb.cost += cny }
        }
      }
    }
    heat.push(heatCell)
  }

  const round3 = (n) => +Number(n || 0).toFixed(3)
  const finish = (o) => {
    o.tokens = round3(o.tokens)
    o.cost = round3(convert(o.cost, currency, rate))
    return o
  }

  const buckets = [...bucketMap.values()].map(finish)
  totals.calls = buckets.reduce((s, b) => s + b.calls, 0)
  totals.prompt = buckets.reduce((s, b) => s + b.prompt, 0)
  totals.completion = buckets.reduce((s, b) => s + b.completion, 0)
  totals.cached = buckets.reduce((s, b) => s + b.cached, 0)
  totals.tokens = round3(buckets.reduce((s, b) => s + b.tokens, 0))
  totals.cost = round3(buckets.reduce((s, b) => s + b.cost, 0))

  const groups = [...groupsMap.values()].map((g) => ({
    key: g.key,
    label: g.label,
    calls: g.calls,
    prompt: g.prompt,
    completion: g.completion,
    cached: g.cached,
    tokens: round3(g.tokens),
    cost: round3(convert(g.cost, currency, rate)),
    buckets: [...g.buckets.values()].map(finish)
  })).sort((a, b) => b.tokens - a.tokens)

  return {
    from: start,
    to: end,
    rangeDays: keys.length,
    granularity: gran,
    groupBy: group,
    currency: String(currency || 'CNY').toUpperCase(),
    rate,
    buckets,
    groups,
    totals,
    heat: heat.map((h) => ({ ...h, tokens: round3(h.tokens), cost: round3(convert(h.cost, currency, rate)) }))
  }
}

/** 读盘版：设置页用。opts 同 reportFromDays */
export function usageReport (opts = {}) {
  return reportFromDays(loadAll().days, opts)
}

/** 汇总：近 N 天（默认 7）+ 今天 + 累计。price = { inp, out }（¥/百万 tokens，估算用） */
export function usageSummary ({ days = 7, price = null } = {}) {
  const all = loadAll()
  const today = todayKey()
  const out = []
  let total = { calls: 0, prompt: 0, completion: 0 }
  for (const [date, d] of Object.entries(all.days)) {
    total.calls += d.calls || 0
    total.prompt += d.prompt || 0
    total.completion += d.completion || 0
    total.cached += d.cached || 0
  }
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000)
    const key = todayKey(dt)
    const d = all.days[key] || emptyDay()
    out.push({ date: key, ...pick(d), cost: estCost(d, price) })
  }
  return {
    today: { ...pick(all.days[today] || emptyDay()), cost: estCost(all.days[today] || emptyDay(), price) },
    days: out,
    total: { ...total, cost: null }, // 累计跨厂商价格变动大，不给累计成本，只给今日估算
    price
  }
}

function pick (d) {
  return { calls: d.calls || 0, prompt: d.prompt || 0, completion: d.completion || 0, cached: d.cached || 0 }
}

function estCost (d, price) {
  if (!price || !price.inp || !price.out) return null
  return +(((d.prompt || 0) * price.inp + (d.completion || 0) * price.out) / 1000000).toFixed(3)
}

export { todayKey as dayKeyLocal, shiftKey as dayShift, bucketKeyOf }
