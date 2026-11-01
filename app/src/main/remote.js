'use strict'
/**
 * 0.24.0 出门方案第 1 期 · 随身服务（remote）
 *
 * 手机网页 ←→ 电脑上的「她」。原则：脑子永远在电脑里，手机只是眼睛+手+嘴。
 *   - 记忆天然同源：手机上的对话走同一条 assistant 管线，桌面端能实时看到
 *   - 只监听 127.0.0.1 + Tailscale 网段（有网卡的才绑），公网摸不到
 *   - 口令鉴权：首次开启自动生成 32 位 hex，手机页面填一次存在 localStorage
 *
 * 端点（全部走 ?t= 或 x-token 头鉴权）：
 *   GET  /                 → 手机页面（token 已内嵌）
 *   POST /api/say          {text}                → 聊天 → {reply, display, audio}
 *   POST /api/see          {image(dataURL), note?} → 让她看 → {reply, audio}
 *   POST /api/voice        {audio(dataURL webm)} → 本地/云 ASR → 聊天 → {text, reply, audio}
 *   POST /api/touch        {part}                → 触摸事件（并入触摸管线：情绪账本+通知）
 *   GET  /api/status                             → {ok, charName, obsPort, tsIp}
 *
 * audio = {mime, b64}：用当前 TTS 配置（含本地回退链）合成的她的声音，手机直接播。
 */
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { fileURLToPath } = require('node:url')

/* HTTPS：Chrome/Edge 规定 getUserMedia（摄像头/麦克风）只在 https 或 localhost 可用，
 * 手机页必须提供 https 入口（自签证书，首次访问点一次「继续前往」）。 */
const selfsigned = require('selfsigned')

const STATE = {
  running: false,
  servers: [],
  port: 0,
  wantedPort: 0,
  tlsPort: 0,
  token: '',
  hosts: [],
  tsIp: '',
  tsFqdn: '',
  tsServeOn: false,
  lastError: '',
  startedAt: 0,
  reqCount: 0
}

let BR = null // bridges：companion 注入的回调集

function log (msg) { try { BR && BR.log && BR.log('[remote] ' + msg) } catch { } }

/** 找 Tailscale 的 IPv4（Windows 网卡名含 Tailscale；Linux/mac 是 tailscale0/tun0 风格） */
function detectTailscaleIp () {
  try {
    const ifs = os.networkInterfaces()
    for (const [name, addrs] of Object.entries(ifs)) {
      if (!/tailscale/i.test(name)) continue
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) return a.address
      }
    }
  } catch { }
  return ''
}

function checkToken (req, urlObj) {
  const q = urlObj.searchParams.get('t')
  const h = req.headers['x-token']
  const t = (typeof h === 'string' && h) || (typeof q === 'string' ? q : '')
  return !!STATE.token && t === STATE.token
}

function sendJson (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(body)
}

function readBody (req, cap) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > (cap || 16 * 1024 * 1024)) { resolve(null); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

/** file:// URL → {mime, b64}（她的声音随 JSON 一起回手机，省一个鉴权端点） */
function audioPayload (ttsResult) {
  try {
    if (!ttsResult || !ttsResult.ok || !ttsResult.url) return null
    const p = fileURLToPath(ttsResult.url)
    const buf = fs.readFileSync(p)
    const mime = /\.wav$/i.test(p) ? 'audio/wav' : (/\.ogg$/i.test(p) ? 'audio/ogg' : 'audio/mpeg')
    return { mime, b64: buf.toString('base64') }
  } catch { return null }
}

/* 自签证书：每个安装生成一次并落盘（浏览器记住了「继续访问」就不反复弹） */
let CERT = null
async function ensureCert (tsIp) {
  if (CERT) return CERT
  const dir = (BR && BR.certDir) || ''
  const kf = dir ? dir + '/remote-key.pem' : ''
  const cf = dir ? dir + '/remote-cert.pem' : ''
  try {
    if (kf && fs.existsSync(kf) && fs.existsSync(cf)) {
      CERT = { key: fs.readFileSync(kf, 'utf8'), cert: fs.readFileSync(cf, 'utf8') }
      return CERT
    }
  } catch { }
  const altNames = [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }]
  if (tsIp) altNames.push({ type: 7, ip: tsIp })
  const p = await selfsigned.generate([{ name: 'commonName', value: 'ryza-remote' }], {
    keySize: 2048, algorithm: 'sha256', days: 3650,
    extensions: [{ name: 'subjectAltName', altNames }]
  })
  CERT = { key: p.private, cert: p.cert }
  try {
    if (kf) { fs.writeFileSync(kf, CERT.key); fs.writeFileSync(cf, CERT.cert) }
  } catch (e) { log('证书落盘失败: ' + e.message) }
  return CERT
}

