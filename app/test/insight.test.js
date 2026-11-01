/**
 * 电脑画像 · 推断层与印象档案（0.24.0）
 *
 * 这些测试守的是「判断质量」而不是「代码能跑」：
 *   - 搜索词只从搜索参数里取，不能顺手把 token 存下来
 *   - 作息分级不能把「过了午夜才睡」说成「凌晨还在玩」
 *   - 历史数据只够几天时，不能把一切都判成「新兴趣」
 *   - 印象要有去重、可纠正、有上限
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const browser = require('../src/main/profile/browser')
const insight = require('../src/main/profile/insight')
const profile = require('../src/main/profile')

const DAY = 86400000

function tmpWs () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-pc-'))
}

/* --------------------------------------------------------- 搜索词提取 */

test('insight: 只从搜索参数里取查询词，普通 URL 取不到', () => {
  assert.equal(browser.searchQueryOf('https://cn.bing.com/search?q=%E5%8E%9F%E7%A5%9E'), '原神')
  assert.equal(browser.searchQueryOf('https://www.baidu.com/s?wd=python%20%E6%8A%A5%E9%94%99'), 'python 报错')
  assert.equal(browser.searchQueryOf('https://search.bilibili.com/all?keyword=%E7%95%AA%E5%89%A7'), '番剧')
  assert.equal(browser.searchQueryOf('https://www.bilibili.com/video/BV1xx?spm_id_from=333'), '')
  assert.equal(browser.searchQueryOf('https://example.com/?token=abc'), '')
})

test('insight: 太短/纯符号的搜索词丢掉，不乱记', () => {
  assert.equal(browser.searchQueryOf('https://www.google.com/search?q=a'), '')
  assert.equal(browser.searchQueryOf('https://www.google.com/search?q=%21%21%21'), '')
})

/* ------------------------------------------------------------- 主题 */

test('insight: 主题从标题词、域名、书签里认出来，短词不误伤', () => {
  const now = Date.now()
  const raw = {
    browser: {
      domains: [
        { host: 'github.com', hits: 40, h7: 40, h7p: 0, first: now - DAY, last: now },
        { host: 'bilibili.com', hits: 200, h7: 100, h7p: 100, first: now - 10 * DAY, last: now }
      ],
      recent: [
        { title: '【原神】深渊 12 层满星阵容', host: 'bilibili.com', at: now },
        { title: '崩坏：星穹铁道 3.0 开荒', host: 'bilibili.com', at: now }
      ],
      searches: [{ q: 'python 报错 找不到模块', host: 'bing.com', at: now }],
      bookmarks: [{ name: 'GitHub Trending', host: 'github.com' }],
      hourly: new Array(24).fill(1)
    }
  }
  const themes = insight.themesOf(raw)
  const keys = themes.map((t) => t.key)
  assert.ok(keys.includes('game'), '原神/星穹铁道 要归到游戏')
  assert.ok(keys.includes('tech'), 'github 与 python 报错 要归到技术')
  /* 'ps' 这种短词曾经把「DeepSeek 开放平台」误判成创作 */
  const craft = themes.find((t) => t.key === 'craft')
  assert.ok(!craft || craft.score < 10, '短词不该把无关标题刷成创作主题')
})

/* ------------------------------------------------------------- 作息 */

test('insight: 凌晨常在线才是夜猫子，过午夜就睡只是晚睡', () => {
  const nightOwl = insight.rhythmOf({
    browser: { hourly: Array.from({ length: 24 }, (_, i) => (i >= 0 && i <= 4 ? 30 : 5)), recent: [] }
  })
  assert.equal(nightOwl.type, '夜猫子')

  const late = insight.rhythmOf({
    /* 深夜 0-5 点几乎没有，但 23 点很活跃，且每天最晚记录在 00:30 左右 */
    browser: {
      hourly: Array.from({ length: 24 }, (_, i) => (i >= 22 ? 40 : (i <= 4 ? 0 : 5))),
      recent: [0, 1, 2].map((d) => ({ host: 'a.com', at: Date.now() - d * DAY - 23.5 * 3600000 }))
    }
  })
  assert.notEqual(late.type, '夜猫子', '凌晨没活动就不该叫夜猫子')
})

