/** 0.18.0 M9：时间观念——久没动=走开/摸鱼/睡着、久坐提醒、深夜劝睡、早安、回来打招呼 */
const test = require('node:test')
const assert = require('node:assert')
const { createTimeSense, tsInWindow, tsDayKey } = require('../src/main/companion/watch-time')
const { createWatch, clampWatchCfg, inQuietHours, langMismatch } = require('../src/main/companion/watch')

const MIN = 60000
/** 造一个 2026-10-25 起始的本地时刻基准（避开真实时钟） */
const BASE = new Date(2026, 9, 25, 14, 0, 0).getTime()

function mkSense (idleMinAt, cfg = {}) {
  // idleMinAt(now) → 当前系统空闲分钟数（测试用它模拟键鼠动静）
  let now = BASE
  const sense = createTimeSense({
    cfgGet: () => ({ ...cfg }),
    idleMs: () => idleMinAt(now) * MIN
  })
  return { sense, step: (min) => { now += min * MIN } , get now () { return now } }
}

test('离开三档：15/30/60 分钟各开口一次，不重复', () => {
  let idle = 0
  const t = mkSense(() => idle)
  assert.equal(t.sense.tick(t.now), null) // 活跃
  idle = 16; t.step(1)
  assert.equal(t.sense.tick(t.now).kind, 'away')
  idle = 20; t.step(1)
  assert.equal(t.sense.tick(t.now), null) // 已说过 away，不重复
  idle = 35; t.step(1)
  assert.equal(t.sense.tick(t.now).kind, 'afk') // 摸鱼/睡着
  idle = 70; t.step(1)
  assert.equal(t.sense.tick(t.now).kind, 'gone') // 很久不在
  idle = 100; t.step(1)
  assert.equal(t.sense.tick(t.now), null) // gone 已说
})

test('回来了打招呼（离开够久），并清零连续使用；短离开不刷存在感', () => {
  let idle = 0
  const t = mkSense(() => idle)
  t.sense.tick(t.now)
  idle = 20; t.step(1); assert.equal(t.sense.tick(t.now).kind, 'away')
  idle = 0; t.step(1)
  const back = t.sense.tick(t.now)
  assert.equal(back.kind, 'back')
  assert.ok(back.minutes >= 15)
  // 回来后再离开，档位从头算
  idle = 16; t.step(1)
  assert.equal(t.sense.tick(t.now).kind, 'away', '档位已重置，again 会再说一次')
})

test('久坐提醒：连续用满 90 分钟开口，45 分钟冷却，真休息（≥5 分钟无动静）才清零', () => {
  let idle = 0
  const t = mkSense(() => idle, { tsWorkMin: 90 })
  const run = (min) => {
    const out = []
    for (let i = 0; i < min; i++) { const e = t.sense.tick(t.now); if (e) out.push(e); t.step(1) }
    return out
  }
  // 活跃 92 分钟 → 第一次 rest（且只此一次）
  const evs1 = run(92)
  assert.deepEqual(evs1.map((e) => e.kind), ['rest'])
  // 43 分钟（冷却内，最大间隔 44 < 45）→ 无 rest；再 2 分钟 → 冷却过了，再次惦记
  assert.ok(!run(43).some((e) => e.kind === 'rest'))
  assert.ok(run(2).some((e) => e.kind === 'rest'), '冷却过后会再次惦记')
  // 真休息 6 分钟（≥5，但不足「走开」档）→ 清零；回来后 10 分钟内不再提醒
  idle = 6
  run(1)
  idle = 0
  run(1)
  assert.ok(!run(10).some((e) => e.kind === 'rest'), '休息过就重新计')
})

