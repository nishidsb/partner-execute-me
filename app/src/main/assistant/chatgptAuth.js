/**
 * ChatGPT 账号登录流程（规格 1.3）：OAuth PKCE + 动态客户端注册 + 本地回调。
 * 走 OpenAI「Sign in with ChatGPT」公开协议（对齐 Codex CLI）：
 *   1. 动态注册 client（RFC 7591，auth.openai.com/api/register）；失败回退 Codex CLI 公开 client_id
 *   2. 生成 PKCE verifier/challenge（S256）→ shell.openExternal 拉起浏览器授权
 *   3. 本地 127.0.0.1:1455 起回调服务收 code（端口被占顺延 1466/1477）
 *   4. code 换令牌 → 落盘 chatgpt-auth.json（core/models/chatgpt.js 请求时读）
 * 本模块只管「登录/登出/状态」；令牌使用与刷新在 core chatgpt.js。
 */
const { ipcMain, shell } = require('electron')
const http = require('node:http')
const crypto = require('node:crypto')
const path = require('node:path')
const { log } = require('../logger') // logger 导出 { log, logfile }
let coreMod = null // core/models/chatgpt.js（ESM 动态 import 后缓存）
let authPath = null
let pending = null // 进行中的登录流程（单例，防连点）

const FALLBACK_CLIENT_ID = 'app_EMoioEEJblYcVQQgZJCqfHqI' // Codex CLI 公开 client_id（动态注册失败时回退）
const SCOPE = 'openid profile email offline_access'
const PORTS = [1455, 1466, 1477]
const LOGIN_TIMEOUT = 5 * 60 * 1000

function b64url (buf) { return Buffer.from(buf).toString('base64url') }

function init ({ dataRoot } = {}) {
  authPath = path.join(dataRoot || '', 'assistant', 'chatgpt-auth.json')
  if (coreMod) coreMod.setAuthFile(authPath)
}

async function getCore () {
  if (!coreMod) {
    // 本文件在 src/main/assistant/ 下，core 在 src/assistant/core/
    coreMod = await import('../../assistant/core/models/chatgpt.js')
    if (authPath) coreMod.setAuthFile(authPath)
  }
  return coreMod
}

/** RFC 7591 动态注册；任何失败都回退公开 client_id（本地回调 + none 认证是原生应用标准姿势） */
async function registerClient (redirectUri) {
  try {
    const res = await fetch('https://auth.openai.com/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_type: 'native',
        client_name: 'Partner.execute(me);',
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [redirectUri],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE
      })
    })
    if (res.ok) {
      const j = await res.json()
      if (j && j.client_id) return { client_id: j.client_id, dynamic: true }
    }
  } catch {}
  return { client_id: FALLBACK_CLIENT_ID, dynamic: false }
}

