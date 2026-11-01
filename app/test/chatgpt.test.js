/**
 * 1.3 ChatGPT 账号接入测试：协议翻译 / SSE 聚合 / 401 自动刷新 / 注册表与厂商表
 * fetch 全部打桩，不联网。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// ESM 动态加载（core 是 ESM）
async function loadCore () {
  return import('../src/assistant/core/models/chatgpt.js')
}
async function loadVendors () {
  return import('../src/assistant/core/vendors.js')
}
async function loadFactory () {
  return import('../src/assistant/core/models/index.js')
}

const enc = new TextEncoder()
function sseResponse (events, status = 200) {
  const body = events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('')
  const stream = new ReadableStream({
    start (c) { c.enqueue(enc.encode(body)); c.close() }
  })
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

function tmpAuthFile () {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-gpt-')), 'chatgpt-auth.json')
}

const AUTH = {
  client_id: 'app_test',
  access_token: 'tok-1',
  refresh_token: 'ref-1',
  account_id: 'acc-9999',
  expires_at: Date.now() + 3600_000
}

test('translate：system→instructions，tool→function_call_output，assistant.tool_calls→function_call', async () => {
  const { translate } = await loadCore()
  const r = translate([
    { role: 'system', content: '你是莱莎' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'pet_say', arguments: '{"x":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'pet_say', content: '说完' }
  ], [
    { type: 'function', function: { name: 'pet_say', description: '说话', parameters: { type: 'object', properties: {} } } }
  ])
  assert.equal(r.instructions, '你是莱莎')
  assert.deepEqual(r.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] })
  assert.deepEqual(r.input[1], { type: 'function_call', call_id: 'c1', name: 'pet_say', arguments: '{"x":1}' })
  assert.deepEqual(r.input[2], { type: 'function_call_output', call_id: 'c1', output: '说完' })
  assert.equal(r.tools.length, 1)
  assert.equal(r.tools[0].name, 'pet_say')
  assert.equal(r.tools[0].type, 'function')
})

test('translate：多模态图片 content → input_image；纯文本助手消息 → output_text', async () => {
  const { translate } = await loadCore()
  const r = translate([
    { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    { role: 'assistant', content: '好的' }
  ], [])
  assert.deepEqual(r.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AAA' })
  assert.equal(r.input[1].content[0].type, 'output_text')
})

test('chat：SSE 聚合 content/toolCalls/usage（usage 归一成 prompt/completion_tokens）', async () => {
  const core = await loadCore()
  const file = tmpAuthFile()
  fs.writeFileSync(file, JSON.stringify(AUTH))
  core.setAuthFile(file)
  const calls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts })
    assert.ok(String(url).includes('chatgpt.com/backend-api/codex/responses'))
    return sseResponse([
      { type: 'response.output_text.delta', delta: '你好' },
      { type: 'response.output_text.delta', delta: '呀' },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c9', name: 'pet_say', arguments: '{"t":"hi"}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 7 } } }
    ])
  }
  try {
    const r = await core.chat({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], tools: [] })
    assert.equal(r.content, '你好呀')
    assert.deepEqual(r.toolCalls, [{ id: 'c9', name: 'pet_say', arguments: '{"t":"hi"}' }])
    assert.deepEqual(r.usage, { prompt_tokens: 11, completion_tokens: 7 })
    // 请求头：Bearer + account-id
    const req = calls[0].opts
    assert.equal(req.headers.Authorization, 'Bearer tok-1')
    assert.equal(req.headers['chatgpt-account-id'], 'acc-9999')
    const body = JSON.parse(req.body)
    assert.equal(body.stream, true)
    assert.equal(body.store, false)
    assert.equal(body.model, 'gpt-5')
    assert.ok(body.input.length >= 1)
  } finally { globalThis.fetch = origFetch }
})

test('chat：401 自动用 refresh_token 刷新并重试一次，新令牌落盘', async () => {
  const core = await loadCore()
  const file = tmpAuthFile()
  fs.writeFileSync(file, JSON.stringify(AUTH))
  core.setAuthFile(file)
  let n = 0
  const refreshBodies = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('auth.openai.com/oauth/token')) {
      refreshBodies.push(JSON.parse(opts.body))
      return new Response(JSON.stringify({ access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 7200 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    n++
    if (n === 1) return new Response('{"detail":"expired"}', { status: 401 })
    return sseResponse([{ type: 'response.output_text.delta', delta: 'refreshed' }])
  }
  try {
    const r = await core.chat({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.content, 'refreshed')
    assert.equal(refreshBodies.length, 1)
    assert.equal(refreshBodies[0].grant_type, 'refresh_token')
    assert.equal(refreshBodies[0].refresh_token, 'ref-1')
    assert.equal(refreshBodies[0].client_id, 'app_test')
    const now = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(now.access_token, 'tok-2')
    assert.equal(now.refresh_token, 'ref-2')
    // 第二次请求带的是新令牌
    assert.equal(n, 2)
  } finally { globalThis.fetch = origFetch }
})

test('chat：未登录给出明确错误', async () => {
  const core = await loadCore()
  core.setAuthFile(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-gpt-')), 'none.json'))
  await assert.rejects(() => core.chat({ messages: [] }), /尚未登录 ChatGPT/)
})

test('vendors：chatgpt 厂商在表内（type=chatgpt），工厂能创建该类型', async () => {
  const v = await loadVendors()
  const g = v.VENDORS.find((x) => x.id === 'chatgpt')
  assert.ok(g, 'chatgpt 厂商缺失')
  assert.equal(g.type, 'chatgpt')
  assert.ok(g.baseUrl.includes('chatgpt.com'))
  const { createProvider } = await loadFactory()
  const p = createProvider({ type: 'chatgpt', baseUrl: g.baseUrl, apiKey: '', model: 'gpt-5' })
  assert.equal(typeof p.chat, 'function')
})
