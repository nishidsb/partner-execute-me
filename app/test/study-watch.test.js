'use strict'
/** 0.45.68 学习监督（视觉抽查 + 怨气累积）状态机测试 */
const test = require('node:test')
const assert = require('node:assert')
const w = require('../src/main/companion/studyWatch.js')

const M = 60 * 1000
const T0 = 1730000000000
const rngLow = () => 0.01   // 抽样总取区间下界（gap=9 分钟、不走突击）
const rngHigh = () => 0.99  // 取上界

function v (kind, what) { return { v: kind, what: what || '', subj: '' } }

test('start：契约成立，目标规整，下次抽查在 9~21 分钟内', () => {
  const st = w.start(T0, { goal: '行测和申论', targetMin: 120, rng: rngLow })
  assert.equal(st.on, true)
  assert.equal(st.goal, '行测、申论', '他说「行测和申论」要规整成「行测、申论」')
  assert.equal(st.targetMin, 120)
  assert.equal(st.heat, 0)
  assert.equal(st.strikes, 0)
  assert.ok(st.nextAt - T0 >= 9 * M - 1, '间隔不小于 9 分钟')
  assert.ok(st.nextAt - T0 <= 21 * M + 1, '间隔不大于 21 分钟')
})

test('tick：开局缓冲期内不查，到点返回 check，再查前不重复触发', () => {
  let st = w.start(T0, { goal: '行测', rng: rngLow })
  // 立刻推进：还在 4 分钟缓冲内
  let r = w.tick(st, T0 + 60 * 1000)
  assert.equal(r.action, 'none')
  st = r.st
  // 缓冲结束但还没到 nextAt
  r = w.tick(st, T0 + 5 * M)
  assert.equal(r.action, 'none')
  // 到点
  r = w.tick(st, T0 + 10 * M)
  assert.equal(r.action, 'check')
})

test('onVerdict：专注降怨气、连续三次夸一次、中途回来给台阶', () => {
  let st = w.start(T0, { goal: '行测', rng: rngLow })
  // 先制造怨气
  let r = w.onVerdict(st, v('fun', '在打原神'), T0 + M)
  st = r.st
  assert.equal(r.kind, 'mild_fun')
  assert.equal(r.level, 'mild')
  const heatAfterFun = st.heat
  assert.ok(heatAfterFun >= w.LEVELS.mild, '第一次抓到娱乐就到小生气')

  // 回来学了 → 给台阶
  r = w.onVerdict(st, v('study', '在做资料分析'), T0 + 2 * M)
  st = r.st
  assert.equal(r.kind, 'recover')
  assert.ok(st.heat < heatAfterFun, '专注要降温')

  // 再连两次 → 第 3 次连续专注夸
  r = w.onVerdict(st, v('study', '在写申论'), T0 + 3 * M)
  st = r.st
  assert.equal(r.kind, '')
  r = w.onVerdict(st, v('study', '在写申论'), T0 + 4 * M)
  st = r.st
  assert.equal(r.kind, 'streak', '连着三次专注要夸一句')
})

test('onVerdict：一直玩 → 小生气 → 真生气 → 彻底生气罢工', () => {
  let st = w.start(T0, { goal: '行测', rng: rngHigh })
  const seen = []
  for (let i = 0; i < 3; i++) {
    const r = w.onVerdict(st, v('fun', '在看B站视频'), T0 + (i + 1) * 10 * M)
    st = r.st
    seen.push({ kind: r.kind, level: r.level, heat: Math.round(st.heat) })
    assert.equal(r.say, true, '每次抓到都要开口')
  }
  assert.equal(seen[0].level, 'mild', '第一次抓到：小生气')
  assert.equal(seen[1].level, 'angry', '第二次还是玩：真生气')
  assert.equal(seen[2].level, 'furious', '第三次还在玩 = 持续不改 → 彻底生气')
  assert.equal(seen[2].kind, 'furious')
  assert.ok(st.sulkUntil > 0, '彻底生气要罢工')
  assert.equal(w.sulking(st, T0 + 31 * M), true)
  // 罢工期间再补一次判定不该改变状态（她已经在一边待着了）
  const r2 = w.onVerdict(st, v('fun', '还在玩'), T0 + 35 * M)
  assert.equal(r2.say, false)
  assert.equal(r2.st.heat, st.heat)
})

