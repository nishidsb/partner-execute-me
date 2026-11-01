'use strict'
/**
 * AI 伴侣 · 废话通道（chatter）
 *
 * 她说的话有两种：
 *   say       说给你听 —— 期待回应，被无视会计入负反馈
 *   narration 自言自语 —— 不期待回应，被无视也不受伤
 *
 * 只有第二种能做出「活人感」。一个只在有话要说时才开口的存在，再聪明也是助手；
 * 会碎碎念「好热」「这个字看了三遍还是没看懂」的，才像有人在家。
 *
 * 规则（写死，防止变成骚扰）：
 *   - 每天最多 MAX_PER_DAY 次（节奏器之外的第二道保险，只管碎碎念这一类）
 *   - 什么时候说，交给 rhythm.js（0.42.0）：同一份「每小时几次」的预算，
 *     但与「有话要说」那种共用一个池子——预算紧的时候先让位给后者
 *   - 只在清醒时段（WAKE_HOUR~SLEEP_HOUR）
 *   - 她太安静（quiet >= 0.6）时不念 —— 心情不好的人不会哼歌
 *   - 不朗读（speech:false），只出气泡：不花钱、不吵，像嘴里嘟囔一句
 *   - 绝不提问、不提醒、不说教 —— 判断标准：这句话没人接，也不尴尬
 */
const llm = require('./llm')

const MAX_PER_DAY = 5
const MIN_GAP = 1 * 60 * 1000      // 0.42.0：只作为「被节奏器挡下之后再等多久」的下限
const MAX_GAP = 15 * 60 * 1000     // 上限：再久也该醒来看一眼节奏器放行了没
const WAKE_HOUR = 9
const SLEEP_HOUR = 23

/** 0.45.14 今日上限可调：cfg.chatterDailyMax（默认 5）× 高频模式（chatterBoostOn，×3，封顶 60）。
 *  高频是试险开关：让她的「活人感」更密，也更容易腻——默认关。 */
function dailyMaxOf (cfg) {
  const base = Math.max(1, Number(cfg && cfg.chatterDailyMax) || MAX_PER_DAY)
  const boost = (cfg && cfg.chatterBoostOn) ? 3 : 1
  return Math.min(60, base * boost)
}

/** 开场白按「多久没跟主人说话」分两副面孔（0.45.44）：
 *  刚聊完（<1h）还念「你现在一个人待着」就是睁眼说瞎话——用户实锤的那句
 *  「敲那么久键盘，一句话也没落我这边」，两分钟前你们还在聊备考。 */
const FRAME_ALONE = '你现在一个人待着，随口说一句话。'
const FRAME_AFTER = '你们刚聊过天（最近对话在下面），现在他忙别的去了。你嘴里冒出来的这半句，要跟刚才的话题沾点边——可以是余韵、是没说完的念头、是拐了个弯的联想，别当刚才没聊过。'
const LINES_BODY = [
  '要求：',
  '1. 10~25 个字，一句话，不要换行。',
  '2. 内容只能是你此刻的：你看到或听到的东西、一个没头没尾的念头、对他的一点观察、你刚做的一件小事。',
  '3. 不要提问（没人会回答），不要提醒他做事，不要问他累不累，不要说教，不要总结。',
  '4. 你是屏幕里的存在，没有会累的身体：绝不说自己肩膀酸、脖子僵、腰疼、眼睛花、手冷这类身体不适（他久坐时你可以提醒他，但别把自己代入进去）。也不许引用以前说过的身体状态（「还是老样子酸」这种）。',
  '5. 不要用「自言自语」的方式开头，不要加括号说明，不要说「我在想」——直接把话说出来。',
  '6. 允许没意义、允许半句话、允许小心眼。这本来就是废话。',
  '7. 只输出这一句。'
].join('\n')
const LINES = FRAME_ALONE + '\n' + LINES_BODY
/** 10 分钟内跟主人说过话就不自言自语（中间状态下说话也轮不到碎碎念） */
const JUST_TALKED_MS = 10 * 60 * 1000
/** 1 小时内的聊天算「刚聊过」，开场白换第二副面孔 */
const AFTER_CHAT_MS = 60 * 60 * 1000

