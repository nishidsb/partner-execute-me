/* 3D 舞台（VRM 0.x / VRM 1.0 / 普通 GLB）
 *
 * 伙伴 overlay 与伴侣窗共用这一份实现，避免两处各写一遍导致行为漂移
 * （之前伙伴的相机按包围盒适配过，伴侣窗还写死 (0,1.35,-1.6)，预览里只露上半身）。
 *
 * 能力：
 *   - 取景：按模型实际包围盒算距离（垂直/水平都塞得下 + 半个厚度），舞台尺寸变化自动重算
 *   - 模型：先按 VRM 解析（three-vrm），失败就当普通 glTF 场景渲染
 *           —— 从 Sketchfab 之类下载的 GLB 不是 VRM，以前 VRM.from 抛错就整块 ✦ 兜底
 *   - 动画：gltf 自带 clip 自动播放，优先名字含 idle/stand/wait/breath 的那条，否则第一条
 *   - 表情：程序化眨眼 + 说话口型（只有 VRM 有 expressionManager；普通 GLB 自动跳过）
 *   - 循环：setInterval（伙伴层是置底透明窗口，被覆盖时 Chromium 会暂停 rAF）。
 *           dt 上限 0.1s，掉帧时不会让 springbone 物理炸开。
 *
 * 依赖 window.AuraLibs（THREE / GLTFLoader / THREEVRM），不额外引入任何包。
 */
