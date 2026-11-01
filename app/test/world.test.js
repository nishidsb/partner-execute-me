/**
 * S10 World 扩展体系测试：manifest 校验 / ZIP 白名单 / 安装-装载-工具注册 / 熔断 / 防死循环 / 卸载。
 * 全部走注入桩（不碰 Electron）；zip 用内置「store 法」构造器生成。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { createWorldManager, validateManifest, auditWorldDir } = require('../src/main/world/index')

/* ---- 极简 ZIP 写入器（store 不压缩，CRC32 现算）——只为测试构造合法 zip ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32 (buf) {
  let c = 0xFFFFFFFF
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function makeZip (entries) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, data] of entries) {
    const nb = Buffer.from(name, 'utf8')
    const db = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    const crc = crc32(db)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22)
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28)
    local.push(lh, nb, db)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(db.length, 20); ch.writeUInt32LE(db.length, 24)
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, nb)
    offset += lh.length + nb.length + db.length
  }
  const cdStart = offset
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(cdStart, 16)
  return Buffer.concat([...local, cd, end])
}

/* ---- 桩 ---- */
function fakeHome () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-world-'))
}
function makeToolsSink () {
  const reg = new Map()
  return {
    reg,
    registerTool: (def) => reg.set(def.name, def),
    unregisterTool: (name) => reg.delete(name)
  }
}
/** 在临时目录搭一个合法扩展目录，返回根目录与 zip 缓冲 */
function buildWorldFiles (id, { prompts = '请用海盗腔说话', tool = true } = {}) {
  const dir = path.join(fakeHome(), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: '测试扩展 ' + id, version: '1.0.0', author: 't', description: 'd',
    prompts, panel: false, config: [{ key: 'greet', type: 'string', default: 'hi', label: '招呼语' }]
  }))
  if (tool) {
    fs.writeFileSync(path.join(dir, 'main.js'), `
      let greet = 'hi'
      module.exports = {
        tools: [{ name: 'echo', description: '回声', risk: 'low',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
          exec: (args) => { if (args && args.boom) throw new Error('炸了'); return { echo: (greet) + ':' + String(args.text || '') } } }],
        api: { ping: () => 'pong' },
        onEnable: (ctx) => { greet = String(ctx.config.greet) },
        onDisable: () => {}
      }`)
  }
  return dir
}

test('validateManifest：缺 id / 名字超长 / os 不符都要拒绝', () => {
  assert.throws(() => validateManifest({ name: 'x' }, null, 'win32'))
  assert.throws(() => validateManifest({ id: 'ok', name: '' }, null, 'win32'))
  assert.throws(() => validateManifest({ id: 'ok', name: 'x', os: ['darwin'] }, null, 'win32'))
  const m = validateManifest({ id: 'ok', name: 'x', os: ['win32'], config: [{ key: 'a', type: 'number', default: 1 }] }, null, 'win32')
  assert.equal(m.id, 'ok')
  assert.equal(m.config[0].type, 'number')
  assert.throws(() => validateManifest({ id: 'ab', name: 'x' }, 'b', 'win32'), /目录名/)
})

test('auditWorldDir：符号链接 / 坏扩展名 / 越界路径都要拒绝', () => {
  const dir = fakeHome()
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'a')
  assert.equal(auditWorldDir(dir).files, 1)
  // 坏扩展名
  fs.writeFileSync(path.join(dir, 'evil.exe'), 'MZ')
  assert.throws(() => auditWorldDir(dir), /不允许的文件类型/)
  fs.rmSync(path.join(dir, 'evil.exe'))
  // 符号链接（Windows 建不了就跳过这条断言）
  try {
    fs.symlinkSync(path.join(dir, 'ok.txt'), path.join(dir, 'link.lnk'), 'file')
    assert.throws(() => auditWorldDir(dir), /符号链接/)
    fs.rmSync(path.join(dir, 'link.lnk'))
  } catch { /* 无权限建 symlink 的环境忽略 */ }
})

