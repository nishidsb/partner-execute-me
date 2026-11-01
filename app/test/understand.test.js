'use strict'
/**
 * 0.36.0 · 语义判读（understand）
 *
 * 这一组的出发点就是用户 20:11 那句「不能固定句式，要跟这个句式一样的意思也可以才行」。
 * 所以要测的不是「某个词在不在表里」，而是三件事：
 *   1. 判读器的协议靠得住（脏输出能剥、坏输出不炸、慢/断不影响主流程）
 *   2. 判读结果回来之后，**补**和**撤**都真的落到状态上
 *   3. 同一句话不会被重复累加（两个入口 + 缓存）
 *
 * 模型判得准不准不在这里测（那是模型能力）；这里测的是「不管它怎么答，系统行为都对」。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const understand = require('../src/main/companion/understand')
const presence = require('../src/main/companion/presence')
const inner = require('../src/main/companion/inner')

function tmpWs () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-und-'))
}

/** 干净的在场实例：idle 恒为 0（测试只关心口头宣告这一路） */
function freshPresence () {
  return presence.createPresence({ idleSec: () => 0 })
}

/* --------------------------------------------------------- 解析容错 */

test('解析：模型爱加的东西都得剥掉', () => {
  const cases = [
    '{"leave":2,"back":0,"about":"other","tone":"none","weight":0}',
    '```json\n{"leave":2,"back":0,"about":"other","tone":"none","weight":0}\n```',
    '好的，判读结果如下：\n{"leave":2,"back":0,"about":"other","tone":"none","weight":0}\n希望有帮助。',
    "{'leave':2,'back':0,'about':'other','tone':'none','weight':0}",
    '{"leave":2,"back":0,"about":"other","tone":"none","weight":0,}'
  ]
  for (const raw of cases) {
    const j = understand.parseReply(raw)
    assert.ok(j, '应能解析：' + raw.slice(0, 30))
    assert.equal(j.leave, 2, raw.slice(0, 30))
  }
})

test('解析：越界值必须夹住，不能把状态打穿', () => {
  const j = understand.parseReply('{"leave":9,"back":-3,"about":"X","tone":"yell","weight":5}')
  assert.equal(j.leave, 2)
  assert.equal(j.back, 0)
  assert.equal(j.about, 'other')
  assert.equal(j.tone, 'none')
  assert.equal(j.weight, 0, 'tone 无效时权重必须归零，否则会凭空扣她')
})

test('解析：说她自己却给了语气', () => {
  const j = understand.parseReply('{"leave":0,"back":0,"about":"her","tone":"criticize","weight":0.6}')
  assert.equal(j.tone, 'criticize')
  assert.equal(j.weight, 0.6)
})

test('解析：说他自己 → 绝不能算成批评她', () => {
  const j = understand.parseReply('{"leave":0,"back":0,"about":"him","tone":"criticize","weight":0.9}')
  assert.equal(j.tone, 'none')
  assert.equal(j.weight, 0)
})

test('解析：既说走又说回，以走为准', () => {
  const j = understand.parseReply('{"leave":2,"back":2,"about":"other","tone":"none","weight":0}')
  assert.equal(j.leave, 2)
  assert.equal(j.back, 0)
})

test('解析：垃圾输出一律 null，不猜', () => {
  for (const raw of ['', '我觉得他是要出门的', '{}', 'null', '[1,2,3]', '发生错误']) {
    const j = understand.parseReply(raw)
    assert.equal(j, null, '不该解析出东西：' + raw)
  }
})

/* --------------------------------------------------------- 提示词 */

test('提示词：原句进得去，语境只取最近几条', () => {
  const ctx = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: 'd' },
    { role: 'user', content: 'e' },
    { role: 'assistant', content: 'f' }
  ]
  const msgs = understand.buildPrompt('车来了', ctx)
  assert.equal(msgs[0].role, 'system')
  assert.ok(msgs[0].content.includes('看意思，不看字面'), '要点必须写死进提示词')
  const u = msgs[1].content
  assert.ok(u.includes('车来了'), '待判句必须在')
  assert.ok(u.includes('你：f'), '最近一条语境必须在')
  assert.ok(!u.includes('他：a'), '太旧的语境不该占 token')
})