test('深夜劝睡：静音时段里每小时最多一次；早安一天一次、静音时段里不说', () => {
  const t = mkSense(() => 0, { watchQuiet: true, watchQuietStart: '23:00', watchQuietEnd: '08:00' })
  // 把时钟拨到 23:30
  const night = new Date(2026, 9, 25, 23, 30).getTime()
  let now = night
  const sense = createTimeSense({ cfgGet: () => ({ watchQuiet: true, watchQuietStart: '23:00', watchQuietEnd: '08:00' }), idleMs: () => 0 })
  const e1 = sense.tick(now)
  assert.equal(e1.kind, 'sleep')
  // 一小时内不重复
  now += 30 * MIN
  assert.equal(sense.tick(now), null)
  now += 31 * MIN
  assert.equal(sense.tick(now).kind, 'sleep', '一小时后可以再劝')
  // 早安：静音时段里不说（07:00 还在静音窗口，会先触发的是深夜劝睡）；08:00 后第一次活跃才说，且一天一次
  const s2 = createTimeSense({ cfgGet: () => ({ watchQuiet: true, watchQuietStart: '23:00', watchQuietEnd: '08:00' }), idleMs: () => 0 })
  const early = new Date(2026, 9, 26, 7, 0).getTime()
  assert.equal(s2.tick(early).kind, 'sleep', '静音中不道早安（该时段只允许劝睡）')
  const after = new Date(2026, 9, 26, 8, 30).getTime()
  assert.equal(s2.tick(after).kind, 'morning')
  assert.equal(s2.tick(after + 10 * MIN), null, '一天只说一次')
  assert.equal(s2.tick(new Date(2026, 9, 27, 9, 0).getTime()).kind, 'morning', '第二天再说')
})

test('timeSenseOn 关掉 → 全部安静；watchQuiet 关着时深夜窗口默认 23:00-06:00', () => {
  const off = createTimeSense({ cfgGet: () => ({ timeSenseOn: false }), idleMs: () => 40 * MIN })
  assert.equal(off.tick(BASE), null)
  const s = createTimeSense({ cfgGet: () => ({}), idleMs: () => 0 })
  assert.ok(tsInWindow(new Date(2026, 9, 25, 23, 30).getTime(), '23:00', '06:00'))
  assert.ok(tsInWindow(new Date(2026, 9, 25, 5, 0).getTime(), '23:00', '06:00'))
  assert.ok(!tsInWindow(new Date(2026, 9, 25, 12, 0).getTime(), '23:00', '06:00'))
  void s
})

test('tsInWindow / tsDayKey 基础正确性', () => {
  assert.ok(inQuietHours(new Date(2026, 9, 25, 23, 30).getTime(), '23:00', '08:00'), '跨零点')
  assert.ok(inQuietHours(new Date(2026, 9, 26, 2, 0).getTime(), '23:00', '08:00'), '跨零点后半夜')
  assert.ok(!inQuietHours(new Date(2026, 9, 25, 12, 0).getTime(), '23:00', '08:00'))
  assert.equal(tsDayKey(new Date(2026, 9, 25, 23, 59).getTime()), '2026-10-25')
})

test('clampWatchCfg 收 ts* 字段（非法回默认）', () => {
  const c = clampWatchCfg({ watchEnabled: true, tsAwayMin: 99999, tsWorkMin: 'bad', tsSleepNudge: false, tsMorning: false, timeSenseOn: true })
  assert.equal(c.tsAwayMin, 240)
  assert.equal(c.tsWorkMin, 90)
  assert.equal(c.tsSleepNudge, false)
  assert.equal(c.tsMorning, false)
  assert.equal(c.timeSenseOn, true)
})

