/**
 * 形象包（API 2）渲染器 —— 伙伴舞台与装扮窗口共用
 *
 * 设计要点：
 *   - 声明式绘制：包只给「层 + 形状/图片 + 颜色引用」，不收执行任何脚本（对齐规格 6.3 的沙箱思路：
 *     第三方包不受信，最多只能放图和我们支持的形状，不能跑 JS）
 *   - 颜色引用在 main 的 pack.resolve 里已经折成具体色值（$变量 / c:slot-main 双色通道），
 *     这里只管画，不再理解变量名
 *   - canvas 用 alpha 掩码做热区（overlay 的像素级点击判定直接复用这张画布），
 *     所以图片必须 crossOrigin=anonymous，否则画布被污染 → getImageData 抛错 → 退化成整块矩形吃鼠标
 *   - 呼吸/摇摆/眨眼是程序化动画，包不用做序列帧：小尺寸伙伴最缺的就是「它是活的」这个感觉
 *   - 0.26.0 起再加一层「程序化姿态」：腿/臂/头/身分组绕关节旋转，
 *     走路有步态、动作词有姿态；包不写 part 也能动（按几何推断），写了更准
 */
(function (global) {
  'use strict'

  const imgCache = new Map() // src -> { img, ok, promise }
  const DEG = Math.PI / 180

  function loadImage (src) {
    const hit = imgCache.get(src)
    if (hit) return hit.promise
    const rec = { img: null, ok: false, promise: null }
    imgCache.set(src, rec)
    rec.promise = new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous' // 掩码采样需要干净画布
      img.onload = () => { rec.img = img; rec.ok = true; resolve(rec) }
      img.onerror = () => { rec.img = null; rec.ok = false; resolve(rec) }
      img.src = src
    })
    return rec.promise
  }

  /* ---------------- 程序化姿态：部位分组 ---------------- */

  const PART_KEYS = ['head', 'body', 'armL', 'armR', 'legL', 'legR']

  /**
   * 推断每个图层属于哪个部位。包显式写 part 的照写，其余按几何猜：
   *  - 窄高、底边贴地、中心在下半部 → 腿
   *  - 窄高、中心在中段、靠左右外缘 → 手臂
   *  - 中线以上 → 头（眼睛/嘴/头发都跟着头动）
   *  - 剩下的 → 身体（只做轻微压缩，绕脚底）
   * 猜错也只是某一层跟着一起歪一点，不会崩；包作者可以写 part 精调。
   */
  function inferParts (layers, size) {
    const map = new Map()
    const W = size[0] || 360
    const H = size[1] || 560
    // 只有一层：那就是整张图，归身体（只呼吸，不摇头晃整张）
    if (layers.length === 1 && !layers[0].part) { map.set(layers[0], 'body'); return map }
    const legCand = []
    const armCand = []
    for (const ly of layers) {
      if (ly.part && PART_KEYS.indexOf(ly.part) >= 0) { map.set(ly, ly.part); continue }
      if (!ly.w || !ly.h) continue
      const cx = (ly.x || 0) + ly.w / 2
      const cy = (ly.y || 0) + ly.h / 2
      const bottom = (ly.y || 0) + ly.h
      const narrow = ly.w <= W * 0.24
      const tall = ly.h >= H * 0.10
      if (narrow && tall && bottom >= H * 0.84 && cy >= H * 0.58) { legCand.push(ly); continue }
      if (narrow && tall && cy >= H * 0.3 && cy <= H * 0.8 && (cx <= W * 0.28 || cx >= W * 0.72)) { armCand.push(ly); continue }
    }
    for (const ly of legCand) {
      map.set(ly, ((ly.x || 0) + ly.w / 2) < W / 2 ? 'legL' : 'legR')
    }
    // 鞋/袜：竖直区间贴着腿、水平与腿重叠 → 跟同一条腿刚性一起转（否则脚会脱开）
    if (legCand.length) {
      let top = Infinity
      let bot = -Infinity
      for (const l of legCand) { top = Math.min(top, l.y || 0); bot = Math.max(bot, (l.y || 0) + l.h) }
      const span = Math.max(1, bot - top)
      for (const ly of layers) {
        if (map.has(ly) || !ly.w || !ly.h) continue
        const lyTop = ly.y || 0
        if (lyTop < top - span * 0.25 || lyTop > bot + span * 0.5) continue
        const lx = ly.x || 0
        const lr = lx + ly.w
        const side = (lx + ly.w / 2) < W / 2 ? 'legL' : 'legR'
        const leg = legCand.find((l) => (((l.x || 0) + l.w / 2) < W / 2 ? 'legL' : 'legR') === side)
        if (!leg) continue
        const ov = Math.min((leg.x || 0) + leg.w, lr) - Math.max(leg.x || 0, lx)
        if (ov > ly.w * 0.4) map.set(ly, side)
      }
    }
    for (const ly of armCand) {
      map.set(ly, ((ly.x || 0) + ly.w / 2) < W / 2 ? 'armL' : 'armR')
    }
    for (const ly of layers) {
      if (map.has(ly)) continue
      // 一整张立绘（几乎铺满画布的单层）：当身体，只呼吸不旋转 —— 绕脖子转头会把整张图甩飞
      if ((ly.w || 0) >= W * 0.6 && (ly.h || 0) >= H * 0.6) { map.set(ly, 'body'); continue }
      if (((ly.y || 0) + (ly.h || 0) / 2) <= H * 0.46) map.set(ly, 'head')
    }
    for (const ly of layers) if (!map.has(ly)) map.set(ly, 'body')
    return map
  }

  /** 每个部位的枢轴：腿/臂 = 顶端（髋/肩），头 = 底端（颈），身 = 底端（脚底）。包可用 pivot 覆盖 */
  function buildRig (layers, size) {
    const parts = inferParts(layers, size)
    const groups = new Map()
    for (const ly of layers) {
      const part = parts.get(ly) || 'body'
      let g = groups.get(part)
      if (!g) {
        g = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, pivot: null }
        groups.set(part, g)
      }
      const x = ly.x || 0
      const y = ly.y || 0
      const w = ly.w || 0
      const h = ly.h || 0
      g.x0 = Math.min(g.x0, x)
      g.y0 = Math.min(g.y0, y)
      g.x1 = Math.max(g.x1, x + w)
      g.y1 = Math.max(g.y1, y + h)
      if (ly.pivot && !g.pivot) g.pivot = [x + w * ly.pivot[0], y + h * ly.pivot[1]]
    }
    for (const [part, g] of groups) {
      if (g.pivot) continue
      const cx = (g.x0 + g.x1) / 2
      const hh = Math.max(1, g.y1 - g.y0)
      if (part === 'head' || part === 'body') g.pivot = [cx, g.y1]
      else g.pivot = [cx, g.y0 + hh * 0.04] // 臂/腿：顶端一点进身体，转起来不像断肢
    }
    return { parts, groups }
  }

  /* ---------------- 程序化姿态：动作表 ---------------- */

  /** 动作词 → 时长（秒）。名字对齐 pet.js 的 ACTION_SEMANTICS 词表 */
  const ACTIONS = {
    wave: 1.9,
    nod: 1.1,
    shake: 1.1,
    happy: 1.4,
    laugh: 1.4,
    jump: 0.9,
    dance: 2.6,
    sleep: 3.0,
    sad: 1.8,
    cry: 1.8,
    angry: 1.4,
    shy: 1.8,
    think: 1.8,
    blush: 1.5,
    sweat: 1.5,
    surprise: 1.0
  }

  function blankPose () {
    return {
      rootX: 0, rootY: 0, rootRot: 0, sx: 1, sy: 1,
      head: { rot: 0, x: 0, y: 0 },
      body: { rot: 0, sy: 1 },
      armL: { rot: 0 }, armR: { rot: 0 },
      legL: { rot: 0 }, legR: { rot: 0 }
    }
  }

  /**
   * 算出这一帧的姿态（纯函数，方便单测）。
   * @param {{time:number, walk?:number, dir?:number, act?:string, actP?:number}} st
   *   walk 0~1（起步/收步的淡入淡出）、dir -1/0/1、actP 0~1 动作进度
   */
  function poseAt (st) {
    const s = st || {}
    const t = s.time || 0
    const walk = Math.max(0, Math.min(1, s.walk || 0))
    const dir = s.dir || 0
    const p = blankPose()

    // 待机：呼吸（以脚底为锚点）+ 慢摆，别像被风吹的纸片
    p.sy = 1 + Math.sin(t / 2100) * 0.008
    p.rootRot = Math.sin(t / 4200) * 0.7

    // 走路：一步一颠，腿交替，手臂反相，朝行进方向前倾
    if (walk > 0.001) {
      const stepMs = Math.max(180, Math.min(700, s.stepMs || 380))
      const ph = (t / stepMs) * Math.PI * 2
      const sn = Math.sin(ph)
      p.legL.rot += -sn * 15 * walk
      p.legR.rot += sn * 15 * walk
      p.armL.rot += sn * 11 * walk
      p.armR.rot += -sn * 11 * walk
      p.rootY += -Math.abs(sn) * 3.2 * walk
      p.sy *= 1 + Math.cos(ph) * 0.012 * walk
      p.rootRot += dir * 3.5 * walk
      p.head.rot += sn * 1.6 * walk
    }

    // 动作：包络 sin(πq) 保证起收都平滑，不会突然弹一下
    const act = s.act
    if (act && ACTIONS[act]) {
      const q = Math.max(0, Math.min(1, s.actP || 0))
      const env = Math.sin(q * Math.PI)
      switch (act) {
        case 'wave': {
          // 先抬起 → 摆三下 → 放下
          const up = q < 0.22 ? q / 0.22 : (q > 0.82 ? Math.max(0, (1 - q) / 0.18) : 1)
          const swing = (q > 0.22 && q < 0.82) ? Math.sin(((q - 0.22) / 0.6) * Math.PI * 6) * 15 : 0
          p.armR.rot += (-140 + swing) * up
          p.head.rot += -3 * up
          break
        }
        case 'nod':
          p.head.rot += Math.sin(q * Math.PI * 4) * 9
          p.head.y += 2.5 * env
          break
        case 'shake':
          p.head.x += Math.sin(q * Math.PI * 6) * 5
          p.head.rot += Math.sin(q * Math.PI * 6) * 2.5
          break
        case 'happy':
        case 'laugh':
          p.rootY += -Math.sin(q * Math.PI) * 9
          p.armL.rot += 32 * env
          p.armR.rot += -32 * env
          p.head.rot += Math.sin(q * Math.PI * 3) * 5
          break
        case 'jump':
          p.rootY += -Math.sin(q * Math.PI) * 18
          p.armL.rot += 45 * env
          p.armR.rot += -45 * env
          break
        case 'dance':
          p.rootRot += Math.sin(q * Math.PI * 4) * 8
          p.rootY += -Math.abs(Math.sin(q * Math.PI * 4)) * 5
          p.legL.rot += -Math.sin(q * Math.PI * 4) * 13
          p.legR.rot += Math.sin(q * Math.PI * 4) * 13
          p.armL.rot += 30 + Math.sin(q * Math.PI * 4) * 25
          p.armR.rot += -30 - Math.sin(q * Math.PI * 4) * 25
          break
        case 'sleep':
          p.head.rot += 13 * env
          p.rootY += 6 * env
          p.sy *= 1 - 0.025 * env
          p.armL.rot += 5 * env
          p.armR.rot += -5 * env
          break
        case 'sad':
        case 'cry':
          p.head.rot += 10 * env
          p.rootY += 4 * env
          p.head.y += 2 * env
          p.armL.rot += 6 * env
          p.armR.rot += -6 * env
          if (act === 'cry') p.head.y += Math.sin(q * Math.PI * 8) * 1.5
          break
        case 'angry':
          p.rootX += Math.sin(q * Math.PI * 10) * 1.6
          p.head.rot += -4 * env
          p.armL.rot += 12 * env
          p.armR.rot += -12 * env
          break
        case 'shy':
          p.head.rot += 7 * env
          p.head.y += 3 * env
          p.rootRot += Math.sin(q * Math.PI * 2) * 2
          break
        case 'think':
          p.head.rot += -7 * env
          p.head.x += 2 * env
          p.armR.rot += -55 * env
          break
        case 'blush':
          p.head.rot += 5 * env
          p.head.y += 1.5 * env
          break
        case 'sweat':
          p.head.rot += -3 * env
          p.rootX += Math.sin(q * Math.PI * 6) * 1.2
          break
        case 'surprise':
          p.rootY += -Math.sin(q * Math.PI) * 10
          p.head.rot += -5 * env
          p.armL.rot += 22 * env
          p.armR.rot += -22 * env
          break
      }
    }
    return p
  }

  /* ---------------- 编译 / 预载 ---------------- */

  /** 口型：从 `part:'mouth'` 的层里挑开口度最接近当前值的一张（0.41.0）
   *  包可以只给「闭 / 半开 / 大张」三张，也可以每帧一张；没给就是没有口型能力。 */
  function pickMouth (mouth, open) {
    if (!Array.isArray(mouth) || !mouth.length) return null
    const v = Math.max(0, Math.min(1, Number(open) || 0))
    let best = mouth[0]
    let bestD = Infinity
    for (const ly of mouth) {
      const d = Math.abs((typeof ly.open === 'number' ? ly.open : 0) - v)
      if (d < bestD) { bestD = d; best = ly }
    }
    return best
  }

  /**
   * needs（0.41.0）：包对宿主的要求。以前只能靠 size 猜，导致同一套图在
   * 高 DPI / 窄舞台上要么被压扁要么被放大糊掉。
   *   needs.facing  'left'|'right' —— 立绘默认朝向；走路时按 dir 决定要不要水平镜像
   *   needs.views   ['front','side'] —— 声明自己带哪几个视角（带 side 才会做侧身走）
   *   needs.stage   [w,h] —— 希望的最小绘制尺寸（px），小于它时不再等比缩小（宁可裁边）
   *   needs.anchor  'bottom'|'center'
   */
  function normNeeds (n, size) {
    const o = n && typeof n === 'object' ? n : {}
    const stage = Array.isArray(o.stage) && o.stage.length === 2 && o.stage.every((x) => Number(x) > 0)
      ? [Number(o.stage[0]), Number(o.stage[1])]
      : null
    return {
      facing: o.facing === 'left' ? 'left' : 'right',
      views: Array.isArray(o.views) ? o.views.filter((v) => v === 'front' || v === 'side') : ['front'],
      stage,
      anchor: o.anchor === 'center' ? 'center' : 'bottom',
      size
    }
  }

  function compileSet (raw, size, zKey) {
    const layers = raw.slice().sort((a, b) => (a.z || 0) - (b.z || 0))
    return {
      size,
      layers,
      rig: buildRig(layers, size),
      mouth: layers.filter((l) => l.part === 'mouth' && typeof l.open === 'number')
    }
  }

  function compile (payload) {
    if (!payload || !Array.isArray(payload.layers)) return null
    const size = Array.isArray(payload.size) && payload.size.length === 2 ? payload.size : [360, 560]
    const needs = normNeeds(payload.needs, size)
    const base = compileSet(payload.layers, size)
    const sideRaw = payload.views && payload.views.side && Array.isArray(payload.views.side.layers)
      ? payload.views.side.layers
      : null
    const side = sideRaw && sideRaw.length ? compileSet(sideRaw, size) : null
    return {
      id: payload.id || '',
      name: payload.name || '',
      size,
      needs,
      layers: base.layers,
      rig: base.rig,
      mouth: base.mouth,
      side,
      // 声明了 side 才认为有侧身走（省得每帧判断 layers 存不存在）
      hasSide: !!(side && needs.views.includes('side'))
    }
  }

  function preload (payload) {
    const c = compile(payload)
    if (!c) return Promise.resolve(null)
    const all = c.side ? c.layers.concat(c.side.layers) : c.layers
    const jobs = all.filter((l) => l.type === 'image' && l.src).map((l) => loadImage(l.src))
    return Promise.all(jobs).then(() => c)
  }

  function colorOf (v, fallback) {
    if (!v) return fallback
    if (typeof v === 'string') return v
    return v.value || fallback
  }

  /** 建路径（不填不描，交给调用方决定）—— 描边形状（眼镜/细线）必须能单独 stroke */
  function buildPath (ctx, ly, w, h) {
    ctx.beginPath()
    if (ly.shape === 'rect') {
      const r = Math.max(0, Math.min(ly.rx || 0, Math.min(w, h) / 2))
      if (r > 0 && ctx.roundRect) ctx.roundRect(0, 0, w, h, r)
      else ctx.rect(0, 0, w, h)
      return true
    }
    if (ly.shape === 'path' && ly.d) {
      // 包里的 path 用逻辑坐标写，按层尺寸等比缩放
      const sx = w / (ly.w || 1)
      const sy = h / (ly.h || 1)
      try {
        const p = new Path2D(ly.d)
        ctx.save()
        ctx.scale(sx, sy)
        ctx.addPath ? ctx.addPath(p) : null
        ctx.restore()
      } catch { return false }
      return true
    }
    ctx.ellipse(w / 2, h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2)
    return true
  }

  function paintShape (ctx, ly, w, h, scale) {
    if (!buildPath(ctx, ly, w, h)) return
    if (ly.fill) {
      ctx.fillStyle = colorOf(ly.fill, 'transparent')
      ctx.fill()
    }
    if (ly.stroke && ly.strokeWidth) {
      ctx.lineWidth = Math.max(0.4, ly.strokeWidth * (scale || 1))
      ctx.strokeStyle = colorOf(ly.stroke, '#000')
      ctx.stroke()
    }
  }

  /* ---------------- 绘制 ---------------- */

  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

  /** 侧身朝向：dir<0 往左走。包声明 facing 后，朝错方向就镜像 */
  function flipFor (dir, needs) {
    if (!dir) return 1
    const want = dir < 0 ? 'left' : 'right'
    return needs && needs.facing === want ? 1 : -1
  }

  /**
   * 画一整套层（正脸或侧身）。
   * @param {object} set { layers, rig, mouth } —— compileSet 的结果
   * @param {number} alpha 整组透明度（侧身走时和正脸交叉淡入）
   * @param {number} flip  1 原样 / -1 水平镜像
   */
  function paintSet (ctx, set, o, alpha, flip) {
    const W = o.w
    const H = o.h
    const t = o.time || 0
    const layers = set.layers
    if (!layers) return

    // contain + 底部对齐：不同尺寸的包都站在同一条地平线上
    const size = set.size || [360, 560]
    const s = Math.min(W / size[0], H / size[1])
    const ox = (W - size[0] * s) / 2
    const oy = H - size[1] * s

    const pose = poseAt({ time: t, walk: o.walk, dir: o.dir, act: o.act, actP: o.actP })
    const rig = set.rig || buildRig(layers, size)
    const mouthLayer = pickMouth(set.mouth, o.talk)

    ctx.save()
    ctx.globalAlpha = 1
    if (flip === -1) { ctx.translate(W / 2, 0); ctx.scale(-1, 1); ctx.translate(-W / 2, 0) }
    // 整体：以脚底为锚点做上下/倾斜/呼吸压缩（先平移到脚底，再缩放，角色才从地面往上长）
    ctx.translate(W / 2 + pose.rootX * s, H + pose.rootY * s)
    ctx.rotate(pose.rootRot * DEG)
    ctx.scale(pose.sx, pose.sy)
    ctx.translate(-W / 2, -H)

    for (const ly of layers) {
      // 口型：只画开口度最接近当前值的那一张
      if (ly.part === 'mouth' && typeof ly.open === 'number' && ly !== mouthLayer) continue
      if (ly.blink === 'closed' && !o.blink) continue
      if (ly.blink === 'open' && o.blink) continue
      ctx.save()
      const x = ox + (ly.x || 0) * s
      const y = oy + (ly.y || 0) * s
      const w = (ly.w || 0) * s
      const h = (ly.h || 0) * s
      ctx.globalAlpha = (ly.opacity == null ? 1 : ly.opacity) * alpha

      // 部位姿态：绕该部位的关节（髋/肩/颈/脚底）旋转，同组图层共用同一个关节
      const part = rig.parts.get(ly)
      if (part) {
        const g = rig.groups.get(part)
        let rot = 0
        let dx = 0
        let dy = 0
        let psy = 1
        if (part === 'head') { rot = pose.head.rot; dx = pose.head.x; dy = pose.head.y } else if (part === 'body') { rot = pose.body.rot; psy = pose.body.sy } else if (part === 'armL') rot = pose.armL.rot
        else if (part === 'armR') rot = pose.armR.rot
        else if (part === 'legL') rot = pose.legL.rot
        else if (part === 'legR') rot = pose.legR.rot
        if (g && (rot !== 0 || dx !== 0 || dy !== 0 || psy !== 1)) {
          const pvx = ox + g.pivot[0] * s
          const pvy = oy + g.pivot[1] * s
          ctx.translate(pvx + dx * s, pvy + dy * s)
          if (rot !== 0) ctx.rotate(rot * DEG)
          if (psy !== 1) ctx.scale(1, psy)
          ctx.translate(-pvx, -pvy)
        }
      }

      if (ly.rotate) {
        ctx.translate(x + w / 2, y + h / 2)
        ctx.rotate((ly.rotate * Math.PI) / 180)
        ctx.translate(-w / 2, -h / 2)
      } else {
        ctx.translate(x, y)
      }
      if (w <= 0 || h <= 0) { ctx.restore(); continue }

      if (ly.type === 'image') {
        const rec = imgCache.get(ly.src)
        if (!rec || !rec.ok || !rec.img) { ctx.restore(); continue }
        if (ly.tint) {
          // 着色：先画到临时层 → source-in 用色值覆盖 → 再按 alpha 叠回去
          // （直接 multiply 会让浅色配件变脏，source-in 得到干净的纯色剪影）
          ctx.drawImage(rec.img, 0, 0, w, h)
          ctx.globalCompositeOperation = 'source-in'
          ctx.globalAlpha = (ly.opacity == null ? 1 : ly.opacity) * (ly.tintAlpha == null ? 1 : ly.tintAlpha) * alpha
          ctx.fillStyle = colorOf(ly.tint, '#888')
          ctx.fillRect(0, 0, w, h)
          ctx.globalCompositeOperation = 'source-over'
        } else {
          ctx.drawImage(rec.img, 0, 0, w, h)
        }
      } else {
        paintShape(ctx, ly, w, h, s)
      }
      ctx.restore()
    }
    ctx.restore()
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} c compile() 的结果
   * @param {{w:number,h:number,time:number,blink:boolean,walk?:number,dir?:number,act?:string,actP?:number,
   *          side?:number,talk?:number}} o
   *   side 0~1：侧身占比（走路时由常驻循环给），talk 0~1：口型开口度
   */
  function draw (ctx, c, o) {
    if (!ctx || !c) return
    const W = o.w
    const H = o.h
    if (!W || !H) return
    ctx.clearRect(0, 0, W, H)
    // 侧身走：没有 side 层就永远是正脸（老包照旧能用）
    const sideAmt = c.hasSide ? clamp01(o.side) : 0
    if (sideAmt < 0.999) paintSet(ctx, c, o, 1 - sideAmt, 1)
    if (sideAmt > 0.001 && c.side) paintSet(ctx, c.side, o, sideAmt, flipFor(o.dir, c.needs))
  }

  /* ---------------- 常驻循环 ---------------- */

  /**
   * 起一个常驻绘制循环。用 setInterval 而不是 rAF：
   * 桌面层是置底透明窗口，被覆盖时 Chromium 会暂停 BeginFrame → rAF 冻结（渲染循环早有这条教训）
   * @returns {{ stop:()=>void, update:(payload)=>Promise<void>, canvas:HTMLCanvasElement,
   *            setWalk:(on:boolean,dir?:number)=>void, play:(name:string)=>number, act:()=>string|null }}
   */
  function startLoop (canvas, payload, opts) {
    const opt = opts || {}
    let cur = compile(payload)
    let timer = null
    let stopped = false
    let blinkUntil = 0
    let nextBlink = 0
    // 走动：目标值 0/1，用 120ms 时间常数淡入淡出（突然切会让第一步很生硬）
    let walkOn = false
    let walkDir = 1
    let walkAmt = 0
    let walkStepMs = 380 // 一步的时长：按「步幅 ÷ 速度」估（活跃档 105px/s 时约 290ms）
    // 动作：一次只播一个，新的顶掉旧的
    let actName = null
    let actT0 = 0
    let actDur = 0
    // 0.41.0 口型：TTS 说话期间给个呼吸式的开合（包里画了 part:'mouth' 才有用）
    let talkOn = false
    let talkAmt = 0
    let talkPhase = 0
    let lastTick = Date.now()
    const t0 = Date.now()
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true })

    function size () {
      const dpr = Math.min(2, global.devicePixelRatio || 1)
      const cw = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const ch = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw
        canvas.height = ch
      }
      return { w: cw, h: ch }
    }

    function tick () {
      if (stopped || !cur) return
      const { w, h } = size()
      const now = Date.now()
      const dt = Math.min(200, Math.max(0, now - lastTick))
      lastTick = now
      // 走动强度淡入淡出
      const target = walkOn ? 1 : 0
      if (walkAmt !== target) {
        walkAmt += (target - walkAmt) * Math.min(1, dt / 120)
        if (Math.abs(walkAmt - target) < 0.01) walkAmt = target
      }
      // 眨眼：4~8 秒一次，闭眼 130ms；没有闭眼层的包自然不受影响
      if (!nextBlink) nextBlink = now + 2500 + Math.random() * 3000
      if (now > nextBlink && !blinkUntil) {
        blinkUntil = now + 130
        nextBlink = now + 4000 + Math.random() * 5000
      }
      const blink = !!blinkUntil && now < blinkUntil
      if (blinkUntil && now >= blinkUntil) blinkUntil = 0
      // 口型开合：两段不同周期的正弦相乘，避免「机械等距张嘴」的节拍感
      if (talkOn) {
        talkPhase += dt
        const w1 = Math.sin(talkPhase * 0.019)
        const w2 = Math.sin(talkPhase * 0.0073 + 1.7)
        talkAmt += ((0.5 + 0.5 * w1 * (0.55 + 0.45 * w2)) - talkAmt) * Math.min(1, dt / 45)
      } else if (talkAmt > 0.001) {
        talkAmt += (0 - talkAmt) * Math.min(1, dt / 90)
        if (talkAmt < 0.002) talkAmt = 0
      }
      // 动作进度（到点自动回待机）
      let actP = 0
      if (actName) {
        actP = (now - actT0) / (actDur * 1000)
        if (actP >= 1) { actName = null; actP = 0 }
      }
      try {
        draw(ctx, cur, {
          w, h, time: now - t0, blink, walk: walkAmt, dir: walkDir, act: actName, actP, stepMs: walkStepMs,
          side: walkAmt, talk: talkAmt
        })
      } catch { /* 单帧失败不打断循环 */ }
    }

    timer = setInterval(tick, opt.interval || 50)
    tick()
    // 尺寸变化（缩放设置 / 窗口 resize）立刻重画，别等下一帧
    const ro = global.ResizeObserver ? new global.ResizeObserver(() => tick()) : null
    if (ro) { try { ro.observe(canvas) } catch {} }

    return {
      canvas,
      stop () {
        stopped = true
        clearInterval(timer)
        timer = null
        if (ro) { try { ro.disconnect() } catch {} }
      },
      async update (next) {
        const c = await preload(next)
        if (stopped) return
        cur = c
        tick()
      },
      /** 说话口型开关（0.41.0）：包里画了 part:'mouth' + open 的层才会动 */
      setTalk (on) { talkOn = !!on; if (!on) talkPhase = 0 },
      /** 走动开关（主进程 pet:walk 广播）。speed 是 px/s，用来定步频 */
      setWalk (on, dir, speed) {
        walkOn = !!on
        if (dir === 1 || dir === -1) walkDir = dir
        const v = Number(speed)
        if (Number.isFinite(v) && v > 5) walkStepMs = Math.max(180, Math.min(700, (30 / v) * 1000))
      },
      /** 播一个动作词，返回时长（秒）；不认识的词返回 0（调用方自己决定要不要兜底） */
      play (name) {
        const key = String(name || '').trim()
        if (!ACTIONS[key]) return 0
        actName = key
        actT0 = Date.now()
        actDur = ACTIONS[key]
        return actDur
      },
      act () { return actName }
    }
  }

  global.AuraFigure = {
    compile, preload, draw, startLoop, loadImage,
    // 供单测与调试
    poseAt, inferParts, buildRig, ACTIONS,
    pickMouth, normNeeds, flipFor,
    hasAction: (name) => !!ACTIONS[String(name || '').trim()]
  }
})(typeof window !== 'undefined' ? window : globalThis)
