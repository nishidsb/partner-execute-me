/**
 * 0.45.94 回归：DeepSeek thinking 模式的 reasoning_content 回传
 *
 * 线上症状（用户原话）：「为什么会显示400，但是确实是有在给我发消息，只不过是日语发的没有翻译」。
 * 真因：她调工具（qq_send 等）后，第二轮请求里带 tool_calls 的 assistant 消息没带
 * reasoning_content → DeepSeek 直接 400「must be passed back to the API」。
 * 工具副作用已经发生（QQ 真收到），而这一轮回复/字幕全没了。
 *
 * 探针实测三种写法：省略字段 → 400；空串 → 200；原内容 → 200。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const IMP = (p) => 'file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', p).replace(/\\/g, '/')

/** 起一个最小 SSE 端点，按给定 chunk 回放 */
async function sseServer (chunks) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, baseUrl: 'http://127.0.0.1:' + srv.address().port }
}

test('①流里的思维链要被攒下来（否则上层无内容可回填）', async () => {
  const { chat } = await import(IMP('models/openaiCompat.js'))
  const { srv, baseUrl } = await sseServer([
    { choices: [{ delta: { reasoning_content: '先判断要不要调工具。' } }] },
    { choices: [{ delta: { reasoning_content: '要，查一下时间。' } }] },
    { choices: [{ delta: { content: '稍等。' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_time', arguments: '{}' } }] } }] }
  ])
  try {
    const r = await chat({
      baseUrl, apiKey: 'k', model: 'deepseek-flash',
      messages: [{ role: 'user', content: '现在几点' }]
    })
    assert.equal(r.reasoning, '先判断要不要调工具。要，查一下时间。', '思维链必须原样攒起来')
    assert.equal(r.content, '稍等。', '正文不受影响')
    assert.equal(r.toolCalls.length, 1, '工具调用仍要解析')
    assert.equal(r.toolCalls[0].name, 'get_time')
  } finally { srv.close() }
})

test('②第二轮请求：带 tool_calls 的 assistant 消息必须带 reasoning_content', async () => {
  const cfgMod = await import(IMP('config.js'))
  const { Session } = await import(IMP('core/session.js'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-reason-'))
  cfgMod.initDataDir(tmp)
  // 指向 deepseek（真实用户配置就是这个）：echo 才生效
  cfgMod.getConfig().provider = {
    type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-flash'
  }
  const s = new Session({ id: 'reason_test', name: '测试角色', persona: '', worldInfo: [], tools: null })
  const seen = []
  s.provider = {
    chat: async (opts) => {
      seen.push(JSON.parse(JSON.stringify(opts.messages || [])))
      if (seen.length === 1) {
        return { content: '', toolCalls: [{ id: 'call_1', name: 'get_time', arguments: '{}' }], reasoning: '我要先看时间' }
      }
      return { content: '十二点了。', toolCalls: [] }
    }
  }
  await s.send('现在几点', { confirmFn: async () => true, policy: { mode: 'never-ask' } })
  assert.equal(seen.length, 2, '调了工具就该有第二轮')
  const carrier = seen[1].find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length)
  assert.ok(carrier, '第二轮必须带着上一轮的 tool_calls')
  assert.equal(carrier.reasoning_content, '我要先看时间', '思维链要原样回传（缺了就是线上那个 400）')
})

test('③老历史没有思维链：补空串而不是省略（省略=400，空串=200）', async () => {
  const cfgMod = await import(IMP('config.js'))
  const { Session } = await import(IMP('core/session.js'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-reason2-'))
  cfgMod.initDataDir(tmp)
  cfgMod.getConfig().provider = {
    type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-flash'
  }
  const s = new Session({ id: 'reason_legacy', name: '测试角色', persona: '', worldInfo: [], tools: null })
  // 0.45.93 及以前落盘的历史：只有 toolCalls，没有 reasoning 字段
  s.history.push({ role: 'user', content: '帮我记一下', at: Date.now() - 3000 })
  s.history.push({ role: 'assistant', content: null, toolCalls: [{ id: 'call_0', name: 'get_time', arguments: '{}' }], at: Date.now() - 2000 })
  s.history.push({ role: 'tool', tool_call_id: 'call_0', name: 'get_time', content: '{"t":"12:00"}', at: Date.now() - 1000 })
  const seen = []
  s.provider = { chat: async (opts) => { seen.push(JSON.parse(JSON.stringify(opts.messages))); return { content: '好。', toolCalls: [] } } }
  await s.send('继续', { confirmFn: async () => true, policy: { mode: 'never-ask' } })
  const carrier = seen[0].find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
  assert.ok(carrier, '老的工具调用消息仍要还原')
  assert.equal(carrier.reasoning_content, '', '没思维链就补空串——省略会 400')
})

test('④非 DeepSeek 端点不加这个字段（别把严格的 OpenAI 端点惹毛）', async () => {
  const cfgMod = await import(IMP('config.js'))
  const { Session } = await import(IMP('core/session.js'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-reason3-'))
  cfgMod.initDataDir(tmp)
  cfgMod.getConfig().provider = {
    type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini'
  }
  const s = new Session({ id: 'reason_openai', name: '测试角色', persona: '', worldInfo: [], tools: null })
  s.history.push({ role: 'user', content: 'hi', at: Date.now() - 3000 })
  s.history.push({ role: 'assistant', content: null, toolCalls: [{ id: 'call_0', name: 'get_time', arguments: '{}' }], at: Date.now() - 2000 })
  s.history.push({ role: 'tool', tool_call_id: 'call_0', name: 'get_time', content: '{"t":"12:00"}', at: Date.now() - 1000 })
  const seen = []
  s.provider = { chat: async (opts) => { seen.push(JSON.parse(JSON.stringify(opts.messages))); return { content: 'ok', toolCalls: [] } } }
  await s.send('继续', { confirmFn: async () => true, policy: { mode: 'never-ask' } })
  const carrier = seen[0].find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
  assert.ok(carrier, '工具调用消息照旧还原')
  assert.ok(!('reasoning_content' in carrier), '非 thinking 端点不该出现该字段')
})

test('⑤QQ 出口：日语台词要带中文译文，中文台词不重复翻', () => {
  const { withTranslation, subtitleTarget } = require('../src/main/companion/subtitle.js')
  const ja = 'ねえ、届いてる？　返事、待ってるね。'
  assert.equal(subtitleTarget(ja, 'zh'), '中文', '日语台词 + 显示语言中文 → 要翻')
  assert.equal(withTranslation(ja, '喂，收到了吗？我在等你回信。'), ja + '\n（喂，收到了吗？我在等你回信。）')
  assert.equal(subtitleTarget('我在等你哦', 'zh'), '', '本来就是中文就不翻')
  assert.equal(withTranslation('我在等你哦', ''), '我在等你哦', '没译文就原样')
  assert.equal(withTranslation(ja, ja), ja, '译文跟原文一样时不重复')
})

test('⑥裁剪从中间切断工具组时，开头的孤儿 tool 结果要被剔掉', async () => {
  const b = await import(IMP('core/budget.js'))
  const arr = [
    { role: 'tool', tool_call_id: 'call_0', content: '旧结果被切剩的半截' },
    { role: 'tool', tool_call_id: 'call_1', content: '也是孤儿' },
    { role: 'user', content: '正常的开始' },
    { role: 'assistant', content: '嗯' }
  ]
  const out = b.dropLeadingOrphanTools(arr)
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant'], '开头的 tool 必须剔掉，后面的不动')
  assert.equal(arr.length, 4, '不能原地改（原历史要留档）')
  assert.deepEqual(b.dropLeadingOrphanTools([]), [])
})