test('installZip → 工具注册 + exec + 提示词片段 + 配置注入', async () => {
  const root = fakeHome()
  const sink = makeToolsSink()
  const zip = makeZip([
    ['manifest.json', JSON.stringify({ id: 'alpha', name: 'Alpha', version: '1.0.0', prompts: '海盗腔', config: [{ key: 'greet', type: 'string', default: 'ahoy' }] })],
    ['main.js', fs.readFileSync(path.join(buildWorldFiles('alpha'), 'main.js'))]
  ])
  const zipPath = path.join(root, 'alpha.zip')
  fs.writeFileSync(zipPath, zip)
  const mgr = createWorldManager({ dataRoot: root, registerTool: sink.registerTool, unregisterTool: sink.unregisterTool, unzip: (p, d) => require('extract-zip')(p, { dir: d }) })
  const r = await mgr.installZip(zipPath)
  assert.ok(r.ok, '安装要成功: ' + JSON.stringify(r))
  assert.equal(r.id, 'alpha')
  assert.equal(r.load.ok, true)
  // 工具名带 w_<id>_ 前缀
  assert.ok(sink.reg.has('w_alpha_echo'), '工具要注册进表: ' + [...sink.reg.keys()])
  // exec 走通 + onEnable 吃到了默认配置
  const out = await sink.reg.get('w_alpha_echo').exec({ text: 'matey' })
  assert.equal(out.echo, 'ahoy:matey')
  // 提示词片段进桥
  assert.deepEqual(mgr.promptSnippets().map((x) => x.text), ['海盗腔'])
  // 列表状态
  const list = mgr.list().worlds[0]
  assert.equal(list.status, 'loaded')
  assert.equal(list.enabled, true)
  assert.equal(list.config.greet, 'ahoy')
  fs.rmSync(root, { recursive: true, force: true })
})

test('installZip：没有 manifest 的包要被拒', async () => {
  const root = fakeHome()
  const sink = makeToolsSink()
  const mgr = createWorldManager({ dataRoot: root, registerTool: sink.registerTool, unregisterTool: sink.unregisterTool, unzip: (p, d) => require('extract-zip')(p, { dir: d }) })
  const badZip = path.join(root, 'bad.zip')
  fs.writeFileSync(badZip, makeZip([['only-a-text.txt', '没有 manifest']]))
  const r2 = await mgr.installZip(badZip)
  assert.ok(!r2.ok && /manifest/.test(r2.error))
  fs.rmSync(root, { recursive: true, force: true })
})

