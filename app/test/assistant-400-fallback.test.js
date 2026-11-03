/**
 * 0.45.95 回归：端点 400 时的「压平重试」退路
 *
 * 用户 11:35 又说「还是显示400」。0.45.94 已经把 reasoning_content 回填上了，
 * 但这条规则本身很脆：老历史没有思维链、网关改写工具调用、不同端点校验不一致，
 * 任何一种都会让整轮直接哑掉——工具的副作用已经发生（QQ 真发出去了），
 * 聊天窗只剩一个 400。所以除了继续回填，还要有一条**无条件成立**的退路：
 * 把 tool_calls 整段压成纯文本再发一次，请求里不再有 tool_calls，规则无从触发。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const IMP = (p) => 'file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', p).replace(/\\/g, '/')

test('①压平：tool_calls + tool 结果变成纯文本，且不再出现 tool 角色', async () => {
  const b = await import(IMP('core/budget.js'))
  const input = [
    { role: 'system', content: '人设' },
    { role: 'user', content: '现在几点' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'get_time', content: '{"t":"12:00"}' },
    { role: 'assistant', content: '中午十二点。' }
  ]
  const out = b.flattenToolHistory(input)
  assert.equal(out.some((m) => m.role === 'tool'), false, '不能再有 tool 角色')
  assert.equal(out.some((m) => m.tool_calls), false, '不能再有 tool_calls')
  assert.match(out.find((m) => m.role === 'assistant').content, /get_time/, '调过什么工具要写进正文')
  assert.match(out.filter((m) => m.role === 'user').map((m) => m.content).join('\n'), /12:00/, '工具结果要留在上下文里')
})

test('②压平：连续同角色合并（部分端点不接受连着两条 user）', async () => {
  const b = await import(IMP('core/budget.js'))
  const out = b.flattenToolHistory([
    { role: 'user', content: '第一句' },
    { role: 'tool', tool_call_id: 'x', name: 'a', content: '结果A' },
    { role: 'tool', tool_call_id: 'y', name: 'b', content: '结果B' }
  ])
  assert.equal(out.filter((m) => m.role === 'user').length, 1, '三条 user 要合成一条')
})

test('③真被 400 挡住时，自动压平重发并把话说完（不再整轮失败）', async () => {
  const cfgMod = await import(IMP('config.js'))
  const { Session } = await import(IMP('core/session.js'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-400-'))
  cfgMod.initDataDir(tmp)
  cfgMod.getConfig().provider = {
    type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-flash'
  }
  const s = new Session({ id: 'fallback_test', name: '测试角色', persona: '', worldInfo: [], tools: null })

  const bodies = []
  let n = 0
  s.provider = {
    chat: async (opts) => {
      bodies.push(JSON.parse(JSON.stringify(opts.messages || [])))
      // 第一轮：她要调工具；之后只要历史里还带 tool_calls → 模拟端点 400
      if (n++ === 0) {
        return { content: '', toolCalls: [{ id: 'call_1', name: 'get_time', arguments: '{}' }], reasoning: '先看时间' }
      }
      if ((opts.messages || []).some((m) => m.tool_calls)) {
        const err = new Error('模型服务 HTTP 400: {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API."}}')
        err.status = 400
        throw err
      }
      // 压平之后（没有 tool_calls）才放行
      return { content: '我在呢，刚才那条发出去了。', toolCalls: [] }
    }
  }

  const r = await s.send('把刚才那句发到 QQ 上', { vision: false })
  assert.match(r.content, /刚才那条发出去了/, '压平重发之后这一轮必须能说完')
  assert.equal(bodies.length, 3, '工具轮 + 400 + 压平重发')
  assert.equal(bodies[1].some((m) => m.tool_calls), true, '第二次是正常形态（有 tool_calls）→ 被 400')
  assert.equal(bodies[2].some((m) => m.tool_calls), false, '压平重发时不能再带 tool_calls')
})

test('④不是 400 的错误不许被吞掉（别拿压平掩盖超时/鉴权故障）', async () => {
  const cfgMod = await import(IMP('config.js'))
  const { Session } = await import(IMP('core/session.js'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-400-'))
  cfgMod.initDataDir(tmp)
  const s = new Session({ id: 'no_swallow', name: '测试角色', persona: '', worldInfo: [], tools: null })
  let calls = 0
  s.provider = {
    chat: async () => {
      calls++
      const err = new Error('模型服务 HTTP 500: 服务器开小差了')
      err.status = 500
      throw err
    }
  }
  await assert.rejects(() => s.send('在吗', { vision: false }), /500/)
  assert.equal(calls, 1, '500 不该重试')
})

test('⑤自言自语通道：tick 里不许再引用 makeLine 的局部变量 voices', () => {
  // 0.45.91 加复读闸时把 `voices` 从 makeLine 抄到了 tick，作用域不对 →
  // 每次 tick 都抛「voices is not defined」，整条碎碎念通道哑掉（日志里 tick 异常）。
  // 这条是防回归的静态栅栏：tick 必须自己取镜子。
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'companion', 'chatter.js'), 'utf8')
  const tick = src.slice(src.indexOf('async function tick ()')).replace(/\/\/.*$/gm, '')
  assert.equal(/[^.\w]voices\b/.test(tick), false, 'tick 里不能直接用 voices（它只属于 makeLine）')
  assert.match(tick, /recentVoices\(/, 'tick 要自己取一份最近说过的话')
})

test('⑥空 assistant（content=null 且无 tool_calls）不许进请求，连着两条 user 要合并', async () => {
  // 探针实测：{role:'assistant', content:null} 且没有 tool_calls → 400
  // 「Invalid assistant message: content or tool_calls must be set」。
  // 历史里真的会有这种消息（整轮只调了工具 / 只在气泡里说完、正文空），
  // 0.45.95 给所有 assistant 补 reasoning_content 时顺手暴露了这个坑。
  const cfgMod = await import(IMP('config.js'))
  const { Session } = await import(IMP('core/session.js'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-null-'))
  cfgMod.initDataDir(tmp)
  cfgMod.getConfig().provider = { type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-flash' }
  const s = new Session({ id: 'null_asst', name: 't', persona: '', worldInfo: [], tools: null })
  s.history = [
    { role: 'user', content: '第一句', at: 1 },
    { role: 'assistant', content: null, at: 2 },
    { role: 'user', content: '第二句', at: 3 }
  ]
  let seen = null
  s.provider = { chat: async (opts) => { seen = opts.messages; return { content: '在呢。', toolCalls: [] } } }
  await s.send('第三句', { vision: false })
  assert.ok(seen, '必须发出去')
  for (const m of seen) {
    if (m.role === 'assistant') assert.ok(typeof m.content === 'string' && m.content.length > 0, 'assistant 不能是空正文')
  }
  const roles = seen.map((m) => m.role)
  for (let i = 1; i < roles.length; i++) {
    assert.equal(roles[i] === 'user' && roles[i - 1] === 'user', false, '不能有连着两条 user')
  }
  assert.match(seen.filter((m) => m.role === 'user').map((m) => m.content).join('\n'), /第一句[\s\S]*第二句/, '两句都要保留')
})
