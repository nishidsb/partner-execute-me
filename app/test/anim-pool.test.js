'use strict'
/* 官方动画选池自守卫：
 * ① 目录/池文件必须被 overlay 页真的引入（漏 script 标签 = 功能静默失效）
 * ② 每个池都得有货，而且池里每个名字都真的在目录里（改名/重烘焙后不会悄悄空转）
 * ③ pose 池必须纯（躺下池里不能混站着的）
 * ④ 已知核对过的两个编号必须落在对应池里（gust_01300 躺倒 / gust_30231 瘫坐）
 * ⑤ pick 要会避开刚播过的，且能注入 rng 保证可测
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const catalog = require(path.join(ROOT, 'src/renderer/shared/anim-catalog.js'))
const pool = require(path.join(ROOT, 'src/renderer/shared/anim-pool.js'))

test('overlay 页引入了动画目录与选池脚本', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/overlay/index.html'), 'utf8')
  assert.match(html, /shared\/anim-catalog\.js/, 'index.html 少了 anim-catalog.js（池子会全是空）')
  assert.match(html, /shared\/anim-pool\.js/, 'index.html 少了 anim-pool.js')
})

test('目录包含全部官方 clip 且带标签', () => {
  const names = Object.keys(catalog.clips)
  assert.ok(names.length >= 360, '目录里的 clip 太少：' + names.length)
  const gust = names.filter((n) => /^gust_\d+$/.test(n))
  assert.ok(gust.length >= 360, 'gust_ 编号数不对：' + gust.length)
  for (const n of names.slice(0, 50)) {
    const c = catalog.clips[n]
    assert.ok(c.pose, n + ' 没有 pose')
    assert.ok(Array.isArray(c.tags) && c.tags.includes(c.pose), n + ' 的 tags 里应该含自己的 pose')
  }
})

test('每个池都有候选，且名字都在目录里', () => {
  for (const name of Object.keys(pool.POOLS)) {
    const list = pool.list(name, catalog)
    assert.ok(list.length >= 2, name + ' 池只有 ' + list.length + ' 个，太少')
    for (const clip of list) assert.ok(catalog.clips[clip], name + ' 池里的 ' + clip + ' 不在目录里')
  }
})

test('pose 池必须纯：躺下池里全是 lie，坐下池里全是 sit', () => {
  for (const [name, rule] of Object.entries(pool.POOLS)) {
    if (!rule.pose) continue
    for (const clip of pool.list(name, catalog)) {
      assert.strictEqual(catalog.clips[clip].pose, rule.pose, name + ' 池混进了 ' + clip)
    }
  }
})

test('核对过的官方编号落在对的池里', () => {
  assert.ok(pool.list('lie', catalog).includes('gust_01300'), 'gust_01300（仰面躺倒）不在躺下池')
  assert.ok(pool.list('sit', catalog).includes('gust_30231'), 'gust_30231（就地瘫坐）不在坐下池')
})

test('pick 会避开最近播过的，池子用完才回退', () => {
  const top = pool.list('lie', catalog).slice(0, 4)
  const got = pool.pick('lie', { catalog, avoid: top.slice(0, 3), rng: () => 0 })
  assert.strictEqual(got, top[3], '应该挑到唯一没播过的那个')

  const all = pool.list('lie', catalog)
  const again = pool.pick('lie', { catalog, avoid: all, rng: () => 0 })
  assert.strictEqual(again, all[0], '全都播过了就该从最好的开始回退')
})

test('pick 对未知池/空目录返回 null，不抛', () => {
  assert.strictEqual(pool.pick('nope', { catalog }), null)
  assert.strictEqual(pool.pick('lie', { catalog: null }), null)
  assert.strictEqual(pool.pick('lie', { catalog: { clips: {} } }), null)
})

test('pick 的 rng 能选中池内任意位置', () => {
  const top = pool.list('wave', catalog).slice(0, 4)
  assert.strictEqual(pool.pick('wave', { catalog, rng: () => 0 }), top[0])
  assert.strictEqual(pool.pick('wave', { catalog, rng: () => 0.99 }), top[3])
})
