'use strict'
/** 第 2+3 期：人格演化提案（做梦→提案→批准→写入→回滚）+ 工具自迭代纯校验 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dream = require('../src/main/companion/dream')
const review = require('../src/main/companion/review')
const self = require('../src/main/companion/self')
const ut = require('../src/main/assistant/userTools')

const T0 = new Date('2026-10-27T10:00:00').getTime()

/* ---------------- 第 2 期：做梦提案 ---------------- */

test('dream：解析 [提案] 行（方面/现状/想改成/理由，超长截断）', () => {
  const out = dream.parseDream(
    '[习惯] 深夜写代码\n' +
    '[提案] 说话风格｜句子偏长爱解释｜多用短句直说｜主人这几天回了三次「太长了」\n' +
    '[提案] 性格｜温柔｜变成高冷｜（不该被接受：没有证据也要拒）\n'
  )
  assert.equal(out.proposals.length, 2)
  const p = out.proposals[0]
  assert.equal(p.aspect, '说话风格')
  assert.equal(p.current, '句子偏长爱解释')
  assert.equal(p.proposed, '多用短句直说')
  assert.ok(p.reason.includes('太长了'))
  // 没有提案时字段仍是数组（宿主循环不炸）
  assert.deepEqual(dream.parseDream('[无]').proposals, [])
})

test('dream：提示词含提案格式与禁区（性格/人设不能提案）', () => {
  assert.ok(dream.DREAM_PROMPT.includes('[提案]'))
  assert.ok(dream.DREAM_PROMPT.includes('性格'))
  assert.ok(dream.DREAM_PROMPT.includes('动不了') || dream.DREAM_PROMPT.includes('不能'))
})

test('dream：有提案时收尾台词点名「提案」；没有时维持原样', () => {
  const withP = dream.closingLine('zh', { habits: [], likes: [], dislikes: [], memories: [], proposals: [{}] })
  const noP = dream.closingLine('zh', { habits: [], likes: [], dislikes: [], memories: [], proposals: [] })
  assert.ok(withP.includes('提案'))
  assert.ok(!noP.includes('提案'))
})

test('dream：开了自动批准时，收尾台词不再说「你来决定」（提案已自动收下）', () => {
  const counts = { habits: [], likes: [], dislikes: [], memories: [], proposals: [{}] }
  const auto = dream.closingLine('zh', counts, { auto: true })
  assert.ok(!auto.includes('你来决定'), '不能再说空话：' + auto)
  assert.ok(!auto.includes('审查册'), '自动批准下东西已收好，不在册子里等人看：' + auto)
  const manual = dream.closingLine('zh', counts, { auto: false })
  assert.ok(manual.includes('你来决定'), '没开自动批准时保持原来的询问')
  const autoJa = dream.closingLine('ja', counts, { auto: true })
  assert.ok(!autoJa.includes('君が決めて'), '日文同理：' + autoJa)
})

test('review：persona 条目带结构化 diff 字段且参与去重', () => {
  let items = []
  const r1 = review.enqueue(items, {
    kind: 'persona', what: '说话风格：多用短句',
    payload: '现状：句子偏长 → 想改成：多用短句', reason: '做梦回顾',
    aspect: '说话风格', current: '句子偏长', proposed: '多用短句', evidence: '主人说太长了'
  }, T0)
  assert.equal(r1.dup, false)
  assert.equal(r1.item.aspect, '说话风格')
  assert.equal(r1.item.proposed, '多用短句')
  items = r1.items
  const r2 = review.enqueue(items, {
    kind: 'persona', what: '说话风格：多用短句',
    payload: '现状：句子偏长 → 想改成：多用短句',
    aspect: '说话风格', current: '句子偏长', proposed: '多用短句'
  }, T0 + 60000)
  assert.equal(r2.dup, true, '同提案 pending 期不重复入队')
})

/* ---------------- 第 2 期：persona.json 落地（真实临时目录） ---------------- */

