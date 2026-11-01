/** FF14 专属角色：本地搜索 / ET 时间 / 天气算法 / 鱼皇摘要（离线部分，不联网） */
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')

const ff14 = require('../src/main/ff14')
const hasData = fs.existsSync(path.join(__dirname, '..', 'resources', 'ff14', 'items-zh.json')) &&
  fs.existsSync(path.join(__dirname, '..', 'resources', 'ff14', 'fishing.json'))

test('norm/etNow 基础', () => {
  assert.equal(ff14.norm('  灵 砂岩 '), '灵砂岩')
  const et = ff14.etNow(0) // unix 0 → ET 00:00
  assert.equal(et.hour, 0)
  const et2 = ff14.etNow(175_000 * 3 + 60_000) // 3 ET 小时后
  assert.equal(et2.hour, 3)
})

test('weatherChance：确定性、范围 0-99、与官方公式一致', () => {
  const rates = [[1, 40], [2, 60], [3, 85], [4, 95], [7, 100]]
  const a = ff14.weatherChance(1_700_000_000, rates)
  const b = ff14.weatherChance(1_700_000_000, rates)
  assert.equal(a, b, '同输入同输出')
  assert.ok(a >= 1 && a <= 7, '返回天气 id')
  // 与 icykoneko/ff14-fish-tracker-app weather.js 的 calculateForecastTarget 同公式复算
  function ref (unixTime) {
    const bell = unixTime / 175
    const inc = (bell + 8 - (bell % 8)) % 24
    const totalDays = ((unixTime / 4200) << 32) >>> 0
    const calcBase = (totalDays * 100) + inc
    const step1 = ((calcBase << 11) ^ calcBase) >>> 0
    const step2 = ((step1 >>> 8) ^ step1) >>> 0
    return step2 % 100
  }
  assert.equal(a, ref(1_700_000_000) === 0 ? 0 : (rates.find((r) => ref(1_700_000_000) < r[1]) || [0])[0])
  // 边界：roll=0 → 第一个天气
  assert.equal(ff14.weatherChance(0, [[3, 50], [1, 100]]) !== undefined, true)
})

test('searchItems：精确/前缀/包含 三级，无数据时安全', () => {
  if (!hasData) return // 数据包缺失时跳过
  const hit = ff14.searchItems('灵砂砾')
  assert.ok(hit.length >= 1, '灵砂砾能搜到')
  assert.ok(hit.some((x) => x.name === '灵砂砾'), '精确命中排前')
  const fuzzy = ff14.searchItems('砂') // 太短，能出结果不崩即可
  assert.ok(Array.isArray(fuzzy))
  assert.deepEqual(ff14.searchItems(''), [])
})

test('weatherForecast：连续段、时间间隔 1400s、名字有映射', () => {
  if (!hasData) return
  const F = require('../resources/ff14/fishing.json')
  const spotId = Object.keys(F.spots).find((k) => F.wr[String(F.spots[k].t)])
  assert.ok(spotId, '能找到有天气表的钓场')
  const fc = ff14.weatherForecast(spotId, 4, 1_700_000_000_000)
  assert.equal(fc.length, 4)
  for (let i = 1; i < fc.length; i++) {
    assert.equal(fc[i].startSec - fc[i - 1].startSec, 1400, '天气段 1400 地球秒')
  }
  assert.ok(fc.every((x) => typeof x.name === 'string' && x.name), '天气名非空')
})

test('windowInfo：全天窗口 / 分段窗口 / 下次开窗', () => {
  const always = ff14.windowInfo([0, 24])
  assert.equal(always.always, true)
  // 固定 now = 某天 ET 03:30 附近：取 unix 使 et hour=3.5 → unix = 3.5/ (3600/175) *1000*3600? 直接用公式反推
  const etMs = 3.5 * 3600 * 1000            // ET 03:30
  const earth = Math.floor(etMs / (3600 / 175))  // 对应 earth ms（忽略 epoch，hour 计算只取 mod）
  const w = ff14.windowInfo([5, 8], earth)
  assert.equal(w.always, false)
  assert.equal(w.inWin, false)
  assert.equal(w.win, '05:00-08:00 ET')
  assert.equal(w.nextEt, 5)
  assert.ok(w.minsToNext >= 0)
})