/** OBS 同源代理：/obs/… → http://127.0.0.1:obsPort/…
 * 手机页的 iframe 走这个（同源、随主页面一起 https），避开 https 页面嵌 http iframe 的混合内容拦截 */
function proxyObs (req, res, urlObj) {
  const info = BR.statusInfo ? BR.statusInfo() : {}
  const port = Number(info.obsPort) || 0
  if (!port) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('OBS 画面导出没开') }
  const up = http.request({
    host: '127.0.0.1', port, method: req.method,
    path: urlObj.pathname.replace(/^\/obs/, '') + urlObj.search,
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + port })
  }, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers)
    ur.pipe(res)
  })
  up.on('error', () => { try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('OBS 连不上') } catch { } })
  req.pipe(up)
}

/* ---------------- Tailscale Serve：真证书入口（自签证书的浏览器会拦摄像头，这条不拦） ---------------- */
const { spawn, execFileSync } = require('node:child_process')

function findTailscaleExe () {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Tailscale\\tailscale.exe',
        'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
      ]
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
  for (const p of candidates) { try { if (fs.existsSync(p)) return p } catch { } }
  return null
}

/** 起tailscale serve（--bg 挂后台），成功后手机可用 https://<机器名>.ts.net 直连（Let's Encrypt 真证书）
 *  失败不致命：八成是 tailnet 没开 Serve，日志里留开启链接，自签 https 仍可用 */
