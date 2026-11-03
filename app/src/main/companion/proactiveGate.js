'use strict'
/**
 * 主动开口的复读硬闸 · 0.45.91
 *
 * 用户 11-02：「说了晚安之后还会一直说话，还是一直重复说话的」。
 * 聊天史实锤：11-01 23:56 ~ 11-02 09:28 她主动开了 9 次口，其中
 * 「あ、戻った。……配合の数字、見直してた」出现 4 次（01:28 / 04:07 / 06:59 / 09:28），
 * 逐字几乎一致——提示词里的「防复读镜子」拦不住，模型面前摆着同一段记忆就照抄。
 *
 * chatter.js / watch.js 已经用 voicesim 做过同样的硬闸，这里给黏人阶梯
 * 与「欢迎回来」用同一把尺子：跟最近说过的比对，雷同就换角度重生成一次，
 * 还雷同就不开口（宁可安静，也不当复读机）。
 *
 * 纯逻辑 + 一个小状态壳，node:test 里不启 Electron 也能跑。
 */
const voicesim = require('./voicesim')

/**
 * @param {object} o { size } 记住多少句（默认 12）
 * @param {function} o.extraHistory 取外部历史（比如 inner.recentVoices），可为空
 */
function createGate ({ size = 12, extraHistory } = {}) {
  const recent = []

  /** 记一句已经出口的台词 */
  function note (text) {
    const t = String(text || '').trim()
    if (!t) return
    recent.push(t)
    while (recent.length > size) recent.shift()
  }

  /** 比对用的历史：外部历史（跨重启还在）+ 本次进程说过的 */
  function history () {
    let out = []
    if (typeof extraHistory === 'function') {
      try { out = extraHistory() || [] } catch { out = [] }
    }
    return out.concat(recent).filter(Boolean).slice(-(size + 6))
  }

  /** @returns {null|{repeat:boolean, score:number, against:string}} 雷同返回命中详情 */
  function check (text) {
    const t = String(text || '').trim()
    if (!t) return null
    const hist = history()
    if (!hist.length) return null
    const r = voicesim.isRepeat(t, hist)
    return r && r.repeat ? r : null
  }

  /** 测试/排查用 */
  function peek () { return recent.slice() }

  return { note, check, history, peek }
}

module.exports = { createGate }
