/* 3D 舞台（shared/vrm-stage.js）单测
 *
 * 用假的 THREE / GLTFLoader / THREEVRM 跑真实模块代码，不需要 Electron/GUI。
 * 覆盖点都是真机踩过的坑：
 *   - 普通 GLB 不是 VRM（VRM.from 抛错）时不能整块失败，要降级成普通 glTF 场景
 *   - 相机必须按包围盒算距离（写死 → 只露上半身）
 *   - gltf 自带 clip 要真的播，且优先 idle 命名的那条
 *   - 眨眼要真的在 expressionManager 上产生非零权重，并且能回到 0
 *   - 说话口型 setTalk(true) → aa > 0，setTalk(false) → aa 回 0
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const CODE = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'shared', 'vrm-stage.js'), 'utf8')

function loadModule () {
  const fakeWindow = {
    performance: { now: () => 0 },
    Image: class {}
  }
  return new Function('window', CODE + '\n;return window.AuraVrm')(fakeWindow)
}

/* 可控时钟：setTimer 只登记，由 advance() 手动推进（眨眼/口型才能确定性断言） */
function makeClock () {
  let t = 0
  const fns = []
  return {
    now: () => t,
    setTimer: (fn) => { fns.push(fn); return fns.length },
    clearTimer: () => {},
    tick () { for (const fn of fns.slice()) fn() },
    advance (ms) { t += ms; this.tick() },
    get time () { return t }
  }
}

