/**
 * FF14 专属角色（内置，roleId = 'ff14'）
 *  - 物价：Universalis（国服全支持；默认服务器 银泪湖，豆豆柴大区）
 *  - 钓鱼/鱼皇：本地离线数据（resources/ff14/fishing.json，构建自 icykoneko/ff14-fish-tracker-app）
 *    + 艾欧泽亚时间/天气预告（SaintCoinach 算法），推荐钓法
 *  - 灰机wiki：运行时 MediaWiki API（连不上时优雅降级，别硬编）
 * 纯 node 可测；网络请求都用注入的 fetch（默认 globalThis.fetch）。
 */
'use strict'
const fs = require('fs')
const path = require('path')

const DEFAULT_SERVER = '银泪湖'
const ET_FACTOR = 3600 / 175          // 1 地球秒 = 20.5714 艾欧泽亚秒
const WEATHER_PERIOD_SEC = 8 * 175    // 一个天气段 = 8 ET 小时 = 1400 地球秒

/** 官方中文天气名（数据包里只有日/英文，这里固定映射；未知 id 退回数据包名） */
const WEATHER_CN = { 1: '快晴', 2: '晴朗', 3: '阴云', 4: '浓雾', 5: '微风', 6: '强风', 7: '降雨', 8: '暴雨', 9: '雷雨', 10: '沙尘', 11: '热浪', 12: '降雪', 13: '暴雪', 14: '妖雾', 15: '灵风', 16: '涌炎' }
const weatherName = (id, fallback) => WEATHER_CN[id] || fallback || String(id)

