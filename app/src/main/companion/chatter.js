'use strict'
/**
 * AI 伴侣 · 自言自语通道（chatter，0.46.0 表达决策化）
 *
 * 她说的话有两种：
 *   say       说给你听 —— 期待回应，被无视会计入负反馈
 *   narration 自言自语 —— 不期待回应，被无视也不受伤
 *
 * 只有第二种能做出「活人感」。一个只在有话要说时才开口的存在，再聪明也是助手；
 * 会碎碎念「好热」「这个字看了三遍还是没看懂」的，才像有人在家。
 *
 * 0.46.0（用户 11-02 自言自语系统）：旧版 tick 到点必生成一句，是「定时播报」不是
 * 「表达」。现在改成一次**决策**：素材里加上「此刻在干什么」（前台窗口、自主活动
 * 纪要、独白状态），模型自己选——保持安静（正常且常见的选择）/ 随口嘀咕一句 /
 * 围绕感兴趣的东西连续说几句（独白，soliloquy.js 管状态）。沉默不占当日预算。
 *
 * 规则（写死，防止变成骚扰）：
 *   - 每天最多 MAX_PER_DAY 次「真的开口」（节奏器之外的第二道保险，只管这一类）
 *   - 什么时候说，交给 rhythm.js（0.42.0）：同一份「每小时几次」的预算，
 *     但与「有话要说」那种共用一个池子——预算紧的时候先让位给后者
 *   - 只在清醒时段（WAKE_HOUR~SLEEP_HOUR）
 *   - 她太安静（quiet >= 0.6）时不念 —— 心情不好的人不会哼歌
 *   - 朗读（Fish Audio）：0.46.0 起默认开、低频——chatterVoiceOn × 概率
 *     chatterVoiceChance（默认 0.3）× 每日朗读上限 chatterVoiceDailyMax（默认 12）。
 *     多数时候只冒气泡，偶尔听见她在旁边嘀咕出声。
 *   - 绝不提问、不提醒、不说教 —— 判断标准：这句话没人接，也不尴尬
 */
const llm = require('./llm')
const voicesim = require('./voicesim')
const dayflow = require('./dayflow')   // 0.46.59 时间单源：nowBlockOf 与回复/自主活动共用一块
// 0.46.18 自言自语的语言要求：主聊天链路的【语言要求】在 index.js buildSystem，
// 这条链路不经过它——不注入模型就默认中文嘀咕，TTS 忠实念中文（用户实测）。
const { monologueLangBlock } = require('../../shared/lang-req')

const MAX_PER_DAY = 5
const MIN_GAP = 1 * 60 * 1000      // 0.42.0：只作为「被节奏器挡下之后再等多久」的下限
const MAX_GAP = 15 * 60 * 1000     // 上限：再久也该醒来看一眼节奏器放行了没
const WAKE_HOUR = 9
const SLEEP_HOUR = 23
/** 一场独白最多几句（与 soliloquy.MAX_LINES 一致，这里只是提示词里告诉她） */
const MONO_MAX_LINES = 4

/** 0.45.14 今日上限可调：cfg.chatterDailyMax（默认 5）× 高频模式（chatterBoostOn，×3，封顶 60）。
 *  高频是试险开关：让她的「活人感」更密，也更容易腻——默认关。 */
function dailyMaxOf (cfg) {
  const base = Math.max(1, Number(cfg && cfg.chatterDailyMax) || MAX_PER_DAY)
  const boost = (cfg && cfg.chatterBoostOn) ? 3 : 1
  return Math.min(60, base * boost)
}

/** 0.46.0 朗读参数（默认开、低频）。全部走 cfg，不硬编码进逻辑。 */
function voiceCfgOf (cfg) {
  // 0.46.11 默认必出声（用户：自言自语就该听得见，用轻声小音量才像嘀咕）；
  // 想要低频的老行为可以显式配 chatterVoiceChance=0.3
  const rawChance = cfg ? cfg.chatterVoiceChance : undefined
  const chance = rawChance == null ? 1 : Math.min(1, Math.max(0, Number(rawChance) || 0))
  return {
    on: !(cfg && cfg.chatterVoiceOn === false),
    chance,
    dailyMax: Math.max(1, Number(cfg && cfg.chatterVoiceDailyMax) || 12)
  }
}

