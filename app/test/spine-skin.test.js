/**
 * 0.45.91 回归：坐下不许换皮肤
 *
 * 用户 11-02：「角色 spine 有时候会自动换成其他皮肤」。
 * 根因：坐卡/原地坐下时整个骨架切到 sitSkel（0001_01 常服），
 * 而主形象是 0005_01（白蓝比基尼）→ 她一坐下就换衣服，起身再换回来。
 *
 * 事实：0005_01 自带 741 条动画（含 B/C 坐姿组与 F_050/G_050 拍手），
 * 本来就不需要借 0001_01 的骨架。
 */
const test = require('node:test')
const assert = require('node:assert')

const skin = require('../src/renderer/shared/spine-skin')

const DIR = 'C:\\Users\\username\\AppData\\Roaming\\ryza-assistant-app\\companion\\assets\\workspaceid\\'
const P = (n) => DIR + 'crf_skn_002_' + n

const MAIN_0005 = {                 // 用户当前主形象：白蓝比基尼
  skel: P('0005_01.skel'), atlas: P('0005_01.atlas'), png: P('0005_01.png'),
  sitSkel: P('0001_01.skel'), sitAtlas: P('0001_01.atlas'), sitPng: P('0001_01.png')
}
const MAIN_0001_STAND = {           // 常服站姿版（用户在 UI 里换的那个）
  skel: P('0001_99.skel'), atlas: P('0001_99.atlas'), png: P('0001_99.png'),
  sitSkel: P('0001_01.skel'), sitAtlas: P('0001_01.atlas'), sitPng: P('0001_01.png')
}

test('outfitId：从骨架文件名取皮肤号', () => {
  assert.equal(skin.outfitId(P('0005_01.skel')), '0005')
  assert.equal(skin.outfitId(P('0001_99.skel')), '0001')
  assert.equal(skin.outfitId(''), '')
})

test('坐下：0005 主形象不换皮肤（bug 本体）', () => {
  const r = skin.pickSkel({ mode: 'sit', spine: MAIN_0005 })
  assert.equal(r.skel, MAIN_0005.skel, '必须还是白蓝比基尼')
  assert.equal(r.switched, false)
  assert.equal(r.reason, 'other-outfit')
})

test('坐下：0001 站姿版 → 0001 坐姿版照旧切（同套皮肤，只是姿态不同）', () => {
  const r = skin.pickSkel({ mode: 'sit', spine: MAIN_0001_STAND })
  assert.equal(r.skel, MAIN_0001_STAND.sitSkel, '同套皮肤才允许换骨架')
  assert.equal(r.atlas, MAIN_0001_STAND.sitAtlas)
  assert.equal(r.switched, true)
})

test('站起来：永远回到主骨架', () => {
  for (const sp of [MAIN_0005, MAIN_0001_STAND]) {
    const r = skin.pickSkel({ mode: 'stand', spine: sp })
    assert.equal(r.skel, sp.skel)
    assert.equal(r.switched, false)
  }
})

test('没配 sitSkel：保持站姿，不报错', () => {
  const r = skin.pickSkel({ mode: 'sit', spine: { skel: P('0005_01.skel'), atlas: 'a', png: 'p' } })
  assert.equal(r.skel, P('0005_01.skel'))
  assert.equal(r.reason, 'no-sit-skel')
})

test('路径解析不出皮肤号 → 当作同套，保留老行为（别把功能关死）', () => {
  const sp = { skel: 'a/foo.skel', atlas: 'a', png: 'p', sitSkel: 'a/bar.skel', sitAtlas: 'sa', sitPng: 'sp' }
  const r = skin.pickSkel({ mode: 'sit', spine: sp })
  assert.equal(r.skel, 'a/bar.skel')
  assert.equal(r.switched, true)
})
