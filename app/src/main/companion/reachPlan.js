'use strict'
/**
 * 0.45.93 · QQ 主动消息的时段策略（谷时窗口判定）
 * 0.47.1：排期队列（addPlan/duePlans/describe/msUntilWindow）随「定时硬触发设计全退役」删除——
 * 主人 11-08 拍板，约好的事进记忆、到点看情况，不再有定时器兜底。
 * 只保留窗口判定语义（tryQqReach 的谷时策略还在用）。
 */

const DEFAULT_FROM = '23:00'
const DEFAULT_TO = '08:00'

/** '09:30' → 570；非法 → null */
function parseHHMM (s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null
  return h * 60 + mi
}

function fmtHHMM (mins) {
  const m = ((Math.round(Number(mins) || 0) % 1440) + 1440) % 1440
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
}

/** 读配置里的时段设置（im 配置是唯一真源），坏值一律退回默认 */
function windowOf (ic) {
  const c = ic || {}
  const mode = c.reachWindowMode === 'valley' ? 'valley' : 'all'   // 默认全时段：先把「能发」跑通，谷时是想省/想安静时的选项
  const from = parseHHMM(c.reachValleyFrom)
  const to = parseHHMM(c.reachValleyTo)
  return {
    mode,
    from: from == null ? parseHHMM(DEFAULT_FROM) : from,
    to: to == null ? parseHHMM(DEFAULT_TO) : to
  }
}

/** 当前时刻是否落在谷时窗口里（支持 23:00→08:00 这种跨零点；起止相同视为全天） */
function inValley (now, w) {
  const d = new Date(Number(now) || Date.now())
  const cur = d.getHours() * 60 + d.getMinutes()
  const from = w && Number.isFinite(w.from) ? w.from : parseHHMM(DEFAULT_FROM)
  const to = w && Number.isFinite(w.to) ? w.to : parseHHMM(DEFAULT_TO)
  if (from === to) return true
  if (from < to) return cur >= from && cur < to
  return cur >= from || cur < to          // 跨零点
}

/**
 * 现在能不能主动发（只看时段，节流交给 reach.shouldReach）
 * @returns {{ok:boolean, why:string, mode:string, window:string}}
 */
function windowOk (ic, now) {
  const w = windowOf(ic)
  if (w.mode === 'all') return { ok: true, why: '', mode: 'all', window: '全时段' }
  const label = fmtHHMM(w.from) + '–' + fmtHHMM(w.to)
  if (inValley(now, w)) return { ok: true, why: '', mode: 'valley', window: label }
  return { ok: false, why: 'outside-window', mode: 'valley', window: label }
}

/** 距下一次谷时开始还有多久（毫秒），全时段模式返回 0 —— 用来给她一句「几点再发」 */
module.exports = {
  DEFAULT_FROM,
  DEFAULT_TO,
  parseHHMM,
  fmtHHMM,
  windowOf,
  inValley,
  windowOk
}
