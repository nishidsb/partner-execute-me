'use strict'
/** 0.50.1 挂机链路走本地（主人 11-09 拍板：晚上挂机/早上用电脑前/挂机不动时都走本地）
 *  - localLlm.pick(role)：分角色选模——side 取最小求快，auto/fallback 取最大求质量
 *  - llm.chatStreamAuto：挂机位本地优先，本地失败回落云端，abort 不回落
 *  - 挂机调用点静态接线：autonomy×2/chatter/curiosity/inner×2/dream/nudge/studyLine/watchLine
 *  - 主对话与字幕翻译保持 chatStream（云主本地备/实时质量敏感） */
const assert = require('assert')
const test = require('node:test')
const path = require('path')

const R = (p) => require('fs').readFileSync(path.join(__dirname, p), 'utf8')

test('0.50.1 localLlm.pick 分角色选模：side 最小求快，auto/fallback 最大求质量', async () => {
  const localLlm = require('../src/main/companion/localLlm')
  const origFetch = global.fetch
  // 三个模型：27b 最大、4b 最小、vl 同尺寸靠后
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'qwen3-vl:4b' }, { id: 'qwen3.5:4b' }, { id: 'qwen3.8:27b' }, { id: 'nomic-embed-text' }] })
  })
  try {
    localLlm.configure({ on: true, url: 'http://127.0.0.1:59999/v1', model: '' })
    const ok = await localLlm.probe({ force: true })
    assert.equal(ok, true, '端点在线')
    assert.equal(localLlm.pick('side').model, 'qwen3.5:4b', 'side 取最小模型（4b < 4b-vl，vl 同尺寸靠后）')
    assert.equal(localLlm.pick('auto').model, 'qwen3.8:27b', 'auto 取最大模型')
    assert.equal(localLlm.pick('fallback').model, 'qwen3.8:27b', 'fallback 取最大模型')
    // 显式配置名压过一切
    localLlm.configure({ on: true, url: 'http://127.0.0.1:59999/v1', model: 'qwen3-vl:4b' })
    await localLlm.probe({ force: true })
    assert.equal(localLlm.pick('side').model, 'qwen3-vl:4b', '配置名显式指定时 side 也用它')
    assert.equal(localLlm.pick('auto').model, 'qwen3-vl:4b', '配置名显式指定时 auto 也用它')
  } finally {
    global.fetch = origFetch
    localLlm.configure({ on: false })
  }
})