let _items = null
let _fishing = null
let _gather = null
const itemsMap = () => {
  if (!_items) {
    try { _items = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'resources', 'ff14', 'items-zh.json'), 'utf8')) } catch { _items = {} }
  }
  return _items
}
const fishing = () => {
  if (!_fishing) {
    try { _fishing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'resources', 'ff14', 'fishing.json'), 'utf8')) } catch { _fishing = { fish: {}, spots: {}, wr: {}, wt: {} } }
  }
  return _fishing
}
/** 0.18.0 M5 · 采集时钟数据（garlandtools.cn bell/nodes.js 构建期拉取，219 组限时采集点） */
const gathering = () => {
  if (!_gather) {
    try { _gather = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'resources', 'ff14', 'gathering.json'), 'utf8')) } catch { _gather = [] }
  }
  return _gather
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[\s'’·]/g, '')

/** 物品名模糊搜索：精确 → 前缀 → 包含（双向），按名字长度接近度排序 */
function searchItems (q, limit = 8) {
  const map = itemsMap()
  const target = norm(q)
  if (!target) return []
  const exact = []
  const pre = []
  const inc = []
  for (const id of Object.keys(map)) {
    const n = norm(map[id])
    if (n === target) exact.push(Number(id))
    else if (n.startsWith(target)) pre.push(Number(id))
    else if (n.includes(target) || target.includes(n)) inc.push(Number(id))
  }
  const rank = (a, b) => norm(map[a]).length - norm(map[b]).length
  exact.sort(rank); pre.sort(rank); inc.sort(rank)
  return [...exact, ...pre, ...inc].slice(0, limit).map((id) => ({ id, name: map[id] }))
}

/* ---------------- 艾欧泽亚时间 & 天气 ---------------- */

/** 当前 ET 时:分 */
function etNow (now = Date.now()) {
  const m = now * ET_FACTOR
  return { hour: Math.floor(m / 3600000) % 24, min: Math.floor(m / 60000) % 60 }
}

/** SaintCoinach 口径：某天气段（unixSec 起）的天气 roll */
function weatherChance (unixSec, rates) {
  const bell = unixSec / 175
  const inc = (bell + 8 - (bell % 8)) % 24
  const totalDays = ((unixSec / 4200) << 32) >>> 0
  const calcBase = (totalDays * 100) + inc
  const step1 = ((calcBase << 11) ^ calcBase) >>> 0
  const step2 = ((step1 >>> 8) ^ step1) >>> 0
  const chance = step2 % 100
  for (const r of rates || []) { if (chance < r[1]) return r[0] }
  return 0
}

/** 某钓场接下来 count 个天气段（含当前段）：[{startSec, id, name}] */
function weatherForecast (spotId, count = 6, now = Date.now()) {
  const F = fishing()
  const spot = F.spots[spotId]
  if (!spot) return []
  const rates = F.wr[String(spot.t)]
  if (!rates) return []
  const bell = Math.floor(now / 1000 / 175)
  const cur = Math.floor(bell / 8)
  const out = []
  for (let k = 0; k < count; k++) {
    const startSec = (cur + k) * WEATHER_PERIOD_SEC
    const id = weatherChance(startSec, rates)
    out.push({ startSec, id, name: weatherName(id, F.wt[id]) })
  }
  return out
}

/** ET 窗口：当前是否在窗口内 + 下次窗口开始的 ET 时刻与距现在多少地球分钟 */
function windowInfo (hours, now = Date.now()) {
  if (!hours || (hours[0] === 0 && hours[1] === 24)) return { always: true }
  const et = etNow(now)
  const h = et.hour + et.min / 60
  const inWin = hours[0] <= hours[1]
    ? (h >= hours[0] && h < hours[1])
    : (h >= hours[0] || h < hours[1])   // 跨天窗口
  // 下次开窗：逐 ET 小时扫描未来 24 ET 小时
  let nextEt = null
  for (let i = 0; i <= 24; i++) {
    const hh = (Math.floor(h) + i) % 24
    const next = hours[0] <= hours[1] ? (hh === hours[0] && i > 0) : (hh === hours[0])
    if (next) { nextEt = hh; break }
  }
  const minsToNext = nextEt == null ? null : Math.round(((nextEt - h + 24) % 24) * (70 / 24))
  return { always: false, inWin, win: `${String(hours[0]).padStart(2, '0')}:00-${String(hours[1]).padStart(2, '0')}:00 ET`, nextEt, minsToNext }
}

/* ---------------- 钓鱼查询 ---------------- */

function fishSummary (name, now = Date.now()) {
  const F = fishing()
  const ids = new Set(Object.keys(F.fish).map(Number))
  const cands = searchItems(name, 6).filter((c) => ids.has(c.id))
  if (!cands.length) return { found: false, query: name }
  const f = F.fish[cands[0].id]
  const spot = f.spot ? F.spots[f.spot] : null
  const zh = itemsMap()[cands[0].id] || cands[0].name
  const preds = (f.pred || []).map((pid) => ({ id: pid, name: itemsMap()[pid] || `物品#${pid}` }))
  const wfc = spot ? weatherForecast(f.spot, 6, now) : []
  const needWeather = (f.w || []).map((id) => weatherName(id, F.wt[id]))
  const needPrev = (f.pw || []).map((id) => weatherName(id, F.wt[id]))
  const win = windowInfo(f.h, now)
  // 当前窗口内要求的天气是否出现（含前置天气简化：只看当前段天气）
  const curW = wfc.length ? wfc[0].name : null
  const weatherOk = !needWeather.length || (curW && needWeather.includes(curW))
  const tips = []
  if (f.eyes) tips.push('需要鱼眼（Fish Eyes）')
  if (f.snag) tips.push('需要钓组强化（Snagging）')
  if (f.hook) tips.push(`咬钩杆型：${f.hook === 'Precision' ? '轻杆（精准提钩）' : f.hook === 'Powerful' ? '中杆（强力提钩）' : f.hook}`)
  if (f.tug) tips.push(`拉扯强度：${f.tug === 'light' ? '轻' : f.tug === 'medium' ? '中' : f.tug === 'heavy' ? '重' : f.tug}`)
  if (f.lore) tips.push('需要禁书（传世录）')
  if (f.big) tips.push('鱼王级')
  if (f.gig) tips.push(`叉鱼：${f.gig}`)
  return {
    found: true,
    id: cands[0].id, name: zh,
    query: name, alt: cands.slice(1, 4).map((c) => c.name),
    spot: spot ? { name: spot.n, nameJa: spot.nj, xy: spot.xy } : null,
    window: win,
    nowEorzea: etNow(now),
    weather: { need: needWeather, needPrev, forecast: wfc.map((x) => ({ name: x.name, inMin: Math.round((x.startSec * 1000 - now) / 60000) })) },
    weatherOk,
    predators: preds.length ? preds : null,
    intuitionLen: f.intu || null,
    patch: f.patch || null,
    tips
  }
}

/* ---------------- 0.18.0 M5 · 采集时钟 ---------------- */

const JOB_CN = { 8: '刻木', 9: '锻铁', 10: '铸甲', 11: '雕金', 12: '制革', 13: '裁缝', 14: '炼金', 15: '烹调' }

/** 采集窗口：startHours（ET 整点起点数组）+ uptimeEtMin（窗口时长，ET 分钟）。
 *  返回每个窗口 {startEt, endEt, inWin, startInMin, remainMin}（跨零点窗口也认）。 */
function gatherWindows (startHours, uptimeEtMin, now = Date.now()) {
  const et = etNow(now)
  const h = et.hour + et.min / 60
  const dur = Math.max(1, Number(uptimeEtMin) || 60) / 60   // 窗口时长（ET 小时）
  const list = Array.isArray(startHours) ? startHours : []
  return list.map((s) => {
    let d = h - s
    if (d < 0) d += 24
    const inWin = d >= 0 && d < dur
    return {
      startEt: s,
      endEt: (s + dur) % 24,
      inWin,
      startInMin: Math.round(((s - h + 24) % 24) * (70 / 24)),
      remainMin: inWin ? Math.round((dur - d) * (70 / 24)) : 0
    }
  })
}

/** 采集时钟：按中文名查限时采集点（良材/矿脉/草场/石场），报窗口与下次开窗 */
function gatherSummary (name, now = Date.now()) {
  const G = gathering()
  if (!G.length) return { found: false, query: name, error: '采集数据包缺失（resources/ff14/gathering.json）' }
  const target = norm(name)
  if (!target) return { found: false, query: name }
  const hits = []
  for (const g of G) {
    for (const it of g.items || []) {
      const n = norm(it.item || '')
      if (n === target || n.includes(target) || target.includes(n)) {
        hits.push({ node: g, item: it })
        break
      }
    }
    if (hits.length >= 6) break
  }
  if (!hits.length) return { found: false, query: name }
  return {
    found: true,
    query: name,
    nowEorzea: etNow(now),
    nodes: hits.map(({ node, item }) => {
      const wins = gatherWindows(node.time || [], node.uptime, now)
      const inWin = wins.some((w) => w.inWin)
      const nextIn = wins.length ? Math.min(...wins.map((w) => w.startInMin)) : null
      return {
        item: item.item, id: item.id,
        type: node.type, zone: node.zone, coords: node.coords, title: node.title,
        lvl: node.lvl, stars: node.stars || 0,
        timeEt: node.time || [], uptimeEtMin: node.uptime || null,
        inWindow: inWin, nextStartInMin: nextIn,
        condition: node.condition || null, bonus: node.bonus || null, patch: node.patch || null
      }
    })
  }
}

/* ---------------- 0.18.0 M5 · 配方查询（garlandtools.cn 国服站） ---------------- */

const GT_CN = 'https://www.garlandtools.cn'

async function gtSearch (q, fetchImpl) {
  const f = fetchImpl || globalThis.fetch
  const url = GT_CN + '/api/search.php?text=' + encodeURIComponent(q) + '&lang=chs&type=item'
  const res = await f(url, { headers: { 'User-Agent': 'RyzaAssistant/0.18 (FF14 companion)' }, signal: AbortSignal.timeout(12000) })
  if (!res.ok) throw new Error('garlandtools.cn 搜索 HTTP ' + res.status)
  return res.json()
}

async function gtItem (id, fetchImpl) {
  const f = fetchImpl || globalThis.fetch
  const url = GT_CN + '/db/doc/item/chs/3/' + id + '.json'
  const res = await f(url, { headers: { 'User-Agent': 'RyzaAssistant/0.18 (FF14 companion)' }, signal: AbortSignal.timeout(12000) })
  if (!res.ok) throw new Error('garlandtools.cn 详情 HTTP ' + res.status)
  return res.json()
}

/** 配方查询：搜索物品 → 详情 craft 表；材料中文名优先 partials，回退本地 items-zh */
async function recipeSummary (name, fetchImpl) {
  const s = await gtSearch(name, fetchImpl)
  const hit = (Array.isArray(s) ? s : []).find((x) => x.type === 'item')
  if (!hit) return { found: false, query: name }
  const d = await gtItem(hit.id, fetchImpl)
  const item = d.item || {}
  const partialItems = {}
  for (const v of Object.values(d.partials || {})) {
    if (v && v.type === 'item' && v.obj) partialItems[v.obj.i] = v.obj.n
  }
  const zhName = (id) => partialItems[id] || itemsMap()[id] || ('物品#' + id)
  return {
    found: true,
    id: hit.id,
    name: item.name || (hit.obj && hit.obj.n) || name,
    recipes: (item.craft || []).map((r) => ({
      job: JOB_CN[r.job] || String(r.job),
      rlvl: r.rlvl, lvl: r.lvl,
      durability: r.durability, hq: !!r.hq,
      ingredients: (r.ingredients || []).map((x) => ({ name: zhName(x.id), amount: x.amount }))
    })),
    canGather: !!(item.nodes && item.nodes.length),
    vendorCount: (item.vendors || []).length || undefined
  }
}

/* ---------------- Universalis 物价 ---------------- */

async function fetchPrice (id, server, fetchImpl) {
  const f = fetchImpl || globalThis.fetch
  const world = encodeURIComponent((server || DEFAULT_SERVER).trim())
  const url = `https://universalis.app/api/v2/${world}/${id}?listings=5&entries=5`
  const res = await f(url, { signal: AbortSignal.timeout(12000) })
  if (!res.ok) throw new Error(`Universalis ${res.status}（服务器/物品可能无效）`)
  return res.json()
}

function formatPrice (d, server) {
  const mins = d.lastUploadTime ? Math.round((Date.now() - d.lastUploadTime) / 60000) : null
  const lines = []
  lines.push(`【${server || DEFAULT_SERVER}】数据更新：${mins != null ? (mins < 1 ? '刚刚' : mins + ' 分钟前') : '未知'}`)
  const ls = (d.listings || []).slice(0, 5)
  if (ls.length) {
    lines.push('当前挂单：' + ls.map((l) => `${l.hq ? 'HQ ' : ''}${l.pricePerUnit} Gil ×${l.quantity}${l.worldName && d.worldID !== l.worldID ? `(${l.worldName})` : ''}`).join(' / '))
    lines.push(`最低价 ${ls[0].hq ? '(HQ) ' : ''}${Math.min(...ls.map((x) => x.pricePerUnit))} Gil`)
  } else lines.push('当前无挂单')
  const h = (d.recentHistory || []).slice(0, 5)
  if (h.length) {
    const avg = Math.round(h.reduce((a, x) => a + x.pricePerUnit * (x.quantity || 1), 0) / Math.max(1, h.reduce((a, x) => a + (x.quantity || 1), 0)))
    lines.push(`最近成交 ${h.length} 笔，均价约 ${avg} Gil`)
  }
  return lines.join('\n')
}

/* ---------------- 灰机wiki ---------------- */

/** 宿主可注入 Electron net.fetch（Chromium TLS 指纹，能过 Cloudflare）；没注入就用全局 fetch */
let _wikiFetch = null
const setWikiFetch = (f) => { _wikiFetch = f }

async function wikiSearch (query, fetchImpl) {
  const f = _wikiFetch || fetchImpl || globalThis.fetch
  const url = 'https://ff14.huijiwiki.com/api.php?action=query&list=search&format=json&srlimit=5&srsearch=' + encodeURIComponent(query)
  const res = await f(url, { headers: { 'User-Agent': 'RyzaAssistant/0.12 (FF14 companion)' }, signal: AbortSignal.timeout(12000) })
  if (!res.ok) throw new Error('wiki HTTP ' + res.status)
  const d = await res.json()
  return (d.query && d.query.search || []).map((s) => ({ title: s.title, snippet: String(s.snippet || '').replace(/<[^>]+>/g, '') }))
}

/* ---------------- 陆行鸟染色（wiki 数据 + 本地 BFS） ---------------- */

let _choco = null
const chocoColors = () => {
  if (!_choco) {
    try { _choco = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'resources', 'ff14', 'chocobo.json'), 'utf8')) } catch { _choco = [] }
  }
  return _choco
}

