/**
 * 0.22.0 记忆强度（衰减/强化/分级呈现）+ 黏人模式状态机
 * 用户语义：长期做同样的事→默认记住；时不时做→忘细节但大体记得；
 * 长期不做→只剩最低程度的记忆；重要的事才默认一直记住。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/* ---------------- 核心 memoryStore（ESM） ---------------- */
const IMP = (p) => 'file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', p).replace(/\\/g, '/')
let M = null
let cfgMod = null
async function mem () {
  if (!M) {
    cfgMod = await import(IMP('config.js'))
    M = await import(IMP('memory/memoryStore.js'))
  }
  return M
}

async function sandbox () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-decay-'))
  await mem()
  cfgMod.initDataDir(dir)
  return dir
}

const DAY = 86400000

test('强度：新记忆接近满，久没想起按 7 天一档衰减，下限 0.15 不完全忘掉', async () => {
  const { effectiveStrength, STRENGTH_FLOOR } = await mem()
  const f = { text: '用户喜欢草莓牛奶', importance: 2, at: 1000 }
  const fresh = effectiveStrength(f, 1000 + DAY)
  assert.ok(fresh > 0.6, '刚记下时还算清楚：' + fresh)
  const half = effectiveStrength(f, 1000 + 30 * DAY)
  assert.ok(half < fresh, '一个月没想起会衰减')
  const ancient = effectiveStrength(f, 1000 + 365 * DAY)
  assert.equal(ancient, STRENGTH_FLOOR, '一年没想起只剩最低程度，但不会归零')
})

test('重要的事（约定/关系/重要度5）永不衰减', async () => {
  const { effectiveStrength, isSticky, levelOf } = await mem()
  for (const f of [
    { text: '约好明天去钓鱼', importance: 5, cat: 'fact', at: 1000 },
    { text: '互相告白成为恋人', importance: 3, cat: 'relation', at: 1000 },
    { text: '答应送她礼物', importance: 2, cat: 'promise', at: 1000 }
  ]) {
    assert.ok(isSticky(f), f.text)
    assert.equal(effectiveStrength(f, 1000 + 400 * DAY), 1)
    assert.equal(levelOf(f, 1000 + 400 * DAY), 0, '重要的事始终全文：' + f.text)
  }
})

test('分级呈现：全文 → 大概记得 → 只剩个印象', async () => {
  const { renderFact } = await mem()
  const long = '用户把珍藏的模型送给了她，并且说这是很重要的东西，希望她好好保管。'
  const base = Date.now() - DAY
  const full = { text: long, importance: 2, strength: 0.9, lastAt: base, at: base }
  assert.equal(renderFact(full, base + DAY), long, '经常想起 = 全文')
  const mid = { text: long, importance: 2, strength: 0.45, lastAt: base, at: base }
  const m = renderFact(mid, base + DAY)
  assert.match(m, /大概记得/)
  assert.ok(m.includes('用户把珍藏'), '概要保留开头')
  const low = { text: long, importance: 2, strength: 0.2, lastAt: base, at: base }
  const l = renderFact(low, base + DAY)
  assert.match(l, /只剩个印象/)
  assert.ok(l.length < 40, '痕迹很短：' + l)
})

test('强化：同一件事再发生会顶回强度并刷新 lastAt；检索命中也强化', async () => {
  await sandbox()
  const { extractTurn, memory } = await mem()
  const roleId = 'decay-r1'
  const text = '明天下午三点一起去钓鱼吧，我们约好的。'
  extractTurn(roleId, text, '好呀')
  const before = memory.list(roleId).find((f) => f.cat === 'promise')
  assert.ok(before)
  const s0 = before.strength == null ? null : before.strength
  // 一段时间没想起（手动把 lastAt 拨回过去）
  const memPath = path.join(process.cwd(), '..', 'tmp-decay-ignore')
  // 直接改文件：把 strength/lastAt 拨老
  const file = JSON.parse(fs.readFileSync(path.join(cfgMod.dataPath('memory'), roleId + '.json'), 'utf8'))
  file.facts[0].strength = 0.3
  file.facts[0].lastAt = Date.now() - 40 * DAY
  fs.writeFileSync(path.join(cfgMod.dataPath('memory'), roleId + '.json'), JSON.stringify(file))
  // 同一件事再说一次 → 强化
  const added = extractTurn(roleId, text, '嗯，说好了')
  assert.equal(added.length, 0, '重复事件不重复记账')
  const after = memory.list(roleId).find((f) => f.cat === 'promise')
  assert.equal(M.effectiveStrength(after), 1, 'sticky 记忆永远清楚（约定不衰减）')
  assert.ok(after.lastAt > Date.now() - 60000, 'lastAt 刷新')
  assert.equal(after.hits, 1, 'hits 记数')
  // 检索命中也强化
  const file2 = JSON.parse(fs.readFileSync(path.join(cfgMod.dataPath('memory'), roleId + '.json'), 'utf8'))
  file2.facts[0].strength = 0.3
  file2.facts[0].lastAt = Date.now() - 40 * DAY
  fs.writeFileSync(path.join(cfgMod.dataPath('memory'), roleId + '.json'), JSON.stringify(file2))
  memory.search(roleId, '钓鱼', 5)
  const after2 = memory.list(roleId).find((f) => f.cat === 'promise')
  assert.ok(after2.lastAt > Date.now() - 60000, '检索命中也刷新时间')
  assert.equal(after2.hits, 2)
})