test('提示词：没有语境也能用', () => {
  const msgs = understand.buildPrompt('我走了', [])
  assert.ok(msgs[1].content.includes('我走了'))
  assert.ok(!msgs[1].content.includes('【刚在聊】'))
})

/* --------------------------------------------------------- 判读器壳 */

test('判读器：同句第二次走缓存，不再烧一次 token', async () => {
  let n = 0
  const ins = understand.createInterpreter({
    cfgGet: () => ({ apiBaseUrl: 'http://x', apiModel: 'm' }),
    chat: async () => {
      n++
      return '{"leave":2,"back":0,"about":"other","tone":"none","weight":0}'
    }
  })
  const a = await ins.interpret('车来了')
  const b = await ins.interpret('车来了')
  assert.equal(n, 1, '缓存没生效')
  assert.deepEqual(a, b)
  assert.equal(ins.status().cached, 1)
})

test('判读器：模型抽风/超时/没配 → null，绝不抛', async () => {
  const boom = understand.createInterpreter({
    cfgGet: () => ({ apiBaseUrl: 'http://x', apiModel: 'm' }),
    chat: async () => { throw new Error('ECONNRESET') }
  })
  assert.equal(await boom.interpret('我出门了'), null)

  const junk = understand.createInterpreter({
    cfgGet: () => ({ apiBaseUrl: 'http://x', apiModel: 'm' }),
    chat: async () => '我不太确定'
  })
  assert.equal(await junk.interpret('我出门了'), null)

  const noCfg = understand.createInterpreter({ cfgGet: () => ({}), chat: async () => 'x' })
  assert.equal(await noCfg.interpret('我出门了'), null)
})

test('判读器：长文不判（省一次调用）', async () => {
  let n = 0
  const ins = understand.createInterpreter({
    cfgGet: () => ({ apiBaseUrl: 'http://x', apiModel: 'm' }),
    chat: async () => { n++; return '{}' }
  })
  await ins.interpret('啊'.repeat(500))
  assert.equal(n, 0)
})

test('判读器：连发不并发堆积（严格串行）', async () => {
  let running = 0
  let peak = 0
  const ins = understand.createInterpreter({
    cfgGet: () => ({ apiBaseUrl: 'http://x', apiModel: 'm' }),
    chat: async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return '{"leave":0,"back":0,"about":"other","tone":"none","weight":0}'
    }
  })
  await Promise.all(['a', 'b', 'c', 'd'].map((t) => ins.interpret(t)))
  assert.equal(peak, 1, '并发峰值必须是 1，否则连发会打满')
})

/* ------------------------------------------- 判读结果落到状态：补 + 撤 */

test('补：词表完全不认的说法（「车来了」）也能判出她在不在', async () => {
  const ws = tmpWs()
  inner.setContext({ wsDir: ws, log: () => { }, llmCfg: {}, feedback: 'on' })
  const p = freshPresence()
  // 词表这一层确实瞎了——这正是用户要解决的问题
  assert.equal(p.noteUserMessage('车来了，先不聊了'), '')
  assert.notEqual(p.state(), 'gone')

  inner.setJudge({ interpret: async () => ({ leave: 2, back: 0, about: 'other', tone: 'none', weight: 0, why: '要出门' }) })
  await inner.judgeUser('车来了，先不聊了', { presence: p })

  assert.equal(p.state(), 'gone', '判读器认出来之后必须真的进离开状态')
  inner.setJudge(null)
  fs.rmSync(ws, { recursive: true, force: true })
})

test('撤：词表看错的话（「我出门前问你的那个」）不该让她闭嘴', async () => {
  const ws = tmpWs()
  inner.setContext({ wsDir: ws, log: () => { }, llmCfg: {}, feedback: 'on' })
  const p = freshPresence()
  assert.equal(p.noteUserMessage('我出门前问你的那个视频叫什么'), 'leave', '词表确实会误判')
  assert.equal(p.state(), 'gone')

  inner.setJudge({ interpret: async () => ({ leave: 0, back: 0, about: 'other', tone: 'none', weight: 0, why: '' }) })
  await inner.judgeUser('我出门前问你的那个视频叫什么', { presence: p })

  assert.notEqual(p.state(), 'gone', '判读说不是要走，就该撤回来')
  inner.setJudge(null)
  fs.rmSync(ws, { recursive: true, force: true })
})

