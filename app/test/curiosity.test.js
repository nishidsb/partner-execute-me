'use strict'
/**
 * 0.37.0 · 她自己待着（curiosity）
 *
 * 设计动机（来自真实使用反馈）：希望她不只是被按到才反应，也能感兴趣
 * 的可以自己玩。」到 0.36.0 为止她没有一条行为是自己想做的（黏人=你不理、
 * 碎碎念=随机到点、做梦=睡前、陪看=你开的功能）。
 *
 * 这一组测的不是「她玩得开不开心」（那是模型的事），而是三件必须守住的事：
 *   1. 门禁：不在场 / 正在说话 / 心情差 / 今天做满了 —— 一个都不许动
 *   2. 素材判断：桌面、任务栏、她自己窗口这些「看一眼没意义」的不算
 *   3. 容错：模型输出格式崩了也要能拿到「做」那一句，拿不到就干脆不做
 */
const test = require('node:test')
const assert = require('node:assert')

const curio = require('../src/main/companion/curiosity')

const NOW = new Date(2026, 9, 29, 15, 0, 0).getTime()

function gate (over) {
  return curio.shouldAct(Object.assign({
    on: true,
    now: NOW,
    presence: 'here',
    displeasure: 0,
    quiet: 0,
    busy: false,
    talkedAt: 0,
    countToday: 0,
    lastAt: 0,
    gap: curio.MIN_GAP
  }, over || {}))
}

/* ------------------------------------------------------------ 门禁 */

test('门禁：该做的时候才做', () => {
  assert.strictEqual(gate().ok, true)
})

test('门禁：人不在就不做（做给他看才叫陪伴，没人看就只是空转）', () => {
  for (const p of ['away', 'gone']) {
    const r = gate({ presence: p })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.why, 'away')
  }
})

test('门禁：正在对话、情绪差、太安静都不做', () => {
  assert.strictEqual(gate({ busy: true }).why, 'busy')
  assert.strictEqual(gate({ displeasure: 0.6 }).why, 'displeased')
  assert.strictEqual(gate({ quiet: 0.65 }).why, 'quiet')
})

test('门禁：刚说完 3 分钟内不动（别刚聊完就自己演起来）', () => {
  const r = gate({ talkedAt: NOW - 60 * 1000 })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.why, 'talking')
})

test('门禁：每天都封顶，超了就不再动', () => {
  assert.strictEqual(gate({ countToday: curio.MAX_PER_DAY }).why, 'daily-limit')
  assert.strictEqual(gate({ countToday: curio.MAX_PER_DAY - 1 }).ok, true)
})

test('门禁：两件之间要隔够时间，并且报出还要等多久', () => {
  const r = gate({ lastAt: NOW - 5 * 60 * 1000, gap: 20 * 60 * 1000 })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.why, 'wait')
  assert.strictEqual(r.wait, 15 * 60 * 1000)
  assert.strictEqual(gate({ lastAt: NOW - 21 * 60 * 1000, gap: 20 * 60 * 1000 }).ok, true)
})

test('门禁：开关关掉什么都不做', () => {
  assert.strictEqual(gate({ on: false }).why, 'off')
})

test('间隔落在设定区间里', () => {
  assert.strictEqual(curio.nextGap(() => 0), curio.MIN_GAP)
  assert.strictEqual(curio.nextGap(() => 1), curio.MAX_GAP)
  const mid = curio.nextGap(() => 0.5)
  assert.ok(mid > curio.MIN_GAP && mid < curio.MAX_GAP)
})

/* ------------------------------------------------------------ 素材 */

test('素材：桌面/任务栏/她自己这些不算「他在用什么」', () => {
  const no = [
    { name: 'explorer', title: 'Program Manager' },
    { name: 'Ryza Assistant', title: 'Ryza Assistant' },
    { name: 'SearchApp', title: '' },
    { name: '', title: '' },
    null
  ]
  for (const fg of no) assert.strictEqual(curio.worthWatching(fg), false, JSON.stringify(fg))
})

test('素材：真的开着东西才值得看一眼', () => {
  assert.strictEqual(curio.worthWatching({ name: 'chrome', title: '某篇论文 - Chrome' }), true)
  assert.strictEqual(curio.worthWatching({ name: 'Code', title: '' }), true)
})

test('素材：什么都没有也能跑（她本来也会自己发呆）', () => {
  const p = curio.buildPrompt({ now: NOW })
  assert.match(p.user, /没有能看的/)
  assert.match(p.user, /做：/)
  assert.ok(p.system === '' || typeof p.system === 'string')
})

test('素材：有前台程序、有字幕、有旧事就都带上', () => {
  const p = curio.buildPrompt({
    now: NOW,
    fg: { name: 'chrome', title: '里世界郊游 第 3 话' },
    subtitle: '【陪看字幕】\n空鱼：这不是我们该来的地方',
    memory: '主人喜欢炼金术',
    didToday: ['凑过去看了一眼他在写的字'],
    persona: '我是莱莎'
  })
  assert.match(p.user, /chrome：里世界郊游/)
  assert.match(p.user, /空鱼/)
  assert.match(p.user, /炼金术/)
  assert.match(p.user, /凑过去看了一眼/)
  assert.strictEqual(p.system, '我是莱莎')
})

