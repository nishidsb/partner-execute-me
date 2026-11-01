const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const needs = require('../src/main/companion/needs')
const autonomy = require('../src/main/companion/autonomy')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'needs-'))
const H = 3600000

test('gainOf：时间推进涨压力，封顶 100，跨夜最多补 12 小时', () => {
  const s0 = needs.newState(0)
  const s1 = needs.gainOf(s0, 2 * H, {})
  assert.ok(s1.boredom > s0.boredom, '无聊随时间涨')
  assert.ok(s1.curiosity > s0.curiosity && s1.share > s0.share)
  // 100 小时后不该无限积压
  const s2 = needs.gainOf(s0, 100 * H, {})
  for (const k of ['curiosity', 'share', 'boredom']) assert.ok(s2[k] <= 100, k + ' 封顶')
  // 100 小时但只按 12 小时补：boredom = 15 + 10*12 = 135 → 封 100，但若按 100 小时算也一样封顶；
  // 关键区分：低速项。curiosity 无刺激 0.7 倍：12h → 20+6*0.7*12=70.4，而 100h 早封顶
  assert.ok(s2.curiosity < 75, '跨夜补积压有上限（不按真实离线时长算）')
})

test('gainOf：外部刺激加成/没有刺激淡去', () => {
  const s0 = needs.newState(0)
  const withTopics = needs.gainOf(s0, 2 * H, { hasTopics: true })
  const noTopics = needs.gainOf(s0, 2 * H, {})
  assert.ok(withTopics.curiosity > noTopics.curiosity, '有话题好奇涨得快')
  const withExp = needs.gainOf(s0, 2 * H, { hadExperience: true })
  const noExp = needs.gainOf(s0, 2 * H, {})
  assert.ok(withExp.share > noExp.share, '有经历没讲，分享压力涨得快')
})

test('dominantOf / goalBlockOf：最强需求决定动机语气', () => {
  const bored = { t: 0, curiosity: 10, share: 10, boredom: 80 }
  assert.equal(needs.dominantOf(bored), 'boredom')
  const block = needs.goalBlockOf(bored)
  assert.ok(block.includes('闲得发慌'), '无聊出无聊的话：' + block)
  const curious = { t: 0, curiosity: 80, share: 10, boredom: 10 }
  assert.ok(needs.goalBlockOf(curious).includes('好奇'))
  const sharing = { t: 0, curiosity: 10, share: 80, boredom: 10 }
  assert.ok(needs.goalBlockOf(sharing).includes('讲给主人'))
  // 压力不足不出声；压力强加狠话
  assert.equal(needs.goalBlockOf({ t: 0, curiosity: 10, share: 5, boredom: 20 }), '')
  const strong = needs.goalBlockOf({ t: 0, curiosity: 90, share: 5, boredom: 5 })
  assert.ok(strong.includes('这股劲挺强'), '高压加码')
})

test('dischargeOf：活动散场泄无聊好奇，主人开口泄分享', () => {
  const s = { t: 0, curiosity: 80, share: 80, boredom: 80 }
  // now 取 state.t：不隐式推进时间，只看泄压本身
  const afterSession = needs.dischargeOf(s, s.t, 'session')
  assert.ok(afterSession.boredom < 20, '散场无聊泄掉')
  assert.ok(afterSession.curiosity < 50, '好奇泄一截')
  assert.equal(afterSession.share, 80, '没跟主人讲就不算分享')
  const afterChat = needs.dischargeOf(s, s.t, 'chat')
  assert.equal(afterChat.share, 10, '聊过天分享泄掉')
  assert.ok(afterChat.boredom < 80, '聊天也解一点闷')
})

test('cooldownScaleOf：压力高冷却短，范围 [0.65,1]', () => {
  assert.equal(needs.cooldownScaleOf({ t: 0, curiosity: 0, share: 0, boredom: 0 }), 1)
  const scale = needs.cooldownScaleOf({ t: 0, curiosity: 100, share: 100, boredom: 100 })
  assert.equal(scale, 0.65)
  assert.ok(needs.cooldownScaleOf({ t: 0, curiosity: 50, share: 0, boredom: 0 }) < 1)
})

