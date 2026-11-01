/* S7 厂商表 + Anthropic/Gemini 直连适配器 单测
 *
 * - 厂商表：结构完整、地址合法、视觉清单 ⊆ 模型清单、类型只允许三种
 * - 转换器：system 抽取 / 图片 base64 化 / tool_calls 双向 / 角色合并 / 首条 user
 * - 流式：假 fetch 吐 SSE，验证 content + toolCalls 聚合与 onDelta
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { ReadableStream } = require('node:stream/web')

const IMP = (p) => 'file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', p).replace(/\\/g, '/')

/** SSE 文本 → Web ReadableStream（适配器的 res.body.getReader 消费它） */
const sseBody = (text) => new ReadableStream({
  start (c) { c.enqueue(new TextEncoder().encode(text)); c.close() }
})

/* ---------------- 1. 厂商表 ---------------- */
test('S7：厂商表结构完整且可按地址回找', async () => {
  const v = await import(IMP('vendors.js'))
  const ids = new Set()
  for (const x of v.VENDORS) {
    assert.ok(x.id && !ids.has(x.id), 'id 重复或缺失: ' + x.id)
    ids.add(x.id)
    assert.ok(x.name, x.id + ' 缺显示名')
    assert.ok(['openai', 'anthropic', 'gemini', 'chatgpt'].includes(x.type), x.id + ' type 非法')
    assert.match(x.baseUrl, /^https:\/\//, x.id + ' baseUrl 必须 https')
    assert.ok(x.models.includes(x.model), x.id + ' 默认模型必须在 models 里')
    for (const m of x.vision) assert.ok(x.models.includes(m), x.id + ' vision 清单越界: ' + m)
    // chatgpt 是账号登录接入（无 Key 页面，keyHint 留空），其余厂商必须给取 Key 信息
    if (x.type !== 'chatgpt') assert.ok(x.keyUrl && x.keyHint, x.id + ' 缺取 Key 信息')
  }
  // 中国用户常用厂商必须在，且 DeepSeek 官方标为无视觉（本机 400 实锤）
  for (const need of ['deepseek', 'qwen', 'glm', 'kimi', 'anthropic', 'gemini']) {
    assert.ok(ids.has(need), '缺厂商 ' + need)
  }
  assert.equal(v.vendorById('deepseek').vision.length, 0, 'DeepSeek 实测读不了图')
  assert.equal(v.vendorByBaseUrl('https://api.deepseek.com/v1/').id, 'deepseek', '回找要容忍尾部斜杠')
  assert.equal(v.vendorByBaseUrl('http://127.0.0.1:11434/v1'), null, '本地模型应判为自定义')
})

/* ---------------- 2. Anthropic 转换 ---------------- */
test('S7 anthropic：消息转换（system/图片/工具/角色合并/首条 user）', async () => {
  const a = await import(IMP('models/anthropic.js'))
  const { system, messages } = a.convertMessages([
    { role: 'system', content: '你是莱莎' },
    { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'screenshot', arguments: '{"maxW":900}' }] },
    { role: 'tool', tool_call_id: 't1', name: 'screenshot', content: 'ok' },
    { role: 'assistant', content: '好的' }
  ])
  assert.equal(system, '你是莱莎')
  assert.equal(messages[0].role, 'user')
  const img = messages[0].content.find((b) => b.type === 'image')
  assert.deepEqual(img.source, { type: 'base64', media_type: 'image/png', data: 'QUJD' })
  const tu = messages[1].content.find((b) => b.type === 'tool_use')
  assert.equal(tu.name, 'screenshot')
  assert.deepEqual(tu.input, { maxW: 900 })
  const tr = messages[2].content[0]
  assert.equal(tr.type, 'tool_result')
  assert.equal(tr.tool_use_id, 't1')
  // tool_result(user) 与前一条 assistant 合并检查：不相邻不同角色 → 不合并
  assert.equal(messages.length, 4)
  // 首条是 assistant 时补一条 user
  const r2 = a.convertMessages([{ role: 'assistant', content: 'hi' }])
  assert.equal(r2.messages[0].role, 'user')
})

