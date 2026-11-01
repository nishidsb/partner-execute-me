/**
 * OpenAI 兼容模型接入（DeepSeek / OpenAI / 各类兼容服务）。
 * 支持流式输出与工具调用（function calling）增量聚合。
 * 依赖 Node 22 原生 fetch，零第三方包。
 *
 * 返回 { content, toolCalls: [{id,name,arguments}], usage? }
 */
export async function chat (opts) {
  const {
    baseUrl, apiKey, model, messages, tools,
    temperature = 0.8, signal, onDelta, maxTokens
  } = opts

  const url = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model, messages, temperature, stream: true
  }
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
    const err = new Error(`模型服务 HTTP ${res.status}: ${detail}`)
    err.status = res.status
    throw err
  }
  if (!res.body) throw new Error('模型服务返回空响应体')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
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
  return { content, toolCalls, usage }
}
