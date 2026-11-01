/**
 * llm.chatStream 工具消息里的截图（0.45.0 挡 3 回归）
 *
 * 真机踩中：cua 截图返回的 image 已经是完整 dataURL（data:image/png;base64,...），
 * chatStream 又拼了一层 'data:image/jpeg;base64,' → 双前缀 →
 * API 400 Invalid base64 data → 挡 3 每次都挂、进一小时冷却，看起来像「空闲了什么都没做」。
 * 这里用假 fetch 断言第二轮回传的 tool 消息里 image_url 只有一层前缀。
 */
const test = require('node:test')
const assert = require('node:assert')

const llm = require('../src/main/companion/llm')

function sse (obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n'
}

/** 假 fetch：第一轮回 tool_calls，第二轮回普通文本，请求体全记下来。
 *  0.45.14 修：read 必须在吐完 chunk 后返回 done，否则 SSE 循环无限读
 *  （之前的「真机/沙箱都跑不完被杀」就是这个假桩自己死循环，不是环境问题）。 */
function fakeFetch (bodies) {
  return async (url, opt) => {
    bodies.push(JSON.parse(opt.body))
    const done = bodies.length >= 2
    const chunk = done
      ? { choices: [{ delta: { content: '看过了' } }] }
      : { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'screenshot', arguments: '{}' } }] } }] }
    return {
      ok: true,
      body: {
        getReader: () => {
          let reads = 0
          return {
            read: async () => {
              reads++
              if (done || reads > 1) return { done: true, value: undefined }
              return { done: false, value: Buffer.from(sse(chunk)) }
            }
          }
        }
      }
    }
  }
}

function toolImageOf (body) {
  const toolMsg = body.messages.find((m) => m.role === 'tool')
  assert.ok(toolMsg, '第二轮回传里应有 tool 消息')
  const part = Array.isArray(toolMsg.content) && toolMsg.content.find((p) => p.type === 'image_url')
  assert.ok(part, 'tool 消息里应有 image_url')
  return part.image_url.url
}

test('llm: 工具返回的 dataURL 截图原样用，不再拼第二层前缀', async () => {
  const bodies = []
  global.fetch = fakeFetch(bodies)
  const dataURL = 'data:image/png;base64,QUFBQQ=='
  await llm.chatStream({
    baseUrl: 'http://x/v1', model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    toolExec: async () => ({ text: '截图', image: dataURL })
  })
  assert.equal(toolImageOf(bodies[1]), dataURL, '已是 dataURL 就一个字节都不动')
})

test('llm: 裸 base64 才补 dataURL 前缀', async () => {
  const bodies = []
  global.fetch = fakeFetch(bodies)
  await llm.chatStream({
    baseUrl: 'http://x/v1', model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    toolExec: async () => ({ text: '截图', image: 'QUFBQQ==' })
  })
  assert.equal(toolImageOf(bodies[1]), 'data:image/png;base64,QUFBQQ==')
})
