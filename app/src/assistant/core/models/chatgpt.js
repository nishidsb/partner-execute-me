/**
 * ChatGPT 账号接入（规格 1.3）：OAuth PKCE 登录拿到的令牌直连 ChatGPT 后端
 * Codex Responses API，免 API Key 用订阅额度。
 *
 * 职责边界：
 *   - 本文件（core，纯 ESM 零依赖）只做：请求 / OpenAI chat → Responses 协议翻译 /
 *     SSE 聚合 / 401 自动刷新；登录流程（浏览器授权 + 本地回调服务）在主进程壳
 *     chatgptAuth.js，令牌落盘 chatgpt-auth.json（路径由主进程 setAuthFile 注入）
 *   - 返回形状与 openaiCompat 一致：{ content, toolCalls:[{id,name,arguments}], usage:{prompt_tokens,completion_tokens} }
 */
import { readFile, writeFile, rm } from 'node:fs/promises'

const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const API_URL = 'https://chatgpt.com/backend-api/codex/responses'

let authFile = null
/** 主进程启动时注入令牌文件路径（core 不猜目录） */
export function setAuthFile (p) { authFile = p }

export async function loadAuth () {
  if (!authFile) return null
  try { return JSON.parse(await readFile(authFile, 'utf8')) } catch { return null }
}
async function saveAuth (a) { if (authFile) await writeFile(authFile, JSON.stringify(a, null, 2)) }
/** 登录流程（主进程壳）换到令牌后从这里落盘 */
export const storeAuth = saveAuth
export async function clearAuth () { try { if (authFile) await rm(authFile, { force: true }) } catch {} }

async function refresh (auth) {
  if (!auth || !auth.refresh_token || !auth.client_id) throw new Error('ChatGPT 令牌已失效且无法刷新（请重新登录）')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: auth.client_id })
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 300) } catch {}
    throw new Error('ChatGPT 令牌刷新失败 HTTP ' + res.status + ' ' + detail + '（请重新登录）')
  }
  const j = await res.json()
  if (!j.access_token) throw new Error('ChatGPT 令牌刷新响应缺少 access_token')
  const next = {
    ...auth,
    access_token: j.access_token,
    refresh_token: j.refresh_token || auth.refresh_token,
    account_id: j.account_id || auth.account_id || '',
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000
  }
  try { await saveAuth(next) } catch {}
  return next
}

function textOf (c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (p && p.text) || '').join('')
  return ''
}

/** OpenAI chat 消息/工具 → Responses API 的 instructions + input + tools */
export function translate (messages, tools) {
  let instructions = ''
  const input = []
  for (const m of messages || []) {
    if (!m || !m.role) continue
    if (m.role === 'system') {
      instructions += (instructions ? '\n\n' : '') + textOf(m.content)
      continue
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id || '', output: textOf(m.content) })
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (m.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textOf(m.content) }] })
      for (const tc of m.tool_calls) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function && tc.function.name, arguments: (tc.function && tc.function.arguments) || '{}' })
      }
      continue
    }
    const parts = []
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: p.text || '' })
        else if (p.type === 'image_url' && p.image_url && p.image_url.url) parts.push({ type: 'input_image', image_url: p.image_url.url })
      }
    } else {
      const t = textOf(m.content)
      if (t) parts.push({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: t })
    }
    if (parts.length) input.push({ type: 'message', role: m.role === 'assistant' ? 'assistant' : 'user', content: parts })
  }
  const t = (tools || [])
    .map((d) => (d && d.function) ? {
      type: 'function',
      name: d.function.name,
      description: d.function.description || '',
      parameters: d.function.parameters || { type: 'object', properties: {} },
      strict: false
    } : null)
    .filter(Boolean)
  return { instructions: instructions || undefined, input, tools: t }
}

/** reasoningEffort 四档 → Responses reasoning.effort（none 不发；max 档 API 无对应，取 high） */
function effortOf (re) {
  if (re === 'low' || re === 'high') return re
  if (re === 'max') return 'high'
  return null
}

async function requestOnce (auth, opts) {
  const { model, messages, tools, signal, onDelta, reasoningEffort, temperature } = opts
  const tr = translate(messages, tools)
  const body = { model: model || 'gpt-5', stream: true, store: false, input: tr.input }
  if (tr.instructions) body.instructions = tr.instructions
  if (tr.tools.length) body.tools = tr.tools
  const eff = effortOf(reasoningEffort)
  if (eff) body.reasoning = { effort: eff }
  // 1.4 约定：temperature 未显式设置就不发（ChatGPT 后端同样不收该参数，这里永不发）
  void temperature

  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + auth.access_token
  }
  if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id

  const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 500) } catch {}
    const err = new Error(`ChatGPT 后端 HTTP ${res.status}: ${detail}`)
    err.status = res.status
    throw err
  }
  if (!res.body) throw new Error('ChatGPT 后端返回空响应体')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  const toolCalls = []
  let usage = null
  let failure = null

  const handle = (chunk) => {
    const type = chunk.type || ''
    if (type === 'response.output_text.delta' && chunk.delta) {
      content += chunk.delta
      if (onDelta) onDelta(chunk.delta)
    } else if (type === 'response.output_item.done' && chunk.item && chunk.item.type === 'function_call') {
      toolCalls.push({ id: chunk.item.call_id || ('call_' + toolCalls.length), name: chunk.item.name || '', arguments: chunk.item.arguments || '' })
    } else if (type === 'response.completed' && chunk.response) {
      const u = chunk.response.usage
      if (u) usage = { prompt_tokens: Number(u.input_tokens) || 0, completion_tokens: Number(u.output_tokens) || 0 }
    } else if (type === 'response.failed') {
      const em = (chunk.response && chunk.response.error && chunk.response.error.message) || 'ChatGPT 返回失败'
      failure = em
    } else if (type === 'error') {
      failure = (chunk.message || chunk.error && chunk.error.message || 'ChatGPT 流式错误')
    }
  }

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
      if (!payload || payload === '[DONE]') continue
      let chunk
      try { chunk = JSON.parse(payload) } catch { continue }
      handle(chunk)
    }
  }
  if (failure) throw new Error(failure)
  return { content, toolCalls, usage }
}

export async function chat (opts) {
  let auth = await loadAuth()
  if (!auth || !auth.access_token) throw new Error('尚未登录 ChatGPT 账号（设置 → 模型 → ChatGPT 账号登录）')
  // 过期前 60s 主动刷新，省一次 401 往返
  if (auth.expires_at && Date.now() > auth.expires_at - 60000 && auth.refresh_token) {
    auth = await refresh(auth)
  }
  try {
    return await requestOnce(auth, opts)
  } catch (e) {
    if (e && e.status === 401 && auth.refresh_token) {
      return requestOnce(await refresh(auth), opts)
    }
    throw e
  }
}