test('insight: 凌晨的访问归到前一天，不会被算成早起', () => {
  /* 10-28 01:30 的访问应算 10-27 的最后一笔 */
  const at = new Date(2026, 9, 28, 1, 30).getTime()
  const hours = insight.lateHourByDay([{ at }])
  assert.equal(hours.length, 1)
  assert.ok(hours[0] > 24, '01:30 应当作 25.5 点，而不是 1.5 点')
})

/* --------------------------------------------------------- 新兴趣 */

test('insight: 登录跳转域名不算新兴趣', () => {
  const now = Date.now()
  const res = insight.freshnessOf({
    browser: {
      domains: [
        { host: 'accounts.google.com', hits: 50, h7: 50, h7p: 0, first: now - DAY },
        { host: 'metacritic.com', hits: 50, h7: 50, h7p: 0, first: now - DAY },
        /* 前一周有大量访问，说明数据不是只覆盖几天（否则会触发 sparse 而不下结论） */
        { host: 'old.com', hits: 200, h7: 0, h7p: 200, first: now - 13 * DAY }
      ],
      recent: []
    }
  })
  const hosts = res.list.map((x) => x.host)
  assert.ok(!hosts.includes('accounts.google.com'), '登录跳转不该被当成兴趣')
  assert.ok(hosts.includes('metacritic.com'))
})

test('insight: 历史只覆盖最近几天时，不硬说有新兴趣', () => {
  const now = Date.now()
  const res = insight.freshnessOf({
    browser: {
      /* 所有访问都在近 7 天 → sparse，宁愿不说 */
      domains: [
        { host: 'a.com', hits: 100, h7: 100, h7p: 0, first: now - DAY },
        { host: 'b.com', hits: 80, h7: 80, h7p: 0, first: now - 2 * DAY }
      ],
      recent: []
    }
  })
  assert.equal(res.sparse, true)
  assert.equal(res.list.length, 0)
})

test('insight: 同根域名合并，不占两个名额', () => {
  const now = Date.now()
  const res = insight.freshnessOf({
    browser: {
      domains: [
        { host: 'bilibili.com', hits: 40, h7: 12, h7p: 28, first: now - 12 * DAY },
        { host: 't.bilibili.com', hits: 90, h7: 90, h7p: 20, first: now - 12 * DAY },
        { host: 'b.com', hits: 10, h7: 3, h7p: 7, first: now - 12 * DAY }
      ],
      recent: []
    }
  })
  const bl = res.list.filter((x) => x.host.includes('bilibili'))
  assert.equal(bl.length, 1, 'bilibili 与 t.bilibili 应合并成一条')
})

/* --------------------------------------------------------- 行为风格 */

test('insight: 样本太少不下行为风格结论', () => {
  const now = Date.now()
  const thin = insight.styleOf({ browser: { searches: [{ q: '怎么装系统', at: now }] } })
  assert.equal(thin, null, '只有一条样本不该给判断')

  const rich = insight.styleOf({
    browser: {
      searches: ['怎么', '如何', '教程', '为什么', '原理', '解决', '哪个好', '推荐'].map((q) => ({ q, at: now }))
    }
  })
  assert.ok(rich && rich.top.length, '样本够了才给结论')
})

/* ------------------------------------------------------- 印象档案 */

