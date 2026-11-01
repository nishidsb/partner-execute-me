/**
 * 0.18.0 M3 屏幕监控陪伴：纯逻辑（静音时段 / JSON 解析 / 限频三闸 / 注入式单轮）。
 * 无 Electron：shoot/chat/say/isFullscreen 全部注入。
 */
const test = require('node:test')
const assert = require('node:assert')

const { createWatch, clampWatchCfg, inQuietHours, parseWatchVerdict, langMismatch, DEFAULTS } = require('../src/main/companion/watch')
const rhythm = require('../src/main/companion/rhythm')

/* ---------------- inQuietHours ---------------- */

test('inQuietHours：跨零点 / 正常区间 / 边界 / 非法输入', () => {
  const at = (h, m) => new Date(2026, 9, 25, h, m).getTime()
  // 23:00~08:00 跨零点
  assert.equal(inQuietHours(at(23, 30), '23:00', '08:00'), true)
  assert.equal(inQuietHours(at(0, 0), '23:00', '08:00'), true, '零点整算静音')
  assert.equal(inQuietHours(at(2, 15), '23:00', '08:00'), true)
  assert.equal(inQuietHours(at(7, 59), '23:00', '08:00'), true)
  assert.equal(inQuietHours(at(8, 0), '23:00', '08:00'), false, '结束时刻不含')
  assert.equal(inQuietHours(at(12, 0), '23:00', '08:00'), false)
  // 正常区间
  assert.equal(inQuietHours(at(12, 30), '12:00', '14:00'), true)
  assert.equal(inQuietHours(at(14, 0), '12:00', '14:00'), false)
  // 空/非法 = 不静音
  assert.equal(inQuietHours(at(23, 0), '', '08:00'), false)
  assert.equal(inQuietHours(at(23, 0), 'xx', 'yy'), false)
})

/* ---------------- parseWatchVerdict ---------------- */

test('parseWatchVerdict：裸 JSON / 围栏 / 废话包裹 / 坏输入', () => {
  assert.deepEqual(parseWatchVerdict('{"interesting":true,"comment":"主人喝口水吧","mood":"担心"}'),
    { interesting: true, comment: '主人喝口水吧', mood: '担心', note: '' })
  // 0.45.0：note 是悄悄观察的一行白描
  assert.equal(parseWatchVerdict('{"interesting":false,"comment":"","note":"他在改驱动"}').note, '他在改驱动')
  assert.ok(parseWatchVerdict('{"interesting":true,"comment":"x","note":"超长'.padEnd(80, '长') + '"}').note.length <= 60, 'note 截断到 60')
  const fenced = '```json\n{"interesting":true,"comment":"久坐啦！"}\n```'
  assert.equal(parseWatchVerdict(fenced).interesting, true)
  assert.equal(parseWatchVerdict(fenced).comment, '久坐啦！')
  const wrapped = '我看了一下屏幕。{"interesting":false,"comment":""} 以上。'
  assert.equal(parseWatchVerdict(wrapped).interesting, false)
  assert.equal(parseWatchVerdict('我看不清').interesting, false)
  assert.equal(parseWatchVerdict('').interesting, false)
  // interesting=true 但 comment 空 → 判为不开口
  assert.equal(parseWatchVerdict('{"interesting":true,"comment":"  "}').interesting, false)
})

/* ---------------- clampWatchCfg ---------------- */

test('clampWatchCfg：默认关、范围钳制、静音时刻格式校验', () => {
  const c = clampWatchCfg({ watchEnabled: 1, watchIntervalSec: 5, proactivePerHour: 999, watchCooldownMin: -5, watchQuiet: true, watchQuietStart: '9:5', watchSkipFullscreen: 1 })
  assert.equal(c.watchEnabled, true)
  assert.equal(clampWatchCfg({}).watchEnabled, false, '默认关')
  assert.equal(c.watchIntervalSec, 60)
  assert.equal(c.proactivePerHour, 12, '0.42.0：每小时次数上限 12')
  assert.equal(c.watchCooldownMin, 0, '0 合法（=不冷却），负数才不会变成负数')
  assert.equal(c.watchQuietStart, '23:00', '非法时刻回默认')
  assert.equal(c.watchSkipFullscreen, true)
  assert.equal(clampWatchCfg({ watchQuietStart: '07:30' }).watchQuietStart, '07:30')
  assert.deepEqual(Object.keys(DEFAULTS).filter((k) => k === 'watchEnabled'), ['watchEnabled'])
  // 老配置迁移：之前存的「每小时最多几次」直接当新旋钮用，不用用户重设
  assert.equal(clampWatchCfg({ watchMaxPerHour: 6 }).proactivePerHour, 6)
})

