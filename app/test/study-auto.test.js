/**
 * 自动学习模式（0.45.12）——场景判定 + 状态机 + study.js 的 auto 分支
 *
 * 用户要求：学习模式不是开关式的，她要自己发现「他在学习」并自动进入静音陪伴。
 * 场景判定保守策略：宁可漏判不可误判（把刷视频判成学习比漏掉一场陪学糟糕得多）。
 */
const test = require('node:test')
const assert = require('node:assert')

const sa = require('../src/main/companion/studyAuto')
const study = require('../src/main/companion/study')

/* ---------------- sceneOf：什么算学习场景 ---------------- */

test('sceneOf：编辑器/IDE/文献/笔记/终端算学习，能说出场景名', () => {
  assert.deepEqual(sa.sceneOf({ pn: 'Code', title: 'main.js - Visual Studio Code' }), { label: '写代码' })
  assert.deepEqual(sa.sceneOf({ pn: 'Code.exe', title: '随便' }), { label: '写代码' }, '进程名带 .exe 也认')
  assert.deepEqual(sa.sceneOf({ pn: 'SumatraPDF', title: '论文.pdf' }), { label: '读文献' })
  assert.deepEqual(sa.sceneOf({ pn: 'Obsidian', title: '笔记' }), { label: '记笔记' })
  assert.deepEqual(sa.sceneOf({ pn: 'WindowsTerminal', title: 'pwsh' }), { label: '敲命令行' })
})

test('sceneOf：浏览器只有标题命中课程关键词才算（刷视频也是浏览器）', () => {
  assert.equal(sa.sceneOf({ pn: 'chrome', title: '哔哩哔哩 (゜-゜)つロ 干杯~' }), null, 'B 站不算学习')
  assert.ok(sa.sceneOf({ pn: 'msedge', title: '线性代数 第3讲 - 中国大学MOOC' }), '网课标题算')
  assert.ok(sa.sceneOf({ pn: 'chrome', title: 'Rust tutorial for beginners' }), '英文教程也算')
})

test('sceneOf：游戏/娱乐永远不算（优先级最高）；空窗口不算', () => {
  assert.equal(sa.sceneOf({ pn: 'Code', title: '原神 启动器' }), null, '标题是游戏就不算')
  assert.equal(sa.sceneOf({ pn: 'GenshinImpact', title: '' }), null)
  assert.equal(sa.sceneOf({ pn: '', title: '' }), null)
  assert.equal(sa.sceneOf(null), null)
})

/* ---------------- tick：进入/退出/冷却状态机 ---------------- */

test('自动进入：学习场景要连续稳定 8 分钟才进入，太急不算', () => {
  const now = 1000000000000
  let st = sa.freshState(now)
  // 第 0 分钟第一次看到（sceneSince=now），之后逐分钟推进
  st = sa.tick(st, { now, scene: { label: '写代码' }, studyActive: false }).st
  for (let m = 1; m <= 7; m++) {
    const r = sa.tick(st, { now: now + m * 60000, scene: { label: '写代码' }, studyActive: false })
    st = r.st
    assert.equal(r.action, 'none', m + ' 分钟还不进')
  }
  const r8 = sa.tick(st, { now: now + 8 * 60000, scene: { label: '写代码' }, studyActive: false })
  assert.equal(r8.action, 'enter', '第 8 分钟进入')
  assert.equal(r8.label, '写代码')
})

test('场景变了要重新计时（写代码 5 分钟→读文献 5 分钟不该进入）', () => {
  const now = 1000000000000
  let st = sa.freshState(now)
  for (let m = 1; m <= 5; m++) st = sa.tick(st, { now: now + m * 60000, scene: { label: '写代码' }, studyActive: false }).st
  const r = sa.tick(st, { now: now + 6 * 60000, scene: { label: '读文献' }, studyActive: false })
  assert.equal(r.action, 'none', '换场景重新计时')
})

