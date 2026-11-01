/**
 * FF14 工具「真实调用」端到端测试（0.18.0 M7）
 * 起因：出海垂钓漏了工具没被测出来——旧单测只测「实现存在」，
 * 没有一条「真实用户问题 → execTool → 输出实质内容」的全链路。
 * 本文件对 TOOL_DEFS 里**每一个**工具按真实参数跑 execTool：
 *  - 离线工具：断言输出实质（found/ok/内容非空且像人话）
 *  - 联网工具：真发请求；沙箱连不上/被反爬时 skip 并注明环境限制（不装绿、不虚空断言）
 * 新增工具必须在本文件加对应真实调用用例，否则视为该功能未完成。
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const ff14 = require('../src/main/ff14')

/* 沙箱网络探针：能建立连接（含 4xx 反爬）=可达 */
async function netReachable (url, ms = 8000) {
  try { await fetch(url, { signal: AbortSignal.timeout(ms) }); return true } catch { return false }
}

/* ---------------- 对齐：每个 TOOL_DEFS 都有实现，绝不复发「定义了没实现」的海钓事故 ---------------- */

test('TOOL_DEFS ⇔ execTool：每个已定义工具真实调用后都不是「未知工具」', async () => {
  const probes = {
    ff14_search_item: { name: '水晶' },
    ff14_price: { name: '白钢锭' },
    ff14_fish: { name: '水晶' },          // 假鱼也行，只验不是未知工具
    ff14_wiki: { query: '陆行鸟' },
    ff14_gather: { name: '云杉原木' },
    ff14_recipe: { name: '白钢锭' },
    ff14_chocobo: { to: '雪白' },
    ff14_tails: { placed: '0,1,2' },
    ff14_blu: {},
    ff14_hunt: {},
    ff14_faux: {},
    ff14_ocean: {},
    ff14_macro: { requirement: '钓鱼宏' }
  }
  const names = ff14.TOOL_DEFS.map((d) => d.function.name)
  assert.ok(names.includes('ff14_macro'), 'ff14_macro 已注册')
  for (const name of names) {
    const r = await ff14.execTool(name, probes[name] || {})
    assert.ok(!/未知工具/.test(r.error || ''), `${name} 在 execTool 里没有实现！`)
  }
})

/* ---------------- 离线工具：真实参数 + 实质断言 ---------------- */

test('ff14_search_item：真实查询「水晶」', async () => {
  const r = await ff14.execTool('ff14_search_item', { name: '水晶' })
  assert.equal(r.ok, true)
  assert.ok(r.results.length >= 1, '能搜到候选')
  assert.ok(r.results.some((x) => x.name.includes('水晶')))
  assert.ok(r.results.every((x) => Number.isInteger(x.id)))
})

test('ff14_fish：真实鱼名（从数据包取一条有钓场+中文名的鱼）', async (t) => {
  const F = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'ff14', 'fishing.json'), 'utf8'))
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'ff14', 'items-zh.json'), 'utf8'))
  const fid = Object.keys(F.fish).find((k) => F.fish[k].spot && items[k])
  if (!fid) return t.skip('数据包里没有可用的鱼')
  const r = await ff14.execTool('ff14_fish', { name: items[fid] })
  assert.equal(r.found, true, `真实鱼「${items[fid]}」居然查不到`)
  assert.ok(r.spot && r.spot.name, '有钓场')
  assert.ok(r.weather && Array.isArray(r.weather.forecast), '有天气预告')
  assert.ok(r.nowEorzea && typeof r.window === 'object', '有 ET 与窗口信息')
})

test('ff14_gather：真实查询「云杉原木」', async () => {
  const r = await ff14.execTool('ff14_gather', { name: '云杉原木' })
  if (r.error && /数据包缺失/.test(r.error)) return console.log('# 采集数据包缺失，跳过')
  assert.equal(r.found, true)
  assert.ok(r.nodes.length >= 1)
  assert.ok(r.nodes[0].zone && r.nodes[0].timeEt.length, '有区域与刷新时刻')
  assert.ok(r.nowEorzea)
})

