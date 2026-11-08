'use strict'
/**
 * 0.46.74 静态接线测试（同 pc-ws-wiring.test.js 模式）：
 * ① declaresSleep 调用点必须传当前时间（白天闸才有挂钟可用）
 * ② chatter 陪学静音闸：deps 注入 + quietNow 计入 + 宿主接线
 * ③ 泄压只放一句（连发修复）
 * ④ 回复链「刚说过」镜子：lifeBlocksNow 产出 + session.js 认 justsaid 块
 * ⑤ studyAuto 公考题词进 COURSE_TITLE_RE
 * 全部是真机事故驱动：
 *  - 11-08 上午报「睡了几小时」→ 大早上 QQ 晚安 + 静默到 18:00
 *  - 11-08 10:52 主动问候 / 10:56 回复第一句又是同一段问候
 *  - 11-08 11:33~12:01 陪学两小时里嘀咕连发（泄压轮三句 4 秒内连出）
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
// p 相对 app/（如 'app/src/...'）→ 这里 ROOT=app，再进一层
const readApp = (p) => fs.readFileSync(path.join(ROOT, p.replace(/^app\//, '')), 'utf8')

test('0.46.74 declaresSleep 调用点传了当前时间（白天闸要挂钟）', () => {
  const src = readApp('app/src/main/companion/index.js')
  const calls = src.match(/idleNudge\.declaresSleep\([^;]*?\)\s*\{/g) || []
  assert.ok(calls.length >= 2, '有两个调用点：' + calls.length)
  for (const c of calls) {
    assert.ok(/declaresSleep\(text,\s*Date\.now\(\)\)/.test(c), '调用必须传 now：' + c)
  }
})

test('0.46.74 回忆否决 + 白天闸常驻 idleNudge', () => {
  const src = readApp('app/src/main/companion/idleNudge.js')
  assert.ok(src.includes('WAKE_VETO_RE'), '过去睡词否决')
  assert.ok(src.includes('STRONG_DECLARE_RE'), '宣言词压过否决')
  assert.ok(src.includes('DAY_GATE_FROM'), '白天闸')
  assert.ok(/declaresSleep \(text, now\)/.test(src), '签名收 now')
})

test('0.46.74 chatter 陪学静音闸：注入 + quietNow + 宿主接线', () => {
  const chatter = readApp('app/src/main/companion/chatter.js')
  assert.ok(chatter.includes('deps.studyActive'), 'deps 注入 studyActive')
  assert.ok(/\|\| studying/.test(chatter), 'quietNow 计入 studying')
  assert.ok(chatter.includes("'study'"), 'skip 留痕 study')
  const host = readApp('app/src/main/companion/index.js')
  assert.ok(/studyActive:\s*\(\)\s*=>\s*\{[^}]*study\.active\(studySess\)/.test(host), '宿主把学习会话状态递进去')
})

test('0.46.74 泄压只放一句（连发修复）', () => {
  const chatter = readApp('app/src/main/companion/chatter.js')
  assert.ok(/escape && passed\.length > 1/.test(chatter), '泄压轮截到 1 句')
  assert.ok(/余下 ' \+ \(passed\.length - 1\)/.test(chatter), '收住的句数留痕')
  assert.ok(/estimateSeconds/.test(chatter), '朗读间隔按 pet_say 估时等，不再固定 2.6s')
})

test('0.46.74 回复链「刚说过」镜子：lifeBlocks 产出 + session 认 justsaid', () => {
  const host = readApp('app/src/main/companion/index.js')
  assert.ok(/blocks\.justsaid/.test(host), 'lifeBlocksNow 产出 justsaid')
  assert.ok(/recentVoices\(4, 30 \* 60 \* 1000\)/.test(host), '取最近半小时主动说的话')
  const sess = readApp('app/src/assistant/core/core/session.js')
  assert.ok(/life\.justsaid/.test(sess), 'buildSystem 把 justsaid 推进 system')
  // 链路×2：companion 自己的 systemPrompt 也要有同款镜子（两份独立代码修一处≠修完）
  assert.ok(/justsaid/.test(readApp('app/src/main/companion/index.js')), 'companion 链同款')
})

test('0.46.74 studyAuto 公考词进课程标题白名单', () => {
  const src = readApp('app/src/main/companion/studyAuto.js')
  for (const w of ['资料分析', '行测', '申论', '套卷', '粉笔']) {
    assert.ok(src.includes(w), 'COURSE_TITLE_RE 缺词：' + w)
  }
})
