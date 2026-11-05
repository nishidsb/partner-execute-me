/**
 * 0.45.29 桌面共存修复（主人 10-30 晚报的五个问题）：
 *  1. 程序打开时桌面挂机游戏（桌面破坏神）无法点击 —— 热区/穿透翻转链路 hardened
 *  2. 聊天框不悬停也一直存在 —— 穿透窗口收不到 pointerleave，主进程翻转时必须通知
 *  3. 悬停工具条（💬🎤🚶🎨🔊…）删除
 *  4. 角色与 AuraDesk 卡片重叠时拖角色点到卡片 —— 可交互瞬间立刻提层
 *  5. 坐下/躺下/坐卡片动作从未出现 —— pet:pose 无接收者、卡片文件不存在、词表没教
 *
 * 主进程文件 require electron，沿用项目惯例做源码静态断言。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('穿透翻转闭环：主进程翻回穿透时通知渲染层（修「聊天框常驻」）', () => {
  const main = read('src/main/main.js')
  // 翻回穿透 → overlay:hot-lost 通知；翻到可交互 → 立刻提层（修拖角色点到卡片）
  assert.ok(/w\.webContents\.send\('overlay:hot-lost'\)/.test(main), '翻转时通知渲染层')
  assert.ok(/if \(hot\) \{[^}]*raiseOverlays\(true\)/.test(main), '可交互瞬间立刻提层')
  // 热区上报只在首次强制回穿透（否则走路时掩码每帧重报会把可交互态打回穿透）
  assert.ok(/const first = !hotRectsByWin\.has\(key\)/.test(main), '热区上报首次判定')
  assert.ok(/if \(first\) \{[^}]*setIgnoreMouseEvents\(true\)/.test(main), '首次才强制穿透')
  const preload = read('src/preload/overlay.js')
  assert.ok(/onHotLost: \(cb\) => ipcRenderer\.on\('overlay:hot-lost'/.test(preload), 'preload 暴露 onHotLost')
})

test('渲染层收尾：hot-lost 收起输入条/右键菜单 + mouseHot 归零', () => {
  const pet = read('src/renderer/overlay/pet.js')
  assert.match(pet, /onHotLost\(\(\) => \{ maybeHide\(\) \}\)/, '聊天输入条收起')
  assert.match(pet, /onHotLost\(\(\) => \{ const m = \$\('petMenu'\); if \(m\) m\.hidden = true \}\)/, '右键菜单收起')
  const app = read('src/renderer/overlay/app.js')
  assert.match(app, /onHotLost\(\(\) => \{ mouseHot = false \}\)/, 'mouseHot 归零（重进热区要能再触发提层）')
})

test('掩码失败兜底：不再整块矩形挡桌面，收缩到中央躯干区', () => {
  const app = read('src/renderer/overlay/app.js')
  assert.ok(/if \(pixel && !petMask\) \{[^}]*insetX/.test(app), '掩码缺失时收缩热区矩形')
  assert.ok(!/宁可挡也不让角色点不中/.test(app), '旧的「宁可挡」策略已移除')
})

test('悬停工具条已整体移除（主人的要求：直接删了吧）', () => {
  const html = read('src/renderer/overlay/index.html')
  assert.ok(!/id="petHover"/.test(html), 'overlay 里没有 petHover 元素')
  const pet = read('src/renderer/overlay/pet.js')
  assert.ok(!/function setupHover/.test(pet), 'setupHover 已拆除')
  assert.ok(!/petHoverButtons/.test(pet), '配置读取已拆除')
  const css = read('src/renderer/overlay/style.css')
  assert.ok(!/\.pethover \{/.test(css), '样式已移除')
  const settings = read('src/renderer/companion/app.js')
  assert.ok(!/cpHoverBtns/.test(settings), '设置页读写已移除')
})

test('坐姿闭环：pet:pose 有渲染层接收者了（此前广播无人监听）', () => {
  const pet = read('src/renderer/overlay/pet.js')
  assert.match(pet, /onPetPose\(\(\{ pose \}\) =>/, 'pet:pose 处理器')
  assert.match(pet, /vrmRuntime\.setPose\(pose === 'sit' \? 'sit' : 'stand'\)/, '接到 vrm 程序化坐姿')
})

test('自主休息：原地坐下 + AuraDesk 窗口兜底当卡片', () => {
  const m = read('src/main/companion/pet.js')
  assert.match(m, /function restInPlace \(\)/, '原地坐下休息')
  assert.match(m, /function leaveGroundRest \(thenWander\)/, '起身')
  assert.match(m, /broadcast\('pet:pose', \{ pose: 'sit' \}\)/, '坐下广播')
  assert.match(m, /function auraDeskWindowsAsCards \(\)/, 'AuraDesk 窗口兜底')
  assert.match(m, /\/auradesk\/i\.test\(w\.title\)/, '按窗口标题认 AuraDesk')
  // 拎起来必须先站起来
  assert.ok(/leaveGroundRest\(false\)[^}]*stopWalk\(\)/s.test(m), 'dragStart 先起身')
  // 走动调度把 groundRest 算进占用
  assert.match(m, /rest \|\| groundRest\) return/, 'scheduleWander 守卫')
})

test('pet_act 动作词表已教给模型（坐下/躺下不再靠缘分）', () => {
  const tool = read('src/assistant/core/tools/pet.js')
  const desc = tool.slice(tool.indexOf("name: 'pet_act'"), tool.indexOf("name: 'pet_set'"))
  for (const w of ['坐下', '躺下', '睡觉', '转圈', '挥手']) {
    assert.ok(desc.includes(w), '描述含动作词：' + w)
  }
})

/* ---- 0.45.31 卡片可见性筛 + 启动位置托回（用户 10-30：走着走着瞬移到屏幕顶） ---- */
test('0.45.31 卡片候选必须过可见性筛：顶边离工作区顶边半个舞台高、剔除全屏窗口', () => {
  const src = read('src/main/companion/pet.js')
  assert.ok(/function visibleCards \(cards\)/.test(src), '有 visibleCards 筛')
  assert.ok(/visibleCards\(petlink\.readCards\(\)\)/.test(src), '上报文件来源过筛')
  assert.ok(/visibleCards\(auraDeskWindowsAsCards\(\)\)/.test(src), '窗口兜底来源过筛')
  assert.ok(/stageHeight\(\) \* 0\.5/.test(src), '头顶净空=半舞台高（顶边太高=坐上去头出屏）')
  assert.ok(/h > wa\.height \* 0\.85/.test(src), '近乎全屏的窗口不是卡片')
  assert.ok(/y > wa\.y \+ wa\.height - 60/.test(src), '顶边贴底=脚垂进任务栏')
})

