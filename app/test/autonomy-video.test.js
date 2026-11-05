/**
 * 0.46.32 她自己看视频（autonomy × biliWatch）：
 * - 挡 1「去B站」场不再滚动搜索页，直接看视频（runVideoWatch）
 * - 挡 2/3 的 watch_video 工具接进 space/free 工具集
 * - 失败如实（watch-failed），无字幕也如实（watched:false）
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const A = require('../src/main/companion/autonomy')

/** 真假时钟：wait 立刻返回，now 走真钟 */
const fakeClock = () => ({ now: Date.now, sleep: async () => {} })

test('0.46.32 挡1 B站场：看视频而不是滚动搜索页', async () => {
  const calls = []
  const fake = async (a) => {
    calls.push(a)
    return {
      ok: true, action: 'watch', bvid: 'BV1xx411c7mD',
      title: '金属加工の基礎', owner: '职人频道', duration: '8:20', durationSec: 500,
      desc: '基礎を解説', url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      watched: true, transcript: '今日は…', note: ''
    }
  }
  const soli = []
  const r = await A.runBrowse({
    topic: '金属加工',
    site: { key: 'bili', host: 'bilibili.com', search: () => 'x' },
    cfg: {},
    onSoliloquy: (l) => { soli.push(l) },
    soliMax: 2,
    biliWatchFn: fake,
    ...fakeClock()
  })
  assert.equal(r.ok, true)
  assert.equal(r.why, 'done')
  assert.match(r.seen[0], /金属加工の基礎/)
  assert.equal(r.url, 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(r.watched, true)
  assert.equal(r.moved, 2, '看完了不写牵挂（moved<2 会触发 carry）')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].query, '金属加工')
  assert.ok(soli.length >= 1, '出门/看完应嘀咕')
  // 不该打开浏览器：整场没有动过键鼠的痕迹（由不调 openUrl/cua 保证——上面没传就能跑通即是证明）
})

test('0.46.32 挡1 看视频失败：如实 watch-failed，不硬演', async () => {
  const r = await A.runBrowse({
    topic: '没什么东西',
    site: { key: 'bili', host: 'bilibili.com', search: () => 'x' },
    cfg: {},
    biliWatchFn: async () => ({ ok: false, error: '搜索失败：网络' }),
    ...fakeClock()
  })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'watch-failed')
})

test('0.46.32 挡2 地盘工具集：watch_video 可用且异步结果正确展开', async () => {
  const events = []
  const space = A.spaceToolsOf('C:\\tmp\\ws', {
    journal: (e) => events.push(e),
    userBack: () => false,
    biliWatchFn: async () => ({
      ok: true, title: 'テスト動画', owner: 'up', duration: '3:00', durationSec: 180,
      desc: 'desc', url: 'https://www.bilibili.com/video/BV1test00000',
      watched: true, transcript: '字幕正文…', note: ''
    })
  })
  assert.ok(space.defs.some((d) => d.function.name === 'watch_video'), 'watch_video 应在挡2工具列表')
  const out = await space.exec('watch_video', { query: 'テスト' })
  const parsed = JSON.parse(String(out))
  assert.equal(parsed.title, 'テスト動画')
  assert.equal(parsed.transcript, '字幕正文…')
  assert.ok(events.some((e) => e.kind === 'watch'), 'journal 应记 watch')
})

test('0.46.32 挡3 完全开放：watch_video 也在场', async () => {
  const events = []
  const free = A.freeToolsOf({
    journal: (e) => events.push(e),
    userBack: () => false,
    cua: null,
    biliWatchFn: async () => ({
      ok: true, title: '自由動画', owner: 'up', duration: '5:00', durationSec: 300,
      desc: 'd', url: 'https://www.bilibili.com/video/BV1free00000',
      watched: false, transcript: '', note: '这个视频没有 CC/AI 字幕，正文暂时看不了——只能基于标题和简介聊'
    })
  })
  assert.ok(free.defs.some((d) => d.function.name === 'watch_video'), 'watch_video 应在挡3工具列表')
  const out = await free.exec('watch_video', { query: '自由研究' })
  const parsed = JSON.parse(String(out))
  assert.equal(parsed.watched, false)
  assert.match(parsed.note, /没有 CC\/AI 字幕/)
  assert.ok(events.some((e) => e.kind === 'watch'))
})

test('0.46.32 静态接线：三处提示词/分支都在源文件里（防 require 断链式的静默丢失）', async () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, '../src/main/companion/autonomy.js'), 'utf8')
  assert.ok(src.includes("site.key === 'bili'"), '挡1 B站分支应存在')
  assert.ok(src.includes('runVideoWatch'), '看视频剧本应存在')
  assert.ok((src.match(/watch_video/g) || []).length >= 3, '挡2/挡3工具+提示词应至少三处')
  assert.ok(src.includes('require(\'./biliWatch\')'), 'biliWatch 应被引入')
})
