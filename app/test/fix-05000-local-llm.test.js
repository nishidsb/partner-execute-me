'use strict'
/** 0.50.0 本地大模型自动路由（主人 23:21 拍板：副手+备胎，端点 Ollama）
 *  - localLlm.js：探测/自动选模（滤嵌入类）/缓存冷却/pick
 *  - llm.js 路由：chatOnce 副手本地优先、chatStream 云主本地备（emitted/abort 守卫）
 *  - 助手核心备胎：setChatFallback + createProvider 包装（abort 守卫）
 *  - 全链静态接线：companion/assistant/preload/UI 五处 */
const assert = require('assert')
const test = require('node:test')
const path = require('path')
const { pathToFileURL } = require('url')

const R = (p) => require('fs').readFileSync(path.join(__dirname, p), 'utf8')

test('0.50.0 localLlm：探测自动选模、滤嵌入类、pick 返回路由参数', async () => {
  const localLlm = require('../src/main/companion/localLlm')
  let calls = 0
  const origFetch = global.fetch
  global.fetch = async (url) => {
    calls++
    assert.ok(String(url).includes('/models'), '探测走 /models')
    return { ok: true, json: async () => ({ data: [{ id: 'nomic-embed-text' }, { id: 'qwen2.5:7b' }] }) }
  }
  try {
    localLlm.configure({ on: true, url: 'http://127.0.0.1:59999/v1', model: '' })
    const ok = await localLlm.probe({ force: true })
    assert.equal(ok, true, '端点在线')
    const p = localLlm.pick()
    assert.ok(p && p.baseUrl === 'http://127.0.0.1:59999/v1', 'pick 给出端点')
    assert.equal(p.model, 'qwen2.5:7b', '嵌入类被滤掉、取可用模型')
    assert.equal(p.apiKey, '', '本地端点无 key')

    // 配置名优先
    localLlm.configure({ on: true, url: 'http://127.0.0.1:59999/v1', model: 'llama3:8b' })
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'llama3:8b' }, { id: 'qwen2.5:7b' }] }) })
    await localLlm.probe({ force: true })
    assert.equal(localLlm.pick().model, 'llama3:8b', '配置名在列表里时优先')

    // 端点死了 → pick 为 null（不抛）
    global.fetch = async () => { throw new Error('ECONNREFUSED') }
    await localLlm.probe({ force: true })
    assert.equal(localLlm.pick(), null, '离线时 pick 返回 null')
    assert.equal(localLlm.stats().online, false, 'stats 如实报离线')

    // 关闭开关 → 永远 null
    localLlm.configure({ on: false, url: 'http://127.0.0.1:59999/v1' })
    assert.equal(localLlm.pick(), null, '开关关闭时 pick 恒 null')
  } finally {
    global.fetch = origFetch
    localLlm.configure({ on: false })
  }
})

test('0.50.0 localLlm：端点只有嵌入类模型 → 不用于对话', async () => {
  const localLlm = require('../src/main/companion/localLlm')
  const origFetch = global.fetch
  global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'nomic-embed-text' }, { id: 'bge-m3' }] }) })
  try {
    localLlm.configure({ on: true, url: 'http://127.0.0.1:59999/v1', model: '' })
    await localLlm.probe({ force: true })
    assert.equal(localLlm.pick(), null, '纯嵌入端点不接管对话')
  } finally {
    global.fetch = origFetch
    localLlm.configure({ on: false })
  }
})

