/* 官方动画选池（0.41.0）
 *
 * 369 个 gust_* 是游戏里的全套角色动画，名字只有编号，没有语义。tools/anim-classify.js
 * 读骨骼轨迹给每个 clip 打了标签（pose = 站/坐/蹲/躺，tags = jump/wave/armsUp/...），
 * 生成 anim-catalog.js。这里把「动作词 → 标签」翻成「挑一个具体编号」。
 *
 * 只挑不演：真的播放还是走 vrm-stage.playClip(name)。
 * 纯函数，不碰 DOM，所以能单测（test/anim-pool.test.js）。
 */
;(function (root) {
  'use strict'

  /* 每个池都是「硬门槛 + 打分」：
   *   门槛先把明显不对的 clip 挡在外面（比如躺下池里 upright 必须<0.15，微弯腰不要）；
   *   打分只决定同一池里谁更靠前，不做secondary筛选。
   * minDur / maxDur 用秒：短于 1s 的多是受击/腾空半帧，当动作词播会像抽帧。 */
  const POOLS = {
    lie: { pose: 'lie', minDur: 1.5, score: (m) => -m.upright },
    sit: { pose: 'sit', minDur: 1.2, score: (m) => -m.hipLevel },
    crouch: { pose: 'crouch', minDur: 0.8, score: (m) => -m.hipLevel },
    jump: { tag: 'jump', maxDur: 2.6, score: (m) => -m.air },
    wave: { tag: 'wave', pose: 'stand', minDur: 1.0, score: (m) => m.swingAmp },
    armsUp: { tag: 'armsUp', pose: 'stand', minDur: 1.0, score: (m) => m.handUp },
    step: { tag: 'step', pose: 'stand', maxDur: 2.0, score: (m) => m.stride },
    turn: { tag: 'turn', pose: 'stand', minDur: 1.0, score: (m) => m.yaw },
    still: { tag: 'still', pose: 'stand', minDur: 1.5, score: (m) => -m.energy }
  }

  function matches (rule, m) {
    if (!m) return false
    if (rule.pose && m.pose !== rule.pose) return false
    if (rule.tag && !(m.tags || []).includes(rule.tag)) return false
    if (rule.minDur && !(m.dur >= rule.minDur)) return false
    if (rule.maxDur && !(m.dur <= rule.maxDur)) return false
    return true
  }

  /** 池里全部候选，按分数从优到劣（导出给测试/调试用） */
  function list (name, catalog) {
    const rule = POOLS[name]
    if (!rule || !catalog || !catalog.clips) return []
    const rows = []
    for (const [clip, m] of Object.entries(catalog.clips)) {
      if (!matches(rule, m)) continue
      const s = typeof rule.score === 'function' ? Number(rule.score(m)) : 0
      rows.push([clip, isFinite(s) ? s : 0])
    }
    rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    return rows.map((r) => r[0])
  }

  /**
   * 从池里挑一个。opts:
   *   catalog  必填，anim-catalog.js 的数据
   *   avoid    最近播过的名字数组，尽量跳过（池子大时才生效）
   *   top      只在最靠前的 N 个里随机（默认 4，避免永远是同一个）
   *   rng      0~1 的随机数来源，测试可注入
   */
  function pick (name, opts) {
    opts = opts || {}
    const all = list(name, opts.catalog)
    if (!all.length) return null
    const top = Math.max(1, Math.min(Number(opts.top) || 4, all.length))
    const avoid = new Set(opts.avoid || [])
    const head = all.slice(0, top)
    const fresh = head.filter((c) => !avoid.has(c))
    const pool = fresh.length ? fresh : head
    const r = typeof opts.rng === 'function' ? opts.rng() : Math.random()
    return pool[Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length)))]
  }

  const api = { POOLS, list, pick, matches }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.AuraAnimPool = api
})(typeof window !== 'undefined' ? window : null)
