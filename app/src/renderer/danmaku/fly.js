'use strict'
/**
 * 飘的弹幕（0.38.0）
 *
 * 一条说完再出下一条：下一条要等上一条的尾巴滑过屏幕右侧 55% 才放，
 * 这样两条同时在场但不会叠在一起（参考项目管这个叫「剩余屏幕比例」）。
 * 位移按真实时间算（dt），掉帧时不会忽然加速。
 */
;(function () {
  const stage = document.getElementById('stage')
  const cfg = { fontSize: 30, speed: 1 }
  const queue = []
  const active = []
  let lastSpawnAt = 0
  let lastEl = null
  let lastTs = 0

  function lanes () {
    const laneH = Math.max(24, cfg.fontSize * 1.9)
    const usable = Math.max(laneH, window.innerHeight * 0.64)
    return Math.max(2, Math.min(12, Math.floor(usable / laneH) + 1))
  }

  function laneTop (i) {
    return Math.round(i * Math.max(24, cfg.fontSize * 1.9))
  }

  function spawn (text, now) {
    const n = lanes()
    let lane = -1
    for (let i = 0; i < n; i++) {
      const cur = active.find((a) => a.lane === i)
      // 上一条的尾巴已经滑过 55% 屏宽（或者这条跑道空着）
      if (!cur || cur.x + cur.w < window.innerWidth * 0.55) { lane = i; break }
    }
    if (lane < 0) return false

    const el = document.createElement('div')
    el.className = 'dk'
    el.textContent = text
    const size = cfg.fontSize
    el.style.fontSize = size + 'px'
    el.style.top = laneTop(lane) + 'px'
    el.style.transform = 'translate3d(' + window.innerWidth + 'px,0,0)'
    stage.appendChild(el)
    const w = el.getBoundingClientRect().width || text.length * size
    const item = {
      el,
      lane,
      w,
      x: window.innerWidth,
      // 整条滑完大约 13 秒（speed=1）；越快越难读，别给到 3 以上
      v: (window.innerWidth + w) / (13 / Math.max(0.4, Math.min(3, cfg.speed)))
    }
    active.push(item)
    lastEl = el
    lastSpawnAt = now
    return true
  }

  function tick (ts) {
    if (!lastTs) lastTs = ts
    const dt = Math.min(0.05, (ts - lastTs) / 1000)
    lastTs = ts
    // 说话是连续的：先尽量把队列放出去，再统一推一帧位移
    if (queue.length && ts - lastSpawnAt > 220) {
      spawn(queue[0], ts) && queue.shift()
    }
    for (let i = active.length - 1; i >= 0; i--) {
      const a = active[i]
      a.x -= a.v * dt
      a.el.style.transform = 'translate3d(' + a.x + 'px,0,0)'
      if (a.x + a.w < -40) {
        a.el.remove()
        active.splice(i, 1)
        if (lastEl === a.el) lastEl = null
      }
    }
    requestAnimationFrame(tick)
  }

  function apply (c) {
    if (!c) return
    if (c.fontSize) cfg.fontSize = Math.max(14, Math.min(64, Number(c.fontSize) || 30))
    if (c.speed) cfg.speed = Math.max(0.4, Math.min(3, Number(c.speed) || 1))
    document.documentElement.style.setProperty('--dk-size', cfg.fontSize + 'px')
  }

  window.dk.onConfig(apply)
  window.dk.onLines((lines) => {
    if (!Array.isArray(lines)) return
    for (const l of lines) {
      const t = String(l || '').trim()
      if (t) queue.push(t)
    }
    // 积压太多（她一次说很长一段）：只留最近 8 条，别让弹幕飘到下个世纪
    while (queue.length > 8) queue.shift()
  })
  // 译文补丁：正在飞的那条直接改字（气泡那边也是这个做法）
  window.dk.onReplace((t) => {
    const text = String(t || '').trim()
    if (!text) return
    const target = lastEl || (active.length ? active[active.length - 1].el : null)
    if (target) {
      target.textContent = text
      const a = active.find((x) => x.el === target)
      if (a) a.w = target.getBoundingClientRect().width || a.w
    }
  })

  requestAnimationFrame(tick)
})()
