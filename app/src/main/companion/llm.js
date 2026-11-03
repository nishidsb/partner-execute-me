'use strict'
/**
 * AI 伴侣 · LLM 客户端
 * OpenAI 兼容 Chat Completions（SSE 流式）。远程 API 与本地部署模型
 * （Ollama / LM Studio / vLLM 等 /v1 兼容端点）走同一协议，只差 baseURL。
 * 支持工具调用（function calling），工具由 tools.js 执行后回填继续生成。
 */
const { log } = require('../logger')

/** 瞬态错误（服务过载 429/5xx、网关抖动）→ 值得退避重试；流式已吐字就不重试（避免重复说话）。
 *  0.45.11：deepseek 高峰期一场活动第一轮就被 503 打断整场报废（真机日志实证），加上韧性。 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const RETRY_DELAYS_MS = [2000, 6000, 15000]

function wait (ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 打开一次补全请求；瞬态错误/网络抖动在收到响应头之前重试。
 * 已建立流（res.ok）之后发生的事不在本函数管辖内——那之后重试有重复说话风险。
 */
async function openCompletion ({ url, headers, body, signal, label }) {
  let lastErr = null
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1]
      log(`[llm] ${label}瞬态错误（${lastErr && lastErr.status || '网络'}），${Math.round(delay / 1000)}s 后重试（第 ${attempt}/${RETRY_DELAYS_MS.length} 次）`)
      await wait(delay)
      if (signal && signal.aborted) throw lastErr || new Error('aborted')
    }
    try {
      const res = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(body) })
      if (res.ok) return res
      const text = await res.text().catch(() => '')
      const err = new Error(`LLM ${res.status}: ${text.slice(0, 300)}`)
      err.status = res.status
      lastErr = err
      if (!RETRYABLE_STATUS.has(res.status)) throw err   // 401/400 这类重试也没用，直接抛
    } catch (e) {
      if (e && e.status && !RETRYABLE_STATUS.has(e.status)) throw e  // 不可重试的 HTTP 错
      lastErr = e
      if (signal && signal.aborted) throw e              // 主动中断（主人回来/超时）绝不重试
      // 网络抖动（fetch TypeError 等）→ 走下一轮重试
    }
  }
  throw (lastErr || new Error('LLM 请求失败'))
}

/**
 * 流式对话。onDelta(text) 逐段回调；遇到工具调用时执行 tools 并自动续轮。
 * 返回 { content, toolResults }
 */
async function chatStream ({ baseUrl, apiKey, model, messages, temperature = 0.8, tools, toolExec, signal, onDelta, maxRounds = 4 }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions'
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey

  const roundMessages = [...messages]
  const toolResults = []
  let content = ''

  for (let round = 0; round < Math.max(1, Number(maxRounds) || 4); round++) {
    const body = { model, messages: roundMessages, temperature, stream: true }
    if (tools && tools.length) body.tools = tools
    const res = await openCompletion({ url, headers, body, signal, label: 'chatStream ' })
    // SSE 解析
    let buf = ''
    let roundContent = ''
    /* 0.45.66 thinking 模式必须把思维链带回去。
     * 真机实测（tools/vision-probe.js 同款探针脚本）：只发 assistant{tool_calls} 不回传
     * reasoning_content，DeepSeek 直接 400「The reasoning_content in the thinking mode
     * must be passed back to the API」。而本文件原先压根不读这个字段——意味着任何
     * 工具调用走到第二轮都可能整体失败（她「记住」「看屏」「开程序」全在工具链上）。
     * 这里把流里的思维链攒起来，回填 assistant 消息时原样带上。 */
    let roundReasoning = ''
    const calls = [] // { id, name, arguments }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let j
        try { j = JSON.parse(data) } catch { continue }
        const d = j.choices && j.choices[0] && (j.choices[0].delta || {})
        // 思维链（DeepSeek 用 reasoning_content，部分网关叫 reasoning）：只攒不回显，
        // 下一轮随 assistant 消息带回去，否则 thinking 模式会 400
        const rsn = d.reasoning_content || d.reasoning
        if (typeof rsn === 'string' && rsn) roundReasoning += rsn
        if (d.content) {
          roundContent += d.content
          try { onDelta && onDelta(d.content) } catch {}
        }
        const tc = d.tool_calls
        if (Array.isArray(tc)) {
          for (const c of tc) {
            const idx = c.index != null ? c.index : 0
            if (!calls[idx]) calls[idx] = { id: c.id || '', name: '', arguments: '' }
            if (c.id) calls[idx].id = c.id
            if (c.function && c.function.name) calls[idx].name += c.function.name
            if (c.function && c.function.arguments) calls[idx].arguments += c.function.arguments
          }
        }
      }
    }
    content += roundContent
    if (!calls.length) break // 没有工具调用，对话结束

    // 工具调用轮：执行并回填
    const assistantMsg = {
      role: 'assistant',
      content: roundContent || null,
      tool_calls: calls.map((c) => ({
        id: c.id || 'call_' + round, type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' }
      }))
    }
    // thinking 模式要求原样带回思维链（空串也别塞，非 thinking 模型会当成未知字段）
    if (roundReasoning) assistantMsg.reasoning_content = roundReasoning
    roundMessages.push(assistantMsg)
    for (const c of calls) {
      let result
      try {
        const args = JSON.parse(c.arguments || '{}')
        result = toolExec ? await toolExec(c.name, args) : '工具不可用'
      } catch (err) {
        result = '工具执行失败: ' + (err && err.message)
      }
      // 工具返回 { text, image }（如 see_screen 截屏）→ 组装多模态 tool 消息。
      // cua 返回的 image 已是完整 dataURL（data:image/png;base64,...）——直接用，
      // 再拼前缀会变成「data:image/jpeg;base64,data:image/png;base64,...」双前缀，
      // API 报 Invalid base64 data 400（0.45.0 挡 3 真机踩中）。
      let toolContent = String(result)
      if (result && typeof result === 'object' && result.image) {
        const url = /^data:image\//.test(String(result.image))
          ? String(result.image)
          : 'data:image/png;base64,' + result.image
        toolContent = [
          { type: 'text', text: result.text || '截图如下' },
          { type: 'image_url', image_url: { url } }
        ]
      }
      log('[companion] 工具', c.name, '->', String(typeof result === 'object' ? result.text : result).slice(0, 200))
      toolResults.push({ name: c.name, result: typeof result === 'object' ? (result.text || '') : String(result) })
      roundMessages.push({ role: 'tool', tool_call_id: c.id || 'call_' + round, content: toolContent })
    }
  }
  return { content, toolResults }
}