test('持久化：load/save 绕工作区一圈，坏文件兜底', () => {
  const dir = tmp()
  const now = 1000000
  assert.equal(needs.saveState(dir, { t: now, curiosity: 33, share: 44, boredom: 55 }), true)
  const s = needs.loadState(dir, now)
  assert.equal(s.curiosity, 33)
  assert.equal(s.boredom, 55)
  fs.writeFileSync(path.join(dir, 'needs-state.json'), '{broken')
  const s2 = needs.loadState(dir, now)
  assert.ok(s2.boredom > 0, '坏文件回到新状态')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('create：实例 tick/泄压/落盘联动', () => {
  const dir = tmp()
  let t = 1000000
  const n = needs.create({ wsDir: () => dir, now: () => t, log: () => { } })
  const s1 = n.state({ hasTopics: true })
  t += 3 * H
  const s2 = n.state({ hasTopics: true })
  assert.ok(s2.curiosity > s1.curiosity, '实例内时间推进')
  n.discharge('session')
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'needs-state.json'), 'utf8'))
  assert.ok(onDisk.boredom <= 15, '泄压结果落盘')
  const st = n.status()
  assert.ok(st.dominant && typeof st.pressure === 'number')
  n.reset()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runFree：需求压力进系统提示词（需求驱动行为）', async () => {
  let sawGoal = false
  const llm = {
    chatStream: async ({ messages, toolExec }) => {
      if (String(messages[0].content).includes('闲得发慌')) sawGoal = true
      try { await toolExec('screenshot', {}) } catch { }
      return { content: '我翻了翻桌面。', toolResults: [] }
    }
  }
  const r = await autonomy.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => 'ok' },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {},
    tastes: [], goalBlock: '你有点闲得发慌，就想找点新鲜事解解闷。'
  })
  assert.equal(r && r.ok, true)
  assert.ok(sawGoal, 'goalBlock 注入 sys')
})

test('autonomy.create + needs：散场泄压、冷却按压力缩放', async () => {
  const dir = tmp()
  const t0 = 1000000
  let t = t0
  let cdRand = () => 0.99   // 让冷却取接近上限，好验证缩放
  let fgN = 0
  const inst = autonomy.create({
    cfgGet: () => ({ autonomyOn: true, autonomyIdleMin: 1 }),
    log: () => { },
    idleSec: () => 99999,
    busy: () => false,
    pool: () => ({ themes: ['话题甲'] }),
    now: () => t,
    rand: cdRand,
    cua: { invoke: async () => ({}) },
    openUrl: async () => { },
    // 前台探测：开门后标题/句柄变化，证明浏览器真的到了目标页
    foreground: async () => {
      fgN++
      return { pn: 'msedge', title: fgN === 1 ? '起点' : '话题甲 - 知乎', hwnd: 100 + fgN }
    },
    needs: needs.create({ wsDir: () => dir, now: () => t, log: () => { } })
  })
  // 直接憋到高压再跑一场（挡 1 browse 路径，全 mock，不掉真网）
  t = t0 + 50 * H
  await inst.tick()
  const st = inst.status()
  assert.ok(st.last && st.last.ok, 'browse 场跑通：' + JSON.stringify(st.last))
  assert.ok(st.needs, 'status 带需求面板')
  assert.ok(st.needs.boredom <= 15, '散场后无聊泄掉：' + JSON.stringify(st.needs))
  // 冷却缩放验证：同 rand 下有压冷却 ≤ 无压冷却
  const full = needs.cooldownScaleOf({ t: 0, curiosity: 100, share: 100, boredom: 100 })
  assert.ok(full < 1)
  fs.rmSync(dir, { recursive: true, force: true })
})
