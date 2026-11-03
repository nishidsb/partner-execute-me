/**
 * 0.46.0 自言自语系统测试。
 *
 * 需求（用户 11-02）：
 *  - 零散嘀咕 + 连续独白，保持安静是正常且常见的选择；
 *  - 不采用固定间隔播报（tick 到点 ≠ 必说）；
 *  - 依附自主活动（复用既有 LLM 调用，不因点击/滚动加调用）；
 *  - 记忆与本体同源（出口统一 sayNarration → ledgerNote via:'chatter'）；
 *  - 朗读复用 Fish Audio，默认开、低频，有开关与每日上限。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createSoliloquy, MAX_LINES } = require('../src/main/companion/soliloquy')
const chatter = require('../src/main/companion/chatter')
const autonomy = require('../src/main/companion/autonomy')

function tmpFile () {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solilo-')), 'state.json')
}

test('独白状态机：开 → 记 → 满 4 句自动收尾', () => {
  const f = tmpFile()
  const s = createSoliloquy({ file: f })
  assert.equal(s.current(), null, '一开始没有独白')
  s.open('炼金术和编程的相似之处')
  assert.equal(s.current().topic, '炼金术和编程的相似之处')
  for (let i = 1; i <= MAX_LINES; i++) s.addLine('第' + i + '句')
  assert.equal(s.current(), null, '说满 4 句自动结束')
  assert.ok(!fs.existsSync(f) === false, '状态落过盘')
})

test('独白状态机：30 分钟没接上自然过期；close 立即结束', () => {
  let t = 1_000_000
  const f = tmpFile()
  const s = createSoliloquy({ file: f, now: () => t })
  s.open('某个话题')
  s.addLine('一句')
  t += 31 * 60 * 1000
  assert.equal(s.current(), null, '过期清掉')
  // close 路径
  s.open('另一个话题')
  assert.ok(s.current())
  const done = s.close('user-back')
  assert.equal(done.closed, true)
  assert.equal(s.current(), null)
})

test('独白跨进程恢复：重启后从盘上读回来（第二天继续昨天没想完的事）', () => {
  const f = tmpFile()
  const a = createSoliloquy({ file: f })
  a.open('昨天的线索')
  a.addLine('先记到这里')
  const b = createSoliloquy({ file: f })
  const cur = b.current()
  assert.ok(cur, '新实例能读到旧独白')
  assert.equal(cur.topic, '昨天的线索')
  assert.equal(cur.lines.length, 1)
})

test('决策解析：[沉默]/[独白完]/单句/多句/序号引号清洗', () => {
  assert.deepEqual(chatter.parseDecision('[沉默]'), { silent: true, lines: [] })
  assert.deepEqual(chatter.parseDecision(''), { silent: true, lines: [] })
  const closed = []
  const fakeSoliloquy = { close: (r) => closed.push(r) }
  assert.deepEqual(chatter.parseDecision('[独白完]', fakeSoliloquy), { silent: true, lines: [] })
  assert.deepEqual(closed, ['done'], '独白收尾标记会关闭独白')
  assert.deepEqual(chatter.parseDecision('嗯，这个图标有点丑。'), { silent: false, lines: ['嗯，这个图标有点丑。'] })
  const multi = chatter.parseDecision('诶？这个原理有点意思。\n1. 等等，是不是和炼金术很像？\n「不过材料完全不同呀……」')
  assert.equal(multi.silent, false)
  assert.equal(multi.lines.length, 3, '多行 = 独白候选')
  assert.deepEqual(multi.lines, ['诶？这个原理有点意思。', '等等，是不是和炼金术很像？', '不过材料完全不同呀……'], '序号和引号剥掉')
  assert.equal(chatter.parseDecision('超过四句\n1\n2\n3\n4\n5').lines.length, 4, '最多 4 句')
})

test('朗读配置：0.46.11 起默认必出声（概率 1）/12 句上限；显式关就是关；概率夹 0~1', () => {
  assert.deepEqual(chatter.voiceCfgOf({}), { on: true, chance: 1, dailyMax: 12 })
  assert.equal(chatter.voiceCfgOf({ chatterVoiceOn: false }).on, false)
  assert.equal(chatter.voiceCfgOf({ chatterVoiceChance: 0.3 }).chance, 0.3, '想要老的低频行为可显式配')
  assert.equal(chatter.voiceCfgOf({ chatterVoiceChance: 5 }).chance, 1)
  assert.equal(chatter.voiceCfgOf({ chatterVoiceChance: -2 }).chance, 0)
  // 嘀咕音量：main 侧 sayNarration 按 chatterVoiceVol（默认 0.35）压低音量，链路三段都要在
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  assert.match(main, /chatterVoiceVol/, '嘀咕音量配置键必须在场')
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src/main/petBridge.js'), 'utf8')
  assert.match(bridge, /kind: 'say'.*vol/, 'pet_say 广播必须带 vol')
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/overlay/pet.js'), 'utf8')
  assert.match(pet, /a\.volume = Math\.min\(1, Math\.max\(0\.05, v\)\)/, 'Audio 播放必须应用音量')
  assert.match(pet, /cmd\.vol != null/, 'say 命令必须把 vol 传进朗读链')
})

test('chatter 决策化：tick 到点可以沉默且沉默不占每日预算', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/chatter.js'), 'utf8')
  assert.ok(/\[沉默\]/.test(src), '保持安静是模型的一个选项')
  // 沉默分支不 count++（预算只在真的开口后记）
  const tick = src.slice(src.indexOf('async function tick'))
  assert.ok(/她想了想，决定不说/.test(tick), '沉默分支存在且有日志')
  const silentPart = tick.slice(tick.indexOf('r.silent'), tick.indexOf('} else {'))
  assert.ok(!/count\+\+/.test(silentPart), '沉默不计预算')
  // 多句走独白、单句不硬开独白
  assert.ok(/keep\.length > 1/.test(tick), '多句才开/续独白')
  assert.ok(/soliloquy\.addLine/.test(tick), '说过的话进独白状态')
  // 决策提示词：明确「多数时候可以沉默」
  assert.ok(/多数时候可以沉默/.test(src), '提示词不许逼她说话')
  // 素材：此刻的处境（不许凭空编正在看的东西）
  assert.ok(/和你的嘀咕对不上就别硬扯/.test(src), '活动素材注入且有对不上就别扯的约束')
})

test('自主活动自语：解析 + 限频 + 提示词 + 宿主出口', async () => {
  // 解析
  assert.deepEqual(autonomy.extractSoliloquy('正文\n（自语）诶？这个有点意思。\n（自语）不过材料不同呀。'),
    ['诶？这个有点意思。', '不过材料不同呀。'])
  assert.deepEqual(autonomy.extractSoliloquy('(自语) 唔，再想想。'), ['唔，再想想。'])
  assert.deepEqual(autonomy.extractSoliloquy('普通行'), [])
  // 限频：每场 ≤ max，间隔 ≥ 90s
  let t = 0
  const sent = []
  const now0 = Date.now
  Date.now = () => t
  try {
    // soliMax=2：一次回复里的多行一起出，但总量拦在 2
    const emit = autonomy.soliEmitter({ onSoliloquy: async (l) => sent.push(l), soliMax: 2 }, {})
    await emit('（自语）第一句\n（自语）第二句\n（自语）第三句')
    assert.deepEqual(sent, ['第一句', '第二句'], 'soliMax=2 拦下第三句')
    t += 91 * 1000
    await emit('（自语）隔了一分半的新一句')
    assert.equal(sent.length, 2, '每场上限用完了，隔多久也不再放')
    // 间隔闸：两次回复之间至少 90s
    const sent2 = []
    const emit2 = autonomy.soliEmitter({ onSoliloquy: async (l) => sent2.push(l), soliMax: 10 }, {})
    await emit2('（自语）开场一句')
    await emit2('（自语）紧接着的一句')
    assert.equal(sent2.length, 1, '90s 内的第二次回复不放行')
    t += 91 * 1000
    await emit2('（自语）隔了一分半的一句')
    assert.equal(sent2.length, 2, '间隔够 90s 后放行')
    // soliMax=0 = 全关
    const off = autonomy.soliEmitter({ onSoliloquy: async () => { throw new Error('不该被调') }, soliMax: 0 }, {})
    await off('（自语）不该出口')
  } finally {
    Date.now = now0
  }
  // 提示词进了挡 2/3
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/autonomy.js'), 'utf8')
  assert.ok(/SOLI_PROMPT/.test(src), 'SOLI_PROMPT 定义')
  const sysFree = src.slice(src.indexOf("const sys = [", src.indexOf('挡 3')))
  assert.ok(/SOLI_PROMPT/.test(sysFree), '完全开放挡的 system 带自语节')
  // 宿主出口：自语走 sayNarration（气泡 + 低频朗读），与本体记忆同源，不转 QQ
  const host = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  assert.ok(/onSoliloquy: async \(line\)[\s\S]{0,200}sayNarration\(t, \{ speech: narrationVoiceOn\(\) \}\)/.test(host), '自语出口接 sayNarration')
  assert.ok(/function narrationVoiceOn/.test(host), '朗读判定函数存在')
  // chatter 拿到独白状态与活动素材
  assert.ok(/soliloquy: getSoliloquy\(\)/.test(host), 'chatter 注入独白状态机')
  assert.ok(/activity: \(\) => \{/.test(host), 'chatter 注入活动素材')
})
