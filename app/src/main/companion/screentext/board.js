'use strict'
/**
 * 字幕白板（纯逻辑，无 Electron 依赖，可单测）
 *
 * 每一轮说话时，把「你最近在看的内容」拼成一段**临时**文字塞进 system prompt。
 * 关键设计（沿用鱼搭子 0.0.9 的游标式投递，实测过的）：
 *
 *   · **游标，不是时间窗**：每条字幕进队列时拿一个递增序号，白板只拼「序号 > 已发到」的。
 *     时间窗的问题是你隔一小时没说话，中间的字幕就永久丢了；游标是一条不漏、也不会重发。
 *   · **本轮只标记、不推进**：text() 可能在同一轮里被调用多次，推进要等这一轮真结束
 *     （commit()），否则第二次调用就成了空串。
 *   · **没新字幕返回空串**：空串不占上下文，安静看片就一分钱不花。
 *   · **不写进对话历史**：白板是每轮现拼的，聊十轮也只占当轮，不会越看越厚。
 */

const QUEUE_MAX = 400       // 最多存这么多句，再多从最旧的丢
const PER_TURN_MAX = 80     // 一轮最多拼这么多句（太长只发最近这些，并标明前面还有几句）

/** 一句字幕是「多久以前」说的 —— 相对时间比钟点有用，而且每轮现拼所以永远新鲜 */
function howLongAgo (at, now) {
  const sec = Math.max(0, Math.round((Number(now) - Number(at || 0)) / 1000))
  if (sec <= 3) return '刚刚'
  if (sec < 60) return sec + ' 秒前'
  const min = Math.round(sec / 60)
  if (min < 60) return min + ' 分钟前'
  return Math.round(min / 60) + ' 小时前'
}

function createBoard (opts = {}) {
  const queueMax = opts.queueMax || QUEUE_MAX
  const perTurn = opts.perTurn || PER_TURN_MAX
  let rows = []
  let next = 1
  let sent = 0
  let inTurn = 0
  let dropped = 0
  let lastAt = 0

  function add (text, at) {
    const t = String(text || '').trim()
    if (!t) return false
    const when = Number(at) || Date.now()
    // 同一句被断句抖动推上来两遍就别写两条
    if (rows.length && rows[rows.length - 1].text === t) return false
    rows.push({ seq: next++, at: when, text: t.slice(0, 300) })
    lastAt = when
    while (rows.length > queueMax) {
      const gone = rows.shift()
      if (gone && gone.seq > sent) dropped += 1
    }
    return true
  }

  function pending () {
    return rows.filter((r) => r.seq > sent)
  }

  /**
   * 这一轮要拼的那段。没有新字幕 → 空串（调用方直接不 push 进 prompt）。
   * ⚠ 只记「本轮到哪儿」，不推进游标。
   */
  function render (now) {
    const pend = pending()
    if (!pend.length) return ''
    const take = pend.length > perTurn ? pend.slice(pend.length - perTurn) : pend
    const skipped = pend.length - take.length
    inTurn = take[take.length - 1].seq
    const head = '【你正在看的】（屏幕上的字幕，不是你俩说的话'
      + (skipped > 0 ? '；前面还有 ' + skipped + ' 句太长没贴' : '')
      + (dropped > 0 ? '；再早还有 ' + dropped + ' 句被挤掉了' : '') + '）'
    const body = take.map((r) => '· ' + howLongAgo(r.at, Number(now) || Date.now()) + '｜' + r.text)
    return head + '\n' + body.join('\n') + '\n（上面这些是片子里的字幕。想看的时候就自然接一句，不用每句都应。）'
  }

  /** 一轮真结束了：把游标推到这一轮拼到的位置（没拼过的轮次不动） */
  function commit () {
    if (!inTurn) return false
    const before = sent
    sent = Math.max(sent, inTurn)
    inTurn = 0
    return sent !== before
  }

  /** 停掉陪看：攒着还没发出去的全扔掉，游标推到队尾（免得下次把旧的当新的） */
  function reset () {
    const lost = rows.filter((r) => r.seq > sent).length
    rows = []
    // 游标 = 最后发出去的序号（next 指向下一个将发放的号，所以是 next - 1）。
    // 写成 sent = next 会让下一句拿到和游标相同的号 → 直接判成「已发过」、永远贴不出来。
    sent = next - 1
    inTurn = 0
    return lost
  }

  const stats = () => ({ total: rows.length, sent, inTurn, dropped, lastAt, pending: pending().length })

  return { add, pending, render, commit, reset, stats }
}

module.exports = { QUEUE_MAX, PER_TURN_MAX, howLongAgo, createBoard }
