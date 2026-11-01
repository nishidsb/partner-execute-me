const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const projects = require('../src/main/companion/projects')
const dayflow = require('../src/main/companion/dayflow')
const autonomy = require('../src/main/companion/autonomy')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xf-'))
const H = 3600000

/* ── projects ── */

test('projects：立项目→注入块→记进展→收尾→新项目（成长弧全链路）', () => {
  let s = { active: null, done: [] }
  const t = 1000000
  s = projects.ensure(s, ['量子纠错', 'B 站 UP 主', '味增汤做法'], t)
  assert.ok(s.active, '无项目时立起新项目')
  assert.ok(s.active.title.includes('量子纠错'), '选题来自话题池')
  const block = projects.blockOf(s)
  assert.ok(block.includes('进行中的小项目'), '注入块说明项目')
  assert.ok(block.includes('查资料'), '给出当前步骤')
  // 记 3 笔：还不到收尾
  for (let i = 0; i < 3; i++) s = projects.note(s, '进展' + i, t + i)
  let r = projects.maybeFinish(s, t)
  assert.equal(r.finished, null, '不满 4 笔不收尾')
  // 第 4 笔 → 收尾
  s = projects.note(s, '写完小结了', t + 3)
  r = projects.maybeFinish(s, t)
  assert.ok(r.finished, '攒够收尾')
  assert.equal(r.finished.title.includes('量子纠错'), true)
  assert.equal(s.active, null, 'active 清空')
  // 新一轮：避开刚做完的主题
  s = projects.ensure(s, ['量子纠错', '味增汤做法'], t)
  assert.ok(s.active.title.includes('味增汤'), '新项目避开刚做完的')
  assert.equal(s.done.length, 1)
})

test('projects：blockOf 无项目不出声；收尾临界提示', () => {
  assert.equal(projects.blockOf({ active: null }), '')
  const near = { active: { title: 'X', why: 'Y', steps: ['a', 'b'], noteIdx: 0, notes: [1, 2, 3], createdAt: 0, updatedAt: 0 } }
  const b = projects.blockOf(near)
  assert.ok(b.includes('快收尾了'), '临收尾给提示')
})

