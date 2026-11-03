'use strict'
/**
 * AI 伴侣 · 连续独白状态机（0.46.0，用户 11-02 自言自语系统）
 *
 * 她的自言自语有两种形态：
 *   零散嘀咕 —— 一句完事，说完就忘
 *   连续独白 —— 对着同一件事琢磨：观察 → 疑惑 → 猜测 → 修正，前后连贯
 *
 * 这个模块只管「独白」这一层薄状态：现在有没有在独白、围绕什么、说了几句、
 * 什么时候过期。不碰台词生成（chatter 管）、不碰记忆（出口统一走 sayNarration
 * → ledgerNote(via:'chatter')，与本体记忆同源，不另立门户）。
 *
 * 过期：30 分钟没接上就算自然结束（人不会对着一个念头琢磨一整天）。
 * 上限：一场独白最多 4 句——独白是「遇到真感兴趣的东西」，不是演讲。
 */
const fs = require('node:fs')
const path = require('node:path')

const MAX_LINES = 4
const EXPIRE_MS = 30 * 60 * 1000

function createSoliloquy ({ file, log = () => { }, now = () => Date.now() }) {
  let mem = null            // { topic, lines[], startedAt, lastAt }
  let loaded = false

  function load () {
    if (loaded) return
    loaded = true
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (j && j.topic && Array.isArray(j.lines) && j.lines.length) mem = j
    } catch { }
  }
  function save () {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(mem ? { ...mem, savedAt: now() } : { closedAt: now() }))
    } catch (e) { log('[soliloquy] 落盘失败: ' + (e && e.message)) }
  }

  /** 当前独白（过期的顺手清掉）。没在独白返回 null。 */
  function current () {
    load()
    if (!mem) return null
    if (now() - mem.lastAt > EXPIRE_MS) {
      log('[soliloquy] 独白自然过期（' + String(mem.topic || '').slice(0, 20) + '）')
      mem = null
      save()
      return null
    }
    return { ...mem, full: mem.lines.length >= MAX_LINES }
  }

  /** 开一场新独白；已有时不动（返回现状） */
  function open (topic) {
    load()
    const t = String(topic || '').trim().slice(0, 40)
    if (!t) return current()
    if (!mem) { mem = { topic: t, lines: [], startedAt: now(), lastAt: now() } }
    save()
    return current()
  }

  /** 记一句已说的；超出上限自动收尾 */
  function addLine (line) {
    load()
    if (!mem) return null
    const t = String(line || '').trim()
    if (t) {
      mem.lines.push(t.slice(0, 60))
      mem.lastAt = now()
    }
    if (mem.lines.length >= MAX_LINES) {
      const done = { ...mem, full: true }
      mem = null
      save()
      return { closed: true, reason: 'full', ...done }
    }
    save()
    return current()
  }

  /** 收尾（说完 / 被用户交流打断 / 主人开口）。本来就没开也无所谓。 */
  function close (reason) {
    load()
    if (!mem) return null
    const done = { ...mem }
    mem = null
    save()
    log('[soliloquy] 独白结束（' + String(reason || 'done') + '）：' + String(done.topic || '').slice(0, 20) + '，共 ' + done.lines.length + ' 句')
    return { closed: true, reason: reason || 'done', ...done }
  }

  return { current, open, addLine, close, MAX_LINES, EXPIRE_MS }
}

module.exports = { createSoliloquy, MAX_LINES, EXPIRE_MS }
