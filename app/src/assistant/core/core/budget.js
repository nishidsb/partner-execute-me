/**
 * 上下文预算（核心侧，0.21.0）
 *
 * 和 main/companion/context.js 同源思路，但核心是纯 ESM、不能反向依赖宿主目录，
 * 所以这里只保留核心真正要用的三件事：
 *   - 固定说明书段落按需注入（不必每轮重发几百字）
 *   - 历史按字符预算裁剪（原来固定 24 条，长回复照样能吃掉上下文）
 *   - 粗估 token（用量提示/日志用）
 */

/** 粗估 token：CJK 一字一 token，其余 4 字符一 token */
export function estTokens (text) {
  const s = String(text || '')
  let cjk = 0
  let other = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/** 「怎么用工具」的说明书：首轮 / 每 N 轮 / 话里提到相关词时才发 */
const FIXED_RULES = {
  petTools: { every: 12, re: /动作|表情|走过来|走过去|跳舞|摸头|抱|亲|害羞|生气|开心|挥手|点头|安静|dance|wave|happy|shy/i },
  sysTools: { every: 20, re: /打开|启动|开个|运行|退出|游戏|程序|steam|epic|记事本|浏览器/i },
  cua: { every: 10, re: /屏幕|截图|看点|点一下|点击|输入|打字|鼠标|键盘|窗口|微信|浏览器|帮我点/i }
}

export function wantFixed (kind, { turn = 0, userText = '' } = {}) {
  const r = FIXED_RULES[kind]
  if (!r) return true
  const t = Number(turn) || 0
  if (t <= 1) return true
  if (t % r.every === 0) return true
  return r.re.test(String(userText || ''))
}

/** 不发全文时留一行索引，避免模型「忘记自己有这个能力」 */
export const FIXED_INDEX = {
  petTools: '（表现工具：pet_say/pet_act/pet_move_to/pet_ask/pet_set/pet_quiet。正文可嵌 [action:语义标签] 让她边说边做动作，一句最多一个）',
  sysTools: '（系统工具：open_app 开程序 / launch_game 开游戏 / game_mode 游戏模式 / list_running 看开着什么 / set_volume 音量 / show_desktop 显示桌面）',
  cua: '（电脑工具：截图 / 点击 / 输入 / 按键 / 窗口管理，参数见工具表）'
}

/** 历史按字符预算裁：从最新往回装，至少保留 keepAtLeast 条 */
export function trimHistory (history, maxChars, keepAtLeast = 8) {
  const arr = Array.isArray(history) ? history : []
  const limit = Math.max(0, Number(maxChars) || 0)
  if (!limit) return arr.slice()
  const keep = Math.max(1, Number(keepAtLeast) || 1)
  let used = 0
  const out = []
  for (let i = arr.length - 1; i >= 0; i--) {
    const len = String((arr[i] && arr[i].content) || '').length
    if (out.length >= keep && used + len > limit) break
    out.unshift(arr[i])
    used += len
  }
  return out
}

/**
 * 剔掉开头的孤儿 tool 结果（0.45.94）。
 * trimHistory 从后往前按预算切，起点可能落在一组工具调用的中间：父 assistant 被切走、
 * tool 结果留下 → OpenAI 兼容端点 400「tool must be a response to a preceding message
 * with tool_calls」，且此后每轮都被同一条卡死。
 */
export function dropLeadingOrphanTools (arr) {
  const out = Array.isArray(arr) ? arr.slice() : []
  while (out.length && out[0] && out[0].role === 'tool') out.shift()
  return out
}

/** 由模型上下文上限（token）反推历史字符预算：历史吃 40% */
export function historyBudget (ctxTokens) {
  const t = Number(ctxTokens) || 0
  if (!t) return 24000
  return Math.max(8000, Math.min(60000, Math.round(t * 0.4 * 1.5)))
}

/**
 * 0.45.95：把「工具调用」整段压成纯文本。
 *
 * 干什么用的：DeepSeek 的 thinking 模式有一条死规则——带 tool_calls 的 assistant 消息
 * 必须把 reasoning_content 原样带回，否则整轮 400。多数情况下我们回填得住，
 * 但历史里的老消息（0.45.93 之前落盘的）、网关转写的工具调用，都可能**根本没有思维链**，
 * 这时候补空串也不一定被接受（不同端点校验不一致）。
 *
 * 所以留一条无条件成立的退路：这一轮把 tool_calls / tool 结果全部改写成普通文本，
 * 请求里再没有任何 tool_calls，那条规则就无从触发，至少能把话说完，不至于整轮哑掉。
 * 只在真被 400 挡回来时用一次，正常路径不受影响。
 */
export function flattenToolHistory (arr) {
  const out = []
  const push = (m) => {
    const last = out[out.length - 1]
    // 连续同角色合并：部分端点不接受连着两条 user
    if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') {
      last.content = last.content + '\n' + m.content
      return
    }
    out.push(m)
  }
  for (const m of (Array.isArray(arr) ? arr : [])) {
    if (m && m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const names = m.tool_calls.map((t) => (t && t.function && t.function.name) || '').filter(Boolean).join('、')
      const text = String(m.content || '').trim()
      push({
        role: 'assistant',
        content: [text, names ? '（我调用了工具：' + names + '）' : '（我调用了一个工具）'].filter(Boolean).join('\n')
      })
      continue
    }
    if (m && m.role === 'tool') {
      push({ role: 'user', content: '【工具 ' + (m.name || '') + ' 的结果】\n' + String(m.content || '').slice(0, 2000) })
      continue
    }
    push(m)
  }
  return out
}