/* ---------------- 单轮流程（注入式） ---------------- */

function makeDeps (over = {}) {
  const cfgStore = { ...DEFAULTS, apiBaseUrl: 'http://x', watchEnabled: true, watchCooldownMin: 0, watchIntervalSec: 60 }
  const seen = { shots: 0, chats: 0, says: [] }
  const defaultChat = async () => ({ content: '{"interesting":false,"comment":""}' })
  const deps = {
    cfgGet: () => cfgStore,
    cfgPatch: (p) => Object.assign(cfgStore, p),
    shoot: async () => { seen.shots++; return { image: 'data:image/png;base64,xxx' } },
    // 动态分发：测试中途换 over.chat 也生效
    chat: (...a) => (over.chat || defaultChat)(...a),
    getContext: () => ({ persona: '测试人设' }),
    say: async (text) => { seen.says.push(text) },
    isFullscreen: over.isFullscreen || (() => false),
    log: () => { },
    ...over.deps
  }
  // 测试用：配置 store 也挂在 deps 上，方便整体换 cfgGet 时引用
  deps.store = cfgStore
  return { store: cfgStore, seen, deps }
}

test('单轮：不值得说 → 看了不开口；值得说 → pet_say 且限额计数', async () => {
  const { deps, seen } = makeDeps()
  const w = createWatch(deps)
  let r = await w.tickOnce()
  assert.equal(r.ok, true)
  assert.equal(r.interesting, false)
  assert.equal(seen.shots, 1)
  assert.equal(seen.says.length, 0)
  // 改成值得说：重建一套依赖（chat 换掉，冷却清零）
  const d2 = makeDeps({ chat: async () => ({ content: '{"interesting":true,"comment":"主人该休息啦","mood":"担心"}' }) })
  const w2 = createWatch(d2.deps)
  r = await w2.tickOnce()
  assert.equal(r.interesting, true)
  assert.equal(r.said, '主人该休息啦')
  assert.equal(d2.seen.says.length, 1)
  assert.ok(w2.status().spoke === 1 && w2.status().looked === 1)
})

test('补丁⑪：sharedBlock（记忆/最近聊天同源块）要进看屏提示词；缺省也不炸', async () => {
  const captured = []
  const { deps } = makeDeps({
    chat: async ({ messages }) => {
      captured.push(messages)
      return { content: '{"interesting":true,"comment":"该休息了哦"}' }
    },
    deps: { getContext: () => ({ persona: '测试人设', sharedBlock: '【记忆】他喜欢猫。' }) }
  })
  const w = createWatch(deps)
  await w.tickOnce()
  assert.ok(captured[0][0].content.includes('【记忆】他喜欢猫'), '看屏 sys 必须带 sharedBlock')
  // 兼容旧 getContext（没有 sharedBlock 字段）：不注入也不报错
  const d2 = makeDeps({ chat: async () => ({ content: '{"interesting":true,"comment":"嗯"}' }) })
  const w2 = createWatch(d2.deps)
  const r = await w2.tickOnce()
  assert.equal(r.interesting, true)
})

