/**
 * OpenAI 兼容模型接入（DeepSeek / OpenAI / 各类兼容服务）。
 * 支持流式输出与工具调用（function calling）增量聚合。
 * 依赖 Node 22 原生 fetch，零第三方包。
 *
 * 返回 { content, toolCalls: [{id,name,arguments}], usage?, reasoning? }
 * reasoning 只在 thinking 模型（DeepSeek reasoner/thinking）下非空，上层必须回填到
 * 带 tool_calls 的 assistant 消息里，否则下一轮 400。
 */
export async function chat (opts) {
  const {
    baseUrl, apiKey, model, messages, tools,
    temperature, signal, onDelta, maxTokens,
    reasoningEffort            // 1.5：none/low/high/max（厂商声明支持才传进来）
  } = opts

  const url = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model, messages, stream: true
  }
  // 1.4：temperature 默认不发——推理模型普遍拒绝该参数；用户在配置里显式给了才发
  if (temperature != null) body.temperature = temperature
  if (reasoningEffort && reasoningEffort !== 'none') body.reasoning_effort = reasoningEffort
  if (tools && tools.length) body.tools = tools
  if (maxTokens) body.max_tokens = maxTokens

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  })

  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 500) } catch {}
    // 0.45.95：失败请求原样存档（只存 400/422 这类「请求本身不合法」）。
    // 同一条 400 反复出现时，光看日志永远只能看到一句英文，看不到自己到底发了什么；
    // 存档在 data/logs/last-400.json，一次只留最新一份，不涨体积。
    if ([400, 422].includes(res.status)) {
      try {
        const { dataPath } = await import('../config.js')
        const fsMod = await import('node:fs')
        fsMod.mkdirSync(dataPath('logs'), { recursive: true })
        fsMod.writeFileSync(dataPath('logs', 'last-400.json'), JSON.stringify({
          at: new Date().toISOString(), url, status: res.status, detail, body
        }, null, 1).slice(0, 3e6), 'utf8')
      } catch { }
    }
    const err = new Error(`模型服务 HTTP ${res.status}: ${detail}`)
    err.status = res.status
    throw err
  }
  if (!res.body) throw new Error('模型服务返回空响应体')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  // 0.45.94 thinking 模式的思维链。DeepSeek 探针实测（tools/probe-reasoning.js 同款）：
  // 带 tool_calls 的 assistant 消息**省略** reasoning_content → HTTP 400
  // 「The reasoning_content in the thinking mode must be passed back to the API」；
  // 传空串 → 200；传原内容 → 200。所以这里必须攒起来交给上层回填。
  // 症状极隐蔽：她调完工具（发 QQ / 记事情）第二轮就整轮失败，聊天窗只剩 400，
  // 而工具的副作用（消息已发出）早就发生了——用户看到「400 但消息真发了」。
  let reasoning = ''
  const tcMap = new Map() // index -> {id,name,arguments}
  let usage = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let chunk
      try { chunk = JSON.parse(payload) } catch { continue }
      if (chunk.usage) usage = chunk.usage
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta
      if (!d) continue
      // 思维链（DeepSeek=reasoning_content，部分网关叫 reasoning）：只攒不显示
      const rsn = d.reasoning_content != null ? d.reasoning_content : d.reasoning
      if (typeof rsn === 'string' && rsn) reasoning += rsn
      if (d.content) {
        content += d.content
        if (onDelta) onDelta(d.content)
      }
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const i = tc.index != null ? tc.index : 0
          const cur = tcMap.get(i) || { id: '', name: '', arguments: '' }
          if (tc.id) cur.id += tc.id
          if (tc.function && tc.function.name) cur.name += tc.function.name
          if (tc.function && tc.function.arguments) cur.arguments += tc.function.arguments
          tcMap.set(i, cur)
        }
      }
    }
  }

  const toolCalls = [...tcMap.values()].filter((t) => t.name)
  // reasoning 给上层回填用（带 tool_calls 的 assistant 消息必须原样带回）
  return { content, toolCalls, usage, reasoning }
}
