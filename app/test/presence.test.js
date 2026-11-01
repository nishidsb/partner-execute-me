'use strict'
/**
 * 0.35.0 · 在场判定 + 整体负反馈
 *
 * 用例取自真实使用场景中的常见说法（已匿名化处理）。
 * 断言语义与原测试一致，不含任何真实个人信息。
 */
const test = require('node:test')
const assert = require('node:assert')

const presence = require('../src/main/companion/presence')
const rebuke = require('../src/main/companion/rebuke')

/* ------------------------------------------------------------ 出门 / 回来 */

test('宣告离开：真实说法都要认出来', () => {
  const yes = [
    '我出门了',
    '我走了',
    '我人还是在外面的不在电脑前',   // 真实使用中的说法
    '我出去一趟，晚点回来',
    '下楼拿个快递',
    '准备出去',
    // 下面三条都会因为「么」这个字被误判成问句
    '今天我会出门一趟，有正事要办，不能在电脑前陪你太久',
    '已经准备好了，要坐车了',
    '抱歉了 莱莎虽然在你看来我还在电脑前，但我已经出门很久了'
  ]
  for (const s of yes) assert.equal(presence.didDeclareLeave(s), true, s)
})

test('宣告离开：问句和否定祈使句不算', () => {
  const no = [
    '你要出门吗？',          // 在问她
    '别出门了，外面下雨',
    '你不要出去',            // 命令她别走
    '出门要带伞吗',
    '我今天看了个视频'        // 无关
  ]
  for (const s of no) assert.equal(presence.didDeclareLeave(s), false, s)
})

test('宣告回来：真实说法', () => {
  assert.equal(presence.didDeclareReturn('我到家了'), true)
  assert.equal(presence.didDeclareReturn('我回来了'), true)
  assert.equal(presence.didDeclareReturn('ただいま'), true)
  // 同时含「到家了」和「是不是不该」，回来优先
  assert.equal(presence.didDeclareReturn('我到家了看了一下，你说过的话，感觉是不是不该在我一个人待着的时候开着你'), true)
})

test('classify：三档阈值', () => {
  assert.equal(presence.classify(0, false), 'here')
  assert.equal(presence.classify(60 * 1000, false), 'here')
  assert.equal(presence.classify(6 * 60 * 1000, false), 'away')
  assert.equal(presence.classify(31 * 60 * 1000, false), 'gone')
  // 口头说了走，就算手抖碰了一下也算走
  assert.equal(presence.classify(0, true), 'gone')
})

test('状态机：说出门 → gone；说回来 → here', () => {
  let idle = 0
  let t = 1000000
  const p = presence.createPresence({ idleSec: () => idle, now: () => t })
  assert.equal(p.state(), 'here')

  p.noteUserMessage('我出门了，晚饭前回来')
  assert.equal(p.state(), 'gone', '说了出门就该闭嘴')

  // 出门期间键鼠不动，一直 gone
  idle = 40 * 60
  t += 40 * 60 * 1000
  assert.equal(p.state(), 'gone')

  p.noteUserMessage('我到家了')
  idle = 1
  assert.equal(p.state(), 'here')
})

test('状态机：宣告离开后短暂有输入不撤销（宽限期内）', () => {
  let idle = 0
  let t = 1000000
  const p = presence.createPresence({ idleSec: () => idle, now: () => t })
  p.noteUserMessage('我出门了')
  idle = 2            // 两秒前碰了一下键鼠（其实是自己碰到的）
  t += 30 * 1000      // 还没过 90 秒宽限期
  assert.equal(p.state(), 'gone', '宽限期内不该被一次输入撤销')
  t += 120 * 1000     // 过了宽限期，仍在持续输入 → 人回来了
  idle = 5
  assert.equal(p.state(), 'here')
})

test('状态机：没说出门，但人走了 30 分钟 → gone', () => {
  let idle = 0
  const t = 1000000
  const p = presence.createPresence({ idleSec: () => idle, now: () => t })
  idle = 8 * 60
  assert.equal(p.state(), 'away')
  idle = 45 * 60
  assert.equal(p.state(), 'gone')
})

