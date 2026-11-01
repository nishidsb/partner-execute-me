'use strict'
/**
 * 自设 · 用户资料解析（0.18.0 M8 修正，主人 2026-10-25 指出「自画像这些也是绑定角色的，不是共用的」）
 *  - 角色卡 userProfile（称呼/自画像/关系定位/互动偏好/需要避开）**优先**：每个角色眼里的你可以不一样
 *    （莱莎看你是炼金术士搭档，别的角色看你是主人——关系定位本来就该跟人设绑定）
 *  - 设置页「通用」里的那套只做**共用默认**：卡上没填的字段用它兜底
 *  - 与音色同一规则：卡优先，全局兜底（voice-pick.js 同款逻辑）
 * 纯函数、零依赖，companion/index.js / im 注入统一走这里；单测 test/user-profile.test.js。
 */

/** @param cardUp 角色卡上的 userProfile（可为 null）；@param globalUp 全局默认（可为 null）→ 合并后的资料对象 */
function resolveUserProfile (cardUp, globalUp) {
  const g = globalUp || {}
  const c = cardUp || {}
  const pick = (k) => String(c[k] == null ? '' : c[k]).trim() || String(g[k] == null ? '' : g[k]).trim()
  return {
    address: pick('address'),
    portrait: pick('portrait'),
    relationship: pick('relationship'),
    interaction: pick('interaction'),
    boundaries: pick('boundaries')
  }
}

/** 合并后转提示词 JSON 文本（空字段显示「未设置」，和旧 userProfileText 保持一致） */
function userProfileTextOf (cardUp, globalUp) {
  const p = resolveUserProfile(cardUp, globalUp)
  return '用户资料：' + JSON.stringify({
    称呼: p.address || '未设置',
    自画像: p.portrait || '未设置',
    关系定位: p.relationship || '未设置',
    互动偏好: p.interaction || '未设置',
    需要避开: p.boundaries || '未设置'
  })
}

module.exports = { resolveUserProfile, userProfileTextOf }
