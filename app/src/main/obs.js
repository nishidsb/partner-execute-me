'use strict'
/**
 * OBS 画面导出（0.19.0）
 *
 * 目标：OBS「浏览器源」填一个本地地址就能拿到透明背景的桌宠画面。
 *
 * 实现选择（2026-10-26 实测后定）：**不新开渲染窗口**，直接定时抓现有桌面层窗口的帧。
 * 实测结论（Electron 32）：
 *   · 透明窗口 capturePage() 保留 alpha —— 空白区 a=0，所以导出的 PNG 天然带透明
 *   · 隐藏/被遮挡窗口里 setInterval 驱动的 WebGL 仍在跑，capturePage 能拿到新帧
 * 复用可见窗口的好处是「所见即所播」：气泡、动作、缩放全都和屏幕上一致，
 * 也不需要维护第二套渲染逻辑（项目铁律：别两处各做一套）。
 *
 * 帧的传输走「HTTP 拉取」而不是 WebSocket：零依赖，OBS 的 Chromium 只要 <img> 换 src。
 * 页面自己按 fps 循环拉 /frame，服务端只在有客户端时才截图（没人看就不烧 CPU）。
 */
const http = require('node:http')

const STATE = {
  server: null,
  extraServers: [],
  port: 0,
  fps: 10,
  timer: null,
  latest: null,
  latestAt: 0,
  clients: 0,
  waiters: [],
  getWebContents: null,
  log: () => {},
  running: false,
  wantedPort: 0,
  lastError: '',
  busy: false,
  mode: '',
  capLast: 0,
  capAvg: 0,
  capCount: 0
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Partner.execute(me); · OBS</title>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}
  #wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
  #a,#b{position:absolute;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;
        image-rendering:auto;opacity:0;transition:opacity 90ms linear}
  #a.on,#b.on{opacity:1}
</style></head>
<body><div id="wrap"><img id="a" alt=""><img id="b" alt=""></div>
<script>
  // 双缓冲交替，避免每帧换 src 时闪一下
  var FPS = __FPS__
  var a = document.getElementById('a'), b = document.getElementById('b')
  var front = a, back = b, cur = ''
  var fails = 0
  async function loop () {
    for (;;) {
      try {
        var r = await fetch('/frame', { cache: 'no-store' })
        if (!r.ok) throw new Error('http ' + r.status)
        var blob = await r.blob()
        var url = URL.createObjectURL(blob)
        back.src = url
        if (back.decode) { try { await back.decode() } catch (e) {} }
        back.classList.add('on'); front.classList.remove('on')
        var t = front; front = back; back = t
        if (cur) URL.revokeObjectURL(cur)
        cur = url
        fails = 0
      } catch (e) {
        fails++
      }
      await new Promise(function (r) { setTimeout(r, Math.max(60, 1000 / FPS)) })
    }
  }
  loop()