test('素材：时间用她的口气说（不是报时）', () => {
  const at = (h) => curio.dayPart(new Date(2026, 9, 29, h, 0, 0).getTime())
  assert.strictEqual(at(3), '深夜')
  assert.strictEqual(at(8), '清早')
  assert.strictEqual(at(11), '上午')
  assert.strictEqual(at(13), '中午')
  assert.strictEqual(at(17), '下午')
  assert.strictEqual(at(20), '晚上')
  assert.strictEqual(at(23), '深夜')
})

/* ------------------------------------------------------------ 解析 */

test('解析：标准两行', () => {
  const r = curio.parse('做：凑过去看他在写的那些字，只认得出括号\n想：这个人又在跟一堆括号较劲')
  assert.strictEqual(r.act, '凑过去看他在写的那些字，只认得出括号')
  assert.strictEqual(r.thought, '这个人又在跟一堆括号较劲')
})

test('解析：全角/半角冒号、多余引号空格都得认', () => {
  const r = curio.parse('  做: “翻了翻自己昨天记的东西” \n 想: 那天好像下了雨 ')
  assert.strictEqual(r.act, '翻了翻自己昨天记的东西')
  assert.strictEqual(r.thought, '那天好像下了雨')
})

test('解析：只给一行「做」也能用', () => {
  const r = curio.parse('做：盯着窗外发了会儿呆')
  assert.strictEqual(r.act, '盯着窗外发了会儿呆')
  assert.strictEqual(r.thought, '')
})

test('解析：格式全崩就取第一行当「做」，空输出返回 null', () => {
  const r = curio.parse('嗯，我翻了翻日记，觉得昨天那句挺好笑的。\n还有第二行')
  assert.strictEqual(r.act, '嗯，我翻了翻日记，觉得昨天那句挺好笑的。')
  assert.strictEqual(curio.parse(''), null)
  assert.strictEqual(curio.parse('   \n  '), null)
})

test('解析：超长会被截断（别让她一句话把气泡撑爆）', () => {
  const r = curio.parse('做：' + '啊'.repeat(200) + '\n想：' + '嗯'.repeat(200))
  assert.ok(r.act.length <= 60)
  assert.ok(r.thought.length <= 80)
})

/* ------------------------------------------------------------ 运行时 */

function mkInst (over) {
  const seen = { noted: [], said: [], mat: null }
  const deps = Object.assign({
    log: () => { },
    cfgGet: () => ({ apiBaseUrl: 'http://x', apiModel: 'm', curiosityOn: true }),
    presence: () => 'here',
    displeasure: () => 0,
    quiet: () => 0,
    busy: () => false,
    talkedAt: () => 0,
    stats: () => ({ countToday: 0, lastAt: 0 }),
    collect: async () => { seen.mat = { fg: { name: 'Code', title: 'a.js' } }; return seen.mat },
    note: (d) => seen.noted.push(d),
    say: async (t) => { seen.said.push(t) },
    rand: () => 0.99, // 默认不开口
    ask: async () => ({ act: '凑过去看了一眼', thought: '这人又在改同一个函数' })
  }, over || {})
  return { inst: curio.createCuriosity(deps), seen }
}

test('运行时：做完会记进事件流（她会记得）', async () => {
  const { inst, seen } = mkInst()
  const r = await inst.once()
  assert.strictEqual(r.ok, true)
  assert.strictEqual(seen.noted.length, 1)
  assert.match(seen.noted[0], /凑过去看了一眼/)
  assert.match(seen.noted[0], /同一个函数/)
})

test('运行时：默认不开口（做事是给自己做的，不是找由头说话）', async () => {
  const { inst, seen } = mkInst({ rand: () => 0.99 })
  await inst.once()
  assert.strictEqual(seen.said.length, 0)
})

test('运行时：掷中了才顺口说一句，说的只是那个念头', async () => {
  const { inst, seen } = mkInst({ rand: () => 0.1 })
  const r = await inst.once()
  assert.strictEqual(r.spoke, true)
  assert.deepStrictEqual(seen.said, ['这人又在改同一个函数'])
})

test('运行时：门禁不过时连素材都不去收（别白花一次截图/读盘）', async () => {
  let collected = 0
  const { inst, seen } = mkInst({
    presence: () => 'away',
    collect: async () => { collected++; return {} }
  })
  const r = await inst.once()
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.why, 'away')
  assert.strictEqual(collected, 0)
  assert.strictEqual(seen.noted.length, 0)
})

test('运行时：模型没给出成形的东西就干脆不做（不写空事件）', async () => {
  const { inst, seen } = mkInst({ ask: async () => null })
  const r = await inst.once()
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.why, 'empty')
  assert.strictEqual(seen.noted.length, 0)
})

test('运行时：状态能报给设置页', async () => {
  const { inst } = mkInst()
  const s = inst.status()
  assert.strictEqual(s.maxPerDay, curio.MAX_PER_DAY)
  assert.strictEqual(s.todayCount, 0)
  assert.strictEqual(s.running, false)
  await inst.start()
  assert.strictEqual(inst.status().running, true)
  inst.stop()
  assert.strictEqual(inst.status().running, false)
})