function makeLibs (opts) {
  const o = opts || {}
  const box = o.box || { w: 0.7, h: 1.7, d: 0.32 }
  const log = { renders: 0, disposed: false, mixerUpdates: 0, actions: [], vrmUpdates: 0, children: [] }

  class Vector3 {
    constructor (x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
    set (x, y, z) { this.x = x; this.y = y; this.z = z; return this }
  }
  class Box3 {
    constructor () {
      this.min = { x: -1, y: 0, z: -1 }
      this.max = { x: 1, y: box.h, z: 1 }
    }

    setFromObject () { return this }

    getSize (v) { v.x = box.w; v.y = box.h; v.z = box.d }

    getCenter (v) { v.x = 0; v.y = box.h / 2; v.z = 0 }
  }
  class Scene {
    constructor () { this.children = log.children }
    add (x) { this.children.push(x) }
  }
  class PerspectiveCamera {
    constructor (fov, aspect) {
      this.fov = fov
      this.aspect = aspect
      this.position = new Vector3()
      this.updated = 0
    }

    lookAt () { this.lookedAt = true }

    updateProjectionMatrix () { this.updated++ }
  }
  class AnimationMixer {
    constructor (root) { this.root = root }

    clipAction (clip) {
      const action = {
        clip,
        played: false,
        faded: null,
        timeScale: 1,
        time: 0,
        loop: null,
        clampWhenFinished: true,
        play () { this.played = true; return this },
        reset () { this.played = false; this.faded = null; this.time = 0; return this },
        fadeIn (d) { this.faded = 'in:' + d; return this },
        fadeOut (d) { this.faded = 'out:' + d; return this },
        setLoop (mode, reps) { this.loop = mode + ':' + reps; return this }
      }
      log.actions.push(action)
      return action
    }

    update () { log.mixerUpdates++ }

    stopAllAction () {}

    uncacheRoot () {}
  }
  class WebGLRenderer {
    constructor (params) { this.params = params }
    setSize (w, h) { this.w = w; this.h = h }
    render () { log.renders++ }
    dispose () { log.disposed = true }
  }
  const THREE = {
    Vector3,
    Box3,
    Scene,
    PerspectiveCamera,
    AnimationMixer,
    WebGLRenderer,
    DirectionalLight: class { constructor (c, i) { this.intensity = i } },
    AmbientLight: class { constructor (c, i) { this.intensity = i } },
    GridHelper: class {}
  }

  const gltf = o.gltf || {
    scene: { rotation: { y: 0 }, updateMatrixWorld () {}, name: 'plainGlb' },
    animations: []
  }
  class GLTFLoader {
    load (url, onLoad) { Promise.resolve().then(() => onLoad(gltf)) }
  }

  const expr = {
    values: {},
    setValue (n, v) { this.values[n] = v },
    getValue (n) { return this.values[n] || 0 }
  }
  /* 0.27.0：humanoid 骨架。只做 rotation（程序化姿态只写旋转与 root 位置），
     够断言「手臂放下 / 两腿反相 / 膝不反折 / 停走回位」。
     0.30.0 补 head：站姿歪头、转头看别处都靠它。 */
  const BONE_NAMES = ['hips', 'spine', 'chest', 'neck', 'head',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
    'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm']
  const bones = {}
  if (o.humanoid) {
    for (const n of BONE_NAMES) {
      bones[n] = {
        name: n,
        rotation: {
          x: 0,
          y: 0,
          z: 0,
          set (a, b, c) { this.x = a; this.y = b; this.z = c; return this }
        }
      }
    }
  }
  const humanoid = o.humanoid
    ? { getNormalizedBoneNode: (n) => bones[n] || null, autoUpdateHumanBones: true }
    : null
  const vrm = o.vrm === undefined
    ? {
        scene: {
          rotation: { y: 0 },
          position: { x: 0, y: 0, z: 0 },
          updateMatrixWorld () {},
          name: 'vrmScene'
        },
        expressionManager: expr,
        humanoid,
        update () { log.vrmUpdates++ }
      }
    : o.vrm
  const THREEVRM = {
    VRM: {
      from: async () => {
        if (o.vrmFails) throw new Error('不是 VRM 文件')
        return vrm
      }
    }
  }

  return { libs: { THREE, GLTFLoader, THREEVRM }, log, gltf, vrm, expr, bones }
}

function makeCanvas (w = 300, h = 520) {
  return { clientWidth: w, clientHeight: h }
}

test('普通 GLB（不是 VRM）降级渲染，不再整块 fallback', async () => {
  const AuraVrm = loadModule()
  const clock = makeClock()
  const { libs, log, gltf } = makeLibs({ vrmFails: true })

  const stage = AuraVrm.create({
    canvas: makeCanvas(),
    libs,
    url: 'aura://local/model.glb',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  await stage.ready

  assert.equal(stage.vrm, null, '不是 VRM 就没有 vrm 实例')
  assert.equal(stage.root, gltf.scene, '要退回普通 glTF 场景')
  assert.equal(stage.expressions, false, '普通 GLB 没有表情系统')
  assert.equal(gltf.scene.rotation && gltf.scene.rotation.y, 0, '普通模型不强行转身')
  // 普通 GLB 没有 VRM 的材质设定，补一盏环境光，否则暗得看不见
  assert.ok(log.children.some((c) => c && c.constructor && c.constructor.name === 'AmbientLight'), '要补环境光')
  assert.ok(log.renders > 0, '首帧要画出来')
  stage.dispose()
})

test('VRM 朝向相机 + 有表情系统 + 每帧 vrm.update', async () => {
  const AuraVrm = loadModule()
  const clock = makeClock()
  const { libs, log, vrm } = makeLibs({})

  const stage = AuraVrm.create({
    canvas: makeCanvas(),
    libs,
    url: 'aura://local/char.vrm',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  await stage.ready

  assert.equal(stage.vrm, vrm)
  assert.equal(vrm.scene.rotation.y, Math.PI, 'VRM 默认背对相机，要转身')
  assert.equal(stage.expressions, true)
  // 普通模型才补环境光，VRM 保持原样
  assert.ok(!log.children.some((c) => c && c.constructor && c.constructor.name === 'AmbientLight'))
  clock.advance(100)
  assert.ok(log.vrmUpdates > 0, 'springbone/眨眼靠 vrm.update 推进')
  stage.dispose()
})

test('眨眼：先闭到 1 再回到 0，不留残影', async () => {
  const AuraVrm = loadModule()
  const clock = makeClock()
  const { libs, expr } = makeLibs({})

  const stage = AuraVrm.create({
    canvas: makeCanvas(),
    libs,
    url: 'aura://local/char.vrm',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    blinkMin: 0, // 立即可眨，测试不等 6 秒
    blinkMax: 0,
    blinkClose: 20,
    blinkHold: 10
  })
  await stage.ready

  clock.advance(10) // 闭合中段 10/20
  assert.equal(expr.values.blink, 0.5, '闭眼中途半合')
  clock.advance(10) // 20~30 保持全闭
  assert.equal(expr.values.blink, 1, '保持全闭')
  clock.advance(15) // 30~50 张开中段
  assert.ok(expr.values.blink > 0 && expr.values.blink < 1, '张开中段')
  clock.advance(30) // 结束
  assert.equal(expr.values.blink, 0, '眨完必须回到 0（否则一直眯眼）')
  stage.dispose()
})

test('说话口型：setTalk(true) 驱动 aa，关掉后回 0', async () => {
  const AuraVrm = loadModule()
  const clock = makeClock()
  const { libs, expr } = makeLibs({})

  const stage = AuraVrm.create({
    canvas: makeCanvas(),
    libs,
    url: 'aura://local/char.vrm',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  await stage.ready

  clock.advance(16)
  assert.equal(expr.values.aa || 0, 0, '不说话嘴要闭着')

  stage.setTalk(true)
  clock.advance(16)
  const a = expr.values.aa
  assert.ok(a > 0, '说话时嘴要张开，实际=' + a)
  clock.advance(60)
  assert.ok(expr.values.aa !== a, '口型要有起伏，不是一直一个开度')

  stage.setTalk(false)
  clock.advance(16)
  assert.equal(expr.values.aa, 0, '说完必须回到闭合')
  stage.dispose()
})

test('自带动画：优先 idle/stand 命名，否则第一条；没有动画不报错', async () => {
  const AuraVrm = loadModule()

  // 三条 clip，idle 在中间
  const clock = makeClock()
  const withIdle = makeLibs({
    gltf: {
      scene: { rotation: { y: 0 }, updateMatrixWorld () {} },
      animations: [
        { name: 'Walk', tracks: [{ name: 'a' }] },
        { name: 'idle_loop', tracks: [{ name: 'b' }] },
        { name: 'Run', tracks: [{ name: 'c' }] }
      ],
      vrmFails: true
    },
    vrmFails: true
  })
  const s1 = AuraVrm.create({
    canvas: makeCanvas(), libs: withIdle.libs, url: 'x', now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  await s1.ready
  assert.equal(s1.clip.name, 'idle_loop', '要挑待机动画，而不是排第一的走路')
  assert.ok(withIdle.log.actions[0].played, 'clip 要真的 play')
  clock.advance(40)
  assert.ok(withIdle.log.mixerUpdates > 0, '每帧推进 mixer')
  s1.dispose()

  // 没有 idle 名 → 用第一条；一条都没有 → clip 为 null 且不抛
  const clock2 = makeClock()
  const noIdle = makeLibs({
    gltf: { scene: { rotation: { y: 0 }, updateMatrixWorld () {} }, animations: [{ name: 'Run', tracks: [{ name: 'c' }] }] },
    vrmFails: true
  })
  const s2 = AuraVrm.create({
    canvas: makeCanvas(), libs: noIdle.libs, url: 'y', now: clock2.now, setTimer: clock2.setTimer, clearTimer: clock2.clearTimer
  })
  await s2.ready
  assert.equal(s2.clip.name, 'Run')
  s2.dispose()

  const clock3 = makeClock()
  const none = makeLibs({
    gltf: { scene: { rotation: { y: 0 }, updateMatrixWorld () {} }, animations: [] },
    vrmFails: true
  })
  const s3 = AuraVrm.create({
    canvas: makeCanvas(), libs: none.libs, url: 'z', now: clock3.now, setTimer: clock3.setTimer, clearTimer: clock3.clearTimer
  })
  await s3.ready
  assert.equal(s3.clip, null)
  assert.equal(none.log.mixerUpdates, 0, '没动画就不要建 mixer 空转')
  s3.dispose()
})

test('取景随模型大小变化（相机不写死距离）', async () => {
  const AuraVrm = loadModule()

  const shoot = async (h) => {
    const clock = makeClock()
    const m = makeLibs({ box: { w: 0.6, h, d: 0.3 }, vrmFails: true })
    const stage = AuraVrm.create({
      canvas: makeCanvas(300, 520), libs: m.libs, url: 'x', now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
    })
    await stage.ready
    const z = stage.camera.position.z
    const y = stage.camera.position.y
    stage.dispose()
    return { z, y }
  }

  const small = await shoot(1.0)
  const tall = await shoot(1.9)
  assert.ok(Math.abs(tall.z) > Math.abs(small.z), '越高的模型相机要退更远：' + small.z + ' vs ' + tall.z)
  assert.ok(Math.abs(small.y - 0.5) < 0.01, '相机高度对准模型中心（1.0 高的模型中心是 0.5）')
  assert.ok(Math.abs(tall.y - 0.95) < 0.01, '相机高度对准模型中心（1.9 高的模型中心是 0.95）')
})

test('dispose 之后不再渲染（换模型/切换形象不留后台循环）', async () => {
  const AuraVrm = loadModule()
  const clock = makeClock()
  const { libs, log } = makeLibs({})

  const stage = AuraVrm.create({
    canvas: makeCanvas(), libs, url: 'x', now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  await stage.ready
  const before = log.renders
  clock.advance(16)
  assert.ok(log.renders > before)
  stage.dispose()
  const after = log.renders
  clock.advance(16)
  clock.advance(16)
  assert.equal(log.renders, after, 'dispose 后不能继续画（否则两块屏/两个模型抢 GPU）')
  assert.equal(log.disposed, true, 'renderer 要释放')
})

test('舞台尺寸变化后自动重算画布尺寸（hidden→显示不再 0×0）', async () => {
  const AuraVrm = loadModule()
  const clock = makeClock()
  const { libs } = makeLibs({})
  const canvas = makeCanvas(0, 0) // 舞台还没显示

  const stage = AuraVrm.create({
    canvas, libs, url: 'x', now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  })
  await stage.ready
  assert.equal(stage.camera.aspect, 300 / 520, '拿不到尺寸时用兜底比例，不能算出 NaN')

  canvas.clientWidth = 240
  canvas.clientHeight = 400
  clock.advance(16)
  assert.equal(stage.camera.aspect, 240 / 400, '尺寸变化当帧就要跟上')
  assert.equal(stage.renderer.w, 240)
  assert.equal(stage.renderer.h, 400)
  stage.dispose()
})

test('鼠标延迟：RESTING_FPS 两档调度 + hidden 停表（Coopanion 模式移植）', async () => {
  // 静态断言（动态行为被假 THREE 时钟覆盖成本太高，模式本身由真机帧率验证）：
  assert.match(CODE, /restFps/, '要有闲时帧率参数')
  assert.match(CODE, /isBusy/, '要有忙闲判定注入点')
  /* 0.45.62 起不再信 document.hidden（透明置顶 overlay 会被 Chromium 误判 occluded，
     导致这块屏的实例整帧跳过、姿势冻住），改成只信主进程下发的 hiddenFn */
  assert.match(CODE, /hiddenFn/, '窗口显隐要由主进程下发（别信 document.hidden）')
  assert.match(CODE, /visibilitychange/, '窗口 hidden 要停表、可见要恢复')
  // pet.js 侧：spine 循环同样两档 + hidden 跳过，并把 petBusy 传给 VRM 舞台
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'pet.js'), 'utf8')
  assert.match(pet, /function restMs|const restMs|restMs\(\)/, 'spine 循环要有闲时档')
  assert.match(pet, /const busyMs|busyMs\(\)/, '忙时按设置帧率')
  assert.match(pet, /petBusy\(\) \? busyMs\(\) : restMs\(\)/, '忙闲两档要真的切')
  assert.match(pet, /isBusy: petBusy/, 'VRM 舞台要接 petBusy')
  assert.match(pet, /if \(document\.hidden\) \{ lastT = performance\.now\(\); return \}/, 'spine 循环 hidden 时整帧跳过')
})

/* ---------------- 0.27.0 程序化姿态（VRM 不靠美术动画文件也能待机 / 走路） ---------------- */

test('0.27.0：没有动画片段的 VRM 不能一直 T 字站着，手臂要放下来', async () => {
  const AuraVrm = loadModule()
  const clock = makeClock()
  const { libs, bones } = makeLibs({ humanoid: true })

  const stage = AuraVrm.create({
    canvas: makeCanvas(),
    libs,
    url: 'aura://local/vroid.vrm',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  await stage.ready
  clock.advance(16)

  assert.equal(stage.posed, true, '有 humanoid、没片段 → 应该启用程序化姿态')
  assert.ok(bones.leftUpperArm.rotation.z < -0.8, '左臂要放下（T 字是 0），实际=' + bones.leftUpperArm.rotation.z)
  assert.ok(bones.rightUpperArm.rotation.z > 0.8, '右臂要朝相反方向放下，实际=' + bones.rightUpperArm.rotation.z)
  assert.ok(Math.abs(bones.leftUpperArm.rotation.x) < 0.05, '待机时手臂不该前后摆')
  assert.ok(Math.abs(bones.leftUpperLeg.rotation.x) < 0.001, '待机时腿要站直')
  stage.dispose()
})

test('0.27.0：走路两腿反相、膝盖只朝屈膝方向弯、停走回位', async () => {
  const AuraVrm = loadModule()
  const clock = makeClock()
  const { libs, bones, vrm } = makeLibs({ humanoid: true })

  const stage = AuraVrm.create({
    canvas: makeCanvas(),
    libs,
    url: 'aura://local/vroid.vrm',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  await stage.ready

  stage.setWalk(true, -1, 105) // 活跃档：105px/s
  let sawOpposite = false
  let maxKnee = 0
  let minKnee = Infinity
  let maxBob = 0
  let maxThigh = 0
  for (let i = 0; i < 8; i++) {
    clock.advance(60)
    const l = bones.leftUpperLeg.rotation.x
    const r = bones.rightUpperLeg.rotation.x
    maxThigh = Math.max(maxThigh, Math.abs(l))
    if (Math.abs(l + r) < 1e-9 && Math.abs(l) > 0.1) sawOpposite = true
    maxKnee = Math.max(maxKnee, bones.leftLowerLeg.rotation.x)
    minKnee = Math.min(minKnee, bones.leftLowerLeg.rotation.x)
    maxBob = Math.max(maxBob, Math.abs(vrm.scene.position.y))
  }
  assert.ok(sawOpposite, '左右大腿必须反相摆动（同向 = 像蹦跳）')
  assert.ok(maxThigh > 0.15, '腿要真的迈开，实际最大=' + maxThigh)
  assert.ok(maxKnee > 0.15, '膝盖要弯，实际最大=' + maxKnee)
  assert.ok(minKnee >= -1e-9, '膝盖不能反向折（负值 = 反关节），实际最小=' + minKnee)
  assert.ok(maxBob > 0, '走路要有上下起伏，实际=' + maxBob)

  // 停走：淡出后腿回直、root 回原位（否则会卡在最后那个迈步姿势）
  stage.setWalk(false)
  for (let i = 0; i < 3; i++) clock.advance(100)
  assert.ok(Math.abs(bones.leftUpperLeg.rotation.x) < 1e-9, '停下腿要站直，实际=' + bones.leftUpperLeg.rotation.x)
  assert.equal(vrm.scene.position.y, 0, '停下 root 要回原位')
  assert.ok(bones.leftUpperArm.rotation.z < -0.8, '停下手臂仍放下，不能弹回 T 字')
  stage.dispose()
})

test('0.32.1：模型自带走路片段时走路也走程序化接管（官方 clip 摆幅不可读），停走回官方待机', async () => {
  const AuraVrm = loadModule()
  const clock = makeClock()
  const { libs, log, bones } = makeLibs({
    humanoid: true,
    gltf: {
      scene: { rotation: { y: 0 }, position: { x: 0, y: 0, z: 0 }, updateMatrixWorld () {} },
      animations: [
        { name: 'idle_loop', tracks: [{ name: 'a' }] },
        { name: 'Walk_Fwd', tracks: [{ name: 'b' }] }
      ]
    }
  })

  const stage = AuraVrm.create({
    canvas: makeCanvas(),
    libs,
    url: 'aura://local/mixamo.vrm',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  await stage.ready

  assert.equal(stage.posed, false, '待机时官方片段在播，程序化让路')
  assert.equal(log.actions.length, 2, '待机 + 走路两个动作都要建')
  assert.ok(log.actions[0].played, '待机片段默认在播')

  stage.setWalk(true, 1, 60)
  assert.equal(stage.posed, true, '走路要切程序化接管（clip 走路摆幅不可读/循环边界跳变）')
  for (let i = 0; i < 40; i++) clock.advance(10) // 步伐淡入 + 相位推进
  assert.ok(Math.abs(bones.leftUpperLeg.rotation.x) > 0, '程序化走路要真的在摆腿')

  stage.setWalk(false)
  for (let i = 0; i < 40; i++) clock.advance(10) // 停走释放
  assert.equal(stage.posed, false, '停下交还官方待机片段')
  const idleA = log.actions.filter((a) => a.clip && a.clip.name === 'idle_loop').pop()
  assert.ok(idleA && idleA.played, '停走后官方待机要重新播')
  stage.dispose()
})

/* ---------------- 0.30.0 站姿自然度 / 待机动作 / 步频（用户：站得太呆、走得太快） ---------------- */

function makeStage (clock, opts) {
  const AuraVrm = loadModule()
  const made = makeLibs(Object.assign({ humanoid: true }, opts || {}))
  const selfActs = []
  const stage = AuraVrm.create({
    canvas: makeCanvas(),
    libs: made.libs,
    url: 'aura://local/ryza.vrm',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    // 0.33.0 自主动作上报：录下回调，测试小彩蛋自播时要「让她自己知道」
    onSelfAct: (kind) => { selfActs.push(String(kind || '')) }
  })
  return { stage, selfActs, ...made }
}

test('0.30.0：站姿不笔直对称（微屈膝 + 两脚外展 + 头部歪一点随时间变）', async () => {
  const clock = makeClock()
  const { stage, bones } = makeStage(clock)
  await stage.ready
  clock.advance(16)

  assert.ok(bones.leftLowerLeg.rotation.x > 0.04, '常驻微屈膝（锁直膝盖一眼假），实际=' + bones.leftLowerLeg.rotation.x)
  assert.ok(bones.rightLowerLeg.rotation.x > 0.04, '两条腿都要微屈，实际=' + bones.rightLowerLeg.rotation.x)
  assert.ok(bones.leftUpperLeg.rotation.z > 0.01, '左脚要向外站一点，实际=' + bones.leftUpperLeg.rotation.z)
  assert.ok(bones.rightUpperLeg.rotation.z < -0.01, '右脚朝反方向外展，实际=' + bones.rightUpperLeg.rotation.z)
  assert.ok(Math.abs(bones.leftUpperArm.rotation.z) > 0.9, '手臂仍然放下')

  // 头部歪 / 重心倾斜是慢周期（9.1s），两个时刻的值必须不同，否则就是死的
  const h0 = bones.head.rotation.z
  const hip0 = bones.hips.rotation.z
  clock.advance(2400)
  assert.ok(Math.abs(bones.head.rotation.z - h0) > 1e-4, '头部倾斜要随时间变化（呼吸/重心）')
  assert.ok(Math.abs(bones.hips.rotation.z - hip0) > 1e-4, '骨盆侧倾要随时间变化')
  stage.dispose()
})

test('0.30.0：待机会自己换动作，不是只会呼吸的死站桩', async () => {
  const clock = makeClock()
  const { stage, bones } = makeStage(clock)
  await stage.ready

  // 刚出现不能立刻做大动作（否则像幻灯片自动播放）
  clock.advance(1200)
  assert.equal(stage.gesture, null, '头 1.2 秒只呼吸')

  // 调度窗口最多 3.5s 后开始，9 秒内一定做过动作
  let id = null
  for (let i = 0; i < 900 && !id; i++) {
    clock.advance(10)
    id = stage.gesture
  }
  assert.ok(id, '待机 9 秒内必须自己做一个动作')
  assert.ok(stage.playGesture('stretch'), 'stretch 是可播的手势')
  assert.equal(stage.playGesture('noSuchGesture'), false, '不认识的手势要返回 false')

  // 伸懒腰：手臂明显抬起（待机 z ≈ -1.12，抬手是往 0 方向去）
  const before = bones.leftUpperArm.rotation.z
  clock.advance(1200)
  assert.ok(bones.leftUpperArm.rotation.z > before + 0.3, '手臂要抬起来，实际=' + bones.leftUpperArm.rotation.z + ' / 之前=' + before)
  assert.ok(Math.abs(bones.head.rotation.x) > 0.02, '伸懒腰要抬头，实际=' + bones.head.rotation.x)
  stage.dispose()
})

test('0.30.0：走路步频降下来（不是 3 步/秒的小跑），且摆幅随速度自适应', async () => {
  const clock = makeClock()
  const { stage, bones } = makeStage(clock)
  await stage.ready

  stage.setWalk(true, 1, 46) // 悠闲档
  const xs = []
  for (let i = 0; i < 700; i++) {
    clock.advance(10)
    xs.push(bones.leftUpperLeg.rotation.x)
  }
  // 找局部极大（= 每迈完一步的时刻），相邻间隔就是单步耗时
  const peaks = []
  for (let i = 1; i < xs.length - 1; i++) {
    if (xs[i] > xs[i - 1] && xs[i] >= xs[i + 1] && xs[i] > 0.05) peaks.push(i)
  }
  const gaps = []
  for (let i = 1; i < peaks.length; i++) gaps.push((peaks[i] - peaks[i - 1]) * 10)
  const avg = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1)
  assert.ok(gaps.length >= 3, '7 秒里至少要迈三四步，实测峰数=' + peaks.length)
  assert.ok(avg > 700, '单步不能快过 700ms（0.29.0 是 327ms = 3 步/秒），实际=' + Math.round(avg) + 'ms')

  // 摆幅自适应：慢走小碎步，不会出现「脚甩 180px、人只挪 30px」的滑冰
  const maxCalm = Math.max(...xs.map(Math.abs))
  assert.ok(maxCalm < 0.30, '悠闲档摆幅要收着，实际=' + maxCalm.toFixed(3))
  assert.ok(maxCalm > 0.10, '再收也要看得出在迈步，实际=' + maxCalm.toFixed(3))

  stage.dispose()
})

test('0.30.0：常见动作手势齐全（拍手/摇头/思考/捂脸/招手/抱臂/欢呼/鞠躬）', async () => {
  const clock = makeClock()
  const { stage, bones } = makeStage(clock)
  await stage.ready
  clock.advance(16)

  const list = ['wave', 'nod', 'shake', 'clap', 'think', 'coverFace', 'beckon', 'armsCross', 'cheer', 'bow', 'stretch', 'handHip', 'fixHair', 'lookAside', 'lookDown', 'bounce']
  for (const id of list) {
    assert.ok(stage.playGesture(id), '手势 ' + id + ' 必须可播')
    clock.advance(3000) // 播完/被打断都行，只要不炸
  }
  assert.equal(stage.playGesture('nope'), false)

  // 摇头 = 头左右（y）摆，前后（x）不动；点头正相反
  stage.playGesture('shake')
  const ys = []
  for (let i = 0; i < 160; i++) { clock.advance(10); ys.push(bones.head.rotation.y) }
  assert.ok(Math.max(...ys.map(Math.abs)) > 0.10, '摇头要左右摆，最大=' + Math.max(...ys.map(Math.abs)).toFixed(3))

  // 拍手 = 两前臂相向开合（z 一负一正，往中线收）
  stage.playGesture('clap')
  const lz = []; const rz = []
  for (let i = 0; i < 160; i++) { clock.advance(10); lz.push(bones.leftLowerArm.rotation.z); rz.push(bones.rightLowerArm.rotation.z) }
  assert.ok(Math.min(...lz) < -0.10 && Math.max(...rz) > 0.10, '拍手前臂要有开合，Lz最小=' + Math.min(...lz).toFixed(3) + ' Rz最大=' + Math.max(...rz).toFixed(3))
  stage.dispose()
})


/* ---------------- 0.31.0 官方动画（mixer 模式） ---------------- */

function makeStageClips (clock) {
  const AuraVrm = loadModule()
  const made = makeLibs({
    humanoid: true,
    gltf: {
      scene: { rotation: { y: 0 }, position: { x: 0, y: 0, z: 0 }, updateMatrixWorld () {}, name: 'vrmScene' },
      animations: [
        { name: 'idle', tracks: [{ name: 'SK_Hips.quaternion' }] },
        { name: 'walk', tracks: [{ name: 'SK_L_UpLeg.quaternion' }] },
        { name: 'run', tracks: [{ name: 'SK_L_UpLeg.quaternion' }] },
        { name: 'gust_00060', tracks: [{ name: 'SK_Hips.quaternion' }], duration: 2 },
        { name: 'idle_fidget', tracks: [{ name: 'SK_Hips.quaternion' }], duration: 10 }
      ]
    }
  })
  const selfActs = []
  const stage = AuraVrm.create({
    canvas: makeCanvas(),
    libs: made.libs,
    url: 'aura://local/ryza.vrm',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    // 0.33.0 自主动作上报：录下回调，测试小彩蛋自播时要「让她自己知道」
    onSelfAct: (kind) => { selfActs.push(String(kind || '')) }
  })
  return { stage, selfActs, ...made }
}

test('0.31.0：有官方动画时启用 mixer、关掉 autoUpdateHumanBones、程序化让路', async () => {
  const clock = makeClock()
  const { stage, vrm, log } = makeStageClips(clock)
  await stage.ready
  clock.advance(32)
  assert.ok(vrm.humanoid && vrm.humanoid.autoUpdateHumanBones === false, '必须关掉 autoUpdateHumanBones（否则动画被 rest 覆盖，腿不动）')
  assert.equal(stage.posed, false, 'mixer 模式程序化让路')
  const idleA = log.actions.find((a) => a.clip && a.clip.name === 'idle')
  assert.ok(idleA && idleA.played, 'idle clip 要播')
  stage.dispose()
})

test('0.32.1：mixer 模式走路回退程序化接管（官方 walk 摆幅太小），停走交还官方 idle', async () => {
  const clock = makeClock()
  const { stage, log, vrm } = makeStageClips(clock)
  await stage.ready
  clock.advance(32)
  stage.setWalk(true, 1, 52)
  assert.equal(stage.posed, true, '走路要切程序化接管（官方 walk clip 摆幅只有 ~8°，像滑行）')
  for (let i = 0; i < 60; i++) clock.advance(10) // 小步推进：侧身 lerp 要多帧收敛
  // 0.33.0 方向修正（walk-probe 截图实测）：dir=1（往右挪）→ root = π − π/2 脸才朝右
  // dir=1（往右走）→ root = π + π/2（walk-probe 数值判定：相机在 -Z 侧，屏幕右=世界 -X，
  // Δ=+90° 时 front=-X 才朝屏幕右）。0.33.0 曾两次误翻成 π−π/2，均被用户实测打回
  assert.ok(Math.abs(vrm.scene.rotation.y - (Math.PI + Math.PI / 2)) < 0.2, '走路要侧身朝行进方向（往右 = π+π/2），实际 y=' + vrm.scene.rotation.y.toFixed(2))
  assert.ok(vrm.humanoid.autoUpdateHumanBones === true, '程序化接管期间要开 autoUpdate（normalized 拷到 raw 才可见）')
  stage.setWalk(false, 1, 52)
  for (let i = 0; i < 60; i++) clock.advance(10) // 停走 → 释放 → 交还官方 idle
  assert.equal(stage.posed, false, '停走要交还官方动画')
  assert.ok(vrm.humanoid.autoUpdateHumanBones === false, '释放后要关 autoUpdate（否则盖掉 mixer 的 raw 写入）')
  const idleA = log.actions.filter((a) => a.clip && a.clip.name === 'idle').pop()
  assert.ok(idleA && idleA.played, '停走后官方 idle 要重新播')
  stage.dispose()
})

test('0.31.0：mixer 模式手势/坐下暂停官方动画，结束后自动交还', async () => {
  const clock = makeClock()
  const { stage } = makeStageClips(clock)
  await stage.ready
  clock.advance(32)
  assert.ok(stage.playGesture('wave'), 'mixer 模式 playGesture 也要能播（走 holdAnim）')
  assert.equal(stage.posed, true, '手势期间程序化接管')
  for (let i = 0; i < 450; i++) clock.advance(10) // 手势最长 3s，播完 + 释放（多帧）
  assert.equal(stage.posed, false, '播完要交还给官方动画')
  assert.ok(stage.playGesture('wave'), '释放后还能再播')

  stage.setPose('sit')
  assert.equal(stage.posed, true, '坐下要切程序化坐姿')
  for (let i = 0; i < 60; i++) clock.advance(10)
  stage.setPose('stand')
  // 起身后可能还有随机手势在收尾（调度器每 2.2~7s 一个），最长一个手势 + 释放
  for (let i = 0; i < 420; i++) clock.advance(10)
  assert.equal(stage.posed, false, '起身交还官方动画')
  stage.dispose()
})

test('0.32.0：playClip 按名字点播官方动画，播完自动回 idle', async () => {
  const clock = makeClock()
  const { stage, log } = makeStageClips(clock)
  await stage.ready
  clock.advance(32)
  assert.ok(stage.playClip('gust_00060'), '点播存在的 clip 返回 true')
  const act = log.actions.filter((a) => a.clip && a.clip.name === 'gust_00060').pop()
  assert.ok(act.played, '官方 clip 要 play')
  assert.ok(act.loop && String(act.loop).endsWith(':1'), '要 LoopOnce 一次性播，实际=' + act.loop)
  assert.equal(stage.posed, false, '点播不切程序化（mixer 继续管骨骼）')
  // 播完（duration 2s + fade 0.12s，留裕量）后回 idle
  for (let i = 0; i < 260; i++) clock.advance(10)
  const idleRefade = log.actions.filter((a) => a.clip && a.clip.name === 'idle').pop()
  assert.ok(idleRefade && idleRefade.played, '播完要回 idle')
  stage.dispose()
})

test('0.32.0：走路时拒绝点播；playGesture 直通 gust_ 编号；未知名字返回 false', async () => {
  const clock = makeClock()
  const { stage } = makeStageClips(clock)
  await stage.ready
  clock.advance(32)
  stage.setWalk(true, 1, 52)
  clock.advance(16)
  assert.equal(stage.playClip('gust_00060'), false, '走路中不能点播')
  stage.setWalk(false, 1, 52)
  for (let i = 0; i < 40; i++) clock.advance(10)
  assert.ok(stage.playGesture('gust_00060'), 'playGesture 对 gust_ 编号直通 playClip')
  assert.equal(stage.playClip('gust_99999'), false, '不存在的 clip 返回 false')
  stage.dispose()
})

test('0.32.1：安静待机基底 + 长待机小彩蛋 45~90s 偶尔来一次，不每圈重复', async () => {
  const clock = makeClock()
  const { stage, log } = makeStageClips(clock)
  await stage.ready
  // 首次彩蛋在 30~60s（0.45.53 起站立窗口 25~55s）；推进 29s 内不该出现（安静基底不被频繁打断）
  for (let i = 0; i < 290; i++) clock.advance(100)
  const early = log.actions.filter((a) => a.clip && a.clip.name === 'idle_fidget')
  assert.equal(early.length, 0, '29s 内不该播小彩蛋（最短间隔 30s）')
  // 再推进到 90s：初始 30~60s + 间隔 45~90s 内可能已触发多次，至少一次
  for (let i = 0; i < 600; i++) clock.advance(100)
  const fidgets = log.actions.filter((a) => a.clip && a.clip.name === 'idle_fidget')
  assert.ok(fidgets.length >= 1, '90s+ 内至少播过一次 idle_fidget')
  stage.dispose()
})

test('0.33.0：小彩蛋自播时触发 onSelfAct 上报（她自己要知道刚做了什么）', async () => {
  const clock = makeClock()
  const { stage, log, selfActs: selfActLog } = makeStageClips(clock)
  await stage.ready
  for (let i = 0; i < 910; i++) clock.advance(100)
  const plays = log.actions.filter((a) => a.clip && a.clip.name === 'idle_fidget').length
  assert.ok(plays >= 1, '前提：90s+ 内至少播过一次 idle_fidget')
  // 上报次数与播放次数一致（每次自播都要让她自己知道）
  const selfActs = (selfActLog || []).filter((k) => k === 'idle_fidget').length
  assert.equal(selfActs, plays, 'onSelfAct 上报次数应与 idle_fidget 播放次数一致')
  stage.dispose()
})
