'use strict'
/**
 * 上下文预算（0.21.0）
 *
 * 为什么要它：0.20 之前 system prompt 是「能加就加」——
 * PARTNER.md（≤12000）+ 她的日记（≤2000）+ 用户资料 + 世界书 + 扩展 +
 * 桌宠工具说明 + 开程序说明 + CUA 说明，全量叠加，固定开销就上万字符，
 * 每轮都重发一次。真正留给对话的上下文被挤掉，长会话更容易触发折叠。
 *
 * 这里只做纯计算（可直接单测），不碰文件、不碰网络：
 *   estTokens    粗估 token
 *   wantFixed    固定说明书这一段本轮要不要发
 *   fixedIndex   不发全文时那行极短索引
 *   assemble     按优先级装填预算，超了丢低优先级的
 *   trimHistory  历史按字符预算裁剪
 *   historyBudget 由模型上下文上限反推历史预算
 */

/** 粗估 token：CJK 一字一 token，其余 4 字符一 token */
function estTokens (text) {
  const s = String(text || '')
  let cjk = 0
  let other = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * 固定说明段（「工具怎么用」的说明书）不需要每轮都复习：
 * 首轮给一次、每隔 N 轮复述一次、话里出现相关词时补一次。
 */
const FIXED_RULES = {
  petTools: { every: 12, re: /动作|表情|走过来|走过去|跳舞|摸头|抱|亲|害羞|生气|开心|挥手|点头|坐下|安静|dance|wave|happy|shy/i },
  sysTools: { every: 20, re: /打开|启动|开个|运行|退出|游戏|程序|steam|epic|记事本|浏览器/i },
  cua: { every: 10, re: /屏幕|截图|看点|点一下|点击|输入|打字|鼠标|键盘|窗口|微信|浏览器|帮我点/i }
}

function wantFixed (kind, opts) {
  const o = opts || {}
  const r = FIXED_RULES[kind]
  if (!r) return true
  const t = Number(o.turn) || 0
  if (t <= 1) return true
  if (t % r.every === 0) return true
  return r.re.test(String(o.userText || ''))
}

/** 不发全文时至少留一行索引，避免模型「忘记自己有这个能力」 */
const FIXED_INDEX = {
  petTools: '（可用表现工具：pet_say 说话 / pet_act 动作 / pet_move_to 走路 / pet_ask 提问 / pet_set 外观 / pet_quiet 安静。动作词例：挥手/打招呼/再见/叉腰/抱臂/害羞/过来/卖萌/坐下/站起来；拍手/加油/比耶/耳语/伸懒腰/晃脚/慌张/等一下/托腮 要她坐着时才会演。也可以在回复正文里直接嵌 [action:标签] 让她边说边做动作（自动调用，不用工具）：acknowledge认同/disagree不认同/think思考/explain说明/excited兴奋/wave挥手/shy害羞/surprised惊讶/comfort安慰/playful俏皮/invite邀请，按这句话的真实语气自然嵌，一句最多一个，不是每句都要加）',
  sysTools: '（可用系统工具：open_app 开程序 / launch_game 开游戏 / game_mode 游戏模式）',
  cua: '（可用电脑工具：截图 / 点击 / 输入 / 按键 / 窗口管理，具体参数见工具表）'
}

/**
 * 按优先级装填：priority 高的先保住；超预算时低优先级的整段丢弃，
 * 高优先级（≥5）可以截断保留。
 * @param {Array<{key?:string,text:string,priority?:number}>} sections
 * @param {number} budgetChars 0/省略 = 不限
 */
function assemble (sections, budgetChars) {
  const list = (sections || []).filter((s) => s && s.text)
  const budget = Math.max(0, Number(budgetChars) || 0)
  if (!budget) return list.map((s) => s.text).join('\n\n')
  const order = new Map(list.map((s, i) => [s, i]))
  let used = 0
  const kept = []
  for (const s of [...list].sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
    const text = String(s.text)
    if (used + text.length <= budget) {
      kept.push(s)
      used += text.length
      continue
    }
    const room = budget - used
    if (room >= 200 && (s.priority || 0) >= 5) {
      kept.push(Object.assign({}, s, { text: text.slice(0, room - 24) + '\n（这段太长，已截断）' }))
      used = budget
    }
  }
  return kept.sort((a, b) => order.get(a) - order.get(b)).map((s) => s.text).join('\n\n')
}

/** 历史按字符预算裁：从最新往回装，至少保留 keepAtLeast 条 */
function trimHistory (history, maxChars, keepAtLeast = 8) {
  const arr = Array.isArray(history) ? history : []
  const limit = Math.max(0, Number(maxChars) || 0)
  if (!limit) return arr.slice()
  const keep = Math.max(1, Number(keepAtLeast) || 1)
  let used = 0
  const out = []
  for (let i = arr.length - 1; i >= 0; i--) {
    const len = String(arr[i] && arr[i].content || '').length
    if (out.length >= keep && used + len > limit) break
    out.unshift(arr[i])
    used += len
  }
  return out
}

/**
 * 给定模型上下文上限（token）→ 留给历史的字符预算。
 * 留一半给 system prompt、回答与工具回来，历史只吃 40%。
 */
function historyBudget (ctxTokens) {
  const t = Number(ctxTokens) || 0
  if (!t) return 24000 // 不知道上限时的保守默认
  return Math.max(8000, Math.min(60000, Math.round(t * 0.4 * 1.5)))
}

/** 给设置页/日志看的一行摘要：各段多少字符、估多少 token */
function digest (sections) {
  const rows = (sections || []).filter((s) => s && s.text).map((s) => ({
    key: s.key || '?',
    chars: String(s.text).length,
    tokens: estTokens(s.text)
  }))
  return {
    parts: rows,
    chars: rows.reduce((n, r) => n + r.chars, 0),
    tokens: rows.reduce((n, r) => n + r.tokens, 0)
  }
}

module.exports = {
  estTokens,
  FIXED_RULES,
  FIXED_INDEX,
  wantFixed,
  assemble,
  trimHistory,
  historyBudget,
  digest
}
