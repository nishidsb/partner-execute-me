/**
 * 形象包程序化姿态（0.26.0）—— 纯函数测试
 *
 * figure-render.js 是挂在 globalThis 上的 IIFE（渲染层直接 <script> 引入），
 * 所以这里用 vm 起一个假 global 来加载它，只测 poseAt / inferParts / buildRig 三个纯函数。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

function loadFigureLib () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'shared', 'figure-render.js'), 'utf8')
  const sandbox = { console }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  return sandbox.AuraFigure
}

const F = loadFigureLib()

// 一个和内置示例包同构的小蓝：大头 + 两条腿 + 两只鞋 + 身体 + 两条手臂
const SIZE = [360, 560]
const LAYERS = [
  { z: 0, type: 'shape', shape: 'ellipse', x: 66, y: 40, w: 228, h: 250, fill: '#8ab' },
  { z: 4, type: 'shape', shape: 'rect', x: 134, y: 396, w: 36, h: 116, rx: 18, fill: '#fcd' },
  { z: 4, type: 'shape', shape: 'rect', x: 190, y: 396, w: 36, h: 116, rx: 18, fill: '#fcd' },
  { z: 5, type: 'shape', shape: 'ellipse', x: 116, y: 500, w: 62, h: 32, fill: '#345' },
  { z: 5, type: 'shape', shape: 'ellipse', x: 182, y: 500, w: 62, h: 32, fill: '#345' },
  { z: 8, type: 'shape', shape: 'ellipse', x: 96, y: 240, w: 168, h: 190, fill: '#fc9' },
  { z: 12, type: 'shape', shape: 'ellipse', x: 76, y: 258, w: 34, h: 148, fill: '#fc9' },
  { z: 12, type: 'shape', shape: 'ellipse', x: 250, y: 258, w: 34, h: 148, fill: '#fc9' },
  { z: 24, type: 'shape', shape: 'ellipse', x: 116, y: 206, w: 32, h: 19, fill: '#222' },
  { z: 24, type: 'shape', shape: 'ellipse', x: 212, y: 206, w: 32, h: 19, fill: '#222' },
  { z: 26, type: 'shape', shape: 'ellipse', x: 172, y: 224, w: 16, h: 10, fill: '#a44' }
]

test('部位推断：腿/鞋/臂/头/身都认得出来（包没写 part 也能动）', () => {
  const rig = F.buildRig(LAYERS, SIZE)
  const partOf = (i) => rig.parts.get(LAYERS[i])
  assert.equal(partOf(0), 'head', '头顶大椭圆应是头')
  assert.equal(partOf(1), 'legL', '左腿')
  assert.equal(partOf(2), 'legR', '右腿')
  assert.equal(partOf(3), 'legL', '左鞋跟左腿一起转（否则脚会脱开）')
  assert.equal(partOf(4), 'legR', '右鞋')
  assert.equal(partOf(5), 'body', '躯干椭圆')
  assert.equal(partOf(6), 'armL', '左臂')
  assert.equal(partOf(7), 'armR', '右臂')
  assert.equal(partOf(8), 'head', '眼睛跟头动')
  assert.equal(partOf(10), 'head', '嘴巴跟头动')
})

test('枢轴位置：腿在髋、臂在肩、头在颈、身在脚底', () => {
  const rig = F.buildRig(LAYERS, SIZE)
  const pv = (part) => rig.groups.get(part).pivot
  // 腿图层 y=396 → 髋在顶端附近
  assert.ok(Math.abs(pv('legL')[1] - 401) < 3, '腿枢轴应在顶端（实际 ' + pv('legL')[1] + '）')
  assert.ok(Math.abs(pv('armR')[1] - 264) < 5, '臂枢轴应在顶端（实际 ' + pv('armR')[1] + '）')
  // 头部组包围盒底边 = 290（头发椭圆 y40 + h250）
  assert.ok(Math.abs(pv('head')[1] - 290) < 3, '头枢轴应在底端（脖子）')
  // 身体组包围盒底边 = 430
  assert.ok(Math.abs(pv('body')[1] - 430) < 3, '身体枢轴应在脚底')
})

test('包显式写 part / pivot 时以包为准', () => {
  const custom = [
    { z: 0, type: 'shape', shape: 'rect', x: 10, y: 10, w: 100, h: 100, part: 'armR', pivot: [0.5, 0.5] }
  ]
  const rig = F.buildRig(custom, SIZE)
  assert.equal(rig.parts.get(custom[0]), 'armR')
  assert.deepEqual(rig.groups.get('armR').pivot, [60, 60], 'pivot 归一化到图层自身')
})

test('待机：只有呼吸与慢摆，四肢角度为 0', () => {
  const p = F.poseAt({ time: 1234 })
  assert.equal(p.legL.rot, 0)
  assert.equal(p.legR.rot, 0)
  assert.equal(p.armL.rot, 0)
  assert.equal(p.armR.rot, 0)
  assert.equal(p.head.rot, 0)
  assert.ok(Math.abs(p.sy - 1) < 0.02, '呼吸幅度应在 1~2% 内')
  assert.ok(Math.abs(p.rootRot) < 1.5, '慢摆不超过 1.5 度')
})

test('走路：两腿反相摆动、身体朝行进方向前倾、有上下颠', () => {
  let sawOpposite = false
  let sawTilt = false
  let sawBob = false
  for (let t = 0; t < 800; t += 20) {
    const p = F.poseAt({ time: t, walk: 1, dir: 1 })
    if (Math.abs(p.legL.rot - p.legR.rot) > 1) sawOpposite = true
    if (Math.abs(p.legL.rot) > 8) sawBob = sawBob || p.rootY < -0.5
    if (p.rootRot > 1) sawTilt = true
    // 角度不能失控
    assert.ok(Math.abs(p.legL.rot) <= 16, '腿摆幅应 ≤16 度（实际 ' + p.legL.rot + '）')
    assert.ok(p.rootY <= 0.5, '走路只会往上颠，不该往下沉')
  }
  assert.ok(sawOpposite, '两条腿必须反相')
  assert.ok(sawTilt, '朝右走应正向前倾')
  assert.ok(sawBob, '每步要有上下颠')
})

test('走路方向：向左走时前倾反号', () => {
  const right = F.poseAt({ time: 100, walk: 1, dir: 1 })
  const left = F.poseAt({ time: 100, walk: 1, dir: -1 })
  assert.ok(right.rootRot > 0 && left.rootRot < 0, '左右前倾必须相反')
})

test('走路强度 0 时完全回到待机（收步不生硬）', () => {
  const idle = F.poseAt({ time: 500, walk: 0 })
  assert.equal(idle.legL.rot, 0)
  assert.equal(idle.rootY, 0)
})

test('挥手：手臂抬到高位再放下，起收两端归零', () => {
  const at = (q) => F.poseAt({ time: 0, act: 'wave', actP: q }).armR.rot
  assert.ok(Math.abs(at(0)) < 1, '开始时不举')
  assert.ok(at(0.5) < -100, '中间应高举（实际 ' + at(0.5) + '）')
  assert.ok(Math.abs(at(1)) < 1, '结束回到原位')
})

test('点头/摇头：头部有动作，身体不动', () => {
  let nodMax = 0
  let shakeMax = 0
  for (let q = 0; q <= 1; q += 0.05) {
    nodMax = Math.max(nodMax, Math.abs(F.poseAt({ time: 0, act: 'nod', actP: q }).head.rot))
    shakeMax = Math.max(shakeMax, Math.abs(F.poseAt({ time: 0, act: 'shake', actP: q }).head.x))
  }
  assert.ok(nodMax > 5, '点头幅度（实际 ' + nodMax.toFixed(1) + '）')
  assert.ok(shakeMax > 2, '摇头左右位移（实际 ' + shakeMax.toFixed(1) + '）')
  const p = F.poseAt({ time: 0, act: 'nod', actP: 0.5 })
  assert.equal(p.legL.rot, 0, '点头不该带动腿')
})

test('跳跃/开心/跳舞/睡觉都有可观测的姿态变化', () => {
  const peak = (act) => {
    let y = 0
    let rot = 0
    for (let q = 0; q <= 1; q += 0.02) {
      const p = F.poseAt({ time: 0, act, actP: q })
      y = Math.min(y, p.rootY)
      rot = Math.max(rot, Math.abs(p.rootRot) + Math.abs(p.legL.rot))
    }
    return { y, rot }
  }
  assert.ok(peak('jump').y < -10, '跳跃要离地')
  assert.ok(peak('happy').y < -4, '开心要蹦一下')
  assert.ok(peak('dance').rot > 8, '跳舞要摇摆')
  const sleep = F.poseAt({ time: 0, act: 'sleep', actP: 0.5 })
  assert.ok(sleep.rootY > 2 && sleep.head.rot > 5, '睡觉要下沉并歪头')
})

test('未知动作词不产生姿态，也不污染待机', () => {
  const p = F.poseAt({ time: 100, act: 'nonsense', actP: 0.5 })
  assert.equal(p.head.rot, 0)
  assert.equal(p.legL.rot, 0)
  assert.equal(F.hasAction('nonsense'), false)
  assert.equal(F.hasAction('wave'), true)
})

test('没有眼睛/腿的极简包也不会得出 NaN', () => {
  const solo = [{ z: 0, type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 200, h: 200 }]
  const rig = F.buildRig(solo, SIZE)
  const p = F.poseAt({ time: 999, walk: 1, dir: -1, act: 'wave', actP: 0.3 })
  for (const k of ['rootX', 'rootY', 'rootRot', 'sx', 'sy']) {
    assert.ok(Number.isFinite(p[k]), k + ' 必须是有限数')
  }
  assert.equal(rig.parts.get(solo[0]), 'body', '只有一个图层时归到身体')
})