/* ------------------------------------------------------------ 整体负反馈 */

test('识别：真实不满的说法', () => {
  const cases = [
    ['我到家了看了一下你说过的话，是不是不该在我一个人待着的时候开着你', 'disappoint'],
    ['我出去之前就已经说了，你可以自己呆着，看看电脑中有什么感兴趣的可以自己玩', 'disappoint'],
    ['别说了', 'stop'],
    ['你太吵了', 'stop'],
    ['下次别一直问我在不在', 'criticize']
  ]
  for (const [s, kind] of cases) {
    const r = rebuke.detect(s)
    assert.equal(r.hit, true, s)
    assert.equal(r.kind, kind, s + ' → ' + r.kind)
  }
})

test('识别：正常叙述不能被误伤', () => {
  const no = [
    '我坐的顺风车，司机原本是接好单的，但是另一个单临时取消了，只能接我，但是又不能只送我，所以就花了半个小时去接合适的单，后面又遇到塞车这些，基本上到那边已经花了4个小时了，下车的时候我甚至有些没缓过来',
    '初印象就不好了，我估计也不行了',
    '我去了一个挺正式的场合，就是到的时候已经迟到一个小时了',
    '我想先稳定下来再思考这些，不稳定下来想其他的没有作用，视频啊相当于打发时间吧'
  ]
  for (const s of no) assert.equal(rebuke.detect(s).hit, false, s.slice(0, 20))
})

test('累积：一句噤声就到 0.55，两句封顶前明显收着', () => {
  let d = 0
  d = rebuke.accumulate(d, 1)        // 别说了
  assert.ok(Math.abs(d - 0.55) < 1e-9)
  d = rebuke.accumulate(d, 0.75)     // 失望
  assert.ok(d > 0.9 - 1e-9, '叠加后应到上限')
  assert.ok(d <= rebuke.MAX)
})

test('累积：一句轻微纠正只到 0.165，不该大动', () => {
  const d = rebuke.accumulate(0, 0.3)
  assert.ok(d > 0.15 && d < 0.2, '实际 ' + d)
})

test('衰减：按小时回落，好好聊天也回落', () => {
  assert.ok(rebuke.decay(0.8, 5) < 0.8)
  assert.ok(rebuke.decay(0.8, 100) === 0)
  assert.ok(rebuke.decayOnTalk(0.3) < 0.3)
  assert.equal(rebuke.decayOnTalk(0.01), 0)
})

test('间隔乘数：越不满间隔越长，但不会变哑巴', () => {
  assert.equal(rebuke.gapScale(0), 1)
  assert.ok(rebuke.gapScale(0.9) > 3)
  assert.ok(rebuke.allowChance(0.9) >= 0.15)
  assert.equal(rebuke.allowChance(0), 1)
})

test('提示词：不同档位给不同的话，0 就不写', () => {
  assert.equal(rebuke.promptLine(0), '')
  assert.ok(rebuke.promptLine(0.2).includes('提醒'))
  assert.ok(rebuke.promptLine(0.5).includes('冷水'))
  assert.ok(rebuke.promptLine(0.8).includes('不要主动开口'))
})

/* ---- 0.45.30 在座收紧：键鼠不动=没在看电脑（用户 10-30 拍板） ---- */
const fs = require('node:fs')
const path = require('node:path')

test('0.45.30 watch 看屏点评：away 也拦（不再只拦 gone）', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/main/companion/watch.js'), 'utf8')
  assert.ok(!src.includes("p === 'gone'"), '旧的 gone-only 闸已清除')
  const gates = src.split("p !== 'here'").length - 1
  assert.ok(gates >= 2, '看屏点评 + 时间观念两处都改成 !== here，实得 ' + gates)
  assert.ok(src.includes('键鼠不动=没在看电脑'), '闸上注明用户拍板的语义')
  // 回来打招呼（back）不受探问闸影响
  assert.ok(src.includes("ev.kind !== 'back'"), 'back 欢迎回来保留')
})
