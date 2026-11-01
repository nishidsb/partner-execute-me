'use strict'
/**
 * 流式上屏的打字机手感（0.45.14）
 *
 * 以前的 onDelta 是「收到就整段重写」：LLM 一口气吐 200 字，聊天框啪一下全出来，
 * 像系统报文不像说话。这里加一个排出队列：
 *  - 首段立即上屏（等第一个字最影响体感，收到多少先出多少，最多 12 字）
 *  - 之后按帧小步排出（每步 2~4 字），句末标点（。！？…」）后多停一拍，像换气
 *  - finish(final) 结束：没排完的直接补完（最终内容以它为准，防截断）
 *  - reset() 新一轮：丢弃未排完的残段
 *
 * 用法：
 *   const tw = RyzaTyper.create({ setText: (t) => el.textContent = t })
 *   tw.push(text)        // onDelta 里
 *   tw.finish(finalText) // onDone 里
 *   tw.reset()           // reset/seq 变化时
 */
;(function (w) {
  const STEP_MS = 18          // 普通步进间隔
  const PAUSE_MS = 110        // 句末标点后的换气
  const COMMA_MS = 45         // 逗号级的小顿
  const FIRST_BURST = 12      // 首段一次性出的字数上限
  const TAIL = /[。！？!?…」』】）》.?!]$/
  const SOFT = /[，,、；;：:—」』】）》]/

  function create (opts) {
    const setText = (opts && opts.setText) || function () {}
    let typed = ''      // 已经排出的
    let buf = ''        // 待排的
    let timer = null
    let finished = false

    function pump () {
      timer = null
      if (finished) return
      if (!buf.length) return
      // 本步取几个字：标点后小步，普通 2~3
      const justTyped = typed.slice(-1)
      let take = TAIL.test(justTyped) ? 1 : (SOFT.test(justTyped) ? 2 : 3)
      const piece = buf.slice(0, take)
      buf = buf.slice(take)
      typed += piece
      setText(typed)
      if (!buf.length) return           // 追平了，等下一个 push
      const delay = TAIL.test(piece) ? PAUSE_MS : (SOFT.test(piece) ? COMMA_MS : STEP_MS)
      timer = setTimeout(pump, delay)
    }

    return {
      push (text) {
        if (finished) return
        buf += String(text || '')
        // 冷启动：一个字都没有时先立即出第一口（最多 FIRST_BURST），别让人干等
        if (!typed.length && buf.length) {
          const head = buf.slice(0, FIRST_BURST)
          buf = buf.slice(head.length)
          typed = head
          setText(typed)
        }
        if (!timer && buf.length) timer = setTimeout(pump, STEP_MS)
      },
      /** 生成结束。final 为最终全文（含 display 覆盖），直接补完上屏。 */
      finish (final) {
        finished = true
        if (timer) { clearTimeout(timer); timer = null }
        const out = (final != null && final !== '') ? String(final) : (typed + buf)
        typed = out
        buf = ''
        setText(out)
      },
      /** 新一轮：全部丢掉 */
      reset () {
        finished = false
        if (timer) { clearTimeout(timer); timer = null }
        typed = ''
        buf = ''
        setText('')
      },
      get text () { return typed }
    }
  }

  w.RyzaTyper = { create, STEP_MS, PAUSE_MS }
})(window)
