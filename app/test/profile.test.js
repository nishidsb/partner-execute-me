/**
 * 电脑画像（0.24.0）：URL 归一、域名聚合、摘要生成、游戏识别、使用时长日期键。
 * 只测纯函数与摘要拼装，不去读真实浏览器库（那属于真机验证）。
 */
const test = require('node:test')
const assert = require('node:assert')

const browser = require('../src/main/profile/browser')
const games = require('../src/main/profile/games')
const usage = require('../src/main/profile/usage')
const profile = require('../src/main/profile')

test('profile: URL 归一剥掉 query 与 hash（不留搜索词）', () => {
  assert.equal(browser.cleanUrl('https://www.bilibili.com/video/BV1xx?spm=1&t=2#part'), 'https://www.bilibili.com/video/BV1xx')
  assert.equal(browser.cleanUrl('https://cn.bing.com/search?q=秘密'), 'https://cn.bing.com/search')
  assert.equal(browser.cleanUrl('not a url'), 'not a url')
})

test('profile: 域名去掉 www 前缀', () => {
  assert.equal(browser.hostOf('https://www.bilibili.com/x'), 'bilibili.com')
  assert.equal(browser.hostOf('https://search.bilibili.com/all?k=1'), 'search.bilibili.com')
  assert.equal(browser.hostOf(''), '')
})

test('profile: 游戏识别认 Steam/Epic 与常见游戏名', () => {
  assert.equal(games.isGameEntry({ name: 'Whatever', source: 'steam' }), true)
  assert.equal(games.isGameEntry({ name: '原神' }), true)
  assert.equal(games.isGameEntry({ name: '崩坏：星穹铁道' }), true)
  assert.equal(games.isGameEntry({ name: 'Microsoft Word' }), false)
})

test('profile: 摘要由各路数据拼出且不超上限', () => {
  const raw = {
    at: Date.now(),
    days: 7,
    browser: {
      ok: true,
      days: 7,
      totalVisits: 120,
      sources: [{ browser: 'Edge', profile: 'Default' }],
      hourly: Array.from({ length: 24 }, (_, i) => (i >= 22 || i <= 1 ? 50 : 1)),
      domains: [{ host: 'bilibili.com', hits: 88, last: Date.now(), title: '哔哩哔哩' }],
      recent: [{ title: '冬冰', host: 'bilibili.com', at: Date.now(), url: 'https://bilibili.com/v/1' }]
    },
    bili: { loggedIn: true, folders: [{ title: '默认收藏夹', count: 12 }], favorites: [{ title: '某个视频', folder: '默认收藏夹', up: 'UP' }], history: [{ title: '看过的', up: 'UP', at: Date.now() }] },
    games: { ok: true, steam: [{ name: 'Stardew Valley' }], epic: [], games: [{ name: '绝区零', source: 'startmenu' }], apps: [] },
    usage: { ok: true, totalHours: 12.5, sampledDays: 3, byApp: [{ app: 'msedge', minutes: 400, share: 60 }], byDay: [], titles: [{ name: 'B站 - Edge', minutes: 200 }] },
    files: { ok: true, dirs: [{ group: 'desktop', path: 'C:/Users/x/Desktop', files: 10, subdirs: 2 }], byExt: [{ ext: 'exe', count: 5, mb: 1 }], recent: [{ name: 'a.png', group: 'desktop', mb: 1, at: Date.now() }], big: [], totalFiles: 10 }
  }
  const md = profile._buildProfileMd(raw)
  assert.ok(md.includes('bilibili.com'), '要包含常去站点')
  assert.ok(md.includes('Steam') || md.includes('Stardew'), '要包含游戏库')
  assert.ok(md.includes('msedge'), '要包含常用程序')
  assert.ok(md.length <= profile.SUMMARY_LIMIT + 80, '摘要必须在 1800 字上限内')
})

test('profile: 没有数据的段不会硬凑', () => {
  const md = profile._buildProfileMd({ at: Date.now(), browser: null, bili: { loggedIn: false }, games: null, usage: null, files: null })
  assert.ok(md.includes('电脑画像'))
  assert.ok(!md.includes('## 上网'), '没有浏览器数据就别写上网段')
})

test('profile: 使用时长按本地日期归天', () => {
  const d = usage.dateKey(new Date(2026, 9, 28, 15, 30))
  assert.equal(d, '2026-10-28')
})

test('profile: 做梦素材把印象与判断交给记忆管道', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-dreammat-'))
  fs.mkdirSync(path.join(ws, 'pc'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'pc', 'impression.md'), [
    '# 她记下的主人（她自己的观察，不是数据）', '',
    '- [2026-10-27] 聊原神会来劲',
    '- [2026-10-28] 久坐腰会疼'
  ].join('\n'))
  fs.writeFileSync(path.join(ws, 'pc', 'insight.md'), [
    '# 她眼中的你（自动推断，可能不准）',
    '> 全是从本机只读痕迹推出来的判断，不是事实记录',
    '## 她的判断',
    '作息上是晚睡型。',
    '## 兴趣主题（按分量排）',
    '- **游戏**（77 分）：ngabbs.com；mihoyo.com',
    ''
  ].join('\n'))

  const m = profile.dreamMaterial(ws, { limit: 1200 })
  assert.ok(m.includes('聊原神会来劲'), '印象要进做梦素材')
  assert.ok(m.includes('晚睡型'), '推断叙述要进做梦素材')
  assert.ok(m.includes('游戏（77 分）'), '主题只留结论')
  assert.ok(!m.includes('ngabbs.com'), '证据链不该占做梦预算')
  assert.ok(!m.includes('全是从本机只读痕迹'), '写给她看的提示语不是素材')

  fs.rmSync(ws, { recursive: true, force: true })
})

test('profile: 没有画像时做梦素材为空（不硬凑）', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-dreammat-empty-'))
  assert.equal(profile.dreamMaterial(ws, {}), '')
  fs.rmSync(ws, { recursive: true, force: true })
})
