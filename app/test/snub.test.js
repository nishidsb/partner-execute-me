/**
 * 0.46.33 冷落感知（snub）：
 * - noteSnub：streak 在 2h 窗口内累加、超窗重置、mood 微降、ignoreStreak/quiet 联动
 * - snubStreakNow：40 分钟鲜活窗口外的读时归零
 * - inner.sweepSays 重写判定：3 分钟窗口 / 主人不在不记 / 游戏学习豁免 / onSnubbed 回调（streak≤2）
 * - rhythm：被晾时主动开口最小间隔拉长
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const self = require('../src/main/companion/self')

function tmpWs () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-snub-'))
  self.ensure(dir)
  return dir
}

test('0.46.33 noteSnub：streak 窗口内累加、超窗重置为 1，mood 微降不暴跌', () => {
  const ws = tmpWs()
  const t0 = Date.now()
  const s1 = self.noteSnub(ws, t0)
  assert.equal(s1.snubStreak, 1)
  const s2 = self.noteSnub(ws, t0 + 5 * 60 * 1000)
  assert.equal(s2.snubStreak, 2)
  assert.ok(s2.mood < 0.5 && s2.mood > 0.4, 'mood 微降但不暴跌: ' + s2.mood)
  assert.ok(s2.quiet > 0, '安静度微升')
  // 3 小时后 = 另一阵子，从 1 重新数
  const s3 = self.noteSnub(ws, t0 + 3 * 60 * 60 * 1000)
  assert.equal(s3.snubStreak, 1)
})

test('0.46.33 snubStreakNow：40 分钟内鲜活，2 小时无新增自动翻篇', () => {
  const ws = tmpWs()
  const t0 = Date.now()
  assert.equal(self.snubStreakNow(ws, t0), 0, '从没被晾过 = 0')
  self.noteSnub(ws, t0)
  assert.equal(self.snubStreakNow(ws, t0 + 30 * 60 * 1000), 1, '30 分钟内还记得')
  assert.equal(self.snubStreakNow(ws, t0 + 130 * 60 * 1000), 0, '2 小时没新增 = 翻篇')
})

test('0.46.33 stateWords：snub 段只在 40 分钟内出现，1~2 次与 3+ 次话不同', () => {
  const ws = tmpWs()
  const t0 = Date.now()
  self.noteSnub(ws, t0)
  const st1 = self.getState(ws)
  const w1 = self.stateWords(st1).join('\n')
  assert.match(w1, /小失落/)
  // 快进到 3 次
  self.noteSnub(ws, t0 + 10 * 60 * 1000)
  self.noteSnub(ws, t0 + 20 * 60 * 1000)
  const w3 = self.stateWords(self.getState(ws)).join('\n')
  assert.match(w3, /泄气/)
  // 50 分钟后（st 没变但当前时间不在 40 分钟窗内）→ 不再提「刚才」
  // stateWords 用 Date.now()，这里通过把 lastSnubAt 拨回来模拟
  self.patchState(ws, { lastSnubAt: Date.now() - 50 * 60 * 1000 })
  const wOld = self.stateWords(self.getState(ws)).join('\n')
  assert.ok(!/小失落|泄气/.test(wOld), '过窗后不再带情绪: ' + wOld)
})

test('0.46.33 inner.sweepSays：3 分钟窗口，人在电脑前才记，游戏/学习豁免，streak≤2 才嘀咕', async () => {
  const inner = require('../src/main/companion/inner')
  const ws = tmpWs()
  const t0 = Date.now()
  const snubs = []
  let exempt = false
  let idle = 0   // 默认：人在电脑前
  inner.setContext({
    wsDir: ws,
    log: () => { },
    feedback: 'on',
    cfgGet: () => ({ coldShoulderOn: true, coldShoulderMin: 3 }),
    idleSec: () => idle,
    exempt: () => exempt,
    onSnubbed: (text, streak) => snubs.push({ text, streak })
  })
  // 她说了句话 → 3 分钟内不判
  inner.noteSayTimeout('游戏好好玩')
  inner.sweepSays(t0 + 2 * 60 * 1000)
  assert.equal(self.snubStreakNow(ws, t0 + 2 * 60 * 1000), 0, '窗口内不判')
  assert.equal(snubs.length, 0)
  // 过了窗口、人在 → 记一次 + 嘀咕
  inner.sweepSays(t0 + 4 * 60 * 1000)
  assert.equal(self.snubStreakNow(ws, t0 + 4 * 60 * 1000), 1, '过了窗口记冷落')
  assert.equal(snubs.length, 1, '第一次要当场嘀咕')
  // 人离开了（idle 10 分钟）→ 不记
  inner.noteSayTimeout('又一句')
  idle = 600
  inner.sweepSays(t0 + 8 * 60 * 1000)
  assert.equal(self.snubStreakNow(ws, t0 + 8 * 60 * 1000), 1, '人不在不记')
  assert.equal(snubs.length, 1)
  // 游戏模式 → 不记
  inner.noteSayTimeout('玩得开心吗')
  idle = 0
  exempt = true
  inner.sweepSays(t0 + 12 * 60 * 1000)
  assert.equal(self.snubStreakNow(ws, t0 + 12 * 60 * 1000), 1, '豁免不记')
  // 再来两次被晾 → streak=3，不再嘀咕（她已经收着了）
  exempt = false
  inner.noteSayTimeout('第三句')
  inner.sweepSays(t0 + 16 * 60 * 1000)
  inner.noteSayTimeout('第四句')
  inner.sweepSays(t0 + 20 * 60 * 1000)
  assert.equal(self.snubStreakNow(ws, t0 + 20 * 60 * 1000), 3, '连续累计')
  assert.equal(snubs.length, 2, 'streak≥3 不再嘀咕（收着，不烦人）')
})

test('0.46.33 sweepSays：coldShoulderOn=false 或负反馈关闭 → 只清账不记情绪', async () => {
  const inner = require('../src/main/companion/inner')
  const ws = tmpWs()
  const t0 = Date.now()
  const snubs = []
  let on = false
  inner.setContext({
    wsDir: ws,
    log: () => { },
    feedback: 'on',
    cfgGet: () => ({ coldShoulderOn: on, coldShoulderMin: 3 }),
    idleSec: () => 0,
    exempt: () => false,
    onSnubbed: (t, s) => snubs.push(s)
  })
  inner.noteSayTimeout('一句话')
  inner.sweepSays(t0 + 5 * 60 * 1000)
  assert.equal(self.snubStreakNow(ws, t0 + 5 * 60 * 1000), 0, '开关关了不记')
  assert.equal(snubs.length, 0)
})

test('0.46.34 心情自然回血：按时间恢复、满值封顶、noteSnub 后计时重置', () => {
  const ws = tmpWs()
  // 掉到 0.2，计时点拨回 1 小时前 → 回血 0.3，读到 ≈0.5 且已落盘
  self.patchState(ws, { mood: 0.2, moodAt: Date.now() - 3600e3 })
  const st = self.getState(ws)
  assert.ok(Math.abs(st.mood - 0.5) < 0.01, '1 小时回 0.3: ' + st.mood)
  const onDisk = JSON.parse(fs.readFileSync(path.join(ws, 'self', 'state.json'), 'utf8'))
  assert.ok(onDisk.mood > 0.4, '回血已落盘: ' + onDisk.mood)
  assert.ok(onDisk.moodAt > Date.now() - 60000, '落盘时计时点已重置')
  // 满值不超封顶：mood=1、计时点拨回很久 → 仍是 1
  self.patchState(ws, { mood: 1, moodAt: Date.now() - 10 * 3600e3 })
  assert.equal(self.getState(ws).mood, 1, '满值不超 1')
  // 真实路径：mood 写点都带 moodAt=now（noteSnub/watchSulkMood/noteAttention），
  // 被晾一次只 -0.03，回血不会凭空抵消扣减
  self.patchState(ws, { mood: 0.5, moodAt: Date.now() })
  const s = self.noteSnub(ws, Date.now())
  assert.ok(Math.abs(s.mood - 0.47) < 0.005, '晾一次只 -0.03: ' + s.mood)
  assert.ok(Math.abs(s.moodAt - Date.now()) < 5000, 'noteSnub 重置回血计时')
})

test('0.46.34 老状态没有 moodAt：不凭空回血，从现在起算', () => {
  const ws = tmpWs()
  self.patchState(ws, { mood: 0.3 })
  self.patchState(ws, { moodAt: 0 }) // 模拟 0.46.33 及以前的老状态文件
  const st = self.getState(ws)
  assert.ok(Math.abs(st.mood - 0.3) < 0.01, '老状态读时不回血: ' + st.mood)
  assert.ok(st.moodAt > 0, '但已记下计时起点')
})

test('0.46.33 rhythm：被晾的那阵子主动开口最小间隔拉长', async () => {
  const rhythm = require('../src/main/companion/rhythm')
  let snub = 0
  const inst = rhythm.createRhythm({
    cfgGet: () => ({ proactiveMinGapSec: 600, proactivePerHour: 4, dailyMax: 10 }),
    log: () => { },
    snubStreakOf: () => snub,
    now: () => t
  })
  let t = 1_800_000_000_000
  // 不调 start()：它会给首次开口设 10 分钟缓冲（not-yet），这测试只关心 min-gap 拉长。
  // 注意 ask 只「问」不记，lastAt 由 note() 在开口成功后记——跟宿主的真实调用顺序一致。
  // 没被晾：minGap=10min
  let r = inst.ask('nudge')
  assert.ok(r.ok === true, '首次可开口: ' + JSON.stringify(r))
  inst.note('nudge')
  // 5 分钟后再想开口 → min-gap 10 分钟挡住
  t += 5 * 60 * 1000
  r = inst.ask('nudge')
  assert.equal(r.ok, false)
  assert.ok(Math.abs(r.waitMs - 5 * 60 * 1000) < 1000, '无冷落 waitMs=剩余 minGap: ' + r.waitMs)
  // 被晾 2 次：gap = 10min × 1.8 = 18min
  snub = 2
  t += 5 * 60 * 1000   // now距上次开口 10min，gap 18min → 仍挡
  r = inst.ask('nudge')
  assert.equal(r.ok, false, '被晾后间隔拉长应仍挡住: ' + JSON.stringify(r))
  assert.ok(r.waitMs > 7 * 60 * 1000, '拉长后的剩余等待应 > 7 分钟: ' + r.waitMs)
})
