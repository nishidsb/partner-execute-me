'use strict'
/**
 * 陪看字幕（0.34.0）· 编排层
 *
 * 一条链：框一条字幕带 → 每 1.2 秒抓一帧 → 本地 OCR 读成一行字 → 断句定稿 → 进白板游标
 *        → 每一轮说话时拼进 system prompt。
 *
 * 为什么要有它：她的模型是 deepseek-flash，**没有视觉**。原来的「看屏陪伴」是截图喂视觉模型，
 * 在这套配置下必然 400。但看片的时候屏幕上本来就有字幕 —— 把字幕读成文字，
 * 既不需要视觉模型，也不花一个图片 token，而且比看图更容易守住人设语气。
 *
 * 边界（别指望它）：
 *   · 只认**画在屏幕上的字幕**（番剧硬字幕、播放器外挂字幕都行）—— 打游戏没有字幕，这条路不管；
 *   · 全屏抓一次要 1 秒，所以必须框一条窄带（600×80 只要几十毫秒）；
 *   · 抓帧时她会从截图里被摘掉（见她自己的气泡被当台词读就不是陪看了）。
 */
const path = require('node:path')
const { app } = require('electron')
const ocr = require('./ocr')
const capture = require('./capture')
const { createSegmenter } = require('./segment')
const { createBoard } = require('./board')

const DEFAULT_INTERVAL = 1200
const MIN_INTERVAL = 600
const MAX_INTERVAL = 4000

function create ({ cfgGet, log = () => { } }) {
  const board = createBoard()
  const seg = createSegmenter()
  let timer = null
  let busy = false
  let ticks = 0
  let hits = 0
  let blanks = 0
  let errors = 0
  let lastText = ''
  let lastAt = 0
  let lastMs = 0
  let lastError = ''
  let excluded = false

  const srcDir = path.join(__dirname, '..', '..', '..', '..', 'resources', 'screen')
  // 脚本/模型拷到这（asar 里的东西 python 读不了）
  const home = () => path.join(app.getPath('userData'), 'screen-text')
  // 复用本地转写那套 venv（onnxruntime/numpy 都在里面），不另建第二个环境
  const venvHome = () => path.join(app.getPath('userData'), 'bili-duty')

  function conf () {
    const c = cfgGet() || {}
    return {
      on: !!c.screenTextOn,
      rect: c.screenTextRect && Number(c.screenTextRect.w) > 8 ? c.screenTextRect : null,
      interval: Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, Number(c.screenTextInterval) || DEFAULT_INTERVAL)),
      hideSelf: c.screenTextHideSelf !== false
    }
  }

  async function tick () {
    const c = conf()
    if (!c.on || !c.rect || busy) return
    busy = true
    ticks += 1
    try {
      const shot = await capture.grabRegion(c.rect)
      if (!shot.ok) {
        if (shot.error !== lastError) log('[screentext] ' + shot.error)
        lastError = shot.error
        errors += 1
        return
      }
      const r = await ocr.readFrame({ home: home(), venvHome: venvHome(), srcDir, bgra: shot.bgra, w: shot.w, h: shot.h, log })
      if (!r.ok) {
        // python 起不来（venv 没装 onnxruntime 之类）：别每帧刷日志，也别一直重试打爆 CPU
        if (r.error !== lastError) log('[screentext] OCR 不可用：' + r.error)
        lastError = String(r.error || '')
        errors += 1
        if (errors > 5) stop('OCR 连续失败，先停下')
        return
      }
      lastError = ''
      lastMs = r.ms
      const text = String(r.text || '').trim()
      if (!text) {
        blanks += 1
        // 没字也要喂给断句器：字幕消失正是「该定稿」的信号
      }
      const done = seg.feed(text)
      if (text) lastText = text
      if (done) {
        hits += 1
        lastAt = Date.now()
        board.add(done, lastAt)
        log('[screentext] 定稿：' + done.slice(0, 40))
      }
    } catch (err) {
      lastError = String(err && err.message)
      errors += 1
      log('[screentext] 出错：' + lastError)
    } finally {
      busy = false
    }
  }

  function start () {
    const c = conf()
    if (!c.rect) return { ok: false, error: '还没框字幕区 —— 先点「框字幕」，把屏幕上那一行字幕框住' }
    if (timer) return { ok: true, already: true }
    board.reset()
    seg.reset()
    errors = 0
    if (c.hideSelf) {
      try { capture.excludeSelf(true); excluded = true } catch { }
    }
    // 先把模型读进内存，第一帧就不用等 0.9 秒
    ocr.warm({ home: home(), venvHome: venvHome(), srcDir, log }).then((r) => {
      if (!r.ok) { lastError = String(r.error || '本地识别环境没装好'); log('[screentext] 预热失败：' + lastError) }
    })
    timer = setInterval(tick, c.interval)
    try { timer.unref && timer.unref() } catch { }
    log('[screentext] 开始陪看：框 ' + JSON.stringify(c.rect) + ' 间隔 ' + c.interval + 'ms')
    return { ok: true }
  }

  function stop (why) {
    if (timer) { clearInterval(timer); timer = null }
    const flushed = seg.flush()
    if (flushed) board.add(flushed, Date.now())
    if (excluded) {
      try { capture.excludeSelf(false) } catch { }
      excluded = false
    }
    const lost = board.reset()
    seg.reset()
    ocr.stop()
    log('[screentext] 停止陪看（' + (why || '手动') + '），清掉 ' + lost + ' 句没发出去的')
    return { ok: true, dropped: lost }
  }

  /** 给 session 的白板取词（没新字幕返回空串） */
  function render () {
    if (!timer) return ''
    return board.render(Date.now())
  }

  /** 一轮真答完了才推进游标 */
  function commit () {
    if (!timer) return
    board.commit()
  }

  function status () {
    const c = conf()
    return {
      on: !!timer,
      enabled: c.on,
      rect: c.rect,
      interval: c.interval,
      hideSelf: c.hideSelf,
      ticks,
      hits,
      blanks,
      errors,
      lastText,
      lastAt,
      lastMs,
      error: lastError,
      ocr: ocr.status(),
      board: board.stats(),
      pending: board.stats().pending
    }
  }

  /** 只留最近一次的读数（设置页显示「现在读到什么」用） */
  function peek () {
    return { text: lastText, at: lastAt, ms: lastMs, error: lastError }
  }

  /**
   * 一次性读一帧（设置页「试一下」用）：不进白板、不动游标。
   * 框选完先按这个，能读出字才说明框对了。
   */
  async function once () {
    const c = conf()
    if (!c.rect) return { ok: false, error: '还没框字幕区 —— 先拖一个框把字幕那一行圈住' }
    const needHide = c.hideSelf && !excluded
    if (needHide) { try { capture.excludeSelf(true) } catch { } }
    try {
      const shot = await capture.grabRegion(c.rect)
      if (!shot.ok) return shot
      const r = await ocr.readFrame({ home: home(), venvHome: venvHome(), srcDir, bgra: shot.bgra, w: shot.w, h: shot.h, log })
      if (!r.ok) return r
      const text = String(r.text || '')
      lastText = text
      lastMs = r.ms
      if (text) lastAt = Date.now()
      return { ok: true, text, lines: r.lines, ms: r.ms, w: shot.w, h: shot.h }
    } finally {
      if (needHide && !timer) { try { capture.excludeSelf(false) } catch { } }
    }
  }

  return { start, stop, render, commit, status, peek, once, tick }
}

module.exports = { create, DEFAULT_INTERVAL }
