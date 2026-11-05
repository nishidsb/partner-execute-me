'use strict'
/** 0.46.37 本地视觉通道：探测 / 描述 / 如实降级 */
const test = require('node:test')
const assert = require('node:assert')
const vision = require('../src/main/companion/vision')

/** 恢复干净状态（探测缓存会跨用例污染） */
function fresh (fetchFn, model) {
  vision.resetForTest()
  vision.configure({ base: 'http://mock', model: model || '' })
  vision.setFetch(fetchFn)
}

test('vision: 探测——qwen3.5:4b 在列表里即选中（本机实测多模态）', async () => {
  fresh(async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen3.8:27b' }, { name: 'qwen3.5:4b' }] }) }))
  const r = await vision.probe()
  assert.ok(r.ok, '应探测成功')
  assert.equal(r.model, 'qwen3.5:4b')
})

test('vision: 探测——列表只有纯文本模型时如实说没有', async () => {
  fresh(async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen3.8:27b' }, { name: 'llama3:8b' }] }) }))
  const r = await vision.probe()
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有视觉模型/)
})

test('vision: 探测——Ollama 没起时不许装看不见', async () => {
  fresh(async () => { throw new Error('ECONNREFUSED') })
  const r = await vision.probe()
  assert.equal(r.ok, false)
  assert.match(r.reason, /Ollama/)
})

test('vision: describe——正常返回模型文本', async () => {
  let seenBody = null
  fresh(async (url, init) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'qwen3.5:4b' }] }) }
    seenBody = JSON.parse(init.body)
    return { ok: true, json: async () => ({ choices: [{ message: { content: ' 红色画面，有一个窗口 ' } }] }) }
  })
  const r = await vision.describe(Buffer.from('fakejpeg'), '什么颜色？')
  assert.ok(r.ok && r.text.includes('红色画面'), r.text)
  assert.equal(r.model, 'qwen3.5:4b')
  // 图必须以 dataURL 进请求体（qwen3.5 实测吃这个格式）
  assert.match(seenBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
  // thinking 模型：max_tokens 得给够（=50 实测回复为空）
  assert.ok(seenBody.max_tokens >= 500)
})

test('vision: describe——服务端炸了要如实报错，不是空手回来', async () => {
  fresh(async (url) => String(url).endsWith('/api/tags')
    ? { ok: true, json: async () => ({ models: [{ name: 'qwen3.5:4b' }] }) }
    : { ok: false, status: 500, text: async () => 'boom' })
  const r = await vision.describe(Buffer.from('x'), '?')
  assert.equal(r.ok, false)
  assert.match(r.reason, /500/)
})

test('vision: 视觉模型规则不误伤纯文本模型', () => {
  const textOnly = ['qwen3.8:27b', 'llama3:8b', 'deepseek-r1:14b', 'qwen2.5:7b-instruct']
  for (const n of textOnly) {
    assert.ok(!vision.VLM_RULES.some((r) => r.re.test(n)), n + ' 不该被当视觉模型')
  }
  const vlms = ['qwen3-vl:4b', 'qwen2.5-vl:7b', 'minicpm-v:8b', 'llava:13b', 'qwen3.5:4b']
  for (const n of vlms) {
    assert.ok(vision.VLM_RULES.some((r) => r.re.test(n)), n + ' 该被当视觉模型')
  }
})