test('recallForPrompt：返回带 shown/level 的渲染行，sticky 恒全文', async () => {
  await sandbox()
  const { memory } = await mem()
  const roleId = 'decay-r2'
  memory.add(roleId, '明天三点去钓鱼（重要约定）', { cat: 'promise' })
  const rows = memory.recallForPrompt(roleId, '钓鱼', 5)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].level, 0, '约定永不衰减')
  assert.equal(rows[0].shown, rows[0].text)
})

test('decaySweep：把衰减后的强度落盘（设置页看得到）', async () => {
  await sandbox()
  const { memory, effectiveStrength } = await mem()
  const roleId = 'decay-r3'
  memory.add(roleId, '用户喜欢草莓牛奶', { importance: 2 })
  const file = path.join(cfgMod.dataPath('memory'), roleId + '.json')
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  doc.facts[0].strength = 0.8
  doc.facts[0].lastAt = Date.now() - 60 * DAY
  fs.writeFileSync(file, JSON.stringify(doc))
  const n = memory.decaySweep(roleId)
  assert.equal(n, 1)
  const after = memory.list(roleId)[0]
  assert.equal(after.strength, effectiveStrength(after), '落盘值 = 现算值')
})

/* ---------------- 桌宠 companion/memory（CJS 同构纯函数） ---------------- */
const cmem = require('../src/main/companion/memory')

test('桌宠侧同构：衰减/分级/重要不衰减与核心一致', () => {
  const f = { text: '用户喜欢草莓牛奶', importance: 2, at: 1000 }
  const fresh = cmem.effectiveStrength(f, 1000 + DAY)
  const ancient = cmem.effectiveStrength(f, 1000 + 365 * DAY)
  assert.ok(fresh > 0.6 && ancient < fresh)
  assert.equal(ancient === 0.15, true, '同一下限')
  const sticky = { text: '约好明天去钓鱼', importance: 5, at: 1000 }
  assert.equal(cmem.effectiveStrength(sticky, 1000 + 400 * DAY), 1)
  assert.equal(cmem.renderFact({ text: '一'.repeat(60), importance: 2, strength: 0.2, at: 0 }, 0).length < 40, true)
})

/* ---------------- 黏人模式（ohwhale 移植） ---------------- */
const nudge = require('../src/main/companion/idleNudge')

test('declaresSleep：「我要睡了」算，问句「你睡了吗」绝不算（ohwhale 修复的坑）', () => {
  assert.equal(nudge.declaresSleep('我去睡了，晚安'), true)
  assert.equal(nudge.declaresSleep('困了，先睡了'), true)
  assert.equal(nudge.declaresSleep('もう寝る、おやすみ'), true)
  assert.equal(nudge.declaresSleep('你睡了吗？'), false, '问句不是宣言')
  assert.equal(nudge.declaresSleep('困不困？要不要睡了？'), false)
  assert.equal(nudge.declaresSleep('晚安是什么意思'), false, '问句优先')
  assert.equal(nudge.declaresSleep(''), false)
  assert.equal(nudge.declaresSleep('今天天气不错'), false)
})