function setupTailscaleServe (port) {
  const exe = findTailscaleExe()
  if (!exe) { log('没找到 tailscale 命令行，跳过真证书入口'); return }
  try {
    const fqdn = String(JSON.parse(execFileSync(exe, ['status', '--json'], { timeout: 8000 }).toString()).Self?.DNSName || '').replace(/\.$/, '')
    if (!fqdn) { log('tailscale 没给出机器域名，跳过真证书入口'); return }
    STATE.tsFqdn = fqdn
    const r = spawn(exe, ['serve', '--bg', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    r.stderr.on('data', (c) => { out += c })
    r.stdout.on('data', (c) => { out += c })
    r.on('close', (code) => {
      const text = out.trim()
      if (code === 0) {
        STATE.tsServeOn = true
        log(`tailscale serve 已挂上：https://${fqdn}/（真证书，摄像头/麦克风可用）`)
      } else if (/not enabled/i.test(text)) {
        const link = (text.match(/https:\/\/login\.tailscale\.com\/\S+/) || [''])[0]
        log('tailnet 没开 Serve。要真证书入口请先点这个链接开启（一次性）：' + (link || 'https://login.tailscale.com/admin/settings/serve'))
        if (link) STATE.tsServeHint = link
      } else {
        log('tailscale serve 失败: ' + text.slice(0, 200))
      }
    })
  } catch (e) { log('tailscale 配置失败: ' + (e && e.message)) }
}

function teardownTailscaleServe () {
  if (!STATE.tsServeOn) return
  STATE.tsServeOn = false
  const exe = findTailscaleExe()
  if (!exe) return
  try { spawn(exe, ['serve', 'reset'], { stdio: 'ignore' }) } catch { }
}

async function handleApi (req, res, urlObj) {
  const route = urlObj.pathname
  // ---------- 无需 body 的 ----------
  if (req.method === 'GET' && route === '/api/status') {
    return sendJson(res, 200, {
      ok: true, running: STATE.running, port: STATE.port, tlsPort: STATE.tlsPort, tsIp: STATE.tsIp, tsFqdn: STATE.tsFqdn,
      ...(BR.statusInfo ? BR.statusInfo() : {})
    })
  }
  const bodyRaw = await readBody(req, req.method === 'POST' && route === '/api/see' ? 14 * 1024 * 1024 : 16 * 1024 * 1024)
  if (!bodyRaw) return sendJson(res, 400, { ok: false, error: '请求体读取失败或超限' })
  let body = {}
  try { body = JSON.parse(bodyRaw.toString('utf8') || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }) }

  // ---------- 触摸：并入触摸管线（情绪账本 + 2.5s 合并注入），桌面手机同一份账本 ----------
  if (route === '/api/touch') {
    const part = String(body.part || '').slice(0, 20)
    if (!part) return sendJson(res, 400, { ok: false, error: '缺 part' })
    try { if (BR.touch) BR.touch(part) } catch { }
    return sendJson(res, 200, { ok: true })
  }

  // ---------- 手机本地数据同步（0.24.0 第 3 期）：手机上先存本地，你点「同步」才上来 ----------
  // items: [{type:'health'|'note'|'mood', at, data:{...}}]，宿主决定怎么落盘（健康记录/自我层事件）
  if (route === '/api/sync') {
    const items = Array.isArray(body.items) ? body.items.slice(0, 300) : []
    if (!items.length) return sendJson(res, 400, { ok: false, error: '没有要同步的内容' })
    if (!BR.sync) return sendJson(res, 200, { ok: false, error: '电脑端还没接上同步能力' })
    try {
      const r = await BR.sync(items)
      return sendJson(res, 200, r)
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) })
    }
  }

  // ---------- 让她看：拍一张 + 一句话，走同一条聊天管线（视觉模型看图） ----------
  if (route === '/api/see') {
    const img = String(body.image || '')
    const note = String(body.note || '').trim().slice(0, 300)
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(img)) {
      return sendJson(res, 400, { ok: false, error: 'image 要是 dataURL' })
    }
    const text = (note ? note + '\n' : '') + '（这是我现在用手机摄像头看到的画面，看看有什么想说的）'
    const r = await BR.send(text, [img])
    if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error || '她没答上来' })
    const audio = await BR.ttsSpeak(r.content)
    return sendJson(res, 200, { ok: true, reply: r.content, display: r.display || r.content, audio: audioPayload(audio) })
  }

  // ---------- 语音留言：ASR → 聊天 → 她的声音 ----------
  if (route === '/api/voice') {
    const audio = String(body.audio || '')
    const m = audio.match(/^data:(audio\/[\w.+-]+);base64,(.+)$/)
    if (!m) return sendJson(res, 400, { ok: false, error: 'audio 要是 dataURL' })
    const tr = await BR.transcribe(m[2], m[1])
    if (!tr.ok) return sendJson(res, 200, { ok: false, error: tr.message || '没听清' })
    const r = await BR.send(tr.text, [])
    if (!r.ok) return sendJson(res, 200, { ok: true, text: tr.text, reply: '', error: r.error || '她没答上来' })
    const tts = await BR.ttsSpeak(r.content)
    return sendJson(res, 200, { ok: true, text: tr.text, reply: r.content, display: r.display || r.content, audio: audioPayload(tts) })
  }

  // ---------- 打字聊天 ----------
  if (route === '/api/say') {
    let text = String(body.text || '').trim().slice(0, 4000)
    if (!text) return sendJson(res, 400, { ok: false, error: '内容为空' })
    /* 0.45.71 防伪：这条管线写的是「主人亲口说的话」——记录、记忆、语气样本全当真。
     * 我 10-31 23:42 拿它做端到端验证，一句「盯着我刷行测，今天要学到一点」就被当成了他的约定，
     * 她抱着这个没发生过的约定过了一夜。以后测试一律带 probe=1，落进数据的文本自带
     * 〔测试注入〕前缀，tools/purge-probe.js 一键能清干净。 */
    if (String(body.probe || '') === '1' || /[?&]probe=1\b/.test(String(req.url || ''))) {
      text = '〔测试注入〕' + text
    }
    const r = await BR.send(text, [])
    if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error || '她没答上来' })
    const tts = await BR.ttsSpeak(r.content)
    return sendJson(res, 200, { ok: true, reply: r.content, display: r.display || r.content, audio: audioPayload(tts) })
  }

  return sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
}