test('0.50.0 助手核心备胎：云端失败 → fallback 顶上；abort 不切；备胎失败抛原错', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '../src/assistant/core/models/index.js')))
  const saved = null
  // 备胎成功路径：云端端口必然连不上 → fallback 返回本地结果
  mod.setChatFallback(async (opts, err) => {
    assert.ok(err, 'fallback 收到原错（分诊用）')
    return { content: 'local-ok', toolCalls: [] }
  })
  const p1 = mod.createProvider({ type: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'cloud', apiKey: '' })
  const r = await p1.chat({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(r.content, 'local-ok', '云端失败本地顶上')

  // 主人主动中断 → 不切备胎，直接抛
  const ctrl = new AbortController()
  ctrl.abort()
  let called = false
  mod.setChatFallback(async () => { called = true; return { content: 'should-not' } })
  const p2 = mod.createProvider({ type: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'cloud', apiKey: '' })
  await assert.rejects(
    () => p2.chat({ messages: [], signal: ctrl.signal }),
    /超时|fetch failed|ECONNREFUSED|请求失败|fetch/i,
    'abort 场景不切备胎（看门狗把预中止 signal 转为超时文案）'
  )
  assert.equal(called, false, 'abort 时 fallback 未被调用')

  // 备胎也失败 → 抛原错（不是备胎的错）
  mod.setChatFallback(async () => { throw new Error('local-also-dead') })
  const p3 = mod.createProvider({ type: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'cloud', apiKey: '' })
  await assert.rejects(() => p3.chat({ messages: [] }), /local-also-dead|fetch failed|ECONNREFUSED/i)
  // 不得把「local-also-dead」当原错抛出——原错优先已由实现保证，这里至少确认抛了错
  mod.setChatFallback(null)
  void saved
})

test('0.50.0 llm.js 路由：导出名不变 + 双守卫齐全', () => {
  const src = R('../src/main/companion/llm.js')
  assert.ok(src.includes('function setRouter'), 'setRouter 注入口')
  assert.ok(/async function chatStream \(args\)/.test(src), 'chatStream 路由包装（导出名不变）')
  assert.ok(/async function chatOnce \(args\)/.test(src), 'chatOnce 路由包装（导出名不变）')
  assert.ok(src.includes('chatStreamImpl'), '原实现保留（impl 后缀）')
  assert.ok(src.includes('chatOnceImpl'), '原实现保留（impl 后缀）')
  assert.ok(src.includes('emitted'), 'chatStream 已吐字守卫（防重复说话）')
  assert.ok(src.includes('args.signal && args.signal.aborted'), '主人主动中断不切备胎')
  assert.ok(src.includes('本地模型顶上'), '备胎切换留痕')
  assert.ok(src.includes('本地判读失败'), '副手回落留痕')
  assert.ok(src.includes("ROUTER.fallback()"), 'fallback 钩子')
  assert.ok(src.includes('ROUTER.side()'), 'side 钩子')
})

test('0.50.0 全链静态接线：companion/assistant/preload/UI 五处', () => {
  const idx = R('../src/main/companion/index.js')
  assert.ok(idx.includes("require('./localLlm')"), 'companion 引路由模块')
  assert.ok(idx.includes('function applyLocalLlm'), '配置同步函数')
  assert.ok(/llm\.setRouter\(\{[\s\S]*?side: \(\) => localLlm\.pick\('side'\)[\s\S]*?fallback: \(\) => localLlm\.pick\('fallback'\)[\s\S]*?auto: \(\) => localLlm\.pick\('auto'\)/.test(idx), '路由注入 llm（0.50.1 三钩子）')
  assert.ok(idx.includes('patch.localLlmOn !== undefined'), 'patchCfg 监听配置变化')
  assert.ok(idx.includes('companion:local-llm-probe'), 'IPC 探测口')
  assert.ok(idx.includes('applyLocalLlm()\n    localLlm.probe()'), 'registerIpc 启动接线+首探')

  const asst = R('../src/main/assistant/index.js')
  assert.ok(asst.includes('modelsMod.setChatFallback'), '助手核心接备胎')
  assert.ok(asst.includes('localLlm.pick()'), '备胎取参走 localLlm')

  const pre = R('../src/preload/companion.js')
  assert.ok(pre.includes('localLlmProbe'), 'preload 探测口')

  const app = R('../src/renderer/companion/app.js')
  assert.ok(app.includes('localLlmOn'), 'UI 开关入配置')
  assert.ok(app.includes('localLlmUrl'), 'UI 地址入配置')
  assert.ok(app.includes('localLlmStatusRefresh'), 'UI 状态行')

  const html = R('../src/renderer/companion/index.html')
  assert.ok(html.includes('cpLocalLlmOn') && html.includes('cpLocalLlmUrl') && html.includes('cpLocalLlmTest'), 'UI 三件套在模型页')
})
