const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const self = require('../src/main/companion/self')
const ctxBudget = require('../src/main/companion/context')

function tmpWs () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-rollback-'))
}

/* ---------------- 负反馈回滚（0.21.0 用户要求：测试期可以回滚） ---------------- */

test('快照：改状态会留痕，数值没变就不重复写', () => {
  const dir = tmpWs()
  self.patchState(dir, { quiet: 0.5 })
  const n1 = self.stateHistory(dir).length
  self.patchState(dir, { quiet: 0.5 })
  assert.equal(self.stateHistory(dir).length, n1, '同样数值不该再写一条')
  self.patchState(dir, { quiet: 0.8 })
  assert.equal(self.stateHistory(dir).length, n1 + 1)
})

test('回滚：能回到几小时前的状态（情绪回去，日记不动）', () => {
  const dir = tmpWs()
  // 「3 小时前」：先写一条带旧时间戳的快照
  self.ensure(dir)
  const st = self.patchState(dir, { quiet: 0.2, mood: 0.8 })
  assert.ok(st)
  // 手工把快照时间戳拨回 3 小时前（模拟当时的样子）
  const logPath = path.join(self.selfDir(dir), 'state.log.jsonl')
  const rows = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  rows[0].t = Date.now() - 3 * 3600 * 1000
  fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  // 之后情绪恶化
  self.patchState(dir, { quiet: 0.9, mood: 0.1, ignoreStreak: 5 })
  self.writeDay(dir, self.dateStr(), '今天的日记不该被回滚删掉')
  // 回滚 2 小时（目标是 3 小时前那条快照）
  const r = self.rollbackState(dir, 2 * 3600 * 1000)
  assert.equal(r.ok, true)
  const back = self.getState(dir)
  assert.ok(Math.abs(back.quiet - 0.2) < 1e-9, 'quiet 应回到 0.2，实际 ' + back.quiet)
  assert.ok(Math.abs(back.mood - 0.8) < 1e-9)
  assert.equal(back.ignoreStreak, 0)
  assert.equal(self.readDay(dir, self.dateStr()), '今天的日记不该被回滚删掉', '回滚不碰日记')
  assert.ok(back.rolledBackAt > 0, '要留下回滚痕迹')
})

test('回滚：快照不够时明确拒绝，不硬编默认值', () => {
  const dir = tmpWs()
  self.patchState(dir, { quiet: 0.5 })
  const r = self.rollbackState(dir, 24 * 3600 * 1000) // 回到一天前：没有那条快照
  assert.equal(r.ok, false)
  assert.equal(r.error, 'no-snapshot')
})

test('清零：情绪归零但事件流和日记都保留', () => {
  const dir = tmpWs()
  self.patchState(dir, { quiet: 0.9, cold: 0.7 })
  self.appendEvent(dir, { kind: 'ignored', text: '被无视' })
  const r = self.resetState(dir)
  assert.equal(r.ok, true)
  const st = self.getState(dir)
  assert.equal(st.quiet, 0)
  assert.equal(st.cold, 0)
  assert.equal(st.mood, 0.5)
  assert.ok(self.readEvents(dir).length >= 1, '事件流不动')
})

/* ---------------- 跨天检索（长期记忆的取回端） ---------------- */

test('检索：按关键词搜日记索引，命中天带摘要（索引由写日记时同步，同 inner）', () => {
  const dir = tmpWs()
  self.writeDay(dir, '2026-10-01', '那天一起看了新番，第一集就神回。')
  self.writeDay(dir, '2026-10-15', '他今天在调打包，忙到很晚。')
  self.upsertIndex(dir, { date: '2026-10-01', summary: '一起看了新番', tags: self.pickTags('那天一起看了新番，第一集就神回。', 6) })
  self.upsertIndex(dir, { date: '2026-10-15', summary: '调打包的一天', tags: self.pickTags('他今天在调打包，忙到很晚。', 6) })
  const hits = self.searchDays(dir, '新番', 3)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].date, '2026-10-01')
  assert.match(hits[0].summary, /新番/)
  // 同一天重写覆盖，不会留两行
  self.upsertIndex(dir, { date: '2026-10-01', summary: '重写后的摘要', tags: [] })
  assert.equal(self.readIndex(dir).filter((r) => r.date === '2026-10-01').length, 1)
})

