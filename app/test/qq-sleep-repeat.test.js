/**
 * 0.45.91 回归：晚安之后不许再开口 + 不许复读
 *
 * 线上实锤（11-02 凌晨）：23:39 判定「静默到 06:39」，23:43 部署重启，
 * 23:56 又开始搭话；整夜 9 次，其中「あ、戻った。……配合の数字、見直してた」
 * 逐字近乎一致地出现了 4 次。
 *
 * 两处根因都在这里钉住：
 *   ① nudgeRec 只活在内存在 → 静默承诺一重启就没（靠 index.js 落盘 + 这里守语义）
 *   ② 提示词挡不住复读 → 出口硬闸（proactiveGate）
 */
const test = require('node:test')
const assert = require('node:assert')

const idleNudge = require('../src/main/companion/idleNudge')
const { createGate } = require('../src/main/companion/proactiveGate')

const T0 = new Date('2026-11-01T23:39:00+08:00').getTime()

test('说了晚安 → sleepUntil 落到 7 小时后，阶段计时挪到睡醒', () => {
  const rec = idleNudge.onSleepDeclared({ stage: 3, baseAt: T0 - 3600e3 }, T0)
  assert.ok(rec.sleepUntil > T0, '必须有静默截止时刻')
  assert.equal(rec.sleepUntil, T0 + 7 * 3600 * 1000, '默认静默 7 小时')
  assert.equal(rec.baseAt, rec.sleepUntil, '闲置计时挪到睡醒那一刻，别一醒来就是「你 400 分钟没理我」')
  assert.equal(rec.stage, 0, '阶段归零')
})

test('静默期内：stageOf 不给阶段（她不该开口）', () => {
  const rec = idleNudge.onSleepDeclared({}, T0)
  // 23:56 —— 只过了 17 分钟，绝不能出「第 5 阶」
  assert.ok(!idleNudge.stageOf(17 * 60 * 1000, rec, T0 + 17 * 60 * 1000), '静默期不出阶段')
  // 01:32 —— 曾经在这里出了「第 1 阶（闲置 111 分钟）」
  assert.ok(!idleNudge.stageOf(111 * 60 * 1000, rec, T0 + 113 * 60 * 1000), '静默期不出阶段')
  // 睡醒之后（过了 7 小时）才允许重新计
  const after = rec.sleepUntil + 60e3
  assert.equal(idleNudge.stageOf(after - rec.baseAt, rec, after), 0, '刚醒 1 分钟不至于追问')
})

test('复读闸：同一道具换句式也拦（「あ、戻った+配合の数字」4 连发）', () => {
  const gate = createGate({ size: 12 })
  gate.note('あ、戻った。……あたしはさっきまで配合の数字、もう一回見直してたとこ。合ってるかどうか、そっちにも後で見てほしいな。')
  // 04:07 的变体
  const v2 = gate.check('あ、戻った。……ちょうどよかった、配合の数字をさっきまで見直してたとこなんだ。合ってるかどうか、ちょっとだけ目を通してくれない？')
  assert.ok(v2 && v2.repeat, '同一道具的变体必须被拦下')
  // 06:59 的变体
  const v3 = gate.check('あ、戻った。……さっきまで配合ノートの数字、もう一回見直してたんだ。目、ちょっと疲れたけど、だいぶすっきりしたよ。')
  assert.ok(v3 && v3.repeat, '第三次变体也要拦')
})

test('复读闸：真正换了话题就放行（别把她憋成哑巴）', () => {
  const gate = createGate({ size: 12 })
  gate.note('あ、戻った。……あたしはさっきまで配合の数字、もう一回見直してたとこ。')
  const ok = gate.check('外面好像下雨了，窗玻璃上都是水痕。你带伞了没？')
  assert.equal(ok, null, '无关内容不该被误杀')
})

test('复读闸：没有历史时一律放行', () => {
  const gate = createGate({ size: 12 })
  assert.equal(gate.check('随便一句什么'), null)
})

test('复读闸：外部历史（跨重启）也参与比对', () => {
  const gate = createGate({
    size: 12,
    extraHistory: () => ['ねえ、まだ画面の前？　何か詰まってるなら、ちょっとだけ顔上げてみて。あたしはここで待ってるから。']
  })
  const hit = gate.check('ねえ、まだ画面の前？　何か詰まってるなら、顔を上げてみてよ。待ってるからね。')
  assert.ok(hit && hit.repeat, '重启后仍要认得出昨天说过的句子')
})

test('他半夜起来说话 → 静默立刻解除（别把晚安变成永久免打扰）', () => {
  const sleeping = idleNudge.onSleepDeclared({}, T0)
  const woke = idleNudge.onUserTalk(sleeping, T0 + 3 * 3600 * 1000)
  assert.equal(woke.sleepUntil, 0, '他说了话就说明人醒了')
  assert.equal(woke.baseAt, T0 + 3 * 3600 * 1000, '计时从他这句重新开始')
})

test('0.46.36 她自己开了口（做梦收尾）→ 只记刚说过话，绝不清睡前静默', () => {
  const sleeping = idleNudge.onSleepDeclared({}, T0)   // 23:39 道晚安 → 静默到 06:39
  const after = idleNudge.noteSelfSpoke(sleeping, T0 + 94 * 60 * 1000)   // 01:13 做梦完成
  assert.equal(after.sleepUntil, sleeping.sleepUntil, '静默必须原样保留（11-04 实锤：01:13 做梦清了静默，02:39 她 QQ「85 分钟没理我？」）')
  assert.equal(after.baseAt, sleeping.baseAt, '计时起点也不动（baseAt 仍=睡醒时刻）')
  assert.ok(after.lastProactiveAt > T0, '但要记下她刚开过口，别紧接着又黏人')
  // 静默期内 stageOf 依旧 0
  assert.equal(idleNudge.stageOf(400 * 60 * 1000, after, T0 + 3 * 3600 * 1000), 0, '静默期不给任何阶段')
})
