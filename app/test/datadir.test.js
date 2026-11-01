'use strict'
/**
 * 数据目录（0.19.0）：便携隔离靠 PORTABLE_EXECUTABLE_DIR，继承询问靠指针文件。
 * 这里只测纯逻辑与文件复制，不启动 Electron。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const datadir = require('../src/main/datadir')

function tmpRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-dd-'))
}

/** 最小 app 替身：只需要 getPath('appData') */
function fakeApp (appData) {
  return {
    getPath (k) {
      if (k === 'appData') return appData
      if (k === 'userData') return path.join(appData, datadir.APP_DIR_NAME)
      throw new Error('unexpected getPath ' + k)
    },
    setPath () {}
  }
}

function putCfg (dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ global: {} }))
}

test('便携模式：数据放程序旁边的 data/，优先于指针与默认目录', () => {
  const appData = tmpRoot()
  const programDir = tmpRoot()
  const app = fakeApp(appData)
  // 先写一个指针，确认便携仍然优先
  datadir.writePointer(app, { root: path.join(appData, 'somewhere'), known: [] })
  const plan = datadir.planStartup({ app, env: { PORTABLE_EXECUTABLE_DIR: programDir } })
  assert.equal(plan.portable, true)
  assert.equal(plan.source, 'portable')
  assert.equal(plan.root, path.join(programDir, 'data'))
})

test('指针文件决定目录（用户换过目录后跨启动有效）', () => {
  const appData = tmpRoot()
  const app = fakeApp(appData)
  const custom = path.join(appData, 'D-drive-data')
  datadir.writePointer(app, { root: custom, known: [custom] })
  const plan = datadir.planStartup({ app, env: {} })
  assert.equal(plan.source, 'pointer')
  assert.equal(plan.root, custom)
})

test('没有指针也没有便携 → 默认 %APPDATA%/ryza-assistant-app', () => {
  const appData = tmpRoot()
  const plan = datadir.planStartup({ app: fakeApp(appData), env: {} })
  assert.equal(plan.source, 'default')
  assert.equal(plan.root, path.join(appData, datadir.APP_DIR_NAME))
})

test('hasData 只认 config.json：空目录 / 只有缓存都不算', () => {
  const dir = tmpRoot()
  assert.equal(datadir.hasData(dir), false)
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true })
  assert.equal(datadir.hasData(dir), false)
  putCfg(dir)
  assert.equal(datadir.hasData(dir), true)
})

test('findLegacy：排除当前目录，只返回真正有数据的旧目录', () => {
  const base = tmpRoot()
  const current = path.join(base, 'current')
  const oldWithData = path.join(base, 'old-with-data')
  const oldEmpty = path.join(base, 'old-empty')
  fs.mkdirSync(current, { recursive: true })
  fs.mkdirSync(oldEmpty, { recursive: true })
  putCfg(oldWithData)
  const found = datadir.findLegacy({
    current,
    pointer: { known: [current, oldEmpty, oldWithData] },
    fallback: oldEmpty
  })
  assert.deepEqual(found, [oldWithData])
})

test('copyData：复制配置与角色数据，跳过日志/缓存/venv 这些能重建的大件', () => {
  const base = tmpRoot()
  const from = path.join(base, 'from')
  const to = path.join(base, 'to')
  putCfg(from)
  fs.mkdirSync(path.join(from, 'companion'), { recursive: true })
  fs.writeFileSync(path.join(from, 'companion', 'characters.json'), '{"list":[]}')
  fs.mkdirSync(path.join(from, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(from, 'logs', 'main.log'), 'x')
  fs.mkdirSync(path.join(from, 'cache'), { recursive: true })
  fs.writeFileSync(path.join(from, 'cache', 'thumb.bin'), 'x')
  fs.mkdirSync(path.join(from, 'bili-duty', '.venv', 'Scripts'), { recursive: true })
  fs.writeFileSync(path.join(from, 'bili-duty', '.venv', 'Scripts', 'python.exe'), 'x')

  const r = datadir.copyData(from, to)
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(path.join(to, 'config.json')), '配置文件要过去')
  assert.ok(fs.existsSync(path.join(to, 'companion', 'characters.json')), '角色数据要过去')
  assert.equal(fs.existsSync(path.join(to, 'logs')), false, '日志不该复制')
  assert.equal(fs.existsSync(path.join(to, 'cache')), false, '缓存不该复制')
  assert.equal(fs.existsSync(path.join(to, 'bili-duty', '.venv')), false, 'venv 不该复制')
  assert.ok(r.skipped >= 2)
})

test('指针往返：known 去重并限 10 条，root 单独更新不影响历史', () => {
  const app = fakeApp(tmpRoot())
  const many = Array.from({ length: 15 }, (_, i) => 'C:\\d' + i)
  datadir.writePointer(app, { root: 'C:\\first', known: many })
  const p1 = datadir.readPointer(app)
  assert.equal(p1.root, 'C:\\first')
  assert.equal(p1.known.length, 10)
  datadir.writePointer(app, { root: 'C:\\second' })
  const p2 = datadir.readPointer(app)
  assert.equal(p2.root, 'C:\\second')
  assert.deepEqual(p2.known, p1.known, '只改 root 时历史保留')
})
