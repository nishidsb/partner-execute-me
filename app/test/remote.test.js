'use strict'
/**
 * 0.24.0 第 1 期出门方案 · 随身服务（remote）测试
 *  真起服务（127.0.0.1 高位端口）：口令校验 / 页面下发 / touch 桥 / say 桥全链路。
 *  Tailscale 外网联调留待手机接入（不虚空测试）。
 */
const test = require('node:test')
const assert = require('node:assert')
const remote = require('../src/main/remote')

function bridges (over = {}) {
  const calls = { touch: [], says: [] }
  return {
    calls,
    cfg: { remotePort: 48720 },
    b: {
      cfgGet: () => ({ ...over.cfgBase, remotePort: 48720 }),
      cfgSet: (p) => Object.assign(bridges.cfgStore = bridges.cfgStore || {}, p),
      send: async (text, images) => {
        calls.says.push({ text, images })
        return { ok: true, content: '嗯，听到啦', display: '嗯，听到啦' }
      },
      transcribe: async () => ({ ok: true, text: '（测试语音）' }),
      ttsSpeak: async () => ({ ok: false, fallback: true }),
      touch: (part) => calls.touch.push(part),
      statusInfo: () => ({ charName: '莱莎' }),
      log: () => { },
      ...over.bridges
    }
  }
}

test('起服务 → 页面要口令 → 带 token 全链路（touch/say）→ 停服', async () => {
  const { b, calls } = bridges()
  const started = await remote.start(b)
  assert.ok(started.ok, '启动要成功: ' + (started && started.error))
  assert.ok(started.token && started.token.length >= 24, '首次启动要自动生成口令')
  const port = started.port
  const base = `http://127.0.0.1:${port}`

  // 页面：无 token → 401；带 token → HTML 且内嵌 token
  const noAuth = await fetch(base + '/')
  assert.equal(noAuth.status, 401)
  const page = await fetch(base + '/?t=' + started.token)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.ok(html.includes(started.token), '页面要内嵌口令（手机填一次就能用）')
  assert.ok(html.includes('/api/touch'), '页面要有触摸层')

  // API：不带 token → 401
  const noTok = await fetch(base + '/api/say', { method: 'POST', body: '{}' })
  assert.equal(noTok.status, 401)

  // touch 桥
  const t1 = await fetch(base + '/api/touch?t=' + started.token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ part: 'head' })
  })
  const tj = await t1.json()
  assert.ok(tj.ok && calls.touch.includes('head'), 'touch 事件要进桥（并入桌面同一套情绪账本）')

  // say 桥：回复文本回传；TTS 失败时 audio=null 不炸
  const s1 = await fetch(base + '/api/say?x=1', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-token': started.token },
    body: JSON.stringify({ text: '在吗' })
  })
  const sj = await s1.json()
  assert.ok(sj.ok && sj.reply === '嗯，听到啦' && sj.audio === null, 'say 全链路要通')

  // status
  const st = await (await fetch(base + '/api/status?t=' + started.token)).json()
  assert.ok(st.ok && st.charName === '莱莎')

  // 停服 → 端口关闭
  remote.stop()
  await new Promise((r) => setTimeout(r, 120))
  let down = false
  try { await fetch(base + '/api/status?t=' + started.token) } catch { down = true }
  assert.ok(down, '停服后端口要关掉')
})

test('cfgSet 生成口令要落盘（第二次 start 复用同一个口令）', async () => {
  const store = {}
  const b1 = bridges()
  b1.b.cfgSet = (p) => Object.assign(store, p)
  const s1 = await remote.start(b1.b)
  remote.stop()
  const b2 = bridges()
  b2.b.cfgGet = () => ({ remotePort: 48720, remoteToken: store.remoteToken })
  const s2 = await remote.start(b2.b)
  assert.equal(s2.token, store.remoteToken, '口令要复用，不每次换')
  remote.stop()
})

test('detectTailscaleIp：不炸、返回字符串', () => {
  assert.equal(typeof remote.detectTailscaleIp(), 'string')
})

test('手机点摸 → remoteTouchTap 走 pet:touch 广播（桌面角色播反应动作）', () => {
  const pet = require('../src/main/companion/pet')
  const seen = []
  pet.setBroadcast((ch, d) => seen.push([ch, d]))
  pet.remoteTouchTap('head')
  assert.deepEqual(seen[0], ['pet:touch', { kind: 'tap', part: 'head' }], '广播 payload 要带 kind=tap + part')
  pet.remoteTouchTap(undefined)
  assert.equal(seen[1][1].part, '', '空 part 要夹成空串，不能变 undefined')
})

test('audioPayload：file:// URL 读文件封装成 {mime,b64}；坏输入返回 null', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  assert.equal(remote.audioPayload(null), null)
  assert.equal(remote.audioPayload({ ok: false }), null)
  assert.equal(remote.audioPayload({ ok: true, url: 'file:///不存在的文件.wav' }), null)
  const f = path.join(os.tmpdir(), 'ryza-remote-test.wav')
  fs.writeFileSync(f, Buffer.from('RIFFffffWAVEfmt '))
  const p = remote.audioPayload({ ok: true, url: require('node:url').pathToFileURL(f).href })
  assert.ok(p && p.mime === 'audio/wav' && p.b64.length > 0)
  fs.rmSync(f, { force: true })
})

test('HTTPS 副口 + /obs 同源代理（摄像头/麦克风安全上下文）', async () => {
  const http = require('node:http')
  // 假 OBS：起个最小 http 服务当代理目标
  const obs = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<html>OBS-FAKE</html>') })
  await new Promise((ok) => obs.listen(48712, '127.0.0.1', ok))
  const os = require('node:os')
  const { b } = bridges({ bridges: { statusInfo: () => ({ charName: '莱莎', obsPort: 48712 }), certDir: os.tmpdir() } })
  const started = await remote.start(b)
  assert.ok(started.ok, '启动要成功')
  try {
    assert.ok(started.tlsPort >= started.port + 1, '要起 https 副口（主口+1 起）')
    const https = require('node:https')
    const get = (path) => new Promise((ok, bad) => {
      const q = https.get({ host: '127.0.0.1', port: started.tlsPort, path, rejectUnauthorized: false }, (s) => {
        let body = ''; s.on('data', (c) => { body += c }); s.on('end', () => ok({ code: s.statusCode, body }))
      })
      q.on('error', bad); q.setTimeout(4000, () => { q.destroy(); bad(new Error('timeout')) })
    })
    // 页面要能从 https 下发（iframe 提示只在 http 页出现，https 页不应包含）
    const page = await get('/?t=' + started.token)
    assert.equal(page.code, 200)
    assert.ok(page.body.includes('/obs/frame?fmt=jpg'), '页面要自己拉 /obs/frame 的 JPEG 流（体积小解码快）')
    // /obs 代理要把 OBS 页面原样带回来
    const proxied = await get('/obs/?t=' + started.token)
    assert.equal(proxied.code, 200)
    assert.ok(proxied.body.includes('OBS-FAKE'), '/obs/ 要代理到 OBS 页面')
    // /obs/frame 代理要把帧带回来
    const fr = await get('/obs/frame?t=' + started.token)
    assert.equal(fr.code, 200)
    assert.ok(fr.body.includes('OBS-FAKE'), '/obs/frame 要代理到 OBS 帧')
    // /api/status 带 tlsPort
    const st = await get('/api/status?t=' + started.token)
    assert.ok(JSON.parse(st.body).tlsPort === started.tlsPort, '/api/status 要带 tlsPort')
  } finally {
    remote.stop()
    obs.close()
  }
})
