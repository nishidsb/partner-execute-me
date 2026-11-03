'use strict'
/**
 * 0.46.6 · 宿主桥注入防回归
 *
 * 事故：alarm.js 的注释写「与 pet_* 共用同一条桥」，实际建了独立的 module 级 bridge，
 * 而宿主（main/assistant/index.js）只注入了 setPetBridge/setReachBridge/…，
 * setAlarmBridge 没人调——她每次设闹钟都报「闹钟未连接（宿主没有注入定时器）」
 * （ryza.log 10-31 起多次实证），聊天里只能说「我设不了闹钟」。学习三工具同款。
 *
 * 这类漏接 wirecheck 拦不住（它只查 IPC 三向），用静态断言锁死：
 * 凡核心工具有独立 bridge 的，宿主必须注入。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

test('宿主必须注入 alarm / study 桥（否则聊天里她说自己设不了闹钟）', () => {
  const host = read('src/main/assistant/index.js')
  // 每个独立 bridge 一条注入，且都路由到 petBridge.invoke
  for (const fn of ['setPetBridge', 'setReachBridge', 'setAlarmBridge', 'setStudyBridge']) {
    assert.ok(host.includes(`tools.${fn}`), `宿主缺少 ${fn} 注入`)
  }
  const after = host.indexOf('tools.setAlarmBridge')
  assert.ok(after > 0 && /petBridge'\)\.invoke/.test(host.slice(after, after + 200)), 'alarm 桥应路由到 petBridge.invoke')
})

test('tools/index.js 必须导出 setAlarmBridge / setStudyBridge（宿主拿不到就注不了）', () => {
  const idx = read('src/assistant/core/tools/index.js')
  assert.ok(/import \{ setAlarmBridge \} from '\.\/alarm\.js'/.test(idx), 'alarm.js 的 setter 未导出')
  assert.ok(/import \{ setStudyBridge \} from '\.\/study\.js'/.test(idx), 'study.js 的 setter 未导出')
  assert.ok(/setAlarmBridge, setStudyBridge/.test(idx), '导出清单缺 alarm/study setter')
})

test('petBridge 必须能接住这三组工具（注入了没人执行等于白接）', () => {
  const bridge = read('src/main/petBridge.js')
  for (const name of ['alarm_set', 'alarm_list', 'alarm_cancel', 'study_start', 'study_peek', 'study_stop']) {
    assert.ok(bridge.includes(`'${name}'`), `petBridge 缺 ${name} case`)
  }
  const comp = read('src/main/companion/index.js')
  for (const fn of ['alarmAdd', 'alarmList', 'alarmCancel', 'studyStart', 'studyStop']) {
    assert.ok(comp.includes(fn), `companion 缺 ${fn}`)
  }
})