test('闸门：关 → off；看屏节拍未到 → 不截图；手动绕过节拍但受开口冷却；静音/全屏跳过', async () => {
  // 关
  {
    const { deps, seen } = makeDeps()
    deps.cfgGet = () => ({ ...deps.store, watchEnabled: false })
    const w = createWatch(deps)
    assert.equal((await w.tickOnce()).skip, 'off')
    assert.equal(seen.shots, 0, '关着不截图')
  }
  // 看屏节拍（0.42.0）：不再是「每 N 秒准点看一次」，紧接着再 tick 应该被告知「还没到」
  {
    const { deps, seen } = makeDeps({ chat: async () => ({ content: '{"interesting":true,"comment":"喵"}' }) })
    deps.cfgGet = () => ({ ...deps.store, watchCooldownMin: 10 })
    const w = createWatch(deps)
    await w.tickOnce()
    assert.equal(seen.says.length, 1)
    const r = await w.tickOnce()
    assert.equal(r.skip, 'not-due', '节拍没到就不必再截一张')
    assert.equal(seen.shots, 1, '没到点不截图（省调用）')
    // 手动触发（设置页「试一下」）绕过看屏节拍，但开口冷却仍然生效
    const r2 = await w.tickOnce(true)
    assert.equal(r2.skip, 'cooldown', '手动触发也受开口冷却')
    assert.equal(seen.shots, 2, '手动触发看了一眼')
  }
  // 节奏器：想说但现在不是时候 → 攒着（不丢），手动 = 用户就在等这一句，不吃闸
  {
    const { deps, seen } = makeDeps({ chat: async () => ({ content: '{"interesting":true,"comment":"你刚才那下好险"}' }) })
    const rh = rhythm.createRhythm({ cfgGet: () => ({ proactivePerHour: 3, proactiveMinGapSec: 120 }), rand: () => 0.95 })
    rh.start() // 下一句最早在几分钟之后
    deps.rhythm = rh
    const w = createWatch(deps)
    const a = await w.tickOnce()
    assert.ok(String(a.skip).startsWith('rhythm-'), '被节奏器挡下：' + a.skip)
    assert.equal(seen.says.length, 0)
    assert.ok(w.status().pending, '被挡下来的话要攒着，等下一个允许的时点补说')
    const b = await w.tickOnce(true)
    assert.equal(b.said, '你刚才那下好险')
  }
  // 静音时段。窗口绕着「现在」构造（往前 2 分钟 ~ 往后 8 分钟）：
  // 固定写 00:00~23:59 会在 23:59:00-23:59:59 那一分钟必挂（结束时刻不含），
  // 这是 0.44.0 深夜跑全量时撞出来的时间敏感缺陷，与产品代码无关。
  {
    const { deps, seen } = makeDeps({ chat: async () => ({ content: '{"interesting":true,"comment":"深夜了"}' }) })
    const hm = (offsetMs) => {
      const x = new Date(Date.now() + offsetMs)
      return String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0')
    }
    deps.cfgGet = () => ({ ...deps.store, watchQuiet: true, watchQuietStart: hm(-2 * 60000), watchQuietEnd: hm(8 * 60000) })
    const w = createWatch(deps)
    const r = await w.tickOnce()
    assert.equal(r.skip, 'quiet-hours')
    assert.equal(seen.shots, 0)
  }
  // 全屏跳过
  {
    const { deps, seen } = makeDeps({ isFullscreen: () => true })
    deps.cfgGet = () => ({ ...deps.store, watchSkipFullscreen: true })
    const w = createWatch(deps)
    assert.equal((await w.tickOnce()).skip, 'fullscreen')
    assert.equal(seen.shots, 0)
  }
})