test('S7 anthropic：流式聚合（文本 + 并行双工具 + usage）', async () => {
  const a = await import(IMP('models/anthropic.js'))
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"click"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":"}}',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t2","name":"key"}}',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"keys\\":\\"enter\\"}"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"100}"}}',
    'data: {"type":"message_delta","usage":{"output_tokens":5}}'
  ].join('\n\n')
  globalThis.fetch = async () => ({
    ok: true, body: sseBody(sse)
  })
  let seen = ''
  const r = await a.chat({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => { seen += d } })
  assert.equal(seen, '你好')
  assert.equal(r.content, '你好')
  assert.equal(r.toolCalls.length, 2)
  assert.deepEqual(JSON.parse(r.toolCalls[0].arguments), { x: 100 })
  assert.deepEqual(JSON.parse(r.toolCalls[1].arguments), { keys: 'enter' })
  assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5 })
})

/* ---------------- 3. Gemini 转换 ---------------- */
test('S7 gemini：消息转换（systemInstruction/functionCall/functionResponse）', async () => {
  const g = await import(IMP('models/gemini.js'))
  const { systemInstruction, contents } = g.convertMessages([
    { role: 'system', content: '你是莱莎' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'screenshot', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'screenshot', content: '{"ok":true}' },
    { role: 'assistant', content: '看完了' }
  ])
  assert.equal(systemInstruction.parts[0].text, '你是莱莎')
  assert.equal(contents[0].role, 'user')
  assert.equal(contents[0].parts[1].inlineData.mimeType, 'image/jpeg')
  assert.equal(contents[1].role, 'model')
  assert.deepEqual(contents[1].parts[0].functionCall, { name: 'screenshot', args: {} })
  assert.deepEqual(contents[2].parts[0].functionResponse, { name: 'screenshot', response: { result: { ok: true } } })
  // 首条 model 时补 user
  const r2 = g.convertMessages([{ role: 'assistant', content: 'hi' }])
  assert.equal(r2.contents[0].role, 'user')
})

test('S7 gemini：流式聚合（文本 + functionCall + usageMetadata）与 tools 声明清洗', async () => {
  const g = await import(IMP('models/gemini.js'))
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"text":"早上"}]}}],"usageMetadata":{"promptTokenCount":7}}',
    'data: {"candidates":[{"content":{"parts":[{"text":"好"},{"functionCall":{"name":"open_app","args":{"name":"微信"}}}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}'
  ].join('\n\n')
  globalThis.fetch = async (_u, init) => {
    // URL 里要带 key 与 sse 标记
    const u = String(_u)
    assert.match(u, /streamGenerateContent\?alt=sse&key=/, '必须走 SSE 流式端点')
    return { ok: true, body: sseBody(sse) }
  }
  let seen = ''
  const r = await g.chat({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIzatest', model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => { seen += d } })
  assert.equal(seen, '早上好')
  assert.equal(r.content, '早上好')
  assert.equal(r.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(r.toolCalls[0].arguments), { name: '微信' })
  assert.deepEqual(r.usage, { prompt_tokens: 7, completion_tokens: 3 })
  // tools 声明：$schema 必须被剥掉
  const decls = g.convertTools([{ type: 'function', function: { name: 'x', description: 'd', parameters: { $schema: 'x', type: 'object', properties: {} } } }])
  assert.ok(!('$schema' in decls[0].functionDeclarations[0].parameters))
})

/* ---------------- 4. 注册表接线 ---------------- */
test('S7：models 注册表认得 anthropic 与 gemini', async () => {
  const m = await import(IMP('models/index.js'))
  const pa = m.createProvider({ type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-haiku-4-5' })
  const pg = m.createProvider({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', model: 'gemini-2.5-flash' })
  assert.equal(pa.type, 'anthropic')
  assert.equal(pg.type, 'gemini')
  assert.throws(() => m.createProvider({ type: 'nope' }), /未知的模型接入类型/)
})