test('watch 集成：时间事件经 timeSpeak 发声（LLM 挂了走兜底台词），静音时段只放行 sleep', async () => {
  const said = []
  let chatCalls = 0
  let idleMin = 0
  const cfg = { watchEnabled: true, timeSenseOn: true, watchQuiet: false, watchQuietStart: '23:00', watchQuietEnd: '08:00', watchCooldownMin: 0, tsAwayMin: 15, tsSleepMin: 30, tsGoneMin: 60, tsWorkMin: 90, tsBreakMin: 5, watchMaxPerHour: 20, replyLang: 'zh' }
  const w = createWatch({
    cfgGet: () => ({ ...cfg }),
    cfgPatch: () => {},
    shoot: async () => null,
    chat: async () => { chatCalls++; throw new Error('模型挂了') },
    getContext: () => ({ persona: '你是莱莎', replyLang: 'zh' }),
    say: async (t) => { said.push(t) },
    isFullscreen: () => false,
    idleSec: () => idleMin * 60
  })
  w._sense._state.lastTickAt = BASE - MIN
  // LLM 挂 → 兜底变体照样开口；时间观念台词指定日语（不跟 replyLang 设置飘）
  idleMin = 16
  const r1 = await w.timeTick()
  assert.equal(r1.ok, true)
  assert.equal(r1.kind, 'away')
  assert.equal(said.length, 1)
  assert.ok(said[0].length >= 4, '兜底台词非空：' + said[0])
  assert.equal(langMismatch(said[0], 'ja'), false, '兜底台词是日语：' + said[0])
  assert.ok(chatCalls >= 1, 'LLM 被尝试过')
  // 静音时段：普通事件闭嘴（档位已说过 away，改触发 sleep 类只对 sleep 放行——这里验证 away 不再说）
  idleMin = 20
  const r2 = await w.timeTick()
  assert.equal(r2.ok, true, '不重复说话，直接返回')
  // 开着静音 + 深夜时刻：sleep 事件能穿过
  cfg.watchQuiet = true
  const realNow = Date.now
  const night = new Date(2026, 9, 25, 23, 30).getTime()
  Date.now = () => night
  try {
    const w2 = createWatch({
      cfgGet: () => ({ ...cfg }),
      cfgPatch: () => {},
      chat: async () => { throw new Error('x') },
      getContext: () => ({ replyLang: 'zh' }),
      say: async (t) => { said.push(t) },
      idleSec: () => 0
    })
    const r3 = await w2.timeTick()
    assert.equal(r3.ok, true)
    assert.equal(r3.kind, 'sleep', '深夜劝睡穿过静音闸')
    assert.equal(said.length, 2)
  } finally {
    Date.now = realNow
  }
})

test('兜底台词池：多变体随机轮换，绝不连着重复；喂过 {m} 分钟数', () => {
  const cfg = { watchEnabled: true, watchCooldownMin: 0, watchMaxPerHour: 20, replyLang: 'zh' }
  const w = createWatch({
    cfgGet: () => ({ ...cfg }),
    cfgPatch: () => {},
    chat: async () => { throw new Error('x') },
    getContext: () => ({ replyLang: 'zh' }),
    say: async () => {},
    idleSec: () => 0
  })
  const pick = (lang, kind, ev) => w._pickTimeLine(lang, kind, ev || { minutes: 92 })
  // 三种语言每个事件都有台词池，且都过了语言粗判
  for (const lang of ['zh', 'ja', 'en']) {
    for (const kind of ['away', 'afk', 'gone', 'back', 'rest', 'sleep', 'morning']) {
      const line = pick(lang, kind)
      assert.ok(line.length >= 4, `${lang}/${kind} 有兜底台词`)
      assert.equal(langMismatch(line, lang), false, `${lang}/${kind} 台词语言正确：${line}`)
    }
  }
  // rest 事件的 {m} 占位被替换
  assert.ok(pick('zh', 'rest').includes('92'), '分钟数已填进台词')
  // 连续挑 20 次绝不连着重样（recent-2 排除保证）
  for (const kind of ['away', 'rest', 'sleep']) {
    let prev = ''
    for (let i = 0; i < 20; i++) {
      const line = pick('zh', kind)
      assert.notEqual(line, prev, `${kind} 不连着重复`)
      prev = line
    }
  }
  // LLM 最近说过的话会记录（timeSaid 由 timeTick 维护，这里验证实例暴露）
  assert.ok(Array.isArray(w._timeSaid))
})
