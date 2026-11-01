const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const self = require('../src/main/companion/self')
const review = require('../src/main/companion/review')
const autonomy = require('../src/main/companion/autonomy')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'taste-'))

test('polarityOf：显式字段 > reason 文字推断 > 默认喜欢', () => {
  assert.equal(self.polarityOf({ polarity: 'dislike' }), 'dislike')
  assert.equal(self.polarityOf({ polarity: 'like' }), 'like')
  assert.equal(self.polarityOf({ reason: '做梦回顾：不喜欢' }), 'dislike')
  assert.equal(self.polarityOf({ reason: '自主活动：不喜欢' }), 'dislike')
  assert.equal(self.polarityOf({ reason: '做梦回顾：喜欢' }), 'like')
  assert.equal(self.polarityOf({}), 'like', '无信号默认当喜欢')
})

test('review 判重：同物不同极性互不吞', () => {
  const like = { kind: 'taste', what: '被夸', payload: '被夸', polarity: 'like' }
  const dis = { kind: 'taste', what: '被夸', payload: '被夸', polarity: 'dislike' }
  assert.notEqual(review.dedupeKey(like), review.dedupeKey(dis), '喜欢被夸 ≠ 不喜欢被夸')
})

test('tasteBlockOf：极性行注入，空记忆给空块', () => {
  const block = autonomy.tasteBlockOf([
    { what: '听他多说话', polarity: 'like' },
    { what: '被冷落', polarity: 'dislike' },
    { what: '旧笔记' }                       // 无极性 → 喜欢
  ])
  assert.ok(block.includes('喜欢：听他多说话；旧笔记'), '无极性默认并入喜欢：' + block)
  assert.ok(block.includes('不喜欢：被冷落'))
  assert.equal(autonomy.tasteBlockOf([]), '', '空记忆不出声')
})

test('runFree：喜恶记忆进系统提示词（记忆改变行为）', async () => {
  let sysLen = 0
  const llm = {
    chatStream: async ({ messages, toolExec }) => {
      if (!sysLen) sysLen = String(messages[0].content).length
      assert.ok(messages[0].content.includes('喜欢：听他多说话'), 'sys 里要有她的喜欢')
      assert.ok(messages[0].content.includes('不喜欢：被冷落'), 'sys 里要有她的不喜欢')
      try { await toolExec('screenshot', {}) } catch { }
      return { content: '我看了桌面，翻了翻。', toolResults: [] }
    }
  }
  const r = await autonomy.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => 'ok' },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {},
    tastes: [{ what: '听他多说话', polarity: 'like' }, { what: '被冷落', polarity: 'dislike' }]
  })
  assert.equal(r && r.ok, true)
  assert.ok(sysLen > 0)
})

test('memoryEntriesOf：做梦式解析出的喜恶带极性', () => {
  const entries = autonomy.memoryEntriesOf({
    likes: [{ what: '被夸', why: '开心' }],
    dislikes: [{ what: '被晾', why: '难受' }]
  })
  const like = entries.find((x) => x.what === '被夸')
  const dis = entries.find((x) => x.what === '被晾')
  assert.equal(like.polarity, 'like')
  assert.equal(dis.polarity, 'dislike')
})