test('tick：罢工结束后自己回来，怨气残留不归零', () => {
  let st = w.start(T0, { goal: '行测', rng: rngHigh })
  for (let i = 0; i < 3; i++) st = w.onVerdict(st, v('fun', '在玩'), T0 + (i + 1) * 10 * M).st
  const sulkUntil = st.sulkUntil
  // 罢工中：不查
  let r = w.tick(st, sulkUntil - 5 * M)
  assert.equal(r.action, 'none')
  st = r.st
  // 罢工结束
  r = w.tick(st, sulkUntil + 1000)
  assert.equal(r.action, 'sulk_over')
  st = r.st
  assert.equal(st.heat, w.HEAT_AFTER_SULK, '不生气了但还记着')
  assert.equal(w.sulking(st, sulkUntil + 60 * 1000), false)
})

test('unsure（亮屏看不出）：轻轻问一句，不涨怨气、不记过', () => {
  let st = w.start(T0, { goal: '申论', rng: rngLow })
  const heat0 = st.heat
  let r = w.onVerdict(st, v('unsure', '在桌面上，认不出在干嘛'), T0 + M)
  st = r.st
  assert.equal(r.kind, 'unsure')
  assert.equal(r.say, true, '第一次存疑要轻轻问一句')
  assert.equal(st.heat, heat0, '存疑不定罪，怨气不动')
  assert.equal(st.strikes, 0, '存疑不算被抓')
  assert.equal(st.unsureChecks, 1)

  // 15 分钟内不追问、整场最多 2 次
  r = w.onVerdict(st, v('unsure', '还是桌面'), T0 + 5 * M)
  st = r.st
  assert.equal(r.say, false, '间隔不够就不追问')
  r = w.onVerdict(st, v('unsure', '还是桌面'), T0 + 30 * M)
  st = r.st
  assert.equal(r.say, true, '过了间隔可以再问一次')
  r = w.onVerdict(st, v('unsure', '还是桌面'), T0 + 60 * M)
  assert.equal(r.say, false, '整场最多问 2 次')
})

test('away（黑屏/锁屏）：人不在不是罪名，不涨怨气不算分心，连续次数要能数出来', () => {
  let st = w.start(T0, { goal: '行测', rng: rngLow })
  let r = w.onVerdict(st, v('away', '黑屏，锁屏界面'), T0 + M)
  st = r.st
  assert.equal(r.kind, '')
  assert.equal(r.say, false, '人不在绝不开口骂')
  assert.equal(st.heat, 0, '怨气不动')
  assert.equal(st.strikes, 0, '不算被抓')
  assert.equal(st.awayStreak, 1)
  r = w.onVerdict(st, v('away', '还是锁屏'), T0 + 11 * M)
  st = r.st
  assert.equal(st.awayStreak, 2, '连续两次人不在（宿主据此收场）')
  // 回来在学习 → 连续计数清零
  r = w.onVerdict(st, v('study', '在做资料分析'), T0 + 21 * M)
  assert.equal(r.st.awayStreak, 0)
})

test('auto 契约：抽查间隔放宽到 20~30 分钟，fillHint 不许拿「约好」说事', () => {
  const st = w.start(T0, { goal: '行测', auto: true, rng: rngLow })
  assert.ok(st.nextAt - T0 >= 20 * M - 1, '自动陪学间隔不小于 20 分钟')
  assert.ok(st.nextAt - T0 <= 30 * M + 1, '自动陪学间隔不大于 30 分钟')
  assert.equal(st.auto, true)
  // 抓到在玩 → 照样小生气，但情境里要说明「没约好」
  const r = w.onVerdict(st, v('fun', '在打原神'), T0 + 25 * M)
  assert.equal(r.kind, 'mild_fun')
  const hint = w.fillHint('mild_fun', r.st, T0 + 25 * M)
  assert.match(hint, /没约过/, '自动陪学的提醒不许说「我们说好要学」')
  assert.doesNotMatch(hint, /而你们说好了今天要学/)
  // 手动契约照旧说「约好」
  const st2 = w.start(T0, { goal: '行测', rng: rngLow })
  const r2 = w.onVerdict(st2, v('fun', '在打原神'), T0 + 10 * M)
  const hint2 = w.fillHint('mild_fun', r2.st, T0 + 10 * M)
  assert.match(hint2, /说好了今天要学/)
})

test('decay：时间过去怨气自然消退，但不会自动清零', () => {
  let st = w.start(T0, { goal: '行测', rng: rngLow })
  st = w.onVerdict(st, v('fun', '在玩'), T0 + M).st
  const h0 = st.heat
  const d1 = w.decay(st, T0 + 11 * M)   // 10 分钟
  assert.ok(d1.heat < h0)
  assert.ok(d1.heat > 0, '十分钟不该全消')
  const d2 = w.decay(st, T0 + 200 * M)  // 很久以后
  assert.equal(d2.heat, 0)
})