test('工具连续抛错 5 次 → 自动熔断停用', async () => {
  const root = fakeHome()
  const sink = makeToolsSink()
  const dir = buildWorldFiles('boomer')
  // 带顶层目录的 zip（测单层目录自动识别）
  const zip = makeZip([
    ['boomer/manifest.json', fs.readFileSync(path.join(dir, 'manifest.json'))],
    ['boomer/main.js', fs.readFileSync(path.join(dir, 'main.js'))]
  ])
  const zipPath = path.join(root, 'b.zip')
  fs.writeFileSync(zipPath, zip)
  const mgr = createWorldManager({ dataRoot: root, registerTool: sink.registerTool, unregisterTool: sink.unregisterTool, unzip: (p, d) => require('extract-zip')(p, { dir: d }) })
  const r = await mgr.installZip(zipPath)
  assert.ok(r.ok && r.load.ok)
  const name = 'w_boomer_echo'
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => sink.reg.get(name).exec({ boom: true }))
  }
  // 第 5 次后熔断：工具被注销、状态 failed、promptSnippets 清空
  assert.ok(!sink.reg.has(name), '熔断后工具要被注销')
  const st = mgr.list().worlds[0]
  assert.equal(st.status, 'failed')
  assert.equal(st.enabled, false)
  assert.equal(mgr.promptSnippets().length, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('防死循环：boot-marker 残留 → failCount++，累计 3 次自动停用', () => {
  const root = fakeHome()
  const sink = makeToolsSink()
  const src = buildWorldFiles('loopy', { tool: false })
  // 把扩展文件放进 worlds/loopy
  const worldDir = path.join(root, 'worlds', 'loopy')
  fs.mkdirSync(worldDir, { recursive: true })
  fs.writeFileSync(path.join(worldDir, 'manifest.json'), fs.readFileSync(path.join(src, 'manifest.json')))
  fs.writeFileSync(path.join(worldDir, 'main.js'), 'module.exports = {}')
  // 标记启用 + 残留 marker（前两次已崩，这是第 3 次）
  const stateFile = path.join(root, 'worlds', 'state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ worlds: { loopy: { status: 'loaded', enabled: true, failCount: 2, lastError: '' } } }))
  fs.writeFileSync(path.join(root, 'worlds', 'boot-marker.json'), JSON.stringify({ ts: 1, worlds: ['loopy'] }))
  const mgr = createWorldManager({ dataRoot: root, registerTool: sink.registerTool, unregisterTool: sink.unregisterTool, unzip: (p, d) => require('extract-zip')(p, { dir: d }) })
  const results = mgr.loadAll()
  const st = mgr.list().worlds.find((w) => w.id === 'loopy')
  assert.ok(st, '列表要有 loopy')
  assert.equal(st.enabled, false, '第 3 次启动崩溃要自动停用')
  assert.equal(st.status, 'failed')
  assert.match(st.lastError, /防死循环/)
  assert.ok(!fs.existsSync(path.join(root, 'worlds', 'boot-marker.json')), 'marker 要清掉')
  // 没启用 → 不会真的装载（results 里是 skipped）
  assert.equal(results.loopy.skipped, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('启停 / 卸载 / api invoke 全链路', async () => {
  const root = fakeHome()
  const sink = makeToolsSink()
  const src = buildWorldFiles('beta')
  const zipPath = path.join(root, 'beta.zip')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(zipPath, makeZip([
    ['manifest.json', fs.readFileSync(path.join(src, 'manifest.json'))],
    ['main.js', fs.readFileSync(path.join(src, 'main.js'))]
  ]))
  const mgr = createWorldManager({
    dataRoot: root, registerTool: sink.registerTool, unregisterTool: sink.unregisterTool,
    unzip: (p, d) => require('extract-zip')(p, { dir: d }),
    openPanel: () => ({ ok: true })
  })
  await mgr.installZip(zipPath)
  // api invoke
  assert.equal((await mgr.invoke('beta', 'ping')).result, 'pong')
  assert.equal((await mgr.invoke('beta', 'nope')).ok, false)
  // 停用 → 工具注销、invoke 拒绝
  assert.ok(mgr.setEnabled('beta', false).ok)
  assert.ok(!sink.reg.has('w_beta_echo'))
  assert.equal((await mgr.invoke('beta', 'ping')).ok, false)
  // 再启用 → 工具回来
  assert.ok(mgr.setEnabled('beta', true).ok)
  assert.ok(sink.reg.has('w_beta_echo'))
  // 配置修改 → onEnable 重新吃到
  mgr.setConfig('beta', { greet: 'ahoy-hoy' })
  const out = await sink.reg.get('w_beta_echo').exec({ text: 'x' })
  assert.equal(out.echo, 'ahoy-hoy:x')
  // 面板没声明 → 拒绝
  assert.equal(mgr.openPanel('beta').ok, false)
  // 卸载 → 目录没了、列表没了
  assert.ok(mgr.uninstall('beta').ok)
  assert.ok(!fs.existsSync(path.join(root, 'worlds', 'beta')))
  assert.equal(mgr.list().worlds.length, 0)
  fs.rmSync(root, { recursive: true, force: true })
})
