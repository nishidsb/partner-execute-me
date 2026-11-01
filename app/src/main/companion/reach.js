'use strict'
/**
 * QQ 主动找主人（0.45.12）
 *
 * 主人不在电脑前时，桌面侧的黏人/欢迎通道全部哑火（这是 0.35.0 的正确让位）——
 * 但「他不在」不等于「她不能找他」：她在 QQ 上给他发条消息，才是真正的黏人。
 *
 * 红线（全部硬编码，不随配置放开）：
 * - 只发给主人名单（ownerAccounts / reachAccount），绝不发给陌生人
 * - 节流：两次至少隔 reachMinGapMin（默认 120 分钟），每天最多 reachDailyMax（默认 3）次
 * - 深夜静默：01:00~08:00 不找（真有急事也等到早上——没有急事，她只是想他）
 * - QQ 侧回话走 im brain 正常聊天链路（已接长期记忆），主人开口同时清桌面黏人计时
 *
 * 纯判定模块：shouldReach(rec, ic, now) → { ok, why }，宿主拿 ok 去生成台词再发。
 */

const QUIET_FROM = 1        // 凌晨 1 点
const QUIET_TO = 8          // 到早上 8 点前不找

/**
 * @param {object} rec { lastAt, day, count }（宿主持有）
 * @param {object} ic im brain 配置（reachOn/reachAccount/ownerAccounts/reachMinGapMin/reachDailyMax）
 * @param {object} o { now, connected: bool }
 * @returns {{ok: boolean, why: string, uid?: string}}
 */
function shouldReach (rec, ic, o) {
  const now = Number((o && o.now) || Date.now())
  const c = ic || {}
  if (c.reachOn === false) return { ok: false, why: 'off' }
  if (!(o && o.connected)) return { ok: false, why: 'disconnected' }
  const uid = String(c.reachAccount || (Array.isArray(c.ownerAccounts) && c.ownerAccounts[0]) || '').trim()
  if (!uid) return { ok: false, why: 'no-owner' }   // 没配主人账号 = 永远不发（安全边界）
  const h = new Date(now).getHours()
  if (h >= QUIET_FROM && h < QUIET_TO) return { ok: false, why: 'quiet-hours' }
  const r = rec || {}
  const gap = Math.max(30, Number(c.reachMinGapMin) || 120) * 60 * 1000
  if (r.lastAt && now - Number(r.lastAt) < gap) return { ok: false, why: 'cooldown' }
  const day = new Date(now).toDateString()
  const count = r.day === day ? (Number(r.count) || 0) : 0
  if (count >= Math.max(1, Number(c.reachDailyMax) || 3)) return { ok: false, why: 'daily-max' }
  return { ok: true, why: '', uid }
}

/** 发出成功后滚动记录 */
function onSent (rec, now) {
  const t = Number(now) || Date.now()
  const day = new Date(t).toDateString()
  const r = rec || {}
  const count = r.day === day ? (Number(r.count) || 0) + 1 : 1
  return { lastAt: t, day, count }
}

module.exports = { QUIET_FROM, QUIET_TO, shouldReach, onSent }