test('抓到分心后有概率突击复查：间隔明显短于常规', () => {
  let st = w.start(T0, { goal: '行测', rng: rngLow })
  const r = w.onVerdict(st, v('fun', '在玩'), T0 + M, rngLow) // rng 取低值 → 走突击
  st = r.st
  assert.equal(st.recheck, true)
  assert.ok(st.nextAt - (T0 + M) <= 7 * M + 1, '突击复查在 3~7 分钟内')
})

test('normalizeVerdict：能吃 JSON、```json 包裹、纯文字，判不出来返回 null', () => {
  assert.deepEqual(
    w.normalizeVerdict('{"v":"study","what":"在做资料分析","subj":"资料分析"}'),
    { v: 'study', what: '在做资料分析', subj: '资料分析', words: 0 }
  )
  assert.equal(
    w.normalizeVerdict('{"v":"study","what":"写申论","subj":"申论","words":820}').words, 820,
    '屏幕上显示的字数要读出来（申论检查靠它）'
  )
  assert.equal(w.normalizeVerdict('```json\n{"verdict":"fun","what":"B站看番"}\n```').v, 'fun')
  assert.equal(w.normalizeVerdict('屏幕上是原神，他在打怪').v, 'fun', '没 JSON 也要靠关键词兜住')
  assert.equal(w.normalizeVerdict('他在做行测的图形推理题').v, 'study')
  assert.equal(w.normalizeVerdict('{"v":"away","what":"锁屏界面，时间 02:17"}').v, 'away', '黑屏/锁屏 = 人不在')
  assert.equal(w.normalizeVerdict('屏幕黑着，什么都没有').v, 'away', '没 JSON 也要认出黑屏')
  assert.equal(w.normalizeVerdict('{"v":"unsure","what":"桌面，认不出"}').v, 'unsure')
  assert.equal(w.normalizeVerdict('{"v":"idle","what":"桌面"}').v, 'unsure', '旧 idle 语义拆分后的兜底')
  assert.equal(w.normalizeVerdict(''), null, '空输出=没查过，绝不能瞎判')
  assert.equal(w.normalizeVerdict('嗯'), null)
})

test('normalizeVerdict：v 字段不认识时用 what 二次判断', () => {
  const r = w.normalizeVerdict('{"v":"unknown","what":"在刷短视频"}')
  assert.equal(r.v, 'fun')
})

test('report：账本把专注/玩/存疑/人不在分开算，能直接写进记忆', () => {
  let st = w.start(T0, { goal: '行测、申论', rng: rngLow })
  st = w.onVerdict(st, v('study', '在做题'), T0 + 10 * M).st
  st = w.onVerdict(st, v('fun', '在玩'), T0 + 20 * M).st
  st = w.onVerdict(st, v('unsure', '在桌面'), T0 + 30 * M).st
  const rep = w.report(st, T0 + 60 * M)
  assert.match(rep, /共查了 3 次/)
  assert.match(rep, /专注 1 次/)
  assert.match(rep, /在玩 1 次/)
  assert.match(rep, /看不太清 1 次/)
  // 恢复默认补时 5 分钟后，抓到「在玩」会让目标从 90 変 95——报账要把这个改动说出来
  assert.match(rep, /目标 95 分钟/)
})

test('brief：契约生效时她要「知道自己正在监督、正在生气」', () => {
  let st = w.start(T0, { goal: '行测', rng: rngHigh })
  for (let i = 0; i < 3; i++) st = w.onVerdict(st, v('fun', '在玩'), T0 + (i + 1) * 10 * M).st
  const b = w.brief(st, T0 + 45 * M)
  assert.match(b, /学习契约/)
  assert.match(b, /行测/)
  assert.match(b, /彻底生气/)
  assert.match(b, /赌气/, '罢工中要说她在赌气')
})

test('不再有固定台词表：她的话必须现生成（用户明确要求）', () => {
  assert.equal(typeof w.fallbackLine, 'undefined', '兜底台词表必须彻底删掉，不能留一手')
  assert.equal(w.FALLBACK, undefined, '固定句子表不许存在')
})