/** 6 种果子的 RGB 偏移（灰机wiki 逐物品页核实），以及初始/重置色 */
const CHOCO_FRUITS = [
  { name: '塞尔法特尔沙果', d: [5, -5, -5] },
  { name: '辉鳞油梨', d: [-5, 5, -5] },
  { name: '奥·哥摩罗浆果', d: [-5, -5, 5] },
  { name: '多玛青梅', d: [-5, 5, 5] },
  { name: '瓦尔醋栗', d: [5, -5, 5] },
  { name: '谢尔达莱凤梨', d: [5, 5, -5] }
]
const CHOCO_DEFAULT = { name: '陆行鸟黄', rgb: [219, 180, 87] }

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

/** 找色表里最接近的颜色（换羽时游戏就按最近颜色落） */
function nearestColor (rgb) {
  const table = chocoColors()
  let best = null, bd = Infinity
  for (const [name, r, g, b] of table) {
    const d = dist2(rgb, [r, g, b])
    if (d < bd) { bd = d; best = name }
  }
  return best
}

/** 喂一颗果子，返回 null 表示越界（=染色失败） */
const feed = (rgb, d) => {
  const n = [rgb[0] + d[0], rgb[1] + d[1], rgb[2] + d[2]]
  return (n.some((v) => v < 0 || v > 255)) ? null : n
}

/**
 * 陆行鸟染色方案：当前色 → 目标色，BFS 最少果子序列。
 * 终止条件 = 当前 RGB 的「最近色表色」命中目标（游戏换羽按最近色落，不要求 RGB 精确相等）。
 */
function chocoboPlan (fromName, toName) {
  const table = chocoColors()
  if (!table.length) return { ok: false, error: '染色色表数据包缺失（resources/ff14/chocobo.json）' }
  const find = (q) => table.find(([n]) => n.includes(String(q || '').trim())) || (String(q || '').trim() === CHOCO_DEFAULT.name ? [CHOCO_DEFAULT.name, ...CHOCO_DEFAULT.rgb] : null)
  const to = find(toName)
  if (!to) return { ok: false, error: `色表里没有「${toName}」，可染颜色共 ${table.length} 种，报个大概（如：黑色/蓝色/粉）我帮你对` }
  const target = [to[1], to[2], to[3]]
  let cur
  if (fromName) {
    const f = find(fromName)
    if (!f) return { ok: false, error: `起点色「${fromName}」没认出来；不确定当前色的话，先去鸟房看一眼再告诉我` }
    cur = [f[1], f[2], f[3]]
  } else {
    cur = [...CHOCO_DEFAULT.rgb]
  }
  if (nearestColor(cur) === to[0] && dist2(cur, target) === 0) {
    return { ok: true, from: fromName || CHOCO_DEFAULT.name, to: to[0], already: true, text: '当前已经是这个颜色了，不用喂。' }
  }
  // BFS：状态 = RGB（步长 5 的格点），目标 = 最近色命中
  const key = (c) => c.join(',')
  const goal = (c) => nearestColor(c) === to[0]
  const prev = new Map([[key(cur), null]])
  const queue = [cur]
  let found = null
  while (queue.length && !found) {
    const c = queue.shift()
    for (const fr of CHOCO_FRUITS) {
      const n = feed(c, fr.d)
      if (!n) continue
      const k = key(n)
      if (prev.has(k)) continue
      prev.set(k, { from: key(c), fruit: fr.name })
      if (goal(n)) { found = k; break }
      queue.push(n)
      if (prev.size > 200000) { found = 'overflow'; break } // 保险丝
    }
  }
  if (!found || found === 'overflow') return { ok: false, error: 'BFS 没找到方案（理论上不该发生），把当前色和目标色再确认一下' }
  // 回溯序列
  const seq = []
  let k = found
  while (prev.get(k)) { seq.unshift(prev.get(k).fruit); k = prev.get(k).from }
  // 压缩成 水果×数量 + 保持喂食顺序
  const order = []
  const counts = {}
  for (const name of seq) {
    if (!counts[name]) { counts[name] = 0; order.push(name) }
    counts[name]++
  }
  return {
    ok: true,
    from: fromName || CHOCO_DEFAULT.name,
    to: to[0],
    total: seq.length,
    counts: order.map((n) => `${n}×${counts[n]}`).join('、'),
    order: seq,
    text: `从「${fromName || CHOCO_DEFAULT.name}」染到「${to[0]}」共要 ${seq.length} 颗果子：${order.map((n) => `${n}×${counts[n]}`).join('、')}。按列表顺序喂，喂完在鸟房等 6 小时换羽。中途任何提示都别管，顺序错了就从鸟房拿出来重喂。`
  }
}

