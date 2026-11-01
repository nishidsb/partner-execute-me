/** 0.18.0 M8 修正：自设（用户资料）跟角色卡走，不共用（主人 2026-10-25 指出） */
const test = require('node:test')
const assert = require('node:assert')
const { resolveUserProfile, userProfileTextOf } = require('../src/main/companion/user-profile')

test('卡上自设优先，全局只兜底（与音色同一规则：卡优先，全局兜底）', () => {
  const g = { address: '全局称呼', portrait: '全局画像', relationship: '全局关系', interaction: '', boundaries: '' }
  // 卡全填 → 全是卡的
  const r1 = resolveUserProfile({ address: '主人', portrait: '卡画像', relationship: '搭档', interaction: '聊游戏', boundaries: '别问工作' }, g)
  assert.deepEqual(r1, { address: '主人', portrait: '卡画像', relationship: '搭档', interaction: '聊游戏', boundaries: '别问工作' })
  // 卡只填称呼/关系（每个角色眼里的你可以不一样），其余用全局
  const r2 = resolveUserProfile({ address: '哥哥', relationship: '炼金术士与搭档' }, g)
  assert.equal(r2.address, '哥哥')
  assert.equal(r2.relationship, '炼金术士与搭档')
  assert.equal(r2.portrait, '全局画像')
  // 卡没有 → 全局兜底
  const r3 = resolveUserProfile(null, g)
  assert.equal(r3.address, '全局称呼')
  // 双双没有 → 空串（提示词层显示「未设置」）
  const r4 = resolveUserProfile(null, null)
  assert.deepEqual(r4, { address: '', portrait: '', relationship: '', interaction: '', boundaries: '' })
})

test('空串/空白的卡字段也算「没填」，不挡全局兜底', () => {
  const g = { address: '全局称呼', portrait: '全局画像' }
  const r = resolveUserProfile({ address: '  ', portrait: '' }, g)
  assert.equal(r.address, '全局称呼')
  assert.equal(r.portrait, '全局画像')
})

test('userProfileTextOf 输出提示词 JSON；空字段显示「未设置」', () => {
  const t1 = userProfileTextOf({ address: '哥哥', relationship: '搭档' }, { portrait: '的样子' })
  assert.ok(t1.startsWith('用户资料：'))
  const j1 = JSON.parse(t1.replace(/^用户资料：/, ''))
  assert.equal(j1['称呼'], '哥哥')
  assert.equal(j1['关系定位'], '搭档')
  assert.equal(j1['自画像'], '的样子')
  const j2 = JSON.parse(userProfileTextOf(null, null).replace(/^用户资料：/, ''))
  assert.equal(j2['称呼'], '未设置')
  assert.equal(j2['自画像'], '未设置')
})

test('卡上空白 + 全局也空白 → 全部「未设置」（不炸、不输出 undefined）', () => {
  const t = userProfileTextOf({ address: '' }, {})
  const j = JSON.parse(t.replace(/^用户资料：/, ''))
  for (const k of ['称呼', '自画像', '关系定位', '互动偏好', '需要避开']) assert.equal(j[k], '未设置')
})
