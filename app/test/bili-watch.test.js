/**
 * 0.46.31 bili_watch 测试：纯逻辑 + 静态接线防断链（pc-ws-wiring 同款思路——
 * require 断链会被 catch 吞掉，运行时测试查不出，靠静态扫描锁死）。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const watch = require(path.join(ROOT, 'src', 'main', 'companion', 'biliWatch.js'))

test('extractBvid：链接/纯号/混在句子里/无号', () => {
  assert.equal(watch.extractBvid('https://www.bilibili.com/video/BV1abcDEF123/?p=1'), 'BV1abcDEF123')
  assert.equal(watch.extractBvid('BV1GJ411x7h7'), 'BV1GJ411x7h7')
  assert.equal(watch.extractBvid('帮我看看这个 BV1xx411c7mD 后面还有字'), 'BV1xx411c7mD')
  assert.equal(watch.extractBvid('没有号'), '')
  assert.equal(watch.extractBvid(''), '')
})

test('trimTranscript：不超长原样 / 超长截断并标注', () => {
  const short = watch.trimTranscript('短字幕', 100)
  assert.equal(short.text, '短字幕')
  assert.equal(short.truncated, false)
  const long = watch.trimTranscript('あ'.repeat(6000), 5000)
  assert.equal(long.text.length, 5000)
  assert.equal(long.truncated, true)
})

test('fmtDur / candidatesOf：字段剥净', () => {
  assert.equal(watch.fmtDur(65), '1:05')
  assert.equal(watch.fmtDur(0), '0:00')
  assert.equal(watch.fmtDur(undefined), '0:00')
  const c = watch.candidatesOf([{ bvid: 'BV1', title: 'T', author: 'A', duration: 95, play: 10, aid: 1, mid: 2 }])
  assert.deepEqual(c, [{ bvid: 'BV1', title: 'T', author: 'A', duration: '1:35', play: 10 }])
  assert.deepEqual(watch.candidatesOf(null), [])
})

test('静态接线：petBridge case / 工具注册 / 导出 / 宿主桥注入 / QQ 白名单，五处都在', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  const petBridge = read('src/main/petBridge.js')
  assert.match(petBridge, /case 'bili_watch':/, 'petBridge 应有 bili_watch 分发')
  assert.match(petBridge, /require\('\.\/companion\/biliWatch'\)\.biliWatch/, 'petBridge 应指向 biliWatch 模块')
  const tool = read('src/assistant/core/tools/bili.js')
  assert.match(tool, /name: 'bili_watch'/, '工具应注册 bili_watch')
  assert.match(tool, /setBiliBridge/, '工具文件应导出宿主桥注入')
  const idx = read('src/assistant/core/tools/index.js')
  assert.match(idx, /import '\.\/bili\.js'/, 'tools/index 应装载 bili 工具')
  assert.match(idx, /setBiliBridge/, 'tools/index 应导出 setBiliBridge')
  const host = read('src/main/assistant/index.js')
  assert.match(host, /setBiliBridge/, '宿主应注入 bili 桥')
  const whitelist = read('src/main/im/brain.js')
  assert.match(whitelist, /'bili_watch'/, 'QQ 白名单应含 bili_watch')
  // 防重复注册/重复白名单（0.46.28 goal 三工具在白名单里写重过一次的教训）
  assert.equal((whitelist.match(/'goal_set'/g) || []).length, 1, '白名单不应有重复项')
})