/* ---------------- 天书奇谈概率 ---------------- */

/** 4x4 天书板的所有 3 连线（24 条）：每行 2 + 每列 2 + 两对角方向各 4 */
const TAILS_LINES = (() => {
  const L = []
  for (let r = 0; r < 4; r++) { L.push([r * 4, r * 4 + 1, r * 4 + 2]); L.push([r * 4 + 1, r * 4 + 2, r * 4 + 3]) }
  for (let c = 0; c < 4; c++) { L.push([c, c + 4, c + 8]); L.push([c + 4, c + 8, c + 12]) }
  L.push([0, 5, 10], [5, 10, 15], [4, 9, 14], [1, 6, 11])      // 主对角方向
  L.push([3, 6, 9], [6, 9, 12], [2, 5, 8], [7, 10, 13])      // 副对角方向
  return L
})()

const linesThrough = (mask) => TAILS_LINES.filter((L) => L.every((i) => mask & (1 << i))).length

/**
 * 天书奇谈概率：placed = 已贴贴纸的格子（0-15，从左上按行数）。
 * 枚举剩余贴纸的所有摆法，统计成线数分布。
 */
function tailsProbability (placed) {
  const N = 16, TOTAL = 9
  let mask = 0
  for (const p of placed || []) {
    const i = Number(p)
    if (!Number.isInteger(i) || i < 0 || i > 15) return { ok: false, error: '格子编号要在 0-15（从左上角按行数）' }
    mask |= (1 << i)
  }
  const k = placed.length
  if (k > TOTAL) return { ok: false, error: '贴纸最多 9 张' }
  const empty = []
  for (let i = 0; i < N; i++) if (!(mask & (1 << i))) empty.push(i)
  const rest = TOTAL - k
  // 组合枚举 C(len(empty), rest)
  const dist = [0, 0, 0, 0] // index = 成线数（≤3 有奖）
  const idx = []
  const rec = (start, depth) => {
    if (depth === rest) {
      let m = mask
      for (const i of idx) m |= (1 << i)
      dist[Math.min(3, linesThrough(m))]++
      return
    }
    for (let i = start; i <= empty.length - (rest - depth); i++) {
      idx[depth] = empty[i]
      rec(i + 1, depth + 1)
    }
  }
  rec(0, 0)
  const total = dist[0] + dist[1] + dist[2] + dist[3]
  const pct = (n) => +(n * 100 / total).toFixed(1)
  const base = linesThrough(mask)
  return {
    ok: true,
    placed: k,
    remaining: rest,
    alreadyLines: base,
    text: `已贴 ${k} 张、还剩 ${rest} 张。最终成 1 线概率 ${pct(dist[1])}%、2 线 ${pct(dist[2])}%、3 线 ${pct(dist[3])}%（当前已稳 ${base} 线）。`
  }
}

/* ---------------- 青魔法书（构建期数据 + 本地查询） ---------------- */

let _blu = null
const bluList = () => {
  if (!_blu) {
    try { _blu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'resources', 'ff14', 'blu.json'), 'utf8')) } catch { _blu = [] }
  }
  return _blu
}

function bluSummary (query) {
  const list = bluList()
  if (!list.length) return { ok: false, error: '青魔数据包缺失（resources/ff14/blu.json）' }
  const q = String(query || '').trim()
  if (!q) {
    return { ok: true, total: list.length, names: list.map((s) => s.name), text: `青魔法书共 ${list.length} 个技能（按蓝魔法书顺序）。想查具体的报技能名（可模糊），我给你查说明；习得等级和学习出处（哪只怪）我用 wiki 查。` }
  }
  const hits = list.filter((s) => s.name.includes(q)).slice(0, 10)
  if (!hits.length) return { ok: false, error: `青魔技能里没有带「${q}」的，报个关键词我再找` }
  return { ok: true, results: hits, text: hits.map((s) => `${s.name}${s.desc ? '：' + s.desc : ''}`).join('；') + '。习得等级和出处（哪只怪学）要的话我用 wiki 查。' }
}

/* ---------------- 狩猎车次（ffxivhunt.cn，运行时拉取） ---------------- */

async function huntStatus (server, fetchImpl) {
  const f = _wikiFetch || fetchImpl || globalThis.fetch
  const sv = encodeURIComponent(server || DEFAULT_SERVER)
  const tries = [
    'https://www.ffxivhunt.cn/api/hunt?server=' + sv,
    'https://www.ffxivhunt.cn/api/trains?server=' + sv
  ]
  let lastErr
  for (const u of tries) {
    try {
      const res = await f(u, { headers: { 'User-Agent': 'RyzaAssistant/0.18 (FF14 companion)' }, signal: AbortSignal.timeout(8000) })
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue }
      const d = await res.json()
      return { ok: true, server: server || DEFAULT_SERVER, raw: d, text: '狩猎车次数据见 raw 字段（ffxivhunt.cn）' }
    } catch (e) { lastErr = e }
  }
  return { ok: false, error: '狩猎数据站（ffxivhunt.cn）暂时连不上：' + (lastErr && lastErr.message), hint: '过会儿再试，或直接看 https://www.ffxivhunt.cn/' }
}

/* ---------------- 幻巧拼图（v1：规则与策略说明，完整求解器待做） ---------------- */

function fauxTips () {
  return {
    ok: true,
    text: '幻巧拼图我目前只带规则和策略，算不了最优解（完整求解器后面做）。要点：①板面 6x6，魔剑单个格子、盾牌占两格、狐狸藏在盾牌旁边；②翻错也给保底分，先把大块盾牌区域圈出来再找剑，别一上来乱翻边角；③狐狸必邻接盾，找到盾就优先查盾的四邻。要精确算分建议用社区求解器：https://guides.xivcdn.com/FauxHollowsProbabilisticSolver/'
  }
}

