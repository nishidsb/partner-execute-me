/**
 * 0.45.97 屏幕陪伴 / QQ 主动消息「两边只算一次」
 *
 * 用户 11-02 的原话：
 *   「这个主动发的这个属于多余的设计，随机发就可以了，不用在意多少条，
 *     以及主动发的这个跟屏幕陪伴这边应该是冲突的设计，
 *     这两个地方只要有一边发了都算发，这样就可以了。
 *     qq主动发这个主要应用在我离开电脑前的」
 *
 * 锁四件事：
 *   ① 桌面开口会占用 QQ 那本账（不会再出现「屏幕前刚说完，QQ 又补一句」）
 *   ② QQ 开口会占用黏人阶梯的账（不会回来立刻又被追问）
 *   ③ 设置页不再有「两次至少隔 / 每天最多」两个多余输入框
 *   ④ 配置里不再有 reachMinGapMin / reachDailyMax（旧值不会偷偷生效）
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const reach = require(path.join(ROOT, 'src', 'main', 'companion', 'reach.js'))
const nudge = require(path.join(ROOT, 'src', 'main', 'companion', 'idleNudge.js'))

const NOW = 1000000000000
const ic = { reachOn: true, ownerAccounts: ['359524452'] }

test('①桌面陪伴开过口 → QQ 这边算「已经发过了」', () => {
  // 桌面说了一句（sayProactive → noteSpoke → reach.onSent）
  let rec = reach.onSent({ lastAt: 0, day: '', count: 0 }, NOW, { rand: () => 0.5 })
  assert.equal(
    reach.shouldReach(rec, ic, { now: NOW + 10 * 60000, connected: true }).why,
    'cooldown',
    '桌面刚说完 10 分钟，QQ 不该再补一句'
  )
  // 随机间隔过完才轮到自己开口
  const later = Number(rec.nextAt) + 1000
  assert.equal(reach.shouldReach(rec, ic, { now: later, connected: true }).ok, true)
})

test('②QQ 开过口 → 黏人阶梯也认得这一笔（回来不会立刻被追问）', () => {
  const sent = NOW
  const rec = Object.assign({ stage: 1, light: true, nextTryAt: 0, baseAt: 0, sleepUntil: 0 }, { lastProactiveAt: sent })
  // 1 小时没说话，但 5 分钟前刚在 QQ 上说过 → 不开口（MIN_STAGE_GAP 内）
  assert.equal(nudge.stageOf(200 * 60000, rec, sent + 5 * 60000), 0)
  // 隔够 10 分钟以上，阶梯才有资格继续（200 分钟闲置 → 该升到第 2 阶）
  assert.equal(nudge.stageOf(200 * 60000, rec, sent + 11 * 60000), 2)
})

test('③两边共用一笔账：任何一边开口都会把 nextAt 往后推（不设条数上限）', () => {
  let rec = { lastAt: 0, nextAt: 0, day: '', count: 0 }
  const a = reach.onSent(rec, NOW, { rand: () => 0 })
  assert.equal(a.nextAt, NOW + reach.GAP_MIN_MS)
  assert.equal(reach.shouldReach(a, ic, { now: a.nextAt + 1, connected: true }).ok, true)
  const b = reach.onSent(a, a.nextAt + 1, { rand: () => 1 })
  assert.equal(b.nextAt, a.nextAt + 1 + reach.GAP_MAX_MS, '下一次是另一个随机间隔，不是固定闹钟')
  assert.ok(b.count > a.count)
  // 一天发了 40 条也照发（没有 daily-max 这道闸了）
  assert.equal(reach.shouldReach({ lastAt: 0, nextAt: 0, day: new Date(NOW).toDateString(), count: 40 }, ic, { now: NOW, connected: true }).ok, true)
})

test('④设置页与配置里都不再有「间隔 / 每天最多」', () => {
  const html = read('src/renderer/companion/index.html')
  assert.ok(!/id="imReachGap"/.test(html), '设置页不该再有「两次至少隔」输入框')
  assert.ok(!/id="imReachDaily"/.test(html), '设置页不该再有「每天最多」输入框')
  assert.ok(!/data-i18n="im.reachGap"/.test(html))

  const app = read('src/renderer/companion/app.js')
  assert.ok(!/imReachGap|imReachDaily/.test(app), '渲染层不该再读写这两个字段')
  assert.ok(!/reachMinGapMin|reachDailyMax/.test(app))

  const brain = read('src/main/im/brain.js')
  // 只查「真正的字段」，注释里提到这两个名字（说明为什么删）不算
  assert.ok(!/reachMinGapMin\s*[:=]|reachDailyMax\s*[:=]/.test(brain), '配置里不该再留这两个键（旧值不该偷偷生效）')

  for (const f of ['zh', 'zh-Hant', 'en', 'ja']) {
    const s = read('src/renderer/shared/i18n/strings.' + f + '.js')
    assert.ok(!/reachGap|reachDaily/.test(s), f + ' 还留着旧文案键')
  }
})

test('⑤宿主接线：桌面出口与 QQ 出口各记一笔', () => {
  const comp = read('src/main/companion/index.js')
  assert.match(comp, /function noteSpoke/, '要有共用的记账函数')
  assert.match(comp, /noteSpoke\(\)\s*\n\s*subtitleFor/, 'sayProactive（屏幕陪伴开口）必须记账')
  assert.match(comp, /noteSpoke\(\)\s*\/\/ 0\.45\.97 碎碎念/, '碎碎念（气泡）也算开口')
  assert.match(comp, /nudgeRec = Object\.assign\(\{\}, nudgeRec, \{ lastProactiveAt: Date\.now\(\) \}\)/, 'QQ 发完要回写黏人账')
  // 不在电脑前那条路必须走统一出口（否则又绕过翻译）
  assert.match(comp, /const r = await deliverReach\(text, 'away'\)/)
  assert.match(comp, /const r = await deliverReach\(text, 'sleep'\)/)
  assert.ok(!/await imApi\.sendPrivate\(gate\.uid, text\)/.test(comp), '不许再直连 sendPrivate 绕过翻译')
})
