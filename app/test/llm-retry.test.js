/**
 * llm 瞬态错误退避重试（0.45.11）
 *
 * 真机踩中：deepseek 高峰期 503 Service is too busy——挡 3 一场活动开场第一轮
 * 就被 503 打断，整场报废还进一小时冷却，看起来像「跑不动了」。
 * 这里验证：429/5xx 与网络抖动在收到响应头之前重试；401 这类直接抛；
 * 主动中断（signal）绝不重试；流已建立后的错误不在重试范围。
 */
const test = require('node:test')
const assert = require('node:assert')

const llm = require('../src/main/companion/llm')

function sse (obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n'
}

// read() 第二次返回 done 的通用成功流
function okStreamFull (text) {
  let sent = false
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: Buffer.from(sse({ choices: [{ delta: { content: text } }] })) }
        }
      })
    }
  }
}

function statusRes (status, bodyText) {
  return { ok: false, status, text: async () => bodyText || 'boom' }
}

test('llm: 503 退避重试后成功——整场不再一次抖动就报废', async () => {
  const delays = llm.RETRY_DELAYS_MS
  const saved = [...delays]
  delays.splice(0, delays.length, 1, 1, 1)   // 测试不等 23 秒
  let calls = 0
  global.fetch = async () => {
    calls++
    return calls <= 2 ? statusRes(503, 'Service is too busy') : okStreamFull('看过了')
  }
  try {
    const r = await llm.chatStream({ baseUrl: 'http://x/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.content, '看过了', '重试后拿到内容')
    assert.equal(calls, 3, '前两次 503，第三次成功')
  } finally {
    delays.splice(0, delays.length, ...saved)
  }
})

test('llm: 401 这类不可重试错误直接抛（重试也没用）', async () => {
  let calls = 0
  global.fetch = async () => { calls++; return statusRes(401, 'bad key') }
  await assert.rejects(
    () => llm.chatStream({ baseUrl: 'http://x/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    /LLM 401/
  )
  assert.equal(calls, 1, '一次都不多打')
})

test('llm: 重试次数用尽仍然失败——错误如实上抛', async () => {
  const delays = llm.RETRY_DELAYS_MS
  const saved = [...delays]
  delays.splice(0, delays.length, 1, 1, 1)
  let calls = 0
  global.fetch = async () => { calls++; return statusRes(503, 'Service is too busy') }
  try {
    await assert.rejects(
      () => llm.chatStream({ baseUrl: 'http://x/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      /LLM 503/
    )
    assert.equal(calls, 4, '首次 + 3 次重试')
  } finally {
    delays.splice(0, delays.length, ...saved)
  }
})

test('llm: 网络抖动（fetch 抛 TypeError）也重试', async () => {
  const delays = llm.RETRY_DELAYS_MS
  const saved = [...delays]
  delays.splice(0, delays.length, 1)
  let calls = 0
  global.fetch = async () => {
    calls++
    if (calls === 1) throw new TypeError('fetch failed')
    return okStreamFull('ok')
  }
  try {
    const r = await llm.chatStream({ baseUrl: 'http://x/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.content, 'ok')
    assert.equal(calls, 2)
  } finally {
    delays.splice(0, delays.length, ...saved)
  }
})

test('llm: 主动中断（主人回来）绝不重试', async () => {
  const delays = llm.RETRY_DELAYS_MS
  const saved = [...delays]
  delays.splice(0, delays.length, 1, 1, 1)
  let calls = 0
  global.fetch = async () => { calls++; return statusRes(503, 'busy') }
  try {
    await assert.rejects(
      () => llm.chatStream({
        baseUrl: 'http://x/v1', model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: AbortSignal.abort()          // 已经中止
      }),
      /503|abort/i
    )
    assert.equal(calls, 1, '中断后一次都不重试')
  } finally {
    delays.splice(0, delays.length, ...saved)
  }
})

test('llm: chatOnce 同样吃重试（提炼记忆的小任务也怕 503）', async () => {
  const delays = llm.RETRY_DELAYS_MS
  const saved = [...delays]
  delays.splice(0, delays.length, 1)
  let calls = 0
  global.fetch = async () => {
    calls++
    return calls === 1 ? statusRes(503, 'busy') : { ok: true, json: async () => ({ choices: [{ message: { content: ' 她喜欢蓝 ' } }] }) }
  }
  try {
    const out = await llm.chatOnce({ baseUrl: 'http://x/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(out, '她喜欢蓝')
    assert.equal(calls, 2)
  } finally {
    delays.splice(0, delays.length, ...saved)
  }
})

test('llm: chatOnce 硬超时语义不变——超时中止时不重试、按时失败', async () => {
  const delays = llm.RETRY_DELAYS_MS
  const saved = [...delays]
  delays.splice(0, delays.length, 1, 1, 1)
  let calls = 0
  global.fetch = async (url, opt) => {
    calls++
    return new Promise((resolve, reject) => {
      opt.signal.addEventListener('abort', () => reject(new Error('aborted')))
      setTimeout(() => resolve(statusRes(503, 'busy')), 5000)   // 比 timeoutMs 慢
    })
  }
  try {
    await assert.rejects(() => llm.chatOnce({ baseUrl: 'http://x/v1', model: 'm', messages: [], timeoutMs: 800 }))
    assert.ok(calls <= 2, '超时封顶，不会无限重试: ' + calls)
  } finally {
    delays.splice(0, delays.length, ...saved)
  }
})