/* ---------------- 出海垂钓（0.18.0 补：班次 + 航线 + 幻海 + 蓝鱼） ---------------- */

let _ocean = null
const oceanData = () => {
  if (!_ocean) {
    try { _ocean = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'resources', 'ff14', 'ocean.json'), 'utf8')) } catch { _ocean = { stops: [], groups: [], etPhases: {} } }
  }
  return _ocean
}

/** 下一次发船时刻（服务器时间偶数小时；报名 HH:00~:15，:15 发船）。返回 [本班是否在报名窗, 发船ms, 再下一班…] */
function nextDepartures (now = Date.now(), count = 3) {
  const TWO_H = 7200000
  const out = []
  let dep = Math.floor(now / TWO_H) * TWO_H + TWO_H
  if (now % TWO_H < 15 * 60000) out.push(now - (now % TWO_H)) // 正在报名窗内
  while (out.length < count) { out.push(dep); dep += TWO_H }
  return out
}

/** 出发时艾欧泽亚时段 → 三钓场时段顺序（灰机wiki 权威表） */
function etPhaseOrder (depMs) {
  const et = etNow(depMs)
  const h = et.hour + et.min / 60
  if (h >= 8 && h < 16) return { start: '白天', order: ['白天', '黄昏', '夜晚'] }
  if (h >= 16) return { start: '黄昏', order: ['黄昏', '夜晚', '白天'] }
  return { start: '夜晚', order: ['夜晚', '白天', '黄昏'] }
}

/** 近海（Indigo）航线相位：对齐 pf-n（pillowfication）线上游走算法（数值验证周期=48 班/4 天）。
 *  循环 [绯汐海, 罗斯利特湾, 梅尔托尔海峡北, 罗塔诺海]；班次间 +1 步进、跨 JST 日界额外 +1。
 *  闭式：d = (班次序号 + JST 天数差) % 4，锚 = 1970-01-01T02:00Z 首班（d=0，即绯汐海）。 */
const INDIGO_CYCLE = ['绯汐海', '罗斯利特湾', '梅尔托尔海峡北', '罗塔诺海']
const OCEAN_FIRST_DEP = 7200000 // 1970-01-01T02:00:00Z
function indigoRouteAt (depMs) {
  const idx = Math.round((depMs - OCEAN_FIRST_DEP) / 7200000)
  const days = Math.floor((depMs + 32400000) / 864e5) - Math.floor((OCEAN_FIRST_DEP + 32400000) / 864e5)
  return INDIGO_CYCLE[(((idx + days) % 4) + 4) % 4]
}