test('异常路径：截屏失败不炸；模型坏 JSON = 不开口；提示词带人设与上一次的话', async () => {
  // 截屏失败
  {
    const { deps } = makeDeps()
    deps.shoot = async () => null
    const w = createWatch(deps)
    const r = await w.tickOnce()
    assert.equal(r.ok, false)
    assert.equal(r.error, '截屏失败')
  }
  // 坏 JSON
  {
    const { deps, seen } = makeDeps({ chat: async () => ({ content: '我看不懂' }) })
    const w = createWatch(deps)
    const r = await w.tickOnce()
    assert.equal(r.interesting, false)
    assert.equal(seen.says.length, 0)
  }
  // chat 抛错 → lastError 留痕
  {
    const { deps } = makeDeps({ chat: async () => { throw new Error('HTTP 503') } })
    const w = createWatch(deps)
    const r = await w.tickOnce()
    assert.equal(r.ok, false)
    assert.ok(w.status().lastError.includes('503'))
  }
  // 提示词：第二次开口提示词里带上一次的话（防复读）
  {
    let lastSys = ''
    const chat = async ({ messages }) => {
      lastSys = messages[0].content
      return { content: '{"interesting":true,"comment":"第' + (lastSys.includes('上一次') ? 2 : 1) + '次"}' }
    }
    const { deps } = makeDeps({ chat })
    const w = createWatch(deps)
    await w.tickOnce()
    assert.ok(lastSys.includes('测试人设'), '人设注入')
    assert.ok(!lastSys.includes('上一次'), '第一次没有历史')
    // 0.42.0：连着看两次要手动（看屏节拍会把第二次挡成 not-due），这里测的是提示词
    await w.tickOnce(true)
    assert.ok(lastSys.includes('上一次') && lastSys.includes('第1次'), '第二次提示带上一次的话防复读')
  }
})

test('patch：写回 + 范围钳制（cfgPatch 收到的只有 watch/ts 键）', async () => {
  const { deps, store } = makeDeps()
  const w = createWatch(deps)
  const next = w.patch({ watchIntervalSec: 5, proactivePerHour: 999, watchEnabled: true })
  assert.equal(next.watchIntervalSec, 60)
  assert.equal(next.proactivePerHour, 12)
  assert.equal(next.watchEnabled, true)
  assert.equal(store.proactivePerHour, 12)
  // 0.18.0 M9：时间观念 ts* 键也归 watch 模块管（watchTimeSense 等默认值一起写回）
  assert.equal(Object.keys(next).every((k) => k.startsWith('watch') || k.startsWith('ts') || k === 'timeSenseOn' || k === 'proactivePerHour'), true, '只写回 watch/ts/节奏键，不覆盖其它伴侣配置')
})

/* ---------------- 语言跟角色设置走（replyLang） ---------------- */

test('langMismatch：ja=无假名即错 / zh=混假名或纯英文即错 / en=混汉字即错 / auto 永不触发', () => {
  assert.equal(langMismatch('マスター、休憩しよう', 'ja'), false)
  assert.equal(langMismatch('主人该休息了', 'ja'), true)
  assert.equal(langMismatch('主人该休息了', 'zh'), false)
  assert.equal(langMismatch('マスター休息', 'zh'), true)
  assert.equal(langMismatch('Time to rest, Master', 'en'), false)
  assert.equal(langMismatch('主人该休息了', 'en'), true)
  assert.equal(langMismatch('anything 任何何でも', 'auto'), false)
  assert.equal(langMismatch('', 'ja'), false)
})

test('语言：replyLang=ja 时提示词带语言要求；comment 说中文 → 守卫纠正重试一次并采用日语', async () => {
  const calls = []
  const chat = async ({ messages }) => {
    calls.push(messages)
    if (calls.length === 1) return { content: '{"interesting":true,"comment":"主人该休息啦"}' } // 中文 → 违规
    return { content: '{"interesting":true,"comment":"マスター、少し休もうか","mood":"心配"}' } // 纠正
  }
  const { deps, seen } = makeDeps({ chat })
  deps.cfgGet = () => ({ ...deps.store, replyLang: 'ja' })
  deps.getContext = () => ({ persona: 'テスト人設', replyLang: 'ja' })
  const w = createWatch(deps)
  const r = await w.tickOnce()
  assert.equal(r.interesting, true)
  assert.equal(r.said, 'マスター、少し休もうか', '说的是纠正后的日语')
  assert.equal(seen.says.length, 1)
  assert.equal(calls.length, 2, '守卫触发重试了一次')
  assert.ok(calls[0][0].content.includes('言語要求') || calls[0][0].content.includes('语言要求'), '提示词带语言要求')
  assert.ok(calls[0][0].content.includes('日文'), '指明日语')
  assert.ok(calls[1].some((m) => m.role === 'user' && /系统纠正|系統糾正/.test(m.content)), '纠正消息追加了')
})

