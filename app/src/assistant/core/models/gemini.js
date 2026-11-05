import { chatWatchdog } from './watchdog.js'

/**
 * Gemini API 直连（S7）。零依赖，Node 22 原生 fetch。
 * 协议：POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse&key=API_KEY
 *
 * 与 openaiCompat 相同的对外契约：
 *   chat({ baseUrl, apiKey, model, messages, tools, temperature, signal, onDelta, maxTokens })
 *     → { content, toolCalls: [{id,name,arguments}], usage }
 * 入参 messages / tools 都是 OpenAI 形状，在内部完成转换。
 */

/** OpenAI 消息数组 → Gemini {systemInstruction, contents}（导出供单测） */
export function convertMessages (messages = []) {
  let system
  const out = []
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      system = { parts: [{ text: (system ? system.parts[0].text + '\n\n' : '') + String(text || '') }] }
      continue
    }
    const parts = []
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      for (const tc of m.toolCalls) {
        let args = {}
        try { args = JSON.parse(tc.arguments || '{}') } catch { /* 坏参数按空对象发 */ }
        parts.push({ functionCall: { name: tc.name, args } })
      }
    }
    if (m.content) {
      if (typeof m.content === 'string') {
        if (m.content.trim()) parts.push({ text: String(m.content) })
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text' && part.text) parts.push({ text: part.text })
          else if (part.type === 'image_url') {
            const mm = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(String(part.image_url && part.image_url.url))
            if (mm) parts.push({ inlineData: { mimeType: mm[1].toLowerCase(), data: mm[2] } })
          }
        }
      }
    }
    if (m.role === 'tool') {
      // 工具结果 = 带 functionResponse 的 user 轮
      let result = String(m.content ?? '')
      try { result = JSON.parse(result) } catch { /* 文本结果包一层 */ }
      out.push({ role: 'user', parts: [{ functionResponse: { name: m.name || 'tool', response: { result } } }] })
      continue
    }
    if (parts.length) out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts })
  }
  // 角色合并（Gemini 官方也推荐连续同角色合并成一条 contents）
  const merged = []
  for (const m of out) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.parts = last.parts.concat(m.parts)
    else merged.push({ role: m.role, parts: m.parts.slice() })
  }
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', parts: [{ text: '（继续之前的对话）' }] })
  }
  return { systemInstruction: system, contents: merged }
}

/** OpenAI tools → Gemini functionDeclarations（导出供单测） */
export function convertTools (tools) {
  if (!tools || !tools.length) return undefined
  const decls = tools.map((t) => {
    const f = t.function || t
    const params = JSON.parse(JSON.stringify(f.parameters || { type: 'object', properties: {} }))
    // Gemini 只认 OpenAPI 子集：$schema 会被拒
    delete params.$schema
    return { name: f.name, description: f.description || '', parameters: params }
  })
  return [{ functionDeclarations: decls }]
}

export async function chat (opts) {
  const {
    baseUrl, apiKey, model, messages, tools,
    temperature, signal, onDelta, maxTokens,
    reasoningEffort            // 1.5：映射成 generationConfig.thinkingConfig.thinkingBudget
  } = opts

  const { systemInstruction, contents } = convertMessages(messages)
  const body = { contents }
  if (systemInstruction) body.systemInstruction = systemInstruction
  const apiTools = convertTools(tools)
  if (apiTools) body.tools = apiTools
  const gen = {}
  if (temperature != null) gen.temperature = temperature
  if (maxTokens) gen.maxOutputTokens = maxTokens
  if (reasoningEffort) {
    gen.thinkingConfig = { thinkingBudget: { none: 0, low: 1024, high: 4096, max: 8192 }[reasoningEffort] ?? 0 }
  }
  if (Object.keys(gen).length) body.generationConfig = gen

  const url = String(baseUrl || '').replace(/\/+$/, '') +
    `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey || '')}`

  // 0.46.21 看门狗：裸 fetch 无超时，流停摆会把整轮永久挂死（真机 17:31 实锤，同 openaiCompat）
  const wd = chatWatchdog(signal)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: wd.signal
    })
  } catch (err) {
    wd.done()
    if (wd.fired()) throw new Error('模型服务超时：60 秒内没有收到响应（已主动断开），请重试')
    throw err
  }
  wd.touch()

  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 500) } catch {}
    const err = new Error(`模型服务 HTTP ${res.status}: ${detail}`)
    err.status = res.status
    wd.done()
    throw err
  }
  if (!res.body) { wd.done(); throw new Error('模型服务返回空响应体') }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  const toolCalls = []
  let usage = null
  let callSeq = 0

  const handleLine = (line) => {
    line = line.trim()
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload) return
    let ev
    try { ev = JSON.parse(payload) } catch { return }
    if (ev.error) throw new Error('模型服务流内错误: ' + (ev.error.message || JSON.stringify(ev.error)))
    const cand = ev.candidates && ev.candidates[0]
    if (cand && cand.content && Array.isArray(cand.content.parts)) {
      for (const p of cand.content.parts) {
        if (p.text) {
          content += p.text
          if (onDelta) onDelta(p.text)
        } else if (p.functionCall && p.functionCall.name) {
          callSeq++
          toolCalls.push({
            id: 'call_' + callSeq,
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args || {})
          })
        }
      }
    }
    if (ev.usageMetadata) {
      usage = {
        prompt_tokens: ev.usageMetadata.promptTokenCount,
        completion_tokens: ev.usageMetadata.candidatesTokenCount
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      wd.touch()
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        handleLine(line)
      }
    }
  } catch (err) {
    if (wd.fired()) throw new Error('模型响应中断：流中 120 秒没有新数据（已主动断开），本轮结束，请重试')
    throw err
  } finally {
    wd.done()
  }
  // 流结束但没有以换行收尾时，最后一条事件还留在 buf 里（SSE 不保证尾部换行）
  if (buf.trim()) handleLine(buf)

  return { content, toolCalls, usage }
}