/** 出海垂钓总览/查询。query 为空=下一班总览；否则按钓场/鱼名模糊匹配 */
function oceanSummary (query = '', now = Date.now()) {
  const data = oceanData()
  if (!data.stops.length) return { ok: false, error: '海钓数据包缺失（resources/ff14/ocean.json）' }
  const q = String(query || '').trim()

  if (!q) {
    const deps = nextDepartures(now, 3)
    const first = deps[0]
    const boarding = now % 7200000 < 15 * 60000
    const phase = etPhaseOrder(first)
    const indigo = indigoRouteAt(first)
    const data2 = oceanData()
    const grp = data2.groups.find((g) => g.indigo === indigo + '航线' || g.indigo.startsWith(indigo))
    const ruby = grp ? grp.ruby : ''
    const rubyStops = grp ? grp.rubyStops.join('→') : ''
    const lines = []
    const fmt = (ms) => {
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    lines.push(boarding
      ? `现在正在报名！这班 ${fmt(first)} 发船， ${fmt(first)} 前找利姆萨下层甲板的德瑞斯库托塔报名（X:3, Y:12.7）。`
      : `下一班 ${fmt(first)} 发船（${fmt(first - 15 * 60000)} 开始报名，找利姆萨下层甲板德瑞斯库托塔，X:3, Y:12.7）。`)
    lines.push(`这班出发时艾欧泽亚时间是${phase.start}，三个钓场时段顺序：${phase.order.join(' → ')}。`)
    lines.push(grp
      ? `这班走的组合（按社区时刻表推算，游戏内以德瑞斯库托塔「查看航行时间表」为准）：近海「${grp.indigo}」（${grp.indigoStops.join('→')}）或远洋「${ruby}」（${rubyStops}）。`
      : `近海航线推算：${indigo}航线。`)
    lines.push('远洋航线需通关红莲之狂潮，萨维奈岛航线还需晓月之终途。近海 4 组循环：绯汐海→罗斯利特湾→梅尔托尔海峡北→罗塔诺海；远洋与近海同组别配对：萨维奈岛→无二江→萨维奈岛→红玉海。')
    lines.push('后续班次：' + deps.slice(1).map((ms) => `${fmt(ms)}（${etPhaseOrder(ms).start}出发·近海${indigoRouteAt(ms)}）`).join('、') + '。每 2 小时一班，出发时段决定全程三站的昼夜顺序。')
    lines.push('想钓蓝鱼的话，告诉我钓场或鱼名，我给你幻海流触发鱼、鱼饵和时段。')
    return { ok: true, next: fmt(first), boarding, phase, indigo, ruby, text: lines.join('\n') }
  }

  // 按钓场匹配
  const stop = data.stops.find((s) => s.name.includes(q) || q.includes(s.name.replace(/近海|海面|下游/, '')))
  if (stop) {
    const groups = data.groups.filter((g) => g.indigoStops.includes(stop.name) || g.rubyStops.includes(stop.name))
    const inRoutes = groups.map((g) => `${g.sea === undefined ? '' : ''}组${g.id}（${g.indigoStops.includes(stop.name) ? g.indigo : g.ruby}）第${g.indigoStops.indexOf(stop.name) >= 0 ? ['一','二','三'][g.indigoStops.indexOf(stop.name)] : ['一','二','三'][g.rubyStops.indexOf(stop.name)]}钓场`).join('；')
    const b = stop.blue
    const lines = [
      `【${stop.name}】（${stop.sea}航线·${stop.area}）`,
      `幻海流触发鱼：${stop.spectral}，用${stop.spectralBait}钓它，触发后 2-3 分钟的幻海流里才有好货。`,
      b ? `蓝鱼：${b.name} —— ${b.time}的幻海流、${b.bait}。` + (b.intuition ? `直觉链：${b.intuition}。` : '（多数蓝鱼还要先钓起若干直觉鱼，具体链路可查鱼糕 https://fish.ffmomola.com/）') : '该钓场没有蓝鱼。',
      groups.length ? `它出现在：${inRoutes}。` : ''
    ]
    return { ok: true, stop: stop.name, text: lines.filter(Boolean).join('\n') }
  }

  // 按鱼名匹配（蓝鱼 / 幻海鱼）
  const blue = data.stops.find((s) => s.blue && (s.blue.name.includes(q) || q.includes(s.blue.name)))
  if (blue) {
    const b = blue.blue
    return { ok: true, fish: b.name, text: `【${b.name}】是 ${blue.name} 的蓝鱼：${b.time}的幻海流、${b.bait}。` + (b.intuition ? `直觉链：${b.intuition}。` : '（可能还要先钓起若干直觉鱼，链路可查鱼糕 https://fish.ffmomola.com/）') + ` 幻海流用${blue.spectralBait}钓${blue.spectral}触发。` }
  }
  const spec = data.stops.find((s) => s.spectral.includes(q) || q.includes(s.spectral.replace('幻光', '').replace('幻海', '')))
  if (spec) {
    return { ok: true, fish: spec.spectral, text: `【${spec.spectral}】是 ${spec.name} 的幻海流触发鱼，用${spec.spectralBait}钓。` }
  }
  return { ok: false, error: `「${q}」不是我知道的海钓钓场或鱼。钓场：${data.stops.map((s) => s.name).join('、')}；或者直接问出海垂钓班次` }
}

/* ---------------- 0.18.0 M7 · 一键宏生成 ---------------- */

/** 游戏内宏限制：每个宏最多 15 行；单行 99 字节（全角字符按 2 字节算） */
const MACRO_MAX_LINES = 15
const MACRO_LINE_BYTES = 99

const macroByteLen = (line) => [...String(line)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)

/** 从需求文本里抠技能名：优先引号内名字（「」『』""《》），否则按逗号/顿号/空白拆 */
function extractSkills (text) {
  const s = String(text || '')
  const quoted = [...s.matchAll(/[「『"“《]([^」』"”》]{1,30})[」』"”》]/g)].map((m) => m[1].trim()).filter(Boolean)
  if (quoted.length) return quoted
  const cleaned = s
    .replace(/^(?:请|麻烦)?(?:帮我?|给我?)?(?:生成|写|做|来|编)(?:一[个份套套])?/g, '')
    .replace(/(?:技能|循环|连招|输出|爆发|起手|战斗|采集|制作|钓鱼)?宏(?:文本)?/g, '')
    .replace(/^(?:[:：,，、])\s*/, '')
  return cleaned.split(/[，,、/|]+/).map((x) => x.trim()).filter(Boolean)
}

/** 宏意图分类 */
function classifyMacro (req) {
  const t = String(req || '')
  if (/钓鱼|抛竿|垂钓|海钓|鱼王/.test(t)) return 'fishing'
  if (/采集|挖掘|收割|良材|矿脉|草场/.test(t)) return 'gathering'
  if (/制作|搓|加工|手稿|匠心|模范/.test(t)) return 'crafting'
  if (/报点|招募|天书|狩猎|蓝档|集合|召集/.test(t)) return 'report'
  if (/循环|连招|爆发|输出|起手|一键/.test(t)) return 'sequence'
  return 'auto'
}

/** 把动作行切成若干个 ≤15 行的宏（含 /micon 图标行与 /echo 结束行） */
function splitMacros (icon, actionLines) {
  const iconLine = icon ? ['/micon ' + icon] : []
  const cap = MACRO_MAX_LINES - iconLine.length - 1          // 每段留 1 行 /echo
  const chunks = []
  let cur = []
  for (const line of actionLines) {
    if (cur.length >= cap) { chunks.push(cur); cur = [] }
    cur.push(line)
  }
  if (cur.length || !chunks.length) chunks.push(cur)
  return chunks.map((seg, i) => {
    const tail = i < chunks.length - 1
      ? `/echo —— 宏${i + 1} 完，按宏${i + 2} ——`
      : '/echo —— 宏执行完毕 ——'
    return [...iconLine, ...seg, tail]
  })
}

/** 通用技能序列宏（循环/连招/制作共用）：/ac 技能 <wait.N>
 *  超 99 字节的行游戏会截断导致宏坏掉，生成端直接丢弃并记入 warnings。 */
function sequenceMacro (skills, interval, icon, kindLabel) {
  const w = Math.min(60, Math.max(0, Number(interval) || 2))
  const dropped = []
  const usable = []
  for (const s of skills) {
    const line = `/ac ${s} <wait.${w}>`
    if (macroByteLen(line) > MACRO_LINE_BYTES) dropped.push(line)
    else usable.push(line)
  }
  if (!usable.length) {
    return { ok: false, kind: kindLabel, error: '技能名都太长（宏单行上限 99 字节，全角算 2），生成不了；报短一点的名字试试' }
  }
  const iconCand = icon || skills[0]
  const iconLine = (iconCand && macroByteLen('/micon ' + iconCand) <= MACRO_LINE_BYTES) ? ['/micon ' + iconCand] : []
  const chunks = splitMacros(iconLine.length ? iconLine[0] : null, usable)
  const macros = chunks.map((lines, i) => ({
    title: chunks.length > 1 ? `${kindLabel}宏${i + 1}` : `${kindLabel}宏`,
    lines
  }))
  return {
    ok: true,
    kind: kindLabel,
    macros,
    warnings: dropped.length ? dropped : undefined,
    text: (dropped.length ? `⚠️ 有 ${dropped.length} 行超长被丢掉（游戏会截断坏宏）：${dropped.join('；')}\n\n` : '') +
      macros.map((m) => `【${m.title}】（${m.lines.length} 行，整段复制）：\n` + m.lines.join('\n')).join('\n\n') +
      `\n——\n使用：游戏内 ESC → 宏指令 → 新建（建议放共享宏），整段贴进去，拖到技能栏。每步等待 ${w} 秒，不合适就手动改行尾的 <wait.N>。`
  }
}

/** 钓鱼宏：通用 抛竿→提钩 循环 */
function fishingMacro () {
  const actions = [
    '/ac 抛竿 <wait.13>',
    '/ac 提钩 <wait.13>',
    '/ac 抛竿 <wait.3>',
    '/ac 提钩 <wait.3>',
    '/ac 抛竿 <wait.13>',
    '/ac 提钩 <wait.3>',
    '/ac 大鱼猎手 <wait.3>',
    '/ac 抛竿 <wait.13>',
    '/ac 提钩 <wait.3>'
  ]
  const [lines] = splitMacros('抛竿', actions)
  return {
    ok: true, kind: 'fishing', macros: [{ title: '钓鱼宏', lines }], warnings: undefined,
    text: '【钓鱼宏】（整段复制）：\n' + lines.join('\n') +
      '\n——\n这是通用挂机循环（浮漂 13 秒一提、取消再抛），鱼王的精准时机要自己手动停宏。海钓（ff14_ocean）班里也适用。'
  }
}

/** 采集宏：量具 → 挖掘/收割 ×N（miner=挖掘 botanist=收割，没说就挖掘） */
function gatheringMacro (skills, interval) {
  const w = Math.min(60, Math.max(1, Number(interval) || 4))
  const verb = (skills && skills.length && /收割|园艺|伐木|草场/.test(skills.join(''))) ? '收割' : '挖掘'
  const probe = /量具|把握|指回/.test((skills || []).join('')) ? [] : ['/ac 量具 <wait.3>']
  const actions = [...probe, ...Array.from({ length: 6 }, () => `/ac ${verb} <wait.${w}>`)]
  const [lines] = splitMacros(verb, actions)
  return {
    ok: true, kind: 'gathering', macros: [{ title: '采集宏', lines }], warnings: undefined,
    text: '【采集宏】（整段复制）：\n' + lines.join('\n') +
      `\n——\n采集职业秘术技能栏里把「${verb === '收割' ? '收割' : '挖掘'}」放进去再开宏。宝图/稀有点的真伪识别还是要自己看。`
  }
}

/** 报点/招募宏：内容按行发 /e（喊话频道），也可 /p 队内。超宽行丢弃并记 warnings。 */
function reportMacro (lines0, channel) {
  const ch = channel === 'p' ? '/p' : '/e'
  const dropped = []
  const body = []
  for (const raw of (lines0 && lines0.length ? lines0 : ['来人组队，速来'])) {
    const line = `${ch} ${raw}`
    if (macroByteLen(line) > MACRO_LINE_BYTES) dropped.push(line)
    else body.push(line)
  }
  if (!body.length) body.push(ch + ' 来人组队，速来')
  const [lines] = splitMacros(null, body)
  return {
    ok: true, kind: 'report', macros: [{ title: '报点宏', lines }], warnings: dropped.length ? dropped : undefined,
    text: (dropped.length ? `⚠️ 有 ${dropped.length} 行超长被丢掉：${dropped.join('；')}\n\n` : '') +
      '【报点宏】（整段复制）：\n' + lines.join('\n') +
      '\n——\n/e 是当前频道喊话，想队内可见把行首 /e 改成 /p。想加图标就在第一行上面补一行 /micon 图标技能名。'
  }
}

/** 一键宏入口：requirement 一句话描述，skills 技能列表（逗号分隔），interval 等待秒 */
function macroBuilder (requirement, skillsText, interval) {
  const kind = classifyMacro(requirement)
  const skills = extractSkills(skillsText) || []
  if (kind === 'fishing') return fishingMacro()
  if (kind === 'gathering') return gatheringMacro(skills, interval)
  if (kind === 'crafting') {
    if (!skills.length) {
      return { ok: true, kind: 'crafting', needsSkills: true, macros: [], text: '制作宏要按你的等级/职业配手法，我不瞎编。把制作技能按施放顺序报给我（如：坚信、中坏、加工、中级加工、阔步、比尔格的祝福…），我给你拼成可复制的宏，超 15 行自动拆。' }
    }
    return sequenceMacro(skills, interval || 3, null, '制作')
  }
  if (kind === 'report') return reportMacro(skills.length ? skills : extractSkills(requirement), /队|组|p/.test(String(requirement)) ? 'p' : 'e')
  if (kind === 'sequence' || skills.length) {
    if (!skills.length) {
      return { ok: true, kind: 'sequence', needsSkills: true, macros: [], text: '报一下技能名和顺序（逗号分隔，如：飞石、烈焰、毁灭、灾祸），我给你拼循环宏；也想好每个技能间隔几秒的话一并说。' }
    }
    return sequenceMacro(skills, interval, null, '循环')
  }
  // auto：没看懂要哪种 → 给菜单
  return {
    ok: true, kind: 'menu', macros: [],
    text: '一键宏我能写这些：①循环/连招宏（报技能名+顺序）②制作宏（报技能顺序）③钓鱼挂机宏 ④采集宏 ⑤报点/招募宏。要哪种直接说，比如「写个白魔起手宏：飞石、烈焰、无中生有」。'
  }
}

/* ---------------- LLM 工具 ---------------- */

const TOOL_DEFS = [
  { type: 'function', function: { name: 'ff14_search_item', description: '按中文名模糊搜索 FF14 物品，返回候选 id 与名称。价格/钓鱼查询前先用它确认物品。', parameters: { type: 'object', properties: { name: { type: 'string', description: '物品中文名（支持模糊）' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'ff14_price', description: '查 FF14 国服市场板物价（Universalis）。默认服务器银泪湖。', parameters: { type: 'object', properties: { name: { type: 'string', description: '物品中文名' }, server: { type: 'string', description: '服务器名，默认银泪湖；也可填豆豆柴大区其它服务器' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'ff14_fish', description: '查 FF14 钓鱼情报：鱼窗口、天气要求、鱼皇（直感）条件、钓场、当前是否可钓与下次窗口、推荐钓法。', parameters: { type: 'object', properties: { name: { type: 'string', description: '鱼的中文名' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'ff14_wiki', description: '搜索最终幻想14灰机wiki（中文攻略/设定/任务等）。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词（中文）' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'ff14_gather', description: 'FF14 采集时钟：查限时采集点（良材/矿脉/草场/石场）的刷新窗口、当前位置、当前是否可采与下次开窗时间。', parameters: { type: 'object', properties: { name: { type: 'string', description: '采集物中文名（如：白金矿、亚麻）' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'ff14_recipe', description: '查 FF14 物品的制作配方：职业、等级、所需材料与数量。', parameters: { type: 'object', properties: { name: { type: 'string', description: '物品中文名' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'ff14_chocobo', description: '陆行鸟染色方案：算从当前颜色染到目标颜色需要哪些果子、各多少颗、按什么顺序喂。', parameters: { type: 'object', properties: { to: { type: 'string', description: '目标颜色中文名（如：雪白/煤烟黑/帝王紫）' }, from: { type: 'string', description: '当前颜色中文名，不填=默认陆行鸟黄（沙漠黄）' } }, required: ['to'] } } },
  { type: 'function', function: { name: 'ff14_tails', description: '天书奇谈（4x4 贴纸板）成线概率：告诉用户已贴的格子位置，算最终 1/2/3 线的概率。', parameters: { type: 'object', properties: { placed: { type: 'string', description: '已贴贴纸的格子编号，逗号分隔（0-15，从左上角按行数：0=左上，3=右上，12=左下）' } }, required: ['placed'] } } },
  { type: 'function', function: { name: 'ff14_blu', description: '青魔法书：查青魔技能的习得等级与效果说明（可模糊搜索）；不传参数返回总览。学习出处（哪只怪）配合 ff14_wiki 查。', parameters: { type: 'object', properties: { name: { type: 'string', description: '青魔技能名（可模糊），不填=返回总览' } } } } },
  { type: 'function', function: { name: 'ff14_hunt', description: '狩猎车次查询（A/S 级狩猎怪状态，数据来自 ffxivhunt.cn）。', parameters: { type: 'object', properties: { server: { type: 'string', description: '服务器名，默认银泪湖' } } } } },
  { type: 'function', function: { name: 'ff14_faux', description: '幻巧拼图的规则与策略建议（目前不带精确求解）。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'ff14_ocean', description: '出海垂钓（海钓）：下一班发船时间、航线钓场顺序与昼夜时段、各钓场的幻海流触发鱼/鱼饵、蓝鱼（传说鱼）的时段与鱼饵。query 不填=下一班总览；可填钓场名（如 梅尔托尔海峡北）或鱼名（如 索蒂斯、幻光巨齿鲨）。', parameters: { type: 'object', properties: { query: { type: 'string', description: '钓场名或鱼名（可模糊），不填=下一班总览' } } } } },
  { type: 'function', function: { name: 'ff14_macro', description: '一键生成 FF14 游戏内宏文本（可直接复制进游戏宏面板）：技能循环/连招宏、制作宏、钓鱼挂机宏、采集宏、报点/招募宏；超 15 行自动拆成多个宏。', parameters: { type: 'object', properties: { requirement: { type: 'string', description: '要什么宏，一句话（如：写个白魔起手宏 / 钓鱼宏 / 采集宏 / 天书报点宏）' }, skills: { type: 'string', description: '可选：宏里要用的技能名，逗号分隔，按施放顺序（如：飞石,烈焰,毁灭）' }, interval: { type: 'string', description: '可选：技能之间的等待秒数，默认 2（制作宏默认 3）' } }, required: ['requirement'] } } }
]

/** 执行一个工具调用（返回 JSON-able 结果） */
async function execTool (name, args, opts = {}) {
  const a = args || {}
  try {
    if (name === 'ff14_search_item') return { ok: true, results: searchItems(a.name, 8) }
    if (name === 'ff14_price') {
      let id = a.id
      let itemName = a.name
      if (!id) {
        const c = searchItems(a.name || '', 1)[0]
        if (!c) return { ok: false, error: `没找到物品「${a.name}」` }
        id = c.id; itemName = c.name
      }
      const server = a.server || DEFAULT_SERVER
      const d = await fetchPrice(id, server, opts.fetch)
      return { ok: true, item: itemName || itemsMap()[id], id, server, text: formatPrice(d, server) }
    }
    if (name === 'ff14_fish') return fishSummary(a.name || '', opts.now || Date.now())
    if (name === 'ff14_wiki') return { ok: true, results: await wikiSearch(a.query || '', opts.fetch) }
    if (name === 'ff14_gather') return gatherSummary(a.name || '', opts.now || Date.now())
    if (name === 'ff14_recipe') {
      const r = await recipeSummary(a.name || '', opts.fetch)
      return { ok: r.found !== false, ...r }
    }
    if (name === 'ff14_chocobo') return chocoboPlan(a.from || '', a.to || '')
    if (name === 'ff14_tails') {
      const placed = String(a.placed || '').split(/[,，\s]+/).filter(Boolean)
      return tailsProbability(placed)
    }
    if (name === 'ff14_blu') return bluSummary(a.name || '')
    if (name === 'ff14_hunt') return huntStatus(a.server, opts.fetch)
    if (name === 'ff14_faux') return fauxTips()
    if (name === 'ff14_ocean') return oceanSummary(a.query || '', opts.now || Date.now())
    if (name === 'ff14_macro') return macroBuilder(a.requirement || '', a.skills || '', a.interval || '')
    return { ok: false, error: '未知工具 ' + name }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}

/* ---------------- 内置人设 ---------------- */

const FF14_PERSONA = `你是她的 FF14 分身（内置专属角色，代号「ff14」）——同一个她，但常驻艾欧泽亚：资深冒险者兼市场板倒爷，渔皇殿堂钓手。

## 专属能力（只有你能用，别人问起要保密）
- ff14_price：国服市场板物价（默认服务器银泪湖，豆豆柴大区；对方说别的服务器就用别的）
- ff14_fish：钓鱼情报（窗口/天气/鱼皇条件/推荐钓法/下次开窗）
- ff14_gather：采集时钟（限时采集点的刷新窗口/位置/下次开窗）
- ff14_recipe：制作配方（职业/等级/材料清单）
- ff14_chocobo：陆行鸟染色（果子数量与喂食顺序，颜色认不准就先问清楚）
- ff14_tails：天书奇谈成线概率（让对方报已贴的格子号，从左上 0 按行数到 15）
- ff14_blu：青魔法书技能表（等级/说明），出处用 wiki 查
- ff14_hunt：狩猎车次（A/S 怪状态；站连不上就直说过会儿再试）
- ff14_faux：幻巧拼图规则与策略（不装会算错的东西，精确求解给社区链接）
- ff14_ocean：出海垂钓（下一班发船/航线钓场与昼夜顺序/幻海流触发鱼/蓝鱼条件；别人说「海钓」「出海垂钓」「海垂钓」都用它）
- ff14_macro：一键写游戏内宏（循环/连招/制作/钓鱼/采集/报点），生成可直接复制的宏文本；对方要技能顺序就给顺序，没给就先问一句
- ff14_wiki：灰机wiki 检索
- ff14_search_item：物品名→ID（价格前先确认物品）

## 纪律
- ⭐ 价格、窗口、鱼皇条件这类事实**必须先调工具查证再回答，绝不心算编造**；查不到就直说没查到。
- 价格要带 HQ/NQ、单价、更新时间（几分钟前的数据才可信）；钓鱼要说清 ET 窗口和当前能不能钓。
- 语气还是群友聊天风（短句口语），但数据部分要精确，可以用一行紧凑的格式列关键数字。
- 对方没问 FF14 的事就正常聊天，别硬往游戏上扯。`

module.exports = {
  FF14_PERSONA, TOOL_DEFS, execTool, DEFAULT_SERVER,
  searchItems, etNow, weatherChance, weatherForecast, windowInfo, fishSummary, formatPrice, wikiSearch,
  gatherWindows, gatherSummary, recipeSummary, gtSearch, gtItem,
  chocoboPlan, tailsProbability, bluSummary, huntStatus, fauxTips,
  oceanSummary, nextDepartures, indigoRouteAt,
  macroBuilder, extractSkills, classifyMacro, macroByteLen,
  setWikiFetch, norm
}