function listenOnce (port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      if (!pending) { res.writeHead(404).end(); return }
      if (u.pathname !== '/auth/callback') { res.writeHead(404).end('not found'); return }
      const err = u.searchParams.get('error')
      const done = pending
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (err) {
        done.fail(new Error('授权被拒绝/失败: ' + (u.searchParams.get('error_description') || err)))
        res.end('<meta charset="utf-8"><body style="font-family:sans-serif;background:#1c1930;color:#eee;text-align:center;padding-top:80px"><h2>登录未完成</h2><p>' + err + '</p><p>可以关闭此页回到应用重试。</p>')
      } else {
        done.got(u.searchParams.get('code'), u.searchParams.get('state'))
        res.end('<meta charset="utf-8"><body style="font-family:sans-serif;background:#1c1930;color:#eee;text-align:center;padding-top:80px"><h2>✅ 登录成功</h2><p>可以关闭此页，回到 Partner.execute(me);。</p>')
      }
    })
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function startLogin () {
  if (pending) return { ok: false, error: '已有登录流程在进行（浏览器里完成授权即可）' }
  const core = await getCore()
  // 1) 先把回调服务起起来（端口顺延），再决定 redirect_uri
  let server = null
  let port = 0
  for (const p of PORTS) {
    try { server = await listenOnce(p); port = p; break } catch {}
  }
  if (!server) return { ok: false, error: '本地回调端口都被占用（' + PORTS.join('/') + '）' }
  const redirectUri = 'http://127.0.0.1:' + port + '/auth/callback'

  const flow = { server, timer: null, resolveOk: null, resolveErr: null }
  flow.done = new Promise((resolve, reject) => {
    flow.resolveOk = resolve
    flow.resolveErr = reject
  })
  flow.got = async (code, state) => {
    try {
      if (state !== flow.state) throw new Error('state 校验失败（回调来源可疑），已中止')
      const tokenRes = await fetch('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: flow.clientId,
          code_verifier: flow.verifier
        })
      })
      if (!tokenRes.ok) {
        let detail = ''
        try { detail = (await tokenRes.text()).slice(0, 300) } catch {}
        throw new Error('令牌交换失败 HTTP ' + tokenRes.status + ' ' + detail)
      }
      const j = await tokenRes.json()
      if (!j.access_token) throw new Error('令牌交换响应缺少 access_token')
      const auth = {
        client_id: flow.clientId,
        access_token: j.access_token,
        refresh_token: j.refresh_token || '',
        account_id: j.account_id || '',
        expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
        logged_at: Date.now()
      }
      await core.storeAuth(auth)
      flow.resolveOk({ ok: true, account: maskAccount(auth.account_id) })
    } catch (e) { flow.resolveErr(e) }
  }
  flow.fail = (e) => flow.resolveErr(e)
  pending = flow

  const cleanup = () => {
    if (flow.timer) clearTimeout(flow.timer)
    try { flow.server.close() } catch {}
    if (pending === flow) pending = null
  }
  flow.timer = setTimeout(() => flow.resolveErr(new Error('登录超时（5 分钟内未完成浏览器授权）')), LOGIN_TIMEOUT)
  flow.done.finally(cleanup).catch(() => {})

  try {
    // 2) 动态注册 + PKCE + 浏览器授权
    const reg = await registerClient(redirectUri)
    flow.clientId = reg.client_id
    flow.verifier = b64url(crypto.randomBytes(48))
    flow.challenge = b64url(crypto.createHash('sha256').update(flow.verifier).digest())
    flow.state = crypto.randomBytes(12).toString('hex')
    const authUrl = 'https://auth.openai.com/authorize?' + new URLSearchParams({
      response_type: 'code',
      client_id: flow.clientId,
      redirect_uri: redirectUri,
      scope: SCOPE,
      state: flow.state,
      code_challenge: flow.challenge,
      code_challenge_method: 'S256',
      prompt: 'login'
    }).toString()
    log('[chatgpt] 登录开始 client=' + (reg.dynamic ? '动态注册' : '内置回退') + ' port=' + port)
    await shell.openExternal(authUrl)
    const r = await flow.done
    log('[chatgpt] 登录成功' + (r.account ? ' 账号尾号=' + r.account : ''))
    return r
  } catch (e) {
    log('[chatgpt] 登录失败: ' + e.message)
    return { ok: false, error: e.message }
  }
}

function maskAccount (id) {
  const s = String(id || '')
  return s.length > 4 ? '…' + s.slice(-4) : s
}

async function status () {
  try {
    const core = await getCore()
    const a = await core.loadAuth()
    if (!a || !a.access_token) return { loggedIn: false, pending: !!pending }
    return { loggedIn: true, pending: !!pending, account: maskAccount(a.account_id), expiresAt: a.expires_at || 0 }
  } catch { return { loggedIn: false, pending: !!pending } }
}

async function logout () {
  try { const core = await getCore(); await core.clearAuth() } catch {}
  return { ok: true }
}

function registerIpc () {
  ipcMain.handle('assistant:chatgpt-login', () => startLogin())
  ipcMain.handle('assistant:chatgpt-logout', () => logout())
  ipcMain.handle('assistant:chatgpt-status', () => status())
}

module.exports = { init, registerIpc, status }
