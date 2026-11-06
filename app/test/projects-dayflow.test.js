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

/* ── projects v2（0.46.64 五类型/生命周期/成果硬闸） ── */

test('projects v2：立项目→注入块→记进展→声明完成→收尾→新项目', () => {
  let s = { active: null, done: [] }
  const t = 1000000
  s = projects.ensure(s, ['量子纠错', 'B 站 UP 主', '味增汤做法'], t, () => 0)   // rand=0 → research
  assert.ok(s.active, '无项目时立起新项目')
  assert.equal(s.active.type, 'research')
  assert.ok(s.active.title.includes('量子纠错'), '选题来自话题池')
  const block = projects.blockOf(s)
  assert.ok(block.includes('进行中的小项目'), '注入块说明项目')
  assert.ok(block.includes('查资料'), '给出当前步骤')
  assert.ok(block.includes('【成果】'), '收尾协议注入')
  assert.ok(block.includes('跳过步骤'), '许可跳步/改向')
  // v2 没有「攒笔自动完成」：记再多笔也只有她声明完成才收
  for (let i = 0; i < 6; i++) s = projects.note(s, '进展' + i, t + i)
  assert.ok(s.active, '攒笔不再自动收尾')
  // 收尾协议解析
  const pc = projects.parseClose('写了小结。【状态】完成【心情】挺踏实的')
  assert.equal(pc.status, '完成')
  assert.equal(pc.mood, '挺踏实的')
  assert.equal(pc.clean, '写了小结。', '协议标记不漏进她说出口的话')
  // research 声明完成 → 总结收尾（不需要文件）
  const r = projects.recordLifecycle(s, pc.clean, pc, t + 9, { verify: () => true })
  assert.ok(r.finished, '声明完成→收尾')
  assert.equal(r.finished.outcome, 'finished')
  assert.equal(r.state.active, null, 'active 清空')
  assert.ok(r.state.done[0].title.includes('量子纠错'))
  // 新一轮：避开刚做完的主题
  s = projects.ensure(r.state, ['量子纠错', '味增汤做法'], t, () => 0)
  assert.ok(s.active.title.includes('味增汤'), '新项目避开刚做完的')
  assert.equal(s.done.length, 1)
})

test('projects：blockOf 无项目不出声；搁置态有专属话术', () => {
  assert.equal(projects.blockOf({ active: null }), '')
  const near = { active: { title: 'X', why: 'Y', type: 'writing', steps: ['a', 'b'], noteIdx: 0, notes: [1, 2, 3], createdAt: 0, updatedAt: 0 } }
  const b = projects.blockOf(near)
  assert.ok(b.includes('做完」的标准'), '注入做完标准')
  assert.ok(b.includes('真实文件'), '没文件不许说完成')
  const pb = projects.blockOf({ active: { ...near.active, status: 'paused', pauseReason: '没灵感' } })
  assert.ok(pb.includes('搁置'), '搁置态有专属话术')
  assert.ok(pb.includes('捡起来'), '给恢复的出口')
})

test('projects：v1 旧数据无损升级（逐字段兜底）', () => {
  const s = projects.normalize({
    active: { title: '弄清楚「量子」', why: '好奇', steps: ['a', 'b', 'c'], noteIdx: 1, notes: ['旧进展'], createdAt: 5, updatedAt: 5 },
    done: [{ title: '旧项目', summary: 's', finishedAt: 9 }]
  })
  assert.equal(s.active.type, 'research', 'v1 无 type → research')
  assert.equal(s.active.status, 'active')
  assert.deepEqual(s.active.artifacts, [])
  assert.deepEqual(s.active.mood, [])
  assert.equal(s.done[0].type, 'research')
  assert.equal(s.done[0].outcome, 'finished')
})