/** 开场白按「多久没跟主人说话」分两副面孔（0.45.44）：
 *  刚聊完（<1h）还念「你现在一个人待着」就是睁眼说瞎话——用户实锤的那句
 *  「敲那么久键盘，一句话也没落我这边」，两分钟前你们还在聊备考。 */
const FRAME_ALONE = '你现在一个人待着，随口说一句话。'
const FRAME_AFTER = '你们刚聊过天（最近对话在下面），现在他忙别的去了。你嘴里冒出来的这半句，要跟刚才的话题沾点边——可以是余韵、是没说完的念头、是拐了个弯的联想，别当刚才没聊过。'
/** 0.46.0 决策提示词：先决定说不说，再决定说几句。「保持安静」必须是个正常选项。 */
const DECIDE_BODY = [
  '先判断：此刻有没有值得嘀咕的？多数时候可以沉默——输出一行 [沉默] 就好，这完全正常。',
  '有的话，输出 1~4 行，每行一句 10~25 个字，不要换行出句：',
  '- 只写 1 行：随口一句，说完就过。',
  '- 写 2~4 行：你在对着同一件事琢磨下去——观察、疑惑、猜测、修正，前后要连贯，像真的在想，不是同一句话换个说法。',
  '内容只能是你此刻的：你看到或听到的东西、一个没头没尾的念头、对他的一点观察、你刚做的一件小事、手头正摸到的东西。',
  '硬性规则：',
  '1. 不要提问（没人会回答），不要提醒他做事，不要问他累不累，不要说教，不要总结。',
  '2. 你是屏幕里的存在，没有会累的身体：绝不说自己肩膀酸、脖子僵、腰疼、眼睛花、手冷这类身体不适，也不许引用以前说过的身体状态。',
  '3. 不要用「自言自语」的方式开头，不要加括号说明，不要说「我在想」——直接把话说出来。',
  '4. 允许没意义、允许半句话、允许小心眼。这本来就是废话。',
  '5. 只输出 [沉默] 或那几行字，不要任何解释。',
  '6. 相对时间词必须换算：记忆和聊天记录里说的「今天/明天/昨天/今晚」都以**那句话记录的日期**为基准换算成绝对日期，再对照【当前时间】决定怎么说——他 11-05 说「明天开始学习」，到了 11-06 那个「明天」就是今天，绝不能照抄原词（11-06 实锤：他把学习定在今天，我嘴上还挂「明日から」）。'
].join('\n')
const LINES = FRAME_ALONE + '\n' + DECIDE_BODY
/** 10 分钟内跟主人说过话就不自言自语（中间状态下说话也轮不到碎碎念） */
const JUST_TALKED_MS = 10 * 60 * 1000
/** 1 小时内的聊天算「刚聊过」，开场白换第二副面孔 */
const AFTER_CHAT_MS = 60 * 60 * 1000

/** 0.46.0 决策结果解析（纯函数，可单测）：[沉默]/[独白完]/每行一句（≤4） */
function parseDecision (raw, soliloquy) {
  const text = String(raw || '').trim()
  if (!text || /^\[沉默\]$/.test(text)) return { silent: true, lines: [] }
  // 独白收尾标记：说通了 → 关掉独白，这轮不再出声
  if (/^\[独白完\]$/.test(text)) {
    if (soliloquy) { try { soliloquy.close('done') } catch { } }
    return { silent: true, lines: [] }
  }
  // 每行一句，最多 4 句；剥掉可能的序号/引号
  const lines = text.split(/\n+/)
    .map((s) => s.replace(/^\s*(?:[-*·]|\d+[.、)])?\s*/, '').replace(/^["「『]|["」』]$/g, '').trim())
    .filter((s) => s && !/^\[(沉默|独白完)\]$/.test(s))
    .slice(0, MONO_MAX_LINES)
    .map((s) => s.slice(0, 60))
  if (!lines.length) return { silent: true, lines: [] }
  return { silent: false, lines }
}