test('补：词表没认出的不满（「你可真安静啊」）要能压下去', async () => {
  const ws = tmpWs()
  inner.setContext({ wsDir: ws, log: () => { }, llmCfg: {}, feedback: 'on' })
  inner.setJudge({ interpret: async () => ({ leave: 0, back: 0, about: 'her', tone: 'criticize', weight: 0.7, why: '嫌她闷' }) })

  inner.noteUser('你可真安静啊')
  const before = inner.displeasure()
  await inner.judgeUser('你可真安静啊', {})
  assert.ok(inner.displeasure() > before, '判读出的批评必须累加')

  inner.setJudge(null)
  fs.rmSync(ws, { recursive: true, force: true })
})

test('撤：词表误伤的句子要把负反馈退回去', async () => {
  const ws = tmpWs()
  inner.setContext({ wsDir: ws, log: () => { }, llmCfg: {}, feedback: 'on' })
  inner.setJudge({ interpret: async () => ({ leave: 0, back: 0, about: 'other', tone: 'none', weight: 0, why: '' }) })

  inner.noteUser('这歌里别吵了，小声点')   // 含「别吵」→ 词表会算成让她闭嘴
  const mid = inner.displeasure()
  assert.ok(mid > 0, '词表这一步确实误加了')
  await inner.judgeUser('这歌里别吵了，小声点', {})
  assert.equal(inner.displeasure(), 0, '判读说是别人/别的事，就该退回去')

  inner.setJudge(null)
  fs.rmSync(ws, { recursive: true, force: true })
})

test('不重复：同一句被两个入口各调一次，只累加一遍', async () => {
  const ws = tmpWs()
  inner.setContext({ wsDir: ws, log: () => { }, llmCfg: {}, feedback: 'on' })
  inner.setJudge({ interpret: async () => ({ leave: 0, back: 0, about: 'her', tone: 'stop', weight: 1, why: '让闭嘴' }) })

  inner.noteUser('别说了')
  const one = inner.displeasure()
  inner.noteUser('别说了')   // assistant.handleSend 与 companion.handleMessage 会各走一次
  // displeasure 带时间衰减因子，两次读数间浮点上会差 1e-8 量级——幂等断言用近似比较（曾经 flaky）
  assert.ok(Math.abs(inner.displeasure() - one) < 0.001, '第二遍不能再加（近似幂等）')

  inner.setJudge(null)
  fs.rmSync(ws, { recursive: true, force: true })
})

test('判读失败时一切照旧（词表说了算，不因为判读挂了变哑巴）', async () => {
  const ws = tmpWs()
  inner.setContext({ wsDir: ws, log: () => { }, llmCfg: {}, feedback: 'on' })
  const p = freshPresence()
  p.noteUserMessage('我出门了')
  assert.equal(p.state(), 'gone')

  inner.setJudge({ interpret: async () => null })
  const r = await inner.judgeUser('我出门了', { presence: p })
  assert.equal(r, null)
  assert.equal(p.state(), 'gone', '判读没结果，原判必须保持')

  inner.setJudge(null)
  fs.rmSync(ws, { recursive: true, force: true })
})

test('软离开：只判出「暗示」时按 away 算，不锁死成不在', async () => {
  const ws = tmpWs()
  inner.setContext({ wsDir: ws, log: () => { }, llmCfg: {}, feedback: 'on' })
  let idle = 0
  const p = presence.createPresence({ idleSec: () => idle })
  inner.setJudge({ interpret: async () => ({ leave: 1, back: 0, about: 'other', tone: 'none', weight: 0, why: '先忙了' }) })

  await inner.judgeUser('先忙了，晚点说', { presence: p })
  assert.equal(p.get().soft, true, '「先忙了」这种该记成软离开')
  assert.equal(p.state(), 'here', '手还在动，不能当场当人不在')

  idle = 6 * 60   // 6 分钟没动
  assert.equal(p.state(), 'away', '确实没动了才压到 away')
  assert.notEqual(p.state(), 'gone', '软离开不该升成 gone——那句也可能是「看完这集再说」')

  p.declareBack('回来了')
  assert.equal(p.get().soft, false)
  idle = 0   // 人回来了会动鼠标；declareBack 只撤口头宣告，不清系统空闲
  assert.equal(p.state(), 'here')

  inner.setJudge(null)
  fs.rmSync(ws, { recursive: true, force: true })
})
