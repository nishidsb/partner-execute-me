'use strict'
/**
 * AI 伴侣 · 在场判定（presence）
 *
 * 为什么要有这个：0.34 之前，三条主动通道（看屏搭话 / 时间观念 / 黏人模式）都不看
 * 「人在不在电脑前」。用户 10-29 出门 6 小时，她照样每 15 分钟看一次屏幕、看到什么说什么，
 * 还在 60 分钟时追问「怎么不理我」。用户回来第一句话是对她整体状态的不满（不该在她独自待着的时候被开着他不在也在说）。
 *
 * 两个信号合并判断，缺一不可：
 *   idleSec()  键鼠无输入秒数（powerMonitor）—— 人走了，屏幕还亮着放视频时唯一可信的信号
 *   口头宣告   「我出门了」「我不在电脑前」—— 人还在但马上要走时，比 idle 更早、更准
 *
 * 三档：
 *   here  人在（刚有输入 / 刚说过话）—— 三条通道都放行
 *   away  暂时走开（≥ AWAY_MS 无输入）—— 不主动搭话，但保留「回来时欢迎一句」
 *   gone  确实不在（≥ GONE_MS 无输入，或口头宣告离开）—— 完全闭嘴，只在回来时说话
 *
 * 刻意做成纯函数 + 一个极小的状态壳：node:test 里不启 Electron 也能把每个分支跑一遍。
 */

const AWAY_MS = 5 * 60 * 1000    // 5 分钟没动静 → 暂时走开
const GONE_MS = 30 * 60 * 1000   // 30 分钟没动静 → 确实不在
const GRACE_MS = 90 * 1000       // 口头宣告离开后，看到「有人回来了」至少要隔这么久才作数（防自己手抖碰到）

/** 「我出门了」类：主动宣告离开 */
const LEAVE_WORDS = [
  '出门', '出去', '走了', '我走', '下楼', '上去一下', '离开', '不在电脑', '不在电脑前',
  '不在座位上', '离开一下', '出去一趟', '外出', '去上班', '上班去', '去公司', '去见',
  '晚点回来', '一会儿回来', '一会回来', '迟点回来', '待会回来', '晚点回', '可能晚回',
  '先出去', '我出去', '我要出去', '得出去', '准备出去',
  '坐车', '要走了', '该走了', '准备走了', '得走了', '走了啊', '我去了',
  '出かける', '外出', '出かけてくる', 'ちょっと出', '席を外', 'いない', '留守',
  'going out', 'be right back', 'brb', 'away from'
]

/** 「我回来了」类：主动宣告回来 */
const RETURN_WORDS = [
  '回来了', '回来啦', '到家', '我回', '刚回', '回到了', '我到了家', '进门',
  'ただいま', '帰ってきた', '戻った', '帰宅',
  "i'm back", 'im back', 'i am back', 'back home'
]

/** 问句一律不算宣告：「你出门吗」「你回来了没」是在问，不是在报告。
 *  注意别把「么」放进来——「什么」「怎么」「怎么样」都含它，
 *  会把「我人还是在外面的不在电脑前，莱莎现在感觉怎么样」这种真话判成问句（0.35.0 实测踩中）。 */
const QUESTION_MARKS = ['？', '?', '吗', '呢', 'か', '是不是', '要不要', '有没有']
/** 例外：自责不是发问。「我是不是不该在你不在的时候开你」是在认错，不是在问她 */
const SELF_BLAME = ['是不是不该', '我是不是', '是不是我做错', '是不是我错', '不该让', '不该开']

function isQuestion (s) {
  if (SELF_BLAME.some((w) => s.includes(w))) return false
  return QUESTION_MARKS.some((q) => s.includes(q))
}

/** 「我出门了」→ true。问句、以及「别出门」这类否定祈使句都排除 */
function didDeclareLeave (text) {
  const s = String(text || '').trim()
  if (!s || s.length > 120) return false
  if (isQuestion(s)) return false
  // 「别/不要/不用 + 出门」是在说她，不是在报告自己
  if (/(别|不要|不用|不必)\s*(出门|出去|走)/.test(s)) return false
  if (!LEAVE_WORDS.some((w) => s.includes(w))) return false
  // 「我回来了」里也含「回来」，先让回来的判定赢
  return !didDeclareReturn(s)
}

/** 「我回来了」→ true */
function didDeclareReturn (text) {
  const s = String(text || '').trim()
  if (!s || s.length > 120) return false
  if (isQuestion(s)) return false
  return RETURN_WORDS.some((w) => s.toLowerCase().includes(w.toLowerCase()))
}