;(function (global) {
  'use strict'

  // 待机动画的常见命名（UniVRM / Blender / Mixamo / VRoid 导出的都有）
  const IDLE_RE = /idle|stand|wait|breath|loop|待机|呼吸|静止/i
  // 走路动画的常见命名（Mixamo 的 walk/run、Blender 导出、示例动作包）
  const WALK_RE = /walk|run|jog|歩|走|移動|move/i

  /* 程序化姿态参数（0.27.0）。
   * VRoid / Booth 上绝大多数 VRM 是「只有模型、没有动画片段」，直接渲染出来是 T 字站桩，
   * 而且窗口平移时人是滑过去的。这里用 humanoid 归一化骨骼摆出待机 + 走路的姿态，
   * 不需要任何美术动画文件。调观感只改这里，别把魔数散到各处。 */
  const POSE = {
    /* ---- 走路（0.30.0 重调）----
       0.29.0 的问题：步频按 34000/speed 算，velvet 档 52px/s → 每步 327ms（3 步/秒），
       真人 1.6~1.8 步/秒，看着像小跑；而且摆幅写死 0.40rad，脚前后甩 180px、人只挪 30px
       = 滑冰。现在步频跟速度成线性（1.1~2.0 步/秒），摆幅由「脚速必须等于地面速度」反解，
       慢走就是小碎步 + 明显抬膝，快走才张开。 */
    legSwingMin: 0.16, // 摆幅下限（再小就看不出在迈步）
    legSwingMax: 0.38, // 摆幅上限（跑起来也不会劈叉）
    legSwingGain: 1.6, // 视觉放大：允许一点滑移换取读得出来的迈步
    kneeLift: 0.70, // 抬腿相的屈膝峰值（离地那条腿，滑不滑冰都好看）
    kneeSoft: 0.10, // 支撑腿也微屈，锁死膝盖一眼假
    armSwing: 0.20, // 手臂反相摆
    armDown: 1.12, // 待机把 T 字手臂放下来
    elbowBend: 0.20, // 常驻肘部微弯（垂手时小臂略朝前，比笔直放松）
    armOut: -0.10, // 待机手臂往躯干收（0.30.0 加反了方向：正值是往外推，用户嫌手离身体太远）
    lean: 0.045, // 走路时上身前倾
    yaw: 0.09, // 走路时身体朝行进方向偏一点
    hipTilt: 0.045, // 走路时骨盆左右倾（重心交替落到支撑脚）
    bob: 0.005, // 每步上下起伏（占模型高度比例）
    /* ---- 站姿（0.30.0 新增）----
       人站着从来不笔直又对称：骨盆有点侧倾、承重脚那条腿更弯、两脚微微分开、
       一侧手臂贴得更紧、头略歪。这几项按 9.1s 慢周期在两脚之间换重心。 */
    standKneeSoft: 0.10, // 常驻微屈膝
    footSplit: 0.045, // 两脚外展（大腿 z 轴，正负反了就内八，只此一处可翻）
    standHipTilt: 0.042, // 骨盆侧倾
    standHeadTilt: 0.026, // 头略歪（和骨盆反相）
    standArmAsym: 0.05, // 两侧手臂不对称
    /* ---- 待机呼吸层（0.28.0）---- */
    idleBreath: 0.030, // 呼吸：胸/脊各 ±1.7°
    idleSway: 0.050, // 重心左右挪（胯部偏转）
    idleHead: 0.032, // 头轻微转（慢一档，像在看东西）
    idleArm: 0.020 // 手臂随呼吸微摆
  }
  /* 待机手势库（0.30.0）。用户「站得太呆」的反馈：光靠呼吸/微摆只有 1~2° 的动静，
     远看就是一尊会呼吸的雕像。这里给一组「真的会做的动作」，每隔 2~7 秒挑一个播。
     每个手势 fn(q) 返回骨骼增量（弧度），q 是 0→1 的进度；包络统一 sin(πq)，
     起落平滑、随时被打断也不跳。sit=true 的手势坐着也能做（伸懒腰坐着很怪）。 */
  const GESTURES = {
    // 转头看别处：最常做，上身基本不动，只有头/颈转，像在打量桌面
    lookAside: {
      dur: [2000, 3400], weight: 3, sit: true,
      fn (q, g) {
        const s = Math.sin(Math.PI * q)
        const d = g.dir || 1
        return {
          head: [0.03 * s, 0.40 * s * d, 0.06 * s],
          neck: [0.01 * s, 0.16 * s * d, 0],
          chest: [0, 0.05 * s * d, 0]
        }
      }
    },
    // 低头看脚下 / 看桌沿
    lookDown: {
      dur: [1700, 2600], weight: 2, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        return { head: [0.24 * s, 0.06 * s, 0], neck: [0.10 * s, 0, 0], chest: [0.04 * s, 0, 0] }
      }
    },
    // 换重心：胯往一侧沉，那条腿更弯，另一条放松
    weightShift: {
      dur: [3400, 5000], weight: 3, sit: false,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        return {
          hips: [0, 0, 0.09 * s],
          leftLowerLeg: [0.12 * s, 0, 0],
          rightLowerLeg: [-0.05 * s, 0, 0],
          spine: [0, 0, -0.03 * s],
          head: [0, 0.05 * s, -0.05 * s]
        }
      }
    },
    // 伸懒腰：双臂抬起 + 上身后仰 + 抬头
    // 0.45.51 weight 1→0 退出随机池：用户「双手向前的动作不太行」——起手双臂
    // 从体侧往前抬的过程观感差。仅保留显式触发（聊天动作词/主人的指令）。
    stretch: {
      dur: [2600, 3400], weight: 0, sit: false,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        return {
          leftUpperArm: [-0.16 * s, 0, 1.60 * s],
          rightUpperArm: [-0.16 * s, 0, -1.60 * s],
          leftLowerArm: [-0.42 * s, 0, 0],
          rightLowerArm: [-0.42 * s, 0, 0],
          spine: [-0.10 * s, 0, 0],
          chest: [-0.08 * s, 0, 0],
          head: [-0.16 * s, 0, 0],
          neck: [-0.06 * s, 0, 0]
        }
      }
    },
    // 单手叉腰
    handHip: {
      dur: [3000, 4600], weight: 2, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        return {
          leftUpperArm: [0.35 * s, 0, 0.72 * s],
          leftLowerArm: [-1.30 * s, 0, -0.35 * s],
          hips: [0, 0.05 * s, 0.02 * s],
          head: [0, -0.10 * s, 0.05 * s]
        }
      }
    },
    // 抬手拨头发（右手到耳侧）
    fixHair: {
      dur: [2000, 2800], weight: 1, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        return {
          rightUpperArm: [-0.20 * s, 0, -1.05 * s],
          rightLowerArm: [-1.95 * s, 0, -0.45 * s],
          head: [0.05 * s, 0.07 * s, 0.08 * s],
          chest: [0, -0.03 * s, 0]
        }
      }
    },
    /* 挥手 / 点头：权重 0 = 不进随机池，只在 playGesture 或聊天动作词（pet_say 的【挥手】）里用。
       真实对话里「挥手打招呼」「点头」比伸懒腰常见得多，但自己待机时挥手很怪。 */
    wave: {
      dur: [2200, 3000], weight: 0, sit: true,
      fn (q) {
        // 快速举起 → 保持 → 快速放下（不能用 sin(πq)：中间是峰值，q>0.45 手臂就掉了）
        const up = Math.min(1, q * 4, (1 - q) * 4)
        const sw = Math.sin(Math.PI * 6 * q) * up
        return {
          rightUpperArm: [-0.16 * up, 0, -1.20 * up],
          rightLowerArm: [-0.60 * up, 0, -0.50 * sw],
          head: [0, 0.07 * up, 0.05 * up],
          chest: [0, 0.03 * up, 0]
        }
      }
    },
    nod: {
      dur: [1100, 1600], weight: 0, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * 3 * q) * Math.sin(Math.PI * q) // 三次点头 + 起落包络
        return { head: [0.17 * s, 0, 0], neck: [0.07 * s, 0, 0] }
      }
    },
    /* ---------- 0.45.54 坐姿专用大动作 ----------
       用户「动作还是一样」的真实图景：她大部分时间在坐卡片（日志实测 19~36s 一坐），
       而原有 5 个 sit 手势全是转头/叉腰这类小幅度，坐着看过去就是没动。
       这几个剪影大、一眼可读，专门给坐姿补多样性。 */
    // 看手机：双手抬到胸前捧机、低头盯着看，中途有轻微刷新动作
    phoneCheck: {
      dur: [5200, 8200], weight: 4, sit: true,
      fn (q) {
        // 平台包络：起手快（12%）、保持到 80%、收手快——sin(πq) 会让手在中间塌回去
        const s = Math.min(1, q * 8, (1 - q) * 5)
        const scroll = Math.sin(Math.PI * 3 * q) * 0.05 * s
        return {
          // 注意：手势是「增量」，坐姿基线已有 upperArm -0.35 / lowerArm -0.95，
          // 所以这里只能补差值（第一版叠 -1.72 直接弯到脸侧，像手贴脸颊）
          leftUpperArm: [-0.15 * s, 0, -0.10 * s],
          rightUpperArm: [-0.15 * s, 0, 0.10 * s],
          leftLowerArm: [-0.52 * s, 0, -0.98 * s - scroll],
          rightLowerArm: [-0.52 * s, 0, 0.98 * s + scroll],
          head: [0.34 * s, 0, 0],
          neck: [0.14 * s, 0, 0],
          chest: [0.05 * s, 0, 0]
        }
      }
    },
    // 抖腿：一条腿在小幅上下颠（坐着放松/急不可耐），躯干几乎不动
    legBounce: {
      dur: [2600, 4400], weight: 3, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        const b = Math.sin(Math.PI * 9 * q) * s
        return {
          rightLowerLeg: [0.11 * b, 0, 0],
          rightFoot: [-0.06 * b, 0, 0],
          leftLowerLeg: [-0.02 * b, 0, 0],
          head: [0.02 * Math.abs(b), 0, 0]
        }
      }
    },
    // 大范围张望：头带脖子带胸口一起转过去停一下再回（比 lookAside 幅度大得多）
    lookAroundBig: {
      dur: [3200, 5200], weight: 3, sit: true,
      fn (q, g) {
        const s = Math.sin(Math.PI * q)
        const d = (g && g.dir) || 1
        // 两段式：先转到一边停一下，回程更慢——像在找东西，不像匀速摆头
        const turn = Math.sin(Math.PI * Math.min(1, q * 1.35)) * s
        return {
          head: [0.02 * s, 0.62 * turn * d, 0.05 * s],
          neck: [0, 0.22 * turn * d, 0],
          chest: [0, 0.12 * turn * d, 0],
          spine: [0, 0.06 * turn * d, 0]
        }
      }
    },
    // 轻轻一顿（像不耐烦 / 抖一下）
    bounce: {
      dur: [900, 1500], weight: 2, sit: false,
      fn (q) {
        const s = Math.sin(Math.PI * q) * Math.abs(Math.sin(Math.PI * 2 * q))
        return {
          leftUpperLeg: [-0.09 * s, 0, 0],
          rightUpperLeg: [-0.09 * s, 0, 0],
          leftLowerLeg: [0.16 * s, 0, 0],
          rightLowerLeg: [0.16 * s, 0, 0],
          spine: [0.04 * s, 0, 0]
        }
      }
    },
    /* ---------- 以下由聊天动作词 / playGesture 触发（weight 0 不进随机池） ---------- */
    // 摇头：三次左右摆头
    shake: {
      dur: [1300, 1800], weight: 0, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * 3 * q) * Math.sin(Math.PI * q)
        return { head: [0, 0.30 * s, 0.04 * s], neck: [0, 0.12 * s, 0] }
      }
    },
    // 拍手：双手抬到胸前，拍三下
    clap: {
      dur: [1400, 2000], weight: 0, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        const c = Math.abs(Math.sin(Math.PI * 3 * q)) * s
        return {
          leftUpperArm: [-0.60 * s, 0, -0.05 * s],
          rightUpperArm: [-0.60 * s, 0, 0.05 * s],
          leftLowerArm: [-1.95 * s, 0, -(0.28 + 0.40 * c) * s],
          rightLowerArm: [-1.95 * s, 0, (0.28 + 0.40 * c) * s],
          chest: [0.03 * s, 0, 0]
        }
      }
    },
    // 思考：手托下巴 + 歪头（也进随机池，像在想事情）
    think: {
      dur: [2600, 4000], weight: 1, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        return {
          rightUpperArm: [-0.35 * s, 0, 0.25 * s],
          rightLowerArm: [-2.65 * s, 0, 0.40 * s],
          head: [0.10 * s, -0.12 * s, 0.12 * s]
        }
      }
    },
    // 害羞捂脸：双手盖脸 + 低头
    coverFace: {
      dur: [1800, 2600], weight: 0, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        return {
          leftUpperArm: [-0.25 * s, 0, -0.05 * s],
          rightUpperArm: [-0.25 * s, 0, 0.05 * s],
          leftLowerArm: [-2.65 * s, 0, -0.50 * s],
          rightLowerArm: [-2.65 * s, 0, 0.50 * s],
          head: [0.18 * s, 0, 0]
        }
      }
    },
    // 招手「过来」：举手后前臂朝自己勾三下
    beckon: {
      dur: [2000, 2600], weight: 0, sit: true,
      fn (q) {
        const up = Math.min(1, q * 4, (1 - q) * 4)
        const sw = Math.sin(Math.PI * 5 * q) * up
        return {
          rightUpperArm: [-0.55 * up, 0, -0.95 * up],
          rightLowerArm: [-1.45 * up, 0, -0.45 * sw],
          head: [0.05 * up, 0, 0.06 * up]
        }
      }
    },
    // 抱臂：双臂交叠胸前（生气 / 不服气 / 冷）
    armsCross: {
      dur: [2800, 4200], weight: 0, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        return {
          leftUpperArm: [-0.40 * s, 0, -0.05 * s],
          rightUpperArm: [-0.40 * s, 0, 0.05 * s],
          leftLowerArm: [-1.50 * s, 0, -0.90 * s],
          rightLowerArm: [-1.50 * s, 0, 0.90 * s],
          head: [0, 0.05 * s, -0.06 * s]
        }
      }
    },
    // 欢呼：双拳举高小挥（加油 / 太好了）
    cheer: {
      dur: [1600, 2400], weight: 0, sit: false,
      fn (q) {
        const up = Math.min(1, q * 3, (1 - q) * 3)
        const sw = Math.sin(Math.PI * 4 * q) * up
        return {
          leftUpperArm: [-0.10 * up, 0, 1.90 * up],
          rightUpperArm: [-0.10 * up, 0, -1.90 * up],
          leftLowerArm: [-0.55 * up, 0, -0.25 * sw],
          rightLowerArm: [-0.55 * up, 0, 0.25 * sw],
          head: [-0.10 * up, 0, 0]
        }
      }
    },
    // 鞠躬：上身前倾 + 低头（谢谢 / 打招呼行礼）
    bow: {
      dur: [1500, 2100], weight: 0, sit: true,
      fn (q) {
        const s = Math.sin(Math.PI * q)
        return {
          spine: [0.35 * s, 0, 0],
          chest: [0.18 * s, 0, 0],
          head: [0.22 * s, 0, 0]
        }
      }
    }
  }
  /* 归一化骨骼里 X 轴正方向 = 脚往身后摆，即屈膝方向。
   * 万一真机上膝盖朝前折（反关节），把 KNEE_DIR 改成 -1 即可，只此一处。 */
  const KNEE_DIR = 1
  const LEAN_DIR = 1
  // 参与程序化姿态的骨骼（缺失的自动跳过，只有上半身也能跑）
  const BONES = [
    'hips', 'spine', 'chest', 'neck', 'head',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
    'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightUpperArm', 'rightLowerArm', 'rightHand'
  ]

  function rand (a, b) { return a + Math.random() * (b - a) }

  function create (opts) {
    const o = opts || {}
    const libs = o.libs || (global && global.AuraLibs)
    if (!libs || !libs.THREE) throw new Error('AuraLibs(three) 未加载')
    const THREE = libs.THREE
    const canvas = o.canvas
    if (!canvas) throw new Error('缺少 canvas')

    // 注意用 num 而不是 `||`：眨眼间隔传 0 是「立刻眨」，用 || 会被默认值吃掉
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d)
    const fps = Math.max(8, Math.min(60, num(o.fps, 30)))
    // 闲时帧率（Coopanion RESTING_FPS 模式）：没走/没拖/没说话时降到这里，GPU 省一半以上
    const restFps = Math.max(4, num(o.restFps, 15))
    // 忙闲判定由宿主注入（拖拽/走路/气泡可见……），不传则恒当忙
    const isBusy = typeof o.isBusy === 'function' ? o.isBusy : null
    const blinkMin = num(o.blinkMin, 2600)
    const blinkMax = num(o.blinkMax, 6200)
    const blinkClose = num(o.blinkClose, 110)
    const blinkHold = num(o.blinkHold, 60)
    // 时间与定时器可注入：渲染层跑真实实现，单测里手动推进以便断言眨眼/口型
    const now = o.now || (() => (global.performance && global.performance.now ? global.performance.now() : Date.now()))
    const setTimer = o.setTimer || ((fn, ms) => setInterval(fn, ms))
    const clearTimer = o.clearTimer || ((t) => clearInterval(t))

    const st = {
      pose: 'stand', // stand | sit（0.29.0：坐到卡片上）
      poseStyle: 'stool', // 0.45.47 stool=高凳式（坐卡片）| ground=席地而坐（原地坐）
      sitAmt: 0,
      sitSettleAt: 0, // 0.45.45 坐到位的时戳（落定回弹用，起身清零）
      alive: true,
      sig: o.sig == null ? (o.url || '') : o.sig,
      url: o.url || '',
      vrm: null,          // VRM 实例（普通 GLB 为 null）
      clip: null,         // 正在播的待机动画
      walkClip: null,     // 模型自带的走路片段（有就优先用片段，没有才程序化摆腿）
      vrmaWalk: null,     // 0.45.44 motions/walk.vrma 预载的走路动作（优先级最高）
      mixer: null,
      talk: false,
      ready: false,
      error: null,
      // 走动状态：on/dir/speed 由宿主广播，amt 是 0→1 的淡入淡出（避免起步硬切）
      walk: { on: false, dir: 1, speed: 0, amt: 0 },
      rig: null,          // 归一化骨骼表，null = 没有 humanoid（普通 GLB）
      rest: null,         // 骨骼静止姿态（叠加姿态前先减掉它）
      gesture: null,      // 正在播的待机手势 id（0.30.0）
      rootBaseY: 0,
      clipWalkAction: null,
      clipIdleAction: null,
      clips: null,        // 全部动画片段（0.32.0 官方全量烘入后按名字点播）
      clipHold: null,     // { until } 官方片段一次性播放中（区别于 animHold 的程序化接管）
      fidgetNext: 0,      // 下一次播 idle_fidget（长待机小彩蛋）的时刻（0.32.1）
      rawBlend: null      // 0.45.73 硬切补间：{ t0, dur, snap:Map<bone,Quaternion> }
    }

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      // 伙伴热区靠 alpha 掩码采样，没有它下一帧读到的 WebGL canvas 是空的
      preserveDrawingBuffer: !!o.preserveDrawingBuffer
    })
    const w0 = canvas.clientWidth || 300
    const h0 = canvas.clientHeight || 520
    renderer.setSize(w0, h0, false)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, w0 / h0, 0.1, 50)
    scene.add(new THREE.DirectionalLight(0xffffff, Math.PI))
    if (o.grid) scene.add(new THREE.GridHelper(6, 12, 0x8f7bff, 0x333344))

    /* 0.45.67 接触阴影（脚底暗影）
       用户：「这个呼吸效果……比起呼吸更像是漂浮在空中，起码要有脚踏实地的感觉」。
       相机是平视的（fit 把 camera.y 放在包围盒中心），真正投在地面上的影子从侧面看
       只有一条线，等于没有——所以用一张面向相机的软椭圆贴在脚底，这是 2D/卡通渲染里
       标准的「接触阴影」画法：脚边有块暗色，人立刻就「站住了」。
       成本：一张 128×64 canvas + 一个 plane，不进 root（不跟着呼吸/走路上下抖）。 */
    let groundShadow = null
    try {
      const sc = document.createElement('canvas')
      sc.width = 128
      sc.height = 64
      const g2 = sc.getContext('2d')
      const grad = g2.createRadialGradient(64, 32, 1, 64, 32, 60)
      grad.addColorStop(0, 'rgba(10,12,20,0.88)')
      grad.addColorStop(0.42, 'rgba(10,12,20,0.40)')
      grad.addColorStop(1, 'rgba(10,12,20,0)')
      g2.fillStyle = grad
      g2.beginPath()
      g2.ellipse(64, 32, 62, 29, 0, 0, Math.PI * 2)
      g2.fill()
      const tex = new THREE.CanvasTexture(sc)
      groundShadow = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.58
        })
      )
      groundShadow.renderOrder = 1
      scene.add(groundShadow)
    } catch { groundShadow = null }

    /* 每帧贴到脚底：跟 x/z 走，但**不跟 root 的 y 上下**（阴影代表地面，地面不会呼吸） */
    function updateGroundShadow () {
      if (!groundShadow) return
      const h = st.height || 1.5
      const r = st.root
      const sit = Math.min(1, st.sitAmt || 0)
      groundShadow.position.set(
        r ? r.position.x : 0,
        /* 放在脚底平面（root 原点＝脚底）：抬高会被鞋子/腿挡住，只露出零星像素。
           一半在脚底以下正是「接触阴影」该在的位置，也是唯一看得见的那一半。 */
        st.rootBaseY - 0.004 * h,
        // z 往身体后方放一点：阴影在脚后面才像投影，放前面会盖住鞋面
        (r ? r.position.z : 0) + 0.02
      )
      groundShadow.scale.set(h * (0.34 + 0.08 * sit), h * (0.060 - 0.010 * sit), 1)
      groundShadow.material.opacity = 0.75 - 0.15 * sit
    }

    let lastW = w0
    let lastH = h0
    let timer = null
    let curGap = Math.round(1000 / fps)
    let last = 0
    let blinkStart = -1
    let blinkVal = 0
    let nextBlink = 0
    let talkPhase = 0
    let talkAmt = 0

    /* 取景：按包围盒把整个模型塞进画面。
       写死距离时标准身高（1.4~1.7m）只露上半身，是「模型显示不全」的经典原因。
       性能铁律：Box3.setFromObject 要遍历整个模型层级（几百个节点），
       是渲染循环里最贵的一步——不能每帧跑。画布尺寸变化时立即重算，
       其余每 400ms 刷一次（走路起伏对取景的影响肉眼不可见）。 */
    const FIT_EVERY = 400
    let lastFitAt = -Infinity
    function fit () {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (!w || !h) return
      const sizeChanged = w !== lastW || h !== lastH
      if (sizeChanged) {
        lastW = w
        lastH = h
        renderer.setSize(w, h, false)
        camera.aspect = w / h
      }
      const root = st.root
      if (!root) { camera.updateProjectionMatrix(); return }
      const t = now()
      if (!sizeChanged && t - lastFitAt < FIT_EVERY) return
      lastFitAt = t
      // 走路上下起伏会改 root.position.y；取景必须按静止位置算，
      // 否则每 400ms 重算一次包围盒，相机跟着抖一下（0.27.0 的 bob 引入的坑）
      const bobY = root.position
      const baseY = bobY ? bobY.y : 0
      if (bobY) bobY.y = st.rootBaseY
      root.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(root)
      if (bobY) bobY.y = baseY
      if (!isFinite(box.min.x) || !isFinite(box.max.y) || !isFinite(box.max.z)) {
        camera.updateProjectionMatrix()
        return
      }
      const size = new THREE.Vector3()
      const center = new THREE.Vector3()
      box.getSize(size)
      box.getCenter(center)
      /* 0.29.0：取景按「站立时的包围盒」缓存。
         坐着 / 侧身走都会改变包围盒，每次重算会让镜头忽远忽近（坐下时整个人变大）。 */
      if (!st.fitSize) st.fitSize = { x: size.x, y: size.y, z: size.z, cx: center.x, cy: center.y, cz: center.z }
      if (st.fitSize) { size.set(st.fitSize.x, st.fitSize.y, st.fitSize.z); center.set(st.fitSize.cx, st.fitSize.cy, st.fitSize.cz) }
      if (!size.x && !size.y && !size.z) { camera.updateProjectionMatrix(); return }
      // 身材高度用来算走路起伏幅度（0.27.0），不同身高的模型起伏绝对值要跟着变
      if (size.y > 0.1) st.height = size.y
      const vFov = (camera.fov * Math.PI) / 180
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
      // 竖向留 3% 余量；横向多留一点，避免手臂/头发贴边
      const distV = ((size.y || 1.5) * 1.06 / 2) / Math.tan(vFov / 2)
      const distH = ((size.x || 0.5) * 1.2 / 2) / Math.tan(hFov / 2)
      // 再补半个厚度：相机在模型外侧，否则算的是「到中轴」而不是「到前表面」
      const dist = Math.max(distV, distH, 0.5) + (size.z || 0) / 2
      camera.position.set(center.x, center.y, center.z - dist)
      camera.lookAt(center.x, center.y, center.z)
      camera.updateProjectionMatrix()
    }

    function setExpr (name, v) {
      const em = st.emo
      if (!em) return
      try { em.setValue(name, v) } catch { /* 模型没这个表情就跳过 */ }
    }

    /* 眨眼 + 口型。两者都写 expressionManager，vrm.update() 之前设好即可 */
    function expressions (now, dt) {
      if (!st.emo) return
      if (blinkStart < 0 && now >= nextBlink) blinkStart = now
      if (blinkStart >= 0) {
        const t = now - blinkStart
        if (t < blinkClose) blinkVal = t / blinkClose
        else if (t < blinkClose + blinkHold) blinkVal = 1
        else if (t < blinkClose * 2 + blinkHold) blinkVal = 1 - (t - blinkClose - blinkHold) / blinkClose
        else {
          blinkVal = 0
          blinkStart = -1
          nextBlink = now + rand(blinkMin, blinkMax)
        }
        setExpr('blink', blinkVal)
      }
      if (st.talk) {
        talkPhase += dt * 9
        talkAmt = 0.26 + 0.42 * Math.abs(Math.sin(talkPhase))
      } else if (talkAmt !== 0) {
        talkAmt = 0
      }
      // 口型随时写：从开到合要真的回到 0，否则说完话嘴巴一直张着
      setExpr('aa', talkAmt)
    }

    const hidden = () => {
      /* 0.45.62 重大修正：0.45.45 起用 document.hidden 判断「这块屏的 overlay 看不见，
         别烧 GPU」——但 Chromium 对「透明 + 点击穿透 + 置顶」的 overlay 会误判为
         occluded，visible 状态可能是 hidden。被判 hidden 的实例 step() 整帧跳过，
         画布永远停在最后一帧：窗口还在被主进程平移（所以看着像在走路），
         但姿势一动不动——用户「动作还是一样」的真凶，之前所有「播放成功」的日志
         都发生在另一块屏的实例上（那边在动，用户看的这块冻着）。
         这里改成只信主进程下发的显隐（o.hiddenFn），默认一律照常渲染。 */
      try {
        if (typeof o.hiddenFn === 'function') return !!o.hiddenFn()
        return false
      } catch { return false }
    }

    /* ---------------- 程序化姿态（0.27.0） ----------------
     * 只对「没有动画片段」的模型生效。mixer 每帧都会写骨骼，我们再去写就是互相打架
     * （表现成抽搐），所以：有走路片段 → 片段交叉淡入；有片段没走路 → 不碰骨骼；
     * 完全没片段（VRoid / Booth 导出的 VRM 基本都是这种）→ 程序化待机 + 走路。 */
    function buildRig () {
      const h = st.vrm && st.vrm.humanoid
      if (!h || typeof h.getNormalizedBoneNode !== 'function') return null
      const rig = {}
      for (let i = 0; i < BONES.length; i++) {
        const n = BONES[i]
        let b = null
        try { b = h.getNormalizedBoneNode(n) } catch { b = null }
        if (b && b.rotation) rig[n] = b
      }
      // 一条大腿都没有就没有「迈步」可言，硬摆只会把整个人歪过去
      if (!rig.leftUpperLeg && !rig.rightUpperLeg) return null
      /* 0.45.73 定基准：rest 必须取**绑定姿势**（加载时抓的快照），不能取「此刻」。
         0.45.44 起走路走 VRMA（写的就是 normalized 骨骼），坐下那一刻 normalized
         停在一个半迈步的姿势上 → 坐姿变成「在迈步姿势上再加偏移」，实测大腿世界
         方向 (0.04,-0.12) 几乎垂直、脚离地 9cm，看着像「站着往下蹲」而不是坐下。
         加载时抓的 restBind 是干净的 A/T 姿势，用它才能每次都坐出同一套坐姿。 */
      if (st.restBind && st.restBind.size) {
        const rest = new Map()
        for (const key in rig) {
          const b = st.restBind.get(key)
          const r = rig[key].rotation
          const v = b || { x: r.x, y: r.y, z: r.z }
          rest.set(key, { x: v.x, y: v.y, z: v.z })
          // 立刻把骨骼摆回绑定姿势：否则接管第一帧还是刚才那段动画的姿势
          rig[key].rotation.set(v.x, v.y, v.z)
        }
        st.rest = rest
        st.droop = st.droopBind != null ? st.droopBind : restDroop(rig)
        return rig
      }
      // A-pose 适配（0.27.1）：很多模型（Booth / VRoid / 游戏提取）静止时手臂本来就垂着，
      // 再套 T-pose 的 armDown 就会把手压进身体里。量一下肩→手的实际下垂角，只补差值。
      st.droop = restDroop(rig)
      const rest = new Map()
      const keys = Object.keys(rig)
      for (let i = 0; i < keys.length; i++) {
        const r = rig[keys[i]].rotation
        rest.set(keys[i], { x: r.x, y: r.y, z: r.z })
      }
      st.rest = rest
      return rig
    }

    /* 静止姿态的手臂下垂角（弧度，向下为正）。T-pose≈0，A-pose≈0.6~0.95 */
    function restDroop (rig) {
      const up = rig.leftUpperArm || rig.rightUpperArm
      const hand = rig.leftHand || rig.leftLowerArm || rig.rightHand || rig.rightLowerArm
      if (!up || !hand) return 0
      try {
        up.updateWorldMatrix(true, false)
        hand.updateWorldMatrix(true, false)
        const a = new THREE.Vector3()
        const b = new THREE.Vector3()
        up.getWorldPosition(a)
        hand.getWorldPosition(b)
        const v = b.sub(a)
        const horiz = Math.hypot(v.x, v.z)
        if (horiz < 1e-6) return 0
        const ang = Math.atan2(-v.y, horiz)
        // 只可能是「已经垂着」才有意义；抬起来的模型（负数）按 0 处理
        return Math.max(0, Math.min(1.5, ang))
      } catch { return 0 }
    }

    /* ---------------- 待机手势调度（0.30.0） ----------------
     * 状态机很小：有正在播的 → 推进进度；播完 → 等 2.2~7s 再挑下一个。
     * 走路（idle 掉到 0.35 以下）立刻收掉，走回来重新等。
     * 权重随机、且不连着播同一个（连着两次伸懒腰特别假）。 */
    let gest = null
    let gestNext = 0
    let gestLast = ''

    /* ---- 0.31.0 mixer <-> 程序化切换 ----
       官方动画（mixer）与程序化姿态（rig）不能同时写骨骼。需要程序化（坐下/手势）
       时暂停 mixer、临时 build rig；条件解除后由 step() 释放，官方动画接着播。
       w.amt 在 mixer 模式下被 setWalk 置 on/off，这里进 hold 前,先把它归 0，
       否则 poseIt 会以为还在走路，坐姿永远混不上来。 */
    /* ---------------- 0.45.73 切换补间（治「坐下之前那一下」） ----------------
     * mixer（官方/VRMA 都在写 raw 骨骼）与程序化姿态（写 normalized，再由 humanoid
     * 拷回 raw）之间切换时，raw 是被**整体覆盖**的：
     *   · 官方 idle 绑 raw —— 它摆过的手在 normalized 上还是绑定姿势；
     *   · 一切到程序化，raw 立刻变成「normalized=绑定姿势」→ 手瞬间翻过去。
     * 真机实测量到 leftHand 单帧 177.8°（tools/sit-snap.js，静置基线每帧 0.08°），
     * 用户看到的就是「坐下之前有一段很短、看不懂的怪动作」。
     * 补间做法：切换那一帧抓一份 raw 快照，之后 ~0.3s 把 raw 从快照 slerp 到新姿态，
     * 视觉上就是普通的过渡，没有任何硬跳。 */
    function snapshotRaw () {
      const h = st.vrm && st.vrm.humanoid
      if (!h || typeof h.getRawBoneNode !== 'function') return null
      const snap = new Map()
      for (let i = 0; i < BONES.length; i++) {
        let b = null
        try { b = h.getRawBoneNode(BONES[i]) } catch { b = null }
        if (b && b.quaternion) snap.set(BONES[i], b.quaternion.clone())
      }
      return snap.size ? snap : null
    }
    /** 在「即将硬切」之前调用：记下此刻可见姿态，开始 0.3s 补间 */
    function beginRawBlend (dur) {
      try {
        const snap = snapshotRaw()
        if (!snap) return
        st.rawBlend = { t0: now(), dur: dur > 0 ? dur : 0.3, snap }
      } catch { }
    }

    /** 0.45.80 手臂自然化：不做离线校准（VRM 祖先节点带 matrix，离线换算的轴
     *  在渲染器里方向反了，实测把 60° 推成了水平）。改为运行时自校正：每帧
     *  量上臂→下臂的世界方向，setFromUnitVectors 转向目标方向——方向永远正确，
     *  左右/朝向自适应。目标 = 离垂直下垂 12°（0°=笔直下垂，与 droop 同一口径；
     *  0.45.81 曾把目标写成「离水平 12°」= 离垂线 78°，把手臂推成了 T-pose）。 */
    const ARM_NAT_DROOP = 12 * Math.PI / 180

    function holdAnim () {
      /* 0.45.77 探针：holdAnim 是唯一「静默清掉 poolPlaying」的路径（会 stopAllAction
         杀掉池内动作）。真机实锤「池内动作播了 1 秒就死、日志里却没有任何 releaseAnim
         成功记录」——如果真凶在这里，这条日志直接钉死调用方。 */
      if (st.poolPlaying && (!st.lastHaLog || Date.now() - st.lastHaLog > 5000)) {
        st.lastHaLog = Date.now()
        let where = ''
        try { where = String(new Error().stack || '').split('\n').slice(2, 4).join(' | ').trim().slice(0, 250) } catch { }
        diag('holdAnim 打断池内动作（probe）: ' + where)
      }
      if (!st.mixer || st.rig) return !!st.rig
      // 0.45.44：VRMA 走路进行中不许程序化接管（stopAllAction 会把走路砍没，
      // 之后 setWalk 又不会重发——表现为走着走着突然变回机器腿）
      if (st.walk.on && st.vrmaWalk && st.vrmaWalk.act) return false
      beginRawBlend(0.3) // 必须在 stopAllAction / buildRig 之前抓快照
      try { st.mixer.stopAllAction() } catch {}
      st.animHold = true
      st.clipHold = null
      /* 0.45.67：接管（坐下/播手势）会把池内待机动作停掉，但标志位以前不清——
         之后 st.poolPlaying 还是 true，releaseAnim 被它挡住（日志里那句「池内动作
         挡住 releaseAnim」），起身要等 20s 的 poolUntil 到期才恢复正常。
         停在动作中间正是「坐下前那个怪动作」的另一半，这里一起清干净。 */
      st.poolPlaying = false
      st.poolAct = null
      st.poolUntil = 0
      st.walk.amt = 0
      st.rig = buildRig()
      // rig 写的是 normalized 骨骼：autoUpdateHumanBones=false 时 normalized 拷不到
      // raw，程序化姿态全隐形。接管期间临时打开（mixer 已停，不会打架），释放再关。
      // 0.45.48 起真正的权威值由 step() 渲染循环每帧声明式收敛（0.45.44~47 走路
      // 隐形的真凶：0.31.0 把它一刀切关死后 VRMA 的 Normalized_* 轨道永远拷不到 raw）。
      try { if (st.vrm && st.vrm.humanoid) st.vrm.humanoid.autoUpdateHumanBones = true } catch {}
      return true
    }
    function releaseAnim () {
      // 0.45.59：池内待机动作在播期间，除了「开始走路」谁也不许把它收掉。
      // 真机实锤：播 20s 的看手机，1 秒后就被某个 releaseAnim 打断 → 屏幕上一动不动
      // （用户「播了跟没播一样」）。trace 记下打断来源，后续再排查有据可查。
      if (st.poolPlaying && !st.walk.on) {
        if (!st.lastRlLog || Date.now() - st.lastRlLog > 5000) {
          st.lastRlLog = Date.now()
          /* 0.45.77 栈截到 250 字符：之前 90 字符只够打出 URL，行号永远被截掉，
             「at step」到底是 1229/1231/1335 哪一处无从判断——这次必须拿到行号 */
          let where = ''
          try { where = String(new Error().stack || '').split('\n').slice(2, 4).join(' | ').trim().slice(0, 250) } catch { }
          diag('池内动作挡住 releaseAnim（animHold=' + st.animHold + ' clipHold=' +
            (st.clipHold ? '1' : '0') + ' rig=' + !!st.rig + ' walkOn=' + !!st.walk.on + '）: ' + where)
        }
        // 0.45.61 关键：animHold 残留会让 step() 跳过 mixer.update(dt)——动作永远停在
        // 第 0 帧，屏幕上「播了跟没播一样」。池内动作期间强制清掉它，让 mixer 继续走。
        if (st.animHold) {
          st.animHold = false
          try { if (st.vrm && st.vrm.humanoid) st.vrm.humanoid.autoUpdateHumanBones = true } catch { }
        }
        st.clipHold = null
        return
      }
      st.animHold = false
      st.poolPlaying = false
      st.clipHold = null
      // 0.45.73 起身/交还 mixer 同样是硬切（坐姿 → 官方 idle），一并补间
      beginRawBlend(0.32)
      // 交还 mixer 前先关掉拷贝：否则 stale 的 normalized 姿态会把 mixer 的 raw 写入盖掉
      try { if (st.vrm && st.vrm.humanoid) st.vrm.humanoid.autoUpdateHumanBones = false } catch {}
      if (st.rig) {
        // 还原程序化写过的骨骼到 rest，交给 mixer 接管
        const rest = st.rest || new Map()
        for (const n in st.rig) {
          const r = rest.get(n)
          if (r) st.rig[n].rotation.set(r.x, r.y, r.z)
        }
        st.rig = null
      }
      // root 高度一并交还：poseIt 最后一次可能停在坐姿下沉/走路起伏的非零偏移上，
      // mixer 模式没人再写 root.position.y，残留会让角色一直悬空或下沉
      try { if (st.root && st.root.position) st.root.position.y = st.rootBaseY } catch {}
      // 0.45.56 关键修复：交还时必须把还在跑的池内/点播动作停掉。以前只重启 idle，
      // 池内 VRMA 会以「幽灵动作」继续以权重 1 跑，和 idle 各占 50% 抢同一批骨骼
      // （实测 wNorm=1.00 wRaw=1.00、转角只到应有的三分之一——用户看到的「动了跟没动一样」）
      try { if (st.mixer) st.mixer.stopAllAction() } catch {}
      st.poolAct = null
      try { st.clipIdleAction.reset(); st.clipIdleAction.fadeIn(0.25); st.clipIdleAction.play() } catch {}
    }

    function gesturePick () {
      // 0.45.67：坐姿手势必须「坐稳了」才允许。以前用 >0.5，那 0.9s 过渡的前半段
      // 仍算站立 → 会出现「坐下那一秒还在播站立手势」的错位。
      const sitting = st.sitAmt > 0.99
      const keys = Object.keys(GESTURES).filter((k) =>
        GESTURES[k].weight > 0 && k !== gestLast && (!sitting || GESTURES[k].sit))
      if (!keys.length) return null
      let total = 0
      for (let i = 0; i < keys.length; i++) total += GESTURES[keys[i]].weight
      let r = Math.random() * total
      for (let i = 0; i < keys.length; i++) {
        r -= GESTURES[keys[i]].weight
        if (r <= 0) return keys[i]
      }
      return keys[0]
    }

    function gestureStart (id, t, dur) {
      const g = GESTURES[id]
      if (!g) return false
      // dur 可显式指定（对照页截图/测试要固定时长，才能落在动作峰值上）
      gest = { id, t0: t, dur: dur > 200 ? dur : rand(g.dur[0], g.dur[1]), dir: Math.random() < 0.5 ? -1 : 1 }
      gestLast = id
      st.gesture = id
      // 0.45.54：新加的坐姿大动作记一条日志（转头类太频繁不记），事后能核对
      if (id === 'phoneCheck' || id === 'legBounce' || id === 'lookAroundBig') {
        diag('坐姿手势: ' + id + ' · ' + (st.sitAmt > 0.5 ? '坐着' : '站着'))
      }
      return true
    }

    /** 每帧推进手势，返回本帧的骨骼增量（没有在播就是 null） */
    function gestureStep (t, idle) {
      /* 0.45.67「坐下前有个很奇怪的短动作」真凶（日志实锤）：
         [23:05:38] [pet] 原地坐下休息 21s
         [23:05:38] [renderer] 坐姿手势: phoneCheck · 站着
         —— 坐下的同一秒，手势调度器还按「站着」挑了一个手势，刚起手 0.9s 就被
         坐姿淹没，用户看到的就是「很短、看不懂是什么」的一下抽搐。
         坐/起的过渡期一律不起新手势，正在播的也利落收掉。 */
      const sitMoving = st.sitAmt > 0.005 && st.sitAmt < 0.995
      if (sitMoving) {
        if (gest) {
          gest = null
          st.gesture = null
          gestNext = t + rand(1200, 2600)
        }
        return null
      }
      if (gest) {
        const g = GESTURES[gest.id]
        const q = (t - gest.t0) / gest.dur
        if (q >= 1 || idle < 0.35 || !g) {
          gest = null
          st.gesture = null
          gestNext = t + rand(2200, 7000)
          return null
        }
        return g.fn(Math.max(0, q), gest)
      }
      if (idle > 0.85 && t >= gestNext) {
        const id = gesturePick()
        if (id) gestureStart(id, t)
        else gestNext = t + 3000
      }
      return null
    }

    /* 每帧姿态：待机 = 站姿 + 呼吸 + 待机手势；走路 = 再叠摆腿/摆臂/前倾；坐下 = 混到坐姿。
       所有角度都写成「静止姿态 + 偏移」，走路量 amt 淡出到 0 就自然回到待机，
       不需要额外还原——待机姿态本身就是我们要的常态（否则 VRM 会一直 T 字站着）。
       0.30.0 改成「先累加增量、最后一次性写骨骼」：手势和坐姿才能干净地叠在基础姿态上，
       而不用到处 set 互相覆盖。 */
    function poseIt (t, dt) {
      const rig = st.rig
      if (!rig) return
      const w = st.walk
      const want = w.on ? 1 : 0
      // 120ms 淡入淡出：起步/收步不会硬切（dt 在 step() 里已钳到 0.1s 上限）
      const step = dt / 0.12
      if (w.amt < want) w.amt = Math.min(want, w.amt + step)
      else if (w.amt > want) w.amt = Math.max(want, w.amt - step)
      const amt = w.amt
      const idle = 1 - amt

      const rest = st.rest || new Map()
      const ZERO = { x: 0, y: 0, z: 0 }
      /* 增量表：所有分量先累加，最后统一写回 rest + delta */
      const D = new Map()
      const add = (n, x, y, z) => {
        if (!rig[n]) return
        let a = D.get(n)
        if (!a) { a = [0, 0, 0]; D.set(n, a) }
        a[0] += x || 0
        a[1] += y || 0
        a[2] += z || 0
      }
      /* 把该骨骼已有的增量朝目标「混合」过去（坐姿用：越坐越像坐着，不是硬切） */
      const mixTo = (n, x, y, z, k) => {
        if (!rig[n] || k <= 0) return
        let a = D.get(n)
        if (!a) { a = [0, 0, 0]; D.set(n, a) }
        a[0] = a[0] * (1 - k) + x * k
        a[1] = a[1] * (1 - k) + y * k
        a[2] = a[2] * (1 - k) + z * k
      }

      /* ---- 步频与摆幅：都跟窗口真实速度绑定 ----
         步频：慢走 1.16 步/秒、活跃 1.55、跑 2.0（0.29.0 是 3 步/秒，像小跑 → 用户说太快）。
         摆幅：脚接地时脚速要等于地面速度，否则「腿大幅甩、人慢慢滑」。 */
      const speed = w.speed > 1 ? w.speed : 46
      const cadence = Math.max(0.9, Math.min(2.0, 0.85 + speed / 150))
      const stepMs = 2000 / cadence // 一个完整周期（左右各一步）
      /* 相位累积而非 (t/stepMs)*2π：绝对时间乘步频在变速瞬间会跳相位
         （用户看到的「两腿并拢时走路动画突然重置」）。累积相位对变速/重播都连续。 */
      if (!Number.isFinite(w.ph)) w.ph = 0
      w.ph += ((dt * 1000) / stepMs) * Math.PI * 2
      const ph = w.ph
      const s = Math.sin(ph)
      const hpx = canvas.clientHeight || 520 // fit 之后模型大致占满画面高度
      const legLen = hpx * 0.45 // 髋到脚踝 ≈ 0.45 身高
      const halfStride = (speed / cadence) / 2
      const rawSwing = Math.asin(Math.max(0.02, Math.min(0.6, halfStride / legLen)))
      const legSwing = Math.max(POSE.legSwingMin, Math.min(POSE.legSwingMax, rawSwing * POSE.legSwingGain))

      /* ---- 待机基础层：呼吸 / 重心 / 头 / 手臂 ----
         周期 2.6s / 5.2s / 7.3s / 9.1s 互质，叠起来不会看出在循环。 */
      const ws = Math.sin((t / 9100) * Math.PI * 2) // 站姿换重心（慢周期，±1）
      const breath = Math.sin((t / 2600) * Math.PI * 2) * POSE.idleBreath * idle
      const sway = Math.sin((t / 5200) * Math.PI * 2) * POSE.idleSway * idle
      const headTurn = Math.sin((t / 7300) * Math.PI * 2 + 0.8) * POSE.idleHead * idle
      const armSway = Math.sin((t / 4200) * Math.PI * 2 + 1.6) * POSE.idleArm * idle

      // 手臂：待机把 T 字放下来；走路略抬并反相摆（与腿相反）
      // 已经垂着的手臂（A-pose）只补「离目标还差的那部分」，否则会压进身体
      const downBase = Math.max(0, POSE.armDown - (st.droop || 0))
      const down = downBase * (1 - amt * 0.22)
      // 站姿不对称：一侧手臂贴身更紧一点（完全对称的手臂一眼就是摆出来的）
      const asym = POSE.standArmAsym * idle
      add('leftUpperArm', -POSE.armSwing * amt * s, 0, -down - armSway - asym + POSE.armOut * idle)
      add('rightUpperArm', POSE.armSwing * amt * s, 0, down + armSway + asym * 0.35 - POSE.armOut * idle)
      // 肘微弯，前摆那只手多弯一点，看起来不像两根棍子
      add('leftLowerArm', -POSE.elbowBend - 0.10 * amt * Math.max(0, s), 0, 0)
      add('rightLowerArm', -POSE.elbowBend - 0.10 * amt * Math.max(0, -s), 0, 0)

      /* 腿：大腿前后交替（严格反相）；膝盖只朝屈膝方向弯，抬腿相屈得多、支撑相微屈。
         脚踝抵消 (髋+膝) 的 60%：脚背不跟着小腿甩，落地像真的踩着地面。 */
      const A = legSwing * amt * s
      const liftL = Math.pow(Math.max(0, Math.sin(ph + 1.1)), 1.3) * amt
      const liftR = Math.pow(Math.max(0, Math.sin(ph + 1.1 + Math.PI)), 1.3) * amt
      // 承重腿更弯一点：重心在哪边哪边吃力（随 9.1s 慢周期换）
      const softL = POSE.standKneeSoft * (1 + 0.5 * Math.max(0, ws)) * idle
      const softR = POSE.standKneeSoft * (1 + 0.5 * Math.max(0, -ws)) * idle
      const hipL = -A
      const hipR = A
      const kneeL = KNEE_DIR * (softL + liftL * POSE.kneeLift + POSE.kneeSoft * amt)
      const kneeR = KNEE_DIR * (softR + liftR * POSE.kneeLift + POSE.kneeSoft * amt)
      // 两脚微微外展（站姿），走路时收回到 0
      const split = POSE.footSplit * idle
      add('leftUpperLeg', hipL, 0, split)
      add('rightUpperLeg', hipR, 0, -split)
      add('leftLowerLeg', kneeL, 0, 0)
      add('rightLowerLeg', kneeR, 0, 0)
      add('leftFoot', -(hipL + kneeL) * 0.6 + liftL * 0.22, 0, 0)
      add('rightFoot', -(hipR + kneeR) * 0.6 + liftR * 0.22, 0, 0)

      // 上身：前倾 + 朝行进方向偏一点（正面看才不会像在飘）；待机时叠呼吸与重心
      // 侧身走的时候身体已经转了 90°，再扭胯就会像在拧腰，所以按侧身量衰减
      const sideK = 1 - (st.side ? st.side.amt : 0)
      add('spine', LEAN_DIR * POSE.lean * amt + breath, 0, -POSE.standHipTilt * 0.6 * ws * idle)
      add('chest', LEAN_DIR * POSE.lean * 0.5 * amt + breath * 0.8, 0, -POSE.standHipTilt * 0.3 * ws * idle)
      add('hips', 0, POSE.yaw * amt * (w.dir < 0 ? -1 : 1) * sideK + sway, POSE.standHipTilt * ws * idle)
      // 走路时骨盆随支撑腿左右倾（重心交替），这是走路「有重量」的关键
      add('hips', 0, 0, POSE.hipTilt * amt * s)
      add('neck', -breath * 0.5, headTurn * 0.6, POSE.standHeadTilt * ws * idle * 0.5)
      add('head', 0, headTurn * 0.4, POSE.standHeadTilt * ws * idle)

      /* 侧身朝行进方向（0.28.0）：桌面是 2D 平面，正面朝前平移看起来像在「滑」，
         转 90° 让身体侧面朝屏幕，迈步/摆臂才是左右方向看得见的。 */
      const side = st.side
      if (side && st.root && st.root.rotation) {
        const wantSide = w.on ? 1 : 0
        const sstep = dt / 0.22
        if (side.amt < wantSide) side.amt = Math.min(wantSide, side.amt + sstep)
        else if (side.amt > wantSide) side.amt = Math.max(wantSide, side.amt - sstep)
        // 0.33.0 侧身方向（walk-probe 数值判定终版）：相机在 -Z 侧 → 屏幕右 = 世界 -X
        // （探针校准实测 worldPlusX=SCREEN-LEFT）。dir=1（往右）需 front=-X → Δ=+90°，
        // 即 sign=+1；dir=-1 反之。此前两轮被视觉模型看图误判带偏（VLM 分左右不可靠），
        // 已改为页面内投影数值判定，不再看图。
        const sign = w.dir < 0 ? -1 : 1
        st.root.rotation.y = side.base + side.amt * (Math.PI / 2) * sign
      }

      /* 坐下（0.29.0）：大腿抬平、膝盖垂下、身体下沉。
         只在完全不走路时生效。0.45.44 过渡 0.25→0.45s（坐下的从容感），
         且坐着不再是一尊雕像：呼吸照常、手随呼吸微浮、慢周期换重心。 */
      const wantSit = (st.pose === 'sit' && amt < 0.02) ? 1 : 0
      // 0.45.45 过渡 0.45→0.9s + smoothstep 缓动：慢起（屈膝预备）→ 加速下沉 →
      // 减速落座。线性过渡是「飘下去」，缓动才有「坐下去」的过程感
      const sitStep = dt / 0.9
      if (st.sitAmt < wantSit) st.sitAmt = Math.min(wantSit, st.sitAmt + sitStep)
      else if (st.sitAmt > wantSit) st.sitAmt = Math.max(wantSit, st.sitAmt - sitStep)
      // 落座到位的瞬间记一次时戳（起身清掉），给落定回弹用
      /* 0.45.67 抖动真凶：这里清零后，下一帧 `!st.sitSettleAt` 又成立 → 重新点燃，
         每帧都重开一次 1 秒的 2Hz 回弹振荡，永远停不下来。
         真机量出来落定后 root.y 一直在 17mm 范围内摆（sit-probe 探针实锤），
         用户看到的就是「坐下时模型一直抖」。加 sitSettled 一次性锁。 */
      if (wantSit && st.sitAmt >= 1 && !st.sitSettleAt && !st.sitSettled) st.sitSettleAt = t
      if (!wantSit) { st.sitSettleAt = 0; st.sitSettled = false }
      // smoothstep 缓动后的量（旋转权重、下沉深度都用它）
      const sitRaw = st.sitAmt
      const sit = sitRaw * sitRaw * (3 - 2 * sitRaw)
      if (sit > 0.0001) {
        // 0.45.47 双坐姿目标值：stool=高凳式（腿垂、胯在卡片顶边）；ground=席地而坐
        // （膝弯到胸前、脚踩地、身体微前倾撑膝——「坐在地上」的剪影一眼可读）
        const ground = st.poseStyle === 'ground'
        const thigh = ground ? -1.50 : -1.35
        const knee = KNEE_DIR * (ground ? 1.42 : 1.30)
        mixTo('leftUpperLeg', thigh, 0, ground ? 0.10 : 0, sit)
        mixTo('rightUpperLeg', thigh, 0, ground ? -0.10 : 0, sit)
        mixTo('leftLowerLeg', knee, 0, 0, sit)
        mixTo('rightLowerLeg', knee, 0, 0, sit)
        mixTo('leftFoot', ground ? -0.06 : -0.15, 0, 0, sit)
        mixTo('rightFoot', ground ? -0.06 : -0.15, 0, 0, sit)
        // 0.45.38 手自然放在大腿上：上臂略前抬（肘部移到身前）+ 前臂前搭落在腿上，
        // 不再是吊在身侧的「撑地」姿势（主人拍板：坐下双手不对劲，不是自然放置）
        // 0.45.44 目标值带微动作：呼吸起浮（2.6s）+ 慢晃（7.3s），手是活的
        const sitBreath = Math.sin((t / 2600) * Math.PI * 2)
        const sitShift = Math.sin((t / 7300) * Math.PI * 2 + 1.2)
        const uaF = ground ? -0.55 : -0.35
        const laF = ground ? -1.15 : -0.95
        /* 0.45.73 手要「垂着再搭到腿上」。
           以前这里对 upperArm 用 mixTo 写绝对值 -downBase*0.45：downBase 是
           「手臂还要往下放多少」（A-pose 模型被 droop 吃掉大半，接近 0），
           写绝对值等于把站姿那点手臂下垂全部抹掉 → 坐着时两条胳膊横着张开
           （真机截图实锤，用户说的「手张着」）。
           这里改成在站姿基础上**加增量**：只往前带一点、往身体内收一点，
           下垂量沿用站姿，怎么改都不会把手臂举起来。 */
        add('leftUpperArm', uaF * sit + 0.02 * sitBreath * sit, 0, -0.05 * sit)
        add('rightUpperArm', uaF * sit + 0.02 * sitBreath * sit, 0, 0.05 * sit)
        mixTo('leftLowerArm', laF + 0.05 * sitBreath, 0, 0.02 * sitShift, sit)
        mixTo('rightLowerArm', laF + 0.05 * sitBreath, 0, -0.02 * sitShift, sit)
        // 0.45.45 落座重心后移：骨盆向后坐（x 负=后倾）、脊柱前倾回正——
        // 「把重量放到凳子上」的剪影；只有腿弯、躯干笔直 = 悬浮感（主人实锤）
        // 0.45.47 席地坐改前倾撑膝（重心在前），后移反而像半躺
        add('hips', ground ? -0.04 : -0.10 * sit, 0, 0.045 * ws * sit)
        add('spine', (ground ? 0.20 : 0.13) * sit + 0.02 * sitShift * sit, 0, -0.03 * ws * sit)
        add('neck', 0, 0, -0.02 * ws * sit)
      }

      /* ---- 待机手势：叠在最后，幅度随 idle 收放（走起来自动消失） ---- */
      const g = gestureStep(t, idle)
      if (g) {
        const k = idle
        for (const n in g) {
          const v = g[n]
          if (v) add(n, v[0] * k, v[1] * k, v[2] * k)
        }
      }

      // 一次性写回：rest + 增量。没进增量表的骨骼保持 rest（从没被写过）
      D.forEach((a, n) => {
        const r = rest.get(n) || ZERO
        rig[n].rotation.set(r.x + a[0], r.y + a[1], r.z + a[2])
      })

      // 上下起伏：两步一个完整周期（|sin| 的周期是 π），落在 root 上
      if (st.root && st.root.position) {
        const h = st.height || 1.5
        // 0.45.38 下沉 0.25h → 0.15h（坐高凳式）：几何上「脚踩地」的坐姿脚踝必然
        // 正好压在舞台底边上=必被窗口裁掉（0.45.37 的 0.25h 用户实拍仍看不到脚）。
        // 0.15h 时脚踝在底边上方 ~0.09h 完整可见，配合主进程 SIT_HIPS=0.37 卡片顶边对齐不变
        // 0.45.45 落定回弹：坐到位瞬间先顿一下（更沉）再回弹半次——「重量落到凳子上」
        // 0.45.47 席地坐下沉 0.30h：屁股落在「地面」（窗口底边）上，膝盖朝天，一眼是坐地上
        const sitSink = (st.poseStyle === 'ground' ? 0.30 : 0.15) * sit
        let settleBump = 0
        if (st.sitSettleAt) {
          const sd = (t - st.sitSettleAt) / 1000
          /* 0.45.67：原来是 exp*sin(13t) 的衰减振荡（2Hz、幅度 18mm）——那是抖动感本身，
             就算只播一次也像「触电」。改成单调：落座瞬间多沉 8mm，之后一路衰减回正，
             视觉上是「重量压下去再稳住」，没有任何来回。 */
          if (sd < 0.9) settleBump = -0.008 * Math.exp(-sd * 4.5)
          else { st.sitSettleAt = 0; st.sitSettled = true }
        }
        st.root.position.y = st.rootBaseY + (Math.abs(Math.sin(ph)) - 0.5) * POSE.bob * h * amt - (sitSink - settleBump * sit) * h
      }
    }

    /* 0.45.54 诊断上报：渲染层 console 进不了 main.log，走 o.onDiag → 宿主落盘。
       这次修待机动作必须能事后核对「到底播了哪一条」，不能再靠「预载就绪」交差。 */
    function diag (msg) {
      try { if (typeof o.onDiag === 'function') o.onDiag(String(msg)) } catch { }
    }

    /** 0.45.54 播一条池内待机 VRMA（站立窗口 + 兜底秒表共用）。true=播成功
     *  0.45.76 maxDur：秒表补的「小动作」只许 ≤10s 的——「看手机 20s」这种
     *  长剧情每分钟插一条，就是用户说的「待机时怪动作」；站立窗口不限。 */
    function playPoolClip (t, why, maxDur) {
      const pool = st.idleVrmas || []
      if (!pool.length) return false
      const clip = pickPoolClip(pool, maxDur)
      if (!clip) return false
      try {
        st.mixer.stopAllAction()
        const act = st.mixer.clipAction(clip)
        const LOOP_ONCE = typeof THREE !== 'undefined' && THREE.LoopOnce !== undefined ? THREE.LoopOnce : 2200
        act.setLoop(LOOP_ONCE, 1)
        act.clampWhenFinished = false
        act.reset()
        act.fadeIn(0.25)
        act.play()
        st.animHold = false
        st.rig = null
        /* 0.45.77 毫秒/秒单位修复（待机动作「只有一下」的真凶）：
           t 是毫秒时间戳，clip.duration 是秒——旧代码 `t + duration` 让
           clipHold/poolUntil 在下一帧（16ms 后）就已过期 → lifecycle else 立刻
           stopAllAction 杀掉刚起播的动作 → 屏幕上「只有起播那一下的抽动」。
           clipHold 机制自 0.32.0 起就带着这个 bug（0.45.60 注释里的
           「动作永远停在第 0 帧/每 2 秒重播」死循环、0.45.54「播了跟没播一样」
           全是它的各种表现），mixer 一次性动画从没完整播完过。 */
        st.clipHold = { until: t + Math.min(clip.duration || 1, 20) * 1000 + 250 }
        st.poolPlaying = true
        st.poolAct = act
        // 池内动作自己管到点时间：clipHold 会被走路/坐姿/别的路径 releaseAnim 清掉，
        // 清了之后动作还在跑但 idle 也回来了 → 两条平分权重（实测 wNorm=1 wRaw=1）
        /* 0.45.80 poolUntil 提前 250ms 到期：动作自然播完的时刻和 poolUntil 只差
           一两帧，谁先到是掷硬币——提前量让「到点淡出」必然赶在 isRunning() 翻转
           之前启动，交叉渐变永远平滑；真被打断（剩余 >600ms）仍走重启分支。 */
        st.poolUntil = t + Math.max(Math.min(clip.duration || 1, 20) * 1000 - 250,
          Math.min(clip.duration || 1, 20) * 800)
        // 0.45.53 连播：看完一条有四成概率 2~5s 后再来一条（人无聊时小动作是连发的）
        // 0.45.76 砍：40%/2~5s 就是真机日志里「思考→3s→鼓掌」背靠背抽风的主因，
        //   改成两成概率、隔 30~60s——还有连击感，但不再是鬼打墙。
        if (Math.random() < 0.2) {
          st.fidgetNext = t + Math.min(clip.duration || 1, 20) * 1000 + rand(30000, 60000)
        }
        /* 0.45.67：这个站立窗口已经用掉了。否则「起身瞬间由秒表播一条」之后 2.2s，
           主路径还会再播一条「站立窗口」把上一条盖掉——真机日志里
           `看手机 20.0s` 两秒后就跟了 `张望 站立窗口 2.4s`，用户看到的就是动作只做两下。 */
        st.standPlayed = true
        diag('待机动作播放: ' + String(clip.__srcName || clip.name || '?') + ' · ' + (why || '') +
          ' · 幅度 ' + (clip.__amp === undefined ? '?' : clip.__amp + '°') +
          ' · 时长 ' + Math.min(clip.duration || 1, 20).toFixed(1) + 's' +
          /* 0.45.77 轨道绑定实证：tracks[0] 到底是不是 Normalized_*（wN/wR 分类
             和 autoUpdate 翻转全押在这上面），轨道总数一并留档 */
          ' · 轨道 ' + (clip.tracks ? clip.tracks.length : 0) + ' 条首轨=' +
          (clip.tracks && clip.tracks.length ? String(clip.tracks[0].name) : '?'))
        /* 0.45.55 实测探针：播完 1.2s 直接读原始骨骼转了多少度，以及当时的开关与
           权重分布——用户「播了但看不到」必须用数字定位，不再靠日志猜。 */
        try {
          const h = st.vrm && st.vrm.humanoid
          const names = ['leftUpperArm', 'rightUpperArm', 'leftUpperLeg']
          const grab = () => names.map((n) => {
            const rn = h && h.getRawBoneNode && h.getRawBoneNode(n)
            return rn ? { x: rn.quaternion.x, y: rn.quaternion.y, z: rn.quaternion.z, w: rn.quaternion.w } : null
          })
          const q0 = grab()
          /* 0.45.77 三点采样：300/700/1200ms 各读一次池内动作生死。
             1.2s 单点只能看到「已经死了」，看不到「什么时候死的、死前什么状态」；
             三点一串，死亡时刻±200ms 内必有一个采样。 */
          const poolProbe = () => {
            try {
              const act = st.poolAct
              let wN = 0; let wR = 0; const names = []
              const acts = (st.mixer && st.mixer._actions) || []
              for (const a of acts) {
                if (!a.isRunning()) continue
                const w = a.getEffectiveWeight()
                if (w <= 0.01) continue
                const tr = (a.getClip() && a.getClip().tracks) || []
                if (!tr.length) continue
                if (/^Normalized_/.test(String(tr[0].name || ''))) { if (w > wN) wN = w } else { if (w > wR) wR = w }
                if (names.length < 3) names.push(String(tr[0].name).split('.')[0] + '@' + w.toFixed(2))
              }
              diag('池内采样: act=' + (act ? (act.isRunning() ? '跑' : '停') + '/t=' + act.time.toFixed(2) + '/w=' + act.getEffectiveWeight().toFixed(2) : 'null') +
                ' wN=' + wN.toFixed(2) + ' wR=' + wR.toFixed(2) + ' autoUpd=' + (st.vrm && st.vrm.humanoid ? st.vrm.humanoid.autoUpdateHumanBones : '?') +
                ' hold=' + !!st.animHold + ' rig=' + !!st.rig + ' walkOn=' + !!st.walk.on + ' pool=' + !!st.poolPlaying +
                ' clipHoldIn=' + (st.clipHold ? Math.round(st.clipHold.until - Date.now()) : '-') +
                ' 跑着的动作[' + names.join(',') + ']')
            } catch { }
          }
          setTimeout(poolProbe, 300)
          setTimeout(poolProbe, 700)
          // 0.45.63 画布像素签名：OBS 抓帧可能给的是缓存画面，不能当唯一证据。
          // 这里直接在 WebGL 上下文中 readPixels（preserveDrawingBuffer=true 才有值），
          // 比较播放中和 1.2s 后的画布内容——它变了就是真的在动。
          const psig = () => {
            try {
              const gl = renderer.getContext()
              const w = 48; const h = 64
              const buf = new Uint8Array(w * h * 4)
              gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
              let sum = 0
              for (let i = 0; i < buf.length; i += 17) sum = (sum * 31 + buf[i]) % 1000003
              return sum
            } catch { return -1 }
          }
          const p0 = psig()
          setTimeout(() => {
            try {
              const q1 = grab()
              let maxDeg = 0
              for (let i = 0; i < q0.length; i++) {
                if (!q0[i] || !q1[i]) continue
                const dot = Math.min(1, Math.abs(q0[i].x * q1[i].x + q0[i].y * q1[i].y + q0[i].z * q1[i].z + q0[i].w * q1[i].w))
                maxDeg = Math.max(maxDeg, 2 * Math.acos(dot) * 180 / Math.PI)
              }
              let wNorm = 0; let wRaw = 0
              const acts = (st.mixer && st.mixer._actions) || []
              for (const a of acts) {
                if (!a.isRunning()) continue
                const w = a.getEffectiveWeight()
                if (w <= 0.01) continue
                const tr = a.getClip() && a.getClip().tracks
                if (!tr || !tr.length) continue
                if (/^Normalized_/.test(String(tr[0].name || ''))) { if (w > wNorm) wNorm = w } else if (w > wRaw) wRaw = w
              }
              diag('实测骨骼转角 ' + maxDeg.toFixed(1) + '° · autoUpdate=' + (h ? h.autoUpdateHumanBones : '?') +
                ' · wNorm=' + wNorm.toFixed(2) + ' wRaw=' + wRaw.toFixed(2) +
                ' · 画布签名 ' + p0 + '→' + psig() + (p0 === psig() ? '（未变）' : '（已变）'))
            } catch { }
          }, 1200)
        } catch { }
        try { if (typeof o.onSelfAct === 'function') o.onSelfAct('idle_fidget') } catch { }
        return true
      } catch { return false }
    }

    /** 0.45.54 量一条 VRMA 的动作幅度（度）＝所有旋转轨道里相对首帧的最大角差。
     *  待机-呼吸只有 4.6°，看着跟静止一样——池子里等概率抽它就是「播了等于没播」。 */
    function clipAmp (clip) {
      let max = 0
      const tracks = (clip && clip.tracks) || []
      for (const tr of tracks) {
        if (!/quaternion$/i.test(String(tr.name || ''))) continue
        const v = tr.values
        if (!v || v.length < 8) continue
        const x0 = v[0], y0 = v[1], z0 = v[2], w0 = v[3]
        for (let i = 4; i + 3 < v.length; i += 4) {
          const dot = Math.min(1, Math.abs(x0 * v[i] + y0 * v[i + 1] + z0 * v[i + 2] + w0 * v[i + 3]))
          const ang = 2 * Math.acos(dot) * 180 / Math.PI
          if (ang > max) max = ang
        }
      }
      return Math.round(max)
    }

    /** 0.45.54 按幅度加权挑一条池内动作。0.45.76 两处改：
     *  · maxDur：传了就只在这条时长以内挑（秒表路径 10s），全超长就放弃这次；
     *  · 幂 1.4 → 0.8：原权重让「思考 132°/看手机 130°」几乎垄断（真机日志
     *    五分钟里占了 6 条），压平后中幅度（张望/鼓掌/待机B）也能轮上。 */
    function pickPoolClip (pool, maxDur) {
      let usable = pool.filter((c) => (c.__amp === undefined ? 30 : c.__amp) >= 15)
      if (maxDur > 0) {
        const short = usable.filter((c) => Math.min(c.duration || 1, 20) <= maxDur)
        if (short.length) usable = short
        else return null
      }
      const arr = usable.length ? usable : pool
      let total = 0
      const w = arr.map((c) => {
        const a = c.__amp === undefined ? 30 : c.__amp
        const x = Math.pow(Math.max(a - 8, 1), 0.8)
        total += x
        return x
      })
      let r = Math.random() * total
      for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i] }
      return arr[arr.length - 1]
    }

    function step () {
      if (!st.alive) return
      // 窗口 hidden（非宿主屏的 overlay）时整帧跳过：两块屏各自满帧画一个
      // 看不见的模型是 GPU 白烧的一半（visibilitychange 已停表，这里兜底）
      if (hidden()) return
      // RESTING_FPS 两档调度：忙=满帧，闲=restFps。呼吸/眨眼在低帧率下肉眼无差
      const busy = isBusy ? !!isBusy() : true
      const want = busy ? Math.round(1000 / fps) : Math.round(1000 / restFps)
      if (want !== curGap) {
        curGap = want
        if (timer) { clearTimer(timer); timer = setTimer(step, want) }
      }
      const t = now()
      // 掉帧钳制：切回前台时 dt 可能是几秒，springbone 会瞬间抽飞
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0
      last = t
      try {
        fit()
        expressions(t, dt)
        // 0.31.0：animHold（坐下/手势期间的程序化接管）结束条件——手势播完、
        // 起身坐姿归零、没在走路，就交还给官方动画。
        // 0.45.36 补 st.pose !== 'sit'：命令坐下时 sitAmt 还没涨起来（0.25s 过渡），
        // 这个条件会立刻把 hold 放掉 → rig 销毁 → 官方 idle 恢复 → 坐姿永远画不出来
        // （0.31.0 起「坐卡片只是走过去站着」的真根因）。
        if (st.animHold && !gest && !st.walk.on && st.sitAmt < 0.01 && st.pose !== 'sit') releaseAnim()
        // 0.32.0：官方片段一次性点播结束（到点回 idle；起步走路会在 setWalk 里提前收）
        if (st.clipHold && t >= st.clipHold.until) releaseAnim()
        // 0.32.1：安静待机基底 + 偶尔播一次长待机小彩蛋（idle_fidget），
        // 避免官方长待机每 10s 一圈伸懒腰的「一直重复」感
        // 0.45.51：从 45% 起播——前 40% 是双臂前伸上举的伸懒腰（用户点名不要），
        // 只留后半段手背后/张望这些自然小动作
        /* 0.45.60 站立窗口重写（治「每 2 秒重播一次」）
           0.45.54~59 的写法有个死循环：播完 clipHold 一置，standingIdle 就变假 →
           else 分支把 standPlayed 清掉 → clipHold 一松就再播一次，动作永远停在第 0 帧，
           屏幕上等于一动不动（日志里 21:54:30/32/34/36 每 2 秒一条「播放」实锤）。
           现在拆成两层：
             trulyStanding = 只看「站着」这件事（不受 clipHold 影响）
             canPlay       = 站着 + 当前没有动作在播 + 过了这条动作的到点时间
           每个站立窗口只播一条；poolUntil 是硬冷却，任何路径都不能提前重播。 */
        const trulyStanding = st.mixer && !st.animHold && !st.rig && !st.walk.on && st.sitAmt < 0.01
        if (trulyStanding) {
          if (!st.standAt) {
            st.standAt = t
            st.standPlayed = false
            diag('站立待机窗口打开（池 ' + ((st.idleVrmas || []).length) + ' 条）')
          }
        } else {
          st.standAt = 0
          st.standPlayed = false
        }
        const canPlay = trulyStanding && !st.clipHold && !st.poolPlaying &&
          t >= (st.poolUntil || 0) && (st.idleVrmas || []).length > 0
        /* 0.45.67：兜底秒表不该被「池里有东西」这个条件卡死。
           以前池空时 canPlay 恒 false → 190 行的官方 idle_fidget 兜底成了死代码，
           池加载失败（首波撞模型未就绪是常态）就再也长待机没有小动作了。
           现在只要站着、没在播别的、没在走路，就按秒表来；有池先抽池，池空用官方片段。 */
        const canFidget = trulyStanding && !st.clipHold && !st.poolPlaying &&
          t >= (st.poolUntil || 0)
        // ① 进入站立窗口 2.2s 后播一条（主路径）
        // 0.45.76 降频（真机日志实锤「待机时怪动作」= 播得太勤）：
        //   14:24~14:29 五分钟 11 条，平均 30~60s 一次 100°+ 的大动作，
        //   还有三条 2~5s 的背靠背连播（思考→鼓掌、鼓掌→思考、思考→看手机）。
        //   桌宠的「偶尔小动作」应该是 1~2.5 分钟一次，连播也要隔上半分钟起。
        if (canPlay && !st.standPlayed && t - (st.standAt || t) >= 2200) {
          st.standPlayed = true
          if (playPoolClip(t, '站立窗口')) st.fidgetNext = t + rand(70000, 150000)
        } else if (canFidget && t >= st.fidgetNext) {
          // ② 兜底秒表：长待机时再补一条（必须 standPlayed 已用掉，避免和 ① 重复）
          st.fidgetNext = t + rand(70000, 150000)
          if (playPoolClip(t, '秒表', 10)) {
            // playPoolClip 内部已上报
          } else {
            playClipFn('idle_fidget', { fromFrac: 0.45 })
            diag('待机动作: idle_fidget（池空，用官方片段）')
            try { if (typeof o.onSelfAct === 'function') o.onSelfAct('idle_fidget') } catch { }
          }
        }
        if (st.mixer) {
          if (!st.animHold) st.mixer.update(dt)
          /* 0.32.1：呼吸叠加——quiet 待机 clip（30181）本身起伏很小，root 上再叠一层。
             0.45.67 修「呼吸像漂浮在空中」（用户实锤）：
             原来写的是 sin(breathPh)*0.006*h，幅度 ±9.8mm，脚底跟着上下 20mm
             （sit-probe 实测 minY span=0.0196m，和 root.y 波动一模一样）——
             脚整个离地再落回，视觉上就是人在半空浮着。
             人呼吸时脚是不动的：这里只保留「向下沉」的一半（0~2.7mm），
             永远不抬脚，配上脚底的接触阴影才有踩住地面的感觉。 */
          if (!st.animHold && !st.clipHold && !st.walk.on && st.sitAmt < 0.01) {
            st.breathPh = (st.breathPh || 0) + dt * (Math.PI * 2 / 3.4)
            if (st.root && st.root.position) {
              const sink = (1 - Math.cos(st.breathPh)) * 0.5 * 0.0018 * (st.height || 1.5)
              st.root.position.y = st.rootBaseY - sink
            }
          }
          // mixer 模式的侧身：poseIt 不跑，root 朝向在这里补（0.22s 淡转，与程序化同速）。
          // 0.33.0：amt 约定与 poseIt 统一（0~1 + 独立 sign）——之前 mixer 分支把 amt
          // 直接当弧度（±π/2）用，两处各推各的，会卡在中间不动。
          const side = st.side
          const wantAmt = st.walk.on ? 1 : 0
          const walkSign = st.walk.dir < 0 ? -1 : 1
          const k = Math.min(1, dt / 0.22)
          side.amt += (wantAmt - side.amt) * k
          if (st.root && st.root.rotation) st.root.rotation.y = side.base + side.amt * (Math.PI / 2) * walkSign
        }
        // 程序化姿态必须在 mixer 之后写（animHold 时 mixer 暂停，不会打架）
        poseIt(t, dt)
        // 0.45.48 传播开关每帧收敛（真凶修复）：0.31.0 起 mixer 模式把
        // autoUpdateHumanBones 一刀切关死（官方 clip 轨道直绑 raw 骨骼，开着会被
        // normalized 残留盖掉），但 0.45.44 的 VRMA 轨道绑的是 Normalized_* 节点，
        // 必须开着才能拷到 raw——结果 VRMA 一直在写归一化骨架、raw 纹丝不动
        // （walkDebug 实锤 normDelta 0.2~0.6 / rawDelta 0.000，真机永远 A 字点姿）。
        // 手动在每条播放路径上设必漏，这里按「当前权重占优的 act 用哪套轨道」
        // 声明式推导：Normalized_* 占优（VRMA/程序化）=开，raw 占优（官方 clip）=关。
        // 0.45.57 池内动作生命周期自管：不依赖 clipHold（别的路径会 releaseAnim 把它清掉，
        // 真机表现＝日志说「播了」，1 秒后骨骼回到 idle，动作只做了一瞬）。
        // 规则：走路开始 / 到点才收；被中断（act 被停）就自动重启；期间每帧压住官方 idle。
        try {
          if (st.poolPlaying && st.poolAct && !st.walk.on && t < (st.poolUntil || 0)) {
            /* 0.45.80：动作「自然播完」也会让 isRunning()=false（比 poolUntil 早
               一两帧），以前这里一律 reset+play 从头重播——真机日志每次播完必现
               「被中断，已重启」，表现为动作结束瞬间跳回第 0 帧再 fades（用户看到的
               「突然转身又突然恢复待机」的另一半）。只有「死得远早于预约时间」
               （剩余 >600ms）才算真被打断才重启；自然尾声交给到点淡出。 */
            if (!st.poolAct.isRunning() && (st.poolUntil || 0) - t > 600) {
              try { st.poolAct.reset(); st.poolAct.fadeIn(0.15); st.poolAct.play() } catch { }
              diag('池内动作被中断，已重启: ' + String(
                (st.poolAct.getClip && st.poolAct.getClip().__srcName) || '?'))
            }
            if (st.clipIdleAction && st.clipIdleAction.isRunning() &&
                st.clipIdleAction.getEffectiveWeight() > 0.01) {
              st.clipIdleAction.fadeOut(0.15)
            }
          } else if (st.poolPlaying) {
            st.poolPlaying = false
            st.poolUntil = 0
            /* 0.45.79 到点收场改淡出交接：以前走 releaseAnim → stopAllAction 硬切，
               「张望」这类带髋部/根节点旋转的动作，最后帧姿势瞬间弹回待机
               （用户实锤「突然间转身但又突然间恢复待机」）。改为动作淡出 0.35s、
               官方 idle 淡入 0.35s，交叉渐变完再交还。走路开始仍走硬切（走路
               自带进场，且淡出会和走路抢骨骼）。 */
            const pact = st.poolAct
            if (!st.walk.on && pact && pact.isRunning && pact.isRunning()) {
              try { pact.fadeOut(0.35) } catch { }
              try {
                st.clipIdleAction.reset(); st.clipIdleAction.fadeIn(0.35); st.clipIdleAction.play()
              } catch { }
              st.fadePool = { act: pact, until: t + 450 }
            } else {
              st.poolAct = null
              releaseAnim() // 到点/开始走路：停所有动作并回官方 idle
            }
          }
          /* 0.45.79 淡出收尾：动作淡完（或到兜底时刻）再走 releaseAnim 归位 */
          if (st.fadePool && (t >= st.fadePool.until || !st.fadePool.act.isRunning())) {
            st.fadePool = null
            /* 淡出期间若坐下/手势已接管（rig/animHold），归位由接管路径负责，
               这里绝不能再 releaseAnim——会把它刚建好的坐姿拆掉 */
            if (!st.poolPlaying && !st.rig && !st.animHold) {
              st.poolAct = null
              releaseAnim() // 动作已淡完，这里的 stopAllAction 是空操作
            }
          }
        } catch { }
        try {
          if (st.vrm && st.vrm.humanoid && st.mixer) {
            let wNorm = 0, wRaw = 0
            const acts = st.mixer._actions || []
            for (const act of acts) {
              try {
                if (!act.isRunning()) continue
                const w = act.getEffectiveWeight()
                if (w <= 0.01) continue
                const tr = act.getClip() && act.getClip().tracks
                if (!tr || !tr.length) continue
                if (/^Normalized_/.test(String(tr[0].name || ''))) { if (w > wNorm) wNorm = w }
                else if (w > wRaw) wRaw = w
              } catch { }
            }
            // 严格大于：无 act 可判（0>0 假）回落官方语义 false；交叉淡化平手瞬间
            // 归官方，下一帧权重反超即翻转，肉眼无感
            // 0.45.55：池内待机动作播放期间强制打开（实测「播了没看到」时兜底），
            // releaseAnim 清掉 poolPlaying，不影响其他路径
            // 0.45.76：池内动作必须「真的还在跑」才允许强制开——真机实锤
            // （14:28:38 思考播放 1.2s 后 wNorm=0 wRaw=0 却 autoUpdate=true，
            // 单帧 77.4°）：动作已被杀、poolPlaying 残留 true 时，谁都不写骨骼，
            // normalized 残留（=绑定姿势 A-pose）被拷进 raw，手臂瞬间外翻再弹回，
            // 用户看到的就是「待机时抽一下」。
            const want = (wNorm > wRaw) || !!st.rig || !!st.animHold ||
              (!!st.poolPlaying && !!st.poolAct && st.poolAct.isRunning())
            if (st.vrm.humanoid.autoUpdateHumanBones !== want) {
              /* 0.45.73：raw↔normalized 的控制权交接就是一次「整体换姿势」，这里是
                 所有路径（官方片、VRMA、程序化、池内动作）的唯一收口——交接瞬间起补间。
                 实测起步走路时 leftHand 单帧 90°（VRMA 没有手部轨道，切到 normalized
                 后手回绑定姿势），也是这一处救的。 */
              beginRawBlend(0.28)
              st.vrm.humanoid.autoUpdateHumanBones = want
            }
          }
        } catch { }
        if (st.vrm) st.vrm.update(dt)
        /* 0.45.73 硬切补间：vrm.update() 里 humanoid 把 normalized 拷到 raw（或 mixer
           直接写 raw），切换那一帧就是「整体换一套姿态」。这里在渲染前把 raw 从旧快照
           slerp 到新姿态，0.3s 内收敛——sit-snap 探针从 177.8°/帧 降到几度。 */
        try {
          if (st.rawBlend && st.vrm && st.vrm.humanoid) {
            const k0 = (t - st.rawBlend.t0) / (st.rawBlend.dur * 1000)
            if (!(k0 < 1)) st.rawBlend = null
            else {
              const k = k0 <= 0 ? 0 : k0 * k0 * (3 - 2 * k0)
              const hm = st.vrm.humanoid
              st.rawBlend.snap.forEach((q0, n) => {
                let b = null
                try { b = hm.getRawBoneNode(n) } catch { b = null }
                if (!b || !b.quaternion) return
                const qt = b.quaternion.clone()
                b.quaternion.copy(q0).slerp(qt, k)
              })
            }
          }
        } catch { }
        /* 0.45.80 待机手臂自然化（运行时自校正版）：模型烘入的 idle_still 上臂
           离垂线 60°/66°（文件解析实测），官方 clip 每帧写绝对值改不了 clip——
           在所有骨骼写完之后，把上臂世界方向朝「保留水平方位角、仰角 12°」
           的目标转过去。不累积：每帧 mixer/vrm.update 重写后再修，权重 0.25s 淡入淡出。
           0.45.84：池内动作播放期间也修，但只半权重（0.55）——池内 clip 同样带着
           烘入的外张上臂，之前一进动作手臂就弹回 60°+ 外张原样（用户：手部动作
           好出戏）；半权重的意思是动作本身的挥动保留，静态外张收掉一半。
           走路/坐 rig/animHold 仍然完全不修（那些有自己的手臂逻辑）。 */
        try {
          if (st.vrm && st.vrm.humanoid) {
            const poolBusy = st.fadePool || (st.poolPlaying && st.poolAct && st.poolAct.isRunning())
            let natTarget = 0
            if (!st.walk.on && !st.rig && !st.animHold) natTarget = poolBusy ? 0.9 : 1
            const an = st.armNat || (st.armNat = { w: 0 })
            an.w += (natTarget - an.w) * Math.min(1, dt / 0.25)
            if (an.w > 0.01) {
              const hm = st.vrm.humanoid
              const sides = st.__armSides || (st.__armSides = [
                { up: 'leftUpperArm', low: 'leftLowerArm' },
                { up: 'rightUpperArm', low: 'rightLowerArm' }
              ])
              for (let si = 0; si < sides.length; si++) {
                const s = sides[si]
                let up = null, low = null
                try { up = hm.getRawBoneNode(s.up); low = hm.getRawBoneNode(s.low) } catch { }
                if (!up || !low || !up.quaternion) continue
                up.updateWorldMatrix(true, false)
                low.updateWorldMatrix(false, false)
                const pu = up.getWorldPosition(st.__anV1 || (st.__anV1 = new THREE.Vector3()))
                const pl = low.getWorldPosition(st.__anV2 || (st.__anV2 = new THREE.Vector3()))
                const dir = st.__anV3 || (st.__anV3 = new THREE.Vector3())
                dir.subVectors(pl, pu)
                if (dir.lengthSq() < 1e-8) continue
                dir.normalize()
                const horiz = Math.sqrt(dir.x * dir.x + dir.z * dir.z)
                if (horiz < 0.05) continue // 已经基本垂直，不用收
                /* 0.45.85 仰角带通：只收「外张区间」的手臂，抬起来的动作不干预。
                   elev = 上臂离垂线角（droop 口径）。模型烘入的 idle/动作静置段在
                   48~71°（探针实测），而鼓掌/挥手/伸懒腰这类 gesture 会把臂抬到
                   70° 以上甚至水平——对抬臂强行压回 12° 会把动作打断（0.45.84
                   半权重 0.55 就是为了躲这个，代价是动作静置段还剩 28~38° 依然外张）。
                   改成按仰角分带：<25° 已贴身不用收；25~40° 渐入；40~72° 全力收；
                   72~88° 渐出（保护抬臂动作）；≥88° 完全不动。这样动作期间可以用
                   0.9 的大权重，动作本身的手臂轨迹不受影响。 */
                const elevDeg = Math.atan2(horiz, -dir.y) * 180 / Math.PI
                let band = 0
                if (elevDeg > 25 && elevDeg < 88) {
                  if (elevDeg < 40) band = (elevDeg - 25) / 15
                  else if (elevDeg <= 72) band = 1
                  else band = 1 - (elevDeg - 72) / 16
                }
                /* 0.45.86 时间平滑：鼓掌这类动作会让上臂在带通边界（~72°）来回摆，
                   逐帧的 band 跟着 1→0.5→1 泵动 = 用户说的「抽搐」。0.18s 低通让
                   权重跨边界时是滑过去的，不跟动作的高频摆动共振。 */
                const bands = st.__anBands || (st.__anBands = [0, 0])
                band = bands[si] + (band - bands[si]) * Math.min(1, dt / 0.18)
                bands[si] = band
                if (band < 0.02) continue
                const effW = an.w * band
                const des = st.__anV4 || (st.__anV4 = new THREE.Vector3())
                des.set(dir.x / horiz * Math.sin(ARM_NAT_DROOP), -Math.cos(ARM_NAT_DROOP),
                  dir.z / horiz * Math.sin(ARM_NAT_DROOP))
                const R = st.__anQ1 || (st.__anQ1 = new THREE.Quaternion())
                R.setFromUnitVectors(dir, des)
                if (effW < 0.99) R.slerp(st.__anQi || (st.__anQi = new THREE.Quaternion()), 1 - effW)
                // 量化探针：动作期间每 600ms 记一次上臂离垂线角（修前→实际修后）
                if (poolBusy && effW > 0.25) {
                  const nowMs = Date.now()
                  if (!st.__anLog || nowMs - st.__anLog > 600) {
                    st.__anLog = nowMs
                    const d2 = st.__anV5 || (st.__anV5 = new THREE.Vector3())
                    d2.copy(dir).applyQuaternion(R)
                    const h2 = Math.sqrt(d2.x * d2.x + d2.z * d2.z)
                    const degAfter = Math.round(Math.atan2(h2, -d2.y) * 180 / Math.PI)
                    console.warn('[arm-nat] 动作中 上臂离垂线 ' + Math.round(elevDeg) + '° → ' + degAfter + '°（w=' + effW.toFixed(2) + '）')
                  }
                }
                // 世界旋转 → 局部增量：qLocal' = parentQ⁻¹ · R · parentQ · qLocal
                const pq = st.__anQ2 || (st.__anQ2 = new THREE.Quaternion())
                up.parent.getWorldQuaternion(pq)
                const corr = st.__anQ3 || (st.__anQ3 = new THREE.Quaternion())
                corr.copy(pq).invert().multiply(R).multiply(pq)
                up.quaternion.premultiply(corr)
              }
            }
          }
        } catch { }
        updateGroundShadow()
        renderer.render(scene, camera)
      } catch (e) {
        st.error = e
        stop()
      }
    }

    /** 按名字播一个官方片段（0.32.0）：一次性播放，播完自动回 idle。
        正在走路/程序化接管时返回 false。step() 的小彩蛋调度也走这里。 */
    function playClipFn (name, opt) {
      opt = opt || {}
      // 走路和程序化接管时拒绝；坐着也允许播（坐着挥手这类）
      if (!st.mixer || st.rig || st.animHold || st.walk.on) return false
      const clips = st.clips || []
      const clip = clips.find((c) => String(c.name || '') === String(name || ''))
      if (!clip) return false
      try {
        st.mixer.stopAllAction()
        const act = st.mixer.clipAction(clip)
        const LOOP_ONCE = typeof THREE !== 'undefined' && THREE.LoopOnce !== undefined ? THREE.LoopOnce : 2200
        act.setLoop(LOOP_ONCE, 1)
        act.clampWhenFinished = false
        act.reset()
        // 0.45.51：opt.from（秒）或 opt.fromFrac（0~1 比例）= 跳过开头从中间开始播。
        // 用途：idle_fidget 前 40% 是伸懒腰（用户点名不要），插播时从 45% 起播
        // 后半段（手背后/张望这些自然小动作）。
        let startAt = 0
        if (opt.fromFrac !== undefined) startAt = (clip.duration || 1) * Math.max(0, Math.min(0.95, Number(opt.fromFrac) || 0))
        if (opt.from !== undefined) startAt = Math.max(0, Math.min((clip.duration || 1) - 0.05, Number(opt.from) || 0))
        if (startAt > 0) { try { act.time = startAt } catch { } }
        const fi = Math.max(0.05, Math.min(0.3, Number(opt.fadeIn) || 0.12))
        act.fadeIn(fi)
        act.play()
        st.animHold = false
        st.rig = null
        // 0.45.77 单位修复：duration 是秒，now() 是毫秒（同 playPoolClip）
        st.clipHold = { until: now() + ((clip.duration || 1) - startAt) * 1000 + fi * 1000 }
        return true
      } catch { return false }
    }

    function start () {
      stop()
      last = 0
      curGap = Math.round(1000 / fps)
      nextBlink = now() + rand(blinkMin, blinkMax)
      // 刚显示出来的 1.5~3.5s 先只呼吸，别一出现就伸懒腰（像幻灯片自动播放）
      if (!gest) gestNext = now() + rand(1500, 3500)
      step()
      // 30fps 定时器：伙伴层被覆盖时 rAF 会冻，定时器不受影响
      timer = setTimer(step, Math.round(1000 / fps))
    }

    function stop () {
      if (timer) { clearTimer(timer); timer = null }
    }

    // 窗口 hidden（切屏宿主/隐藏 overlay）→ 整个渲染停表；重新可见再启动
    function onVis () {
      if (!st.alive) return
      if (hidden()) stop()
      else if (!timer) start()
    }
    if (global.document && typeof global.document.addEventListener === 'function') {
      try { global.document.addEventListener('visibilitychange', onVis) } catch {}
    }

    function dispose () {
      if (!st.alive) return
      st.alive = false
      stop()
      try {
        if (global.document && typeof global.document.removeEventListener === 'function') {
          global.document.removeEventListener('visibilitychange', onVis)
        }
      } catch {}
      try { if (st.mixer) { st.mixer.stopAllAction(); st.mixer.uncacheRoot(st.root) } } catch {}
      try { renderer.dispose() } catch {}
      st.vrm = null
      st.root = null
      st.emo = null
    }

    /** 加载一个 VRMA 文件转成 clip（0.45.44 从 playVRMA 提出来，走路也要用） */
    async function loadVRMAClip (u) {
      const loader = new libs.GLTFLoader()
      try { loader.register((parser) => new libs.VRMAnim.VRMAnimationLoaderPlugin(parser)) } catch { }
      const gltf = await new Promise((ok, bad) => loader.load(u, ok, undefined, bad))
      if (!st.alive) throw new Error('已销毁')
      const anims = (gltf && gltf.userData && gltf.userData.vrmAnimations) || []
      if (!anims.length) throw new Error('文件里没有 VRMA 动画数据')
      const clip = libs.VRMAnim.createVRMAnimationClip(anims[0], st.vrm)
      if (!clip || !clip.tracks.length) throw new Error('VRMA 转出的 clip 为空（骨骼映射全没命中）')
      return clip
    }

    /* ---------------- 0.45.44 走路接真 MMD 动作 ----------------
     * 程序化摆腿（正弦大腿+膝补偿）调不出人味，VMD 转的 walk.vrma 是真走路。
     * 位移照旧由窗口移动负责，动画只负责「迈步」：hips 位移轨道剥掉（MMD センター
     * 的前移会烘进来，不剥她就往前飘），LoopRepeat 循环，timeScale 跟窗口速度走。 */
    const LOOP_REP = typeof THREE !== 'undefined' && THREE.LoopRepeat !== undefined ? THREE.LoopRepeat : 2201
    /* 0.45.50 步态物理对齐（治「滑着走」）：timeScale = 窗口速度 / 动画等效前进速度。
     * walk.vrma 实测（tools/check-walk-gait.js）：步频 ~1.5 步/s、摆幅 ~20°、全腿 0.785
     * → 等效前进速度 ≈0.5 单位/s。px→单位换算：fit() 取景 = 模型高×1.06 铺满画布高，
     * pxPerUnit = 画布高/(身高×1.06)。之前 speed/92 的经验常数就是滑步的根源——
     * 腿倒腾的速度比窗口挪的速度快一截，脚一直在地上打滑。 */
    const WALK_NATURAL_SPEED = 0.5 // 单位/s，换素材要重测
    function walkTimeScale (speed) {
      let pxPerUnit = 0
      try {
        const hgt = st.height || 1.5
        const canvasH = canvas.clientHeight || 0
        if (hgt > 0.1 && canvasH > 10) pxPerUnit = canvasH / (hgt * 1.06)
      } catch { }
      if (!(pxPerUnit > 0)) pxPerUnit = 150 // 兜底：260px 画布 / 1.73
      const spdUnits = (speed || 46) / pxPerUnit
      return Math.max(0.4, Math.min(1.6, spdUnits / WALK_NATURAL_SPEED))
    }
    async function setWalkMotion (u) {
      if (!u || !st.alive || !st.mixer) return false
      if (!libs.VRMAnim || !libs.VRMAnim.createVRMAnimationClip || !st.vrm) return false
      try {
        const clip = await loadVRMAClip(u)
        // 0.45.50：position 轨道不再全剥。MMD センター烘进来的「线性前移」只剥漂移
        // 成分（每轴减去 v0→vN 的线性趋势，首尾对齐→循环安全），上下起伏/侧向摆胯
        // 保留——那是步感的大头，全剥掉走路像浮在水上滑行（0.45.44 的滑步根源之一）
        for (const t of clip.tracks) {
          if (!/^Normalized_.*\.position$/.test(String(t.name || ''))) continue
          const n = t.times.length
          if (n < 2) continue
          const vals = t.values
          const T = t.times[n - 1] || 1
          for (let k = 0; k < 3; k++) {
            const v0 = vals[k], vN = vals[(n - 1) * 3 + k]
            const drift = vN - v0
            if (Math.abs(drift) < 1e-4) continue
            for (let i = 0; i < n; i++) vals[i * 3 + k] -= drift * (t.times[i] / T)
          }
        }
        if (!clip.tracks.length) return false
        const act = st.mixer.clipAction(clip)
        try { act.setLoop(LOOP_REP, Infinity); act.clampWhenFinished = false } catch { }
        st.vrmaWalk = { act }
        // 加载完成时正好在走路 → 立刻接管（不然这一段走路还是程序化）
        if (st.walk.on) {
          if (st.rig || st.animHold || st.clipHold) releaseAnim()
          try { act.timeScale = walkTimeScale(st.walk.speed) } catch { }
          try { act.reset(); act.fadeIn(0.25); act.play() } catch { }
          try { if (st.clipIdleAction) st.clipIdleAction.fadeOut(0.25) } catch { }
        }
        return true
      } catch (e) {
        try { (o.log || console.warn)('[vrm-stage] walk VRMA 加载失败，走路继续用程序化: ' + (e && e.message)) } catch { }
        return false
      }
    }

    const handle = {
      sig: st.sig,
      url: st.url,
      state: st,
      renderer, scene, camera,
      get vrm () { return st.vrm },
      get root () { return st.root },
      get clip () { return st.clip },
      get expressions () { return !!st.emo },
      get alive () { return st.alive },
      /** 姿态：'stand' | 'sit'（0.29.0 卡片联动用） */
      setPose (name, style) {
        st.pose = name === 'sit' ? 'sit' : 'stand'
        // 0.45.47 双坐姿：stool=坐卡片（高凳式，胯对卡片顶边）；ground=原地席地而坐
        // （大幅下沉+屈膝朝前，地面=窗口底边，治「飘着没有坐感」）
        st.poseStyle = style === 'ground' ? 'ground' : 'stool'
        // 0.31.0 mixer 模式：坐下时官方 idle 不该播（站着的人坐不下），切程序化坐姿
        if (st.mixer && st.pose === 'sit' && !st.rig) holdAnim()
      },
      /* 手动播一个待机手势（0.30.0）：lookAside / lookDown / weightShift / stretch /
         handHip / fixHair / bounce。返回 false = 没这个手势。
         主动权在宿主（表情动作联动、调试截图），播完照旧回到随机调度。 */
      playGesture (id, dur) {
        // 0.32.0：官方 clip 点播直通（gust_XXXXX 由 g1a-bake-all.py 烘入，名字即编号）
        if (/^gust_\d+$/.test(String(id || ''))) return this.playClip(id)
        // mixer 模式：官方 idle/walk 在播时程序化写骨骼会打架，暂停官方动画、
        // 临时启用 rig 播手势，播完 step() 里自动释放回官方动画
        if (!st.rig) { if (!st.mixer || !holdAnim()) return false }
        if (!gestureStart(String(id || ''), now(), dur)) return false
        gestNext = 0
        return true
      },
      /** 按名字播一个官方片段（0.32.0）：一次性播放，播完自动回 idle。
          正在走路/程序化接管时返回 false。 */
      playClip (name, opt) { return playClipFn(name, opt) },
      /** 播一个 VRMA 动画文件（0.45.39，MMD→VRMA 离线转换产物）。
       *  @param u aura:// URL（assetUrl 转过）；@param opt { loop, fadeIn }
       *  返回 false = 当前状态不能播（走路/程序化接管/无 mixer）。
       *  一次性播放时到点自动回 idle（复用 clipHold 机制）。 */
      async playVRMA (u, opt) {
        opt = opt || {}
        if (!u || !st.alive) return false
        // 0.45.45：坐着时来动作词先站起来（此前直接拒播=说【走路】没反应的主因之一；
        // playActionWord 已处理 actSit，这里兜底主驱 pose==='sit' 的场景）
        if (st.pose === 'sit') {
          st.pose = 'stand'
          if (st.animHold || st.rig) releaseAnim()
        }
        if (!st.mixer || st.rig || st.animHold || st.walk.on) return false
        if (!libs.VRMAnim || !libs.VRMAnim.createVRMAnimationClip || !st.vrm) return false
        const clip = await loadVRMAClip(u)
        st.mixer.stopAllAction()
        const act = st.mixer.clipAction(clip)
        const LOOP_ONCE = typeof THREE !== 'undefined' && THREE.LoopOnce !== undefined ? THREE.LoopOnce : 2200
        const LOOP_REP = typeof THREE !== 'undefined' && THREE.LoopRepeat !== undefined ? THREE.LoopRepeat : 2201
        const fi = Math.max(0.05, Math.min(0.5, Number(opt.fadeIn) || 0.25))
        if (opt.loop) {
          act.setLoop(LOOP_REP, Infinity)
          act.clampWhenFinished = false
        } else {
          act.setLoop(LOOP_ONCE, 1)
          act.clampWhenFinished = false
        }
        act.reset()
        act.fadeIn(fi)
        act.play()
        st.animHold = false
        st.rig = null
        // 0.45.77 单位修复：duration/fi 都是秒，now() 是毫秒（同 playPoolClip）
        if (!opt.loop) st.clipHold = { until: now() + (clip.duration || 1) * 1000 + fi * 1000 }
        return true
      },
      /** 0.45.52 待机池：预载一个 VRMA 待机进轮换池（fidget 插播时随机挑一条）。
       *  幂等（同 URL 只载一次）。返回 false=加载失败（文件坏/模型未就绪）。 */
      async registerIdleVrma (u) {
        try {
          if (!u || !st.alive || !libs.VRMAnim || !st.vrm || !st.mixer) return false
          if (!st.idleVrmaKeys) st.idleVrmaKeys = new Set()
          if (st.idleVrmaKeys.has(u)) return true
          const clip = await loadVRMAClip(u)
          // 0.45.54：VRMA 加载出来的 clip.name 统一叫 "Clip"，诊断日志分不清是哪一条，
          // 这里把文件名记到 clip 上（日志用 __srcName，不影响播放）
          try { clip.__srcName = decodeURIComponent(String(u).split('/').pop() || '').replace(/\.vrma$/i, '') } catch { }
          // 0.45.54 记幅度：待机池按幅度加权抽（呼吸 4.6° 排到后面，思考/看手机 130° 优先）
          try {
            clip.__amp = clipAmp(clip)
            diag('待机池 + ' + (clip.__srcName || '?') + '（幅度 ' + clip.__amp + '° · ' +
              Math.round(clip.duration || 0) + 's）')
          } catch { }
          if (!st.idleVrmas) st.idleVrmas = []
          st.idleVrmas.push(clip)
          st.idleVrmaKeys.add(u)
          return true
        } catch (e) { return false }
      },
      /** 当前在播的手势 id（没有就是 null） */
      get gesture () { return st.gesture },
      /** 说话口型开关（TTS 播放期间打开） */
      setTalk (on) { st.talk = !!on; if (!on) talkAmt = 0 },
      /** 直接驱动某个表情（happy / angry / sad / relaxed / surprised / blink / aa） */
      setExpression (name, v) { setExpr(name, Number(v) || 0) },
      /* 走动开关（主进程 pet:walk 广播）。
       * speed 是窗口平移速度 px/s，用来定步频——走得快步子迈得急，不会变成「滑冰」。
       * 有走路片段 → 片段交叉淡入；没有 → 由 poseIt 摆腿（模型加载完成前调用也不丢，状态留在 st.walk）。 */
      setWalk (on, dir, speed) {
        const w = st.walk
        w.on = !!on
        if (dir === 1 || dir === -1) w.dir = dir
        if (typeof speed === 'number' && isFinite(speed) && speed > 1) w.speed = speed
        if (st.mixer) {
          // 0.45.44：真 MMD 走路优先（motions/walk.vrma，setWalkMotion 预载）——
          // 走路观感的大头在步态，程序化正弦腿怎么调都是机器味。有 VRMA 就走
          // mixer 交叉淡入路线（与下面模型自带片段同款语义）；没有才程序化摆腿兜底。
          const vw = st.vrmaWalk
          const idleA = st.clipIdleAction
          if (vw && vw.act && idleA && idleA !== vw.act) {
            if (w.on) {
              // 坐姿/点播/手势的程序化接管先交还 mixer，再淡入走路
              if (st.rig || st.animHold || st.clipHold) releaseAnim()
              // 0.45.50 物理对齐步频（此前经验常数 speed/92 与动画步速不匹配 = 滑步）
              try { vw.act.timeScale = walkTimeScale(w.speed) } catch { }
              // 0.45.45：只有没在跑时才 reset+play——同一段溜达里主进程可能
              // 补发 setWalk(true)（换向/调速），无脑 reset 会把 clip 打回第一步
              let running = false
              try { running = vw.act.isRunning() } catch { }
              if (!running) {
                try { vw.act.reset(); vw.act.fadeIn(0.25); vw.act.play() } catch { }
                try { idleA.fadeOut(0.25) } catch { }
                try { (o.log || console.warn)('[vrm-stage] VRMA 步态接管') } catch { }
              }
            } else {
              try { vw.act.fadeOut(0.3) } catch { }
              try { idleA.reset(); idleA.fadeIn(0.3); idleA.play() } catch { }
            }
            return
          }
          // 0.32.1：走路回退程序化。官方 00010 是悠闲小碎步（大腿摆幅 ~8°），
          // 桌宠尺寸下步子几乎不可见 = 看着像单脚蹭地滑行；程序化步频跟速度联动、
          // 摆幅按「脚速=地面速度」反解（0.27-0.30 用户反馈走路观感更好）。
          // 起步 = holdAnim 接管；停走由 step() 的 animHold 释放条件自动交还官方 idle。
          if (w.on) {
            if (st.clipHold) releaseAnim()
            holdAnim()
          }
          return
        }
        const walkA = st.clipWalkAction
        const idleA = st.clipIdleAction
        if (!walkA || !idleA) return
        // 官方动画步幅大（~0.5m/步），桌面位移慢时把动画慢放，步频才不会跟位移脱节（像滑冰）
        try { walkA.timeScale = Math.max(0.5, Math.min(1.8, (w.speed || 52) / 92)) } catch {}
        const act = w.on ? walkA : idleA
        const off = w.on ? idleA : walkA
        try { if (typeof act.reset === 'function') act.reset() } catch {}
        try { if (typeof act.fadeIn === 'function') act.fadeIn(0.22) } catch {}
        try { if (typeof act.play === 'function') act.play() } catch {}
        try { if (typeof off.fadeOut === 'function') off.fadeOut(0.22) } catch {}
      },
      /** 程序化姿态是否可用（没 humanoid 的普通 GLB 为 false；调试/单测用） */
      get posed () { return !!st.rig },
      /** 0.45.45 诊断：walk.vrma 是否已预载进走路通道（宿主上报主日志用） */
      get walkMotionReady () { return !!(st.vrmaWalk && st.vrmaWalk.act) },
      /** 0.45.44 预载 motions/walk.vrma 进走路通道。0.45.45 补挂——之前它只是
       *  create() 内部的局部函数从没暴露到 handle 上，预载永远跳过 = 走路
       *  永远程序化（「走路没触发过」的真根因）。 */
      setWalkMotion (u) { return setWalkMotion(u) },
      /** 0.45.47 走路实证诊断：400ms 双采样原生/归一化骨骼的实际转角。
       *  离线模拟一切正常但真机帧拍出来是 A 字绑定点姿——必须知道应用内
       *  VRMA act 到底有没有把骨骼转起来。异步返回 JSON 可读对象。 */
      async walkDebug () {
        const grab = () => {
          const out = { norm: {}, raw: {} }
          try {
            const h = st.vrm && st.vrm.humanoid
            if (!h) return out
            for (const n of ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightLowerLeg', 'leftUpperArm']) {
              const nn = h.getNormalizedBoneNode && h.getNormalizedBoneNode(n)
              const rn = h.getRawBoneNode && h.getRawBoneNode(n)
              if (nn) out.norm[n] = [nn.quaternion.x.toFixed(3), nn.quaternion.y.toFixed(3), nn.quaternion.z.toFixed(3), nn.quaternion.w.toFixed(3)].join(',')
              if (rn) out.raw[n] = [rn.quaternion.x.toFixed(3), rn.quaternion.y.toFixed(3), rn.quaternion.z.toFixed(3), rn.quaternion.w.toFixed(3)].join(',')
            }
          } catch { }
          return out
        }
        const a = grab()
        await new Promise((ok) => setTimeout(ok, 400))
        const b = grab()
        const delta = (m1, m2) => {
          const d = {}
          for (const k in m1) {
            if (!m2[k]) continue
            const v1 = m1[k].split(','), v2 = m2[k].split(',')
            let s = 0
            for (let i = 0; i < 4; i++) s += Math.abs(parseFloat(v1[i]) - parseFloat(v2[i]))
            d[k] = s.toFixed(3)
          }
          return d
        }
        let act = '无'
        try {
          const vw = st.vrmaWalk && st.vrmaWalk.act
          act = vw ? ('running=' + vw.isRunning() + ' w=' + vw.getEffectiveWeight().toFixed(2) + ' t=' + vw.time.toFixed(2) + ' ts=' + vw.timeScale) : 'null'
        } catch { }
        return { walkOn: st.walk.on, animHold: st.animHold, rig: !!st.rig, act, normDelta: delta(a.norm, b.norm), rawDelta: delta(a.raw, b.raw) }
      },
      /** 手动重排取景（换装、改缩放后调用；尺寸没变也能强制重算） */
      refit () { lastW = 0; lastH = 0; fit() },
      dispose
    }

    handle.ready = new Promise((resolve, reject) => {
      let settled = false
      const fail = (e) => { if (settled) return; settled = true; st.error = e; reject(e) }
      try {
        // three-vrm 3.x 删掉了 VRM.from(gltf)，必须在 GLTFLoader 上注册 VRMLoaderPlugin，
        // 解析结果落在 gltf.userData.vrm。之前没注册 → 所有 VRM 都被当成普通 GLB：
        // 没有 humanoid（于是不会程序化走路，只剩平移）、没有表情、springBone 也不跑。
        const loader = new libs.GLTFLoader()
        if (libs.THREEVRM && libs.THREEVRM.VRMLoaderPlugin && typeof loader.register === 'function') {
          try { loader.register((parser) => new libs.THREEVRM.VRMLoaderPlugin(parser)) } catch { /* 老版本 three 没 register */ }
        }
        // 0.45.39 MMD 路线：VRMA 动画（vmd2vrma 离线转换产物）的解析插件
        if (libs.VRMAnim && libs.VRMAnim.VRMAnimationLoaderPlugin && typeof loader.register === 'function') {
          try { loader.register((parser) => new libs.VRMAnim.VRMAnimationLoaderPlugin(parser)) } catch { }
        }
        loader.load(
          o.url,
          async (gltf) => {
            if (!st.alive) return fail(new Error('已销毁'))
            try {
              let vrm = (gltf.userData && gltf.userData.vrm) || null
              if (!vrm && libs.THREEVRM && typeof libs.THREEVRM.VRM.from === 'function') {
                // 老版本 three-vrm（2.x）的兜底路径；不是 VRM 的 GLB 会 reject，降级成普通 glTF
                try { vrm = await libs.THREEVRM.VRM.from(gltf) } catch { vrm = null }
              }
              const root = (vrm && vrm.scene) || gltf.scene || (gltf.scenes && gltf.scenes[0])
              if (!root) throw new Error('模型里没有可用场景')
              st.vrm = vrm
              st.root = root
              /* 0.45.73 绑定姿势快照：此刻还没播任何动画，normalized 骨骼就是建模的
                 静止姿势。程序化坐姿/手势的 rest 与手臂下垂基准都从这里取，
                 免得「坐下时 rest 是半迈步」这种污染（详见 buildRig 注释）。 */
              try {
                if (vrm && vrm.humanoid && typeof vrm.humanoid.getNormalizedBoneNode === 'function') {
                  const rb = new Map()
                  const probe = {}
                  for (const n of BONES) {
                    let b = null
                    try { b = vrm.humanoid.getNormalizedBoneNode(n) } catch { b = null }
                    if (!b || !b.rotation) continue
                    rb.set(n, { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z })
                    probe[n] = b
                  }
                  if (rb.size) {
                    st.restBind = rb
                    st.droopBind = restDroop(probe)
                  }
                }
              } catch { }
              st.emo = (vrm && vrm.expressionManager) || null
              if (vrm) root.rotation.y = Math.PI // VRM 默认背对相机
              else if (o.ambient !== 0) scene.add(new THREE.AmbientLight(0xffffff, o.ambient || 0.6))
              scene.add(root)

              st.rootBaseY = root.position ? root.position.y : 0
      st.side = { amt: 0, dir: 1, base: root.rotation ? root.rotation.y : 0 }

              const clips = (gltf.animations || []).filter((c) => c && c.tracks && c.tracks.length)
              st.clips = clips
              if (clips.length) {
                const clip = clips.find((c) => IDLE_RE.test(String(c.name || ''))) || clips[0]
                const walkClip = clips.find((c) => WALK_RE.test(String(c.name || ''))) || null
                const runClip = clips.find((c) => /^run/i.test(String(c.name || ''))) || null
                try {
                  st.mixer = new THREE.AnimationMixer(root)
                  st.clip = clip
                  st.clipIdleAction = st.mixer.clipAction(clip)
                  if (st.clipIdleAction && typeof st.clipIdleAction.play === 'function') st.clipIdleAction.play()
                  // 模型自带走路片段（0.31.0 官方 g1a 烘入 / Mixamo 之类）就交叉淡入
                  if (walkClip && walkClip !== clip) {
                    st.walkClip = walkClip
                    st.clipWalkAction = st.mixer.clipAction(walkClip)
                  }
                  if (runClip && runClip !== clip && runClip !== walkClip) {
                    st.runClip = runClip
                    st.clipRunAction = st.mixer.clipAction(runClip)
                  }
                  // 0.32.1：待机基底是安静循环，长待机小彩蛋（idle_fidget）隔 45~90s 偶尔来一次
                  st.fidgetNext = now() + rand(30000, 60000)
                  // 0.31.0 关键：autoUpdateHumanBones 每帧把 normalized(=rest) 姿态拷回
                  // raw 骨骼，官方 clip（直绑 raw 骨骼）写进来的动画会被覆盖（腿永远
                  // 不动）。默认关掉。0.45.48 起 step() 每帧按「占优 act 的轨道套层」
                  // 声明式收敛：VRMA（Normalized_* 轨道）播放时自动打开，官方 clip 回落。
                  if (vrm && vrm.humanoid) vrm.humanoid.autoUpdateHumanBones = false
                } catch { st.mixer = null; st.clip = null; st.clipIdleAction = null }
              }
              // 只有「完全没有动画片段」时才程序化摆姿态，否则会和 mixer 抢骨骼
              if (!st.mixer) st.rig = buildRig()

              st.ready = true
              // 0.45.62 诊断：Chromium 是否把这个 overlay 误判成不可见（历史真凶嫌疑）
              try {
                diag('舞台就绪 · document.hidden=' + !!(global.document && global.document.hidden) +
                  ' · visibility=' + (global.document ? global.document.visibilityState : '?'))
              } catch { }
              fit()
              start()
              if (!settled) { settled = true; resolve(handle) }
            } catch (e) { fail(e) }
          },
          undefined,
          (e) => fail(e)
        )
      } catch (e) { fail(e) }
    })

    return handle
  }

  const api = { create, IDLE_RE }
  if (global) global.AuraVrm = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this))
