'use strict'
/**
 * 0.46.76 静态接线测试（同 pc-ws-wiring.test.js 模式）：
 * 真机事故：11-08 13:45/13:55 两个闹钟催同一个 14 点的安排，两句几乎一样的催促
 * （加上 13:25 回复里已经说过一遍=三连）；「あ、」开头连着三句；
 * 13:59 收尾自语混入简体字形乱码（「触れないって结论も結論として」）直进聊天窗。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const readApp = (p) => fs.readFileSync(path.join(ROOT, p.replace(/^app\//, '')), 'utf8')

test('0.46.76 闹钟同窗去重常驻 alarms.add', () => {
  const src = readApp('app/src/main/companion/alarms.js')
  assert.ok(src.includes('DUP_WINDOW_MS'), '去重窗口常量')
  assert.ok(src.includes('duplicate: true'), '拒绝时带 duplicate 标记')
  assert.ok(/const dup = \(daily === false\)/.test(src), '只对一次性闹钟去重（每天闹钟不去重）')
})

test('0.47.1 到点看情况：闹钟不再直接开口，只入账约定候选', () => {
  const src = readApp('app/src/main/companion/index.js')
  assert.ok(!/async function alarmLine/.test(src), 'alarmLine 生成函数已随直接开口路径退役')
  const m = src.match(/onFire: \(a\) => \{[\s\S]*?\n    \}/)
  assert.ok(m, 'onFire 回调存在')
  assert.ok(m[0].includes('setDuePlan(a)'), '到点只入账约定候选（看情况）')
  assert.ok(!m[0].includes('sayProactive'), '不许直接开口（sayProactive 已移出 onFire）')
  assert.ok(!m[0].includes('pet:alarm'), '不许再弹 ⏰ 气泡')
  assert.ok(!m[0].includes('Notification'), '不许再发系统通知')
  assert.ok(src.includes('function duePlanBlock'), 'duePlan 注入块存在')
  assert.ok(src.includes('sweepDuePlan'), '过期扫账存在')
  assert.ok(src.includes('noteSuppress'), '过期咽回去进念头池（想说说没说）')
  assert.ok(/duePlanBlock\('reply'\)/.test(src), '回复链注入约定')
  assert.ok(/duePlan: \(\) => \{ try \{ return duePlanBlock\('chatter'\)/.test(src), 'chatter 链注入约定')
})

test('0.46.76 收尾自语乱码守卫：简体字形检测 + 重写 + 接线', () => {
  const src = readApp('app/src/main/companion/autonomy.js')
  assert.ok(src.includes('SIMPLIFIED_ONLY_RE'), '简体字形特征表')
  assert.ok(src.includes('async function detangleCloseLine'), '守卫函数')
  assert.ok(/said = await detangleCloseLine\(said, cfgGet\(\), log\)/.test(src), '在收尾协议解析后接线')
  const m = src.match(/async function detangleCloseLine[\s\S]*?\n\}/)
  assert.ok(m[0].includes("lang !== 'ja'"), '只管 ja 模式')
  assert.ok(m[0].includes('chatOnce'), '重写走 LLM')
})