test('fishSummary：真鱼出全字段，假鱼 found=false', function () {
  if (!hasData) return this.skip()
  const F = require('../resources/ff14/fishing.json')
  const ids = Object.keys(F.fish)
  const one = F.fish[ids.find((k) => F.fish[k].spot)]
  const items = require('../resources/ff14/items-zh.json')
  const name = items[ids.find((k) => Number(k) === (one && Object.keys(F.fish)[0]))] || Object.values(items)[0]
  // 用真实鱼名（从 items 表按 id 取）
  const fishId = Object.keys(F.fish).find((k) => F.fish[k].spot && items[k])
  assert.ok(fishId, '存在有钓场且有中文名的鱼')
  const r = ff14.fishSummary(items[fishId])
  assert.equal(r.found, true)
  assert.ok(r.spot && r.spot.name, '有钓场')
  assert.ok(Array.isArray(r.tips))
  assert.ok(r.weather.forecast.length > 0, '有天气预告')
  const bad = ff14.fishSummary('不存在的鱼xyzq')
  assert.equal(bad.found, false)
})

test('execTool：ff14_search_item 与未知工具（无网络）', async () => {
  if (!hasData) return
  const r1 = await ff14.execTool('ff14_search_item', { name: '灵砂岩' })
  assert.equal(r1.ok, true)
  assert.ok(r1.results.length >= 1)
  const r2 = await ff14.execTool('no_such_tool', {})
  assert.equal(r2.ok, false)
  assert.match(r2.error, /未知工具/)
})

test('TOOL_DEFS：参数全部 string 类型（部分端点不认 anyOf）', () => {
  for (const d of ff14.TOOL_DEFS) {
    assert.equal(d.type, 'function')
    assert.ok(d.function.name.startsWith('ff14_'))
    for (const p of Object.values(d.function.parameters.properties)) {
      assert.equal(p.type, 'string', d.function.name + ' 参数须 string')
    }
  }
})

/* ---------------- 0.18.0 M5：采集时钟 + 配方查询 ---------------- */

test('gatherWindows：窗口内/外、跨零点、下次开窗与剩余时间', () => {
  // unix 0 → ET 00:00。窗口 9 点开、180 ET 分钟（=3 ET 小时）→ ET 2:30 不在窗内，9 点整在窗内
  const nowAt = (h, m) => Date.now() - Date.now() % 4200000 + (h * 3600 + m * 60) * 175 * 1000 - 0 // 近似构造：直接用 etNow 反推不划算，改用固定锚
  // 更稳妥：直接以「当前 ET 时刻」为锚来断言
  const now = Date.now()
  const et = ff14.etNow(now)
  const h = et.hour + et.min / 60
  // 以当前 ET 小时作为窗口起点 → 必在窗内
  const wins = ff14.gatherWindows([et.hour], 180, now)
  assert.equal(wins.length, 1)
  assert.equal(wins[0].inWin, true)
  assert.ok(wins[0].remainMin > 0 && wWinninsOk(wins[0].remainMin), '剩余时间在 (0, 175] 分钟内')
  // 起点为当前 ET 时间的 6 小时后 → 不在窗内，startInMin ≈ 6*70/24*... 直接断言范围
  const nextH = (et.hour + 6) % 24
  const wins2 = ff14.gatherWindows([nextH], 60, now)
  assert.equal(wins2[0].inWin, false)
  assert.ok(wins2[0].startInMin > 0)
  // 跨零点：23 点开窗、120 ET 分钟 → ET 23:30 在窗内（d = h-23 mod 24 = 0.5+... 走另一分支）
  const wins3 = ff14.gatherWindows([23], 120, now)
  assert.equal(wins3.length, 1)
  assert.ok(wins3[0].endEt === 1, '23 点 + 2 ET 小时 → 窗口到 1 点')
})
function wWinninsOk (m) { return m > 0 && m <= 175 }

