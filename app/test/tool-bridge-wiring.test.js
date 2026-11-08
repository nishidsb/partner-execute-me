'use strict'
/**
 * 0.46.6 · 宿主桥注入防回归（0.47.1 更新）
 *
 * 事故：alarm.js 的注释写「与 pet_* 共用同一条桥」，实际建了独立的 module 级 bridge，
 * 而宿主只注入了 setPetBridge/setReachBridge/…——她每次设闹钟都报「闹钟未连接」。
 * 这类漏接 wirecheck 拦不住（它只查 IPC 三向），用静态断言锁死：
 * 凡核心工具有独立 bridge 的，宿主必须注入。
 *
 * 0.47.1：alarm 桥随闹钟工具整体下架（主人拍板：定时硬触发设计全退役），
 * 这里改为「负断言」——alarm 的注册与桥不许再回来。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

test('宿主必须注入 reach / study 桥（漏接=工具白注册）', () => {
  const host = read('src/main/assistant/index.js')
  for (const fn of ['setPetBridge', 'setReachBridge', 'setStudyBridge']) {
    assert.ok(host.includes(`tools.${fn}`), `宿主缺少 ${fn} 注入`)
  }
})

test('tools/index.js 必须导出 setStudyBridge；alarm setter 不许回来', () => {
  const idx = read('src/assistant/core/tools/index.js')
  assert.ok(/import \{ setStudyBridge \} from '\.\/study\.js'/.test(idx), 'study.js 的 setter 未导出')
  assert.ok(/setStudyBridge, setGoalBridge/.test(idx), '导出清单缺 study setter')
  assert.ok(!idx.includes('setAlarmBridge'), '0.47.1 alarm setter 已随闹钟工具下架，不许再导出')
  assert.ok(!/import '\.\/alarm\.js'/.test(idx), 'alarm.js 不许再被注册')
})

test('0.47.1 定时硬触发端口全部下架（alarm 三工具 + qq_plan 三工具）', () => {
  const idx = read('src/assistant/core/tools/index.js')
  assert.ok(!idx.includes("import './alarm.js'"), 'alarm.js 注册入口已删')
  const reach = read('src/assistant/core/tools/reach.js')
  for (const bad of ['qq_plan', 'alarm_set']) {
    assert.ok(!new RegExp("name: '" + bad + "'").test(reach), bad + ' 不许再注册（0.47.1 退役）')
  }
  assert.ok(!/name: 'qq_plan'/.test(reach), 'qq_plan 工具已删')
  assert.ok(/name: 'qq_send'/.test(reach), 'qq_send 保留（她此刻的判断，不是定时器）')
  const brain = read('src/main/im/brain.js')
  assert.ok(!brain.includes('alarm_set'), 'QQ 大脑白名单不再含 alarm 工具')
})

test('petBridge 必须能接住 study 工具（注入了没人执行等于白接）', () => {
  const bridge = read('src/main/petBridge.js')
  for (const name of ['study_start', 'study_peek', 'study_stop']) {
    assert.ok(bridge.includes(`'${name}'`), `petBridge 缺 ${name} case`)
  }
  for (const bad of ['alarm_set', 'alarm_list', 'alarm_cancel', 'qq_plan']) {
    assert.ok(!bridge.includes(`'${bad}'`), `petBridge 的 ${bad} 转发应已随端口下架删除`)
  }
  const comp = read('src/main/companion/index.js')
  for (const fn of ['alarmAdd', 'alarmList', 'alarmCancel', 'studyStart', 'studyStop']) {
    assert.ok(comp.includes(fn), `companion 缺 ${fn}（alarm 三 fn 是设置页端口，保留）`)
  }
})