test('ff14_chocobo：黄→雪白，序列回放合法且是「人话」', async () => {
  const r = await ff14.execTool('ff14_chocobo', { to: '雪白' })
  if (!r.ok && /数据包缺失/.test(r.error || '')) return console.log('# 染色数据包缺失，跳过')
  assert.equal(r.ok, true)
  assert.ok(r.total >= 10, '果子总数合理')
  assert.ok(r.text.includes('颗') && r.text.includes('顺序'), '输出可读')
  // 回放：按 6 果子偏移重放全程不越界
  const FR = { 塞尔法特尔沙果: [5, -5, -5], 辉鳞油梨: [-5, 5, -5], '奥·哥摩罗浆果': [-5, -5, 5], 多玛青梅: [-5, 5, 5], 瓦尔醋栗: [5, -5, 5], 谢尔达莱凤梨: [5, 5, -5] }
  let c = [219, 180, 87]
  for (const n of r.order) {
    c = c.map((v, i) => v + FR[n][i])
    assert.ok(c.every((v) => v >= 0 && v <= 255), '回放越界 @ ' + n)
  }
})

test('ff14_tails / ff14_blu / ff14_faux / ff14_ocean：真实参数全链路', async () => {
  const t = await ff14.execTool('ff14_tails', { placed: '0,1,2' })
  assert.equal(t.ok, true)
  assert.match(t.text, /还剩 6 张/)

  const b = await ff14.execTool('ff14_blu', {})
  if (b.ok) {
    assert.ok(b.total >= 120, '青魔总览有 126 条')
    const q = await ff14.execTool('ff14_blu', { name: '水炮' })
    assert.ok(q.ok && q.text.includes('水炮'))
  } else assert.match(b.error, /数据包缺失/)

  const f = await ff14.execTool('ff14_faux', {})
  assert.equal(f.ok, true)
  assert.match(f.text, /幻巧/)

  const o = await ff14.execTool('ff14_ocean', {})
  if (o.ok) {
    assert.match(o.text, /发船/)
    assert.match(o.text, /报名/)
    const s = await ff14.execTool('ff14_ocean', { query: '梅尔托尔海峡北' })
    assert.ok(s.ok && s.text.includes('幻光海马'))
  } else assert.match(o.error, /数据包缺失/)
})

/* ---------------- ff14_macro：一键宏（多场景真实调用） ---------------- */

const isMacroText = (r, minLines) => {
  assert.equal(r.ok, true)
  assert.ok(r.macros.length >= 1)
  for (const m of r.macros) {
    assert.ok(m.lines.length <= 15, '宏不超 15 行')
    assert.ok(m.text !== undefined || m.lines.length >= minLines, '有实质内容')
  }
  assert.ok(!r.warnings, '没有超宽行')
}

test('ff14_macro：循环宏（报技能+顺序）', async () => {
  const r = await ff14.execTool('ff14_macro', { requirement: '写个白魔起手宏', skills: '飞石,烈焰,无中生有,疾风', interval: '2' })
  isMacroText(r, 4)
  assert.ok(r.macros[0].lines.some((l) => l === '/ac 飞石 <wait.2>'), '按给定顺序生成 /ac 行')
  assert.ok(r.macros[0].lines[0].startsWith('/micon '), '带图标行')
  assert.ok(r.text.includes('宏指令'), '有使用说明')
})

test('ff14_macro：超 15 行自动拆分且每段带接续提示', async () => {
  const skills = Array.from({ length: 20 }, (_, i) => '技能' + (i + 1)).join(',')
  const r = await ff14.execTool('ff14_macro', { requirement: '循环宏', skills })
  isMacroText(r, 1)
  assert.equal(r.macros.length, 2, '20 技能拆 2 段')
  assert.ok(r.macros[0].lines.at(-1).includes('宏2'), '段尾有接续提示')
  assert.ok(r.macros[1].lines.at(-1).includes('执行完毕'), '末段收尾')
})