test('gatherSummary：限时采集点（本地数据包，不联网）', () => {
  const G = ff14.gatherSummary && ff14.gatherSummary('云杉原木')
  if (!G || !G.found) return console.log('# 采集数据包缺失，跳过')
  assert.equal(G.found, true)
  assert.ok(G.nowEorzea)
  assert.ok(G.nodes.length >= 1)
  const n = G.nodes[0]
  assert.ok(n.zone, '有区域名')
  assert.ok(Array.isArray(n.timeEt) && n.timeEt.length, '有刷新时刻')
  assert.ok(typeof n.inWindow === 'boolean')
  assert.ok(n.nextStartInMin == null || n.nextStartInMin >= 0)
  const miss = ff14.gatherSummary('绝对不存在的采集物xyz')
  assert.equal(miss.found, false)
})

test('recipeSummary：注入 fetch，不发真请求', async () => {
  const canned = {
    search: [{ type: 'item', id: 5058, obj: { i: 5058, n: '白钢锭' } }],
    detail: {
      item: {
        name: '白钢锭', id: 5058,
        craft: [{ job: 9, rlvl: 26, lvl: 26, durability: 40, hq: 1, ingredients: [{ id: 5111, amount: 2 }, { id: 2, amount: 2 }] }],
        nodes: [], vendors: [{ dummy: 1 }]
      },
      partials: { 0: { type: 'item', id: 5111, obj: { i: 5111, n: '铁矿' } } }
    }
  }
  const fakeFetch = async (url) => {
    const body = String(url).includes('search.php') ? canned.search : canned.detail
    return { ok: true, json: async () => body }
  }
  const r = await ff14.recipeSummary('白钢锭', fakeFetch)
  assert.equal(r.found, true)
  assert.equal(r.name, '白钢锭')
  assert.equal(r.recipes.length, 1)
  const rec = r.recipes[0]
  assert.equal(rec.job, '锻铁', 'job id 9 → 锻铁')
  assert.equal(rec.hq, true)
  assert.equal(rec.ingredients.length, 2)
  assert.deepEqual(rec.ingredients[0], { name: '铁矿', amount: 2 }, '材料名走 partials')
  assert.equal(rec.ingredients[1].amount, 2)
  assert.ok(rec.ingredients[1].name && !rec.ingredients[1].name.startsWith('物品#'), '本地表有 id 2 的中文名（水晶类）')
  assert.equal(r.vendorCount, 1)
  // 搜索无结果
  const r2 = await ff14.recipeSummary('不存在xyz', async () => ({ ok: true, json: async () => [] }))
  assert.equal(r2.found, false)
})

test('execTool：ff14_gather / ff14_recipe 接线', async () => {
  const g = await ff14.execTool('ff14_gather', { name: '云杉原木' })
  if (g.error && /数据包缺失/.test(g.error)) return console.log('# 采集数据包缺失，跳过')
  assert.ok(g.found !== false)
  const canned = {
    search: [{ type: 'item', id: 1, obj: { i: 1, n: '测试锭' } }],
    detail: { item: { name: '测试锭', craft: [{ job: 15, rlvl: 1, lvl: 1, durability: 40, hq: 0, ingredients: [] }], nodes: [], vendors: [] }, partials: {} }
  }
  const r = await ff14.execTool('ff14_recipe', { name: '测试锭' }, { fetch: async (url) => (String(url).includes('search.php') ? { ok: true, json: async () => canned.search } : { ok: true, json: async () => canned.detail }) })
  assert.equal(r.ok, true)
  assert.equal(r.recipes[0].job, '烹调', 'job 15 → 烹调')
})

/* ---------------- 0.18.0 M5b：陆行鸟染色 / 天书 / 青魔 / 狩猎 / 幻巧 ---------------- */

