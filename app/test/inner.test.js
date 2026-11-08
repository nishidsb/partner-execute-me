'use strict'
/**
 * 自我层（self）单测：事件流 / 日记 / 状态 / 负反馈 / 注入预算 / 多角色隔离。
 * 只测 self.js（纯文件操作，不依赖 electron），inner.js 的调度靠静态断言兜。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const self = require('../src/main/companion/self')

function tmpWs () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-self-'))
}
function ws (dir) { self.ensure(dir); return dir }

test('事件流：写入后能按日期读回来，跨天分开', () => {
  const dir = ws(tmpWs())
  const t1 = new Date('2026-10-26T10:00:00').getTime()
  const t2 = new Date('2026-10-27T10:00:00').getTime()
  self.appendEvent(dir, { kind: 'user', text: '在吗', at: t1 })
  self.appendEvent(dir, { kind: 'say', text: '在的', at: t2 })

  const d1 = self.readEvents(dir, '2026-10-26')
  const d2 = self.readEvents(dir, '2026-10-27')
  assert.equal(d1.length, 1)
  assert.equal(d1[0].text, '在吗')
  assert.equal(d2.length, 1)
  assert.equal(d2[0].text, '在的')
})

test('事件流：坏行不影响后续读取', () => {
  const dir = ws(tmpWs())
  self.appendEvent(dir, { kind: 'user', text: 'ok' })
  fs.appendFileSync(path.join(dir, 'self', 'events', self.dateStr() + '.jsonl'), '{坏掉的json\n')
  self.appendEvent(dir, { kind: 'user', text: '还是能读到' })
  const evs = self.readEvents(dir, self.dateStr())
  assert.equal(evs.length, 2)
})

test('日记：写入后 recentDays 是新的在前', () => {
  const dir = ws(tmpWs())
  self.writeDay(dir, '2026-10-24', '第一天的日记')
  self.writeDay(dir, '2026-10-26', '第三天的日记')
  self.writeDay(dir, '2026-10-25', '第二天的日记')
  const days = self.recentDays(dir, 3)
  assert.deepEqual(days.map((d) => d.date), ['2026-10-26', '2026-10-25', '2026-10-24'])
})

test('注入：完全没有数据时返回空串（老行为一点不变）', () => {
  const dir = ws(tmpWs())
  assert.equal(self.promptBlock(dir), '')
})

test('注入：有日记就带上（默认摘要模式，问过去时给全文），并声明是她自己写的', () => {
  const dir = ws(tmpWs())
  self.writeDay(dir, self.dateStr(), '今天他一直在弄打包，我没敢说话。')
  // 0.21.0：无 query 默认摘要（省上下文），带 query 或 deep=true 才给全文
  const terse = self.promptBlock(dir)
  assert.match(terse, /是你自己写的话|是你这几天记下的东西/)
  assert.match(terse, /今天他一直在弄打包/, '摘要至少要露出当天的一句提要')
  assert.ok(!terse.includes('带着这些继续过'), '摘要模式不该带全文版开头')
  const deep = self.promptBlock(dir, { query: '昨天我们在干什么' })
  assert.match(deep, /这是你自己写的话/)
  assert.match(deep, /今天他一直在弄打包/)
})

test('注入：预算硬上限 2000 字符，超了砍掉最早的日记', () => {
  const dir = ws(tmpWs())
  const long = 'あ'.repeat(900)
  self.writeDay(dir, '2026-10-20', long)
  self.writeDay(dir, '2026-10-21', long)
  self.writeDay(dir, '2026-10-22', long)
  const block = self.promptBlock(dir)
  assert.ok(block.length <= 2000, '实际长度 ' + block.length)
  assert.ok(block.includes('2026-10-22'), '最近的日记必须留下')
})

test('多角色：两个工作区完全不串（日记和状态各是各的）', () => {
  const a = ws(tmpWs())
  const b = ws(tmpWs())
  self.writeDay(a, self.dateStr(), '我是A的日记')
  self.writeDay(b, self.dateStr(), '我是B的日记')
  self.patchState(a, { quiet: 0.8 })
  assert.match(self.promptBlock(a), /我是A的日记/)
  assert.doesNotMatch(self.promptBlock(a), /我是B的日记/)
  assert.equal(self.getState(a).quiet, 0.8)
  assert.equal(self.getState(b).quiet, 0)
})

test('状态：脏数据被夹在 0~1，不影响读取', () => {
  const dir = ws(tmpWs())
  self.patchState(dir, { quiet: 9, mood: -3, cold: 'x' })
  const st = self.getState(dir)
  assert.equal(st.quiet, 1)
  assert.equal(st.mood, 0)
  assert.equal(st.cold, 0, '非数字回落到默认值')
})

test('负反馈：说了三次没人理 → 安静度上升，但不超过 0.75 的上限', () => {
  const dir = ws(tmpWs())
  const base = new Date('2026-10-26T09:00:00').getTime()
  for (let i = 0; i < 4; i++) {
    self.appendEvent(dir, { kind: 'say', text: '第' + i + '句', at: base + i * 60 * 60 * 1000 })
  }
  // 一条回应都没有
  const st = self.settleDay(dir, '2026-10-26')
  assert.ok(st.quiet > 0, '应该变安静')
  // 连续多天都没人理，也不能突破上限（护栏：最冷也只是不太想说话）
  for (const d of ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) {
    const t = new Date(d + 'T09:00:00').getTime()
    for (let i = 0; i < 4; i++) self.appendEvent(dir, { kind: 'say', text: 'x', at: t + i * 3600000 })
    const s = self.settleDay(dir, d)
    assert.ok(s.quiet <= 0.75, d + ' quiet=' + s.quiet)
  }
})

test('负反馈：同一天只结算一次（lastDay 去重）', () => {
  const dir = ws(tmpWs())
  const t = new Date('2026-10-26T09:00:00').getTime()
  for (let i = 0; i < 4; i++) self.appendEvent(dir, { kind: 'say', text: 'x', at: t + i * 3600000 })
  const a = self.settleDay(dir, '2026-10-26')
  const b = self.settleDay(dir, '2026-10-26')
  assert.equal(a.quiet, b.quiet, '重复结算会把安静度越推越高，必须去重')
})

test('负反馈：回应率高的时候会慢慢恢复', () => {
  const dir = ws(tmpWs())
  self.patchState(dir, { quiet: 0.6 })
  const t = new Date('2026-10-26T09:00:00').getTime()
  for (let i = 0; i < 3; i++) {
    const at = t + i * 3600000
    self.appendEvent(dir, { kind: 'say', text: 'x', at })
    self.appendEvent(dir, { kind: 'user', text: '嗯', at: at + 60000 })
  }
  const st = self.settleDay(dir, '2026-10-26')
  assert.ok(st.quiet < 0.6, '被回应了应该松一点')
})

test('统计：只有 say 计入期待回应，narration（废话）不算', () => {
  const dir = ws(tmpWs())
  const t = new Date('2026-10-26T09:00:00').getTime()
  self.appendEvent(dir, { kind: 'narration', text: '好热', at: t })
  self.appendEvent(dir, { kind: 'narration', text: '脖子酸', at: t + 1000 })
  const s = self.dayStats(dir, '2026-10-26')
  assert.equal(s.says, 0, '废话被无视不算受伤')
  assert.equal(s.responseRate, 1)
})

test('统计：她说完 10 分钟内有回应算答上，超时不算', () => {
  const dir = ws(tmpWs())
  const t = new Date('2026-10-26T09:00:00').getTime()
  self.appendEvent(dir, { kind: 'say', text: '在吗', at: t })
  self.appendEvent(dir, { kind: 'user', text: '在', at: t + 60 * 1000 })
  self.appendEvent(dir, { kind: 'say', text: '帮我看看', at: t + 3600000 })
  self.appendEvent(dir, { kind: 'user', text: '嗯', at: t + 3600000 + 20 * 60 * 1000 })
  const s = self.dayStats(dir, '2026-10-26')
  assert.equal(s.says, 2)
  assert.equal(s.answered, 1)
  assert.equal(s.ignored, 1)
})

test('负反馈：被扔出去会掉心情、变冷；被摸只恢复一点点（不能一摸就满血）', () => {
  const dir = ws(tmpWs())
  self.patchState(dir, { cold: 0.5, mood: 0.5, quiet: 0.6 })
  const afterThrow = self.noteAttention(dir, 'throw')
  assert.ok(afterThrow.cold > 0.5)
  assert.ok(afterThrow.mood < 0.5)
  const afterPet = self.noteAttention(dir, 'pet')
  assert.ok(afterPet.cold < afterThrow.cold)
  assert.ok(afterPet.cold > 0, '一次摸不能把冷淡清零')
})

test('注入：安静度和冷淡会翻译成人话，不暴露数字', () => {
  const dir = ws(tmpWs())
  self.patchState(dir, { quiet: 0.8, cold: 0.6, ignoreStreak: 4 })
  const block = self.promptBlock(dir)
  assert.match(block, /说话比平时少|提不起劲/)
  assert.match(block, /别质问|把话收着/)
  assert.doesNotMatch(block, /0\.8|0\.6/, '不能把参数原样吐给模型')
})

test('成长年表只追加，不覆盖', () => {
  const dir = ws(tmpWs())
  self.appendGrowth(dir, '第 1 天：写了日记')
  self.appendGrowth(dir, '第 2 天：第一次主动搭话')
  const raw = fs.readFileSync(path.join(dir, 'self', 'growth.md'), 'utf8')
  assert.equal(raw.trim().split('\n').length, 2)
})

test('日期用本地时区（不能用 UTC，否则晚上写的日记会记到明天）', () => {
  const late = new Date('2026-10-26T23:30:00')
  assert.equal(self.dateStr(late), '2026-10-26')
})

test('护栏：废话通道的频控与时段必须写死，不能被后人改松', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/main/companion/chatter.js'), 'utf8')
  assert.match(src, /MAX_PER_DAY\s*=\s*\d+/, '每天上限')
  assert.match(src, /q\s*>=\s*0\.6/, '她太安静时不碎碎念')
  assert.match(src, /不要提问/, '废话不能变成提问（没人会回答）')
  // 0.46.0 朗读改为「默认开、低频」：出口 speech 由开关×概率×每日上限决定，不许写死常开
  assert.match(src, /voiceCfgOf/, '朗读参数集中管理（开关/概率/每日上限）')
  assert.match(src, /chatterVoiceDailyMax/, '每日朗读上限必须在场')
})

test('护栏：看屏搭话不受安静度拦截（功能不能因为心情失效）', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/main/companion/index.js'), 'utf8')
  // 0.37.0：这行判据从 opts.kind 改成了先解构的 kind，护栏正则跟着松一格——
  // 之前它一直红着没人管，等于这条护栏早就名存实亡。
  assert.match(src, /(?:opts\.)?kind === 'watch'/, '只有看屏搭话会被安静度拦')
  // 0.47.1：kind: 'alarm' 随闹钟直接开口路径退役——到点只入账约定候选，看情况开口
  assert.ok(!src.includes("kind: 'alarm'"), '闹钟开口标记已退役')
  assert.ok(src.includes('setDuePlan'), '到点走约定候选通道')
  assert.match(src, /noteSuppress/, '想开口但忍住这件事要留痕')
})

test('0.37.0 她自己待着：selfLog 取全部时不能截断，否则每日上限形同虚设', () => {
  const dir = ws(tmpWs())
  const inner = require('../src/main/companion/inner')
  inner.setContext({ wsDir: dir, log: () => { } })
  for (let i = 0; i < 9; i++) self.appendEvent(dir, { kind: 'self', text: '第' + i + '件' })
  assert.equal(inner.selfLog(0).length, 9, '不传/传 0 = 全部（每日 8 件上限靠它算）')
  assert.equal(inner.selfLog().length, 9)
  assert.equal(inner.selfLog(3).length, 3)
  assert.equal(inner.selfLog(3)[2].text, '第8件')
  inner.setContext({ wsDir: '' })
})

test('护栏：废话和「说给你听」是两条通道，事件类型不同', () => {  const src = fs.readFileSync(path.resolve(__dirname, '../src/main/companion/self.js'), 'utf8')
  assert.match(src, /const NARRATION = 'narration'/)
  assert.match(src, /const SAY = 'say'/)
})

test('解析：日记的摘要单独拆出来，正文不带 [摘要] 这行', () => {
  const out = self.splitDiary('今天他一直在弄打包，我没说话。\n\n[摘要] 她开始忍着不催他')
  assert.equal(out.summary, '她开始忍着不催他')
  assert.ok(!out.body.includes('[摘要]'))
  assert.match(out.body, /弄打包/)
})

test('解析：模型没写摘要时正文原样保留', () => {
  const out = self.splitDiary('就一段话')
  assert.equal(out.summary, '')
  assert.equal(out.body, '就一段话')
})

test('解析：归纳只认三种标记，废话丢掉，条数有上限', () => {
  const out = self.parseDistill([
    '这是说明，应该被丢掉',
    '- [习惯] 他忙的时候我就趴着',
    '[习惯] 喜欢待在窗台',
    '[习惯] 话变少了',
    '[习惯] 第四条应该被丢掉',
    '[喜欢] 晒太阳｜因为暖',
    '[不喜欢] 被拎起来｜因为头晕',
    '[喜欢] 第三条应该被丢掉'
  ].join('\n'))
  assert.equal(out.habits.length, 3)
  assert.equal(out.tastes.length, 2)
  assert.equal(out.tastes[1].kind, 'hate')
  assert.equal(out.tastes[0].reason, '因为暖')
})

test('解析：模型回 [无] 时什么都不产出', () => {
  const out = self.parseDistill('[无]')
  assert.equal(out.habits.length, 0)
  assert.equal(out.tastes.length, 0)
})

/* ==================== 0.45.0 悄悄观察 ==================== */

test('悄悄观察：noteObserve 进事件流，observesToday 只取今天、可限量', async () => {
  const inner = require('../src/main/companion/inner')
  const dir = ws(tmpWs())
  inner.setContext({ wsDir: dir, log: () => { } })
  inner.noteObserve('他在改 main.js')
  inner.noteObserve('   ')            // 空白丢弃
  inner.noteObserve('x'.repeat(100))  // 截到 80
  const all = inner.observesToday(0)
  assert.equal(all.length, 2, '空白不记')
  assert.ok(all[0].text.includes('main.js'))
  assert.ok(all[1].text.length <= 80)
  assert.equal(inner.observesToday(1).length, 1, '限量取最新的')
  // 跟 narration 是两种事件：日记里一个是「瞥见他在」一个是「我随口念」
  const evs = self.readEvents(dir, self.dateStr())
  assert.ok(evs.some((e) => e.kind === 'observe' && e.text.includes('main.js')))
  assert.ok(!evs.some((e) => e.kind === 'observe' && e.text.length > 80))
})