test('0.46.60 declaresSleep 主语守卫：安排「她」睡觉的不算主人宣言（11-06 19:06 实锤）', () => {
  // 当天事故原话：主语是她，关键词命中「困了/先睡」→ 误判主人去睡静默 7 小时
  assert.equal(nudge.declaresSleep('不过莱莎要是困了就先睡吧，有你定的闹钟就够了'), false, '睡词说的是莱莎')
  assert.equal(nudge.declaresSleep('你先睡吧'), false, '第二人称=在跟她说')
  assert.equal(nudge.declaresSleep('你困了就早点睡'), false)
  assert.equal(nudge.declaresSleep('她要是困了就躺下了，别管'), false)
  assert.equal(nudge.declaresSleep('你睡了没'), false, '无问句词的「你睡了」也不算')
  // 正常宣言不受影响
  assert.equal(nudge.declaresSleep('晚安，莱莎'), true, '称呼后置不影响宣言')
  assert.equal(nudge.declaresSleep('晚安莱莎，我去了'), true)
  assert.equal(nudge.declaresSleep('我困了，先睡了'), true)
  assert.equal(nudge.declaresSleep('おやすみ、ライザ'), true, '日语称呼后置')
})

test('0.46.69 declaresSleep 邀请否决：睡词后跟「一起/看视频」不算宣言（11-07 16:34 实锤）', () => {
  // 当天事故原话：白天说休息+邀请一起看视频 → 命中「休息了」→ 误判晚安 → QQ 发晚安+静默到 23:34
  assert.equal(nudge.declaresSleep('我暂时可以好好休息了莱莎，来一起看视频吧'), false, '邀请看视频不是就寝')
  assert.equal(nudge.declaresSleep('休息了休息了，一起来玩游戏吧'), false)
  assert.equal(nudge.declaresSleep('我去眯一会，等下回来一起聊天'), false)
  // 真宣言不受影响（邀请词在睡词前方，不查前方）
  assert.equal(nudge.declaresSleep('一起看完这集我就休息了'), true, '邀请词在前方不误伤')
  assert.equal(nudge.declaresSleep('晚安，我先去睡了'), true)
  assert.equal(nudge.declaresSleep('困了，去躺下了'), true)
  // 已知代价：真晚安+句尾邀请会被漏判——宁可漏判不误判（漏=照常陪聊，误=乱发晚安+静默数小时）
  assert.equal(nudge.declaresSleep('我先睡了，你们一起玩吧'), false, '已知漏判，接受')
})

test('0.46.74 declaresSleep 回忆否决：说「睡过了多久」是醒了不是去睡（11-08 上午实锤）', () => {
  // 当天事故：上午他报了自己睡了多久——在说刚醒来的那觉，
  // 关键词命中「睡了」→ 判成去睡 → 大早上 QQ 发晚安 + 静默到 18:00
  const morning = new Date('2026-11-08T11:00:00').getTime()
  const night = new Date('2026-11-08T23:30:00').getTime()
  assert.equal(nudge.declaresSleep('睡了差不多6个小时，应该还好吧', morning), false, '报睡眠时长=已经醒了')
  assert.equal(nudge.declaresSleep('昨晚只睡了5个小时', night), false, '夜里回顾昨天也不算宣言')
  assert.equal(nudge.declaresSleep('我11点就睡醒了', night), false)
  assert.equal(nudge.declaresSleep('刚起床', night), false)
  assert.equal(nudge.declaresSleep('最近失眠，烦死', night), false)
  // 过去词+真宣言并存：宣言词压过回忆否决
  assert.equal(nudge.declaresSleep('熬夜熬到两点，先睡了，晚安', night), true, '真宣言压过过去词')
  // 白天闸：白天根本不存在就寝宣言（哪怕句句是宣言词）——判错代价太大，宁漏判
  assert.equal(nudge.declaresSleep('我去补个觉，晚安', morning), false, '白天一律不判就寝')
  assert.equal(nudge.declaresSleep('困了，先睡了', night), true, '夜里正常宣言不受影响')
})

