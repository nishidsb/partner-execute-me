'use strict'
/**
 * 0.46.76 静态接线测试（同 pc-ws-wiring.test.js 模式）：
 * 真机事故：11-08 13:45/13:55 两个闹钟催同一个 14 点的安排，两句几乎一样的催促
 * （加上 13:25 回复里已经说过一遍=三连）；「あ、」开头连着三句；
 * 13:59 收尾自语混入简体字形乱码（日文句子里夹着「结论」）直进聊天窗。
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

test('0.46.76 闹钟台词生成带刚说过镜子 + 撞车重生成', () => {
  const src = readApp('app/src/main/companion/index.js')
  const m = src.match(/async function alarmLine[\s\S]*?\n\}/)
  assert.ok(m, 'alarmLine 存在')
  assert.ok(m[0].includes('recentVoices(6, 30 * 60 * 1000)'), '镜子取最近半小时台词')
  assert.ok(m[0].includes('你已经提醒过这同一件事') || m[0].includes('已经提醒过这同一件事'), '硬规则：同件事不许催第二遍')
  assert.ok(m[0].includes('voicesim.isRepeat'), '生成后过撞车检测')
  assert.ok(m[0].includes('禁语·最高优先级'), '撞车重生成带禁语')
  assert.ok(m[0].includes('「あ、」开场'), '开头语气词防连用')
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