test('0.50.1 chatStreamAuto：本地在线走本地，本地失败回落云端，abort 不回落', async () => {
  const llm = require('../src/main/companion/llm')
  const origFetch = global.fetch
  const resets = []
  const reset = (fn) => { resets.push(fn) } // 只注册，finally 统一执行（误写成立即执行会把 ROUTER 提前清掉）
  try {
    // 路由桩：auto 给本地参数
    llm.setRouter({ auto: () => ({ baseUrl: 'http://127.0.0.1:59999/v1', apiKey: '', model: 'local-27b' }) })
    reset(() => llm.setRouter(null))

    // ① 本地在线 → 走本地（请求落在本地端点），云端零调用
    let localHits = 0
    let cloudHits = 0
    global.fetch = async (url) => {
      const u = String(url)
      if (u.includes('59999')) { localHits++; return { ok: true, body: sse(['{"choices":[{"delta":{"content":"本地嘟囔"}}]}', '[DONE]']) } }
      cloudHits++
      throw new Error('cloud-should-not-be-called')
    }
    const deltas = []
    const r1 = await llm.chatStreamAuto({
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'cloud-x',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (t) => deltas.push(t)
    })
    assert.equal(r1.content, '本地嘟囔', '挂机活动内容来自本地模型')
    assert.equal(localHits, 1, '本地端点被调用')
    assert.equal(cloudHits, 0, '云端零调用（挂机不烧 token）')
    assert.deepEqual(deltas, ['本地嘟囔'], 'onDelta 照常回调')

    // ② 本地失败 → 回落云端
    global.fetch = async (url) => {
      if (String(url).includes('59999')) return { ok: false, status: 500, text: async () => 'local dead' }
      return { ok: true, body: sse(['{"choices":[{"delta":{"content":"云端兜底"}}]}', '[DONE]']) }
    }
    const r2 = await llm.chatStreamAuto({
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'cloud-x',
      messages: [{ role: 'user', content: 'hi' }]
    })
    assert.equal(r2.content, '云端兜底', '本地失败回落云端')

    // ③ 主人主动中止 → 本地失败时不回落（回来就是叫停）
    const ctrl = new AbortController()
    ctrl.abort()
    global.fetch = async (url) => {
      if (String(url).includes('59999')) return { ok: false, status: 500, text: async () => 'local dead' }
      throw new Error('cloud-should-not-be-called-on-abort')
    }
    await assert.rejects(
      () => llm.chatStreamAuto({
        baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'cloud-x',
        messages: [], signal: ctrl.signal
      }),
      /500|local dead|请求失败/i,
      'abort 时本地失败不回落云端'
    )

    // ④ 本地不在线（auto 返回 null）→ 直接走云端，等价老行为
    llm.setRouter({ auto: () => null })
    reset(() => llm.setRouter(null))
    global.fetch = async () => ({ ok: true, body: sse(['{"choices":[{"delta":{"content":"云端直走"}}]}', '[DONE]']) })
    const r3 = await llm.chatStreamAuto({
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'cloud-x',
      messages: [{ role: 'user', content: 'hi' }]
    })
    assert.equal(r3.content, '云端直走', '本地不在线时照旧走云端（优雅降级）')
  } finally {
    global.fetch = origFetch
    for (const fn of resets) { try { fn() } catch { } }
  }
})

/** 最小 SSE Response 桩 */
function sse (events) {
  return {
    getReader () {
      let i = 0
      return {
        read: async () => (i < events.length
          ? { done: false, value: new TextEncoder().encode('data: ' + events[i++] + '\n\n') }
          : { done: true, value: undefined })
      }
    }
  }
}

test('0.50.1 挂机调用点静态接线：十处换 chatStreamAuto，主对话/字幕翻译保持 chatStream', () => {
  // 挂机链路（她一个人活动/自语台词/后台沉淀）→ 必须用 chatStreamAuto
  // （调用点写法 = (llm.chatStreamAuto || llm.chatStream)：消费端兼容双形状，老测试桩零修改）
  const AUTO_POINTS = [
    ['../src/main/companion/autonomy.js', 2, '自主活动主循环×2'],
    ['../src/main/companion/chatter.js', 1, '嘀咕'],
    ['../src/main/companion/curiosity.js', 1, '好奇心提问'],
    ['../src/main/companion/inner.js', 2, '日记+每周习惯沉淀'],
    ['../src/main/companion/index.js', 4, '做梦+黏人台词+陪学台词+伴看台词']
  ]
  for (const [file, atLeast, why] of AUTO_POINTS) {
    const src = R(file)
    const n = (src.match(/chatStreamAuto \|\| llm\.chatStream\)/g) || []).length
    assert.ok(n >= atLeast, why + ' → chatStreamAuto 兼容写法（' + file + '）')
  }

  // 保持 chatStream 的三处：主对话×2（handleMessage 回复链）+ 字幕翻译（实时+质量敏感）
  const idx = R('../src/main/companion/index.js')
  const plain = (idx.match(/llm\.chatStream\(/g) || []).length
  assert.equal(plain, 3, 'index.js 只剩主对话×2 + 字幕翻译×3 处 chatStream')
  assert.ok(/function translateLine[\s\S]{0,400}?llm\.chatStream\(/.test(idx), '字幕翻译保持 chatStream')
  assert.ok(/async function handleMessage[\s\S]{0,6000}?llm\.chatStream\(/.test(idx), '主对话保持 chatStream（云主本地备）')
})
