/**
 * 0.17.0 模型层策略测试：
 *  - 1.4 temperature 默认不发、显式才发（三协议）
 *  - 1.5 reasoningEffort 映射（openai: reasoning_effort / anthropic: thinking / gemini: thinkingConfig）
 *  - 1.9 usage 记账与汇总
 *  - 1.6/1.7/1.8 session 工具预算、连续失败播报、上下文溢出折叠
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ReadableStream } = require('node:stream/web')

const IMP = (p) => 'file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', p).replace(/\\/g, '/')

const sseBody = (text) => new ReadableStream({
  start (c) { c.enqueue(new TextEncoder().encode(text)); c.close() }
})

const SSE = {
  openai: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
  anthropic: 'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
  gemini: 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n'
}

function captureFetch (respond) {
  const seen = []
  globalThis.fetch = async (_u, init) => { seen.push(init && JSON.parse(init.body)); return respond() }
  return seen
}

/* ---------------- 1.4 / 1.5 参数策略 ---------------- */

test('1.4 openai：temperature 默认不发；显式才发；1.5 reasoning_effort 按档下发', async () => {
  const m = await import(IMP('models/openaiCompat.js'))
  const seen = captureFetch(() => ({ ok: true, body: sseBody(SSE.openai) }))
  await m.chat({ baseUrl: 'https://x/v1', model: 'm', messages: [{ role: 'user', content: 'a' }] })
  assert.ok(!('temperature' in seen[0]), '默认不发 temperature')
  assert.ok(!('reasoning_effort' in seen[0]))
  await m.chat({ baseUrl: 'https://x/v1', model: 'm', messages: [{ role: 'user', content: 'a' }], temperature: 0.3 })
  assert.equal(seen[1].temperature, 0.3)
  await m.chat({ baseUrl: 'https://x/v1', model: 'm', messages: [{ role: 'user', content: 'a' }], reasoningEffort: 'low' })
  assert.equal(seen[2].reasoning_effort, 'low')
  await m.chat({ baseUrl: 'https://x/v1', model: 'm', messages: [{ role: 'user', content: 'a' }], reasoningEffort: 'none' })
  assert.ok(!('reasoning_effort' in seen[3]), 'none = 不发')
})

test('1.5 anthropic：thinking 预算映射，开 thinking 摘 temperature，max_tokens 兜底', async () => {
  const a = await import(IMP('models/anthropic.js'))
  const seen = captureFetch(() => ({ ok: true, body: sseBody(SSE.anthropic) }))
  await a.chat({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'a' }], temperature: 0.5, reasoningEffort: 'high' })
  assert.deepEqual(seen[0].thinking, { type: 'enabled', budget_tokens: 8192 })
  assert.ok(!('temperature' in seen[0]), 'thinking 开启必须摘掉 temperature')
  assert.ok(seen[0].max_tokens > 8192, 'max_tokens 必须 > budget')
  await a.chat({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'x', messages: [{ role: 'user', content: 'a' }] })
  assert.ok(!('thinking' in seen[1]))
})

test('1.5 gemini：thinkingConfig.thinkingBudget 映射（none=0 关闭思考）', async () => {
  const g = await import(IMP('models/gemini.js'))
  const seen = captureFetch(() => ({ ok: true, body: sseBody(SSE.gemini) }))
  await g.chat({ baseUrl: 'https://g', apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'a' }], reasoningEffort: 'max' })
  assert.equal(seen[0].generationConfig.thinkingConfig.thinkingBudget, 8192)
  await g.chat({ baseUrl: 'https://g', apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'a' }], reasoningEffort: 'none' })
  assert.equal(seen[1].generationConfig.thinkingConfig.thinkingBudget, 0)
})

test('1.5 vendors：effort 声明合法（模型清单内）+ ctx/price 字段在', async () => {
  const v = await import(IMP('vendors.js'))
  for (const x of v.VENDORS) {
    // chatgpt 是账号登录接入：无公开单价表 → price 缺省（用量图不估成本），其余厂商必须给
    if (x.type === 'chatgpt') {
      assert.ok(Array.isArray(x.effort) && x.ctx > 0, x.id + ' 缺 effort/ctx')
    } else {
      assert.ok(Array.isArray(x.effort) && x.ctx > 0 && x.price && x.price.inp > 0, x.id + ' 缺 effort/ctx/price')
    }
    for (const m of x.effort) assert.ok(x.models.includes(m), x.id + ' effort 模型越界: ' + m)
  }
})

/* ---------------- 1.9 usage 记账 ---------------- */