test('chocoboPlan：黄→素雪白有方案、回放无越界、终点最近色命中', () => {
  const p = ff14.chocoboPlan('', '素雪白')
  if (!p.ok) return console.log('# 染色数据包缺失，跳过')
  assert.equal(p.ok, true)
  assert.ok(p.total >= 10 && p.total <= 120, '果子总数在合理范围，实际 ' + p.total)
  const FRUITS = { 塞尔法特尔沙果: [5, -5, -5], 辉鳞油梨: [-5, 5, -5], '奥·哥摩罗浆果': [-5, -5, 5], 多玛青梅: [-5, 5, 5], 瓦尔醋栗: [5, -5, 5], 谢尔达莱凤梨: [5, 5, -5] }
  let c = [219, 180, 87]
  for (const name of p.order) {
    const d = FRUITS[name]
    assert.ok(d, '序列里的果子名合法: ' + name)
    c = [c[0] + d[0], c[1] + d[1], c[2] + d[2]]
    assert.ok(c.every((v) => v >= 0 && v <= 255), '回放全程不越界: ' + c.join(','))
  }
  // 同色起点 → already
  const same = ff14.chocoboPlan('陆行鸟黄', '陆行鸟黄')
  assert.equal(same.already, true)
  // 未知颜色 → 报错
  const bad = ff14.chocoboPlan('', '纯粹不存在的颜色xyz')
  assert.equal(bad.ok, false)
})

test('tailsProbability：空板分布 + 已稳线 + 非法输入', () => {
  const t = ff14.tailsProbability([])
  assert.equal(t.ok, true)
  assert.equal(t.placed, 0)
  assert.ok(t.text.includes('还剩 9 张'))
  // [0,1,2] 是第一行左段 → 已稳 1 线
  const t2 = ff14.tailsProbability([0, 1, 2])
  assert.equal(t2.alreadyLines, 1)
  // 非法
  assert.equal(ff14.tailsProbability([99]).ok, false)
  assert.equal(ff14.tailsProbability(['a']).ok, false)
})

test('bluSummary：总览 / 模糊查询 / 未命中', () => {
  const all = ff14.bluSummary('')
  if (!all.ok) return console.log('# 青魔数据包缺失，跳过')
  assert.ok(all.total >= 120, '技能总数 ≥120，实际 ' + all.total)
  const hit = ff14.bluSummary('水炮')
  assert.equal(hit.ok, true)
  assert.ok(hit.results[0].name.includes('水炮'))
  assert.equal(ff14.bluSummary('绝对没有的技能xyz').ok, false)
})

test('huntStatus：注入 fetch 200 / 失败两路', async () => {
  const good = await ff14.huntStatus('银泪湖', async () => ({ ok: true, json: async () => ({ trains: [] }) }))
  assert.equal(good.ok, true)
  const bad = await ff14.huntStatus('', async () => { throw new Error('conn refused') })
  assert.equal(bad.ok, false)
  assert.ok(/连不上/.test(bad.error))
})

test('fauxTips：返回规则说明与社区链接', () => {
  const t = ff14.fauxTips()
  assert.equal(t.ok, true)
  assert.ok(t.text.includes('guides.xivcdn.com'))
})

test('execTool：ff14_chocobo / ff14_tails / ff14_blu 接线（参数统一 string）', async () => {
  const c = await ff14.execTool('ff14_chocobo', { to: '煤烟黑' })
  if (c.ok) assert.ok(c.total > 0 && c.order.length === c.total)
  const t = await ff14.execTool('ff14_tails', { placed: '0,1,2' })
  assert.equal(t.ok, true)
  assert.equal(t.alreadyLines, 1)
  const b = await ff14.execTool('ff14_blu', { name: '启示录' })
  if (b.ok) assert.ok(b.results[0].name.includes('启示录'))
})

/* ---------------- 0.18.0 补：出海垂钓 ---------------- */

test('oceanSummary：下一班总览（时间/报名窗/时段/组别配对）', () => {
  const o = ff14.oceanSummary('')
  if (!o.ok) return console.log('# 海钓数据包缺失，跳过')
  assert.ok(o.text.includes('发船'), '提到发船')
  assert.ok(o.text.includes('报名'), '提到报名窗')
  assert.ok(o.text.includes('艾欧泽亚时间'), '提到出发 ET 时段')
  assert.ok(/近海「.+航线」/.test(o.text) && /远洋「.+航线」/.test(o.text), '给出近海+远洋配对航线')
  assert.ok(o.text.includes('推算'), '航线标注了推算属性（不装绝对权威）')
})