test('projects：持久化绕一圈，坏文件兜底，note 封顶', () => {
  const dir = tmp()
  const s = projects.ensure(projects.load(dir), ['某话题'], 1)
  projects.save(dir, s)
  const s2 = projects.load(dir)
  assert.ok(s2.active && s2.active.title.includes('某话题'))
  fs.writeFileSync(path.join(dir, 'projects.json'), '{bad')
  assert.equal(projects.load(dir).active, null, '坏文件回到空状态')
  // note 封顶
  let s3 = projects.ensure({ active: null, done: [] }, ['t'], 1)
  for (let i = 0; i < 30; i++) s3 = projects.note(s3, 'n' + i, 1)
  assert.equal(s3.active.notes.length, projects.NOTE_CAP)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('projects：create 实例 block/record/status 联动', () => {
  const dir = tmp()
  const p = projects.create({ wsDir: () => dir, now: () => 1000, log: () => { } })
  const b1 = p.block(['话题甲'])
  assert.ok(b1.includes('话题甲'))
  for (let i = 0; i < 4; i++) p.record('第' + i + '笔进展')
  const st = p.status()
  assert.equal(st.active, null, '4 笔后收尾')
  assert.equal(st.doneCount, 1)
  const b2 = p.block(['话题乙'])
  assert.ok(b2.includes('话题乙'), '收尾后 block 立新项目')
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ── dayflow ── */

test('dayflow：phaseOf 六段全覆盖', () => {
  const mk = (h) => new Date(2026, 9, 30, h, 0, 0).getTime()
  assert.equal(dayflow.phaseOf(mk(3)).key, 'night')
  assert.equal(dayflow.phaseOf(mk(6)).key, 'dawn')
  assert.equal(dayflow.phaseOf(mk(10)).key, 'morning')
  assert.equal(dayflow.phaseOf(mk(13)).key, 'noon')
  assert.equal(dayflow.phaseOf(mk(16)).key, 'afternoon')
  assert.equal(dayflow.phaseOf(mk(20)).key, 'evening')
  assert.equal(dayflow.phaseOf(mk(23)).key, 'night')
  assert.ok(dayflow.phaseBlockOf(mk(3)).includes('深夜'), '深夜块有状态语气')
  assert.ok(dayflow.phaseBlockOf(mk(10)).includes('上午'))
})

test('dayflow：last-chat 记录与 gapBlock 阈值', () => {
  const dir = tmp()
  const t0 = new Date(2026, 9, 30, 10, 0, 0).getTime()
  const r = dayflow.noteOwner(dir, '我在研究固态电池的电解质', t0)
  assert.equal(r.newDay, true, '首次记录算新一天')
  // 2 小时后：太近不出声
  const prev = dayflow.loadLast(dir)
  assert.ok(prev.text.includes('固态电池'))
  assert.equal(dayflow.gapBlockOf(prev, t0 + 2 * H), '', '隔 2 小时不算「上次」')
  // 6 小时后：出声
  const g = dayflow.gapBlockOf(prev, t0 + 6 * H)
  assert.ok(g.includes('固态电池'), '隔 6 小时接旧话头')
  assert.ok(g.includes('6 小时'))
  // 隔天
  const g2 = dayflow.gapBlockOf(prev, t0 + 30 * H)
  assert.ok(g2.includes('隔了1天'), '超过 24 小时按天说')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('dayflow：跨天判定（同一天第二次说话不算新天）', () => {
  const dir = tmp()
  const d1 = new Date(2026, 9, 30, 10, 0, 0).getTime()
  const d1b = new Date(2026, 9, 30, 18, 0, 0).getTime()
  const d2 = new Date(2026, 10, 1, 9, 0, 0).getTime()
  assert.equal(dayflow.noteOwner(dir, '早上好', d1).newDay, true)
  assert.equal(dayflow.noteOwner(dir, '晚上好', d1b).newDay, false, '同一天不算新天')
  assert.equal(dayflow.noteOwner(dir, '第二天好', d2).newDay, true, '隔天算新天')
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ── autonomy 集成 ── */

test('runSpace：项目块与时间感进系统提示词', async () => {
  let sysTxt = ''
  const llm = {
    chatStream: async ({ messages }) => {
      if (!sysTxt) sysTxt = String(messages[0].content)
      return { content: '整理了一下笔记。', toolResults: [] }
    }
  }
  const r = await autonomy.runSpace({
    topic: '某话题', dir: '/tmp/ws', log: () => {}, now: new Date(2026, 9, 30, 15, 0, 0).getTime(),
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    journal: () => {}, openUrl: async () => {}, userBack: () => false,
    projBlock: '你有个进行中的小项目：《弄清楚「某话题"」》。'
  })
  assert.equal(r && r.ok, true)
  assert.ok(sysTxt.includes('进行中的小项目'), 'projBlock 注入')
  assert.ok(sysTxt.includes('【时间感】'), '时间感注入')
  assert.ok(sysTxt.includes('下午'), '时间段正确')
})

test('autonomy.create + projects：收尾后 status 可见、并立新项目', async () => {
  const dir = tmp()
  const t0 = 1000000
  let t = t0
  let fgN = 0
  const inst = autonomy.create({
    cfgGet: () => ({ autonomyOn: true, autonomyIdleMin: 1 }),
    log: () => { },
    idleSec: () => 99999,
    busy: () => false,
    pool: () => ({ themes: ['话题甲'] }),
    now: () => t,
    rand: () => 0.99,
    cua: { invoke: async () => ({}) },
    openUrl: async () => { },
    foreground: async () => {
      fgN++
      return { pn: 'msedge', title: fgN === 1 ? '起点' : '话题甲 - 知乎', hwnd: 100 + fgN }
    },
    projects: projects.create({ wsDir: () => dir, now: () => t, log: () => { } })
  })
  t = t0 + 50 * H
  // 连跑 4 场（每场记一笔）→ 第 4 场收尾
  for (let i = 0; i < 4; i++) { t += 3 * H; await inst.tick() }
  const st = inst.status()
  assert.ok(st.project, 'status 带项目面板')
  assert.equal(st.project.doneCount, 1, '4 场后项目收尾：' + JSON.stringify(st.project))
  fs.rmSync(dir, { recursive: true, force: true })
})