test('projects：五类型模板与选题加权', () => {
  assert.equal(projects.TYPES.length, 5)
  for (const t of projects.TYPES) {
    const tpl = projects.TYPE_TEMPLATES[t]
    assert.ok(tpl.steps.length >= 3, t + ' 有默认步骤')
    assert.ok(tpl.finishHint.length > 4, t + ' 有做完标准')
    const p = projects.newProject('某题', 1, t)
    assert.equal(p.type, t)
    assert.equal(p.status, 'active')
    assert.deepEqual(p.artifacts, [])
    assert.ok(p.title.length > 0)
  }
  // 无主题也有兜底题目
  const p = projects.newProject('', 1, 'organize')
  assert.ok(p.title.includes('理一理'))
  // 选题避开上一个类型（连续两单同型不像活人）
  const seen = new Set()
  for (let i = 0; i < 40; i++) seen.add(projects.pickType(() => 0.99, 'research'))
  assert.ok(!seen.has('research'), '上一个类型被避开后不再出现：' + [...seen].join(','))
})

test('projects：完成硬闸（writing/collection 无真实文件不许收尾）', () => {
  const mkWriting = () => projects.normalize({
    active: { title: '写一篇', type: 'writing', status: 'active', steps: ['a', 'b', 'c'], noteIdx: 0, notes: ['写完了'], artifacts: [], mood: [], createdAt: 1, updatedAt: 1 },
    done: []
  })
  // 完全没有成果
  let s = mkWriting()
  let r = projects.finishProject(s, 10, () => true)
  assert.equal(r.finished, null, '没有成果不许收尾')
  assert.ok(r.blocked.includes('成果文件'))
  // 有记录但校验不过（空文件/不在地盘）
  s.active.artifacts = [{ path: '作品.md', kind: 'final', at: 5 }]
  r = projects.finishProject(s, 10, () => false)
  assert.equal(r.finished, null, '校验不过不收尾')
  assert.ok(r.blocked.includes('校验'))
  // 没有校验器也不许收尾（fail-safe）
  r = projects.finishProject(s, 10, null)
  assert.equal(r.finished, null)
  // 校验过了 → 放行
  r = projects.finishProject(s, 10, () => true)
  assert.ok(r.finished, '文件真实存在→放行')
  assert.equal(r.state.active, null)
  // research/conceive/organize 允许总结收尾（成果本来就可以不是文件）
  const rs = projects.normalize({
    active: { title: '弄清楚', type: 'research', status: 'active', steps: ['a'], noteIdx: 0, notes: ['明白了'], artifacts: [], mood: [], createdAt: 1, updatedAt: 1 },
    done: []
  })
  r = projects.finishProject(rs, 10, null)
  assert.ok(r.finished, 'research 总结收尾不需要文件')
})

test('projects：搁置→继续→改向→放弃 全保留', () => {
  const mk = () => projects.normalize({
    active: { title: 'A', type: 'research', status: 'active', steps: ['s1', 's2', 's3'], noteIdx: 0, notes: [], artifacts: [], mood: [], createdAt: 1, updatedAt: 1 },
    done: []
  })
  let s = mk()
  s = projects.pauseProject(s, '没灵感了', 2)
  assert.equal(s.active.status, 'paused')
  assert.equal(s.active.pauseReason, '没灵感了')
  s = projects.resumeProject(s, 3)
  assert.equal(s.active.status, 'active')
  s = projects.redirectProject(s, 'B 方向', 4)
  assert.equal(s.active.title, 'B 方向')
  assert.ok(s.active.why.includes('换了方向'))
  assert.equal(s.active.noteIdx, 0, '改向重铺步骤')
  s.active.notes = ['进展一']
  s.active.artifacts = [{ path: 'x.md', kind: 'stage', at: 5 }]
  const r = projects.abandonProject(s, 6)
  assert.equal(r.state.active, null)
  assert.equal(r.abandoned.outcome, 'abandoned', '放弃进 done 且标记')
  assert.equal(r.abandoned.summary, '进展一', '放弃时过程保留')
  assert.equal(r.abandoned.artifacts.length, 1, '放弃时成果保留')
})