test('0.45.31 启动时把头顶出屏的持久化位置托回，拖拽钳制不动', () => {
  const src = read('src/main/companion/pet.js')
  assert.ok(/minYok = minY \+ stageHeight\(\) \* 0\.85/.test(src), 'boot 里按 0.85 舞台高托回')
  assert.ok(/if \(state\.pos\.y < minYok\) state\.pos = \{ x: state\.pos\.x, y: Math\.round\(minYok\) \}/.test(src), '只托 y 不动 x')
  // 拖拽 clampPos 仍保留 140px 旧行为（用户拖拽时看得见，不夺权）
  assert.ok(/minY \+ 140/.test(src), 'clampPos 拖拽行为未变')
})

test('0.46.45 锚点纵向出屏不隐身：主进程随 pet:pos 下发宿主屏提示，渲染层按提示接管（11-04 坐贴屏底卡片 pos.y=1489>1440 两屏都不接管 → 整只消失实锤）', () => {
  const main = read('src/main/companion/pet.js')
  assert.ok(/function hostBoundsFor \(x, y\)/.test(main), 'hostBoundsFor 定义')
  assert.ok(/getAllDisplays\(\)/.test(main), '遍历全部显示器取最近')
  assert.ok(/dist === bestD && inX && !bestInX/.test(main), '同距优先 x 命中的屏（并排双屏消歧）')
  assert.equal((main.match(/hostBounds: hostBoundsFor\(state\.pos\.x, state\.pos\.y\)/g) || []).length, 2, 'pushPos/pushTo 两个 pet:pos 发送点都带提示')
  const pet = read('src/renderer/overlay/pet.js')
  assert.ok(/let petHostHint = null/.test(pet), '渲染层存宿主提示')
  assert.ok(/petHostHint = p\.hostBounds \|\| null/.test(pet), 'onPetPos 接住提示')
  assert.ok(/const hostIsMe = !!petHostHint && Math\.abs\(petHostHint\.x - wx\) <= 2 && Math\.abs\(petHostHint\.y - wy\) <= 2/.test(pet), '本窗=提示屏判定（窗口原点比对）')
  assert.ok(/const inside = petHostHint \? \(hostIsMe \|\| \(inX && inY\)\) : \(inX && inY\)/.test(pet), '有提示：提示屏接管（含出屏兜底）；无提示：保持原判定')
})
