'use strict'
/**
 * QQ 主动找主人（0.45.12；0.45.97 改成「随机节奏 + 两边只算一次」）
 *
 * 主人不在电脑前时，桌面侧的黏人/欢迎通道全部哑火（这是 0.35.0 的正确让位）——
 * 但「他不在」不等于「她不能找他」：她在 QQ 上给他发条消息，才是真正的黏人。
 *
 * 红线（全部硬编码，不随配置放开）：
 * - 只发给主人名单（ownerAccounts / reachAccount），绝不发给陌生人
 * - 节奏：两次之间随机 25~90 分钟（GAP_MIN_MS ~ GAP_MAX_MS），没有「每天最多几条」
 * - 深夜静默：由 reachPlan 的时段策略管（全时段 / 谷时）
 * - QQ 侧回话走 im brain 正常聊天链路（已接长期记忆），主人开口同时清桌面黏人计时
 *
 * 0.45.97（用户 11-02）：
 *   「这个主动发的属于多余的设计，随机发就可以了，不用在意多少条，
 *     以及主动发的这个跟屏幕陪伴这边应该是冲突的设计，这两个地方只要有一边发了都算发」
 *   → 删掉 reachMinGapMin / reachDailyMax 两个设置项；间隔改为每次现抽的随机值；
 *   → rec.lastAt 变成「屏幕陪伴 + QQ」共用的那一笔账：任意一边开过口，另一边都先安静。
 *
 * 纯判定模块：shouldReach(rec, ic, now) → { ok, why }，宿主拿 ok 去生成台词再发。
 */

const reachPlan = require('./reachPlan')

const QUIET_FROM = 1        // 历史值：0.45.93 起由 reachPlan 的时段策略接管，常量仅留作兼容导出
const QUIET_TO = 8

/* 随机节奏：每次发完现抽一个间隔，所以是「忙起来忘了你 → 忽然想起你」，不是闹钟。
 * 下限别太短（刚说完又贴上来），上限别太长（等着等着人就凉了）。 */
const GAP_MIN_MS = 25 * 60 * 1000
const GAP_MAX_MS = 90 * 60 * 1000

/**
 * 抽一个随机间隔
 * @param {Function} [rand] 注入随机源（测试用），默认 Math.random
 */
function randomGap (rand) {
  const f = typeof rand === 'function' ? rand : Math.random
  let x = Number(f())
  if (!Number.isFinite(x)) x = 0.5
  x = Math.min(1, Math.max(0, x))
  return Math.round(GAP_MIN_MS + x * (GAP_MAX_MS - GAP_MIN_MS))
}

/**
 * @param {object} rec { lastAt, nextAt, day, count }（宿主持有；屏幕陪伴与 QQ 共用）
 * @param {object} ic im brain 配置（reachOn/reachAccount/ownerAccounts/reachWindowMode/reachValleyFrom/reachValleyTo）
 * @param {object} o { now, connected: bool, bypassWindow?: bool }
 * @returns {{ok: boolean, why: string, uid?: string}}
 */
function shouldReach (rec, ic, o) {
  const now = Number((o && o.now) || Date.now())
  const c = ic || {}
  if (c.reachOn === false) return { ok: false, why: 'off' }
  if (!(o && o.connected)) return { ok: false, why: 'disconnected' }
  const uid = String(c.reachAccount || (Array.isArray(c.ownerAccounts) && c.ownerAccounts[0]) || '').trim()
  if (!uid) return { ok: false, why: 'no-owner' }   // 没配主人账号 = 永远不发（安全边界）
  // 0.45.93 时段策略：全时段 / 谷时（可跨零点，起止在设置页里改）。
  // 用户明确要求「谈起什么时候给我发」这类当场承诺不吃时段限制 → bypassWindow。
  if (!(o && o.bypassWindow)) {
    const w = reachPlan.windowOk(c, now)
    if (!w.ok) return { ok: false, why: 'outside-window' }
  }
  const r = rec || {}
  // 「两边只算一次」：nextAt 由任意一边开过口时写入（桌面陪伴也算），到点前谁都别再开口
  // 0.46.67 bypassCooldown：当场承诺（道晚安）不但免时段，还得免冷却——
  // 真机 11-06 晚实锤：23:35 屏幕刚开口 → 23:45 晚安被 cooldown 拦；
  // 00:19 又开口 → 00:30/00:31 晚安再被拦，三连毁约（共用账本本意是节流，不该拦承诺）。
  // 滥用风险有界：晚安入口自带 30 分钟锁 + busy 锁，一次晚安最多补发一条。
  if (!(o && o.bypassCooldown)) {
    const next = Number(r.nextAt) || 0
    if (next && now < next) return { ok: false, why: 'cooldown' }
    // 老记录（0.45.96 及之前没有 nextAt）：退回「距上次开口至少 GAP_MIN_MS」
    const last = Number(r.lastAt) || 0
    if (!next && last && now - last < GAP_MIN_MS) return { ok: false, why: 'cooldown' }
  }
  return { ok: true, why: '', uid }
}

/** 发出成功后滚动记录（桌面陪伴开口也调这个 —— 两边共用一本账） */
function onSent (rec, now, o) {
  const t = Number(now) || Date.now()
  const day = new Date(t).toDateString()
  const r = rec || {}
  const count = r.day === day ? (Number(r.count) || 0) + 1 : 1
  return { lastAt: t, nextAt: t + randomGap(o && o.rand), day, count }
}

module.exports = {
  QUIET_FROM,
  QUIET_TO,
  GAP_MIN_MS,
  GAP_MAX_MS,
  randomGap,
  shouldReach,
  onSent
}