</script></body></html>`

function pageHtml (fps) {
  return PAGE.replace('__FPS__', String(fps || 10))
}

function resolveWaiters (buf) {
  const list = STATE.waiters
  STATE.waiters = []
  for (const w of list) {
    try { w(buf) } catch {}
  }
}

/** 抓一帧（只在有人看的时候抓）。
 *  0.24.0 补丁㉕：capturePage 对透明窗口要做整窗合成回读，实测约 500ms/帧 → 服务端只有
 *  2fps（手机端卡顿根因）。改为优先走渲染层快帧通道：executeJavaScript 调
 *  window.__ryzaObsFrame() 直接导出角色 2D 画布（内容常驻，PNG 走 base64），只回读
 *  角色本身，不回读整窗。渲染层没有钩子/失败时回退 capturePage。
 *  另加 busy 门闩：上一次取帧没回来之前不再叠加新请求（旧实现 33ms 定时器会堆一层
 *  capturePage 并发，越堆越慢）。 */
function grab () {
  STATE.invoked = (STATE.invoked || 0) + 1
  if (!STATE.running) return
  if (STATE.busy) { STATE.skipBusy = (STATE.skipBusy || 0) + 1; return }
  const active = STATE.clients > 0 || STATE.waiters.length > 0 ||
    Date.now() - (STATE.lastClientAt || 0) < 1500
  if (!active) { STATE.skipIdle = (STATE.skipIdle || 0) + 1; return }
  const wc = STATE.getWebContents && STATE.getWebContents()
  if (!wc || wc.isDestroyed()) return
  STATE.busy = true
  const t0 = Date.now()
  const finish = (img, png, fromCanvas) => {
    STATE.busy = false
    STATE.capLast = Date.now() - t0
    STATE.capAvg = STATE.capAvg ? STATE.capAvg * 0.9 + STATE.capLast * 0.1 : STATE.capLast
    if (fromCanvas !== undefined) STATE.mode = fromCanvas ? 'canvas' : 'capturePage'
    STATE.capCount = (STATE.capCount || 0) + 1
    if (STATE.capCount % 150 === 0) {
      STATE.log('[obs] 取帧 ' + (STATE.mode || '?') + ' 平均 ' + Math.round(STATE.capAvg) + 'ms/帧（目标 ' + Math.round(1000 / STATE.fps) + 'ms）')
    }
    if (!img) return
    const sz = img.getSize()
    if (!sz.width || !sz.height) return
    let out = img
    let outPng = png || null
    /* 手机随身页要满屏角色：getRegion() 返回围绕角色的竖屏区域（DIP，frameW=窗口内容宽），
       在这里按窗口→像素比例裁剪。任何异常都回退整帧。画布模式下整个画布就是角色，无需裁剪 */
    if (!fromCanvas) {
      try {
        const reg = STATE.getRegion && STATE.getRegion()
        if (reg && reg.width >= 16 && reg.height >= 16 && reg.frameW > 0) {
          const f = sz.width / reg.frameW
          const r = {
            x: Math.round(reg.x * f), y: Math.round(reg.y * f),
            width: Math.round(reg.width * f), height: Math.round(reg.height * f)
          }
          if (r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 &&
              r.x + r.width <= sz.width && r.y + r.height <= sz.height) { out = img.crop(r); outPng = null }
        }
      } catch (e) { STATE.log && STATE.log('[obs] 裁剪失败回退整帧: ' + e.message) }
    }
    /* 角色画布（WebGL）没开 preserveDrawingBuffer，capturePage 会时不时抓到「刚清空的画布」
       ——几乎全透明的空帧，手机/直播画面就一闪一闪。用 PNG 体积识别空帧，保住上一张好帧 */
    if (!outPng) outPng = out.toPNG()
    if (outPng.length < 30 * 1024 && STATE.goodImg) {
      resolveWaiters(STATE.goodImg)
      return
    }
    /* 内容变化计数：完成的抓帧里有多少真的带来了新画面（区分「抓得少」和「抓得多但画面没变」） */
    if (!STATE.lastPngHash || !outPng.equals(STATE.lastPngHash)) {
      STATE.pngChanged = (STATE.pngChanged || 0) + 1
      STATE.lastPngHash = outPng
    }
    STATE.goodImg = out
    STATE.goodPng = outPng
    STATE.latestAt = Date.now()
    resolveWaiters(out)
  }
  const viaCapturePage = () => {
    wc.capturePage().then((img) => finish(img, null, false)).catch((err) => {
      STATE.busy = false
      STATE.lastError = err && err.message
    })
  }
  /* 每 60 帧把渲染层诊断拖回来打一行：steps 对墙上时间求导=渲染循环真实帧率，
     hidden/vis=页面是否被判隐藏（区分「渲染循环被节流」和「抓错窗口」） */
  if (STATE.capCount % 60 === 1) {
    try {
      wc.executeJavaScript('window.__ryzaDiag ? window.__ryzaDiag() : null', true)
        .then((d) => { if (d) STATE.log('[obs] diag ' + JSON.stringify(d)) }).catch(() => { })
    } catch { }
  }
  let p = null
  try { p = wc.executeJavaScript('window.__ryzaObsFrame ? window.__ryzaObsFrame() : null', true) } catch { p = null }
  if (p && typeof p.then === 'function') {
    p.then((url) => {
      if (typeof url === 'string' && url.slice(0, 22) === 'data:image/png;base64,') {
        try {
          const { nativeImage } = require('electron')
          const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
          finish(nativeImage.createFromDataURL(url), png, true)
        } catch (e) {
          STATE.lastError = e && e.message
          viaCapturePage()
        }
      } else {
        viaCapturePage() // 渲染层还没有钩子（角色加载中/旧页面）→ 走老路
      }
    }).catch((err) => {
      STATE.lastError = err && err.message
      viaCapturePage()
    })
  } else {
    viaCapturePage()
  }
}

function schedule () {
  if (STATE.timer) clearInterval(STATE.timer)
  const ms = Math.max(33, Math.round(1000 / Math.max(1, Math.min(30, STATE.fps))))
  STATE.timer = setInterval(grab, ms)
  if (STATE.timer.unref) STATE.timer.unref()
}

function send (res, code, type, body) {
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  })
  res.end(body)
}

function handle (req, res) {
  const u = new URL(req.url, 'http://127.0.0.1')
  if (u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', pageHtml(STATE.fps))
  if (u.pathname === '/health') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      ok: true, fps: STATE.fps, clients: STATE.clients, lastFrameAgoMs: STATE.latestAt ? Date.now() - STATE.latestAt : -1,
      mode: STATE.mode, capMs: Math.round(STATE.capAvg || 0),
      invoked: STATE.invoked || 0, skipBusy: STATE.skipBusy || 0, skipIdle: STATE.skipIdle || 0,
      grabs: STATE.capCount || 0, pngChanged: STATE.pngChanged || 0, busyNow: !!STATE.busy
    }))
  }
  if (u.pathname === '/act') {
    // 0.45.86 诊断点播：/act?name=鼓掌 → pet_act(manual) 直接播 motions/ 里的同名 VRMA。
    // 只绑 127.0.0.1 的诊断口，跟 /frame 同级；动作闸用 manual 豁免（点播就要响）。
    const name = String((u.searchParams && u.searchParams.get('name')) || '').trim()
    if (!name) return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '缺 name 参数（如 /act?name=鼓掌）' }))
    try {
      const r = require('./petBridge').invoke('pet_act', { actions: [name], manual: true })
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, name, r }))
    } catch (e) {
      return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: e && e.message }))
    }
  }
  if (u.pathname === '/frame') {
    const sp = u.searchParams
    const wantJpg = sp && sp.get('fmt') === 'jpg'
    const q = Math.max(40, Math.min(95, Number(sp && sp.get('q')) || 75))
    const hWanted = Number(sp && sp.get('h')) || 0 // 0 = 原画
    /* 0.24.0 补丁㉕关键修复：拉流客户端是「请求→等→换图→间隔」的轮询节奏，两次请求
       之间有空档；旧逻辑只认「此刻有没有请求在途」，定时器 92% 落在空档里被当没人看
       跳过 → 30fps 设置实际只出 ~2fps。改为：1.5s 内来过请求就算「观看中」，持续抓帧 */
    STATE.lastClientAt = Date.now()
    const encode = (img) => {
      if (!img) return null
      if (!wantJpg) return img === STATE.goodImg ? STATE.goodPng : img.toPNG()
      try {
        // 同一帧 + 同参数直接给缓存的 JPEG（30fps 轮询时主进程几乎零编码开销）
        const pngRef = img === STATE.goodImg ? STATE.goodPng : null
        const c = STATE.jpgCache
        if (pngRef && c && c.q === q && c.h === hWanted && c.png === pngRef) return c.buf
        let j = img
        const s = img.getSize()
        if (hWanted > 0 && s.height > hWanted) j = img.resize({ height: hWanted, quality: 'better' })
        const buf = j.toJPEG(q)
        if (pngRef) STATE.jpgCache = { q, h: hWanted, png: pngRef, buf }
        return buf
      } catch { return null }
    }
    STATE.clients++
    let done = false
    const finish = (img) => {
      if (done) return
      done = true
      STATE.clients = Math.max(0, STATE.clients - 1)
      const buf = encode(img)
      if (buf) send(res, 200, wantJpg ? 'image/jpeg' : 'image/png', buf)
      else send(res, 503, 'text/plain; charset=utf-8', 'no frame')
    }
    // 有现成帧且不算太旧就立刻给，否则等下一帧（最多 900ms，别把 OBS 拖死）
    if (STATE.goodImg && Date.now() - STATE.latestAt < 400) return finish(STATE.goodImg)
    STATE.waiters.push(finish)
    const to = setTimeout(() => finish(STATE.goodImg && Date.now() - STATE.latestAt < 2000 ? STATE.goodImg : null), 900)
    if (to.unref) to.unref()
    res.on('close', () => {
      // finish 已经扣过 clients 就别再扣（旧实现双重递减把 clients 拖到 0，抓帧被判没人看）
      if (!done) { done = true; STATE.clients = Math.max(0, STATE.clients - 1) }
    })
    return
  }
  send(res, 404, 'text/plain; charset=utf-8', 'not found')
}

/**
 * @param {{port?:number, fps?:number, getWebContents:()=>any, log?:Function}} opts
 * @returns {Promise<{ok:boolean, port?:number, error?:string}>}
 */
function start (opts) {
  return new Promise((resolve) => {
    stop()
    STATE.fps = Math.max(1, Math.min(30, Number(opts.fps) || 10))
    STATE.getWebContents = opts.getWebContents
    STATE.getRegion = opts.getRegion || null
    STATE.log = opts.log || (() => {})
    const wanted = Number(opts.port) || 8712
    STATE.wantedPort = wanted
    let port = wanted
    let tries = 0

    const tryListen = () => {
      const server = http.createServer(handle)
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && tries < 12) {
          tries++
          port++
          try { server.close() } catch {}
          return tryListen()
        }
        STATE.lastError = err && err.message
        STATE.log('[obs] 启动失败: ' + STATE.lastError)
        try { server.close() } catch {}
        resolve({ ok: false, error: STATE.lastError })
      })
      server.listen(port, '127.0.0.1', () => {
        STATE.server = server
        STATE.port = port
        STATE.running = true
        STATE.goodImg = null
        STATE.goodPng = null
        STATE.latestAt = 0
        STATE.busy = false
        STATE.mode = ''
        STATE.capLast = 0
        STATE.capAvg = 0
        STATE.capCount = 0
        STATE.invoked = 0
        STATE.skipBusy = 0
        STATE.skipIdle = 0
        STATE.pngChanged = 0
        STATE.lastPngHash = null
        STATE.lastClientAt = 0
        STATE.jpgCache = null
        schedule()
        STATE.log('[obs] 已启动 http://127.0.0.1:' + port + '/ fps=' + STATE.fps +
          (port !== wanted ? '（端口 ' + wanted + ' 被占用，顺延）' : ''))
        // 0.24.0 随身服务：手机页面要内嵌这路画面流 → 同端口再绑 Tailscale 网卡。
        // 该网卡只在用户自己的 tailnet 内可达（比局域网还小），画面本身也没有隐私内容。
        try {
          const ifs = require('node:os').networkInterfaces()
          for (const [name, addrs] of Object.entries(ifs)) {
            if (!/tailscale/i.test(name)) continue
            for (const a of addrs || []) {
              if (a.family !== 'IPv4' || a.internal) continue
              const s2 = http.createServer(handle)
              s2.on('error', () => { })
              s2.listen(port, a.address, () => {
                STATE.extraServers.push(s2)
                STATE.log('[obs] 已同步监听 http://' + a.address + ':' + port + '/（Tailscale，手机可见）')
              })
              break
            }
            break
          }
        } catch { }
        resolve({ ok: true, port })
      })
    }
    tryListen()
  })
}

function stop () {
  if (STATE.timer) { clearInterval(STATE.timer); STATE.timer = null }
  STATE.running = false
  STATE.goodImg = null
  STATE.goodPng = null
  STATE.latestAt = 0
  STATE.busy = false
  STATE.mode = ''
  STATE.capLast = 0
  STATE.capAvg = 0
  STATE.capCount = 0
        STATE.invoked = 0
        STATE.skipBusy = 0
        STATE.skipIdle = 0
        STATE.pngChanged = 0
        STATE.lastPngHash = null
        STATE.lastClientAt = 0
        STATE.jpgCache = null
  resolveWaiters(null)
  for (const s of STATE.extraServers || []) { try { s.close() } catch {} }
  STATE.extraServers = []
  if (STATE.server) {
    try { STATE.server.close() } catch {}
    STATE.server = null
    STATE.log('[obs] 已停止')
  }
  STATE.port = 0
  STATE.clients = 0
}

function status () {
  return {
    running: STATE.running,
    port: STATE.port,
    wantedPort: STATE.wantedPort,
    url: STATE.running ? 'http://127.0.0.1:' + STATE.port + '/' : '',
    fps: STATE.fps,
    clients: STATE.clients,
    lastFrameAgoMs: STATE.latestAt ? Date.now() - STATE.latestAt : -1,
    mode: STATE.mode,
    capMs: Math.round(STATE.capAvg || 0),
    lastError: STATE.lastError
  }
}

module.exports = { start, stop, status, pageHtml }