test('检索：什么都不写时返回空，不抛错', () => {
  const dir = tmpWs()
  assert.deepEqual(self.searchDays(dir, '随便', 3), [])
})

test('问过去才给全文：wantsRecall 中英日都认，闲聊不误触', () => {
  assert.equal(self.wantsRecall('昨天我们在干什么'), true)
  assert.equal(self.wantsRecall('你还记得那个游戏吗'), true)
  assert.equal(self.wantsRecall('what did we do yesterday'), true)
  assert.equal(self.wantsRecall('この前言ってたこと覚えてる？'), true)
  assert.equal(self.wantsRecall('今天天气不错'), false)
  assert.equal(self.wantsRecall('帮我打开记事本'), false)
})

/* ---------------- 上下文预算（历史裁剪 / 按需注入） ---------------- */

test('estTokens：CJK 一字一 token，英文四字符一 token', () => {
  assert.equal(ctxBudget.estTokens('abcd'), 1)
  assert.equal(ctxBudget.estTokens('你好世界'), 4)
  assert.equal(ctxBudget.estTokens('你好world'), 2 + 2, 'world 5 字符进 2 个 token')
  assert.equal(ctxBudget.estTokens(''), 0)
})

test('trimHistory：从最新往回装，超预算就断，但至少留底', () => {
  const mk = (n, c) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: 'x'.repeat(c) + i }))
  const h = mk(20, 100) // 20 条 × 100 字
  const out = ctxBudget.trimHistory(h, 500, 3)
  assert.ok(out.length <= 8, '500 字预算最多装 5 条 + 兜底，实际 ' + out.length)
  assert.ok(out.length >= 3, 'keepAtLeast 必须兜住')
  assert.equal(out[out.length - 1].content.slice(-1), '9', '必须保住最新的那条')
  // 预算管够时一条不丢
  assert.equal(ctxBudget.trimHistory(h, 99999).length, 20)
})

test('assemble：高优先级先保住，超预算丢低优先级，顺序不乱', () => {
  const out = ctxBudget.assemble([
    { key: 'a', text: 'A'.repeat(500), priority: 10 },
    { key: 'b', text: 'B'.repeat(500), priority: 30 },
    { key: 'c', text: 'C'.repeat(500), priority: 20 }
  ], 900)
  assert.ok(out.includes('B'.repeat(100)) || out.startsWith('B'), '优先级最高的 b 先装')
  assert.ok(!out.includes('AAAA'), '最低的 a 整段丢弃')
  const order = out.indexOf('B') < out.indexOf('C')
  assert.ok(order, '输出顺序仍按传入顺序')
})

test('wantFixed：首轮必发、每 N 轮复述、话里提到就补', () => {
  assert.equal(ctxBudget.wantFixed('petTools', { turn: 1 }), true)
  assert.equal(ctxBudget.wantFixed('petTools', { turn: 2, userText: '今天吃啥' }), false)
  assert.equal(ctxBudget.wantFixed('petTools', { turn: 2, userText: '摸摸头' }), true, '提到相关词要补发')
  assert.equal(ctxBudget.wantFixed('petTools', { turn: 12, userText: '' }), true, '到周期要复述')
})

test('historyBudget：有上限按比例反推，没上限给保守默认', () => {
  assert.equal(ctxBudget.historyBudget(0), 24000)
  const b = ctxBudget.historyBudget(65536) // 64k 模型
  assert.ok(b >= 8000 && b <= 60000, '必须夹在区间里：' + b)
  assert.ok(b > ctxBudget.historyBudget(16384), '上下文越大历史预算越大')
})