test('补时：抓到「在玩」就延长今天的目标，存疑不补', () => {
  let st = w.start(T0, { goal: '行测', targetMin: 90, penaltyMin: 5, rng: rngHigh })
  // 第一次抓到玩 → 立刻补时
  let r = w.onVerdict(st, v('fun', '在打原神'), T0 + 10 * M)
  st = r.st
  assert.equal(r.penalty, 5, '第一次抓到就该补 5 分钟')
  assert.equal(st.targetMin, 95)
  // 存疑 → 不补（看不出在干嘛，不能罚）
  const before = st.targetMin
  r = w.onVerdict(st, v('unsure', '桌面发呆'), T0 + 20 * M)
  st = r.st
  assert.equal(r.penalty, 0)
  assert.equal(st.targetMin, before)
  // 再抓一次玩 → 累加
  r = w.onVerdict(st, v('fun', '又在看番'), T0 + 30 * M)
  st = r.st
  assert.equal(st.penaltyAdded, 10)
  assert.equal(st.targetMin, before + 5)
})

test('补时可关闭（penaltyMin=0）', () => {
  let st = w.start(T0, { goal: '行测', targetMin: 60, penaltyMin: 0, rng: rngHigh })
  const r = w.onVerdict(st, v('fun', '打游戏'), T0 + 10 * M)
  assert.equal(r.penalty, 0)
  assert.equal(r.st.targetMin, 60)
})

test('申论字数：开了才盯，且只认申论/作文场景', () => {
  // 关着 → 不开口
  let st = w.start(T0, { goal: '申论', essayOn: false, essayWords: 1000, rng: rngHigh })
  let r = w.onVerdict(st, { v: 'study', what: 'Word 里在写申论', subj: '申论', words: 320 }, T0 + 10 * M)
  assert.equal(r.essay, null)
  assert.equal(r.kind, '', '关着就不该为了字数开口')

  // 开着 + 申论 + 字数不够 → 开口
  st = w.start(T0, { goal: '申论', essayOn: true, essayWords: 1000, rng: rngHigh })
  r = w.onVerdict(st, { v: 'study', what: 'Word 里在写申论', subj: '申论', words: 320 }, T0 + 10 * M)
  assert.equal(r.essay.words, 320)
  assert.equal(r.essay.target, 1000)
  assert.equal(r.kind, 'essay')
  assert.equal(r.say, true)
  st = r.st

  // 12 分钟内不再念（只提醒，不啰嗦）
  r = w.onVerdict(st, { v: 'study', what: '还在写', subj: '申论', words: 400 }, T0 + 15 * M)
  assert.equal(r.kind, '')
  // 过了间隔又能提醒
  r = w.onVerdict(r.st, { v: 'study', what: '还在写', subj: '申论', words: 500 }, T0 + 40 * M)
  assert.equal(r.kind, 'essay')

  // 行测做题页显示的「字数」不算作文（避免冤枉）
  st = w.start(T0, { goal: '行测', essayOn: true, essayWords: 1000, rng: rngHigh })
  r = w.onVerdict(st, { v: 'study', what: '资料分析题', subj: '资料分析', words: 200 }, T0 + 10 * M)
  assert.equal(r.essay, null)

  // 字数够了不催
  st = w.start(T0, { goal: '申论', essayOn: true, essayWords: 1000, rng: rngHigh })
  r = w.onVerdict(st, { v: 'study', what: '申论', subj: '申论', words: 1200 }, T0 + 10 * M)
  assert.equal(r.essay, null)
})

test('防复读：她说过的话会被记下来，并喂进下一次的情境里', () => {
  let st = w.start(T0, { goal: '行测', rng: rngHigh })
  st = w.onVerdict(st, v('fun', 'B站番剧'), T0 + 10 * M).st
  st = w.noteSaid(st, '我刚才瞄到你屏幕了，B站那个番播到12分34秒了')
  st = w.noteSaid(st, '你自己说说这算什么')
  const hint = w.fillHint('angry', st, T0 + 20 * M)
  assert.match(hint, /你刚才已经亲口说过的话/)
  assert.match(hint, /B站那个番播到12分34秒了/)
  assert.match(hint, /不要重复/)
})

test('fillHint：把「主屏在学、副屏在放番」这种具体画面喂进去', () => {
  const st = w.start(T0, { goal: '行测、申论', rng: rngLow })
  const r = w.onVerdict(st, v('fun', '主屏在做题，副屏在放B站番剧'), T0 + 10 * M)
  const hint = w.fillHint('mild_fun', r.st, T0 + 10 * M)
  assert.match(hint, /主屏在做题，副屏在放B站番剧/)
})

test('stop：结束契约，不再监督', () => {
  const st = w.start(T0, { goal: '行测', rng: rngLow })
  const s2 = w.stop(st, T0 + 30 * M)
  assert.equal(s2.on, false)
  assert.equal(w.tick(s2, T0 + 999 * M).action, 'none')
})