test('stageOf：阶梯升级 + 防翻车（间隔/退避/24h 上限/重复期）', () => {
  const now = 1000000000000
  const fresh = { stage: 0, light: false, lastProactiveAt: 0, nextTryAt: 0 }
  // 0.45.12 黏人加强版：15 分钟先轻声凑一句（stage 5），说完不影响后面阶梯
  assert.equal(nudge.stageOf(nudge.IDLE_LIGHT - 1, fresh, now), 0, '没到 15 分钟连轻声都不说')
  assert.equal(nudge.stageOf(nudge.IDLE_LIGHT + 1, fresh, now), 5, '15 分钟轻声一级')
  const lightSent = { stage: 0, light: true, lastProactiveAt: 0, nextTryAt: 0 }
  assert.equal(nudge.stageOf(nudge.IDLE_STAGE1 - 1, lightSent, now), 0, '轻声说过就等正式阶梯，不连发')
  assert.equal(nudge.stageOf(nudge.IDLE_STAGE1 + 1, fresh, now), 1)
  assert.equal(nudge.stageOf(nudge.IDLE_STAGE2 + 1, { stage: 1, lastProactiveAt: 0, nextTryAt: 0 }, now), 2)
  assert.equal(nudge.stageOf(nudge.IDLE_STAGE3 + 1, { stage: 2, lastProactiveAt: 0, nextTryAt: 0 }, now), 3)
  // 刚发过一条（< MIN_STAGE_GAP）不许连发——重启回来不许把阶梯一口气念完
  const justSent = { stage: 0, lastProactiveAt: now - 60000, nextTryAt: 0 }
  assert.equal(nudge.stageOf(10 * 3600000, justSent, now), 0)
  // 生成失败退避中不触发
  const backoff = { stage: 0, lastProactiveAt: 0, nextTryAt: now + 3600000 }
  assert.equal(nudge.stageOf(10 * 3600000, backoff, now), 0)
  // 超过 24 小时不理就不再追（避免几天后回来突然小作文）
  assert.equal(nudge.stageOf(25 * 3600000, fresh, now), 0)
  // 第 3 阶后进入重复期：每 REPEAT_EVERY 一条
  const late = { stage: 3, lastProactiveAt: now - nudge.REPEAT_EVERY - 1, nextTryAt: 0 }
  assert.equal(nudge.stageOf(8 * 3600000, late, now), 4)
  const tooSoon = { stage: 3, lastProactiveAt: now - 60 * 1000, nextTryAt: 0 }
  assert.equal(nudge.stageOf(8 * 3600000, tooSoon, now), 0)
})

test('0.45.12 黏人加强：onSent(轻声) 只点 light 旗不占阶梯名额；welcomeWorthy 门槛', () => {
  const now = 1000000000000
  let rec = { stage: 0, light: false, lastProactiveAt: 0, nextTryAt: 0 }
  rec = nudge.onSent(rec, nudge.LIGHT_STAGE, now)
  assert.equal(rec.light, true, '轻声级记 light 旗')
  assert.equal(rec.stage, 0, '不占阶梯名额——60/180/360 照常升级')
  rec = nudge.onSent(rec, 2, now + 60000)
  assert.equal(rec.stage, 2, '正式阶梯照常记档')
  // 欢迎回来：离开 ≥30 分钟才迎；2 小时内不重复迎；离开超过一天不迎（人都一天没见了，那不是欢迎是查岗）
  assert.equal(nudge.welcomeWorthy(29 * 60000, 0, now), false, '不到 30 分钟不迎')
  assert.equal(nudge.welcomeWorthy(31 * 60000, 0, now), true, '离开半小时值得一迎')
  assert.equal(nudge.welcomeWorthy(60 * 60000, now - 30 * 60000, now), false, '刚迎过没多久不重复')
  assert.equal(nudge.welcomeWorthy(60 * 60000, now - 2 * 3600000 - 1, now), true, '隔了 2 小时可以再迎')
  assert.equal(nudge.welcomeWorthy(25 * 3600000, 0, now), false, '离开一天以上不迎（不是查岗）')
})

test('状态机：说话清零 / 睡觉宣言挪计时到睡醒 / 失败退避 / 成功记档', () => {
  const now = 1000000000000
  let rec = { stage: 3, lastProactiveAt: now - 60000, nextTryAt: 0, baseAt: now - 3600000, sleepUntil: 0 }
  rec = nudge.onUserTalk(rec, now)
  assert.equal(rec.stage, 0)
  assert.equal(rec.baseAt, now, '计时从现在重新起算')
  assert.equal(rec.sleepUntil, 0)
  rec = nudge.onSleepDeclared(rec, now)
  assert.equal(rec.sleepUntil, now + nudge.SLEEP_HOURS * 3600 * 1000)
  assert.equal(rec.baseAt, rec.sleepUntil, '睡醒那一刻才是计时起点（醒来被想起，不是被追债）')
  rec = nudge.onFail(rec, now)
  assert.ok(rec.nextTryAt > now, '退避中')
  assert.equal(rec.stage, 0, '睡觉宣言已把阶梯清零（睡醒重新爬）')
  rec = nudge.onSent(rec, 1, now)
  assert.equal(rec.stage, 1, '睡觉清零后重新爬阶梯，记为第 1 阶')
  assert.equal(rec.nextTryAt, 0)
})