test('nextDepartures：每 2 小时一班、偶数点、含正在报名窗', () => {
  // 构造「报名窗内」的时刻：HH:05
  const now = Date.now()
  const inWindow = now - (now % 7200000) + 5 * 60000
  const deps = ff14.nextDepartures(inWindow, 3)
  assert.equal(deps.length, 3)
  assert.equal(deps[0] % 7200000, 0, '发船时刻都是 2 小时整点')
  assert.equal(deps[1] - deps[0], 7200000, '间隔 2 小时')
  assert.ok(deps[0] < inWindow + 7200000, '本班在 2 小时内')
  // 报名窗外的时刻不含本班
  const outWindow = inWindow + 30 * 60000
  const deps2 = ff14.nextDepartures(outWindow, 2)
  assert.ok(deps2[0] > outWindow, '窗外第一班晚于 now')
})

test('indigoRouteAt：与 pf-n 原版游走算法 400 班一致 + 48 班周期', () => {
  const B = 1593302400000
  const walk = (nowMs, count) => {
    const s = nowMs + 324e5 - 27e5
    let oo = Math.floor((s - B) / 864e5)
    let l = new Date(s).getUTCHours()
    l += (1 & l) === 0 ? 1 : 2
    if (l > 23) { oo += 1; l -= 24 }
    const first = B + oo * 864e5 + l * 36e5 - 324e5
    let cc = l, d = (((oo + (l >> 1)) % 4) + 4) % 4
    const out = []
    for (let i = 0; i < count; i++) {
      out.push({ dep: first + i * 72e5, d })
      if (cc === 23) { oo += 1; cc = 1; d = (d + 2) % 4 }
      else { cc += 2; d = (d + 1) % 4 }
    }
    return out
  }
  const CY = ['绯汐海', '罗斯利特湾', '梅尔托尔海峡北', '罗塔诺海']
  for (const { dep, d } of walk(Date.now(), 400)) {
    assert.equal(ff14.indigoRouteAt(dep), CY[d], '游走 vs 闭式 @ ' + new Date(dep).toISOString())
  }
  const t0 = Date.now() + 36e5
  assert.equal(ff14.indigoRouteAt(t0), ff14.indigoRouteAt(t0 + 48 * 7200000), '48 班（4 天）周期')
})

test('oceanSummary：钓场查询（幻海鱼/蓝鱼/组别位置）与蓝鱼/幻海鱼直查', () => {
  const s = ff14.oceanSummary('梅尔托尔海峡北')
  if (!s.ok) return console.log('# 海钓数据包缺失，跳过')
  assert.ok(s.text.includes('幻光海马'), '幻海触发鱼')
  assert.ok(s.text.includes('石沙蚕'), '幻海饵')
  assert.ok(s.text.includes('依拉丝莫龙'), '蓝鱼')
  assert.ok(s.text.includes('组1') || s.text.includes('组3'), '出现组别位置')
  const b = ff14.oceanSummary('索蒂斯')
  assert.ok(b.text.includes('加拉迪翁湾外海') && b.text.includes('火萤') && b.text.includes('天堂之钥'), '蓝鱼直查带直觉链')
  const sp = ff14.oceanSummary('幻光巨齿鲨')
  assert.ok(sp.text.includes('加拉迪翁湾外海') && sp.text.includes('刺螠'), '幻海鱼直查')
  assert.equal(ff14.oceanSummary('绝对不存在的东西xyz').ok, false)
})

test('execTool：ff14_ocean 接线（无参总览 / 带参查询）', async () => {
  const o = await ff14.execTool('ff14_ocean', {})
  if (o.ok) assert.ok(o.text.includes('发船'))
  const q = await ff14.execTool('ff14_ocean', { query: '哈弗古法' })
  if (q.ok) assert.ok(q.text.includes('谢尔达莱') && q.text.includes('乌贼丝'))
})