/* ---------------- 手机页面 ---------------- */

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>她 · 随身</title>
<style>
  html,body{margin:0;height:100%;background:#0f1115;color:#e8e6e0;font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;
    display:flex;flex-direction:column;overflow:hidden;-webkit-tap-highlight-color:transparent}
  #her{position:fixed;inset:0;z-index:0;display:flex;align-items:flex-end;justify-content:center;background:#0f1115}
  #her img{width:100%;height:100%;object-fit:cover;background:transparent}
  #touch{position:absolute;inset:0}
  #chat{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;justify-content:flex-end;min-height:0;
    pointer-events:none} /* 全屏容器不能挡住下面的触摸层，交互只留给具体控件 */
  #grip,#bar{pointer-events:auto}
  #msgs{flex:none;height:44vh;overflow-y:auto;padding:10px 14px;background:transparent;pointer-events:none}
  #grip{height:20px;display:flex;align-items:center;justify-content:center;touch-action:none;cursor:ns-resize}
  #grip::before{content:'';width:46px;height:4px;border-radius:2px;background:rgba(255,255,255,.35)}
  .m{max-width:86%;padding:8px 12px;border-radius:14px;margin-bottom:8px;word-break:break-word}
  .me{background:#2b4a7a;margin-left:auto}
  .her{background:#26292f}
  .sys{color:#8b8f98;font-size:12px;text-align:center;margin:4px 0}
  #bar{display:flex;gap:8px;padding:8px 10px calc(8px + env(safe-area-inset-bottom));background:rgba(23,26,32,.72)}
  #txt{flex:1;background:#22262d;border:1px solid #333842;color:#e8e6e0;border-radius:18px;padding:9px 14px;font-size:15px;outline:none}
  button{background:#2b4a7a;color:#fff;border:0;border-radius:50%;width:44px;height:44px;font-size:20px;flex:none}
  button:active{filter:brightness(1.2)}
  #mic.rec{background:#a33}
  #cam{background:#2f6e4f}
  #status{font-size:11px;color:#8b8f98;text-align:center;padding:2px 0}
</style></head><body>
<div id="her"><div id="herbox" style="position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center"></div></div>
<div id="chat">
  <div id="grip" title="拖动调整聊天区高度"></div>
  <div id="msgs"></div>
  <div id="status">连接中…</div>
  <div id="bar">
    <button id="cam" title="让她看">📷</button>
    <input id="txt" placeholder="跟她说点什么…"/>
    <button id="send">➤</button>
    <button id="mic" title="按住说话">🎤</button>
  </div>
</div>
<script>
var TOKEN = '__TOKEN__'
var api = function (path, body) {
  return fetch(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-token': TOKEN },
    body: JSON.stringify(body || {}) })
    .then(function (r) { return r.json() })
}
var msgs = document.getElementById('msgs'), statusEl = document.getElementById('status')
function addMsg (cls, text) {
  var d = document.createElement('div'); d.className = 'm ' + cls; d.textContent = text
  msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight
  return d
}
function playAudio (a) {
  if (!a || !a.b64) return
  try {
    var bin = atob(a.b64), arr = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    var u = URL.createObjectURL(new Blob([arr], { type: a.mime }))
    new Audio(u).play().catch(function () {})
  } catch (e) {}
}
var busy = false
function ask (path, body, hold) {
  if (busy) return Promise.resolve()
  busy = true; statusEl.textContent = '她在想…'
  var my = addMsg('me', hold || '…')
  return api(path, body).then(function (r) {
    if (!r.ok) { my.textContent = hold || '(发送失败)'; addMsg('sys', r.error || '失败了，再试一次？'); return }
    if (r.text) my.textContent = r.text; else my.textContent = hold
    if (r.reply) addMsg('her', r.display || r.reply)
    playAudio(r.audio)
  }).catch(function () { addMsg('sys', '网络不通了') })
    .finally(function () { busy = false; statusEl.textContent = '已连接 · ' + (STATE_NAME || '') })
}
var STATE_NAME = ''
var herReady = false // 形象流注入过就不再重复（OBS 后开也能自动出现）
var statusTimer = null
function loadStatus () {
  fetch('/api/status?t=' + TOKEN).then(function (r) { return r.json() }).then(function (s) {
  STATE_NAME = s.charName || ''
  statusEl.textContent = '已连接 · ' + STATE_NAME
  if (!s.tsIp) statusEl.textContent += '（注意：电脑上没检测到 Tailscale，出门就连不上了）'
  /* 她的形象：复用 OBS 画面导出那路流（同一台电脑、同一个 hostname，端口不同）。
     OBS 后开也没关系：拿不到 obsPort 就每 5 秒重查，一开形象自动出现 */
  if (s.obsPort) {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
    if (herReady) return
    herReady = true
    var box = document.getElementById('herbox')
    /* 不再嵌 OBS 的 iframe——它内部 fetch('/frame') 是绝对路径，在 /obs/ 代理下会打到自家服务上 401。
       手机页自己拉 /obs/frame（同源代理，跟随 http/https），双缓冲换 src 防闪 */
    box.innerHTML = '<img id="herimg" alt="" style="width:100%;height:100%;object-fit:cover;background:transparent">' +
      '<div id="touch" style="position:absolute;inset:0"></div>'
    var herImg = document.getElementById('herimg')
    /* 拉帧：fetch→blob→离屏解码完再换 src。
       旧写法（新 URL 直接赋给 img.src）会在加载瞬间清空画面 → 背景一闪一闪，且每帧实际请求两次。
       帧率/画质/分辨率跟随电脑端设置（streamFps/streamQ/streamH） */
    var SFPS = Math.max(1, Math.min(30, Number(s.streamFps) || 10))
    var SQ = Math.max(40, Math.min(95, Number(s.streamQ) || 75))
    var SH = Number(s.streamH) || 0
    var frameMs = Math.max(33, Math.round(1000 / SFPS))
    ;(function pull () {
      var t0 = Date.now()
      fetch('/obs/frame?fmt=jpg&q=' + SQ + '&h=' + SH + '&t=' + TOKEN, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.blob() : null })
        .then(function (b) {
          if (!b) { setTimeout(pull, 800); return }
          var url = URL.createObjectURL(b)
          var im = new Image()
          im.onload = function () {
            var old = herImg.src
            herImg.src = url
            if (old && old.indexOf('blob:') === 0) { try { URL.revokeObjectURL(old) } catch (e) {} }
            setTimeout(pull, Math.max(0, frameMs - (Date.now() - t0)))
          }
          im.onerror = function () { try { URL.revokeObjectURL(url) } catch (e) {} ; setTimeout(pull, 1000) }
          im.src = url
        })
        .catch(function () { setTimeout(pull, 1200) })
    })()
    bindTouch()
  } else if (!herReady) {
    if (!statusTimer) {
      addMsg('sys', '（把电脑设置里的「OBS 画面导出」打开，这里就能看到她、摸到她——开着的话 5 秒内会自动出现）')
      statusTimer = setInterval(loadStatus, 5000)
    }
  }
  /* 摄像头/麦克风只有受信任的 https 才能用（浏览器安全规定）：
     优先给 ts.net 真证书入口（无任何警告），退而求其次给自签 https（首次要点「继续前往」，部分浏览器仍会拦摄像头） */
  var needTls = !location.origin.startsWith('https') || (s.tsFqdn && location.hostname !== s.tsFqdn)
  if (needTls && !window.__tlsHinted && (s.tsFqdn || s.tlsPort)) {
    window.__tlsHinted = true
    var a = document.createElement('div'); a.className = 'm sys'
    var link = document.createElement('a')
    if (s.tsFqdn) {
      link.href = 'https://' + s.tsFqdn + '/?t=' + TOKEN
      link.textContent = '① 点这里换到正式证书入口（语音/摄像头都能用，无任何警告）'
    } else {
      link.href = 'https://' + location.hostname + ':' + s.tlsPort + '/?t=' + TOKEN
      link.textContent = '① 点这里切换到语音/摄像头可用的入口（首次会提示证书风险：点「高级」→「继续前往」）'
    }
    link.style.color = '#7ab0ff'
    a.appendChild(link); msgs.appendChild(a); msgs.scrollTop = msgs.scrollHeight
  }
}).catch(function () { statusEl.textContent = '连不上电脑'; if (!herReady) setTimeout(loadStatus, 5000) })
}
loadStatus()
addMsg('sys', '（长按 📷 可切换前/后摄像头，拖动上面的横条可调整聊天区高度）')
/* 聊天区高度拖拽：抓住 grip 上下拉，记住偏好 */
var grip = document.getElementById('grip')
var gdrag = null
function applyMsgsH (h) {
  var max = window.innerHeight * 0.82 - 110
  var min = window.innerHeight * 0.14
  h = Math.max(min, Math.min(max, h))
  document.getElementById('msgs').style.height = h + 'px'
  return h
}
try {
  var savedMsgsH = Number(localStorage.getItem('ryzaMsgsH'))
  if (savedMsgsH > 0) applyMsgsH(savedMsgsH)
} catch (e) { }
grip.addEventListener('pointerdown', function (e) {
  gdrag = { y: e.clientY, h: document.getElementById('msgs').getBoundingClientRect().height }
  try { grip.setPointerCapture(e.pointerId) } catch (e2) { }
})
grip.addEventListener('pointermove', function (e) {
  if (!gdrag) return
  applyMsgsH(gdrag.h - (e.clientY - gdrag.y))
})
grip.addEventListener('pointerup', function () {
  if (!gdrag) return
  gdrag = null
  try { localStorage.setItem('ryzaMsgsH', String(document.getElementById('msgs').getBoundingClientRect().height)) } catch (e) { }
})
document.getElementById('send').onclick = function () {
  var t = document.getElementById('txt'); var v = t.value.trim()
  if (!v) return; t.value = ''; ask('/api/say', { text: v }, v)
}
document.getElementById('txt').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('send').click()
})
/* 触摸层：摸她的头/身体 —— 事件进同一套情绪账本 */
function bindTouch () {
  var touch = document.getElementById('touch')
  if (!touch) return
  var lastTap = 0
  touch.addEventListener('pointerup', function (e) {
    var now = Date.now()
    if (now - lastTap < 250) return
    lastTap = now
    var r = touch.getBoundingClientRect()
    var part = (e.clientY - r.top) < r.height * 0.38 ? 'head' : 'body'
    api('/api/touch', { part: part }).then(function (res) {
      /* 电脑那边她会反应（气泡/动作）；手机上先给个即时反馈 */
      addMsg('sys', part === 'head' ? '（你摸了摸她的头）' : '（你碰了碰她）')
    }).catch(function () { addMsg('sys', '没摸到——网络不通了') })
  })
}
/* 按住说话 */
var mic = document.getElementById('mic'), rec = null, chunks = []
mic.addEventListener('pointerdown', function () {
  if (busy) return
  if (!navigator.mediaDevices || !window.MediaRecorder) { addMsg('sys', 'http 页面给不了麦克风——用上面那条 https 链接重新打开'); return }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    chunks = []
    rec = new MediaRecorder(stream)
    rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data) }
    rec.onstop = function () {
      stream.getTracks().forEach(function (t) { t.stop() })
      mic.classList.remove('rec')
      if (!chunks.length) return
      var blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' })
      var fr = new FileReader()
      fr.onload = function () { ask('/api/voice', { audio: fr.result }, '（语音）') }
      fr.readAsDataURL(blob)
    }
    rec.start(); mic.classList.add('rec')
  }).catch(function (err) {
    var name = (err && err.name) || ''
    var msg
    if (window.isSecureContext === false) msg = '麦克风在这个入口不受浏览器信任——用上面的 ts.net 链接打开就能说了'
    else if (name === 'NotAllowedError') msg = '麦克风被浏览器拒了——点地址栏左边的 🔒/ⓘ →「权限」→「麦克风」改成允许，再按一次 🎤'
    else if (name === 'NotReadableError') msg = '麦克风被别的 App 占用中，关掉再按 🎤'
    else msg = '麦克风开不了（' + (name || '未知原因') + '）'
    addMsg('sys', msg)
  })
})
mic.addEventListener('pointerup', function () { try { if (rec && rec.state !== 'inactive') rec.stop() } catch (e) {} })
mic.addEventListener('pointerleave', function () { try { if (rec && rec.state !== 'inactive') rec.stop() } catch (e) {} })
/* 让她看 */
var facing = 'environment'
document.getElementById('cam').onclick = function () {
  if (busy) return
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { addMsg('sys', 'http 页面开不了摄像头——用上面那条 https 链接重新打开'); return }
  busy = true; statusEl.textContent = '眨眨眼…'
  var openCam = function (constraints) {
    return navigator.mediaDevices.getUserMedia(constraints)
  }
  openCam({ video: { facingMode: facing, width: { ideal: 1280 } } })
    .catch(function (err) {
      /* 指定摄像头在个别机型上会 OverconstrainedError——退回默认摄像头再试一次 */
      if ((err && err.name === 'OverconstrainedError') || (err && err.name === 'NotFoundError')) return openCam({ video: true })
      throw err
    })
    .then(function (stream) {
      var v = document.createElement('video')
      v.srcObject = stream; v.muted = true
      return v.play().then(function () { return new Promise(function (ok) { setTimeout(ok, 600) }) }).then(function () { return { v: v, stream: stream } })
    })
    .then(function (r) {
      var v = r.v, stream = r.stream
      var c = document.createElement('canvas')
      c.width = v.videoWidth || 1280; c.height = v.videoHeight || 720
      c.getContext('2d').drawImage(v, 0, 0)
      stream.getTracks().forEach(function (t) { t.stop() })
      var dataUrl = c.toDataURL('image/jpeg', 0.72)
      busy = false
      return ask('/api/see', { image: dataUrl }, '（让她看了看眼前）')
    })
    .catch(function (err) {
      busy = false
      var name = (err && err.name) || ''
      var msg
      if (window.isSecureContext === false) msg = '这个入口不受浏览器信任（自签证书），摄像头会被拦——用上面的 ts.net 链接打开就能拍了'
      else if (name === 'NotAllowedError') msg = '摄像头被浏览器拒了——点地址栏左边的 🔒/ⓘ →「权限」→「相机」改成允许，再点一次 👁（之前拒绝过一次就会被记住）'
      else if (name === 'NotReadableError') msg = '摄像头被别的 App 占用中，关掉占用的应用再点一次 👁'
      else if (name) msg = '摄像头开不了（' + name + (err && err.message ? '：' + err.message : '') + '）'
      else msg = '摄像头开不了（浏览器没说原因，通常是权限被记住了——点地址栏 🔒/ⓘ 查相机权限）'
      addMsg('sys', msg)
    })
}
/* 长按 📷 切换前/后摄像头（手机浏览器长按会触发 contextmenu） */
document.getElementById('cam').addEventListener('contextmenu', function (e) {
  e.preventDefault()
  facing = facing === 'environment' ? 'user' : 'environment'
  addMsg('sys', '已切换到「' + (facing === 'environment' ? '后置' : '前置') + '」摄像头，点一下 📷 拍照')
})
</script></body></html>`

function pageHtml () {
  return PAGE.replace('__TOKEN__', STATE.token)
}

function handle (req, res) {
  STATE.reqCount++
  let urlObj
  try { urlObj = new URL(req.url, 'http://x') } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }) }
  if (urlObj.pathname === '/' && req.method === 'GET') {
    if (!checkToken(req, urlObj)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('需要口令：在电脑设置里复制「随身服务」的访问口令，加到网址后面 ?t=口令')
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(pageHtml())
  }
  if (!checkToken(req, urlObj)) return sendJson(res, 401, { ok: false, error: '口令不对' })
  // OBS 同源代理（iframe 用；鉴权靠 ?t=）
  if (/^\/obs(\/|$)/.test(urlObj.pathname)) return proxyObs(req, res, urlObj)
  handleApi(req, res, urlObj).catch((err) => {
    log('api 失败: ' + (err && err.message))
    try { sendJson(res, 500, { ok: false, error: err && err.message }) } catch { }
  })
}

/** 启动。bridges: {cfgGet, cfgSet, send, transcribe, ttsSpeak, touch, statusInfo, obsPort, log} */
function start (bridges) {
  BR = bridges || BR
  if (!BR || typeof BR.send !== 'function') return { ok: false, error: 'bridges 未注入' }
  if (STATE.running) return { ok: true, port: STATE.port, tsIp: STATE.tsIp }
  // 口令：cfg 里没有就生成一个并落盘（cfgSet 由 companion 提供，写 companion 配置）
  let cfg = BR.cfgGet() || {}
  STATE.token = String(cfg.remoteToken || '')
  if (!STATE.token) {
    STATE.token = crypto.randomBytes(16).toString('hex')
    try { BR.cfgSet({ remoteToken: STATE.token }) } catch (e) { return { ok: false, error: '口令写不进配置: ' + e.message } }
  }
  STATE.tsIp = detectTailscaleIp()
  const wanted = Number(cfg.remotePort) || 8720
  STATE.wantedPort = wanted
  let port = wanted
  const tryListen = (host, p) => new Promise((done) => {
    const s = http.createServer(handle)
    s.on('error', () => done(null))
    s.listen(p, host, () => { STATE.servers.push(s); done(p) })
  })
  return (async () => {
    // 主口（本机回环）：被占就从 wanted+1 顺延找 10 个
    let actual = await tryListen('127.0.0.1', port)
    if (!actual) {
      for (let q = wanted + 1; q <= wanted + 10 && !actual; q++) actual = await tryListen('127.0.0.1', q)
    }
    if (!actual) { STATE.lastError = '端口都被占用'; return { ok: false, error: STATE.lastError } }
    STATE.hosts.push('127.0.0.1')
    // 副口（Tailscale）：跟主口同一个端口，网卡没在就不绑
    if (STATE.tsIp) {
      const p2 = await tryListen(STATE.tsIp, actual)
      if (p2) STATE.hosts.push(STATE.tsIp)
      else log('Tailscale 地址 ' + STATE.tsIp + ' 绑定失败（不影响本机使用）')
    }
    STATE.port = actual
    STATE.running = true
    STATE.startedAt = Date.now()
    // HTTPS 副口（主口 +1）：摄像头/麦克风只在 https 下能用；证书生成失败就只留 http
    let tlsPort = 0
    try {
      const cert = await ensureCert(STATE.tsIp)
      if (cert) {
        const tryListenTls = (host, p) => new Promise((done) => {
          const s = https.createServer(cert, handle)
          s.on('error', () => done(null))
          s.listen(p, host, () => { STATE.servers.push(s); done(p) })
        })
        let tp = await tryListenTls('127.0.0.1', actual + 1)
        for (let q = actual + 2; q <= actual + 5 && !tp; q++) tp = await tryListenTls('127.0.0.1', q)
        if (tp && STATE.tsIp) await tryListenTls(STATE.tsIp, tp)
        tlsPort = tp || 0
      }
    } catch (e) { log('HTTPS 起不来（不影响 http 使用）: ' + (e && e.message)) }
    STATE.tlsPort = tlsPort
    // Tailscale 真证书入口：ts.net 域名 + Let's Encrypt，浏览器完全信任（摄像头/麦克风不拦）
    // 只在宿主显式开启（companion 传 tailscaleServe:true）时才动系统 tailscale，测试环境不碰
    if (STATE.tsIp && BR.tailscaleServe) setupTailscaleServe(STATE.port)
    const where = STATE.hosts.includes(STATE.tsIp) ? ` 与 http://${STATE.tsIp}:${STATE.port}/（手机用这个）` : '（未检测到 Tailscale，出门连不上）'
    log(`已启动 http://127.0.0.1:${STATE.port}/` + where + (tlsPort ? `；https://127.0.0.1:${tlsPort}/（说话/看镜头走这个）` : '；https 不可用'))
    return { ok: true, port: STATE.port, tlsPort, tsIp: STATE.tsIp, token: STATE.token }
  })()
}

function stop () {
  for (const s of STATE.servers) { try { s.close() } catch { } }
  STATE.servers = []
  STATE.running = false
  STATE.port = 0
  STATE.tlsPort = 0
  teardownTailscaleServe()
}

function status () {
  return {
    ok: true, running: STATE.running, port: STATE.port, wantedPort: STATE.wantedPort, tlsPort: STATE.tlsPort, tsIp: STATE.tsIp, tsFqdn: STATE.tsFqdn,
    hosts: STATE.hosts, lastError: STATE.lastError, reqCount: STATE.reqCount,
    hasToken: !!STATE.token
  }
}

module.exports = { start, stop, status, detectTailscaleIp, checkToken, audioPayload }
