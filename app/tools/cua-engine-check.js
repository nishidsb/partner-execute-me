/**
 * CUA 引擎端到端自检（不启 Electron）：
 *   node tools/cua-engine-check.js
 *
 * 只跑「只读」操作（ping / 桌面尺寸 / 光标 / 空闲 / 枚举窗口 / 截图），
 * **不会动你的鼠标键盘**，可以随时跑。
 * 退出码非 0 说明引擎在这台机器上不可用（安全软件拦截 / 不是 Windows / DLL 缺失）。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { fork } = require('child_process')

const enginePath = path.join(__dirname, '..', 'src', 'main', 'cua', 'engine.js')

let seq = 0
const pending = new Map()

const child = fork(enginePath, [], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  serialization: 'advanced'
})
child.stdout.on('data', (b) => { const s = String(b).trim(); if (s) console.log('[engine]', s.slice(0, 200)) })
child.stderr.on('data', (b) => { const s = String(b).trim(); if (s) console.log('[engine:err]', s.slice(0, 300)) })

child.on('message', (m) => {
  if (m && m.event === 'ready') { ready(); return }
  const p = pending.get(m && m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

function call (op, args = {}, ms = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const t = setTimeout(() => { pending.delete(id); reject(new Error('超时: ' + op)) }, ms)
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
    child.send({ id, op, args })
  })
}

let failed = 0
async function check (name, fn) {
  try {
    const r = await fn()
    console.log('OK   ' + name + (r === undefined ? '' : '  → ' + r))
  } catch (e) {
    failed++
    console.log('FAIL ' + name + '  → ' + (e && e.message))
  }
}

async function ready () {
  await check('引擎握手', async () => {
    const r = await call('ping')
    return 'pid=' + r.pid + ' koffi=' + r.koffi
  })
  await check('虚拟桌面', async () => {
    const m = await call('metrics')
    global.__m = m
    return `origin=${m.vx},${m.vy} size=${m.vw}x${m.vh} primary=${m.primaryW}x${m.primaryH}`
  })
  await check('光标位置', async () => {
    const c = await call('cursor')
    return `x=${c.x} y=${c.y}`
  })
  await check('用户空闲', async () => {
    const r = await call('idle')
    return r.idleMs + 'ms'
  })
  await check('枚举窗口', async () => {
    const list = await call('windows')
    if (!list.length) throw new Error('一个窗口都没枚举到')
    return list.length + ' 个，最前：' + list[0].title.slice(0, 24)
  })
  await check('全屏截图（缩放到 1280x800 内）', async () => {
    const s = await call('shot', { maxW: 1280, maxH: 800 })
    if (!s.buffer || s.buffer.length !== s.outW * s.outH * 4) throw new Error('像素数据大小不对')
    let nz = 0
    for (let i = 0; i < s.buffer.length; i += 4000) if (s.buffer[i]) nz++
    if (!nz) throw new Error('整张图全黑（BitBlt 没抓到内容）')
    const p = path.join(os.tmpdir(), 'ryza-cua-shot.png')
    try { fs.writeFileSync(p, s.buffer) } catch {}
    return `${s.outW}x${s.outH}（源 ${s.srcW}x${s.srcH}，scale ${s.scale.toFixed(3)}）非零抽样 ${nz}`
  })
  await check('局部截图（400x300）', async () => {
    const m = global.__m
    const s = await call('shot', { x: m.vx + 40, y: m.vy + 40, w: 400, h: 300, maxW: 1024, maxH: 1024 })
    return `${s.outW}x${s.outH}`
  })
  console.log(failed ? '\n有 ' + failed + ' 项失败' : '\n全部通过（未动鼠标键盘）')
  try { child.disconnect() } catch {}
  process.exit(failed ? 1 : 0)
}

setTimeout(() => {
  if (failed === 0 && !process.exitCode) {
    console.log('FAIL 引擎 12 秒内没有就绪')
    try { child.kill() } catch {}
    process.exit(1)
  }
}, 15000)