test('印象: 追加、去重、纠正、读到新到旧', () => {
  const ws = tmpWs()
  try {
    assert.equal(profile.writeImpression(ws, { note: '他说过不喜欢被问工作的事' }).added, true)
    assert.equal(profile.writeImpression(ws, { note: '他说过不喜欢被问工作的事' }).added, false, '同一句不重复写')
    assert.equal(profile.writeImpression(ws, { note: '收藏都是原神和崩坏' }).total, 2)

    /* 主人纠正：抹掉旧的、写新的 */
    const r = profile.writeImpression(ws, { remove: '不喜欢被问工作', note: '其实可以问工作，只是别追问细节' })
    assert.equal(r.ok, true)
    assert.equal(r.removed, 1)
    const text = profile.readImpression(ws)
    assert.ok(!text.includes('不喜欢被问工作'), '旧的要被抹掉')
    assert.ok(text.includes('别追问细节'))
    assert.ok(text.includes('原神'), '别的印象不能被牵连')
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('印象: 超过上限折叠最旧的，最近的还在', () => {
  const ws = tmpWs()
  try {
    const n = profile.IMPRESSION_MAX + 5
    for (let i = 0; i < n; i++) profile.writeImpression(ws, { note: '印象第 ' + i + ' 条' })
    const items = profile.parseImpression(fs.readFileSync(path.join(ws, 'pc', 'impression.md'), 'utf8'))
    assert.equal(items.length, profile.IMPRESSION_MAX)
    assert.ok(items[items.length - 1].text.includes(String(n - 1)), '最新的一条必须在')
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('印象: 空工作区不炸', () => {
  const r = profile.writeImpression('', { note: 'x' })
  assert.equal(r.ok, false)
  assert.equal(profile.readImpression(''), '')
})

/* ----------------------------------------------------- 提示词整段 */

test('提示词: 印象放在判断与事实之前，且受字数上限约束', () => {
  const ws = tmpWs()
  try {
    profile.writeImpression(ws, { note: '腰疼，久坐会难受' })
    fs.mkdirSync(path.join(ws, 'pc'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'pc', 'insight.md'), '# x\n\n## 她的判断\n他是个夜猫子。\n\n## 值得留意的矛盾\n- 说的和做的不一致\n')
    fs.writeFileSync(path.join(ws, 'pc', 'profile.md'), '# 主人电脑画像\n\n## 上网\nbilibili×558\n')
    const block = profile.promptBlock(ws)
    assert.ok(block.includes('腰疼'), '印象要在')
    assert.ok(block.includes('夜猫子'), '判断要在')
    assert.ok(block.includes('bilibili'), '事实要在')
    assert.ok(block.indexOf('腰疼') < block.indexOf('夜猫子'), '印象要排在判断前面')
    assert.ok(block.indexOf('夜猫子') < block.indexOf('bilibili'), '判断要排在事实前面')
    assert.ok(block.length <= profile.BLOCK_LIMIT + 40, '整段必须在预算内')
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

/* ------------------------------------------------- 设备运行时间（0.24.0 补） */

test('作息: 没有浏览记录时，只凭关机时间也能判晚睡', () => {
  const r = insight.rhythmOf({
    browser: null,
    sessions: { ok: true, source: 'eventlog', lateShutdowns: 3, avgUpHours: 12, sessions: [] }
  })
  assert.equal(r.type, '晚睡型')
  assert.ok(r.note.includes('凌晨'))
})

test('作息: 关机记录和浏览记录打架时信关机', () => {
  const hourly = new Array(24).fill(0)
  hourly[15] = 100   // 浏览器统计出来「白天为主」= 常规作息
  const r = insight.rhythmOf({
    browser: { hourly, recent: [], domains: [] },
    sessions: {
      ok: true, source: 'eventlog', lateShutdowns: 2, avgUpHours: 11, avgBootHour: 13,
      sessions: [{ on: Date.UTC(2026, 9, 27, 5) }, { on: Date.UTC(2026, 9, 28, 5) }]
    }
  })
  assert.equal(r.type, '晚睡型')
  assert.equal(r.avgBootHour, 13)
})

test('交叉: 他说 01:20 睡、电脑 03:00 才关 → 出矛盾', () => {
  const ins = insight.build({
    browser: { hourly: new Array(24).fill(0), recent: [], domains: [] },
    sessions: {
      ok: true, source: 'eventlog', lateShutdowns: 4, avgUpHours: 14,
      sessions: [
        { on: 1, off: new Date(2026, 9, 27, 3, 5).getTime() },
        { on: 1, off: new Date(2026, 9, 28, 2, 55).getTime() }
      ]
    }
  }, { health: { ok: true, sleep: { avgBed: '01:20', avgHours: 7 } } })
  const hit = ins.cross.find((c) => c.kind === 'bed-vs-shutdown')
  assert.ok(hit, '应判出「说 1:20 睡、电脑 3 点才关」')
  assert.ok(hit.text.includes('01:20'))
})
