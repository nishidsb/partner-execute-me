/**
 * Anthropic Messages API 直连（S7）。零依赖，Node 22 原生 fetch。
 * 协议文档：POST {baseUrl}/v1/messages，SSE 流式，tool_use / tool_result 内容块。
 *
 * 与 openaiCompat 相同的对外契约：
 *   chat({ baseUrl, apiKey, model, messages, tools, temperature, signal, onDelta, maxTokens })
 *     → { content, toolCalls: [{id,name,arguments}], usage }
 * 入参 messages / tools 都是 OpenAI 形状，在内部完成转换。
 */

const API_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

/** dataURL → {media_type, data}；不是 base64 图片 dataURL 返回 null */
function parseImage (url) {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(String(url || ''))
  return m ? { media_type: m[1].toLowerCase(), data: m[2] } : null
}

/** OpenAI 消息数组 → Anthropic {system, messages}（导出供单测） */
export function convertMessages (messages = []) {
  let system = ''
  const out = []
  for (const m of messages) {
    const role = m.role
    if (role === 'system') {
      system += (system ? '\n\n' : '') + String(m.content || '')
      continue
    }
    if (role === 'tool') {
      // 工具结果 = 一条带 tool_result 块的 user 消息
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: String(m.content ?? '') }]
      })
      continue
    }
    const blocks = []
    if (role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      for (const tc of m.toolCalls) {
        let input = {}
        try { input = JSON.parse(tc.arguments || '{}') } catch { /* 坏参数按空对象发 */ }
        blocks.push({ type: 'tool_use', id: tc.id || ('call_' + blocks.length), name: tc.name, input })
      }
    }
    if (m.content) {
      if (typeof m.content === 'string') {
        if (m.content.trim()) blocks.unshift({ type: 'text', text: String(m.content) })
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text })
          else if (part.type === 'image_url') {
            const img = parseImage(part.image_url && part.image_url.url)
            if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })
          }
        }
      }
    }
    if (blocks.length) out.push({ role: role === 'assistant' ? 'assistant' : 'user', content: blocks })
  }
  // Anthropic 要求角色交替：把相邻同角色合并（tool_result 也天然是 user，正好接上）
  const merged = []
  for (const m of out) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.content = last.content.concat(m.content)
    else merged.push({ role: m.role, content: m.content.slice() })
  }
  // 首条必须是 user
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: [{ type: 'text', text: '（继续之前的对话）' }] })
  }
  return { system: system || undefined, messages: merged }
}

/** OpenAI tools → Anthropic tools（导出供单测） */
export function convertTools (tools) {
  if (!tools || !tools.length) return undefined
  return tools.map((t) => {
    const f = t.function || t
    return { name: f.name, description: f.description || '', input_schema: f.parameters || { type: 'object', properties: {} } }
  })
}

export async function chat (opts) {
  const {
    baseUrl, apiKey, model, messages, tools,
    temperature, signal, onDelta, maxTokens,
    reasoningEffort            // 1.5：映射成 thinking.budget_tokens（开了 thinking 就不许带 temperature）
  } = opts

  const { system, messages: bodyMsgs } = convertMessages(messages)
  const body = {
    model,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    stream: true,
    messages: bodyMsgs
  }
  if (system) body.system = system
  if (temperature != null) body.temperature = temperature
  if (reasoningEffort && reasoningEffort !== 'none') {
    const budget = { low: 2048, high: 8192, max: 16384 }[reasoningEffort] || 2048
    body.thinking = { type: 'enabled', budget_tokens: budget }
    // Anthropic 规则：thinking 开启时 temperature 必须省略，且 max_tokens > budget_tokens
    delete body.temperature
    if (body.max_tokens <= budget) body.max_tokens = budget + 2048
  }
  const apiTools = convertTools(tools)
  if (apiTools) body.tools = apiTools

  const url = String(baseUrl || '').replace(/\/+$/, '') + '/v1/messages'
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey || '',
      'anthropic-version': API_VERSION
    },
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

  const handleLine = (line) => {
    line = line.trim()
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let ev
    try { ev = JSON.parse(payload) } catch { return }
    if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
      const i = ev.index != null ? ev.index : 0
      tcMap.set(i, { id: ev.content_block.id || '', name: ev.content_block.name || '', arguments: '' })
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {}
      if (d.type === 'text_delta' && d.text) {
        content += d.text
        if (onDelta) onDelta(d.text)
      } else if (d.type === 'input_json_delta' && d.partial_json) {
        const i = ev.index != null ? ev.index : 0
        const cur = tcMap.get(i)
        if (cur) cur.arguments += d.partial_json
      }
    } else if (ev.type === 'message_delta' && ev.usage) {
      // message_delta 只带增量（通常只有 output_tokens），与 message_start 合并
      usage = {
        prompt_tokens: ev.usage.input_tokens ?? (usage && usage.prompt_tokens) ?? 0,
        completion_tokens: ev.usage.output_tokens ?? (usage && usage.completion_tokens) ?? 0
      }
    } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
      usage = {
        prompt_tokens: ev.message.usage.input_tokens ?? (usage && usage.prompt_tokens) ?? 0,
        completion_tokens: (usage && usage.completion_tokens) || 0
      }
    } else if (ev.type === 'error') {
      throw new Error('模型服务流内错误: ' + ((ev.error && ev.error.message) || JSON.stringify(ev.error)))
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      handleLine(line)
    }
  }
  // 流结束但没有以换行收尾时，最后一条事件还留在 buf 里（SSE 不保证尾部换行）
  if (buf.trim()) handleLine(buf)

  const toolCalls = [...tcMap.values()].filter((t) => t.name)
  return { content, toolCalls, usage }
}