test('自动退出：场景消失 5 分钟才退；退后 45 分钟冷却内不再进入', () => {
  const now = 1000000000000
  let st = sa.freshState(now)
  // 直接进入一场（第 0 分钟看到 → 第 8 分钟进入）
  st = sa.tick(st, { now, scene: { label: '写代码' }, studyActive: false }).st
  const enter = sa.tick(st, { now: now + 8 * 60000, scene: { label: '写代码' }, studyActive: false })
  st = sa.markStarted(enter.st, now + 8 * 60000)
  // 会话中场景消失：逐分钟推进，前 5 分钟不退（起点=第一个「不在」的 tick）
  for (let m = 1; m <= 5; m++) {
    const r = sa.tick(st, { now: now + 8 * 60000 + m * 60000, scene: null, studyActive: true })
    st = r.st
    assert.equal(r.action, 'none', '离开 ' + m + ' 分钟还在（可能倒水去了）')
  }
  // 第 6 分钟：离开满 5 分钟，退出
  const r5 = sa.tick(st, { now: now + 8 * 60000 + 6 * 60000, scene: null, studyActive: true })
  assert.equal(r5.action, 'exit', '场景消失满 5 分钟收场')
  st = r5.st
  // 冷却期内场景又出现也不进
  const rC = sa.tick(st, { now: now + 20 * 60000, scene: { label: '写代码' }, studyActive: false })
  assert.equal(rC.action, 'none', '冷却 45 分钟内不反复进出')
  // 冷却结束（退场时刻 + 45 分钟）后重新计满 8 分钟才进
  let st2 = rC.st
  const exitAt = now + 8 * 60000 + 6 * 60000
  const tCoolEnd = exitAt + sa.COOLDOWN_MIN * 60000
  st2 = sa.tick(st2, { now: tCoolEnd, scene: { label: '写代码' }, studyActive: false }).st
  for (let m = 1; m <= 7; m++) {
    const r7 = sa.tick(st2, { now: tCoolEnd + m * 60000, scene: { label: '写代码' }, studyActive: false })
    st2 = r7.st
    assert.equal(r7.action, 'none', '冷却结束后第 ' + m + ' 分钟还不进')
  }
  const r2 = sa.tick(st2, { now: tCoolEnd + 8 * 60000, scene: { label: '写代码' }, studyActive: false })
  assert.equal(r2.action, 'enter', '冷却结束后重新计满 8 分钟进入')
})

/* ---------------- study.js 的 auto 分支 ---------------- */

test('study auto：查岗间隔翻倍，语气永远封顶 check_normal（没回应是专注不是冷落）', () => {
  // 90 分钟单轮：躲开 45 分钟的轮次边界，专心验查岗节奏
  const cfg = { studyMinutes: 90, studyBreak: 10, studyRounds: 3 }
  const t0 = 1000000000000
  // 自动会话
  let st = study.start(cfg, t0, { auto: true, sceneLabel: '写代码' })
  assert.equal(st.auto, true, 'auto 标记带上')
  assert.equal(st.sceneLabel, '写代码', '场景名带上（台词里说得出「在写代码呢」）')
  // 自动：30 分钟才第一次查岗（CHECK_EVERY 15min × 2）
  assert.equal(study.tick(st, cfg, t0 + 15 * 60000), null, '自动模式 15 分钟不查岗')
  const t30 = study.tick(st, cfg, t0 + 30 * 60000)
  assert.ok(t30, '30 分钟轻声问一次')
  assert.equal(t30.say, 'check_normal', '语气封顶：连续没回应也不升级成委屈/撒娇')
  // 自动：60 分钟还只查一次普通岗
  st = t30
  assert.equal(study.tick(st, cfg, t0 + 45 * 60000), null, '又一个 15 分钟：不动')
  const t60 = study.tick(st, cfg, t0 + 60 * 60000)
  assert.equal(t60.say, 'check_normal', '第二轮没回应也只轻轻问')
  // 对照：手动会话 2 轮没回应就升级
  let manual = study.start(cfg, t0)
  manual = study.tick(manual, cfg, t0 + 15 * 60000)
  const m30 = study.tick(manual, cfg, t0 + 30 * 60000)
  assert.equal(m30.say, 'check_worried', '手动模式保留原阶梯（2 次没回应→不安）')
})

test('study auto：fillHint 的 {scene} 占位符替换', () => {
  const cfg = { studyMinutes: 45, studyBreak: 10, studyRounds: 3 }
  const st = study.start(cfg, 1000000000000, { auto: true, sceneLabel: '写代码' })
  const hint = study.fillHint('auto_start', st)
  assert.ok(hint.includes('写代码'), '场景名进提示词：' + hint.slice(0, 50))
})