/**
 * 纯判定：给定空闲毫秒与「是否被口头宣告离开」，返回 here/away/gone
 * @param {number} idleMs
 * @param {boolean} declaredAway
 */
function classify (idleMs, declaredAway) {
  const idle = Number(idleMs)
  const t = Number.isFinite(idle) && idle > 0 ? idle : 0
  if (declaredAway) return 'gone'      // 说了走，就是走，哪怕手抖碰了一下键鼠
  if (t >= GONE_MS) return 'gone'
  if (t >= AWAY_MS) return 'away'
  return 'here'
}

function createPresence ({ idleSec, log = () => { }, now = () => Date.now() }) {
  let declaredAway = false
  let declaredAt = 0
  /** 软离开：判读器只判出「暗示」（「先忙了」「手机快没电了先这样」）时用。
   *  不直接锁死成 gone——那种话也可能是「我看完这集再说」，
   *  只在她确实一段时间没动键鼠时才当 away。 */
  let softAway = false
  let lastUserAt = 0

  function idleMs () {
    try {
      const v = typeof idleSec === 'function' ? Number(idleSec()) : 0
      return Number.isFinite(v) && v > 0 ? v * 1000 : 0
    } catch { return 0 }
  }

  /** 当前档位（每次调用现算，不做缓存——powerMonitor 的读数本来就很便宜） */
  function get () {
    const t = now()
    const idle = idleMs()
    // 口头宣告离开后，只有「隔了宽限期还在持续有输入」才算人真回来了（防她自己碰一下鼠标就撤销）
    if (declaredAway && idle < 30 * 1000 && t - declaredAt > GRACE_MS) {
      declaredAway = false
      log('[presence] 检测到键鼠活动，撤销「离开」宣告')
    }
    let state = classify(idle, declaredAway)
    // 软离开只压到 away：不拦看屏（看片手不动是常态），但足够拦住碎碎念和黏人
    if (state === 'here' && softAway && idle >= AWAY_MS) state = 'away'
    return { state, idleMs: idle, declaredAway, soft: softAway, since: declaredAt, lastUserAt }
  }

  /** 只看状态字符串，给各通道做门禁用 */
  function state () { return get().state }

  /**
   * 用户说了一句话 → 解析是不是在宣告离开/回来。
   * 注意：任何用户消息都算「他在这里」（哪怕宣告离开，也是此刻还在）——
   * 所以 lastUserAt 一定更新，只是同时把 declaredAway 置上。
   */
  function noteUserMessage (text) {
    const t = now()
    lastUserAt = t
    if (didDeclareReturn(text)) {
      if (declaredAway) log('[presence] 主人说回来了，解除离开状态')
      declaredAway = false
      declaredAt = 0
      return 'return'
    }
    if (didDeclareLeave(text)) {
      if (!declaredAway) log('[presence] 主人说出门了，进入离开状态')
      declaredAway = true
      declaredAt = t
      return 'leave'
    }
    // 说了话就说明人在，但不撤销口头的离开宣告（可能是临走前最后一句 / 手机上发的）
    return ''
  }

  function reset () { declaredAway = false; declaredAt = 0; softAway = false }

  /**
   * 外部直接宣告（0.36.0 语义判读用）。
   * 词表认得的是字面，判读器认的是意思——「车来了」「到公司了」词表全瞎，
   * 判读器认出来之后从这里补进来，效果跟当场说了「我出门了」一样。
   */
  function declareAway (by = 'judge', opts = {}) {
    const t = now()
    lastUserAt = t
    // soft = 只判出「暗示」（「先忙了」「手机快没电了先这样」）：按 away 处理，
    // 不锁死 gone——那种话也可能是「我看完这集再说」，人不一定真走。
    if (opts && opts.soft) {
      if (!softAway) log('[presence] 记下软离开（' + by + '）')
      softAway = true
      return 'leave'
    }
    softAway = false
    if (declaredAway) return 'leave'
    declaredAway = true
    declaredAt = t
    log('[presence] 进入离开状态（' + by + ' 判定）')
    return 'leave'
  }

  /** 撤销离开（判读器认为不是要走，或者确认回来了） */
  function declareBack (by = 'judge') {
    const t = now()
    lastUserAt = t
    softAway = false
    if (!declaredAway) return ''
    declaredAway = false
    declaredAt = 0
    log('[presence] 解除离开状态（' + by + '）')
    return 'return'
  }

  return { get, state, noteUserMessage, declareAway, declareBack, reset, idleMs }
}

module.exports = {
  AWAY_MS, GONE_MS, GRACE_MS,
  LEAVE_WORDS, RETURN_WORDS,
  didDeclareLeave, didDeclareReturn, classify,
  createPresence
}