test('self：applyPersona 同方面旧条目退位 + promptBlock 注入她想成为的样子', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-persona-'))
  self.applyPersona(dir, { aspect: '说话风格', current: '句子长', proposed: '多用短句' }, '2026-10-26')
  self.applyPersona(dir, { aspect: '说话风格', current: '短句', proposed: '偶尔用颜文字收尾' }, '2026-10-27')
  const list = self.getPersona(dir)
  assert.equal(list.length, 2)
  assert.equal(list[0].active, false, '同方面旧提案退位不删档')
  assert.equal(list[1].active, true)
  // promptBlock：active 的要出现，退位的不出现
  const block = self.promptBlock(dir, {})
  assert.ok(block.includes('偶尔用颜文字收尾'))
  assert.ok(!block.includes('多用短句（'))
  assert.ok(block.includes('你想成为的样子'))
  // 回滚 = 直接把快照写回（review.rollback 已测），这里验证快照文件内容可还原
  const f = path.join(dir, 'self', 'persona.json')
  const before = fs.readFileSync(f, 'utf8')
  self.applyPersona(dir, { aspect: '称呼', current: '', proposed: '叫主人全名' }, '2026-10-27')
  fs.writeFileSync(f, before, 'utf8')
  assert.equal(self.getPersona(dir).length, 2)
})

/* ---------------- 第 3 期：工具自迭代纯校验 ---------------- */

test('userTools：名字白名单（拒路径注入/大写/太短/太长）', () => {
  assert.equal(ut.validateName('zip_pics'), true)
  assert.equal(ut.validateName('a'), false)
  assert.equal(ut.validateName('Abc'), false)
  assert.equal(ut.validateName('../evil'), false)
  assert.equal(ut.validateName('a'.repeat(33)), false)
  assert.equal(ut.validateName(''), false)
})

test('userTools：代码校验（必须 CommonJS 导出、限长、非空）', () => {
  assert.equal(ut.checkCode('module.exports = async (args) => 1'), '')
  assert.ok(ut.checkCode('const x = 1').includes('module.exports'))
  assert.ok(ut.checkCode('').length > 0)
  assert.ok(ut.checkCode('//' + 'x'.repeat(33000) + '\nmodule.exports=1').includes('太长'))
})

/* ---------------- 第 3 期：写→跑→部署→快照 全链（真实临时目录+子进程） ---------------- */

test('userTools：全链——返回值回传 / 异常堆栈回传 / 部署先快照 / 改动即停用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-ut-chain-'))
  ut.init(dir)
  const w = ut.write({
    name: 'hello_chain', description: '测试', parameters: '{}',
    code: 'module.exports = async (args) => ({ hi: (args && args.name) || "world" })'
  })
  assert.equal(w.ok, true, '写工具要成功：' + (w.error || ''))
  assert.equal(w.enabled, false, '新工具默认停用')
  ut.write({ name: 'boom_chain', description: 't', parameters: '{}', code: 'module.exports = async () => { throw new Error("炸了") }' })

  const r1 = await ut.run({ name: 'hello_chain', argsJson: JSON.stringify({ name: '莱莎' }) })
  assert.equal(r1.ok, true)
  assert.deepEqual(r1.result, { hi: '莱莎' }, '工具返回值必须原样回传')
  const r2 = await ut.run({ name: 'boom_chain', argsJson: '' })
  assert.equal(r2.ok, false)
  assert.ok(/炸了/.test(r2.error), '异常要带堆栈回传（自修复循环靠它）: ' + r2.error)

  const d = ut.deploy('hello_chain')
  assert.equal(d.ok, true)
  assert.ok(d.snapshot && fs.existsSync(d.snapshot), '部署前必须留下 data 快照')
  const snaps = fs.readdirSync(path.join(dir, 'backups')).filter((n) => n.startsWith('data-'))
  assert.equal(snaps.length, 1)
  assert.equal(ut.manifest().hello_chain.enabled, true)

  const w2 = ut.write({ name: 'hello_chain', description: '改一版', parameters: '{}', code: 'module.exports = async () => 2' })
  assert.equal(w2.version, 2, '改动升版本')
  assert.equal(ut.manifest().hello_chain.enabled, false, '改动后回到停用（重新部署要再批准）')

  const u = ut.undeploy('hello_chain')
  assert.equal(u.ok, true)
  const rm = ut.remove('boom_chain')
  assert.equal(rm.ok, true)
  assert.ok(!ut.manifest().boom_chain, '删除后 manifest 里没有它')
})
