/**
 * 0.46.0 坐姿默认态（用户 11-02：「现在的spine只有坐姿，所以应该默认坐在某一张卡片上
 * 或者坐在某个还未关闭的程序上。不用移动」）。
 *
 * pet.js 依赖 electron 不能直接 require，按项目惯例做源码级断言：
 *  - walkMode 默认档从 calm 改 off（显式配了 calm/lively 仍尊重）
 *  - boot 末尾默认执行一次 sitOnCommand（卡片 → AuraDesk 窗口顶边 → 原地持续坐）
 *  - 宿主/设置页的默认值四处同步，不许出现「主进程 off、设置页显示 calm」的错位
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

test('walkMode：未配置/配 off → off；显式 calm/lively 尊重用户', () => {
  const src = read('src/main/companion/pet.js')
  const block = (src.match(/function walkMode \(\) \{[\s\S]*?\n\}/) || [])[0] || ''
  assert.ok(block, '找得到 walkMode')
  assert.ok(/return 'off'/.test(block), '兜底返回 off')
  assert.ok(/m === 'calm' \|\| m === 'lively'/.test(block), '显式档位仍生效')
  assert.ok(!/return m === 'off' \|\| m === 'lively' \? m : 'calm'/.test(src), '旧默认 calm 已移除')
})

test('boot：启动后默认坐一次（只一次，之后主人说了算）', () => {
  const src = read('src/main/companion/pet.js')
  const boot = (src.match(/function boot \(\) \{[\s\S]*?\n\}/) || [])[0] || ''
  assert.ok(/defaultSitTimer = setTimeout/.test(boot), 'boot 里有延迟默认坐下')
  assert.ok(/sitOnCommand\(\)/.test(boot), '走 sitOnCommand（卡片→窗口→原地，复用既有链路）')
  // 守卫：没显示 / 被拎着 / 已在坐姿时不再动作
  assert.ok(/!state\.visible \|\| drag \|\| rest \|\| \(groundRest && groundRest\.persistent\)/.test(boot), '有状态守卫')
  assert.ok(/clearTimeout\(defaultSitTimer\)/.test(boot), '重复 boot 不会叠定时器')
})

test('默认值四处同步：宿主 cfg / 设置页读取 / 引导页', () => {
  assert.ok(/petWalk: c\.petWalk \|\| 'off'/.test(read('src/main/companion/index.js')), '宿主默认 off')
  assert.ok(/\$\('cpPetWalk'\)\.value = cs\.petWalk \|\| 'off'/.test(read('src/renderer/companion/app.js')), '设置页默认 off')
  assert.ok(/step === 'walk'\) set\('gdWalk', s\.petWalk \|\| 'off'\)/.test(read('src/renderer/companion/app.js')), '引导页默认 off')
  // 四语言都说明了「默认不走动/坐下」
  for (const f of ['strings.zh.js', 'strings.zh-Hant.js', 'strings.en.js', 'strings.ja.js']) {
    const s = read('src/renderer/shared/i18n/' + f)
    assert.ok(/walkLabel[^\n]*(默认不走动|預設不走動|off by default|既定はオフ)/.test(s), f + ' walkLabel 说明默认')
  }
})