/**
 * 一次性短问答（非流式）。
 *
 * 用途：不生成对话、只要一个判断的小任务（0.36.0 的语义判读器）。
 * 跟 chatStream 的区别：不需要 SSE、不需要工具、token 上限压得很小、
 * 自带硬超时（判读是旁路，慢了一律当失败，绝不能拖住主对话）。
 *
 * @returns {Promise<string>} 模型输出原文（空串表示没拿到内容，调用方应回退）
 */
async function chatOnce ({ baseUrl, apiKey, model, messages, temperature = 0, maxTokens = 220, timeoutMs = 8000 }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base || !model) throw new Error('判读器缺少 baseUrl/model')
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions'
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey

  const ctrl = new AbortController()
  const timer = setTimeout(() => { try { ctrl.abort() } catch { } }, Math.max(1000, Number(timeoutMs) || 8000))
  try {
    // 复用 openCompletion 的瞬态重试：硬超时（ctrl.abort）一旦触发 signal.aborted
    // 就不再重试，总时长封顶仍是 timeoutMs——旁路「慢了一律当失败」的语义不变。
    const res = await openCompletion({ url, headers, body: {
      model,
      messages,
      temperature,
      max_tokens: Math.max(32, Number(maxTokens) || 220),
      stream: false
    }, signal: ctrl.signal, label: 'chatOnce ' })
    const parse = (j) => {
      const c = j && j.choices && j.choices[0]
      return {
        out: String((c && ((c.message && c.message.content) || c.text)) || '').trim(),
        fin: (c && c.finish_reason) || ''
      }
    }
    let p = parse(await res.json())
    // 0.46.4 reasoning 模型（deepseek 等）会先吐 reasoning_content 再给正文：
    // 小预算调用经常思考就把 max_tokens 吃光，正文一字未出（finish_reason=length），
    // 表现为「模型空回复」——经历沉淀上线以来 0 次成功（全日志实证）。空 + length
    // 时原地用 3 倍预算重试一次；真·空回复（stop）不重试，照旧返回。
    if (!p.out && p.fin === 'length') {
      const res2 = await openCompletion({ url, headers, body: {
        model,
        messages,
        temperature,
        max_tokens: Math.min(1200, Math.max(64, (Math.max(32, Number(maxTokens) || 220)) * 3)),
        stream: false
      }, signal: ctrl.signal, label: 'chatOnce 预算重试 ' })
      p = parse(await res2.json())
    }
    return p.out
  } finally {
    clearTimeout(timer)
  }
}

/** 模型列表（本地端点 /v1/models），失败返回空数组 */
async function listModels ({ baseUrl, apiKey }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const url = /\/models$/.test(base) ? base : base + '/models'
  try {
    const headers = {}
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey
    const res = await fetch(url, { headers })
    if (!res.ok) return []
    const j = await res.json()
    return (j.data || []).map((m) => m.id).filter(Boolean)
  } catch {
    return []
  }
}

module.exports = { chatStream, chatOnce, listModels, RETRY_DELAYS_MS }
