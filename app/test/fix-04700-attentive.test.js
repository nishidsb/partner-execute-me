/**
 * 0.47.0 陪伴感 2.0：触发源重构（§5.15 设计红线）
 *
 * 主人 11-08 拍板：「陪伴感更多是依靠黏人模式来的，我要的不是这种」。
 *   黏人 = 「你不理我」驱动（计时器，索取注意力）→ 15/60/180/360 阶梯整体拆除
 *   陪伴 = 「共同生活」驱动（状态触发，呈现存在）→ attentive.js 四柱之二：
 *     ② 她懂你（studyCare / missing，状态触发、一天最多一次）
 *     ③ 共同生活的痕迹（echoHint / echoBlockOf，素材不是指令）
 *
 * 锁死：旧阶梯不再复活（15min 轻声 / 3h 委屈追问 / 小作文 / 每 3h 续杯全灭）；
 * missing 只在醒着的时间窗说、一天最多一次；陪学关心满 2h 才说、一天一次；
 * 回响是素材不是指令；接线四处（require / tick 支路 / 回复注入 / 嘀咕注入）。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const attentive = require(path.join(ROOT, 'src', 'main', 'companion', 'attentive.js'))
const nudge = require(path.join(ROOT, 'src', 'main', 'companion', 'idleNudge.js'))
const dayflow = require(path.join(ROOT, 'src', 'main', 'companion', 'dayflow.js'))

// 本地时区构造，hour 判定与实现一致（避免 UTC 偏移踩空）
const AT = (h, m) => new Date(2026, 10, 8, h, m || 0, 0).getTime()

test('attentive·陪学关心：满 2h 才说，一天最多一次', () => {
  assert.equal(attentive.studyCareDue(90, {}, AT(15)), false, '不满 2h 不说')
  assert.equal(attentive.studyCareDue(120, {}, AT(15)), true, '满 2h 值得一句')
  const said = attentive.noteStudyCare({}, AT(15))
  assert.equal(attentive.studyCareDue(180, said, AT(17)), false, '同一天第二次不说')
  assert.equal(attentive.studyCareDue(180, said, AT(15) + 86400000), true, '第二天重新开始算')
})

test('attentive·一整天没见：门槛 + 醒着时间窗 + 一天一次', () => {
  const sixH = attentive.MISSING_MIN_MS
  assert.equal(attentive.missingDue(sixH - 1, {}, AT(15)), false, '不到 6h 不算一整天')
  assert.equal(attentive.missingDue(sixH, {}, AT(15)), true, '6h + 下午 → 该说了')
  assert.equal(attentive.missingDue(sixH, {}, AT(8)), false, '早上 8 点不算（他可能还没起）')
  assert.equal(attentive.missingDue(sixH, {}, AT(23)), false, '23 点后不说')
  const said = attentive.noteMissing({}, AT(15))
  assert.equal(attentive.missingDue(sixH, said, AT(20)), false, '今天说过了就收住')
  assert.equal(attentive.missingDue(sixH, said, AT(15) + 86400000), true, '明天重新算')
})

test('attentive·dayKeyOf 与 dayflow.dayKeyOf 同规则（复制件不许漂移）', () => {
  for (const t of [AT(0, 30), AT(12), AT(23, 59), Date.now()]) {
    assert.equal(attentive.dayKeyOf(t), dayflow.dayKeyOf(t))
  }
})

test('0.47.0·阶梯彻底拆除：15min 轻声 / 1h / 3h 一律不再开口；6h 只剩 missing 一次', () => {
  const noon = AT(15)
  assert.equal(nudge.stageOf(15 * 60000, {}, noon), 0, '轻声级（15min 凑一句）没了')
  assert.equal(nudge.stageOf(60 * 60000, {}, noon), 0, '第 1 阶没了')
  assert.equal(nudge.stageOf(180 * 60000, {}, noon), 0, '第 2 阶（委屈追问）没了')
  assert.equal(nudge.stageOf(359 * 60000, {}, noon), 0, '还不到「一整天」')
  assert.equal(nudge.stageOf(360 * 60000, {}, noon), 1, '6h = missing（不再有第 3 阶小作文）')
  const old = { stage: 3, lastProactiveAt: noon - 3600000 }
  assert.equal(nudge.stageOf(400 * 60000, old, noon), 1, '旧 stage 字段失效，只剩 missing 语义')
})

test('0.47.0·missing 走 stage 1，onSent 记当天（QQ 与桌面共用一本账）', () => {
  const noon = AT(15)
  const rec = { lastProactiveAt: noon - 3600000 }
  assert.equal(nudge.stageOf(attentive.MISSING_MIN_MS, rec, noon), 1)
  const sent = nudge.onSent(rec, 1, noon)
  assert.equal(sent.missingDay, attentive.dayKeyOf(noon), '说完记今天')
  assert.equal(nudge.stageOf(attentive.MISSING_MIN_MS, sent, noon + 3600000), 0, '今天不再说第二次')
  assert.equal(nudge.stageOf(attentive.MISSING_MIN_MS, sent, noon + 86400000 + 3600000), 1, '明天可以再说')
})

test('0.47.0·睡前静默/睡醒武装的老闸全部保留', () => {
  const night = AT(23)                    // 23:00 道晚安
  const sleeping = nudge.onSleepDeclared({}, night)
  assert.equal(nudge.stageOf(8 * 3600000, sleeping, night + 4 * 3600000), 0, '静默期不出')
  assert.equal(nudge.stageOf(8 * 3600000, sleeping, night + 7 * 3600000 + 1000), 0, '静默到期 ≠ 他醒了（armed）')
  const morning = AT(8, 30)               // 次日 8:30 他开口
  const awake = nudge.onUserTalk(sleeping, morning)
  assert.equal(awake.sleepArmed, 0, '他说话解除武装')
  assert.equal(nudge.stageOf(5 * 3600000, awake, AT(13, 30)), 0, '距他上次说话 5h：只是忙，不开口')
  assert.equal(nudge.stageOf(6 * 3600000, awake, AT(14, 30)), 1, '距他上次说话 6h：一整天没见，轻轻说一次')
})

test('0.47.0·措辞红线：提示词里不许再有索取注意力的戏码', () => {
  const prompts = Object.values(nudge.STAGE_PROMPTS).map(String).join('\n')
  assert.ok(!/没理你/.test(prompts), '「他没理你」这个参照系整体退场')
  assert.ok(!/不甘心|没安全感/.test(prompts), '小作文的示弱话术删除（「不要委屈」这类禁令允许在）')
  assert.ok(!/问一句在干嘛|是不是不想理你|问他是不是/.test(prompts.replace(/不要问他是不是|绝不要问他/g, '')), '追问话术删除（禁令形式的「别问」允许在）')
  const p1 = String(nudge.STAGE_PROMPTS[1] || '')
  assert.ok(p1.length > 20, 'missing 提示词还在')
  assert.ok(/忙你的就好，我在/.test(p1), 'missing 的基调 = 在场，不是讨 attention')
  assert.ok(String(nudge.STAGE_PROMPTS.welcome || '').includes('{mins}'), 'welcome 提示词保留')
})

test('0.47.0·接线：状态触发器与回响块全部接进宿主（修一处≠修完，静态锁死）', () => {
  const comp = read('src/main/companion/index.js')
  assert.match(comp, /require\('\.\/attentive'\)/, '宿主要引入 attentive')
  assert.match(comp, /attentive\.studyCareDue\(/, '陪学关心支路要真跑（不只是 require）')
  assert.match(comp, /attentive\.noteStudyCare\(nudgeRec/, '关心过要记当天（跨重启落盘由 saveNudgeRec 承担）')
  assert.match(comp, /careStudyDay: String\(nudgeRec\.careStudyDay/, '新字段要落盘，否则重启后一天一次变一天 N 次')
  assert.match(comp, /missingDay: String\(nudgeRec\.missingDay/, 'missingDay 同样要落盘')
  assert.match(comp, /function echoBlockOf/, '回响块要存在')
  assert.match(comp, /key: 'echo'/, '回复链要注入回响块')
  assert.match(comp, /echoHint: \(\) =>/, '嘀咕链要接 echoHint')

  const chat = read('src/main/companion/chatter.js')
  assert.match(chat, /deps\.echoHint \|\|/, '嘀咕要有 echoHint 依赖')
  assert.match(chat, /共同经历的回响/, '嘀咕决策提示词要带回响段')

  const proj = read('src/main/companion/projects.js')
  assert.match(proj, /echoHint \(\)/, '项目层要提供回响素材')

  const idle = read('src/main/companion/idleNudge.js')
  assert.match(idle, /require\('\.\/attentive'\)/, 'idleNudge 的 missing 判定走 attentive 单源')
  assert.ok(!/IDLE_STAGE1|LIGHT_STAGE|REPEAT_EVERY/.test(idle), '阶梯常量不许残留（残留=有人会接回去）')
})

test('0.47.0·projects.echoHint：有进行中项目给一句，空仓给空串（绝不硬提）', () => {
  const projects = require(path.join(ROOT, 'src', 'main', 'companion', 'projects.js'))
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'echohint-'))
  const inst = projects.create({ wsDir: () => dir, now: () => AT(15), rand: () => 0.99, log: () => {} })
  // 空 state：echoHint 不该抛、该给空串（「绝不硬提」的底线）
  const out = inst.echoHint()
  assert.equal(out, '', '没有项目就闭嘴，不硬凑素材')
})
