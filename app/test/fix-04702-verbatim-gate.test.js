'use strict'
/**
 * 0.47.2 · 「一模一样的话不只看到一次两次」（主人 11-08 22:12 实锤）
 *
 * 两层根因，两层都锁死：
 *   A. 显示层复读假象：dmHold 译文 dk.say 上过弹幕后，subtitle 又 replaceLast(整句)
 *      把切句后的最后一条覆盖成全句 → 前半句在弹幕盒出现两遍。（见 fix-04702-subtitle-no-dup）
 *   B. 生成层真复读：复读硬闸只看最近 90 分钟，同一刺激物（挂机游戏界面）一晚上
 *      出现十几次，窗口一过她就把几乎原句的话再说一遍。
 *      修复：24h 一字不差闸（Jaccard ≥ 0.85 无条件咽回去，泄压也不放）。
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

/** 0.47.3 修时间依赖脆弱：chatter tick 有清醒时段闸（9~23 点外一律闭嘴），
 *  本文件 22 点多写完当晚能过，0 点后跑必挂。桩一个白天挂钟（15:00），跑完还原。 */
const FIXED_MS = new Date('2026-11-08T15:00:00+08:00').getTime()
function freezeDaytimeClock () {
  const RealDate = global.Date
  class FrozenDate extends RealDate {
    constructor (...args) { args.length ? super(...args) : super(FIXED_MS) }
    static now () { return FIXED_MS }
  }
  global.Date = FrozenDate
  return () => { global.Date = RealDate }
}

test('24h 一字不差闸：90 分钟窗外说过的原句再生成会被咽回去，新句正常通过', async () => {
  const said2hAgo = '手元はもう別の画面。切り替えの速さが、少し羨ましい。'
  const brandNew = '勝ち筋を数える指が、今日は少し躊躇ってる。'
  // llm 桩：这轮她生成的还是 2 小时前说过的那句
  const llm = require('../src/main/companion/llm')
  const origChat = llm.chatStream
  llm.chatStream = async () => ({ content: said2hAgo })
  // recentVoices 桩：严格按时间窗回答——90 分钟镜子里已经没有那句（2h 前说的），
  // 24h 长镜里还在。旧行为下这句会畅通无阻地说出口。
  const recentVoices = (n, sinceMs) => {
    if (sinceMs && sinceMs <= 90 * 60 * 1000) return []
    return [said2hAgo]
  }
  const swallowed = []
  const said = []
  const { createChatter } = require('../src/main/companion/chatter')
  const inst = createChatter({
    log: () => { },
    cfgGet: () => ({ apiBaseUrl: 'http://x', apiModel: 'm', chatterVoiceOn: false }),
    state: () => ({ quiet: 0 }),
    isBusy: () => false,
    say: async (t) => { said.push(t); return { estimateSeconds: 1 } },
    note: () => { },
    presence: () => 'here',
    displeasure: () => 0,
    recentVoices,
    studyActive: () => false,
    noteSwallowed: (t) => { swallowed.push(t) }
  })
  // 捕获 tick：start() 内部 setTimeout(tick, …) —— 换成同步捕获，立刻手动跑一轮
  const origST = global.setTimeout
  let tickFn = null
  global.setTimeout = (fn, ms) => { if (!tickFn) tickFn = fn; return { unref: () => { } } }
  const unfreeze = freezeDaytimeClock()
  try {
    inst.start()
    assert.ok(tickFn, 'start 后应当挂了 tick 定时器')
    await tickFn()
  } finally {
    unfreeze()
    global.setTimeout = origST
    inst.stop()
    llm.chatStream = origChat
  }
  assert.deepStrictEqual(said, [], '24h 内说过的几乎原句必须咽回去，不许再说出口')
  assert.strictEqual(swallowed.length, 1, '咽回去的要进念头池')
  assert.ok(swallowed[0].includes('別の画面'), '咽回去的正是那句复读')
})

test('对照组：内容真正不同的新句不被 24h 闸误伤', async () => {
  const said2hAgo = '手元はもう別の画面。切り替えの速さが、少し羨ましい。'
  const brandNew = 'このゲーム、宝括弧が閉まらないまま夜が来たね。'
  const llm = require('../src/main/companion/llm')
  const origChat = llm.chatStream
  llm.chatStream = async () => ({ content: brandNew })
  const recentVoices = (n, sinceMs) => {
    if (sinceMs && sinceMs <= 90 * 60 * 1000) return []
    return [said2hAgo]
  }
  const swallowed = []
  const said = []
  const { createChatter } = require('../src/main/companion/chatter')
  const inst = createChatter({
    log: () => { },
    cfgGet: () => ({ apiBaseUrl: 'http://x', apiModel: 'm', chatterVoiceOn: false }),
    state: () => ({ quiet: 0 }),
    isBusy: () => false,
    say: async (t) => { said.push(t); return { estimateSeconds: 1 } },
    note: () => { },
    presence: () => 'here',
    displeasure: () => 0,
    recentVoices,
    studyActive: () => false,
    noteSwallowed: (t) => { swallowed.push(t) }
  })
  const origST = global.setTimeout
  let tickFn = null
  global.setTimeout = (fn, ms) => { if (!tickFn) tickFn = fn; return { unref: () => { } } }
  const unfreeze = freezeDaytimeClock()
  try {
    inst.start()
    await tickFn()
  } finally {
    unfreeze()
    global.setTimeout = origST
    inst.stop()
    llm.chatStream = origChat
  }
  assert.deepStrictEqual(swallowed, [], '内容不同的新句不该被一字不差闸吞掉')
  assert.strictEqual(said.length, 1, '新句正常说出口')
})

test('闸的写法：一字不差判定必须先于泄压放行（泄压不许放行原句）', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, '../src/main/companion/chatter.js'), 'utf8')
  const verbatimAt = src.indexOf('24h 内说过几乎一样的话，咽回去')
  const escapeAt = src.indexOf('泄压放行一轮（近似原句照拦）')
  assert.ok(verbatimAt > 0 && escapeAt > 0, '两个闸都在')
  assert.ok(verbatimAt > escapeAt, '一字不差闸写在泄压判定之前（filter 内先判 VERBATIM）')
  assert.ok(/VERBATIM_HIT = 0\.85/.test(src), '阈值 0.85：几乎一字不差才算')
  assert.ok(/VERBATIM_WINDOW_MS = 24 \* 60 \* 60 \* 1000/.test(src), '窗口 24h')
})