test('projects：recordLifecycle 走协议（成果入账/坏路径拒收/搁置/完成/放弃）', () => {
  const mk = () => projects.normalize({
    active: { title: 'A', type: 'writing', status: 'active', steps: ['s1', 's2', 's3'], noteIdx: 0, notes: [], artifacts: [], mood: [], createdAt: 1, updatedAt: 1 },
    done: []
  })
  const okVerify = () => true
  let s = mk()
  // 成果入账 + 心情
  let r = projects.recordLifecycle(s, '写了一段。【成果】notes/a.md【心情】有点兴奋', projects.parseClose('写了一段。【成果】notes/a.md【心情】有点兴奋'), 2, { verify: okVerify })
  assert.equal(r.state.active.artifacts.length, 1)
  assert.equal(r.state.active.artifacts[0].path, 'notes/a.md')
  assert.equal(r.state.active.artifacts[0].kind, 'stage', '非完成态记 stage')
  assert.equal(r.state.active.mood[0].feeling, '有点兴奋')
  assert.equal(r.event, '')
  // 坏路径不入账（拒绝逻辑在 verifyArtifact，这里模拟越界路径被拒）
  const pickyVerify = (rel) => !String(rel).includes('..')
  r = projects.recordLifecycle(r.state, '存了点东西。【成果】../../etc/passwd', projects.parseClose('存了点东西。【成果】../../etc/passwd'), 3, { verify: pickyVerify })
  assert.equal(r.state.active.artifacts.length, 1, '校验不过的路径不入账')
  // 搁置
  r = projects.recordLifecycle(r.state, '先放放。【状态】搁置', projects.parseClose('先放放。【状态】搁置'), 4, { verify: okVerify })
  assert.equal(r.event, '搁置')
  assert.equal(r.state.active.status, 'paused')
  // 继续
  r = projects.recordLifecycle(r.state, '接着写。【状态】继续', projects.parseClose('接着写。【状态】继续'), 5, { verify: okVerify })
  assert.equal(r.event, '继续')
  // 完成：有校验过的真实成果 → 放行
  r = projects.recordLifecycle(r.state, '写完了。【状态】完成【成果】notes/a.md', projects.parseClose('写完了。【状态】完成【成果】notes/a.md'), 6, { verify: okVerify })
  assert.ok(r.finished, '有校验过的真实成果→放行')
  assert.equal(r.state.active, null)
  // 放弃
  r = projects.recordLifecycle(mk(), '不想要了。【状态】放弃', projects.parseClose('不想要了。【状态】放弃'), 7, { verify: okVerify })
  assert.equal(r.event, '放弃')
  assert.equal(r.abandoned.outcome, 'abandoned')
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

test('projects：create 实例 block/record/status 联动（v2）', () => {
  const dir = tmp()
  const p = projects.create({ wsDir: () => dir, now: () => 1000, log: () => { }, rand: () => 0 })
  const b1 = p.block(['话题甲'])
  assert.ok(b1.includes('话题甲'))
  const r = p.record('告一段落。', projects.parseClose('告一段落。【状态】完成'), { spaceDir: '' })
  assert.ok(r.finished, 'research 声明完成即收尾')
  const st = p.status()
  assert.equal(st.active, null)
  assert.equal(st.doneCount, 1)
  const b2 = p.block(['话题乙'])
  assert.ok(b2.includes('话题乙'), '收尾后 block 立新项目')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('projects：extras 搁置/放弃项目进选题池尾部', () => {
  const dir = tmp()
  const p = projects.create({ wsDir: () => dir, now: () => 1000, log: () => { }, rand: () => 0 })
  p.block(['话题甲'])
  p.record('先放着。【状态】搁置', null, {})
  assert.ok(p.extras().join(' ').includes('搁置'), '搁置项目进 extras')
  p.record('捡回来。【状态】继续', null, {})
  p.record('不要了。【状态】放弃', null, {})
  assert.ok(p.extras().join(' ').includes('放着了'), '放弃项目进 extras')
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

test('autonomy.create + projects：4 场记 4 笔，v2 不再攒笔自动收尾', async () => {
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
  // 连跑 4 场（每场记一笔）→ v2 靠声明收尾，攒笔不算
  for (let i = 0; i < 4; i++) { t += 3 * H; await inst.tick() }
  const st = inst.status()
  assert.ok(st.project, 'status 带项目面板')
  assert.equal(st.project.active.notes, 4, '4 场记 4 笔：' + JSON.stringify(st.project))
  assert.equal(st.project.doneCount, 0, 'v2 攒笔不自动收尾')
  fs.rmSync(dir, { recursive: true, force: true })
})