function createChatter (deps) {
  const log = deps.log || (() => { })
  const cfgGet = deps.cfgGet || (() => ({}))
  const state = deps.state || (() => ({}))
  const isBusy = deps.isBusy || (() => false)
  const say = deps.say // async (text, { speech }) => void，由宿主接到 pet_say
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
  // 0.46.0：连续独白状态机 + 此刻的活动素材（宿主注入，可为空）
  const soliloquy = deps.soliloquy || null
  const activity = deps.activity || (() => '')
  // 0.46.50 被吞句变资产：咽回去的话不再无痕消失——① 落事件流（日记里就是
  // 「我本来想说但没说」）；② decide 时把最近的念头池递回去，她可以把憋着的
  // 念头换个说法漏出来。都不算「说过的话」（不进 recentVoices 镜子）。
  const noteSwallowed = deps.noteSwallowed || null
  const swallowedRecent = deps.swallowedRecent || (() => [])
  // 0.46.51 情绪残余：被打断自主活动的扫兴残量（needs.deflated），影响语气
  const mood = deps.mood || null
  // 0.46.54 听觉：耳朵里此刻的声音特征（安静无事 → 空串，这整段不进预算）
  const hear = deps.hear || null

  let timer = null
  let dayKey = ''
  let count = 0
  let voiceDayKey = ''
  let voiceCount = 0
  let stopped = true
  let lastSkip = ''
  // 0.46.46 复读闸泄压阀：持续话题（盯同一块屏幕/同一件事）下，镜子把模型锚在
  // 同几个话题词上 → 生成的每句都跟最近说过的话撞车 → 连续几十分钟全被咽回去
  // （11-04 18:38~19:00 实锤：22 分钟 8 轮 24 句全吞、只漏 1 句；15/16/18 时
  // 每小时吞 27~30 句只放行 6~8 句）。连续咽回去够多就泄压放行一轮，但仍拦
  // 近似原句（score ≥ 0.5 的最像变体照吞），0.45.85「变着花样重复同一句」的
  // 防护保住底线。
  let swallowStreak = 0
  // 0.46.50 泄压放宽（用户 11-05「得到的负反馈还是有些保守了」）：真机 210 句/天被吞，
  // 5 句才泄压 + 0.5 分数线压得太死。阈值 5→3（持续话题下 ~2 分钟就能漏一轮），
  // 分数线 0.5→0.65（「话题相近但内容不同」的句子更容易活下来，最像的变体照吞）。
  const SWALLOW_ESCAPE = 3
  const SWALLOW_ESC_SCORE = 0.65

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

  /** 朗读这次的句子出不出声：开关 × 概率 × 每日上限 */
  function wantVoice (cfg) {
    const v = voiceCfgOf(cfg)
    if (!v.on) return false
    if (voiceCount >= v.dailyMax) return false
    const k = todayKey()
    if (k !== voiceDayKey) { voiceDayKey = k; voiceCount = 0 }
    if (Math.random() >= v.chance) return false
    voiceCount++
    return true
  }

  /** 0.46.0 一次决策：说不说、说几句。返回 { silent, lines }。 */
  async function decide () {
    const c = cfgGet()
    if (!c || !c.apiBaseUrl || !c.apiModel) return { silent: true, lines: [] }
    let sinceTalk = Infinity
    try { sinceTalk = Date.now() - (Number(state().lastTalkAt) || 0) } catch { }
    // 0.45.44 开场白按聊天新近度换面孔
    const frame = sinceTalk < AFTER_CHAT_MS ? FRAME_AFTER : FRAME_ALONE
    let shared = ''
    try { shared = String(sharedBlock() || '') } catch { } // 0.45.42：sharedBlock 内部已按优先级排序+4000 截断
    let voices = ''
    // 0.46.42 时间窗：镜子只放最近 90 分钟说过的话——旧台词挂「最近说过」
    // 会误导模型围着几小时前的话题打转，生成的新句又全被硬闸咽回去
    try { voices = String(recentVoices(8, voicesim.REPEAT_WINDOW_MS) || '') } catch { }
    let act = ''
    try { act = String(activity() || '') } catch { }
    // 0.46.50 念头池：最近咽回去的话递回去——她每天有一多半的生成被复读闸吃掉，
    // 这些念头是「想说没说的话」，攒着可以漏。只取近 2 小时的（更早的进日记就好）。
    let swallowed = ''
    try { swallowed = (swallowedRecent(3) || []).join('\n') } catch { }
    // 0.46.51 情绪残余：有扫兴残量就带一句语气基调（自然消散，没有就不出声）
    let moodLine = ''
    try { moodLine = String((mood && mood()) || '') } catch { }
    // 0.46.54 听觉：耳朵里此刻的声音（安静无事 → 空串）。嘀咕可以「听到」环境的动静，
    // 但她听到的是声音特征不是对话内容——提示词里说清楚，别让她编「他说了什么」。
    let hearLine = ''
    try { hearLine = String((hear && hear()) || '') } catch { }
    // 0.46.18 语言跟设置走：replyLang 固定语言时注入【语言要求】（auto=跟人设走，不注入）
    const langBlock = monologueLangBlock(c.replyLang)
    // 独白状态：正在独白就让她接着说（或收尾）
    const mono = soliloquy ? soliloquy.current() : null
    const monoBlock = mono
      ? '【你正在自言自语】你刚才在琢磨「' + mono.topic + '」，已经说了 ' + mono.lines.length + ' 句' +
        (mono.lines.length ? '：「' + mono.lines.slice(-2).join('」「') + '」' : '') +
        '。接着这往下说下一句（最多 ' + MONO_MAX_LINES + ' 句），想通了就正常收尾；没兴趣了输出 [沉默]，这件事就先放着。'
      : ''
    try {
      const res = await llm.chatStream({
        baseUrl: c.apiBaseUrl,
        apiKey: c.apiKey,
        model: c.apiModel,
        messages: [
          { role: 'system', content: String(deps.persona ? deps.persona() : '').slice(0, 900) },
          // 0.35.0：以前这里只有人设 + 一句指令，所以她自言自语的内容跟你们刚聊的完全无关
          // （用户原话：「自动说话的这个跟本体的聊天记录看的就像没有关联一样」）。
          // 现在把记忆和最近几条对话一起给她，让碎碎念接得上现实。
          ...(shared ? [{ role: 'system', content: '【你现在知道的事（记忆与你们最近的对话，碎碎念要能接上这些，别当没发生过）】\n' + shared }] : []),
          // 0.45.44：把自己最近几句递回去，明说别复读——没有这面镜子模型每次都凑同一个道具
          ...(voices ? [{ role: 'system', content: '【你最近几次主动说过的话（别再重复这些话题、道具和句式，换点别的来说）】\n' + voices }] : []),
          // 0.46.0：她此刻在干什么（前台窗口/自主活动纪要）——嘀咕要有内容依据，不许凭空编正在看的东西
          ...(act ? [{ role: 'system', content: '【你此刻的处境（屏幕前正在发生的事；和你的嘀咕对不上就别硬扯）】\n' + act }] : []),
          // 0.46.50 她憋着的念头：可以换个说法漏出来，多数时候放着也好
          ...(swallowed ? [{ role: 'system', content: '【你刚才想过又咽回去的话（复读闸替你收着的）】\n' + swallowed + '\n这些都是你想说又收住的念头。想说的可以现在漏出来——必须换个说法：更短、更随口、换个角度或只漏半句，别原样照搬（原样会再被收回去一次）；多数时候放着不说也完全正常，别为漏而漏。' }] : []),
          // 0.46.51 情绪残余：被打断的扫兴还没散时，嘀咕带一点那个语气
          ...(moodLine ? [{ role: 'system', content: '【你此刻的心情底色】\n' + moodLine }] : []),
          // 0.46.54 听觉：她有耳朵了——环境声音的响度/特征/突变（安静且无事时不注入）
          ...(hearLine ? [{ role: 'system', content: '【你耳朵里的世界（此刻的环境声音；你听到的是声音特征，听不出谁在说什么内容，别编「他说了什么」）】\n' + hearLine }] : []),
          ...(langBlock ? [{ role: 'system', content: langBlock }] : []),
          // 0.46.59 时间单源：换 nowBlockOf（带精确钟点+不报时措辞+旧约定过期判定），
          // 与回复/自主活动链路共用一块，别再各写一份（链路×2 修一处≠修完）
          { role: 'user', content: (monoBlock ? monoBlock + '\n' : '') + frame + '\n' + DECIDE_BODY + '\n\n' + dayflow.nowBlockOf() }
        ],
        temperature: 0.95
      })
      return parseDecision(String((res && res.content) || ''), soliloquy)
    } catch (err) {
      log('生成失败：' + (err && err.message))
      return { silent: true, lines: [] }
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
        const r = await decide()
        if (r.silent) {
          // 0.46.0 沉默是正常选择：不占当日预算，独白保持开着（下次接着想）
          log('[chatter] 她想了想，决定不说')
        } else {
          // 0.45.85 复读硬闸：提示词镜子（「别重复」）拦不住同一刺激物的变体修辞——
          // 用户实锤：对屏幕上同一行残留文字，一个半小时里变着花样嘀咕了 6 遍。
          // 生成结果再跟最近说过的话比一次，撞车的句子丢掉。
          let mirror = ''
          // 0.46.42 硬闸同款时间窗：时间窗外说过的不算复读（隔几小时再说相似的话不是复读机）
          try { mirror = String(recentVoices(8, voicesim.REPEAT_WINDOW_MS) || '') } catch { }
          const voiceList = mirror ? mirror.split('\n').map((s) => s.trim()).filter(Boolean) : []
          const escape = swallowStreak >= SWALLOW_ESCAPE
          if (escape) log('[chatter] 连续咽回去 ' + swallowStreak + ' 句，泄压放行一轮（近似原句照拦）')
          const keep = r.lines.filter((line) => {
            const rep = voiceList.length ? voicesim.isRepeat(line, voiceList) : null
            // 泄压时只拦最像的变体（score ≥ SWALLOW_ESC_SCORE），话题相近但内容不同的放行
            if (rep && rep.repeat && !(escape && rep.score < SWALLOW_ESC_SCORE)) {
              swallowStreak++
              // 0.46.50 被吞句入账：进事件流 suppress 类型——日记里成为
              // 「我本来想说但没说」，decide 时还能从念头池里换个说法漏出来。
              // 原来只进日志，每天 200+ 句生成无痕消失。
              try { if (noteSwallowed) noteSwallowed(line) } catch { }
              log('[chatter] 跟最近说过的话撞车（' + rep.against.slice(0, 20) + '），这句咽回去：' + line.slice(0, 30))
              return false
            }
            return true
          })
          if (keep.length) swallowStreak = 0
          if (!keep.length) {
            count++   // 全撞车：照样占当日预算，防止下一个 tick 再撞
          } else {
            // 多句 = 连续独白：开/续一场；单句：独白没开就只是随口一句
            const mono = soliloquy && keep.length > 1
              ? (soliloquy.current() || soliloquy.open(keep[0]))
              : (soliloquy ? soliloquy.current() : null)
            const speech = wantVoice(cfgGet())
            for (let i = 0; i < keep.length; i++) {
              count++
              note(keep[i])
              log((mono ? '独白' : '自言自语') + (keep.length > 1 ? '（' + (i + 1) + '/' + keep.length + '）' : '') + '：' + keep[i])
              try { await say(keep[i], { speech }) } catch { }
              if (i < keep.length - 1) await new Promise((res) => setTimeout(res, 2600))
            }
            if (soliloquy) {
              try {
                if (mono) { for (const line of keep) soliloquy.addLine(line) } else if (keep.length > 1) { soliloquy.open(keep[0]); for (const line of keep) soliloquy.addLine(line) }
              } catch { }
            }
            if (rhythm) { try { rhythm.note('talk') } catch { } }
          }
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

module.exports = {
  createChatter, MAX_PER_DAY, MIN_GAP, MAX_GAP, WAKE_HOUR, SLEEP_HOUR,
  LINES, FRAME_ALONE, FRAME_AFTER, DECIDE_BODY, LINES_BODY: DECIDE_BODY,
  JUST_TALKED_MS, AFTER_CHAT_MS, dailyMaxOf, voiceCfgOf,
  MONO_MAX_LINES, parseDecision
}