function createChatter (deps) {
  const log = deps.log || (() => { })
  const cfgGet = deps.cfgGet || (() => ({}))
  const state = deps.state || (() => ({}))
  const isBusy = deps.isBusy || (() => false)
  const say = deps.say // async (text) => void，由宿主接到 pet_say（speech:false）
  const note = deps.note || (() => { })
  // 0.35.0：在场判定 / 共享上下文（记忆+最近聊天）/ 整体负反馈
  const presence = deps.presence || (() => 'here')
  const sharedBlock = deps.sharedBlock || (() => '')
  const displeasure = deps.displeasure || (() => 0)
  const gapScale = deps.gapScale || ((d) => 1 + (Number(d) || 0) * 2.4)
  // 0.42.0：开口权交给全局节奏器（与看屏搭话共用一份预算）
  const rhythm = deps.rhythm || null
  // 0.45.44：最近几次主动说过的话（防「配合ノート」式复读）；主人上次说话的时间在 state().lastTalkAt
  const recentVoices = deps.recentVoices || (() => '')

  let timer = null
  let dayKey = ''
  let count = 0
  let stopped = true
  let lastSkip = ''

  function todayKey () {
    const d = new Date()
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  /** 下一次醒来的时间：跟着节奏器的下一个开口点走，但夹在 1~15 分钟之间 */
  function nextWait () {
    let ms = 4 * 60 * 1000
    if (rhythm) {
      try {
        const st = rhythm.status()
        ms = st.nextInMs > 0 ? st.nextInMs + 15_000 : 2 * 60 * 1000
      } catch { }
    }
    return Math.min(MAX_GAP, Math.max(MIN_GAP, ms))
  }

  function schedule (ms) {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, ms == null ? nextWait() : ms)
    if (timer.unref) timer.unref()
  }

  async function makeLine () {
    const c = cfgGet()
    if (!c || !c.apiBaseUrl || !c.apiModel) return ''
    let sinceTalk = Infinity
    try { sinceTalk = Date.now() - (Number(state().lastTalkAt) || 0) } catch { }
    // 0.45.44 开场白按聊天新近度换面孔
    const frame = sinceTalk < AFTER_CHAT_MS ? FRAME_AFTER : FRAME_ALONE
    let shared = ''
    try { shared = String(sharedBlock() || '') } catch { } // 0.45.42：sharedBlock 内部已按优先级排序+4000 截断，这里不再二次砍半
    let voices = ''
    try { voices = String(recentVoices(4) || '') } catch { }
    try {
      const res = await llm.chatStream({
        baseUrl: c.apiBaseUrl,
        apiKey: c.apiKey,
        model: c.apiModel,
        messages: [
          { role: 'system', content: String(deps.persona ? deps.persona() : '').slice(0, 900) },
          // 0.35.0：以前这里只有人设 + 一句指令，所以她自言自语的内容跟你们刚聊的完全无关
          // （真实使用反馈：自动说话和本体聊天记录看着没有关联）。
          // 现在把记忆和最近几条对话一起给她，让碎碎念接得上现实。
          ...(shared ? [{ role: 'system', content: '【你现在知道的事（记忆与你们最近的对话，碎碎念要能接上这些，别当没发生过）】\n' + shared }] : []),
          // 0.45.44：把自己最近几句递回去，明说别复读——没有这面镜子模型每次都凑同一个道具
          ...(voices ? [{ role: 'system', content: '【你最近几次主动说过的话（别再重复这些话题、道具和句式，换点别的来说）】\n' + voices }] : []),
          { role: 'user', content: frame + '\n' + LINES_BODY + '\n\n【当前时间】' + new Date().toLocaleString('zh-CN', { hour12: false }) }
        ],
        temperature: 0.95
      })
      return String(res.content || '').trim().replace(/\s*\n+\s*/g, ' ').slice(0, 60)
    } catch (err) {
      log('生成失败：' + (err && err.message))
      return ''
    }
  }

  async function tick () {
    if (stopped) return
    try {
      const k = todayKey()
      if (k !== dayKey) { dayKey = k; count = 0 }
      const hour = new Date().getHours()
      const q = Number(state().quiet) || 0
      // 0.45.44：刚跟主人聊完就闭嘴。用户实锤：16:48 聊完备考，16:50 她自言自语
      // 「敲那么久键盘，一句话也没落我这边」——明明话头就在她眼前，像独立出去的另一个人
      let sinceTalk = Infinity
      try { sinceTalk = Date.now() - (Number(state().lastTalkAt) || 0) } catch { }
      const justTalked = sinceTalk < JUST_TALKED_MS
      // 0.35.0：人不在就别说废话（她对着空房间碎碎念是最出戏的一环）
      let where = 'here'
      try { where = String(presence() || 'here') } catch { }
      const away = where !== 'here'
      // 整体负反馈高时，连自言自语都收着（不是只在看屏那条路上拦）
      let d = 0
      try { d = Number(displeasure()) || 0 } catch { }
      const quietNow = justTalked || count >= dailyMaxOf(cfgGet()) || hour < WAKE_HOUR || hour >= SLEEP_HOUR || q >= 0.6 || isBusy() || away || d >= 0.7
      // 0.42.0：本地条件都满足之后，再去问节奏器（它管的是「现在这个时刻该不该开口」）
      let gate = { ok: !quietNow, why: quietNow ? (justTalked ? 'just-talked' : 'local') : 'free' }
      if (quietNow) {} else if (rhythm) { try { gate = rhythm.ask('talk') } catch { gate = { ok: true } } }
      if (!gate.ok) {
        // 只在「卡住的原因变了」时留一行：既方便调（为什么她一直不说话），又不会每几分钟刷一遍日志
        if (gate.why !== lastSkip) log('[chatter] 先不说（' + gate.why + '）')
        lastSkip = gate.why
      } else {
        lastSkip = ''
      }
      if (gate.ok) {
        const text = await makeLine()
        if (text) {
          count++
          note(text)
          log('自言自语：' + text)
          try { await say(text) } catch { }
          if (rhythm) { try { rhythm.note('talk') } catch { } }
        }
      }
    } catch (err) {
      log('tick 异常：' + (err && err.message))
    } finally {
      // 不在场 / 被冷着 → 下次间隔拉长，别一回来就撞上一句
      let d = 0
      try { d = Number(displeasure()) || 0 } catch { }
      schedule(nextWait() * gapScale(d))
    }
  }

  return {
    start () {
      if (!stopped) return
      stopped = false
      dayKey = todayKey()
      // 起手不要立刻说：先等一个完整间隔，避免刚开机就冒一句
      schedule()
    },
    stop () {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
    }
  }
}

module.exports = { createChatter, MAX_PER_DAY, MIN_GAP, MAX_GAP, WAKE_HOUR, SLEEP_HOUR, LINES, FRAME_ALONE, FRAME_AFTER, LINES_BODY, JUST_TALKED_MS, AFTER_CHAT_MS, dailyMaxOf }