test('ff14_macro：钓鱼宏 / 采集宏 / 报点宏 / 菜单兜底', async () => {
  const fish = await ff14.execTool('ff14_macro', { requirement: '钓鱼宏' })
  isMacroText(fish, 8)
  assert.ok(fish.macros[0].lines.some((l) => l.startsWith('/ac 抛竿')), '抛竿循环')

  const g = await ff14.execTool('ff14_macro', { requirement: '采集宏', interval: '4' })
  isMacroText(g, 6)
  assert.ok(g.macros[0].lines.some((l) => l.includes('量具')), '带量具')

  const rep = await ff14.execTool('ff14_macro', { requirement: '天书报点宏', skills: '教皇厅 8 点速来,带天书' })
  isMacroText(rep, 1)
  const repLines = rep.macros[0].lines.filter((l) => !l.startsWith('/echo'))
  assert.ok(repLines.length >= 1 && repLines.every((l) => l.startsWith('/e ')), '报点内容行走 /e')

  const menu = await ff14.execTool('ff14_macro', { requirement: '帮我写宏' })
  assert.equal(menu.ok, true)
  assert.match(menu.text, /循环\/连招宏/, '没看懂时给菜单不瞎编')

  const craft = await ff14.execTool('ff14_macro', { requirement: '制作宏' })
  assert.equal(craft.ok, true)
  assert.ok(craft.needsSkills, '制作宏没给技能顺序时先问，不编造')
})

test('ff14_macro：超 99 字节的行被丢弃并警告（游戏会截断坏宏）', async () => {
  const long = '超长技能名测试' + '字'.repeat(40)
  const r = await ff14.execTool('ff14_macro', { requirement: '循环宏', skills: long + ',飞石' })
  assert.equal(r.ok, true)
  for (const m of r.macros) {
    for (const line of m.lines) {
      assert.ok(ff14.macroByteLen(line) <= 99, '宏里不允许出现超宽行：' + line)
      assert.ok(!line.includes('超长技能名测试'), '超长技能不得进宏')
    }
  }
  assert.ok(Array.isArray(r.warnings) && r.warnings.some((w) => w.includes('超长技能名测试')), '超宽行记入 warnings 提示模型')
})

/* ---------------- 联网工具：真发请求，沙箱连不上 = skip 并注明 ---------------- */

test('ff14_price：Universalis 真实查询（白钢锭@银泪湖）', async (t) => {
  const up = 'https://universalis.app/api/v2/%E9%93%B6%E6%B3%AA%E6%B9%96/4?listings=1'
  if (!(await netReachable(up))) return t.skip('沙箱连不上 Universalis（真机验证）')
  const r = await ff14.execTool('ff14_price', { name: '白钢锭' })
  assert.equal(r.ok, true, 'price 失败：' + (r.error || ''))
  assert.match(r.text, /银泪湖/)
  assert.match(r.text, /挂单|无挂单/)
})

test('ff14_recipe：garlandtools.cn 真实查询（白钢锭）', async (t) => {
  if (!(await netReachable('https://www.garlandtools.cn/api/search.php?text=test&lang=chs'))) {
    return t.skip('沙箱连不上 garlandtools.cn')
  }
  const r = await ff14.execTool('ff14_recipe', { name: '白钢锭' })
  assert.equal(r.ok, true, 'recipe 失败：' + (r.error || ''))
  assert.equal(r.found, true)
  assert.ok(r.recipes.length >= 1, '白钢锭有配方')
  assert.ok(r.recipes[0].ingredients.length >= 1, '有材料清单')
})

test('ff14_wiki：灰机 wiki 真实检索', async (t) => {
  const url = 'https://ff14.huijiwiki.com/api.php?action=query&list=search&format=json&srlimit=1&srsearch=%E9%99%B8%E8%A1%8C%E9%B3%A5'
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'RyzaAssistant/0.18' } })
    if (res.status >= 400) return t.skip('沙箱被反爬拦（HTTP ' + res.status + '）；真机走 Electron net.fetch 验证')
  } catch { return t.skip('沙箱连不上灰机 wiki') }
  const r = await ff14.execTool('ff14_wiki', { query: '陆行鸟' })
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.results), '返回结构正确')
})

test('ff14_hunt：ffxivhunt.cn 真实查询', async (t) => {
  if (!(await netReachable('https://www.ffxivhunt.cn/'))) return t.skip('沙箱连不上 ffxivhunt.cn（真机重点验证）')
  const r = await ff14.execTool('ff14_hunt', {})
  assert.equal(r.ok, true, 'hunt 失败：' + (r.error || ''))
  assert.ok(r.raw !== undefined, '有原始数据')
})