test('1.9 usage：recordUsage 累计 + usageSummary 按天汇总与成本估算', async () => {
  const cfg = await import(IMP('config.js'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'))
  cfg.initDataDir(dir)
  const u = await import(IMP('core/usage.js'))
  u.recordUsage({ model: 'm1', prompt: 1000, completion: 500 })
  u.recordUsage({ model: 'm1', prompt: 1000, completion: 500 })
  u.recordUsage({ model: 'm2', prompt: 100, completion: 0 })
  const s = u.usageSummary({ days: 3, price: { inp: 2, out: 8 } })
  assert.equal(s.today.calls, 3)
  assert.equal(s.today.prompt, 2100)
  assert.equal(s.today.completion, 1000)
  // 成本 = (2100*2 + 1000*8)/1e6
  assert.equal(s.today.cost, 0.012)
  assert.equal(s.days.length, 3)
  assert.ok(s.total.calls >= 3)
  // 非法输入不炸
  u.recordUsage({ model: '', prompt: 'x', completion: -5 })
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ---------------- 1.6 / 1.7 / 1.8 session 护栏 ---------------- */

async function newSession (dir) {
  const cfg = await import(IMP('config.js'))
  cfg.initDataDir(dir)
  const { Session } = await import(IMP('core/session.js'))
  const reg = await import(IMP('tools/registry.js'))
  if (!reg.get('test_fail_tool')) {
    reg.register({ name: 'test_fail_tool', description: 'always fails', parameters: { type: 'object', properties: {} }, risk: 'low', exec: () => { throw new Error('boom') } })
  }
  return { Session, reg }
}

test('1.6 工具硬熔断：次数用满后调用不再出门，模型收到「用已有信息回答」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'))
  const { Session } = await newSession(dir)
  const s = new Session({ id: 't-budget', persona: 'x' })
  const calls = []
  s.provider = { chat: async ({ messages, tools }) => {
    calls.push(messages.length)
    if (calls.length === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'calc', arguments: '{"expression":"1+1"}' }], usage: null }
    return { content: '算了', toolCalls: [], usage: null }
  } }
  s._toolDay = new Date().toDateString() // 免被按天重置清零
  s._toolCount = 40 // 假装今天已用满
  await s.send('hi', { policy: { mode: 'never-ask' } })
  assert.equal(calls.length, 2, '给了工具结果后模型能收尾')
  const toolMsg = s.history.find((m) => m.role === 'tool')
  assert.ok(toolMsg && /硬上限/.test(toolMsg.content), 'tool 消息说明预算用满')
  assert.equal(s.toolResultsBlocked, undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('1.7 连续 5 次工具失败：停止调用并把原因说给用户听', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'))
  const { Session } = await newSession(dir)
  const s = new Session({ id: 't-fail', persona: 'x' })
  let rounds = 0
  s.provider = { chat: async () => {
    rounds++
    if (rounds <= 6) return { content: '', toolCalls: [{ id: 'f' + rounds, name: 'test_fail_tool', arguments: '{}' }], usage: null }
    return { content: 'done', toolCalls: [], usage: null }
  } }
  const r = await s.send('hi', { policy: { mode: 'never-ask' } })
  assert.match(r.content, /连续 5 次工具调用失败/, '回复里要有失败说明')
  assert.match(r.content, /test_fail_tool/, '说明里带工具名')
  assert.match(r.content, /boom/, '说明里带最后错误')
  assert.ok(rounds <= 6, '失败播报后不再无限调')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('1.8 上下文溢出：主动折叠（逼近上限）+ 400 溢出错折叠重建重试', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'))
  const { Session } = await newSession(dir)
  const s = new Session({ id: 't-of', persona: 'x' })
  // 主动折叠：塞一大段历史（estTokens 按 chars/2.5 估）
  s.history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(4000), at: Date.now() }))
  assert.ok(s.estTokens() > 48000 * 0.85 - 1)
  assert.ok(s.collapseHistory(), '折叠发生')
  assert.ok(s.history.length <= 10, '折叠后只留摘要+最近几条')
  assert.ok(s.history[0].internal && /折叠/.test(s.history[0].content))
  // 反应式：端点 400 报 context → 折叠重试成功
  const s2 = new Session({ id: 't-of2', persona: 'x' })
  s2.history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'y'.repeat(3000), at: Date.now() }))
  let n = 0
  s2.provider = { chat: async () => {
    n++
    if (n === 1) { const e = new Error('模型服务 HTTP 400: This model maximum context length is 8192 tokens'); e.status = 400; throw e }
    return { content: '折叠后能聊', toolCalls: [], usage: null }
  } }
  const r = await s2.send('hi', { policy: { mode: 'never-ask' } })
  assert.equal(r.content, '折叠后能聊')
  assert.equal(n, 2, '重试了一次')
  fs.rmSync(dir, { recursive: true, force: true })
})