test('语言：纠正后仍不符 → 用原判断；auto 不注入语言要求也不触发守卫', async () => {
  // 纠正失败：第二次还是中文 → 保留原 comment（宁可说中文也不哑火）
  {
    const chat = async () => ({ content: '{"interesting":true,"comment":"主人该休息啦"}' })
    const { deps, seen } = makeDeps({ chat })
    deps.getContext = () => ({ persona: '测试人设', replyLang: 'ja' })
    const w = createWatch(deps)
    const r = await w.tickOnce()
    assert.equal(r.said, '主人该休息啦')
    assert.equal(seen.says.length, 1)
  }
  // auto：无语言要求注入；中文 comment 一次通过
  {
    let sys = ''
    let calls = 0
    const chat = async ({ messages }) => { calls++; sys = messages[0].content; return { content: '{"interesting":true,"comment":"主人该休息啦"}' } }
    const { deps } = makeDeps({ chat })
    deps.getContext = () => ({ persona: '测试人设', replyLang: 'auto' })
    const w = createWatch(deps)
    const r = await w.tickOnce()
    assert.equal(r.said, '主人该休息啦')
    assert.equal(calls, 1, 'auto 不触发守卫')
    assert.ok(!sys.includes('语言要求') && !sys.includes('言語要求'), 'auto 不注入语言要求')
  }
  // 正常聊天链路默认 zh：中文 comment 一次通过
  {
    const chat = async () => ({ content: '{"interesting":true,"comment":"主人该休息啦"}' })
    const { deps } = makeDeps({ chat })
    deps.getContext = () => ({ persona: '测试人设' }) // 无 replyLang → 默认 zh
    const w = createWatch(deps)
    const r = await w.tickOnce()
    assert.equal(r.said, '主人该休息啦')
  }
})

/* ==================== 0.45.0 悄悄观察 ==================== */

test('悄悄观察：不说话也记一行；10 分钟内不重复记；一样的画面不记', async () => {
  const notes = []
  const chatJson = () => ({ content: '{"interesting":false,"comment":"","note":"他在改 main.js，终端跑着测试"}' })
  const { deps } = makeDeps({ chat: chatJson })
  deps.observe = (t) => { notes.push(t) }
  const w = createWatch(deps)
  const r1 = await w.tickOnce()
  assert.equal(r1.interesting, false)
  assert.equal(notes.length, 1, '第一次看：记下了')
  assert.ok(notes[0].includes('main.js'))
  // 紧接着再看一轮（间隔 0）→ 节流，不重复记
  await w.tickOnce()
  assert.equal(notes.length, 1, '10 分钟内不重复')
  // 换个内容、把时间拨过 10 分钟 → 记
  const d2 = makeDeps({ chat: async () => ({ content: '{"interesting":false,"comment":"","note":"他在看B站视频"}' }) })
  d2.deps.observe = (t) => { notes.push(t) }
  const w2 = createWatch(d2.deps)
  await w2.tickOnce()
  assert.equal(notes.length, 2)
  assert.ok(notes[1].includes('B站'))
})

test('悄悄观察：值得说但被节奏器挡下时，观察照样进记忆', async () => {
  const notes = []
  const { deps } = makeDeps({ chat: async () => ({ content: '{"interesting":true,"comment":"该休息啦","note":"他连着干了三小时"}' }) })
  deps.observe = (t) => { notes.push(t) }
  deps.rhythm = { ask: () => ({ ok: false, why: 'budget' }), note: () => { }, status: () => ({ usedLastHour: 1, budget: { soft: 4, hard: 7 } }) }
  const w = createWatch(deps)
  const r = await w.tickOnce()
  assert.equal(r.skip, 'rhythm-budget')
  assert.equal(notes.length, 1, '话没说成，但看见了就记')
})

test('悄悄观察：模型没给 note / 给空 note → 不记也不炸', async () => {
  const notes = []
  const { deps } = makeDeps({ chat: async () => ({ content: '{"interesting":false,"comment":""}' }) })
  deps.observe = (t) => { notes.push(t) }
  const w = createWatch(deps)
  const r = await w.tickOnce()
  assert.equal(r.interesting, false)
  assert.equal(notes.length, 0)
})
