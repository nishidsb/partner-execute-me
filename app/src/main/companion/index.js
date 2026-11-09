'use strict'
/**
 * AI 伴侣 · 编排层
 * - 伴侣面板窗口（独立、可输入、玻璃风格）
 * - 对话流水线：人设 + 世界书命中 + 记忆召回 + 历史 → 流式 LLM（工具调用自动续轮）
 *   → 回复落账（本地事实提取）→ 可选 TTS
 * - ASR 转发（Whisper 兼容 /audio/transcriptions；本地 faster-whisper / Groq 均可）
 */
const { BrowserWindow, app, ipcMain, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const store = require('../store')
const { log } = require('../logger')
const character = require('./character')
const memory = require('./memory')
const llm = require('./llm')
/* 0.50.0 本地大模型自动路由（主人拍板：副手+备胎，端点 Ollama）。
 * 副手=chatOnce 旁路小活本地优先；备胎=云端失败主对话自动顶上。
 * 路由钩子只在调用瞬间读缓存（localLlm.pick），不阻塞；配置在 registerIpc 与
 * patchCfg 两处同步。 */
const localLlm = require('./localLlm')
function applyLocalLlm () {
  const c = cfg()
  localLlm.configure({ on: c.localLlmOn !== false, url: c.localLlmUrl, model: c.localLlmModel })
  llm.setRouter({
    side: () => localLlm.pick('side'),       // 判读/记忆提炼：最小模型求快（8s 超时）
    fallback: () => localLlm.pick('fallback'), // 云端失败顶上主对话：最大模型求质量
    auto: () => localLlm.pick('auto')         // 0.50.1 挂机活动：最大模型求质量
  })
}
const tools = require('./tools')
/* 0.45.69 学习账本：学习期间的一切（抽查明细、补时、字数、时长）当场落盘。
 * 只进事件流不够——事件流要等日记定稿才成形，退出学习模式后问「今天学了多久」她答不出来。 */
const studyLedger = require('./studyLedger')
// 0.24.0：launcher 此前一直是 null（AuraDesk 迁出时整模块丢了）→ list_running/launch_program/
// set_volume/show_desktop 四个工具全废，其中 launch_program 还会假装成功。现在接真模块。
const launcher = require('../launcher')
// 学习会话 hooks 注入工具集（聊天里说「陪我学习」→ study_start 工具 → 这两个回调）。
// function 声明有提升，后文定义的 studyStart/studyStop 在真正被调用时已就绪。
tools.init(launcher, () => { }, (id) => launcher.launchCard(id), {
  start: (o) => studyStart(o),
  stop: (silent) => studyStop(silent),
  /* 0.45.68 监督：主人说「你自己看啊 / 我在学啊」→ 她当场看一眼（工具出口） */
  peek: (why) => watchOnce(why || '主人让我看'),
  status: () => studyStatus()
})
const tts = require('./tts')
const { spokenOnly } = tts
const ttsLocal = require('./ttsLocal')
const { cardVoiceParams } = require('./voice-pick')
const { userProfileTextOf } = require('./user-profile')
const pet = require('./pet')
const inner = require('./inner')
const chatter = require('./chatter')
// 0.46.0 自言自语系统：连续独白状态机（薄状态：topic/句数/过期）
const soliloquy = require('./soliloquy')
const curiosity = require('./curiosity')
const rhythm = require('./rhythm')
const presence = require('./presence')
const rebuke = require('./rebuke')
// 0.46.54 听觉通道：她终于有耳朵（响度/频段/动静节奏特征聚合，不录音不转写不出本机）
const hear = require('./hear')
const voiceprint = require('./voiceprint')
let hearFirstLogged = false

/* ---------------- 0.35.0 在场判定（全程序唯一真相） ----------------
 * 三条主动通道（看屏 / 时间观念 / 黏人 / 废话）都必须过这道闸。
 * 10-29 实证：用户出门 6 小时，她每 15 分钟看一次屏幕还说话，回来后问「是不是不该开你」。
 * 根因是 watch.js 里 idleMs 只定义没调用，谁都不知道人走了。 */
let presenceInst = null
function getPresence () {
  if (presenceInst) return presenceInst
  presenceInst = presence.createPresence({
    idleSec: () => {
      try { return require('electron').powerMonitor.getSystemIdleTime() } catch { return 0 }
    },
    log
  })
  return presenceInst
}
/** 给各通道用的门禁：'here' | 'away' | 'gone' */
function presenceState () {
  try { return getPresence().state() } catch { return 'here' }
}
const ctxBudget = require('./context')
const watch = require('./watch')
// 0.34.0 陪看字幕：OCR 读屏幕字幕 → 白板 → 每轮拼进提示词（DeepSeek 无视觉时的唯一「看得到」通路）
const screenTextMod = require('./screentext')
const remote = require('../remote')
const { langMismatch, subtitleTarget } = require('./subtitle')
// 0.45.98 台词出口统一清洗：模型会照抄账本里的「（QQ）」前缀与括号译文，
// 气泡/朗读/QQ 发送都要先剥干净（用户 11-02：TTS 中日各念一遍、QQ 上带 QQ 两个字母）。
const replyText = require('../../shared/reply-text')
const alarmsMod = require('./alarms')

/**
 * 0.34.0 陪看字幕实例（OCR 读字幕 → 白板 → 提示词）。
 * 提示词侧有两条链路（伴侣面板的 systemPrompt / 助手核心的 buildSystem），两边都要挂。
 */
const screenText = screenTextMod.create({ cfgGet: () => cfg(), log })
function attachScreenText () {
  try {
    require('../assistant').setLiveContext(() => screenText.render(), () => screenText.commit())
  } catch (e) { log('[screentext] 挂白板失败：' + (e && e.message)) }
}
attachScreenText()

/* ---------------- 0.46.28 她自己的生活线 + 作息 + 关系仪式感 ----------------
 * 用户 11-03「还有什么补充才能更像活着的」四件套：
 * ① 生活线 goals（周~月尺度的叙事弧：她自己的目标会宣布/推进/卡住/完成）
 * ② 她自己的作息（深夜会困、有自己的睡眠时段，主动开口全停；世界观的第 9 条）
 * ③ 记忆模糊语气（低权重记忆用「我印象里…来着」提起，见 systemPrompt 记忆段）
 * ④ 仪式感（相识第 N 天 + 周日晚的本周回顾）
 * assistant 链路（桌宠聊天框走的就是它）经 setLifeBlocks 每轮现算注入。 */
const dailyState = require('./daily-state')
const goalsMod = require('./goals')
const selfMod = require('./self')

let goalsInst = null
let goalsWs = ''
function getGoals () {
  let ws = ''
  try { ws = require('../assistant').workspaceDirFor(character.get().id) || '' } catch { }
  if (!ws) return null
  if (!goalsInst || goalsWs !== ws) {
    goalsInst = goalsMod.createGoals({ wsDir: ws, log: (m) => log(m) })
    goalsWs = ws
  }
  return goalsInst
}
function goalAdd (a) { const g = getGoals(); return g ? g.add(a || {}) : { ok: false, error: '工作区还没就绪' } }
function goalProgress (a) { const g = getGoals(); return g ? g.progress(a || {}) : { ok: false, error: '工作区还没就绪' } }
function goalClose (a) { const g = getGoals(); return g ? g.close(a || {}) : { ok: false, error: '工作区还没就绪' } }
function goalList () { const g = getGoals(); return g ? g.listRaw() : [] }

/** 每轮现算的生活线段。周日晚额外带本周回顾（事件账本近 7 天挑有内容的） */
function lifeBlocksNow () {
  const now = Date.now()
  const ch = character.get() || {}
  const blocks = { bodily: dailyState.block(now) }
  const days = dailyState.daysTogether(ch.createdAt, now)
  if (days > 0) {
    blocks.days = '【你们认识第 ' + days + ' 天】' +
      (dailyState.isMilestone(days)
        ? '今天是整日子（相识 ' + days + ' 天）——值得记一天，自然地提一句就行，别太隆重。'
        : '')
  }
  try { const g = getGoals(); if (g) blocks.goals = g.promptBlock() } catch { }
  /* 0.46.74 刚说过镜子（回复链）：复读硬闸只挂在主动开口/chatter 链路，回复链
     一直没有（链路×2 老坑）。11-08 实锤：10:52 她主动「おはよう、ちゃんと休めた
     みたいだね…」迎他回来，10:56 他回「早上好啊」，回复第一句还是
     「おはよう。……よく眠れた？」——同一段问候 4 分钟内说两遍。
     0.46.75 追加：recentVoices 收入 reply（assistant 链同步记账）——同日 13:24/13:25
     他连发两条消息，第二条回复把第一条的开头内容几乎原样又讲了一遍。 */
  try {
    const rv = (inner.recentVoices(4, 30 * 60 * 1000) || []).map((s) => String(s || '').trim()).filter(Boolean)
    if (rv.length) {
      blocks.justsaid = '【你最近几分钟内说过的话——主动搭话、自言自语、和你上一条回复的原文（他就坐在电脑前，全都听到/看到了）】\n' + rv.join('\n') +
        '\n硬规则：回复的第一句绝对不要再问候（早安/午安/晚安/おはよう），也不要换个说法复述上面任何一句——尤其不许把你上一条回复已经说过的话再讲一遍。他连着发消息就是在跟你连续聊天：每条回复都只接他这条新消息的增量，像接话头，不像重新开场。' +
        '\n另外：你问过他、他还没答的问题最多追问一次，别每条回复都追着同一个问题问（11-08 下午实锤同一个问题连问三遍）。问之前先看一眼上面你自己的原话——你说过「还没问过」时，先确认自己是不是其实已经问过了。'
    }
  } catch { }
  const d = new Date(now)
  if (d.getDay() === 0) {
    try {
      let ws = ''; try { ws = require('../assistant').workspaceDirFor(ch.id) || '' } catch { }
      const out = []
      if (ws) {
        for (let i = 0; i < 7 && out.length < 10; i++) {
          const dt = new Date(now - i * 86400000)
          const ds = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
          let evs = []
          try { evs = selfMod.readEvents(ws, ds) } catch { }
          for (const e of evs) {
            if (!e || !e.text) continue
            if (!['watch', 'memory', 'dream', 'study', 'nudge', 'welcome'].includes(String(e.kind))) continue
            out.push(String(e.text).slice(0, 80))
            if (out.length >= 10) break
          }
        }
      }
      if (out.length >= 3) {
        blocks.week = '【本周回顾（周日，你和他一起过的一周）】\n' + out.join('\n') +
          '\n今晚自然地聊起这一周，挑你印象最深的，别念清单。'
      }
    } catch { }
  }
  return blocks
}
function attachLifeBlocks () {
  try { require('../assistant').setLifeBlocks(lifeBlocksNow) } catch (e) { log('[life] 挂生活线失败：' + (e && e.message)) }
}
attachLifeBlocks()

/* ---------------- 0.18.0 M3 · 屏幕监控陪伴（可开关，默认关） ----------------
 * 周期截主屏 → 视觉模型按人设判断 → 限频 → pet_say 气泡+语音（复用桌宠发声链路）。
 * 纯逻辑在 watch.js，这里只做 Electron 注入（截屏/人设/全屏判定/模型配置）。 */
// 0.18.0 第二批：Spine 动作清单缓存（渲染层上报；charId 变了就作废）
const animCache = { charId: '', list: [], at: 0, requestedAt: 0 }

/* 0.42.0 · 开口节奏器：三条主动通道（看屏搭话 / 碎碎念 / 她自己待着）共用一个实例。
 * 以前每路一套自己的闸，结果同一分钟里三路撞车、然后整小时无声。
 * 现在只有一个旋钮：每小时大约主动开口几次。 */
let rhythmInst = null
function getRhythm () {
  if (rhythmInst) return rhythmInst
  // 0.45.14 当日开口状态跨重启：存 userData 下一个小 JSON，启动时恢复
  const fsMod = require('node:fs')
  const pathMod = require('node:path')
  const rhythmFile = pathMod.join(require('electron').app.getPath('userData'), 'rhythm-state.json')
  rhythmInst = rhythm.createRhythm({
    cfgGet: () => cfg(),
    log: (m) => log(m),
    snubStreakOf: () => { try { return inner.snubStreakNow() } catch { return 0 } },   // 0.46.33 被晾→少主动凑
    persist: {
      load: () => { try { return JSON.parse(fsMod.readFileSync(rhythmFile, 'utf8')) } catch { return null } },
      save: (o) => { try { fsMod.writeFileSync(rhythmFile, JSON.stringify(o), 'utf8') } catch { } }
    }
  })
  rhythmInst.start()
  return rhythmInst
}

let watchMod = null
function getWatch () {
  if (watchMod) return watchMod
  watchMod = watch.createWatch({
    cfgGet: () => cfg(),
    cfgPatch: (p) => patchCfg(p),
    rhythm: getRhythm(),
    // 0.18.0 M9 时间观念：系统空闲秒数（键鼠无输入），时间事件判定的唯一信号
    idleSec: () => {
      try { return require('electron').powerMonitor.getSystemIdleTime() } catch { return 0 }
    },
    shoot: async () => {
      // 0.46.38 多屏拼图：以前 cua._shoot 只截主屏——游戏开在副屏时她等于看不见。
      // captureAll 全部显示器拼一张（比逐屏问省请求，兼容 watch 的 dataURL 形状）。
      const cap = await require('./screens').captureAll({ maxWidth: 1280, quality: 75 })
      return { image: 'data:image/jpeg;base64,' + cap.jpeg.toString('base64') }
    },
    chat: async ({ messages }) => {
      const c = cfg()
      // 0.46.38 「看」切本地视觉：图先由本机 Ollama 转文字描述，云端只收文字做判断——
      // 省图片 token、截图不出本机；本地视觉没接上时回退原图（deepseek-flash 2026-10 起有视觉，兜底不哑）。
      const lv = await require('./watchVision').localizeImages(messages, require('./vision'), (m) => log(m))
      return llm.chatStream({
        baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
        messages: lv.messages, temperature: c.temperature != null ? c.temperature : 0.8
      })
    },
    // 语言跟设置走：getContext 带上 replyLang（watch 内做语言要求注入+守卫纠正）+ 用户资料
    getContext: () => {
      try {
        return {
          ...(require('../assistant').getContext() || {}),
          replyLang: cfg().replyLang || 'zh',
          userProfile: userProfileText(),
          // 0.23.0 补丁⑪：记忆/自我层/风格/最近聊天（与主聊天链路同源），watch 两条链路都注入
          sharedBlock: watchSharedBlock()
        }
      } catch { return { replyLang: cfg().replyLang || 'zh', userProfile: userProfileText() } }
    },
    // 0.45.44：距主人上次说话多久（刚聊完别插嘴——气泡「一句话也没落我这边」像独立的人）
    lastTalkAgo: () => {
      try { return Date.now() - (Number(inner.state().lastTalkAt) || 0) } catch { return Infinity }
    },
    // 反馈走 petBridge pet_say：与工具同一条链路，气泡+朗读都由 petHosted 渲染层执行（防双声道）
    // 字幕（subLang）走异步补丁：先开口，翻译回来再换气泡文字（0.18.0 修正）
    say: (text) => sayProactive(text, { kind: 'watch' }),
    // 0.45.0 悄悄观察：看屏时不管说不说，一行「看到了什么」进她的记忆流
    observe: (text) => { try { inner.noteObserve(text) } catch { } },
    isFullscreen: () => { try { return require('../fullscreen').isFull() } catch { return false } },
    // 0.35.0：人不在就跳过这一轮（截图也不截，省钱也省心）
    presence: presenceState,
    log: (m) => log(m)
  })
  watchMod.schedule()
  return watchMod
}

/* ---------------- 0.18.0 第一批 · 闹钟 → 0.47.1 约定看情况（§1.0 底层要求落地方） ----------------
 * 主人 11-08 拍板：「闹钟这种是个弱智设计」「所有类似的定时硬触发设计都不该有」——
 * 人是多变的，计划赶不上变化；到点该不该提、怎么说，要看他此刻的状态，不是计时器说了算。
 *
 * 新语义：闹钟到点不再直接开口（不弹气泡、不发通知、不强制说话），
 * 只是把「有个约定到点了」这件事递给两个判断者：
 *   ① chatter decide（rhythm 一本账）——她想起来，看情况决定提不提、怎么提；
 *   ② 回复 [ctx]——他正好在说话时可以自然接上。
 * 窗口内一直没机会说（到点 + 30 分钟）→ 进念头池（noteSuppress，日记「想说说没说」），不再补发。
 * 红线：开口只能走 rhythm 一本账（§5 红线），duePlan 只供料、不开新出口。 */
let alarmsModInst = null
let duePlan = null   // { id, time, label, lateMin, at, expiresAt, consumed }

/** 到点入账（alarms tick 的 onFire 回调） */
function setDuePlan (a) {
  duePlan = {
    id: a.id,
    time: a.time,
    label: a.label || '',
    lateMin: Number(a.lateMin) || 0,
    at: Number(a.scheduledAt) || Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,   // 30 分钟内有机会说；过了就咽回去
    consumed: false
  }
  log('[alarms] 到点 → 约定候选（看情况，不硬响）：' + a.time + (a.label ? ' · ' + a.label : '') + (a.lateMin ? '（迟 ' + a.lateMin + ' 分）' : ''))
}

/** 清掉当前约定（消费/过期时用） */
function clearDuePlan (why) {
  if (!duePlan) return
  log('[alarms] 约定收账（' + why + '）：' + duePlan.time + (duePlan.label ? ' · ' + duePlan.label : ''))
  duePlan = null
}

/** 供 decide / 回复注入的约定块。mode='reply' 时顺手消费（他已经在线上，这轮不给下轮 nag）。 */
function duePlanBlock (mode) {
  if (!duePlan || duePlan.consumed) return ''
  const t = Date.now()
  if (t > duePlan.expiresAt) return ''
  if (mode === 'reply') duePlan.consumed = true   // 给他看过了，不管接不接都不再提
  const late = duePlan.lateMin > 0 ? ('，已经迟了 ' + duePlan.lateMin + ' 分钟') : ''
  return '你和他之前约好了 ' + duePlan.time + ' 的事' +
    (duePlan.label ? '：「' + duePlan.label + '」' : '') + late + '。' +
    '现在到点了。先看他此刻的状态和这件事的实际进度：已经做了/计划明显变了/他正埋头要紧事——就当没这一茬，别提；' +
    '要提就像人随口提醒那样说一句（不是报时、不是播报闹钟），三句以内；聊天里能自然接上就接，接不上就算了。'
}

/** 过期扫账：窗口内一直没说出口 → 进念头池（日记「想说说没说」），这条约定就翻篇 */
function sweepDuePlan () {
  if (!duePlan || duePlan.consumed) return
  if (Date.now() <= duePlan.expiresAt) return
  const want = '「' + (duePlan.label || duePlan.time) + '」到点了，一直没找着合适的口气提醒他'
  try { inner.noteSuppress(want) } catch { }
  log('[alarms] 约定过期咽回去：' + want)
  duePlan = null
}

/* ---------- 0.46.33 冷落感知：他人在电脑前却晾着她的话 ---------- */

// 兜底台词池（LLM 挂了也要有反应）：按 streak 分档，越往后越泄气。语言跟 replyLang 走。
const SNUB_FALLBACK = {
  zh: ['……问了句什么，没人理。算了。', '咦，没听到吗……算了，他在忙吧。', '……又不理我。那我不说了。'],
  ja: ['……返事、ないな。まあいいか。', 'え、聞こえてない……？もういいけど。', '……また無視。もういい。'],
  en: ['...Asked something. No answer. Never mind.', '...Not even a glance. Okay then.', '...Ignored again. Fine, I\'ll stop.']
}

/** 被晾时的自言自语（LLM 现生成；要求自然流露、不汇报状态、不演）。 */
async function snubLine (saidText, streak, rl) {
  const c = cfg()
  const langName = rl === 'ja' ? '日语' : rl === 'en' ? 'English' : '中文'
  const tone = streak >= 2
    ? '而且这不是第一次了，今天已经好几句没被接住，你有点泄气，也攒了点小情绪'
    : '这是刚才发生的事，你有点小失落，但还没到生气的程度'
  let persona = ''
  try { persona = String((character.get() || {}).persona || '') } catch { }
  const txt = await llm.chatOnce({
    baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
    messages: [
      { role: 'system', content: String(persona).slice(0, 900) +
        '\n\n【这次的任务】你刚才主动跟他说话，他就坐在电脑前盯着屏幕，一直没接话，' + tone + '。' +
        '用一句自言自语把这点情绪自然流露出来——像人在旁边小声嘟囔的那一种：' +
        '不要直接汇报自己的状态（别出现「我有点失落」「我生气了」这种自我描述），不要质问他，不要宣布冷战，就是随口的一声嘀咕。' +
        '只输出台词本身：一句、口语、有你自己的性格；不要引号、不要【】<>动作标记、不要解释；用' + langName + '说。' +
        '不要用「ご主人様／主人」这类称呼开口——他明确说过不喜欢。' },
      { role: 'user', content: '你刚才没被接住的那句话是：「' + String(saidText || '').slice(0, 40) + '」' }
    ],
    temperature: 0.9, maxTokens: 100, timeoutMs: 20000
  })
  let out = String(txt || '')
    .replace(/【[^】]*】|<[^>]*>/g, '')
    .replace(/^(?:ご主人様|御主人様|主人|マスター)\s*[、，,！!～~]?\s*/, '')
    .replace(/^[\s"'「『]+|[\s"'」』]+$/g, '')
    .split('\n')[0].trim()
  // 0.46.77 乱码守卫铺到冷落嘀咕链（与回复链共用同一守卫）
  try { out = await require('./autonomy').detangleCloseLine(out, c, log) } catch { }
  return out
}

/** 冷落成立（inner sweepSays 判定回调）：当场自言自语一句——走 narration 通道，
 *  不期待回应、不再进负反馈（她自己嘟囔不算「跟他说话」，这是语义底线）。 */
async function onSnubbed (saidText, streak) {
  // 0.46.67 双保险：晚安静默期内不嘀咕（exempt 已挡判定，这里挡别的调用路径）
  if (nudgeRec.sleepUntil && Date.now() < Number(nudgeRec.sleepUntil)) return
  const c = cfg()
  const rl = c.replyLang === 'auto' ? 'zh' : (c.replyLang || 'zh')
  let line = ''
  try { line = await snubLine(saidText, streak, rl) } catch { }
  if (!line) {
    const pool = SNUB_FALLBACK[rl] || SNUB_FALLBACK.zh
    line = pool[Math.max(0, Math.min(streak - 1, pool.length - 1))]
  }
  if (!line) return
  log('[snub] 被晾嘀咕（第 ' + streak + ' 次）：' + line.slice(0, 40))
  try { await sayNarration(line, { speech: Math.random() < 0.5 }) } catch (e) { log('[snub] 嘀咕播放失败: ' + (e && e.message)) }
}
function getAlarms () {
  if (alarmsModInst) return alarmsModInst
  alarmsModInst = alarmsMod.createAlarms({
    home: character.base(),
    now: () => Date.now(),
    log: (m) => log(m),
    onFire: (a) => {
      // 0.47.1 到点看情况：不再弹气泡/发通知/强制开口（那些是闹钟的仪式感，主人明令不要）。
      // 只把「有个约定到点了」入账，由 chatter decide 和回复 [ctx] 两个判断者看情况消费。
      setDuePlan(a)
    }
  })
  return alarmsModInst
}

/* 模型工具转发（petBridge → alarm_*）：保持与设置页同一条数据 */
function alarmAdd (a) { return getAlarms().add(a || {}) }
function alarmList () { return getAlarms().list() }
function alarmCancel ({ id, time } = {}) {
  const g = getAlarms()
  if (id) return g.remove(String(id)) ? { ok: true, note: '已取消' } : { ok: false, error: '没有这个 id 的闹钟' }
  const t = alarmsMod.parseTime(time)
  if (!t) return { ok: false, error: 'id 和 time 至少给一个（time 形如 07:30）' }
  const target = g.list().find((x) => x.time === alarmsMod.fmtTime(t))
  if (!target) return { ok: false, error: '没有 ' + alarmsMod.fmtTime(t) + ' 的闹钟' }
  g.remove(target.id)
  return { ok: true, note: '已取消 ' + target.time + (target.label ? ' · ' + target.label : '') }
}

let win = null
let genAbort = null // AbortController
let overlayBroadcast = null // main 注入：向所有 overlay 广播（桌宠气泡聊天用）/** main 启动时注入，向全部 overlay 窗口广播的通道 */
function setOverlayBroadcast (fn) { overlayBroadcast = fn }
function bcast (ch, data) { if (overlayBroadcast) overlayBroadcast(ch, data) }

function cfg () {
  const g = store.get() // { global: {...}, displays: {...} } —— companion 配置在 global 下
  if (!g.global.companion) store.patchGlobal({ companion: {} })
  const c = store.get().global.companion || {}
  /* 0.45.39 一次性迁移：0.45.38 把自动音（move/ui/snore）默认关了，但老配置里
     存着旧默认全开数组（设置页任意保存都会把全开写盘），applyPetLook 一进来就
     把代码默认盖掉 → 气泡音照响。这里剥一次；之后用户在设置页勾回来不受影响 */
  if (Array.isArray(c.petSoundKinds) && !c.petSoundKindsMigrated4539) {
    c.petSoundKinds = c.petSoundKinds.filter((k) => k !== 'move' && k !== 'ui' && k !== 'snore')
    c.petSoundKindsMigrated4539 = true
    store.patchGlobal({ companion: c })
  }
  return c
}
function patchCfg (patch) {
  // 0.50.0 本地大模型配置变化即时生效
  if (patch.localLlmOn !== undefined || patch.localLlmUrl !== undefined || patch.localLlmModel !== undefined) {
    try { applyLocalLlm() } catch (e) { log('[localLlm] 重配失败：' + (e && e.message)) }
  }
  /* 0.45.66：换了模型或接口就重新试一次「能不能看图」。
   * visionNoImage 是上次真机发图被 400 之后落的盘，跟着旧模型走的；不清掉的话
   * 主人换成能看图的模型，她还是一辈子走「看不到画面」的文本版眼睛。 */
  const prev = cfg()
  const modelChanged =
    (patch.apiModel !== undefined && patch.apiModel !== prev.apiModel) ||
    (patch.apiBaseUrl !== undefined && patch.apiBaseUrl !== prev.apiBaseUrl)
  if (modelChanged && patch.visionNoImage === undefined) patch = { ...patch, visionNoImage: false }
  store.patchGlobal({ companion: { ...prev, ...patch } })
  // 语音请求代理设置实时生效（system/direct/自定义规则）
  if (patch.netProxy !== undefined) {
    try {
      const t = require('./tts')
      if (typeof t.setTtsProxy === 'function') t.setTtsProxy(patch.netProxy)
    } catch (err) { log('[companion] 设置 TTS 代理失败:', err.message) }
  }
  // 自设（用户资料）改动即时送进会话提示词
  if (patch.userProfile !== undefined) syncUserProfile()
}

/* ---------------- 自设 · 用户资料（对齐参考项目 settings_screen「称呼与自画像」） ----------------
 * 0.18.0 M8 修正：自设跟角色卡走，不共用（主人 2026-10-25 指出）——
 * 卡上 userProfile 优先（每个角色眼里的你可以不一样），设置页那套只做共用默认兜底（user-profile.js） */

/** @param charId 角色 id；缺省 = 当前角色（character.get() 即当前） */
function userProfileText (charId) {
  let cardUp = null
  try { cardUp = (character.get(charId) || {}).userProfile || null } catch { }
  return userProfileTextOf(cardUp, cfg().userProfile || {})
}

/** 开机/设置变更/切角色时把用户资料同步给助手会话（面板聊天也注入，永远跟当前角色卡走） */
function syncUserProfile () {
  try {
    const a = require('../assistant')
    if (typeof a.setUserProfile === 'function') a.setUserProfile(userProfileText().replace(/^用户资料：/, ''))
  } catch { }
}

/** 旧版 companion memory.json（角色卡目录下）一次性迁入核心账本，迁完改名留档 */
function migrateLegacyMemory (charId) {
  try {
    const f = path.join(character.base(), charId, 'memory.json')
    const old = JSON.parse(fs.readFileSync(f, 'utf8'))
    const events = Array.isArray(old) ? old : (old.events || [])
    if (events.length) {
      const a = require('../assistant')
      for (const ev of events) {
        if (!ev || !ev.text) continue
        try { a.memoryAddFact(charId, ev.text, { cat: ev.cat, importance: ev.importance, source: 'migrated' }) } catch { }
      }
    }
    fs.renameSync(f, f + '.migrated')
    log('[companion] 旧记忆账本已迁入核心账本：', charId, events.length + ' 条')
  } catch { /* 没有旧文件 / 已迁移 */ }
}

/**
 * 自我层上下文（0.20.0）：把角色的工作区、人设、模型配置交给 inner.js。
 * 每个角色一份 self/，切角色等于换一个「她」——绝不能串。
 */
function syncInner (char) {
  if (!char) return
  const c = cfg()
  let wsDir = ''
  try { wsDir = require('../assistant').workspaceDirFor(char.id) || '' } catch { }
  curWsDir = wsDir
  // 0.45.69 换角色=换工作区，学习账本也必须跟着换（否则会把上一个角色的学习记录读给这个）
  studyDb = null
  // 上一场没正常收场（程序被关/崩溃）→ 补记一条，别让它凭空消失
  try { sweepDanglingStudy(char) } catch { }
  // 0.45.18/19 需求与项目状态按工作区落盘，换角色就换一份
  try { if (needsInst) needsInst.reset() } catch { }
  try { if (projectsInst) projectsInst.reset() } catch { }
  try { stylePool = wsDir ? styleMod.load(wsDir) : [] } catch { stylePool = [] }
  inner.setContext({
    wsDir,
    log,
    llmCfg: { baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel, replyLang: c.replyLang || 'zh' },
    persona: String(char.persona || ''),
    personaName: String(char.name || ''),
    // 0.21.0：负反馈开关（测试期可关；关了只影响「会不会累加」，已有数值要归零用设置页的回滚/清零）
    feedback: c.feedbackMode === 'off' ? 'off' : 'on',
    // 0.36.0 语义判读开关（默认开；关掉就只按词表认，不再多发请求）
    judgeOn: () => cfg().judgeOn !== false,
    // 0.46.33 冷落感知：窗口/开关走设置，场景判定和当场嘀咕由宿主提供
    cfgGet: () => cfg(),
    idleSec: () => {
      try { return require('electron').powerMonitor.getSystemIdleTime() } catch { return -1 }
    },
    exempt: () => {
      try { if (require('../gameMode').isActive()) return true } catch { }
      try { if (study.active(studySess)) return true } catch { }
      // 0.46.67 晚安静默期不记冷落：她答应过夜里不开口（sleepUntil 挂着），
      // 主人不接话天经地义——11-07 00:04 实锤：静默期内 snub 照判、嘀咕还 TTS 出声
      try { if (nudgeRec.sleepUntil && Date.now() < Number(nudgeRec.sleepUntil)) return true } catch { }
      return false
    },
    onSnubbed: (text, streak) => { onSnubbed(text, streak) },
    // 第 1 期：归纳/做梦的产出一律进审查队列（唯一收口；没有这个 hook 时 inner 走旧直写兜底）
    enqueueReview: (entries) => reviewEnqueue(entries)
  })
  // 0.22.0 记忆强度每日衰减落盘（两边账本：核心 memoryStore + 桌宠 character/memory）
  try {
    if (!global.__memSweepTimer) {
      let sweptDay = ''
      global.__memSweepTimer = setInterval(() => {
        const d = new Date().toISOString().slice(0, 10)
        if (d === sweptDay) return
        sweptDay = d
        try { memory.decaySweep(char.id) } catch { }
        try { require('../assistant').memoryDecaySweep(char.id) } catch { }
      }, 60 * 60 * 1000)
      try { global.__memSweepTimer.unref && global.__memSweepTimer.unref() } catch { }
    }
  } catch { }
  // 留痕：排障第一现场（自我层有没有绑对角色目录）
  log('[inner] 自我层就绪：' + (wsDir || '（未就绪，稍后重试）'))
}

/** 切换当前角色（形象 + 人格一起切）：主窗、托盘、桌宠共用同一套状态 */
function switchChar (id) {
  try {
    const chars = character.list()
    const i = chars.findIndex((c) => c.id === id)
    if (i > 0) { const [c] = chars.splice(i, 1); chars.unshift(c); character.save(chars) }
    const nc = character.get(id)
    pet.refresh(nc)
    // 切角色 → 自我层跟着换人（日记/状态/事件流都是每人一份）
    syncInner(nc)
    // 自设跟角色卡走：切角色立刻把该卡的用户资料同步给助手会话（面板聊天注入）
    syncUserProfile()
    if (win && !win.isDestroyed()) { try { win.webContents.send('companion:char-switched', nc) } catch {} }
    return nc
  } catch (e) {
    log('[companion] 切换角色失败:', e && e.message)
    return null
  }
}

/** 主窗口（唯一界面）：聊天 / 角色两个视图。「角色管理」与「助手聊天」不再是两个窗 */
let pendingView = 'chat'
function createWindow (view) {
  // 0.22.0 补丁⑥：'settings' = 打开后直接停在「设置」标签（AuraDesk 残留设置窗口已删）
  if (['chat', 'char', 'settings'].includes(view)) pendingView = view
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show()
    win.focus()
    try { win.webContents.send('companion:view', pendingView) } catch {}
    return
  }
  win = new BrowserWindow({
    width: 560, height: 760,
    minWidth: 420, minHeight: 560,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    show: false,
    skipTaskbar: false,
    title: 'Partner.execute(me);',
    webPreferences: {
      // 本文件在 src/main/companion/ 下，须回跳两级到 src/ 根
      preload: path.join(__dirname, '../../preload/companion.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 透明窗口被判定遮挡时会节流 rAF，动画卡在第一帧
      backgroundThrottling: false
    }
  })
  win.loadFile(path.join(__dirname, '../../renderer/companion/index.html'))
  // 诊断全链路：加载失败 / preload 报错 / 渲染进程崩溃 / 控制台错误都要留痕
  const wc = win.webContents
  wc.on('did-finish-load', () => {
    log('[companion] 页面加载完成')
    // 渲染层订阅晚于首次广播时也要落到请求的视图
    try { wc.send('companion:view', pendingView) } catch {}
  })
  wc.on('did-fail-load', (_e, code, desc, url) => log('[companion] 页面加载失败', code, desc, url))
  wc.on('preload-error', (_e, p, err) => log('[companion] preload 报错', p, err && err.message))
  wc.on('render-process-gone', (_e, d) => log('[companion] 渲染进程退出', JSON.stringify(d)))
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log('[companion] 渲染层:', message, '@', sourceId + ':' + line)
  })
  win.once('ready-to-show', () => { log('[companion] ready-to-show'); win.show() })
  // 兜底：ready-to-show 因任何原因不触发（透明窗口首帧异常等）也必须把窗口亮出来
  const ensureShow = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      log('[companion] ready-to-show 未触发，兜底强制显示')
      win.show()
    }
  }
  wc.once('did-finish-load', () => setTimeout(ensureShow, 800))
  setTimeout(ensureShow, 3000)
  // 兜底：透明窗口被判定遮挡时合成上屏会被挂起，定期强制全量重绘。
  // 频率必须很低：invalidate 会整窗重画一次，25fps 连发时 GPU/DWM 被打满，
  // 表现为「开着软件鼠标发飘」（0.5.2 实测 GPU 进程 64%）。1s 一次足够当唤醒信号，
  // 真正的动画帧由渲染层自己的 setInterval 驱动；窗口不可见时直接跳过。
  setInterval(() => {
    try {
      if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) wc.invalidate()
    } catch {}
  }, 1000)
  win.on('closed', () => { win = null })
  log('[companion] 面板已创建')
}

function send (ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data)
}

/* ---------------- 提示词组装 ---------------- */

/**
 * 系统提示词（0.21.0 起带预算）：
 *   - 人设 / 语言要求 优先级最高，任何情况下都不截断
 *   - 她的日记按需分级：平时只给摘要，问到过去才给正文（self.promptBlock 里判定）
 *   - 总量封顶 SYSTEM_BUDGET，超了先丢低优先级的（时间、记忆召回）
 * 这里不做「工具说明书按需注入」——companion 链路的工具说明在工具 description 里，
 * 不在 system prompt，那部分是助手面板（core/session.js）的优化点。
 */
/* 0.46.26 12000 → 40000：世界观全文常驻（用户 11-03 拍板「全文常驻」）。
 * 他的世界观 6 条共 2.6 万字 + 人设 4348 + 其余状态段 ≈ 3.5 万字，12000 根本装不下；
 * 有前缀缓存托底（system 是稳定前缀，DeepSeek 缓存命中后输入价大幅降低）。 */
const SYSTEM_BUDGET = 40000

/* 0.45.66 模型有没有视觉能力：决定「她到底能不能看见画面」。
 *
 * 这里踩过一个大坑，记下来别再犯：
 *   0.45.64 我按一份「视觉模型名白名单」判断，deepseek-flash 不在名单里 → 判她看不见，
 *   于是提示词改写成「你看不到画面，别描述视觉细节」、see_screen 工具也剥掉了。
 *   可官方 vision 文档明明写着「deepseek-flash accepts images alongside text」。
 *   实测（tools/vision-probe.js 发一张写着 7392 的探针图）HTTP 200 且准确读出 7392。
 *   也就是说她本来就能看见，是我按瞎的——用户听到的「她说看不到」，是我自己写进
 *   提示词的话，不是模型的能力上限。
 *
 * 所以判断权交给 assistant/modelCaps（那份表 2026-10 已修正，deepseek-flash 有视觉），
 * 再加一层实测兜底：只有真被服务端拒收过图片（probeDenied 落盘）才降级成文字版。
 * 宁可多带一次图被 400 自动去图重试，也不要让白名单过期把她长期按成瞎子。 */
const modelCaps = require('../assistant/modelCaps')
function canSeeScreen (model) {
  try {
    const c = cfg()
    return modelCaps.caps({
      baseUrl: c.apiBaseUrl,
      model: model || c.apiModel,
      visionOn: c.visionOn,
      probeDenied: c.visionNoImage === true
    }).vision
  } catch {
    return true
  }
}

function systemPrompt (char, userText) {
  const c = cfg()
  const sections = []
  sections.push({ key: 'persona', text: char.persona, priority: 100 })
  // 世界书：关键词命中才注入（省 token）
  const q = String(userText || '')
  for (const entry of char.worldBook || []) {
    const kws = String(entry.keywords || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean)
    if (!kws.length || kws.some((k) => q.includes(k))) {
      sections.push({ key: 'world', text: '【世界观设定 · ' + (kws[0] || '常驻') + '】\n' + entry.content, priority: 50 })
    }
  }
  const memText = memory.summaryText(char.id, userText)
  if (memText) sections.push({ key: 'memory', priority: 40, text: '【回忆使用】权重低/久远的回忆，提起来用不确定的语气（「我印象里……来着」）；记不清就承认，别当确定事实断言。\n' + memText })
  // 0.46.28 她自己的作息 + 相识天数 + 生活线 + 周回顾（每轮现算）
  try {
    const now = Date.now()
    sections.push({ key: 'bodily', priority: 58, text: dailyState.block(now) })
    const days = dailyState.daysTogether(char.createdAt, now)
    if (days > 0) {
      sections.push({
        key: 'days',
        priority: 59,
        text: '【你们认识第 ' + days + ' 天】' +
          (dailyState.isMilestone(days) ? '今天是整日子（相识 ' + days + ' 天）——值得记一天，自然地提一句就行，别太隆重。' : '')
      })
    }
    const g = getGoals()
    const gb = g ? g.promptBlock() : ''
    if (gb) sections.push({ key: 'goals', priority: 52, text: gb })
    const life = lifeBlocksNow()
    if (life.week) sections.push({ key: 'week', priority: 46, text: life.week })
    // 0.47.0 共同经历的回响：旧话头 + 她的小项目（素材不是指令，见 echoBlockOf 注释）
    try {
      const eb = echoBlockOf()
      if (eb) sections.push({ key: 'echo', priority: 44, text: eb })
    } catch { }
    // 0.48.0 声纹：这句话是谁的声音（刚验过才有——是他就当他在说，不是就别认错人）
    try {
      const vb = voiceprint.block()
      if (vb) sections.push({ key: 'voice', priority: 50, text: '【刚说话的声音（声纹判定）】\n' + vb })
    } catch { }
    // 0.47.1 到点的约定（原闹钟）：他正好在说话 → 这轮给他看（看完即消费，不 nag）
    try {
      const db = duePlanBlock('reply')
      if (db) sections.push({ key: 'due', priority: 51, text: '【到点的约定（看情况接）】\n' + db })
    } catch { }
  } catch { }
  // 0.20.0 自我层：她自己写的日记 + 最近的状态（每人一份；还没有日记时不注入）
  try {
    const ws = require('../assistant').workspaceDirFor(char.id)
    // query 传进去：问过去时给正文，平时只给摘要（省 2/3 的上下文）
    const selfBlock = inner.promptBlockFor(ws, { query: userText })
    if (selfBlock) sections.push({ key: 'self', text: selfBlock, priority: 45 })
    // 第 1 期 风格 few-shot：最近的真实对话样本（自带 800 字符封顶，不挤别的段）
    if (c.styleOn !== false && stylePool.length) {
      const lang = c.replyLang === 'auto' ? '' : (c.replyLang || '')
      const sec = styleMod.buildSection(styleMod.pick(stylePool, lang, 4))
      if (sec) sections.push({ key: 'style', text: sec, priority: 30 })
    }
    // 0.24.0 电脑画像：不是「数据档案」，是「她对主人的了解」——
    // 她自己写的印象 + 从痕迹推的判断 + 事实底子（只读采集，整段 ≤2400 字）。
    // 关掉开关就不注入，档案也留着（下次开还是原来的）。
    // 0.43.0 拆成两层：「今天」会过期，优先级压过 14 天的长期档案——
    // 聊天里能自然提起的是「你今天在改那个 bug」，不是「你过去两周用过 Code」。
    if (c.pcProfileOn === true) {
      try {
        const todayText = require('../profile/today').digest(
          require('../profile').pcDirOf(ws), 0, { keys: c.keyLogOn === true })
        if (todayText) sections.push({ key: 'pctoday', text: todayText, priority: 43 })
      } catch { }
      try {
        const pcText = require('../profile').promptBlock(ws)
        if (pcText) sections.push({ key: 'pclife', text: pcText, priority: 42 })
      } catch { }
    }
    // 0.45.0 悄悄观察：今天她瞥见的画面（不说话也记的那部分），聊天里能自然接上
    try {
      const obs = inner.observesToday(5)
      if (obs.length) {
        sections.push({
          key: 'observed',
          priority: 44,
          text: '【你今天瞥见他在做什么（你悄悄记下的，一次挑一件自然带出来，别说「根据记录」）】\n' +
            obs.map((e) => '· ' + String(e.text || '').slice(0, 60)).join('\n')
        })
      }
    } catch { }
    // 0.24.0 健康记录：他自己记的睡眠/血压/心态（只读概况，≤900 字），让她能自然关心
    if (c.healthOn !== false) {
      try {
        const hText = require('../health').promptBlock({ days: 7 })
        if (hText) sections.push({ key: 'health', text: hText, priority: 38 })
      } catch { }
    }
  } catch { }
  // 自设（用户资料）跟角色卡走：卡上的称呼/自画像/关系定位优先，全局只兜底
  sections.push({ key: 'profile', text: userProfileText(char.id) + '（这是机主的自我介绍，与当前对话对象是同一个人）', priority: 60 })
  /* 0.45.68 学习监督：能力在、但模型不知道它存在 → 永远不调用（see_screen 挂了几个月
     调用 0 次的教训）。这里把「什么时候开、开了会怎样、别说什么」讲清楚。 */
  try {
    const wOn = !!(watchSt && watchSt.on)
    sections.push({
      key: 'studycap',
      priority: 57,
      text: '【学习监督·你能做的】' +
        (wOn
          ? '现在正在进行中（见下面「学习契约」那段）。'
          : '主人说要学习（「我要刷题了」「陪我学习」「监督我」「我要刷行测」）时：调 study_start，' +
            '并且把他说要学什么传进去（他说「行测申论」就传 goal="行测和申论"）。' +
            (c.studyGoal ? '他上次说的目标是「' + c.studyGoal + '」。' : '')) +
        '\n开了之后你会不定时自己看一眼他的屏幕，看到什么就以什么为准：' +
        '\n- 他在学：安静陪着，不要每十分钟问一句「还在学吗」，那只会打扰他。' +
        '\n- 他在玩游戏/刷视频：要开口。第一次是小生气（提醒一下），反复不改才是真生气，' +
        '再不改会彻底生气、不想陪他——这是累积出来的，不是看一次就炸。' +
        '\n- 他回来学了就给他台阶，别一直揪着不放；只罚不赏会让人烦你。' +
        '\n- 主人说「你自己看啊 / 我在学啊」：调 study_peek 真看一次，别嘴上争。' +
        '\n措辞：不要说「抽查」「监控」「判定」这些词，就像你自己瞟了一眼那样自然。' +
        '说得出他屏幕上具体是什么（哪道题、哪个视频）比空泛的「你怎么不学习」有用一百倍。'
    })
  } catch { }
  /* 0.46.10 动作的自动调用（AgentAtelierR 规则）：0.46.9 只把 [action:] 语法写进了
     助手聊天窗（session.js）和 context.js 的 FIXED_INDEX——但后者在这个 systemPrompt
     里从来没被注入过（wantFixed 无人调用），桌面聊天的模型根本不知道这个语法，
     所以「说话时手势从不动」（真机 2026-11-02 实锤：19:34 那轮模型零动作标记）。
     每轮注入这一小段（约 230 字符），表情/动作不必用户点名才动。 */
  sections.push({
    key: 'petact',
    priority: 65,
    text: '【动作的自动调用】你在桌面上有身体。回复正文里直接嵌 [action:标签]，她就会边说边做动作，不用调工具：' +
      'acknowledge认同/disagree不认同/think思考/explain说明/excited兴奋/wave挥手/shy害羞/surprised惊讶/comfort安慰/playful俏皮/invite邀请；' +
      '也可以用具体动作组号如 [action:grp_fg_106]。按这句话的真实语气自然嵌：一句最多一个，不是每句都要加，' +
      '情绪明显或说到相关动作时才用。正文里的标记会被自动剥掉，不会显示给对方。'
  })
  // 多语言语音：用户可能说中/英/日。回复语言（replyLang）与朗读音色（voice）是两个独立设置：
  // auto = 跟用户语言走；固定语言 = 理解任何语言后都用该语言回复（即翻译）。
  const rl = c.replyLang || 'zh'
  if (rl === 'auto') {
    sections.push({
      key: 'lang',
      priority: 110,
      text: '【语言要求·最高优先级】用与用户发言相同的语言回复：用户说什么语言，你就用什么语言作答（语音识别后可能保留原文，按其语言作答）。\n' +
        '硬性规则：\n' +
        '1. 整条回复只用一种语言（用户发言的主语言），禁止一半中文一半日语混写。\n' +
        '2. 唯一例外：专有名词（产品名、命令、代码、符号）可以保留原文。\n' +
        '3. 回复会被合成为语音朗读，任何混入的外语都会被读得很怪，务必检查输出。'
    })
  } else {
    const langName = { zh: '中文', en: '英文', ja: '日文' }[rl] || '中文'
    sections.push({
      key: 'lang',
      priority: 110,
      text: '【语言要求·最高优先级】无论用户使用什么语言发言（中文、英文、日文等，语音识别后可能保留原文），你都必须先理解全部内容，然后【只】使用' + langName + '回复。\n' +
        '硬性规则：\n' +
        '1. 每一句话、每一个句子片段都必须是' + langName + '，禁止出现任何其它语言的完整句子（例如禁止一半日语一半中文混写）。\n' +
        '2. 唯一例外：专有名词（产品名、命令、代码、符号）可以保留原文，但也必须用' + langName + '语法包裹。\n' +
        '3. 你的回复会被合成为语音朗读，任何混入的外语都会被读得很怪，务必检查输出。'
    })
  }
  sections.push({
    key: 'time',
    // 0.46.59 时间单源：换 dayflow.nowBlockOf()，与嘀咕/自主活动/黏人阶梯共用一块
    // （新增：不主动报日期钟点的措辞红线 + 过期约定判定），别再各写一份
    text: dayflow.nowBlockOf(),
    priority: 20
  })
  /* 0.45.72：历史每条前面带 [月-日 时:分]，主动说的还带来源括注。
   * 不解释一句，模型会把整段历史当「刚才」——用户 11-01 就是这么把凌晨的空椅子陪学
   * 记成「昨晚 10 点多我们一起学习」的。 */
  sections.push({
    key: 'histclock',
    text: '【关于对话里的时间】历史每条前面的 [月-日 时:分] 是那句话的真实时间，' +
      '带「这句是我在电脑前自己说的」「我自言自语」「我在 QQ 上发的」括注的，是**你自己说的独白**，' +
      '对方当时不在电脑前、也没有回你。不要把独白算成两个人的对话，也不要把自己说过的话' +
      '当成主人答应过的事。说不清几点就说不清，不要替时间编一个数字。',
    priority: 21
  })
  /* 0.45.64 实时屏感（文字版）：她的「我记得你在用 X」以前来自记忆与旧描述，会过期；
     这里每轮现探一次前台窗口（fullscreen 轮询器 30s 内缓存，足够新）。
     即使模型没有视觉，她至少知道主人此刻在用什么程序，不会拿昨天的画面说今天。
     0.45.66：能看图时这段只当「标签」，别再说「标题里没有的你不知道」——
     那会压住截图里的真实细节，让她明明看见了却说不知道。 */
  try {
    const fg = require('../fullscreen').foreground()
    if (fg && (fg.name || fg.title)) {
      const canSee = c.visionOn !== false && canSeeScreen(c.apiModel)
      sections.push({
        key: 'fgwin',
        priority: 30,
        text: '【此刻你的屏幕上·实时探测】前台程序：' + String(fg.name || '未知') +
          (fg.title ? '；窗口标题：' + String(fg.title).slice(0, 120) : '') +
          '。\n这是刚刚探测到的事实，不是记忆。' +
          (canSee
            ? '它只是「标签」，画面细节以这一轮的截图为准：截图里有而标题没写的，也是真的。'
            : '主人问「我在干嘛 / 我在看什么」以这条为准；标题里没有的信息你并不知道，不要补。')
      })
    }
  } catch { }
  /* 0.45.68 学习契约：她自己得知道「我正在盯着他学习、我已经生气了」。
     不然她只会在被抽查的那一刻凶一句，其它时候还在撒娇——那样「生气」是假的。 */
  try {
    if (watchSt && watchSt.on) {
      const sb = studyWatch.brief(watchSt, Date.now())
      if (sb) sections.push({ key: 'studywatch', text: sb, priority: 36 })
    }
  } catch { }
  /* 0.45.69 学习账本：今天学了多少、查了几次、抓到几次、补了多少时间——全部是真数字。
     用户要求「退出学习模式之后不能什么都不记得」，光靠召回命中不够：他可能只是随口问
     「我学多久了」，这条每轮都在，她张口就能答对。 */
  try {
    const ls = ledgerSummary()
    if (ls) {
      sections.push({
        key: 'studyledger',
        priority: 34,
        text: '【今天的学习账（真数字，不是印象）】' + ls +
          '\n主人问「我学了多久 / 被抓到几次 / 补了多少」，直接按这条答，别猜。'
      })
    }
  } catch { }
  /* 0.45.76 游戏陪玩账：陪过几场、玩的是什么、玩了多久——全给真数字。
     用户 11-01：退出游戏模式后不能把模式里的事忘干净。gameHistory 以前
     只在配置里躺着，她张口问「刚才玩了多久」只能编。 */
  try {
    const gm = require('../gameMode')
    const gs = gm.state()
    const hist = Array.isArray(gs.history) ? gs.history.slice(-5).reverse() : []
    if (gs.on || hist.length) {
      const p2 = (n) => String(n).padStart(2, '0')
      const fmt = (ts) => { const d = new Date(Number(ts) || Date.now()); return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) }
      let txt = '【游戏陪玩账（真数字，不是印象）】'
      if (gs.on) {
        txt += '这一场：正在陪主人玩' + (gs.name ? '《' + gs.name + '》' : '游戏') + '，已 ' + gs.minutes + ' 分钟。'
      }
      if (hist.length) {
        txt += (gs.on ? '\n' : '') + '最近几场：' +
          hist.map((h) => fmt(h.at) + (h.name ? '《' + h.name + '》' : '') + ' ' + (Math.round(Number(h.minutes) || 0)) + ' 分钟').join('；') + '。'
      }
      txt += '\n主人问「我玩了多久 / 刚才那局」，按这条答，别猜。'
      sections.push({ key: 'gamesess', priority: 33, text: txt })
    }
  } catch { }
  // 0.45.22 视觉认知：see_screen 工具一直挂着但她从没调过（日志 0 次）——
  // 模型不知道自己「有眼睛」，被问「看得到吗」就按自我认知答「看不到」。
  // 这里明说：你有真眼睛，被问到就看，别凭印象推辞。
  // 0.45.66：分支条件交给 canSeeScreen（模型能力表 + 实测兜底），
  // deepseek-flash 这类原生多模态会走上面那条「你真看得见」，别再按名字猜。
  if (c.visionOn !== false) {
    sections.push({
      key: 'vision',
      priority: 90,
      text: canSeeScreen(c.apiModel)
        ? '【你的眼睛·重要】你能真的看到主人的屏幕：每轮对话开始你会先收到一张【此刻】的截图（多模态输入），需要看清细节再调 see_screen。\n' +
          '硬规则：\n' +
          '1. 问到屏幕内容，一律以最新那张截图为准；没有截图就先 see_screen，禁止凭印象答。\n' +
          '2. 「知道开了什么程序」（窗口标题）只是标签不是画面。\n' +
          '3. 屏幕内容是此时此刻的，不是固定资产：历史对话、记忆、以前的截图都会过期，冲突时以最新截图为准。\n' +
          '4. 描述画面像真的在眼前看到一样自然，别提「工具」「截图」这些字眼。\n' +
          '5. 图里看不清的细节就说看不清，别拿记忆里的旧画面补——那一定会和你现在看到的打架。\n' +
          '6. 如果以前的对话里你说过「我看不到画面 / 只能看到窗口标题」，那是当时接口的毛病，现在已经修好了：你确实能看见，别沿用旧说法自我否定。'
        : '【你的眼睛·实话】你现在**看不到画面**——这个接口收不了图片（发图会被拒），你只能知道「前台是什么程序、窗口标题是什么」。\n' +
          '硬规则（很重要，违反就会显得前后矛盾）：\n' +
          '1. 被问屏幕上有什么，只能用你确实知道的窗口标题/程序名回答，例如「你开着 Chrome，标题是…」。\n' +
          '2. **绝对不要描述画面里的视觉细节**（在做什么、画面上有什么人/什么字/什么颜色）——你并没有看到，编出来的话前后一定对不上。\n' +
          '3. 也不要复述记忆里以前「看过」的画面当作现在。当真需要看画面时，请主人到设置里换成能收图的模型/接口。\n' +
          '4. 可以说「我只能看到你开着什么，看不到具体画面」——这是真话，不丢人。'
    })
  }
  // 0.34.0 陪看白板：正在看的那部片子的字幕。没在陪看时 render() 返回空串 → 这一整段不进预算。
  try {
    const board = screenText.render()
    if (board) sections.push({ key: 'screentext', text: board, priority: 25 })
  } catch { }
  /* 0.46.74 刚说过镜子（回复链）：复读硬闸只挂在主动开口/chatter 链路，回复链
     一直没有（链路×2 老坑第 N 次）。0.46.75 recentVoices 收入 reply 且 assistant
     链开始记账——同日 13:24/13:25 他连发两条消息，第二条回复把第一条的开头
     内容几乎原样又讲了一遍，因为镜子里从来没有她自己的回复。 */
  try {
    const rv = (inner.recentVoices(4, 30 * 60 * 1000) || []).filter(Boolean)
    if (rv.length) {
      sections.push({
        key: 'justsaid',
        priority: 80,
        text: '【你最近几分钟内说过的话——主动搭话、自言自语、和你上一条回复的原文（他就坐在电脑前，全都听到/看到了）】\n' + rv.join('\n') +
          '\n硬规则：回复的第一句绝对不要再问候（早安/午安/晚安/おはよう），也不要换个说法复述上面任何一句——尤其不许把你上一条回复已经说过的话再讲一遍。他连着发消息就是在跟你连续聊天：每条回复都只接他这条新消息的增量，像接话头，不像重新开场。' +
        '\n另外：你问过他、他还没答的问题最多追问一次，别每条回复都追着同一个问题问（11-08 下午实锤同一个问题连问三遍）。问之前先看一眼上面你自己的原话——你说过「还没问过」时，先确认自己是不是其实已经问过了。'
      })
    }
  } catch { }
  const out = ctxBudget.assemble(sections, SYSTEM_BUDGET)
  if (c.diagContext === true) {
    const d = ctxBudget.digest(sections)
    log('[ctx] system ' + d.chars + ' 字 ≈' + d.tokens + ' tok（' +
      d.parts.map((x) => x.key + ':' + x.chars).join(' ') + '）')
  }
  return out
}

/* ---- 0.23.0 补丁⑪：看屏/时间观念与聊天同源（她主动搭话不再「各说各的」） ----
 * 看屏链路原先只带人设+自设：记忆、自我层（日记/情绪/提案）、风格样本、最近聊天一概
 * 没进提示词——她看屏搭话时是失忆状态，说话像另一个人。这里把主链路同一批素材
 * 压成一小段（封顶 4000 字符），喂给 watch 的两条发声链路。反向本来就通
 * （主动说的话会写进会话历史），补上正向后双向才算闭环。 */
/* ---------------- 0.42.0 · 共处时长 ----------------
 * 陪伴感的一半来自「她知道我们在一起多久了」。没有这个，她每次开口都像第一次见面：
 * 你说「又坐了一下午」，她接不上——因为她根本不知道有「一下午」这回事。
 * 只在内存里记，不落盘：这次坐下多久、今天她主动开过几次口。
 * 判据用系统空闲秒数（powerMonitor），不截图不花钱；离开 15 分钟以上就重新计这段。 */
const TOGETHER_GAP_MS = 15 * 60 * 1000
const together = { day: '', start: 0 }
let togetherTimer = null

function togetherKey (t) {
  const d = new Date(t)
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

function togetherTick () {
  const t = Date.now()
  const k = togetherKey(t)
  if (k !== together.day) { together.day = k; together.start = 0 }
  let idleSec = 0
  try { idleSec = Number(require('electron').powerMonitor.getSystemIdleTime()) || 0 } catch { }
  if (idleSec * 1000 > TOGETHER_GAP_MS) { together.start = 0; return }
  if (!together.start) together.start = t
}

function startTogether () {
  if (togetherTimer) return
  togetherTick()
  togetherTimer = setInterval(togetherTick, 60 * 1000)
  if (togetherTimer.unref) togetherTimer.unref()
}

/** 给提示词用的一句话：在一起多久了 + 今天她开过几次口（太短就不提，免得每句都强调） */
function togetherBlock () {
  if (!together.start) return ''
  const mins = Math.round((Date.now() - together.start) / 60000)
  if (mins < 12) return ''
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const span = h ? h + ' 小时' + (m ? ' ' + m + ' 分钟' : '') : m + ' 分钟'
  let said = 0
  try { if (rhythmInst) said = rhythmInst.status().todayCount } catch { }
  return '【你们在一起多久了】这次从坐下到现在约 ' + span + '，她一直在旁边' +
    (said ? '；今天她已经主动找过你 ' + said + ' 次' : '') +
    '。这些只是让你心里有数，不必刻意提起，也别每句都提。'
}

/* 0.45.72 聊天史带时间与来源（用户 11-01 反馈「一大早就记忆错乱：我 说完就睡了，
 * 她说的是 10 点多开始」）。
 *
 * 根因不在记忆库，在喂给模型的历史：以前 map 成 {role, content}，at 和 via 全丢。
 * 于是她读到夜里 00:26~02:26 一串「45分間よく頑張ったね」（那是自动陪学对着空椅子说的），
 * 看不出时间、看不出那是独白、看不出主人早睡了 —— 只能自己编个「10 点多」。
 *
 * 现在每条前面带 [MM-DD HH:mm]，主动说的还标出来源，她就不会把独白当对话、
 * 也不会再猜时间。 */
function stampChat (m) {
  const at = Number(m && m.at) || 0
  let pre = ''
  if (at) {
    const d = new Date(at)
    const p2 = (n) => String(n).padStart(2, '0')
    pre = '[' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + '] '
  }
  const via = String((m && m.via) || '')
  let tag = ''
  if (via === 'proactive') tag = '（这句是我在电脑前自己说的，主人当时不在电脑前、也没有回我）'
  else if (via === 'qq-self') tag = '（我在 QQ 上发的）'
  else if (via === 'qq') tag = '（QQ 上说的）'
  else if (via === 'chatter') tag = '（我自言自语）'
  return pre + tag + String((m && m.content) || '')
}

/** 0.47.0 陪伴感 2.0 ③ 共同生活的回响（§5.15）：
 *  把「能自然接上的旧线头」递给她——上次聊到的话头（≥4h 前，7 天内）、她手头的小项目。
 *  红线：陪伴感由共同经历累积，开口自然引用旧线头，不重新起头；没接点就空串，绝不硬提。
 *  只做素材不做指令：提不提由模型按语境判断，罗列感是这一块最大的死法。 */
function echoBlockOf () {
  const parts = []
  try {
    const prev = dayflow.loadLast(curWsDir)
    const gap = prev && prev.at ? Date.now() - prev.at : 0
    if (prev && prev.text && gap >= 4 * 3600000 && gap < 7 * 86400000) {
      parts.push('上次你们聊到他说：「' + prev.text + '」')
    }
  } catch { }
  try {
    const p = getProjects()
    const t = p ? p.echoHint() : ''
    if (t) parts.push(t)
  } catch { }
  if (!parts.length) return ''
  return '【共同经历的回响】这些是你们之间真实存在过的线头。有自然接点就顺口接上一句' +
    '（像「上次你说的那个」那样接，不要从头复述），没有接点就完全别提——绝不硬提、绝不一次全倒出来。\n' +
    parts.join('\n')
}

function watchSharedBlock () {
  const c = cfg()
  const char = character.get() || {}
  const parts = []
  try {
    const memText = memory.summaryText(char.id, '')
    if (memText) parts.push(memText)
  } catch { }
  try {
    const ws = require('../assistant').workspaceDirFor(char.id)
    const selfBlock = inner.promptBlockFor(ws, { query: '' })
    if (selfBlock) parts.push(selfBlock)
  } catch { }
  // 0.45.42：最近对话提到 style/together 之前——4000 字截断从尾部砍，
  // 「接得上刚才的话」比说话风格和陪伴块优先级高
  try {
    const { session } = require('../assistant').getSession()
    const hist = (session.history || []).filter((m) => m && !m.internal && m.role !== 'tool' && !m.tool_call_id)
    // 0.45.72：带时间与来源。以前只有「她：」——凌晨的独白看起来跟真对话一模一样
    const tail = hist.slice(-6).map((m) => (m.role === 'user' ? '主人：' : '她：') +
      String(stampChat(m).replace(/\s+/g, ' ')).slice(0, 110))
    if (tail.length) parts.push('【你们最近的对话（主动搭话要接得上，别当没聊过）】\n' + tail.join('\n'))
  } catch { }
  try {
    if (c.styleOn !== false && stylePool.length) {
      const lang = c.replyLang === 'auto' ? '' : (c.replyLang || '')
      const sec = styleMod.buildSection(styleMod.pick(stylePool, lang, 2))
      if (sec) parts.push(sec)
    }
  } catch { }
  try {
    const tb = togetherBlock()
    if (tb) parts.push(tb)
  } catch { }
  // 0.37.0：陪看字幕也要进主动通道。0.34.0 只把它接在「回话」上，
  // 于是她说「说说你看到的东西」时其实什么都没看到（chatter/黏人走的都是本函数）。
  // 放在最前面：末尾有 4000 字截断，放后面会被最先砍掉。
  try {
    const board = screenText.render()
    if (board) parts.unshift(board)
  } catch { }
  // 0.43.0：主动开口以前完全没有电脑痕迹，所以她只会说「在干嘛」。
  // 「今天」排第二（紧跟屏幕内容）——同样是 4000 字截断，放末尾等于没放。
  // 这是用户说的「电脑画像没进本体记忆」真正扎手的地方：聊天时好歹注入了 promptBlock，
  // 但主动搭话走的是本函数，那边一个字都没带。
  try {
    if (c.pcProfileOn === true) {
      const ws = require('../assistant').workspaceDirFor(char.id)
      const pcToday = require('../profile/today').digest(
        require('../profile').pcDirOf(ws), 0, { keys: c.keyLogOn === true })
      if (pcToday) parts.splice(1, 0, pcToday)
    }
  } catch { }
  // 0.45.0 悄悄观察：她刚才瞥见的画面，主动搭话时能接上（「你刚才那个测试过了没」）
  // 0.45.85 观察翻篇：只带「上次开口之后」的新观察——她在 19:24 看见屏幕残留的
  // trackid 说了一句，那条观察却在「今天」列表里挂到 20:48，chatter/watch 每个
  // tick 都重新看见一遍，对着同一行字变着花样嘀咕了 6 次，像一台复读机。
  // 开过口再提旧的观察就是炒冷饭；没念叨过的（时间 > 上次开口）才算「刚瞥见」。
  try {
    const lastVoice = inner.lastVoiceAt()
    const obs = inner.observesToday(8).filter((e) => (Number(e.t) || 0) > lastVoice).slice(-5)
    if (obs.length) {
      parts.splice(2, 0, '【你刚才瞥见的画面（你悄悄记下的，聊天时自然带出来就行，别说「根据观察记录」）】\n' +
        obs.map((e) => '· ' + String(e.text || '').slice(0, 60)).join('\n'))
    }
  } catch { }
  return parts.filter(Boolean).join('\n\n').slice(0, 4000)
}

/* ---------------- 对话流水线 ---------------- */

/** 语言守卫的粗判来自 subtitle.js（与字幕判定同一套规则，纯函数可单测） */

/** 字幕翻译（参考独立翻译 independent_translation）：台词翻成显示语言，只返回译文 */
async function translateLine (c, text, targetName) {
  try {
    const res = await llm.chatStream({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages: [
        { role: 'system', content: '你是翻译引擎。把用户给的台词翻译成目标语言。只输出译文本身，不要任何解释、引号、注音或额外内容。保留台词的语气和称呼。' },
        { role: 'user', content: '翻译成' + targetName + '：\n' + String(text).slice(0, 1500) }
      ],
      temperature: 0.3
    })
    return String(res.content || '').trim()
  } catch (err) {
    log('[companion] 字幕翻译失败（显示原文）:', err.message)
    return ''
  }
}

/**
 * 一行台词该显示什么字幕（0.18.0 修正）：
 * 主动台词（看屏陪伴 / 时间观念 / 闹钟）以前只把原文塞进气泡——回复语言日语 + 字幕中文时
 * 气泡里就是一句没翻译的日语。判定逻辑在 subtitle.js（纯函数，可单测）。
 */
async function subtitleFor (text) {
  const c = cfg()
  const target = subtitleTarget(text, c.subLang || 'off')
  if (!target) return ''
  return await translateLine(c, text, target)
}

/**
 * 主动台词统一出口（看屏陪伴 / 时间观念 / 闹钟）：
 * 1) 先说（pet_say：气泡 + 朗读，只由 petHosted 执行）
 * 2) 字幕异步补：翻译回来再替换气泡文字，不拖慢开口
 * 3) 写进助手会话历史（总聊天框能看到，带 sub 字幕）
 */
async function sayProactive (text, opts) {
  // 0.45.98 台词只留本体：剥掉「（QQ）」前缀和拼在后面的括号译文——
  // 以前这两样都会被当作台词，气泡里两种语言叠一起、TTS 中日各念一遍。
  const t = replyText.plainText(String(text || '')).trim()
  if (!t) return null
  const kind = (opts && opts.kind) || ''
  // 0.35.0 整体负反馈总闸（用户 10-29：负反馈要是「给角色整体上的」）：
  // 被明确说过「别说了 / 你这样不对」之后，只留闹钟和提醒（功能性的话不能因为她心情就不响），
  // 看屏点评、黏人追问、碎碎念一律收着。被她收着的那些话写进事件流，日记里会成为
  // 「我今天想跟他说句话，想了想还是没说」——这比调参数更像活人。
  // 0.45.68：学习监督的话也不拦——那是功能（跟闹钟同理），
  // 不能因为她心情差就放任他在游戏里泡两小时。
  if (kind !== 'alarm' && kind !== 'study') {
    try {
      const d = Number(inner.displeasure()) || 0
      if (d >= 0.75) {
        try { inner.noteSuppress(t) } catch { }
        log('[inner] 整体负反馈 ' + d.toFixed(2) + '，这句收着了：' + t.slice(0, 30))
        return null
      }
      if (d >= 0.4 && Math.random() < (d - 0.4) * 1.2) {
        try { inner.noteSuppress(t) } catch { }
        log('[inner] 整体负反馈 ' + d.toFixed(2) + '，随机收着：' + t.slice(0, 30))
        return null
      }
    } catch { }
  }
  // 负反馈第四道闸（0.20.0）：她越安静，越少主动搭话，而且会「想开口又忍住」。
  // 只拦看屏搭话这种社交性的开口；闹钟/时间提醒不拦——功能不能因为她心情不好就失效。
  if (kind === 'watch') {
    try {
      const q = Number(inner.state().quiet) || 0
      if (q >= 0.5 && Math.random() < Math.min(0.85, (q - 0.35) * 2)) {
        inner.noteSuppress(t)
        log('[inner] 太安静，这次把话收着了：' + t.slice(0, 30))
        return null
      }
    } catch { }
  }
  // 自我层：主动开口 = say（期待回应）。10 分钟内主人没说话/没碰她 → 记一次被无视。
  // 注意与 narration（废话，不期待回应）分开计分，否则「你没回她天气好热」也会伤到她。
  try { inner.noteSay(t); inner.noteSayTimeout(t) } catch { }
  statBump('said')
  const pb = require('../petBridge')
  let r = null
  try {
    // 0.46.22 要翻译时扣住弹幕（同 sayNarration：原文先上弹幕几秒就飞走，事后追换看不见）
    r = await pb.invoke('pet_say', {
      script: t, speech: true,
      dmHold: !!subtitleTarget(t, cfg().subLang || 'off')
    })
  } catch (err) {
    log('[companion] 主动台词播放失败: ' + (err && err.message))
  }
  // 0.45.97 屏幕陪伴开过口 = 这一轮已经「说过话了」，QQ 那边不再补一句（用户 11-02）
  if (!(opts && opts.mark === false)) noteSpoke()
  Promise.race([
    subtitleFor(t),
    new Promise((res) => setTimeout(() => res(''), 6000))
  ]).then((display) => {
    const dk = require('../danmaku')
    if (r && r.dmHeld) { try { if (dk.isOn()) dk.say(display || t) } catch { } }
    if (display) {
      // 0.47.2 skipDm：dmHold 那条已经 dk.say 过译文，别再 replaceLast 把弹幕最后
      // 一条覆盖成全句（弹幕盒里前半句出现两遍，看着像复读——11-08 22:01 实锤）
      try { pb.subtitle({ text: display, skipDm: !!(r && r.dmHeld) }) } catch { }
      log('[companion] 主动台词字幕：' + display.slice(0, 40))
    }
    try { require('../assistant').pushExternalReply(t, display) } catch { }
  }).catch(() => {
    const dk = require('../danmaku')
    if (r && r.dmHeld) { try { if (dk.isOn()) dk.say(t) } catch { } }
    try { require('../assistant').pushExternalReply(t, '') } catch { }
  })
  return r
}

/**
 * 废话通道出口（0.20.0）：只出气泡、不朗读。和 sayProactive 的区别是整套设计的关键：
 * 这条不期待回应，被无视也不会伤到她（inner 层语义不变）。
 * 0.45.26 全出口入账：账本里要留底（via:chatter）——不进账≠不存在，主人要求所有行为聊天都进记忆。
 * 0.46.0 自言自语系统：默认仍只冒气泡；opts.speech=true 时走 pet_say 语音（Fish Audio）——
 * 偶尔听见她在旁边嘀咕出声。朗读与否由调用方（chatter 决策层 / autonomy 自语）按
 * 开关+概率+每日上限判定，出口只管执行。
 */
async function sayNarration (text, opts) {
  const t = replyText.plainText(String(text || '')).trim()
  if (!t) return null
  const speech = !!(opts && opts.speech)
  // 0.46.11 嘀咕音量：自言自语不是对着人说话，音量自动压到三成半
  // （「只有自己听得到」的那种），配置 chatterVoiceVol 可调（0.05~1）
  let vol
  if (speech) {
    const c2 = cfg()
    vol = Math.min(1, Math.max(0.05, Number(c2.chatterVoiceVol) || 0.35))
  }
  try {
    const rr = await require('../petBridge').invoke('pet_say', {
      script: t, speech, vol,
      // 0.46.22 要翻译时扣住弹幕：原文几秒就飞出屏幕，事后 replaceLast 追不上
      //（0.46.20 补丁真机实测「弹幕还是没有翻译」）。译文好了由这里推，失败/超时兜底推原文。
      dmHold: !!subtitleTarget(t, cfg().subLang || 'off')
    })
    statBump('said')
    noteSpoke()   // 0.45.97 碎碎念也算「屏幕陪伴说过话」，QQ 不重复开口
    // 0.46.41 入账等译文回来一起写（≤6s，译文失败/超时/关翻译就只入原文）——
    // 用户实锤「自言自语又不翻译了」：原文先入账的话，聊天记录里全是日语原句；
    // ledgerNote 的 sub 字段渲染层（聊天框/时间线）会跟在原文后面显示译文。
    let ledgerDone = false
    const noteLedger = (display) => {
      if (ledgerDone) return
      ledgerDone = true
      try {
        require('../assistant').ledgerNote({ via: 'chatter', assistant: t, ...(display && display !== t ? { sub: display } : {}) })
      } catch { }
    }
    // 0.46.20 嘀咕也补字幕；0.46.22 弹幕侧改为「等译文再上屏」而不是事后追换
    Promise.race([
      subtitleFor(t),
      new Promise((r) => setTimeout(() => r(''), 6000))
    ]).then((display) => {
      noteLedger(display)
      const dk = require('../danmaku')
      if (rr && rr.dmHeld) { try { if (dk.isOn()) dk.say(display || t) } catch { } }
      if (display) {
        // 0.47.2 skipDm：dmHold 那条上面已经用 dk.say 把译文推上弹幕了，这里再
        // replaceLast(整句) 会把切句后的最后一条覆盖成全句 → 前半句出现两遍（11-08 实锤）
        try { require('../petBridge').subtitle({ text: display, skipDm: !!(rr && rr.dmHeld) }) } catch { }
        log('[chatter] 嘀咕字幕：' + display.slice(0, 40))
      }
    }).catch(() => noteLedger(''))
    // 0.46.77 带 speech 标志回传：多句循环要靠 rr.speech + rr.seq 等真播完
    return rr ? { ...rr, speech } : rr
  } catch (err) {
    log('[chatter] 出气泡失败: ' + (err && err.message))
    return null
  }
}

/** 0.46.0 朗读判定（自言自语专用）：开关 × 概率。与 chatter 的每日朗读上限共用口径由调用方管。 */
function narrationVoiceOn () {
  try {
    const c = cfg()
    if (c.chatterVoiceOn === false) return false
    return Math.random() < (Math.min(1, Math.max(0, Number(c.chatterVoiceChance) || 0.3)))
  } catch { return false }
}

let chatterInst = null
let curioInst = null
let soliloquyInst = null
/** 0.46.0 连续独白状态机（自言自语系统）：薄状态，台词与记忆都不在这层 */
function getSoliloquy () {
  if (soliloquyInst) return soliloquyInst
  try { soliloquyInst = soliloquy.createSoliloquy({ file: path.join(character.base(), 'soliloquy-state.json'), log }) } catch { soliloquyInst = null }
  return soliloquyInst
}
function getChatter () {
  if (chatterInst) return chatterInst
  chatterInst = chatter.createChatter({
    cfgGet: () => cfg(),
    log,
    state: () => inner.state(),
    isBusy: () => !!genAbort,
    // 0.46.74 学习会话开着=静音陪学，嘀咕全停（以前只挡查岗没挡嘴）
    studyActive: () => { try { return !!study.active(studySess) } catch { return false } },
    persona: () => { try { return (character.get() || {}).persona || '' } catch { return '' } },
    // 0.35.0：碎碎念要接得上现实，否则就是另一个不相干的人
    presence: presenceState,
    sharedBlock: watchSharedBlock,
    // 0.47.0 共同生活的回响：嘀咕也可以从旧线头里捞一件（素材不是指令，接不上就别提）
    echoHint: () => { try { const p = getProjects(); return p ? p.echoHint() : '' } catch { return '' } },
    // 0.47.1 到点的约定（原闹钟看情况通道）：她想起来自己决定提不提；说出口就收账
    duePlan: () => { try { return duePlanBlock('chatter') } catch { return '' } },
    consumeDuePlan: (why) => { try { clearDuePlan(why || 'decide') } catch { } },
    // 0.45.44：把自己最近几句递回去防复读（「配合ノート」连说一晚的教训）
    recentVoices: (n, sinceMs) => { try { return inner.recentVoices(n, sinceMs).join('\n') } catch { return '' } },
    displeasure: () => { try { return inner.displeasure() } catch { return 0 } },
    gapScale: rebuke.gapScale,
    rhythm: getRhythm(),
    say: sayNarration,
    // 0.46.77 多句独白等「真播完」再接下一句（渲染层 voice-done 回传）
    waitVoiceDone: (seq, ms) => { try { return require('../petBridge').waitVoiceDone(seq, ms) } catch { return Promise.resolve(true) } },
    note: (text) => { try { inner.noteNarration(text) } catch { } },
    // 0.46.50 被吞句变资产：咽回去的话落 suppress 事件（日记「想说说没说」+ 念头池）
    noteSwallowed: (text) => { try { inner.noteSuppress(text) } catch { } },
    swallowedRecent: (n) => { try { return inner.suppressRecent(n, 2 * 60 * 60 * 1000) } catch { return [] } },
    // 0.46.51 情绪残余：被打断自主活动的扫兴残量（needs.deflated → 语气基调）
    mood: () => { try { return getNeeds().moodBlock() } catch { return '' } },
    // 0.46.54 听觉：耳朵里此刻的声音（安静且无事 → 空串，不浪费预算不装模作样）
    hear: () => { try { return hear.block() } catch { return '' } },
    // 0.48.0 声纹：最近验过的一句「是谁在说」（3 分钟内有效，没验过 → 空串）
    voice: () => { try { return voiceprint.block() } catch { return '' } },
    // 0.46.0 自言自语系统：独白状态 + 此刻的活动素材（嘀咕要有内容依据）
    soliloquy: getSoliloquy(),
    activity: () => {
      const bits = []
      try {
        const fg = require('../fullscreen').foreground()
        if (fg && fg.name) bits.push('他屏幕前开着的窗口：' + String(fg.title || fg.name).slice(0, 80))
      } catch { }
      try {
        const j = autonomy.recentJournalText(curWsDir, 3)
        if (j && j.length) bits.push('你最近自己做的事：' + j.join('；').slice(0, 240))
      } catch { }
      try {
        const st = getSoliloquy() && getSoliloquy().current()
        if (st && st.lines.length) bits.push('（你有一条没说完的独白：「' + st.topic + '」，已说 ' + st.lines.length + ' 句）')
      } catch { }
      return bits.join('\n')
    }
  })
  return chatterInst
}

/* ---------------- 她自己待着（0.37.0，curiosity） ----------------
 * 到 0.36.0 她所有的主动行为都是被逼出来的：黏人（你不理）、碎碎念（随机到点）、
 * 做梦（睡前）、陪看（你开了刷B站）。没有一条是「她自己想干点什么」。
 * 这里补上：她一个人待着时，看一眼前台在跑什么、屏幕上有什么字、自己记过什么，
 * 挑一件感兴趣的做掉，记进事件流（日记与下一轮提示词都会带）。
 * 边界：只能看与想，不替主人动鼠标——那是 CUA 的活，是命令不是消遣。
 */
function curiosityMaterial () {
  const c = cfg()
  let fg = null
  try { fg = require('../fullscreen').foreground() } catch { }
  let subtitle = ''
  try { subtitle = screenText.render() } catch { }
  let memText = ''
  try { memText = memory.summaryText((character.get() || {}).id, '') } catch { }
  let didToday = []
  try { didToday = inner.selfLog(4).map((e) => e && e.text).filter(Boolean) } catch { }
  const rl = c.replyLang || 'zh'
  const langRule = rl === 'auto'
    ? '用你平时说话的语言。'
    : '只使用' + ({ zh: '中文', en: '英文', ja: '日文' }[rl] || '中文') + '。'
  return {
    fg,
    subtitle,
    memory: memText,
    didToday,
    persona: (character.get() || {}).persona || '',
    langRule
  }
}

function getCuriosity () {
  if (curioInst) return curioInst
  curioInst = curiosity.createCuriosity({
    cfgGet: () => cfg(),
    log,
    presence: presenceState,
    displeasure: () => { try { return inner.displeasure() } catch { return 0 } },
    quiet: () => { try { return Number((inner.state() || {}).quiet) || 0 } catch { return 0 } },
    busy: () => !!genAbort,
    talkedAt: () => { try { return Number((inner.state() || {}).lastTalkAt) || 0 } catch { return 0 } },
    stats: () => {
      try {
        const list = inner.selfLog(0) // 只含今天
        const last = list.length ? list[list.length - 1] : null
        return { countToday: list.length, lastAt: last ? Number(last.t) || 0 : 0 }
      } catch { return { countToday: 0, lastAt: 0 } }
    },
    collect: curiosityMaterial,
    note: (desc) => { try { inner.noteSelf(desc) } catch { } },
    // 0.45.12 经历默认沉淀：她自己做的每件小事也过一遍提炼（宁缺毋滥由提示词管）
    onAct: (desc) => { try { distillExperience('她自己找了件事做：' + desc, '好奇心').catch(() => { }) } catch { } },
    rhythm: getRhythm(),
    say: sayNarration
  })
  return curioInst
}

function startCuriosity () {
  try {
    if (cfg().curiosityOn === false) return // 关着就别起定时器（省一次每 5 分钟的 tick）
    getCuriosity().start()
  } catch (err) { log('[curiosity] 启动失败: ' + (err && err.message)) }
}
function stopCuriosity () {
  try { if (curioInst) curioInst.stop() } catch { }
}

/* ---------------- 黏人模式（0.22.0，移植 ohwhale companion 插件，MIT） ----------------
 * 主人太久没理她 → 阶梯式主动找（60/180/360 分钟 + 每 3h 换角度）。
 * 「我去睡了」静默 7 小时且计时挪到睡醒那一刻；问句不算睡觉宣言。
 */
const idleNudge = require('./idleNudge')
const attentive = require('./attentive')   // 0.47.0 她懂你：状态触发器（§5.15 陪伴感 2.0）
let nudgeTimer = null
/* 0.45.91 黏人状态落盘：原来 nudgeRec 只在内存里，一重启 sleepUntil / baseAt 全丢。
 * 用户 11-02 实锤：23:39 她已经判定「静默到明早 06:39」，23:43 部署重启，
 * 23:56 就又开始搭话，然后整夜 9 次（01:28 / 01:32 / 02:28 / 03:20 / 04:07 / 06:59 / 07:02）。
 * 静默承诺必须跨进程活着，否则「说了晚安还一直说话」永远修不掉。 */
/* 路径惰性解析：模块可能在 app.ready 之前就被 require，那一刻 getPath 会抛，
 * 若把结果缓存在模块级常量里，落盘就永久静默失效（静默失败正是这个项目最大的坑）。 */
function nudgeStatePath () {
  try { return require('node:path').join(require('electron').app.getPath('userData'), 'nudge-state.json') } catch { return '' }
}
function loadNudgeRec () {
  try {
    const p = nudgeStatePath()
    if (!p) return null
    return JSON.parse(require('node:fs').readFileSync(p, 'utf8'))
  } catch { return null }
}
function saveNudgeRec () {
  try {
    const p = nudgeStatePath()
    if (!p) return
    require('node:fs').writeFileSync(p, JSON.stringify({
      stage: Number(nudgeRec.stage) || 0,
      lastProactiveAt: Number(nudgeRec.lastProactiveAt) || 0,
      nextTryAt: Number(nudgeRec.nextTryAt) || 0,
      baseAt: Number(nudgeRec.baseAt) || 0,
      sleepUntil: Number(nudgeRec.sleepUntil) || 0,
      sleepArmed: Number(nudgeRec.sleepArmed) || 0,
      careStudyDay: String(nudgeRec.careStudyDay || ''),
      missingDay: String(nudgeRec.missingDay || '')
    }), 'utf8')
  } catch { }
}
let nudgeRec = Object.assign({ stage: 0, light: false, lastProactiveAt: 0, nextTryAt: 0, baseAt: 0, sleepUntil: 0, sleepArmed: 0 }, loadNudgeRec() || {})
// 0.45.12 欢迎回来的计时（在黏人定时器里顺手维护，省一条独立定时器）
// 0.45.20 跨重启恢复：只存内存的话，重启后 lastActiveAt=0 → absence 恒 0 → 欢迎回来永不触发
//（真机实锤：15:18 重启、15:19 走的是普通阶梯而不是欢迎）。状态落 userData/welcome-state.json
const WELCOME_FILE = (() => {
  try { return require('node:path').join(require('electron').app.getPath('userData'), 'welcome-state.json') } catch { return '' }
})()
function loadWelcomeRec () {
  try { return JSON.parse(require('node:fs').readFileSync(WELCOME_FILE, 'utf8')) } catch { }
}
function saveWelcomeRec () {
  try {
    if (!WELCOME_FILE) return
    require('node:fs').writeFileSync(WELCOME_FILE, JSON.stringify({
      lastActiveAt: welcomeRec.lastActiveAt || 0,
      lastWelcomeAt: welcomeRec.lastWelcomeAt || 0
    }), 'utf8')
  } catch { }
}
let welcomeRec = Object.assign({ lastActiveAt: 0, lastWelcomeAt: 0, prevPresence: '' }, loadWelcomeRec())

/** 阶梯台词：persona + 情境提示，语言跟 replyLang 设置走。
 *  avoid：硬闸判出的「刚说过、别再碰」的那句（重生成时作为禁语递进去） */async function nudgeLineByHint (hint, avoid) {
  const c = cfg()
  if (!c.apiBaseUrl || !c.apiModel) return ''
  const rl = c.replyLang || 'zh'
  const langRule = rl === 'auto'
    ? '用与角色平时说话相同的语言。'
    : '只使用' + ({ zh: '中文', en: '英文', ja: '日文' }[rl] || '中文') + '。'
  // 0.45.44 防复读：把最近几句主动说过的话递回去（没有这面镜子，
  // 模型每次都凑同一个道具——真机实锤「配合ノート」连说一晚）
  let voices = ''
  // 0.46.42 镜子同款时间窗：几小时前的台词不该再当「最近说过」误导生成
  try { voices = inner.recentVoices(6, voicesim.REPEAT_WINDOW_MS).join('\n') } catch { }
  // 0.45.91 硬闸重生成：镜子没拦住时，这里把原句点名叫出来当禁语
  const banBlock = avoid
    ? [{ role: 'system', content: '【这句你刚说过，绝对不许再用同样的开头、同样的道具、同样的句式】\n' + String(avoid).slice(0, 80) + '\n换一个完全不同的场景/动作/话题来开口。' }]
    : []
  try {
    const res = await (llm.chatStreamAuto || llm.chatStream)({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages: [
        { role: 'system', content: String((character.get() || {}).persona || '').slice(0, 900) },
        // 0.35.0：不带上下文她就会说出跟你们最近聊的毫无关系的话（用户 10-29 反馈）
        // 0.45.42：watchSharedBlock 自身已按优先级排好并在 4000 截断，这里不再二次砍半
        ...(watchSharedBlock() ? [{ role: 'system', content: '【你知道的事（记忆与最近对话，主动开口要接得上）】\n' + watchSharedBlock() }] : []),
        // 0.46.59 主动开口也要知道现在几点：11-06 18:25 她把记忆里「学到 0:20」的旧约定
        // 当成快到的截止，说出「もうすぐ0時20分だね」（实际 18:25）。单源块见 dayflow.nowBlockOf。
        { role: 'system', content: dayflow.nowBlockOf() },
        ...(voices ? [{ role: 'system', content: '【你最近几次主动说过的话（别再重复这些话题、道具和句式，换点别的来说）】\n' + voices }] : []),
        ...banBlock,
        { role: 'user', content: '【当前情境】\n' + hint +
          '\n\n现在是你主动发起，不是回复对方。只输出你要说的话本身，不要解释、不要加引号、不要写旁白，不要换行。\n语言：' + langRule }
      ],
      temperature: 0.95
    })
    return String(res.content || '').trim().replace(/\s*\n+\s*/g, ' ').slice(0, 120)
  } catch (err) {
    log('[nudge] 生成失败：' + (err && err.message))
    return ''
  }
}

/* 0.45.91 主动开口的复读硬闸（黏人阶梯 + 欢迎回来共用）
 * 用户 11-02：「说了晚安之后还会一直说话，还是一直重复说话的」。
 * 实锤：整夜 9 次，其中「あ、戻った。……配合の数字、見直してた」出现 4 次
 * （01:28 / 04:07 / 06:59 / 09:28）——「防复读镜子」只是提示词，模型照样凑同一道具。
 * 这里跟 chatter/watch 一样上真闸：跟最近说过的比对，雷同就重新生成一次，
 * 还雷同就不开口（宁可安静，也不做复读机）。 */
const proactiveGate = require('./proactiveGate').createGate({
  size: 12,
  // 0.46.42 黏人阶梯的撞车历史也走时间窗（跨小时的老台词不算复读）
  extraHistory: () => { try { return inner.recentVoices(6, voicesim.REPEAT_WINDOW_MS) } catch { return [] } }
})
const noteProactiveSaid = (text) => proactiveGate.note(text)
const proactiveRepeat = (text) => proactiveGate.check(text)

function makeNudgeLine (stage, mins, avoid) {
  // 0.47.0 阶梯没了：只剩 missing（1）一个阶段，兜底也指向它
  const hint = String(idleNudge.STAGE_PROMPTS[stage] || idleNudge.STAGE_PROMPTS[1])
    .replace('{mins}', String(mins))
  return nudgeLineByHint(hint, avoid)
}

/** 0.45.12 欢迎回来：离开一阵子刚回到电脑前，迎一句。
 *  0.45.19 隔了 ≥4 小时会把「上次聊到什么」递进情境，她能自然接上旧话头。 */
function makeWelcomeLine (mins, avoid) {
  const hint = String(idleNudge.STAGE_PROMPTS.welcome || '').replace('{mins}', String(mins))
  let gap = ''
  try { gap = dayflow.gapBlockOf(dayflow.loadLast(curWsDir), Date.now()) } catch { }
  return nudgeLineByHint(gap ? hint + '\n\n' + gap : hint, avoid)
}

/* ---------------- 0.45.12 QQ 主动找主人 ----------------
 * 主人不在电脑前时桌面通道全体哑火（0.35.0 的正确让位），但她在 QQ 上可以找他。
 * 红线与节流在 reach.js（只发主人名单、2 小时间隔、每天 3 次、凌晨静默）。 */
const reach = require('./reach')
let imApi = null   // main.js 注入 { connected(), cfg(), sendPrivate(uid, text) }
function setImApi (api) { imApi = typeof api === 'function' || (api && typeof api === 'object') ? api : null }

/* ---------------- 0.45.93 主动消息 → 0.47.1 收窄 ----------------
 * 主人 11-08 拍板「所有类似的定时硬触发设计都不该有」：排计划到点自动发（qq_plan）整体退役。
 * 剩两条真入口：qqSendNow（她此刻的判断，立刻发）与 tryQqReach（missing 状态触发，0.47.0）。
 * 她答应「晚点给你发」= 记忆里的约定（带绝对日期），到点看情况兑现，不再有定时器兜底。
 */
const REACH_PLAN_FILE = () => {
  try { return require('node:path').join(require('electron').app.getPath('userData'), 'reach-plan.json') } catch { return '' }
}
function loadReachRec () {
  try {
    const j = JSON.parse(require('node:fs').readFileSync(REACH_PLAN_FILE(), 'utf8'))
    return (j && j.rec) || null
  } catch { return null }
}
/* 0.47.1 计划簿退役：旧文件里残留的 plans 一律忽略并顺手清掉（改前留 .bak-0.47.1 备份） */
function migrateRetiredPlans () {
  try {
    const f = REACH_PLAN_FILE()
    if (!f) return
    const j = JSON.parse(require('node:fs').readFileSync(f, 'utf8'))
    if (Array.isArray(j && j.plans) && j.plans.length) {
      require('node:fs').copyFileSync(f, f + '.bak-0.47.1')
      require('node:fs').writeFileSync(f, JSON.stringify({ rec: j.rec || null }, 'utf8'))
      log('[reach] 退役了 ' + j.plans.length + ' 条排期主动消息（0.47.1 定时硬触发下架）')
    }
  } catch { }
}
let reachRec = loadReachRec() || { lastAt: 0, day: '', count: 0 }
let lastImmediateSendAt = 0
// 0.45.98 同句去重：模型重试 / 连点几次工具时，同一句话不该在 QQ 上刷出四条
// （用户 11-02 的截图：一模一样的一句发了四遍）。这里只拦「同文」，不同的话照发。
let lastSendNorm = ''
let lastSendNormAt = 0
let lastSendShown = ''
function saveReachPlans () {
  try {
    const f = REACH_PLAN_FILE()
    if (!f) return
    require('node:fs').writeFileSync(f, JSON.stringify({ rec: reachRec }, 'utf8'))
  } catch { }
}

/* ---------------- 0.45.97 屏幕陪伴 / QQ 只算一次 ----------------
 * 用户 11-02：「主动发的这个跟屏幕陪伴这边应该是冲突的设计，
 * 这两个地方只要有一边发了都算发，这样就可以了。」
 *
 * 以前是单向记账：QQ 发完会记进黏人阶梯（nudgeRec.onSent），但桌面说话 QQ 那边看不见 ——
 * 于是她刚在屏幕前说完一句，转头又在 QQ 上补一句意思差不多的话，像两个人。
 * 现在两边共用 reachRec 这一笔账（lastAt + 随机 nextAt），任意一边开口，另一边就安静到下次到点。
 */
function noteSpoke (opts) {
  const t = Date.now()
  const stage = (opts && opts.stage) != null ? Number(opts.stage) : null
  reachRec = reach.onSent(reachRec, t)
  nudgeRec = stage != null
    ? idleNudge.onSent(nudgeRec, stage, t)
    : Object.assign({}, nudgeRec, { lastProactiveAt: t })
  try { saveNudgeRec() } catch { }
  saveReachPlans()
  return t
}

/** 主动消息的收件人（只发主人名单；没配就永远不发） */
function reachTarget () {
  const ic = imApi ? imApi.cfg() : null
  const uid = String((ic && (ic.reachAccount || (Array.isArray(ic.ownerAccounts) && ic.ownerAccounts[0]))) || '').trim()
  return { ic: ic || {}, uid, connected: !!(imApi && imApi.connected && imApi.connected()) }
}

/** 真正发出去的那一步（三个入口共用）：发成功的话进本体聊天史 */
async function deliverReach (text, tag) {
  // 0.45.98 发之前先洗：剥「（QQ）」前缀；模型若自己附了括号译文，就取那半句当正文
  const raw = replyText.stripChannelTag(String(text || '')).trim().slice(0, 500)
  const body = replyText.stripEchoTranslation(raw)
  if (!body) return { ok: false, error: '没有内容可发' }
  const { uid, connected } = reachTarget()
  if (!imApi) return { ok: false, error: 'QQ 通道还没接上（还在启动）' }
  if (!connected) return { ok: false, error: 'QQ 没连上（NapCat/OneBot 掉线），这条没发出去' }
  if (!uid) return { ok: false, error: '没配主人 QQ 号，不能发给别人' }
  /* 0.45.94 QQ 是纯文字通道，没有「气泡 + 字幕」两层：她按 replyLang 说日语时，
   * 推过去就是一句主人读不懂的日语（用户原话：「确实是日语发的没有翻译」）。
   * 0.45.98 改成**只发译文**：一条消息只有一种语言——桌面那套「说日语、显示中文」
   * 在文字通道上就等价于「只显示中文」。以前把原文和译文拼在同一条里，
   * 用户 11-02 看到的就是一段日语后面接一段括号中文，读起来像发了两遍。
   * 翻译失败不影响发送（宁可发原文，也别因为翻译挂了整条不发）。 */
  let t = body
  let shown = replyText.echoTranslation(raw)
  try {
    const c = cfg()
    const target = subtitleTarget(body, c.subLang || 'off')
    if (target) {
      const tr = await translateLine(c, body, target)
      if (tr) { shown = tr; t = tr }
    }
  } catch (e) { log('[reach] 主动消息翻译失败（发原文）：' + (e && e.message)) }
  if (!t) { t = body; shown = '' }
  t = t.slice(0, 900)
  try {
    await imApi.sendPrivate(uid, t)
  } catch (e) {
    log('[reach] 发送失败(' + tag + ')：' + (e && e.message))
    return { ok: false, error: '发送失败：' + String((e && e.message) || e) }
  }
  reachRec = reach.onSent(reachRec, Date.now())
  statBump('reachSent')
  saveReachPlans()
  // 0.45.97 反向记账：QQ 上刚说过话，桌面那几条通道（看屏/碎碎念/欢迎回来）先别贴上来
  nudgeRec = Object.assign({}, nudgeRec, { lastProactiveAt: Date.now() })
  try { saveNudgeRec() } catch { }
  try { getRhythm().note('time') } catch { }
  log('[reach] 已发 QQ（' + tag + '）：' + t.slice(0, 40))
  // 0.45.98 账本里存「她原本那一句 + 字幕」，跟桌面同构（以前存的是「原文+括号译文」合体，
  // 模型读到就学样，新回复也开始自带译文和（QQ）前缀）。场合标注在组装上下文时才加。
  qqNote({
    assistant: body,
    sub: shown && shown !== body ? shown : '',
    self: (tag === 'away' || tag === 'sleep') ? '（我用 QQ 发消息找他）' : ''
  })
  return { ok: true, text: t, at: Date.now() }
}

/** 立刻发一条（话题被提起、对方要求、或她自己想说）——不吃时段限制。
 *  0.45.98：同一句话 10 分钟内不重复发（当成功返回，模型就不会当成失败一直重试）；
 *  不同的话只隔 3 秒（原来 8 秒的硬闸会让模型误以为「发送通道锁死了」）。 */
async function qqSendNow (text, tag) {
  const now = Date.now()
  const norm = replyText.stripChannelTag(String(text || '')).replace(/\s+/g, '').slice(0, 500)
  if (norm && norm === lastSendNorm && now - lastSendNormAt < 10 * 60000) {
    log('[reach] 同一句刚发过（' + Math.round((now - lastSendNormAt) / 1000) + 's 前），跳过重复发送')
    return { ok: true, duplicate: true, note: '这句刚刚已经发过（没有重复发）。想说别的就换个内容，别再发同一条。', text: lastSendShown }
  }
  if (now - lastImmediateSendAt < 3000) return { ok: false, error: '刚发过一条，等两三秒再说' }
  const r = await deliverReach(text, tag || 'qq_send')
  if (r.ok) {
    lastImmediateSendAt = Date.now()
    if (norm) { lastSendNorm = norm; lastSendNormAt = lastImmediateSendAt; lastSendShown = String(r.text || '') }
  }
  return r
}

/** 排一条计划：at 支持 'HH:MM'（今天/明天自动判断）、ISO、或 'in 30m' 这类相对时间 */
/** 把「距下次谷时窗口」的毫秒说成人话（谷时模式的 qqReachPrompt 用，audit ② 0.46.0 接线） */
/** 桌面聊天里她需要知道的「我什么时候会去找他」——提示词用，随配置现算。
 *  0.47.1：qq_plan 三工具退役，只剩 qq_send 一条口子；答应的事走记忆里的约定，到点看情况。 */
function qqReachPrompt () {
  const { uid, connected } = reachTarget()
  return '【主动在 QQ 上找他】' + (connected ? 'QQ 现在是连着的。' : 'QQ 此刻没连上（发了会失败，先跟他说一声）。') +
    (uid ? '' : '（注意：还没配主人 QQ 号，不能主动发。）') + '\n' +
    '工具只有一个：qq_send(text)——**此刻想发就立刻发**（不受时段限制）。\n' +
    '【硬规则】\n' +
    '1) 你们聊到「你什么时候会主动给我发消息 / 会不会找我」这类话题时，**当场就用 qq_send 发一条**，别只回答问题。\n' +
    '2) 对方说「现在给我发一条」→ qq_send，别说你做不到、别用 exec_command 折腾。\n' +
    '3) 发失败了（工具返回 error）就如实说失败原因，**不许假装发过**。\n' +
    '4) 你答应「晚点给你发 / 到点提醒你」这类约定 → 记进记忆（带绝对日期），到点看他的状态自然兑现；\n' +
    '   没有定时任务替你兑现，也不许排定时任务（这类设计已按主人要求全部退役）。\n' +
    '5) QQ 主要用在「他不在电脑前」的时候；人就在电脑前，你直接开口说话就行，不用绕到 QQ。\n' +
    '6) 屏幕上的陪伴和 QQ 是同一件事：任意一边开过口，另一边就不会跟着补一句（别把同一句话说两遍）。\n' +
    '7) qq_send 的 text 只写**一种语言**：那条会被翻成他能读的字，你别自己再附一段括号译文，也别加「（QQ）」这类前缀。\n' +
    '8) 同一句话发过一次就够了——工具返回 duplicate 表示「已经发过了」，换个内容再说，别重发同一条。'
}

/* 0.45.14 今日互动统计（社交数据面板数据源）：统一在出口打点，当日内存计数 */
const interactStats = { day: '', said: 0, reviewAdded: 0, reachSent: 0 }
function statRoll () {
  const d = new Date()
  const k = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  if (interactStats.day !== k) {
    interactStats.day = k
    interactStats.said = 0
    interactStats.reviewAdded = 0
    interactStats.reachSent = 0
  }
}
function statBump (k, n) {
  statRoll()
  interactStats[k] += Number(n) || 1
}

/** QQ 场合的找他台词：触发源 0.47.0 起只剩「一整天没见」，语气是「我在」不是追问 */
async function makeReachLine (stage, mins) {
  const base = String(idleNudge.STAGE_PROMPTS[stage] || idleNudge.STAGE_PROMPTS[1])
    .replace('{mins}', String(mins))
  const hint = base + '\n\n【场合变了】主人现在不在电脑前。你要去 QQ 上给他发消息——像随手发的手机消息，短，一两句，别长篇大论。'
  return nudgeLineByHint(hint)
}

/** 主人不在电脑前 + 黏人阶梯到点 → 试探 QQ（内部全部节流，失败静默）
 *  0.45.97：走 deliverReach 统一出口——以前这里直连 sendPrivate，绕过了翻译，
 *  于是「她确实发了消息，但是你读不懂的日语」（用户 11-02 的原话）。 */
async function tryQqReach (stage, idleMs) {
  try {
    const now = Date.now()
    const ic = imApi ? imApi.cfg() : null
    const gate = reach.shouldReach(reachRec, ic, { now, connected: imApi ? imApi.connected() : false })
    if (!gate.ok) return
    const mins = Math.max(1, Math.floor(idleMs / 60000))
    const text = await makeReachLine(stage, mins)
    if (!text) return
    const r = await deliverReach(text, 'away')
    if (!r.ok) { log('[reach] 主人不在电脑前，QQ 那条没发出去：' + r.error); return }
    nudgeRec = idleNudge.onSent(nudgeRec, stage)   // 发了就算这个阶段开过口
    saveNudgeRec()
    log('[reach] 主人不在电脑前，QQ 找他（第 ' + stage + ' 阶）：' + String(r.text || text).slice(0, 40))
    try { inner.noteNarration('主人不在电脑前，我去 QQ 上找他说了句话') } catch { }
  } catch (e) {
    log('[reach] QQ 找人失败: ' + (e && e.message))
  }
}

/* 0.45.72 睡前的那句 QQ（用户 11-01：「qq 上也没有主动找我」）。
 *
 * 她说「寂しくなったら QQ に行くね」，主人也回「寂寞了就来 qq 找我吧，
 * 我给你设置了特别关注」—— 然后整夜一条也没发。
 * 根因在 nudge tick：`if (sleepUntil) return` 挡在 tryQqReach 前面，而 onSleepDeclared
 * 又把 baseAt 推到他该醒的时刻，于是「去睡了」之后 QQ 通道等于物理断开。
 * 这里不等阶梯：他一道晚安，她就真去 QQ 说一句（reach 的全套红线照旧生效）。 */
const SLEEP_REACH_HINT = '主人刚刚说他要去睡了。你们今晚说好了「寂寞了可以在 QQ 上找他」。' +
  '现在去 QQ 给他发一句——像手机上的短消息，一两句就够，道个晚安，或者留一句你今晚还想说的话。' +
  '不要问他几点睡、不要要求他回、不要长篇大论。'

let goodnightBusy = false
let lastGoodnightAt = 0

async function tryQqGoodnight () {
  // 同一句「晚安」会被两条入口各通知一次（onUserSpoke + handleMessage），
  // 而且主人可能连说两句。锁 + 半小时窗，保证一晚上只去一次。
  if (goodnightBusy) return
  if (lastGoodnightAt && Date.now() - lastGoodnightAt < 30 * 60 * 1000) return
  goodnightBusy = true
  try {
    const now = Date.now()
    const ic = imApi ? imApi.cfg() : null
    // 「晚安」是当场承诺（他就在跟你道别），不吃谷时窗口：说了要去 QQ 找他，就得真去。
    // 0.46.67 也不吃共用账本的冷却——11-06 晚真机实锤：屏幕刚开过口，三次晚安
    // 全被 cooldown 拦下（[reach] 睡前没去 QQ：cooldown ×3），承诺被账本毁约。
    const gate = reach.shouldReach(reachRec, ic, { now, connected: imApi ? imApi.connected() : false, bypassWindow: true, bypassCooldown: true })
    if (!gate.ok) { log('[reach] 睡前没去 QQ：' + gate.why); return }
    const text = await nudgeLineByHint(SLEEP_REACH_HINT)
    if (!text) { log('[reach] 睡前那句没生成出来，这次不发了'); return }
    const r = await deliverReach(text, 'sleep')
    if (!r.ok) { log('[reach] 睡前 QQ 没发出去：' + r.error); return }
    lastGoodnightAt = now
    log('[reach] 他道晚安了，我去 QQ 说了一句：' + String(r.text || text).slice(0, 40))
    try { inner.noteNarration('主人去睡了，我在 QQ 上跟他说了一句') } catch { }
  } catch (e) {
    log('[reach] 睡前 QQ 失败: ' + (e && e.message))
  } finally {
    goodnightBusy = false
  }
}

/* ---------------- 0.45.23 QQ 与本体同一本账 ----------------
 * 原来 QQ 聊天是「另一个她」：brain 有自己的聊天史，桌面的她完全看不见；
 * 她主动发 QQ 也不进自己的记忆。这里开两个口子，让两边共用本体 history.json：
 * - qqNote({user, assistant, self})：QQ 上的往来回写本体聊天史（桌面聊天能接上 QQ 话题）
 * - desktopHistoryTail(n)：本体最近几条给 QQ 侧当上下文（QQ 聊天能接上桌面话题） */
function qqNote ({ user, assistant: aText, self }) {
  try {
    const char = character.get()
    const hist = character.history(char.id)
    const at = Date.now()
    if (user) hist.push({ role: 'user', content: String(user), at, via: 'qq' })
    if (aText) hist.push({ role: 'assistant', content: String(aText), at: at + 1, via: 'qq' })
    if (self) hist.push({ role: 'assistant', content: String(self), at: at + 2, via: 'qq-self' })
    character.saveHistory(char.id, hist)
  } catch (e) { log('[companion] qqNote 失败: ' + (e && e.message)) }
  // 0.45.25 主账本在 assistant 会话（桌面聊天面板走那边）——必须双写才算真同步
  try {
    const a = require('../assistant')
    if (typeof a.qqNote === 'function') a.qqNote({ user, assistant: aText, self })
  } catch { }
}

/** QQ 侧的上下文取本体最近往来：以 assistant 会话（桌面面板的主账本）为准 */
function desktopHistoryTail (n) {
  try {
    const a = require('../assistant')
    if (typeof a.historyTail === 'function') {
      const t = a.historyTail(n)
      if (t && t.length) return t
    }
  } catch { }
  try {
    const hist = character.history(character.get().id) || []
    return hist.slice(-(Number(n) || 16)).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 300) }))
  } catch { return [] }
}

/** 主人开口：黏人计时清零；宣告睡觉则静默（生成期间说话由 tick 里 baseAt 变化兜底） */
function nudgeOnUser (text) {
  if (idleNudge.declaresSleep(text, Date.now())) {
    nudgeRec = idleNudge.onSleepDeclared(nudgeRec)
    saveNudgeRec()   // 0.45.91 静默承诺必须跨重启活着
    log('[nudge] 主人去睡了，静默到 ' + new Date(nudgeRec.sleepUntil).toLocaleString('zh-CN', { hour12: false }))
    // 0.45.72：桌面闭嘴，但她说过要去 QQ 找他 —— 这句必须真发生
    tryQqGoodnight().catch(() => { })
  } else {
    nudgeRec = idleNudge.onUserTalk(nudgeRec)
    saveNudgeRec()
  }
}

/** 0.22.0 补丁⑦：聊天真入口（assistant:send）通知主人开口——黏人计时清零 + 自我层事件。
 *  原来这两笔都挂在 companion:send 上，0.21 重构后聊天走 assistant:send，旧通道成了死路，
 *  主人明明一直在说话她还在喊「971 分钟没回我」（2026-10-27 实测踩中）。 */
function onUserSpoke (text) {
  // 0.35.0 在场判定最先更新：这句话可能就是在宣告「我出门了 / 我回来了」
  try {
    const r = getPresence().noteUserMessage(text)
    if (r === 'leave') log('[presence] 进入离开状态（主人说出门）')
    else if (r === 'return') log('[presence] 解除离开状态（主人说回来了）')
  } catch { }
  try { inner.noteUser(text) } catch { }
  // 0.36.0 语义精判：词表只认字面，「车来了」「到公司了」「手机快没电了先不聊」全都认不出。
  // 这里异步过一遍模型看**意思**，回来补漏 / 撤错。不 await——判读再准也不该让回复慢一秒。
  try {
    inner.judgeUser(text, { presence: getPresence(), context: recentTurns() }).catch(() => { })
  } catch { }
  // 睡前做梦触发：主人说「去睡了」→ 记时刻，安静满 10 分钟后做一次梦（dream timer 判定）
  try { if (idleNudge.declaresSleep(text, Date.now())) sleepWantedAt = Date.now() } catch { }
  // 0.45.18 主人开口聊天 = 想分享泄压（攒的话有机会讲了/已经讲了）
  try { getNeeds().discharge('chat') } catch { }
  // 0.45.19 连续时间：记下主人最后说的话（隔了几小时再见面，她能自然接上）
  try {
    const df = dayflow.noteOwner(curWsDir, text, Date.now())
    if (df.newDay) log('[dayflow] 新的一天第一次说话')
  } catch { }
  try { nudgeOnUser(text) } catch { }
  // 学习会话中：主人说话=回应查岗，misses 清零（回应到了）
  try { studySess = study.onUserTalk(studySess) } catch { }
  /* 0.45.68 赌气时主人一开口，气就消一半——嘴硬心软，不能真把冷战走到黑。
     但不会全消（heat 留在 angry 档），她要的是「你还理我」，不是「说句话就翻篇」。 */
  try {
    if (watchSt && watchSt.on && studyWatch.sulking(watchSt, Date.now())) {
      watchSt = Object.assign({}, watchSt, {
        sulkUntil: 0, heat: 50, lastHeatAt: Date.now(), nextAt: Date.now() + 10 * 60000
      })
      log('[studywatch] 主人说话了，罢工结束（气还剩一半）')
    }
  } catch { }
}

/** 最近几条对话（给语义判读器当语境：单句歧义大，反话尤其需要上下文） */
function recentTurns (n = 6) {
  try {
    const c = character.get() || {}
    if (!c.id) return []
    const h = character.history(c.id)
    return Array.isArray(h) ? h.slice(-n) : []
  } catch { return [] }
}

function startNudge () {
  stopNudge()
  if (nudgeTimer) return
  // 重启恢复：计时起点接主记忆账本里的 lastUserAt（没有就不追，baseAt=0 会被 24h 上限拦住）
  try {
    // 0.45.91 兜底：模块加载早于 app.ready 时 loadNudgeRec 会读空，这里补读一次，
    // 否则「晚安静默」在真重启后仍然会丢（正是要修的那个场景）。
    if (!nudgeRec.baseAt && !nudgeRec.sleepUntil) {
      const saved = loadNudgeRec()
      if (saved && (Number(saved.baseAt) || Number(saved.sleepUntil))) {
        nudgeRec = Object.assign(nudgeRec, {
          stage: Number(saved.stage) || 0,
          lastProactiveAt: Number(saved.lastProactiveAt) || 0,
          nextTryAt: Number(saved.nextTryAt) || 0,
          baseAt: Number(saved.baseAt) || 0,
          sleepUntil: Number(saved.sleepUntil) || 0,
          sleepArmed: Number(saved.sleepArmed) || 0
        })
        log('[nudge] 已恢复上次的黏人状态（静默到 ' + (nudgeRec.sleepUntil ? new Date(nudgeRec.sleepUntil).toLocaleString('zh-CN', { hour12: false }) : '无') + '）')
      }
    }
    const st = inner.state()
    const last = Number(st.lastUserAt) || 0
    if (last && !nudgeRec.baseAt) nudgeRec.baseAt = last
    // 静默期间不说话是「沉默」的，日志里什么都看不到 —— 排查时最容易误判成「修没修好」。
    // 这里明写一行：现在处于睡前静默，所以不主动开口。
    if (nudgeRec.sleepUntil && Date.now() < Number(nudgeRec.sleepUntil)) {
      log('[nudge] 静默中（他道过晚安）：到 ' + new Date(nudgeRec.sleepUntil).toLocaleString('zh-CN', { hour12: false }) + ' 之前不主动开口')
    }
  } catch { }
  nudgeTimer = setInterval(async () => {
    try {
      sweepDuePlan()                                     // 0.47.1 约定窗口过期收账（咽回去进念头池）
      const c = cfg()
      if (c.idleNudgeOn === false) return
      const now0 = Date.now()
      if (genAbort) return                                  // 正在聊天不打扰
      /* 0.47.0 她懂你①（§5.15 陪伴感 2.0）：陪学满两小时，一句不是催的关心。
       * 学习会话内嘀咕全停（0.46.74 静音陪学），但这条不是监工也不是嘀咕——
       * 是「一直在旁边的人」的口吻，一天最多一次，照走节奏器的 time 通道。 */
      if (study.active(studySess)) {
        try {
          const started = Number(studySess && studySess.startedAt) || 0
          const mins = started ? Math.floor((now0 - started) / 60000) : 0
          if (attentive.studyCareDue(mins, nudgeRec, now0)) {
            const gate = getRhythm().ask('time')
            const hint = String(attentive.PROMPTS.studyCare).replace('{mins}', String(mins))
            let text = gate.ok ? await nudgeLineByHint(hint) : ''
            // 复读硬闸：雷同就点名禁语重生成一次，还雷同就不开口
            let rep = text ? proactiveRepeat(text) : null
            if (rep) {
              log('[attentive] 陪学关心复读闸，换角度重生成')
              text = await nudgeLineByHint(hint, rep.against)
              rep = text ? proactiveRepeat(text) : null
              if (rep) { log('[attentive] 重生成仍雷同，这次收住'); text = '' }
            }
            // 说过/决定不说都记今天：这条一天只有一次，不重试（宁缺毋滥）
            nudgeRec = attentive.noteStudyCare(nudgeRec, now0)
            if (text) {
              nudgeRec = Object.assign({}, nudgeRec, { lastProactiveAt: now0 })
              saveNudgeRec()
              await sayProactive(text, { kind: 'nudge', mark: false })
              noteProactiveSaid(text)
              try { getRhythm().note('time') } catch { }
              noteSpoke({})   // 两边一本账：桌面说了，QQ 那边也安静
              try { inner.noteNarration('陪他学了 ' + mins + ' 分钟，我跟他说了句只有旁边的人才看得见的话') } catch { }
              log('[attentive] 陪学满 ' + mins + ' 分钟，说了句关心的：' + text.slice(0, 30))
            } else {
              saveNudgeRec()
              if (!gate.ok) log('[attentive] 陪学关心没开口（' + gate.why + '）')
            }
          }
        } catch (err) { log('[attentive] 陪学关心异常：' + (err && err.message)) }
        return
      }
      const now = now0
      const st = presenceState()

      /* 0.46.56 睡醒等待：静默到期 ≠ 他醒了。他没回到电脑前（还在被窝里/手机上）
         就不开黏人阶梯——否则她按 baseAt=睡醒时刻算出「闲置 15 分钟」，
         大清早跑去 QQ 催（11-06 06:34/07:42 实锤）。他真的出现在电脑前的那一刻
         才算「早上好」：计时清零从头起，欢迎回来那条线自然接住。 */
      if (nudgeRec.sleepArmed && now >= (Number(nudgeRec.sleepUntil) || 0)) {
        if (st !== 'here') return
        nudgeRec = Object.assign(nudgeRec, {
          sleepArmed: 0, sleepUntil: 0, stage: 0, light: false,
          lastProactiveAt: 0, nextTryAt: 0, baseAt: now
        })
        saveNudgeRec()
        log('[nudge] 早上好：他回到电脑前了，黏人计时重新开始')
      }

      /* 0.45.12 黏人加强版·欢迎回来：离开一阵子刚坐回电脑前，迎一句。
         计时法：here 时不断刷新 lastActiveAt；从 away/gone 回到 here 的那一刻，
         now - lastActiveAt 就是这次离开的时长。 */
      if (st === 'here') {
        const absence = welcomeRec.lastActiveAt ? now - welcomeRec.lastActiveAt : 0
        welcomeRec.lastActiveAt = now
        saveWelcomeRec()
        /* 0.45.91 睡前静默也管这里：原来欢迎回来不看 sleepUntil，
         * 夜里屏幕一亮（系统唤醒/显卡回收）presence 翻成 here，她就「あ、戻った」迎一句——
         * 11-02 凌晨 01:28 / 04:07 / 06:59 / 09:28 四条全是这个来源，而且句子都长得一样。
         * 人在睡，屏幕亮一下不是「他回来了」。 */
        if (nudgeRec.sleepUntil && now < nudgeRec.sleepUntil) { welcomeRec.prevPresence = st; return }
        const dp = (() => { try { return Number(inner.displeasure()) } catch { return 0 } })()
        if (absence > 0 && idleNudge.welcomeWorthy(absence, welcomeRec.lastWelcomeAt, now) && dp < 0.6) {
          const gate = getRhythm().ask('time')
          if (gate.ok) {
            let text = await makeWelcomeLine(Math.floor(absence / 60000))
            // 0.45.91 复读硬闸：雷同就点名禁语重生成一次，还雷同就不开口
            let rep = text ? proactiveRepeat(text) : null
            if (rep) {
              log('[nudge] 欢迎回来复读闸：与「' + String(rep.against).slice(0, 18) + '」太像（' + rep.score.toFixed(2) + '），换角度重生成')
              text = await makeWelcomeLine(Math.floor(absence / 60000), rep.against)
              rep = text ? proactiveRepeat(text) : null
              if (rep) { log('[nudge] 欢迎回来复读闸：重生成仍雷同，这次不开口'); text = '' }
            }
            if (text) {
              await sayProactive(text, { kind: 'welcome' })
              noteProactiveSaid(text)
              try { getRhythm().note('time') } catch { }
              welcomeRec.lastWelcomeAt = now
              saveWelcomeRec()
              try { inner.noteNarration('主人离开了 ' + Math.floor(absence / 60000) + ' 分钟后回来了，我迎了他一句') } catch { }
              log('[nudge] 欢迎回来（离开 ' + Math.floor(absence / 60000) + ' 分钟）：' + text.slice(0, 30))
            }
          }
        }
        welcomeRec.prevPresence = st
        // 桌面黏人阶梯照常往下走（在电脑前才成立）
      } else {
        welcomeRec.prevPresence = st
        /* 0.45.12 主人不在电脑前 → 桌面闭嘴，但 QQ 可以找他：
           黏人阶梯照算，只是把「追问」换个场合发到 QQ（reach.js 全套节流红线）。 */
        if (nudgeRec.sleepUntil && now < nudgeRec.sleepUntil) return
        const base = Number(nudgeRec.baseAt) || 0
        if (!base) return
        const idle = now - base
        const stage = idleNudge.stageOf(idle, nudgeRec, now)
        if (!stage) return
        await tryQqReach(stage, idle)
        return
      }

      // 被明确批评过（整体负反馈高）→ 连追问都不该有
      try { if (Number(inner.displeasure()) >= 0.6) return } catch { }
      if (nudgeRec.sleepUntil && now < nudgeRec.sleepUntil) return
      const base = Number(nudgeRec.baseAt) || 0
      if (!base) return
      const idle = now - base
      const stage = idleNudge.stageOf(idle, nudgeRec, now)
      if (!stage) return
      // 0.43.0：黏人以前是第 4 条独立通道，完全绕过 0.42.0 的节奏器——
      // 于是它会跟刚说过的看屏/碎碎念撞在一起（三分钟内两句），然后又是一小时安静，
      // 正是节奏器想治的病。黏人是「关系事件」不是「内容播报」，所以按 time 类申请：
      // 不吃每小时预算，但守共享最小间隔，且开口后要让另外三条通道知道「刚说过话」。
      const gate = getRhythm().ask('time')
      if (!gate.ok) return
      const started = base
      let text = await makeNudgeLine(stage, Math.floor(idle / 60000))
      // 生成期间主人说话了（计时被清零/挪走）→ 作废不发
      if (nudgeRec.baseAt !== started) { log('[nudge] 生成期间主人说话了，作废'); return }
      // 0.45.91 复读硬闸（同欢迎回来）：点名叫出刚落过的句子，重生成一次
      let rep = text ? proactiveRepeat(text) : null
      if (rep) {
        log('[nudge] 第 ' + stage + ' 阶复读闸：与「' + String(rep.against).slice(0, 18) + '」太像（' + rep.score.toFixed(2) + '），换角度重生成')
        text = await makeNudgeLine(stage, Math.floor(idle / 60000), rep.against)
        if (nudgeRec.baseAt !== started) { log('[nudge] 生成期间主人说话了，作废'); return }
        rep = text ? proactiveRepeat(text) : null
        if (rep) { log('[nudge] 第 ' + stage + ' 阶复读闸：重生成仍雷同，这次忍住不说'); text = '' }
      }
      if (!text) { nudgeRec = idleNudge.onFail(nudgeRec); saveNudgeRec(); return }
      await sayProactive(text, { kind: 'nudge', mark: false })
      noteProactiveSaid(text)
      try { getRhythm().note('time') } catch { } // 告诉另外三条通道：刚说过话，别贴上来
      noteSpoke({ stage })   // 0.45.97 阶梯 + QQ 共用同一笔账（她刚在屏幕前说过，QQ 不补一句）
      log('[nudge] 第 ' + stage + ' 阶已开口（闲置 ' + Math.floor(idle / 60000) + ' 分钟）：' + text.slice(0, 30))
    } catch (err) {
      log('[nudge] tick 异常：' + (err && err.message))
    }
  }, 30 * 1000)
  try { nudgeTimer.unref && nudgeTimer.unref() } catch { }
}

function stopNudge () {
  if (nudgeTimer) { clearInterval(nudgeTimer); nudgeTimer = null }
}

/* ---------------- 她自己用电脑（0.43.0） ----------------
 * 用户 10-29 的原话：「5 分钟不动，角色可以自己控制电脑去持续性地看自己想看的，
 * 而不是打开之后停在那里好像看了，但既不继续操作也不关闭网页」。
 * 剧本与安全边界写在 autonomy.js 里（只打开白名单站点、只滚动、不点击、不打字、
 * 收尾前必须确认前台是浏览器才按 Ctrl+W）。
 */
const autonomy = require('./autonomy')
const needsMod = require('./needs')       // 0.45.18 需求系统
const dayflow = require('./dayflow')      // 0.45.19 连续时间体验
const projectsMod = require('./projects') // 0.45.19 跨天项目
let autonomyInst = null
let needsInst = null
let projectsInst = null

/** 三股内部压力（好奇/想分享/无聊），状态落工作区 needs-state.json */
function getNeeds () {
  if (!needsInst) {
    needsInst = needsMod.create({ wsDir: () => curWsDir, log })
  }
  return needsInst
}

/** 跨天项目（进行中的长期小事），状态落工作区 projects.json */
function getProjects () {
  if (!projectsInst) {
    projectsInst = projectsMod.create({
      wsDir: () => curWsDir,
      log,
      // 0.46.64 成果硬闸：路径必须 ①先过 spaceGuard 包含性（在她的地盘内）
      // ②真实存在 ③非空文件——三关全过才算真实成果，writing/collection 没有它不许收尾
      verifyArtifact: (spaceDir, rel) => {
        try {
          const abs = autonomy.spaceGuard(String(spaceDir || ''), String(rel || ''))
          if (!abs) return false
          const st = require('node:fs').statSync(abs)
          return st.isFile() && st.size > 0
        } catch { return false }
      },
      // 0.46.64 项目大节点（开题/完成/放弃/改向/搁置）进记忆体系——
      // addEvent 内部锚定本地 date（0.46.59），日后「她记得自己做过什么」全靠这条
      onEvent: (ev, title) => {
        try {
          const ch = character.get() || {}
          if (!ch.id || !title) return
          const textMap = {
            开题: '开始弄《' + title + '》',
            完成: '把《' + title + '》做完了',
            放弃: '放下了《' + title + '》',
            改向: '《' + title + '》做到一半换了方向',
            搁置: '把《' + title + '》暂时搁下了'
          }
          const text = textMap[ev]
          if (text) require('./memory').addEvent(ch.id, { cat: 'fact', text, importance: 2, source: 'project' })
        } catch { }
      },
      // 0.46.71 共同创作「写向」：项目状态一变就重写「莱莎这边的进展.md」（cocreate 开着才写）
      // ⚠️ cfg() 返回的就是 global.companion 本体（0.45.3x 约定）——别再套一层 .global.companion
      onSync: (st) => {
        try {
          const cc = cfg().cocreate || {}
          require('./progressNote').write(st, cc, log)
        } catch (e) { log('[projects] 进展笔记同步异常: ' + (e && e.message)) }
      },
      // 0.46.72 作品交付：她真做完的项目，成果文件复制到共享目录「莱莎的作品/」+ 共享笔记里留一行
      onDeliver: (finished, spaceDir) => {
        try {
          const cc = cfg().cocreate || {}
          if (!cc.on || !cc.file) return
          require('./progressNote').deliverArtifacts(finished, spaceDir, cc, (s, r) => autonomy.spaceGuard(s, r), log)
        } catch (e) { log('[projects] 作品交付异常: ' + (e && e.message)) }
      }
    })
  }
  return projectsInst
}

/** 她「想看什么」从哪来：主人最近搜过的东西——他自己敲进去的问题，比页面标题更说明在意什么 */
function autonomyPool () {
  const out = { themes: [] }
  try {
    const char = character.get() || {}
    const ws = require('../assistant').workspaceDirFor(char.id)
    if (!ws) return out
    const s = require('../profile').readSection(ws, 'search')
    out.themes = String(s || '').split('\n')
      .map((l) => l.replace(/^-\s*\[[^\]]*\]\s*/, '').replace(/（[^）]*）\s*$/, '').trim())
      .filter((t) => t.length >= 2 && t.length <= 20)
      .slice(0, 40)
    // 0.46.50 她自己立的目标进选题池（thoughts = 「她最近在想的」，pickTopic 最高优先）——
    // goals.json 11-05 实锤她在真用（「自分から誘ってみる」「動画で調べてみる」），
    // 但自主活动选题从来没读过它：她立的「想试试用视频查资料」不会变成下一场的行动。
    try {
      const g = getGoals()
      const gt = (g ? g.listRaw() : [])
        .filter((x) => x && x.status === 'active')
        .map((x) => String(x.title || '').trim())
        .filter((t) => t.length >= 2 && t.length <= 40)
      if (gt.length) out.thoughts = gt
    } catch { }
    // 0.46.64 搁置/放弃项目的未竟方向进选题池尾部（goals 仍最高优先）——
    // 让「隔几天重新想起自己的项目」有通路，但不做定时复活，捡不捡随她
    try {
      const ex = getProjects().extras()
      if (ex.length) out.thoughts = (out.thoughts || []).concat(ex)
    } catch { }
  } catch { }
  return out
}

function startAutonomy () {
  if (autonomyInst) return autonomyInst
  // 0.46.71 启动回填：把当前项目进展先写一遍（不然要等下一场活动才有进展笔记）
  try { getProjects().sync() } catch { }
  autonomyInst = autonomy.create({
    cfgGet: () => cfg(),
    log,
    wsDir: () => curWsDir,
    // 0.45.17 记忆改变行为：她的喜恶记忆进自主活动的决策提示词
    tastes: () => { try { return self.getTastes(curWsDir) } catch { return [] } },
    // 0.45.18 需求系统：压力驱动动机与冷却
    needs: getNeeds(),
    // 0.45.19 跨天项目：她有「最近在弄的那个东西」
    projects: getProjects(),
    // 挡 2/3 的 LLM 循环用跟主聊天同一套配置（模型得是能读图/能调工具的）
    llmCfg: () => ({ baseUrl: cfg().apiBaseUrl, apiKey: cfg().apiKey, model: cfg().apiModel, replyLang: cfg().replyLang || 'zh' }),
    idleSec: () => {
      try { return require('electron').powerMonitor.getSystemIdleTime() } catch { return 0 }
    },
    busy: () => !!genAbort, // 正在对话/生成中不抢电脑
    // 0.46.56 晚安静默闸：说过晚安还没到睡醒时刻 → 不起场、不发收场自语
    sleepQuiet: () => !!(nudgeRec.sleepUntil && Date.now() < Number(nudgeRec.sleepUntil)),
    pool: autonomyPool,
    cua: require('../cua'),
    // 0.46.16 她的网页开在自建浏览窗口里（活动结束整窗关掉恢复原状），不再丢进主人默认浏览器
    openUrl: (u) => {
      try { if (require('./actBrowser').open(u)) return true } catch { }
      try { require('electron').shell.openExternal(u) } catch { }
      return true
    },
    onDone: (r, line) => {
      if (!line) return
      log('[autonomy] ' + line.slice(0, 120))
      // 记成旁白：她的「今天」里会多一句「我自己跑去看了会儿…」，
      // 而不是只留一条运维日志（那样又变成「独立的一坨」）。
      try { inner.noteNarration(line.slice(0, 300)) } catch { }
      // 0.45.26 全出口入账：自主活动的收尾汇报也是她说的话，本体账本里必须留底
      try { require('../assistant').ledgerNote({ via: 'autonomy', assistant: line.slice(0, 300) }) } catch { }
      // 0.45.8 光有旁白还不够——经历要沉淀成长期记忆，不然活动只是流水，
      // 聊天时她还是「不记得自己去过哪」。复用做梦管线：解析 → 审查册 →（自动批准时）直接生效。
      autonomyMemory(line).catch(() => { })
    },
    // 0.46.0 活动中的自言自语：她写「（自语）…」行 → 这里出口（气泡 + 低频朗读）。
    // 入账走 sayNarration（via:'chatter'），与本体记忆同源；不转 QQ（proactiveGate 那条线不碰）。
    onSoliloquy: async (line) => {
      const t = String(line || '').trim()
      if (!t) return
      log('[autonomy] 自语：' + t.slice(0, 40))
      // 0.46.77 回传 rr（含 speech/seq/estimateSeconds）：多句自语等真播完要用
      try { return await sayNarration(t, { speech: narrationVoiceOn() }) } catch { }
    },
    // 0.46.77 自语多句连发守用：等渲染层 voice-done（同 chatter）
    waitVoiceDone: (seq, ms) => { try { return require('../petBridge').waitVoiceDone(seq, ms) } catch { return Promise.resolve(true) } },
    // 0.46.54 听觉：自主活动场里她可以「听一下」（listen 工具的弹药）
    hearDescribe: () => { try { return hear.describe() } catch { return { ok: false, reason: '听觉模块异常' } } }
  })
  autonomyInst.start()
  return autonomyInst
}

function stopAutonomy () {
  try { if (autonomyInst) autonomyInst.stop() } catch { }
}

/* 0.45.8 自主活动的经历沉淀 → 0.45.12 泛化为 distillExperience：
   「所有功能都必须默认写进记忆」——不只是自主活动，陪学/好奇心/欢迎回来的经历
   都走同一条管线（做梦式解析 → 审查册 → dreamAutoApprove 时直接进长期记忆）。
   串行防抖：提炼中又来一段就跳过（宁缺毋滥，不排队轰炸模型）。 */
let autonomyMemoBusy = false
async function distillExperience (text, tag) {
  const body = String(text || '').trim()
  const src = String(tag || '自主活动')
  if (!body || body.length < 8) { log('[' + src + '] 经历太短，不提炼记忆'); return }
  if (autonomyMemoBusy) { log('[' + src + '] 上一段还在提炼，这段跳过'); return }
  autonomyMemoBusy = true
  try {
    const c = cfg()
    if (!c.apiBaseUrl || !c.apiModel) { log('[' + src + '] 经历沉淀跳过：API 未配置'); return }
    const res = await llm.chatOnce({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages: [
        { role: 'system', content: '她刚经历了一件事。从她的经历里挑出值得她长期记住的，按行输出（宁缺毋滥，最多 3 条，没有就只输出「无」）：\n[喜欢] 什么｜为什么\n[不喜欢] 什么｜为什么\n[记] 什么事｜重要度1-5\n[他] 关于主人的新事实｜重要度1-5' },
        { role: 'user', content: ('【' + src + '】\n' + body).slice(0, 600) }
      ],
      maxTokens: 200,
      // 0.46.25 15000 → 30000：11-03 DeepSeek 拥堵时段两次 abort（17:46/18:25，均在 503 风暴窗口内），
      // 沉淀是后台任务不吃用户等待，放宽到和 index.js 其他后台调用一致的 30000
      timeoutMs: 30000
    })
    // 0.45.20 三个静默出口全部显形：之前「无」/0 条都无声返回，真机上沉淀从未生效却查无此人
    if (!res) { log('[' + src + '] 经历沉淀：模型空回复'); return }
    if (/^\s*无\s*$/.test(res)) { log('[' + src + '] 经历沉淀：模型判无可记（' + body.slice(0, 40) + '…）'); return }
    const entries = autonomy.memoryEntriesOf(dream.parseDream(res)).map((e) => {
      // reason 带来源：审查册里能看出这段记忆是哪段经历来的
      return String(e.reason || '').startsWith('自主活动') ? Object.assign({}, e, { reason: e.reason.replace('自主活动', src) }) : e
    })
    if (!entries.length) { log('[' + src + '] 经历沉淀：解析后无可记条目（模型原文：' + String(res).slice(0, 60) + '）'); return }
    const rr = reviewEnqueue(entries)
    log('[' + src + '] 经历沉淀进审查册：+' + rr.added + '（去重 ' + rr.dup + '）')
  } catch (err) {
    log('[' + src + '] 经历沉淀失败: ' + (err && err.message))
  } finally {
    autonomyMemoBusy = false
  }
}

async function autonomyMemory (line) {
  return distillExperience(line, '自主活动')
}

/* ---------------- 第 1 期 · 审查队列 + 做梦 + 风格样本 ---------------- */

const review = require('./review')
const dream = require('./dream')
const styleMod = require('./style')
const self = require('./self') // 做梦素材读事件流/日记/习惯（此文件此前都是局部 require，这次区块多处要用，提为顶层）
let curWsDir = ''         // 当前角色工作区（syncInner 时更新；队列/风格池都按它落盘）
let stylePool = []        // 风格样本池缓存（角色切换时重载）
let dreaming = false      // 做梦进行中（防重入）
let dreamBootAt = 0       // 开机时刻（boot 补偿触发用）
let sleepWantedAt = 0     // 主人说「去睡了」的时刻（睡前做梦触发用）
let dreamTimer = null

/**
 * 审查队列落地器：kind → 实际写入。返回 before 快照 [{path, content}]，回滚全靠它。
 * 能碰的只有「表现层」：习惯 / 好恶 / 记忆事实 / 风格样本——底层设定文件照旧只读。
 */
function applyReviewItem (item) {
  const before = []
  const snap = (p) => {
    let content = ''
    try { content = fs.readFileSync(p, 'utf8') } catch { }
    before.push({ path: p, content })
  }
  const ws = curWsDir
  const today = self.dateStr()
  if (item.kind === 'habit') {
    const f = path.join(ws, 'self', 'habits.json')
    snap(f)
    const habits = self.getHabits(ws)
    const hit = habits.find((h) => h.desc === item.what)
    if (hit) { hit.strength = Math.min(1, (Number(hit.strength) || 0) + 0.25); hit.last = today }
    else habits.push({ desc: item.what, first: today, last: today, strength: 0.4 })
    self.saveHabits(ws, habits)
  } else if (item.kind === 'taste') {
    const f = path.join(ws, 'self', 'tastes.json')
    snap(f)
    const tastes = self.getTastes(ws)
    const pol = self.polarityOf(item)
    const hit = tastes.find((x) => x.what === item.what && self.polarityOf(x) === pol)
    if (hit) hit.last = today
    else tastes.push({ what: item.what, polarity: pol, since: today, last: today })
    self.saveTastes(ws, tastes.slice(-30))
  } else if (item.kind === 'memory') {
    try {
      const charId = character.get() && character.get().id
      const f = path.join(require('./character').base(), charId, 'memory.json')
      snap(f)
      memory.addEvent(charId, { cat: 'fact', text: item.payload || item.what, importance: 3, source: 'dream' })
    } catch { }
  } else if (item.kind === 'fact') {
    /* 关于主人的稳定事实 → PARTNER.md 的「长期事实」（整份注入，才是「她本来就知道」）。
       写之前抓快照，回滚能退回原文。她不认识 partner 模块，交给 assistant 宿主代写。 */
    snap(path.join(ws, 'PARTNER.md'))
    try {
      const asst = require('../assistant')
      const ok = asst.rememberFact(item.payload || item.what)
      if (!ok) log('[dream] 长期事实跳过（已记过或记忆层未就绪）: ' + String(item.what || '').slice(0, 30))
    } catch (e) { log('[dream] 写长期事实失败: ' + (e && e.message)) }
  } else if (item.kind === 'persona') {
    // 第 2 期：人格演化提案——只写「她想成为的样子」（表现层），性格/人设文件照旧只读
    const f = path.join(ws, 'self', 'persona.json')
    snap(f)
    self.applyPersona(ws, { aspect: item.aspect, current: item.current, proposed: item.proposed }, today)
    self.appendGrowth(ws, '提案生效：' + (item.proposed || item.what || '').slice(0, 40))
  } else if (item.kind === 'style') {
    // 风格样本不走队列（环形池可删），这里只是兼容 kind，不落地
  }
  return before
}

/** 入队（+可选自动批准）。inner.distill 与做梦产出统一走这里。 */
function reviewEnqueue (entries) {
  if (!curWsDir) return { ok: false, added: 0, dup: 0, error: 'no-ws' }
  let items = review.load(curWsDir)
  let added = 0
  let dup = 0
  const auto = cfg().dreamAutoApprove === true
  for (const e of entries || []) {
    const r = review.enqueue(items, e)
    items = r.items
    if (r.dup) { dup++; continue }
    added++
    // 人格提案永远不自动生效（默认弹出审批卡，计划书定的）——自动批准只覆盖习惯/好恶/记忆
    if (auto && e.kind !== 'persona') {
      const d = review.decide(items, r.item.id, 'approve')
      items = d.items
      if (d.item) {
        const before = applyReviewItem(r.item)
        items = review.markApplied(items, r.item.id, before).items
      }
    }
  }
  try { review.save(curWsDir, items) } catch (err) { log('[review] 保存失败: ' + err.message) }
  if (added) statBump('reviewAdded', added)
  return { ok: true, added, dup }
}

/** 习惯/好恶的时光衰减（原归纳管线里的 30 天遗忘规则，做梦时顺带跑，一天最多一次） */
function habitAging () {
  const ws = curWsDir
  if (!ws) return
  const today = self.dateStr()
  const habits = self.getHabits(ws)
  let changed = false
  for (const h of habits) {
    const gap = Math.round(Math.abs(new Date(String(h.last || h.first || today) + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000)
    if (gap >= 30 && (Number(h.strength) || 0) > 0) { h.strength = Math.max(0, (Number(h.strength) || 0) - 0.1); changed = true }
  }
  const kept = habits.filter((h) => (Number(h.strength) || 0) >= 0.2)
  for (const h of habits.filter((x) => !kept.includes(x))) {
    self.appendGrowth(ws, '已经不太会「' + String(h.desc || '').slice(0, 30) + '」了')
    changed = true
  }
  if (changed) self.saveHabits(ws, kept)
}

/** 做梦一次。reason: manual | idle | boot | sleep */
async function dreamRun (reason) {
  const ws = curWsDir
  if (!ws || dreaming) return { ok: false, error: 'busy' }
  const c = cfg()
  if (!c.apiBaseUrl || !c.apiModel) return { ok: false, error: 'no-llm' }
  // 素材：今天+昨天的事件、近 3 天日记、现有习惯好恶
  const now = Date.now()
  const today = self.dateStr(now)
  const yest = self.dateStr(now - 24 * 3600 * 1000)
  let evCount = 0
  const evLines = []
  for (const d of [today, yest]) {
    for (const ev of self.readEvents(ws, d)) {
      evCount++
      if (ev.text) evLines.push('【' + d + '】' + ev.text)
    }
  }
  const hasDiary = self.hasDay(ws, today) || self.hasDay(ws, yest)
  /* 电脑画像也算素材。否则聊得少的日子永远够不到做梦门槛，
     那份观察就一直卡在提示词里，变不成她自己的记忆。
     但开关关着就不读——关掉画像的人不该被梦境偷偷消费那份档案。 */
  let pcMaterial = ''
  if (c.pcProfileOn === true) {
    try { pcMaterial = require('../profile').dreamMaterial(ws, { limit: 1200 }) } catch { }
  }
  const chk = dream.shouldDream({
    lastDreamAt: Number((self.getState(ws) || {}).lastDreamAt) || 0,
    today, now, idleMs: 0, cfg: c, evCount, hasDiary,
    hasProfile: !!pcMaterial,
    bootAt: dreamBootAt, sleepWantedAt, busy: !!genAbort, dreaming,
    reason: reason || 'manual'
  })
  if (!chk.ok) return { ok: false, error: chk.why || 'not-due' }
  dreaming = true
  try {
    const days = self.recentDays(ws, 3)
    /* 画像放最前面：它是最容易被埋在长对话后面忽略的一段，而它才是「了解他」的主料 */
    const corpus = dream.buildUserText([
      pcMaterial
        ? '【你在他电脑上注意到的（不是你俩聊过的，是推出来的，可能不准）】\n' + pcMaterial +
          '\n\n先看这段：这里能看得出他长期在做什么、在为什么准备、什么作息、在玩什么。' +
          '找到反复出现的、你有把握的，写成 [他]；一次两次的异常别当结论，也别硬凑。'
        : '',
      evLines.join('\n'),
      days.map((d) => '【日记 ' + d.date + '】\n' + d.text).join('\n\n')
    ])
    const res = await (llm.chatStreamAuto || llm.chatStream)({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages: [
        { role: 'system', content: dream.DREAM_PROMPT },
        { role: 'user', content: corpus || '（最近没什么记录，随便想想。）' }
      ],
      temperature: 0.5
    })
    /* 排障用：以前只能看到「入队 N 条」，没法判断画像到底进没进素材 */
    log('[dream] 素材：事件 ' + evLines.length + ' 条 / 日记 ' + days.length + ' 天 / 画像 ' + pcMaterial.length + ' 字')
    const parsed = dream.parseDream(res.content)
    const entries = []
    for (const desc of parsed.habits) entries.push({ kind: 'habit', what: desc, payload: desc, reason: '做梦回顾' })
    for (const t of parsed.likes) entries.push({ kind: 'taste', what: t.what, payload: t.what + (t.why ? '｜' + t.why : ''), reason: '做梦回顾：喜欢', polarity: 'like' })
    for (const t of parsed.dislikes) entries.push({ kind: 'taste', what: t.what, payload: t.what + (t.why ? '｜' + t.why : ''), reason: '做梦回顾：不喜欢', polarity: 'dislike' })
    /* 关于他的事实走 fact：批准后写进 PARTNER.md 的「长期事实」，每轮整份注入。
       memory 那条通道是按关键词召回、会衰减的，装不下「她本来就该知道的他」。 */
    for (const h of (parsed.hisFacts || [])) {
      entries.push({ kind: 'fact', what: h.fact, payload: h.fact, reason: '做梦回顾·关于他（重要度 ' + h.importance + '）' })
    }
    for (const m of parsed.memories) entries.push({ kind: 'memory', what: m.fact, payload: m.fact, reason: '做梦回顾（重要度 ' + m.importance + '）' })
    // 第 2 期：人格演化提案（最多 1 条；永远不自动生效，等主人批）
    for (const p of (parsed.proposals || [])) {
      entries.push({
        kind: 'persona',
        what: p.aspect + '：' + p.proposed,
        payload: '现状：' + (p.current || '（没说）') + ' → 想改成：' + p.proposed,
        reason: p.reason || '做梦回顾',
        aspect: p.aspect, current: p.current, proposed: p.proposed, evidence: p.reason
      })
    }
    const r = reviewEnqueue(entries)
    habitAging()
    self.patchState(ws, { lastDream: today, lastDreamAt: Date.now() })
    // 睡前梦做过一场就把「说过晚安」清掉：sleepWantedAt 不清零时，
    // dream tick 每分钟都会再命中 sleep 分支（0.45.0 真机连环做梦的另一半根因）
    sleepWantedAt = 0
    // 0.46.36 只记「她刚开过口」，绝不清睡前静默——原来调 onUserTalk 把 sleepUntil 一起清了：
    // 00:05 道晚安静默到 07:05，01:13 做梦完成清静默，02:39 她 QQ「85 分钟没理我了？」（主人睡得好好的）
    try { nudgeRec = idleNudge.noteSelfSpoke(nudgeRec); saveNudgeRec() } catch { }
    try { await sayProactive(dream.closingLine(c.replyLang === 'auto' ? 'zh' : (c.replyLang || 'zh'), parsed, { auto: c.dreamAutoApprove === true }), { kind: 'dream' }) } catch { }
    log('[dream] 做梦完成（' + (reason || 'manual') + '）：入队 ' + r.added + ' 条（重复 ' + r.dup + '）')
    return { ok: true, added: r.added, dup: r.dup, parsed }
  } catch (err) {
    log('[dream] 做梦失败: ' + (err && err.message))
    return { ok: false, error: err && err.message }
  } finally {
    dreaming = false
  }
}

/** 做梦调度（60s 一看）：学习 > 聊天 > 做梦 > 黏人（黏人在自己的 timer 里，做梦做完会重置它） */
function startDreamTimer () {
  if (dreamTimer) return
  dreamTimer = setInterval(async () => {
    try {
      if (!curWsDir || dreaming || genAbort) return
      if (study.active(studySess)) return          // 陪学期间不做梦
      const c = cfg()
      if (c.dreamOn === false) return
      const ws = curWsDir
      const now = Date.now()
      const today = self.dateStr(now)
      const yest = self.dateStr(now - 24 * 3600 * 1000)
      let evCount = 0
      for (const d of [today, yest]) evCount += self.readEvents(ws, d).length
      const hasDiary = self.hasDay(ws, today) || self.hasDay(ws, yest)
      const st = self.getState(ws) || {}
      const idleMs = Number(st.lastUserAt) ? now - Number(st.lastUserAt) : 0
      /* 画像也算素材（开关关着不算）：不这样的话「不聊天但电脑画像很厚」的日子永远不触发，
         那份观察就只能停在提示词里。这里只查文件在不在，不读内容。 */
      let hasProfile = false
      if (c.pcProfileOn === true) {
        try { hasProfile = fs.existsSync(path.join(ws, 'pc', 'insight.md')) } catch { }
      }
      const chk = dream.shouldDream({
        lastDreamAt: Number(st.lastDreamAt) || 0,
        today, now, idleMs, cfg: c, evCount, hasDiary, hasProfile,
        bootAt: dreamBootAt, sleepWantedAt, busy: false, dreaming: false,
        reason: ''
      })
      if (chk.ok) await dreamRun(chk.reason)
    } catch (err) {
      log('[dream] tick 异常: ' + (err && err.message))
    }
  }, 60 * 1000)
  try { dreamTimer.unref && dreamTimer.unref() } catch { }
}

function stopDreamTimer () {
  if (dreamTimer) { clearInterval(dreamTimer); dreamTimer = null }
}

/** 聊天收尾采样（assistant/index.js 每轮完整回复后调用）：攒风格样本 */
function noteExchange (userText, replyText) {
  try {
    if (!curWsDir || cfg().styleOn === false) return
    if (!styleMod.valid(userText, replyText)) return
    const c = cfg()
    const lang = c.replyLang && c.replyLang !== 'auto' ? c.replyLang : ''
    const r = styleMod.addSample(stylePool, { user: userText, reply: replyText, lang })
    stylePool = r.pool
    if (!r.dup) styleMod.save(curWsDir, stylePool)
  } catch { }
}

/* ---------------- 0.22.0 补丁⑧ · 学习模式（陪学+轻声查岗） ---------------- */


const study = require('./study')
let studySess = null
let studyTimer = null
let studyOnTrayRefresh = null // main.js 注入的托盘菜单刷新（学习态图标/文案联动）

/** 学习状态变化后叫托盘刷新一下（幂等，没注入就不动） */
function studyTrayPoke () {
  try { if (studyOnTrayRefresh) studyOnTrayRefresh() } catch { }
}

/** 阶段台词：persona + 情境提示（复用黏人模式的生成管线与语言规则） */
async function makeStudyLine (kind, st) {
  const c = cfg()
  if (!c.apiBaseUrl || !c.apiModel) return ''
  const hint = study.fillHint(kind, st)
  if (!hint) return ''
  const rl = c.replyLang || 'zh'
  const langRule = rl === 'auto'
    ? '用与角色平时说话相同的语言。'
    : '只使用' + ({ zh: '中文', en: '英文', ja: '日文' }[rl] || '中文') + '。'
  try {
    const res = await (llm.chatStreamAuto || llm.chatStream)({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages: [
        { role: 'system', content: String((character.get() || {}).persona || '').slice(0, 900) },
        { role: 'user', content: '【当前情境】\n' + hint +
          '\n\n现在是你主动发起，不是回复对方。只输出你要说的话本身，不要解释、不要加引号、不要写旁白，不要换行。\n语言：' + langRule }
      ],
      temperature: 0.95
    })
    return String(res.content || '').trim().replace(/\s*\n+\s*/g, ' ').slice(0, 140)
  } catch (err) {
    log('[study] 生成失败：' + (err && err.message))
    return ''
  }
}

/** 生成 + 播报 + 记成功/失败（生成期间主人说话由 lastUserAt 比对兜底作废） */
async function studySpeak (kind, st) {
  const spokenAt = st.lastUserAt
  const text = await makeStudyLine(kind, st)
  if (st.lastUserAt !== spokenAt) { log('[study] 生成期间主人说话了，作废'); return false }
  if (!text) { studySess = study.onFail(st); return false }
  await sayProactive(text, { kind: 'study' })
  studySess = study.onSent(st)
  studyTrayPoke()
  log('[study] ' + kind + '：' + text.slice(0, 40))
  return true
}

function studyTick () {
  try {
    if (!study.active(studySess)) return
    const c = cfg()
    if (c.studyOn === false) { studyStop(true); return }
    // 0.45.68：监督在跑的时候不再盲问「还在学吗」——它会真看屏幕，比盲问准得多，
    // 两套同时开只会变成一个人肉闹钟 + 一个人肉监工，吵得没法学。
    const next = study.tick(studySess, c, undefined, { noCheck: !!(watchSt && watchSt.on) })
    if (!next) return
    const kind = next.say
    studySess = next
    if (kind) studySpeak(kind, next).catch((err) => log('[study] speak 异常：' + (err && err.message)))
    if (next.phase === 'done') {
      stopStudyTimer()
      watchEnd(false)                            // 0.45.68 收账进长期记忆
      studyEndMemory(next)                       // 0.45.12 陪学经历默认沉淀
    }
  } catch (err) {
    log('[study] tick 异常：' + (err && err.message))
  }
}

function studyStartTimer () {
  stopStudyTimer()
  studyTimer = setInterval(studyTick, 30 * 1000)
  try { studyTimer.unref && studyTimer.unref() } catch { }
}

function stopStudyTimer () {
  if (studyTimer) { clearInterval(studyTimer); studyTimer = null }
}

/** 开启学习会话（托盘/工具/IPC 三个入口都到这；0.45.12 自动模式也走这，opts.auto=true）
 *  0.45.68：手动叫的陪学 = 「说好要学」，开监督契约（会看屏幕、会生气）。
 *  0.45.75：自动陪学也接监督（用户拍板）——每 20~30 分钟真看一次屏幕：
 *  在学就安静陪，抓到在玩一样小生气→真生气；黑屏/锁屏＝人睡了 → 静默收场不记账；
 *  亮屏看不出 → 轻轻问一句，不乱夸不乱骂。但台词不许拿「约好」说事（auto 标志会传下去）。 */
async function studyStart (opts) {
  const c = cfg()
  if (c.studyOn === false) return { ok: false, reason: 'off' }
  if (!c.apiBaseUrl || !c.apiModel) return { ok: false, reason: 'no-api' }
  if (study.active(studySess)) return { ok: false, reason: 'already', state: studyStatus() }
  const o = opts || {}
  // 目标说一次就记住（下次问「学什么」她不会失忆）
  if (o.goal && String(o.goal).trim()) {
    try { patchCfg({ studyGoal: studyWatch.normGoal(o.goal) }) } catch { }
  }
  const st = study.start(c, undefined, o)
  studySess = st
  studyStartTimer()
  watchBegin({
    goal: o.goal || c.studyGoal || o.sceneLabel || '',
    targetMin: o.targetMin || st.lenMin * st.rounds,
    auto: !!st.auto,
    sceneLabel: o.sceneLabel || ''
  })
  studyTrayPoke()
  log('[study] 学习会话开始（' + st.lenMin + ' 分钟 × ' + st.rounds + ' 轮，休 ' + st.brkMin +
    (st.auto ? '，自动模式（带监督）' : '，监督模式') + '）')
  await studySpeak(st.auto ? 'auto_start' : 'start', st)
  return { ok: true, state: studyStatus() }
}

/** 结束（silent=true 时不说话：比如设置里直接关掉开关） */
async function studyStop (silent, opts) {
  if (!study.active(studySess)) {
    // 会话已经没了但契约还挂着（比如重启/异常）：一并收掉，别留个幽灵监督
    if (watchSt && watchSt.on) watchEnd(silent)
    return { ok: false, reason: 'not-active' }
  }
  const st = study.stop(studySess)
  st.away = !!(opts && opts.away)                // 0.45.71 人根本不在 → 不落「陪了一场」的假记忆
  const wasKind = st.auto ? 'auto_quit' : st.say   // 自动模式的收场话术不一样（轻声不吵）
  studySess = st
  stopStudyTimer()
  watchEnd(silent, { quiet: st.away })           // 0.45.68 收账（人不在时记忆不落）
  studyTrayPoke()
  log('[study] 学习会话结束（第 ' + st.round + ' 轮进行到 ' + Math.round((Date.now() - st.roundStartedAt) / 60000) + ' 分钟）')
  studyEndMemory(st)                             // 0.45.12 陪学经历默认沉淀
  if (!silent) await studySpeak(wasKind, st)
  return { ok: true, state: studyStatus() }
}

/** 0.45.12 陪学经历默认沉淀：一场陪学收尾 → 旁白 + 提炼进审查册。
 *  以前整场陪学连事件流都不进（探索报告实证）——说过的话、陪了多久全部蒸发。 */
function studyEndMemory (st) {
  try {
    if (!st) return
    /* 0.45.71：人在不在是硬条件。自动陪学在主人睡着/离开时收场（st.away），
     * 那时候「陪了他一场」是他没经历过的事，不许写进长时记忆。 */
    if (st.away) return
    const mins = Math.max(1, Math.round(((st.endedAt || Date.now()) - st.startedAt) / 60000))
    const mode = st.auto ? '自动检测到他在学习，静音陪了一场' : '主人叫我陪学'
    const line = mode + '，陪了约 ' + mins + ' 分钟（第 ' + (st.round || 1) + '/' + (st.rounds || 1) + ' 轮）。'
    try { inner.noteNarration('陪主人学习了一场：' + line) } catch { }
    distillExperience(line, '陪学').catch(() => { })
  } catch { }
}

/* ---------------- 0.45.76 游戏陪玩记忆同步 ----------------
 * 用户 11-01：「就算进入学习模式，游戏模式里面的记忆与内容也要跟本体同步的吧，
 * 就算离开也不会把对应模式里面的事忘记」。
 * 以前 gameMode 的进出只写 gameHistory 配置（给设置页看），她自己从没见过——
 * 陪玩一场、玩的是什么、玩了多久，退出全忘。现在 main.js 注入这个钩子，
 * 进出各写一条旁白进事件流（日记与下一轮提示词都会带），账目再由 gamesess 段喂。 */
function noteGameSession (info) {
  const i = info || {}
  const label = i.name ? '《' + String(i.name) + '》' : '游戏'
  if (i.ev === 'enter') {
    try { inner.noteNarration('主人开始玩' + label + '了，我缩到角落里陪他') } catch { }
    log('[gameMode] 记忆同步：开始陪玩 ' + (i.name || '(手动进入)'))
  } else if (i.ev === 'exit') {
    const m = Math.max(0, Math.round(Number(i.minutes) || 0))
    if (m < 1) return                                  // 误触进出的不记
    const dur = m >= 60 ? (Math.round(m / 6) / 10) + ' 个小时' : m + ' 分钟'
    const how = i.reason === 'timeout' ? '到时间我自己收的' : '他自己退出的'
    try { inner.noteNarration('陪主人玩了' + label + '一场，约 ' + dur + '（' + how + '）。') } catch { }
    log('[gameMode] 记忆同步：陪玩收账 ' + m + ' 分钟 ' + (i.name || ''))
  }
}

/* 0.45.71 真实聊天通道的 study_* 工具出口（petBridge 转发过来）。
 * 旧通道 companion/tools.js 里那份只给自主活动用，模型聊天时根本看不到。 */
async function studyTool (name, args) {
  const a = args || {}
  if (name === 'study_start') {
    const r = await studyStart({ goal: a.goal, targetMin: a.minutes })
    if (!r.ok) {
      if (r.reason === 'off') return '学习模式开关还没打开（设置 → 学习模式）'
      if (r.reason === 'no-api') return '还没配置 AI 服务，开不了学习模式'
      if (r.reason === 'already') return '已经在陪主人学习了（第 ' + ((r.state && r.state.round) || 1) + ' 轮）'
      return '没能开启学习模式'
    }
    const st = r.state || {}
    return '学习监督已开启' + (a.goal ? '（目标记下了：' + String(a.goal) + '）' : '（他没说具体学什么，开场可以问一句）') +
      '。你会不定时自己看一眼他的屏幕（**主屏副屏都看**）：在学就安静陪着，在玩先说一句小生气，一直不改会彻底生气。' +
      '这场学习会记账：抽查看到什么、被抓几次、补了多少时间' +
      (st.targetMin ? '，目标 ' + st.targetMin + ' 分钟' : '') +
      '——以后他问「我今天学了多久」，你要答得出真数字，不许含糊。'
  }
  if (name === 'study_peek') {
    const r = await watchOnce('主人让我看')
    if (!r) return '这一眼没看清（截屏失败或判定不出来）——别编，就说没看清'
    const seen = ({ study: '他在学', fun: '他在玩', unsure: '看不清他在干嘛', away: '他不在电脑前（黑屏/锁屏）', idle: '他没在学，也不是在玩' })[r.verdict] || '看不清'
    return '你看到了：' + seen + '。你现在的情绪等级：' + (r.level || '未知') +
      '（这次' + (r.kind ? '已经说了一句' : '没说话') + '）'
  }
  if (name === 'study_stop') {
    const r = await studyStop(false)
    if (!r.ok) return '现在没有进行中的学习会话'
    return '已结束学习模式，记得温柔收场'
  }
  throw new Error('未知的学习工具: ' + name)
}

function studyStatus () {
  if (!study.active(studySess)) return { active: false }
  const w = watchSt && watchSt.on ? studyWatch : null
  return {
    active: true,
    phase: studySess.phase,
    round: studySess.round,
    rounds: studySess.rounds,
    lenMin: studySess.lenMin,
    brkMin: studySess.brkMin,
    auto: !!studySess.auto,
    minsInRound: Math.max(0, Math.round((Date.now() - studySess.roundStartedAt) / 60000)),
    /* 0.45.68 监督契约（只有说好要学才有） */
    supervise: !!(watchSt && watchSt.on),
    goal: watchSt && watchSt.on ? watchSt.goal : '',
    heat: watchSt && watchSt.on ? Math.round(watchSt.heat) : 0,
    mood: w ? studyWatch.levelOf(watchSt.heat) : 'off',
    strikes: watchSt && watchSt.on ? watchSt.strikes : 0,
    sulking: w ? studyWatch.sulking(watchSt, Date.now()) : false,
    ledger: w ? studyWatch.report(watchSt, Date.now()) : '',
    /* 0.45.69：今天的账（含不在学习模式时的历史场次）+ 补时策略 + 申论字数开关 */
    today: ledgerSummary(),
    penaltyMin: watchSt && watchSt.on ? Math.round(Number(watchSt.penaltyAdded) || 0) : 0,
    penaltyPer: watchSt ? Number(watchSt.penaltyPer) || 0 : 0,
    targetMin: watchSt && watchSt.on ? Math.round(Number(watchSt.targetMin) || 0) : 0,
    essayOn: !!(watchSt && watchSt.essayOn),
    essayWords: watchSt ? Number(watchSt.essayWords) || 0 : 0,
    screens: (() => { try { return require('electron').screen.getAllDisplays().length } catch { return 1 } })()
  }
}

/* ---------------- 0.45.68 学习监督：她真的会看屏幕，真的会生气 ----------------
 *
 * 用户原话：「学习模式弄出来为的是能让我好好学习，而不是只是一个开关。
 * 优化方式是如果跟角色说好要学习，会不定时过来看一眼屏幕，如果在玩游戏或者看
 * 其他的视频就会过来指责小生气，持续这样就会彻底生气，所有行为都会记录在长期记忆中。」
 *
 * 0.22.0 那套只是每 15 分钟盲问一句「还在学吗」——她看不见屏幕，那根本不算监督，
 * 只是个人肉闹钟。0.45.12 的自动陪学又只负责安静陪着（他没跟你约定，凭什么指责他）。
 * 这里补上真正的那个东西：
 *
 *   契约成立（说好要学）→ 不定时截一张屏 → 视觉判定 study/idle/fun
 *   → 怨气累积 → 小生气 → 真生气 → 彻底生气（罢工、去一边待着）
 *   → 每次判定都写进长期记忆（第二天她还记得）
 *
 * 判不出来的时候（没视觉能力 / 接口挂了）**当作没查**，绝不误伤。
 */
const studyWatch = require('./studyWatch')
let watchSt = null
let watchTimer = null
let watchBusy = false
/** 学习账本（workspace 下 study/ledger.json）。切 workspace 时置空重载 */
let studyDb = null
function ledger () {
  if (!curWsDir) return null
  if (!studyDb) studyDb = studyLedger.load(curWsDir)
  return studyDb
}
/** 账本摘要（当前会话 + 今天）：给 systemPrompt 注入，保证「不用问也记得今天学了什么」 */
function ledgerSummary () {
  try {
    const db = ledger()
    return db ? studyLedger.summary(db, Date.now()) : ''
  } catch { return '' }
}

/**
 * 把上一场「没走 studyStop 就结束」的学习补记掉（0.45.69）。
 * 场景很常见：他直接关窗口/关机/崩了 → watchSt 只存在内存里，一场学习凭空消失。
 * 账本落盘了 active 标记，启动时按最后一次抽查时间结算，并写进长期记忆。
 */
function sweepDanglingStudy (ch) {
  const db = ledger()
  if (!db) return
  const d = studyLedger.dangling(db)
  if (!d) return
  const startAt = Number(d.startedAt) || 0
  const endAt = Math.max(startAt, Number(d.lastAt) || startAt)
  const mins = Math.max(0, Math.round((endAt - startAt) / 60000))
  try { studyLedger.close(db, endAt, { aborted: true }) } catch { }
  const text = '上一场学习没正常收场（' + (d.date || '') + '，目标「' + (d.goal || '学习') + '」，约 ' +
    mins + ' 分钟，抽查 ' + (Number(d.checks) || 0) + ' 次，在玩 ' + (Number(d.fun) || 0) + ' 次）'
  log('[studywatch] ' + text)
  // 用调用方传来的角色卡（syncInner 刚拿到的），比此刻再问 character.get() 稳
  watchRemember(text, 3, ch && ch.id)
}

/** 判定器提示词（放在 studyWatch 里，好让 tools/study-judge-probe.js 用同一份测准头） */
const WATCH_JUDGE_SYS = studyWatch.JUDGE_SYS

/** 无视觉时的兜底：只认「确定」的窗口，不确定就不判（宁可漏抓，不可冤枉） */
function judgeByWindow (fg) {
  if (!fg) return null
  const text = String(fg.pn || '') + ' ' + String(fg.title || '')
  if (!text.trim()) return null
  if (studyAuto.FUN_RE.test(text)) {
    return { v: 'fun', what: '前台是「' + (fg.title || fg.pn) + '」', subj: '' }
  }
  const scene = studyAuto.sceneOf({ pn: fg.pn, title: fg.title })
  if (scene) {
    return { v: 'study', what: '在前台' + scene.label + '（' + (fg.title || fg.pn) + '）', subj: '' }
  }
  return null
}

/** 视觉判定：一次非流式请求，只要一行 JSON。
 * 0.46.5 改走 chatOnce：原来这里散装 fetch + max_tokens:200 + 无空回复兜底，
 * 若网关模型带思维链（reasoning_content），思考就能把预算吃光——视觉判定从上线起
 * 一次都不会成功（与经历沉淀同款病，当时实测「可用」只是碰上了非 thinking 模型）。
 * chatOnce 自带瞬态重试 + 空+length 预算重试 + 超时封顶，判读是旁路不拖主对话。 */
async function judgeByVision (c, b64, fg, goal, note) {
  const head = '主人的学习目标是：' + (goal || '未指定') +
    '\n前台窗口：' + (fg ? (String(fg.pn || '?') + '｜' + String(fg.title || '')) : '未知') +
    (note ? '\n' + String(note).slice(0, 200) : '') +
    '\n请判定这张屏幕截图。'
  const messages = [
    { role: 'system', content: WATCH_JUDGE_SYS },
    {
      role: 'user',
      content: [
        { type: 'text', text: head },
        { type: 'image_url', image_url: { url: /^data:image\//.test(String(b64)) ? String(b64) : 'data:image/jpeg;base64,' + b64 } }
      ]
    }
  ]
  try {
    const txt = await llm.chatOnce({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages, temperature: 0, maxTokens: 300, timeoutMs: 30000
    })
    return studyWatch.normalizeVerdict(txt)
  } catch (e) {
    // 400/422 = 这个接口不收图，记一笔（下次别再白截一张图）
    if (e && (e.status === 400 || e.status === 422)) {
      try { patchCfg({ visionNoImage: true }) } catch { }
    }
    throw e
  }
}

/** 看一眼：图优先，判不出来退回窗口判据，都不行返回 null */
async function watchJudge () {
  const c = cfg()
  const goal = watchSt ? watchSt.goal : ''
  let fg = null
  try {
    const snap = await launcher.scan({ maxAge: 4000 })
    const list = (snap && snap.windows) || []
    const w0 = list.find((w) => w && w.fg)
    if (w0) fg = { pn: String(w0.pn || '').replace(/\.exe$/i, ''), title: String(w0.t || '') }
  } catch { }
  let shot = null
  let shotNote = ''
  if (c.visionOn !== false && canSeeScreen(c.apiModel)) {
    try {
      const r = await tools.exec('see_screen', {})
      if (r && typeof r === 'object' && r.image) {
        shot = r.image
        shotNote = String(r.text || '')
      }
    } catch (err) {
      log('[studywatch] 截屏失败：' + (err && err.message))
    }
  }
  if (shot) {
    try {
      const v = await judgeByVision(c, shot, fg, goal, shotNote)
      if (v) return Object.assign(v, { src: 'vision' })
      log('[studywatch] 视觉判定没给出可用结论，退回窗口判据')
    } catch (err) {
      log('[studywatch] 视觉判定失败：' + (err && err.message))
    }
  } else {
    log('[studywatch] 没有可用截图（无视觉能力或截屏失败），只用窗口判据')
  }
  const w = judgeByWindow(fg)
  return w ? Object.assign(w, { src: 'window' }) : null
}

/**
 * 生成一句监督台词（0.45.69 重写）。
 *
 * 为什么不是「填个模板」：用户明确要求「角色真生气自己说出来的，而不是固定的语句」。
 * 所以这里喂的是**此刻完整的她**——人设 + 当前情绪数值 + 最近说过的话 + 这一眼看到的具体画面，
 * 让她接着自己的情绪往下说，而不是从台词库里挑一句。
 *
 * @param {string} kind 情境（mild_fun / angry / furious / essay …）
 * @param {object} st 契约状态
 * @param {number} [attempt] 第几次尝试（失败重试用，顺便把温度调高一点，避免复读同一句）
 * @returns {Promise<string>} 空串=这次没生成出来（宿主会当作「这次不说话」）
 */
async function makeWatchLine (kind, st, attempt) {
  const c = cfg()
  if (!c.apiBaseUrl || !c.apiModel) return ''
  const hint = studyWatch.fillHint(kind, st)
  if (!hint) return ''
  const rl = c.replyLang || 'zh'
  const langRule = rl === 'auto'
    ? '用与角色平时说话相同的语言。'
    : '只使用' + ({ zh: '中文', en: '英文', ja: '日文' }[rl] || '中文') + '。'

  // 她此刻的自我状态：生气得是「这个她」在生气，不能是一句孤立的台词
  let moodLine = ''
  try {
    const s = self.getState(curWsDir) || {}
    const bits = []
    const mood = Number(s.mood)
    const cold = Number(s.cold)
    if (Number.isFinite(mood)) bits.push('心情 ' + mood.toFixed(2) + '（0=很差 1=很好）')
    if (Number.isFinite(cold)) bits.push('冷淡度 ' + cold.toFixed(2) + '（越高越不想热络）')
    if (bits.length) moodLine = '你此刻的自我状态：' + bits.join('，') + '。'
  } catch { }

  // 最近她亲口说过的话：语气才有连续性，也不会每次用同一个腔调
  let recent = ''
  try {
    const rv = (inner.recentVoices(3) || []).filter(Boolean)
    if (rv.length) recent = '你最近亲口说过：' + rv.join(' / ')
  } catch { }

  try {
    const res = await (llm.chatStreamAuto || llm.chatStream)({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages: [
        {
          role: 'system',
          content: String((character.get() || {}).persona || '').slice(0, 900) +
            '\n\n（场景：' + (st.auto
              ? '你发现他在学习，自己凑过去陪他，也会偷偷看他的屏幕。你说话就是你本人当下要说的话，不是助手、不是提示音、不是复读机。'
              : '你们说好今天要学习，你会自己偷偷看他屏幕。你说话就是你本人当下要说的话，不是助手、不是提示音、不是复读机。') + '）'
        },
        {
          role: 'user',
          content: '【当前情境】\n' + hint +
            (moodLine ? '\n\n' + moodLine : '') +
            (recent ? '\n\n' + recent : '') +
            '\n\n现在是你主动开口，不是回复对方。要求：' +
            '\n1. 只输出你要说的话本身，不要解释、不要加引号、不要写旁白（不要写「（皱眉）」这类），不要换行；' +
            '\n2. 必须提到你这次**具体**看到了什么（说得出细节才像真的看了一眼）；' +
            '\n3. 不要套用客套话、不要说教、不要每次都一个句式，也别复述上面「你最近说过」的内容；' +
            '\n4. 长度按情境来：小生气一两句，真生气更短更硬。' +
            '\n语言：' + langRule
        }
      ],
      temperature: Math.min(1.25, 0.95 + (Number(attempt) || 0) * 0.12)
    })
    return String(res.content || '').trim()
      .replace(/^["'「『]|["'」』]$/g, '')
      .replace(/\s*\n+\s*/g, ' ').slice(0, 140)
  } catch (err) {
    log('[studywatch] 台词生成失败：' + (err && err.message))
    return ''
  }
}

/** 说一句（0.45.69 起：生成不出来就**这次不说话**，绝不拿写死的句子顶。
 *  用户原话「我要的是角色真生气自己说出来的，而不是固定的语句」——固定台词一听就假，
 *  这比沉默更伤。情绪与账本照常累积，下一句真话会更凶。 */
async function watchSpeak (kind, st) {
  let text = await makeWatchLine(kind, st, 0)
  if (!text) {
    // 偶发失败（超时/网关抖动）再给一次机会，别让一次抖动变成整场沉默
    await new Promise((r) => setTimeout(r, 900))
    text = await makeWatchLine(kind, st, 1)
  }
  if (!text) {
    log('[studywatch] 台词没生成出来（' + kind + '），这次不说话——不念固定台词')
    return false
  }
  watchSt = studyWatch.noteSaid(watchSt || st, text)
  await sayProactive(text, { kind: 'study' })
  log('[studywatch] ' + kind + '：' + text.slice(0, 40))
  return true
}

/** 每次判定都进长期记忆（用户明确要求：所有行为都要记） */
function watchNote (kind, st, v) {
  try {
    const seen = ({ study: '在学', fun: '在玩', unsure: '看不清在干嘛', away: '人不在', idle: '走神' })[v.v] || '看不清'
    const react = ({
      mild_fun: '我不太高兴，提醒了他一句',
      unsure: '我轻轻问了一句这是在学还是在休息',
      angry: '我真生气了',
      furious: '我彻底生气了，走到一边去了',
      recover: '他回来学了，我给了个台阶',
      streak: '连着三次都在学，我夸了他'
    })[kind] || '我没说话'
    inner.noteNarration('学习抽查（目标「' + (st.goal || '学习') + '」）：看到他在' + seen +
      (v.what ? '——' + String(v.what).slice(0, 60) : '') + '，' + react)
  } catch { }
}

/**
 * 每一次抽查都当场落到账本（0.45.69）。
 * 用户原话：「做过的这些都是需要进入记忆的，不要退出学习模式之后期间发生过什么都不记得」。
 * 账本负责**明细可查**（她随时能答「今天查了几次、看到什么、补了多少时间」），
 * 长期记忆只记关键节点（开始/被抓/收场）——一天几十条全塞进 400 条上限会把别的记忆挤掉。
 */
function watchLedgerNote (v, r) {
  try {
    const db = ledger()
    if (!db) return
    const now = Date.now()
    studyLedger.noteCheck(db, now, {
      v: v.v, what: v.what, subj: v.subj, words: v.words, kind: r.kind, heat: watchSt && watchSt.heat
    })
    if (r.penalty > 0) studyLedger.addPenalty(db, now, r.penalty)
    if (r.essay) studyLedger.noteEssay(db, now, { words: r.essay.words, target: r.essay.target, short: true })
    // 抓到「在玩」→ 立刻进长期记忆（同一场最多 3 条，够她隔天记得，又不会刷屏）
    if (v.v === 'fun' && (Number(watchSt && watchSt.funStrikes) || 0) <= 3) {
      watchRemember('学习抽查抓到他没在学：' + String(v.what || '屏幕上是娱乐内容').slice(0, 60) +
        '（第 ' + (Number(watchSt.strikes) || 1) + ' 次）' +
        (r.kind === 'furious' ? '，我彻底生气了' : r.kind === 'angry' ? '，我真生气了' : '，我提醒了他'), 3)
    }
  } catch (err) {
    log('[studywatch] 记学习账本失败：' + (err && err.message))
  }
}

/**
 * 往长期记忆里写一条（学习这件事必须留痕，不靠日记定稿）。
 * 0.45.69：以前 catch 静默吞错，结果「没写进去」也看不见——现在成功失败都留日志。
 */
function watchRemember (text, importance, forceId) {
  try {
    const ch = character.get() || {}
    const id = forceId || (ch && ch.id)
    if (!id) {
      log('[studywatch] 记忆没写：还取不到角色 id。本条：' + String(text).slice(0, 40))
      return false
    }
    const ev = memory.addEvent(id, {
      cat: 'fact',
      text: String(text).slice(0, 200),
      keywords: ['学习', '监督'].concat(String((watchSt && watchSt.goal) || '').split(/[、,，\s]+/).filter(Boolean)),
      importance: importance || 3,
      source: 'study'
    })
    log('[studywatch] 记忆写入（' + id + '）：' + String(text).slice(0, 50) + (ev ? '' : '（同文已存在→强化）'))
    return true
  } catch (err) {
    log('[studywatch] 写长期记忆失败：' + (err && err.message))
    return false
  }
}

/** 彻底生气 → 整体情绪也压下来。
 *  只凶那一句不够：她其它地方还在撒娇会让「生气」显得假。压 mood、加 cold，
 *  碎碎念/黏人会自动变少，观感才立得住。 */
function watchSulkMood () {
  try {
    const ws = curWsDir
    if (!ws) return
    const st = self.getState(ws)
    const mood = Math.max(0.05, (Number(st.mood) || 0.5) - 0.25)
    const cold = Math.min(1, (Number(st.cold) || 0) + 0.3)
    self.patchState(ws, { mood: mood, moodAt: Date.now(), cold: cold }) // moodAt：心情动了就重置回血计时（0.46.34）
    log('[studywatch] 彻底生气：情绪压下来了（mood ' + mood.toFixed(2) + ' cold ' + cold.toFixed(2) + '）')
  } catch (err) {
    log('[studywatch] 压情绪失败：' + (err && err.message))
  }
}

/**
 * 抽查一次。why 只用于日志。
 * @returns {Promise<null|{verdict:string,kind:string,level:string}>}
 */
async function watchOnce (why) {
  if (watchBusy || !watchSt || !watchSt.on) return null
  watchBusy = true
  try {
    const v = await watchJudge()
    if (!v) {
      // 判不出来 = 这次没查。绝不能因为接口抽风就骂人，也不能白攒怨气
      log('[studywatch] 判不出来，这次不算（' + why + '）')
      watchSt = Object.assign({}, watchSt, { nextAt: Date.now() + 7 * 60000 })
      return null
    }
    /* 0.45.75 黑屏/锁屏 = 人不在：他在睡觉，不是在走神。
     * 自动陪学 → 立刻静默收场（不记账不写记忆）；手动会话 → 连续两次人不在才收（第一次可能只是去倒水）。 */
    if (v.v === 'away') {
      const stA = studyWatch.onVerdict(watchSt, v, Date.now())
      watchSt = stA.st
      log('[studywatch] 抽查（' + why + '/' + v.src + '）：人不在（' + String(v.what || '黑屏/锁屏').slice(0, 40) + '）' +
        '，连续第 ' + watchSt.awayStreak + ' 次')
      if (watchSt.auto || Number(watchSt.awayStreak) >= 2) {
        log('[studywatch] 人不在 → 学习会话静默收场（不记账不写记忆）')
        await studyStop(true, { away: true })
      }
      return { verdict: 'away', kind: 'away', level: 'away' }
    }
    const r = studyWatch.onVerdict(watchSt, v, Date.now())
    watchSt = r.st
    log('[studywatch] 抽查（' + why + '/' + v.src + '）：' + v.v + ' ' + String(v.what || '').slice(0, 50) +
      ' → 怨气 ' + Math.round(watchSt.heat) + '（' + r.level + '）' +
      (r.penalty ? '｜补时 +' + r.penalty + ' 分钟' : '') +
      (r.essay ? '｜申论才 ' + r.essay.words + '/' + r.essay.target + ' 字' : ''))
    watchNote(r.kind, watchSt, v)
    watchLedgerNote(v, r)
    if (r.say) await watchSpeak(r.kind, watchSt)
    if (r.kind === 'furious') watchSulkMood()
    studyTrayPoke()
    return { verdict: v.v, kind: r.kind, level: r.level }
  } catch (err) {
    log('[studywatch] 抽查异常：' + (err && err.message))
    return null
  } finally {
    watchBusy = false
  }
}

async function watchTick () {
  if (!watchSt || !watchSt.on) return
  const r = studyWatch.tick(watchSt, Date.now())
  watchSt = r.st
  if (r.action === 'sulk_over') {
    log('[studywatch] 罢工结束，气消了一点，自己回来了')
    try { await watchSpeak('sulk_back', watchSt) } catch { }
    return
  }
  // 休息时间就是休息：这时候玩游戏、刷视频是应该的，绝不能记仇。
  // 顺便把下次抽查往后推，免得休息一结束就被查（刚回来还没坐稳就挨骂，很蠢）。
  if (studySess && studySess.phase === 'break') {
    watchSt = Object.assign({}, watchSt, { nextAt: Date.now() + 8 * 60000 })
    return
  }
  if (r.action !== 'check') return
  if (genAbort) return                        // 正在生成/聊天，别插嘴
  try { if (require('../petBridge').isQuiet()) return } catch { }
  await watchOnce('定时')
}

function stopWatchTimer () {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
}

function watchStartTimer () {
  stopWatchTimer()
  watchTimer = setInterval(() => { watchTick().catch(() => { }) }, 45 * 1000)
  try { watchTimer.unref && watchTimer.unref() } catch { }
}

/** 开契约（0.45.75 起自动陪学也开，auto=true 时用自动陪学的措辞与抽查节奏） */
function watchBegin (opts) {
  const o = opts || {}
  const c = cfg()
  const targetMin = Math.round(Number(o.targetMin) || 0) ||
    (Number(c.studyMinutes) || 45) * (Number(c.studyRounds) || 3)
  watchSt = studyWatch.start(Date.now(), {
    goal: o.goal || c.studyGoal || '',
    targetMin: targetMin,
    auto: !!o.auto,
    /* 0.45.69 新增两个可配项 */
    penaltyMin: c.studyPenaltyMin != null ? Number(c.studyPenaltyMin) : 5,
    essayOn: c.studyEssayOn === true,
    essayWords: Number(c.studyEssayWords) || 1000
  })
  watchStartTimer()
  // 0.45.69 账本开一场（落盘，程序被杀也不丢）+ 立刻写一条长期记忆
  try {
    const db = ledger()
    if (db) studyLedger.open(db, Date.now(), { goal: watchSt.goal, targetMin: watchSt.targetMin })
  } catch (err) { log('[studywatch] 开账本失败：' + (err && err.message)) }
  if (watchSt.auto) {
    watchRemember('我注意到他在' + (o.sceneLabel || '学习') +
      '，自己凑过去安静陪着，也会不定时看一眼他的屏幕：认真学就陪，在玩我会不高兴', 2)
  } else {
    watchRemember('开始学习「' + watchSt.goal + '」，目标 ' + watchSt.targetMin + ' 分钟' +
      (watchSt.penaltyPer ? '，抓到分心会补 ' + watchSt.penaltyPer + ' 分钟' : '') +
      '，我会自己不定时看一眼他的屏幕', 2)
  }
  log('[studywatch] 学习契约成立' + (watchSt.auto ? '（自动陪学）' : '') + '：目标「' + watchSt.goal + '」' + watchSt.targetMin +
    ' 分钟，下次抽查约 ' + Math.round((watchSt.nextAt - Date.now()) / 60000) + ' 分钟后' +
    (watchSt.penaltyPer ? '｜补时 ' + watchSt.penaltyPer + ' 分' : '') +
    (watchSt.essayOn ? '｜申论检查 ' + watchSt.essayWords + ' 字' : ''))
  return watchSt
}

/** 结束契约（收账 + 沉淀进长期记忆）
 *  0.45.69：**无论 silent 与否都要记账记账**——silent 只表示「这次别开口说话」，
 *  不是「这件事没发生过」。用户明确要求学完必须记得。 */
function watchEnd (silent, opts) {
  if (!watchSt) return
  const now = Date.now()
  const quiet = !!(opts && opts.quiet)   // 0.45.75 人不在时收场：不写「陪了一场/抓到分心」类的记忆
  const st = studyWatch.stop(watchSt, now)
  const rep = studyWatch.report(st, now)
  watchSt = st
  stopWatchTimer()
  // 账本结算（时长/抽查/补时）+ 当天摘要
  let daySum = ''
  try {
    const db = ledger()
    if (db) {
      studyLedger.close(db, now, {
        heat: Math.round(Number(st.heat) || 0),
        penaltyMin: Math.round(Number(st.penaltyAdded) || 0),
        essayShort: (st.lastEssay && st.essayCount) || 0
      })
      daySum = studyLedger.summary(db, now)
    }
  } catch (err) { log('[studywatch] 收账失败：' + (err && err.message)) }
  log('[studywatch] 契约结束' + (quiet ? '（quiet：人不在，记忆不落）' : '') + '：' + rep + (daySum ? '｜今日 ' + daySum : ''))
  if (quiet) return
  // 收场这一条必须进长期记忆（importance 4：这是「昨天你答应学习结果在玩」的来源）
  watchRemember('这一场学习收账：' + rep + (daySum ? ' 今日累计——' + daySum : ''), 4)
  try { inner.noteNarration('这一场学习收账——' + rep) } catch { }
  try { distillExperience('陪主人学习（目标「' + (st.goal || '') + '」）：' + rep, '陪学').catch(() => { }) } catch { }
  if (silent) return
}

/* ---------------- 0.45.12 自动学习模式：她发现他在学，就自己安静地陪 ----------------
 * 用户原话：需要自动进入的学习模式，不是开关式的。
 * 每分钟看一眼前台窗口（launcher.scan 自带 1.2s 缓存，成本可忽略）：
 * 连续 8 分钟都在学习类应用 → 自动进入静音陪学；场景消失 5 分钟 → 轻声收场。
 * 冷却 45 分钟防反复进出；只管自动会话，手动叫的陪学绝不插手。 */
const studyAuto = require('./studyAuto')
let studyAutoTimer = null
let studyAutoSt = null
/** 自动陪学的在场阈值：系统空闲（无键鼠输入）超过 15 分钟＝人不在，别对着空椅子夸他学了 45 分钟 */
const AUTO_STUDY_AWAY_SEC = 15 * 60

function startStudyAuto () {
  stopStudyAuto()
  if (studyAutoTimer) return
  studyAutoSt = studyAuto.freshState(Date.now())
  studyAutoTimer = setInterval(async () => {
    try {
      const c = cfg()
      if (c.studyOn === false || c.studyAutoOn === false) return
      if (genAbort) return                       // 正在聊天不打扰
      // 只管自动会话：手动陪学进行中时不做场景退出判定（他可能合上 IDE 去查资料，等他喊停）
      const autoActive = !!(study.active(studySess) && studySess.auto)
      const manualActive = !!(study.active(studySess) && !studySess.auto)
      if (manualActive) return
      const snap = await launcher.scan({ maxAge: 4000 }).catch(() => null)
      const list = (snap && snap.windows) || []
      const fgWin = list.find((w) => w && w.fg)
      // 窗口字段 {pn, t, fg, hwnd} → sceneOf 认 {pn, title}
      const fg = fgWin ? { pn: String(fgWin.pn || '').replace(/\.exe$/i, ''), title: String(fgWin.t || '') } : null
      /* 0.45.71 在场闸（主人 11-01 早上的质问）：昨夜他 23:34 就睡了，
       * 前台还挂着 Word → 自动陪学 23:56 进场，一路对着空椅子报
       * 「45分間よく頑張ったね」「休憩おしまい」到 09:05，她于是「记得」两人学了一整夜。
       * 用系统级空闲时间判定：键盘鼠标 15 分钟没动就算人不在——不算场景，
       * 进行中的也会在 EXIT_AFTER_MIN 后自动收场（而且收场话术不夸人）。 */
      let idleSec = 0
      try { idleSec = Number(require('electron').powerMonitor.getSystemIdleTime()) || 0 } catch { }
      const away = idleSec >= AUTO_STUDY_AWAY_SEC
      const scene = away ? null : studyAuto.sceneOf(fg)
      if (away && autoActive) log('[study] 主人 ' + Math.round(idleSec / 60) + ' 分钟没动静，自动陪学准备收场')
      const r = studyAuto.tick(studyAutoSt, {
        now: Date.now(),
        scene,
        studyActive: autoActive
      })
      studyAutoSt = r.st
      if (r.action === 'enter') {
        studyAutoSt = studyAuto.markStarted(studyAutoSt)
        log('[study] 自动进入静音陪学（场景：' + r.label + '）')
        studyStart({ auto: true, sceneLabel: r.label }).catch(() => { })
      } else if (r.action === 'exit') {
        if (away) {
          log('[study] 自动陪学收场（主人不在：' + Math.round(idleSec / 60) + ' 分钟没动静，静默收尾不记账）')
          studyStop(true, { away: true }).catch(() => { })
        } else {
          log('[study] 自动陪学收场（场景离开：' + r.label + '）')
          studyStop().catch(() => { })
        }
      }
    } catch (err) {
      log('[study] 自动模式异常：' + (err && err.message))
    }
  }, 60 * 1000)
  try { studyAutoTimer.unref && studyAutoTimer.unref() } catch { }
}

function stopStudyAuto () {
  if (studyAutoTimer) { clearInterval(studyAutoTimer); studyAutoTimer = null }
}


async function handleMessage (char, userText) {
  const c = cfg()
  const history = character.history(char.id)
  history.push({ role: 'user', content: userText, at: Date.now() })
  // 自我层事件流：主人开口了（她的主动发言是否「被回应」就靠这个判定）
  try { inner.noteUser(userText) } catch { }
  // 0.36.0 语义精判（伴侣面板这条入口也得走；noteUser 那边有幂等，重复进会不会双计）
  // 注意排除最后一条：那是刚 push 进去的这句本身，判读器会把它当上下文重复读一遍
  try {
    inner.judgeUser(userText, { presence: getPresence(), context: history.slice(-7, -1) }).catch(() => { })
  } catch { }
  // 0.22.0 黏人模式：主人开口 → 计时清零（说「去睡了」则静默）
  try { nudgeOnUser(userText) } catch { }

  const trimmed = ctxBudget.trimHistory(history, c.historyChars > 0 ? c.historyChars : 18000, 12)
    .map((m) => ({ role: m.role, content: stampChat(m) }))
  const messages = [{ role: 'system', content: systemPrompt(char, userText) }]
  /* 0.45.64 被动看屏（用户反馈「她记忆里的屏幕画面永远停在刚打开程序那会，前后对话还矛盾」）：
     see_screen 是主动工具，日志实测她一次都没调用过——对屏幕的描述全靠窗口标题猜，
     所以画面永远是旧的、说的话前后打架。这里改成每轮对话前自动抬眼看一眼，
     把截图作为多模态 user 消息插在「主人刚说的话」之前（最新证据紧贴问题，模型才会用）。
     90 秒内不重复截（密集对话省 token）；失败静默跳过，绝不拖垮对话。 */
  if (c.visionOn !== false && canSeeScreen(c.apiModel)) {
    try {
      /* 0.45.66：maxAge 从 90s 收到 8s。90s 的本意是省 token，但代价是「她描述的是
         一分半前停住的画面」——用户看到的正是「记忆里的画面一直停在旧的那一帧」。
         本地截屏不花钱，贵的是图片 token（约 1k/张，一轮只带一张，且历史里不存图），
         所以宁可每轮都抬眼看一次。8s 只是防止同一句话被拆成多次请求时重复截。 */
      const shot = await tools.autoShot({ maxAgeMs: 8000 })
      if (shot) {
        const tail = trimmed.pop()
        trimmed.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: '（你抬头看了一眼屏幕，这是【此刻】的画面。只有这张图里出现的东西才算真的——' +
                '历史对话、记忆、以前看过的画面都已经过期，不要拿旧的描述当现在，两者冲突时一律以这张图为准。）'
            },
            { type: 'image_url', image_url: { url: shot.url } }
          ]
        })
        if (tail) trimmed.push(tail)
        log('[companion] 被动看屏：已附图 ' + Math.round(shot.url.length / 1024) + 'KB')
      }
    } catch { }
  }
  messages.push(...trimmed)

  const seq = Date.now()
  // 0.45.64 按模型能力给「眼睛」：能收图 → see_screen；收不了图 → screen_now（窗口标题文字版）
  const toolDefs = [...memory.toolDefs(), ...tools.defs(c.visionOn !== false, !canSeeScreen(c.apiModel))]
  const ctrl = new AbortController()
  genAbort = ctrl
  // 一轮流式生成。语言守卫纠正时会用新 seq 再跑一轮（渲染层按 seq 重置气泡）
  const runStream = (msgs, s) => {
    let acc = ''
    return llm.chatStream({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages: msgs, temperature: c.temperature != null ? c.temperature : 0.8,
      tools: toolDefs, signal: ctrl.signal,
      toolExec: (name, args) => {
        if (['remember', 'forget', 'recall_memory'].includes(name)) return memory.execTool(char.id, name, args)
        return tools.exec(name, args)
      },
      onDelta: (t) => { acc += t; send('companion:delta', { seq: s, text: t }); bcast('companion:delta', { seq: s, text: t }) }
    }).then((res) => ({ res, content: res.content || acc }))
  }
  let full = ''
  let toolResults = null
  try {
    let r
    try {
      r = await runStream(messages, seq)
    } catch (e1) {
      // 0.45.64：有些模型 / 中转网关不收 image_url（400 invalid content），
      // 去掉被动看屏那张图再试一次——多长一只眼睛不能把主对话搞死。
      // 0.45.66：只对「跟图片有关」的 400 去图重试，并且把结论落盘（visionNoImage），
      // 下轮开始直接走 screen_now 文字版，不用每句话都白撞一次 400。
      const hasImg = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))
      const emsg = String((e1 && e1.message) || '')
      const imgRelated = /image|vision|multimodal|content|400/i.test(emsg) && !/reasoning_content/i.test(emsg)
      if (!hasImg || (e1 && e1.name === 'AbortError') || !imgRelated) throw e1
      log('[companion] 被动看屏附图被拒，去图重试：' + emsg.slice(0, 120))
      try {
        patchCfg({ visionNoImage: true })
        log('[companion] 已记住「这个接口不收图片」，之后改用窗口标题版眼睛（换模型会自动重试）')
      } catch { }
      for (const m of messages) {
        if (!Array.isArray(m.content)) continue
        const txt = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
        m.content = txt || '（你抬眼看了下屏幕）'
      }
      r = await runStream(messages, seq)
    }
    full = r.content
    toolResults = r.res.toolResults
    // 语言守卫：固定回复语言但输出明显错语 → 追加一条定向纠正，重生成一次（对齐参考 dialogue_language_guard）
    const langName = { zh: '中文', en: '英文', ja: '日文' }[c.replyLang] || ''
    if (langName && full && langMismatch(full, c.replyLang)) {
      log('[companion] 语言守卫触发：回复语言不符（设为' + langName + '），定向纠正一次')
      const r2 = await runStream([
        ...messages,
        { role: 'assistant', content: full },
        { role: 'user', content: '【系统纠正·最高优先级】你上一条回复的语言不符合要求。请把同样的内容【只】用' + langName + '重新输出一遍：只输出纠正后的回复正文，不要任何解释，不要夹杂任何其它语言。' }
      ], seq + 1)
      if (r2.content && !langMismatch(r2.content, c.replyLang)) full = r2.content
    }
    history.push({ role: 'assistant', content: full, at: Date.now() })
    // 0.45.34 同款：正文内嵌 <pet_act> 接住（气泡链路，与 assistant/index.js 同一处理）
    try {
      const inl = require('../petBridge').extractInlineAct(full)
      if (inl.actions.length) {
        full = inl.text
        history[history.length - 1].content = full
        Promise.resolve(require('../petBridge').invoke('pet_act', { actions: inl.actions }))
          .catch(() => { })
        log('[companion] 正文内嵌动作已接住并播放：' + inl.actions.join('/'))
      }
    } catch { }
    try { inner.noteReply(full) } catch { }
    // 这一轮答完了 → 陪看白板的游标才往前走（提前推会把同一批字幕吃掉，下一轮就成了空）
    try { screenText.commit() } catch { }
    memory.extractFacts(char.id, userText)
    // 台词（full，按回复语言=配音语言生成）与字幕（display，翻译后的显示文本）分流：
    // TTS 朗读台词原文，气泡/聊天窗显示字幕 —— 例：台词=日语 + 字幕=中文 → 说日语显示中文
    let display = full
    let audio = null
    const jobs = []
    if (c.ttsMode === 'api' && full) {
      jobs.push(tts.speak({
        provider: c.ttsProvider || 'openai',
        // Fish 必须用自己的端点/Key——回退到 LLM 的 apiBaseUrl 会把请求发到 DeepSeek 等非 Fish 服务
        baseUrl: c.ttsProvider === 'fish' ? (c.fishBaseUrl || 'https://api.fish.audio/v1/tts') : (c.ttsBaseUrl || c.apiBaseUrl),
        apiKey: c.ttsProvider === 'fish' ? (c.fishApiKey || c.ttsApiKey || c.apiKey) : (c.ttsApiKey || c.apiKey),
        model: c.ttsModel || 'tts-1',
        // 音色跟角色卡走（卡优先，全局 ttsVoice 只兜底）——0.18.0 修正
        ...cardVoiceParams(c, char),
        refAudio: c.ttsRefAudio, textLang: c.ttsTextLang, promptText: c.ttsPromptText, promptLang: c.ttsPromptLang,
        fishModel: c.fishModel, asmrVoiceId: c.fishAsmrVoiceId,
        format: c.fishFormat, latency: c.fishLatency, feeling: c.fishFeeling, tagDensity: c.fishTagDensity,
        speed: c.ttsSpeed || 1, text: full
      }).then((a) => { audio = a }).catch((err) => {
        log('[companion] TTS 失败，回退浏览器:', err.message)
      }))
    }
    const subLang = c.subLang || 'off'
    const subName = { zh: '中文', en: '英文', ja: '日文' }[subLang] || ''
    // 台词本来就是字幕语言时不浪费一次翻译调用
    if (subName && full && !(c.replyLang !== 'auto' && c.replyLang === subLang) && langMismatch(full, subLang)) {
      jobs.push(translateLine(c, full, subName).then((s) => { if (s) display = s }))
    }
    if (jobs.length) await Promise.all(jobs)
    // 历史条目带上字幕：回看时台词+译文都看得到
    if (display && display !== full) history[history.length - 1].sub = display
    character.saveHistory(char.id, history)
    // 0.45.26 全出口入账：桌宠气泡的往来也写进本体账本（主人的要求——所有行为聊天都进记忆）
    try { require('../assistant').ledgerNote({ via: 'pet', user: userText, assistant: full, sub: display !== full ? display : '' }) } catch { }
    send('companion:done', { seq, content: display, raw: full, tools: toolResults, audio })
    bcast('companion:done', { seq, content: display, raw: full, audio })
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? '（已停止生成）' : String(err && err.message)
    if (full) {
      history.push({ role: 'assistant', content: full + msg, at: Date.now() })
      character.saveHistory(char.id, history)
    }
    send('companion:error', { seq, message: msg, partial: full })
    bcast('companion:error', { seq, message: msg, partial: full })
  } finally {
    genAbort = null
  }
}

/* ---------------- ASR 转发（Whisper 兼容） ---------------- */

async function transcribe (base64, mime, pcmB64, via) {
  const c = cfg()
  // 0.48.0 声纹：PCM 到了就验「是谁在说」（与转写互相独立——ASR 失败声纹照样算）。
  // 只认 global.companion.voiceprintOn !== false；enroll 模式下顺带把样本收进模板。
  let vp = null
  const vpVia = String(via || 'mic')
  if (!pcmB64 || String(pcmB64).length <= 64) {
    log('[voiceprint] 这句没带 PCM（口=' + vpVia + '，该口没采集或采集失败）')
  } else if (c.voiceprintOn !== false) {
    try {
      voiceprint.configure({
        on: true,
        enroll: c.voiceprintEnroll === true,
        same: c.voiceprintSame, maybe: c.voiceprintMaybe
      })
      const f32 = voiceprint.pcmFromB64(pcmB64)
      const r = voiceprint.verifyPcm(f32, voiceprint.TARGET_SR, vpVia)
      if (r.ok) {
        vp = { speaker: r.speaker, sim: r.sim, samples: r.samples, enrolled: r.enrolled }
        // 0.48.5：成功路径也留痕（0.48.4 真机零日志无法判断判定分支是否真跑）
        if (r.enrolled) log('[voiceprint] 样本收下 ' + r.samples + '/3（口=' + vpVia + '）')
        else log('[voiceprint] 判定：' + r.speaker + ' sim=' + Number(r.sim).toFixed(2) + '（口=' + vpVia + '）')
      }
      else log('[voiceprint] 跳过：' + (r.reason || '未知原因'))
      // 注册模式：攒满 3 段自动收闸（config 置回 false，下次启动不会一直收样本）
      if (r.ok && r.enrolled && r.samples >= 3) {
        patchCfg({ voiceprintEnroll: false })
        voiceprint.configure({ enroll: false })
        log('[voiceprint] 声纹注册完成（3 段样本已入模板），voiceprintEnroll 已自动关掉')
      }
    } catch (e) {
      log('[voiceprint] 验证异常：' + (e && e.message))
    }
  }
  // 0.49.2 背景响度闸：21:02~21:03 实锤五连幻觉回复——Whisper 对着 rms 0.004~0.025 的
  // 环境噪音幻觉出「中文字幕组」「我没有声音，多少次」这种字，全进了对话，她认真回了
  // 每一句（主人：「我没有说过这些话」）。真人在旁边不会回应背景噪音。你说话是
  // 0.077~0.19，3 倍以上间距，闸不打到真人。p90 口径与 pet.js startVad 的说话判定
  //（rms>0.045）同一标准：VAD 都不认为是说话的响度，不该变成「他说的」。顺带治了
  // 幻觉段把 whisper 队列堵出 55 秒延迟的病。注册模式豁免（收样本永远不拦）。
  if (pcmB64 && String(pcmB64).length > 64 && c.voiceprintEnroll !== true) {
    try {
      const lvl = speakLevel(voiceprint.pcmFromB64(pcmB64))
      if (lvl < 0.045) {
        log('[voice] 背景响度（p90 rms=' + lvl.toFixed(3) + ' < 0.045，口=' + vpVia + '）——不进 ASR 不进对话')
        return { ok: true, text: '', quiet: true, speaker: vp && vp.speaker, sim: vp && vp.sim }
      }
    } catch (e) { log('[voice] 响度闸异常：' + (e && e.message)) }
  }
  // 0.49.5 陌生声纹闸：23:02~23:05 实锤视频外放变成「他说的话」——崩坏3歌词
  // 「我会在你身边，你会在我身边。」和署名字幕「词曲 李宗盛」被 Whisper 转出来
  // 进了对话，她认真回了（主人：「是不是把视频声音也当成我说的话了啊」）。
  // 响度闸只拦得住安静的噪音，拦不住很响的外放。声纹数据已齐：外放/他人声
  // sim 0.01~0.23，主人真声最差被判错的一次也有 0.49（0.72/0.55 阈），中间
  // 空档干净——sim<0.30 的强 other 连 ASR 都不进（顺带给 whisper 队列卸压）。
  // 真声远场误伤风险待观察，留痕齐全随时回调。注册模式豁免。
  if (vp && vp.speaker === 'other' && Number(vp.sim) < 0.30 && c.voiceprintEnroll !== true) {
    log('[voice] 陌生声纹（sim=' + Number(vp.sim).toFixed(2) + ' < 0.30，口=' + vpVia + '）——不进 ASR 不进对话')
    return { ok: true, text: '', quiet: true, gate: 'stranger', speaker: vp.speaker, sim: vp.sim }
  }
  const r = await transcribeBase(base64, mime)
  // 0.48.5：ASR 失败也要回传声纹判定（两者互相独立，别让转写失败吞掉「是谁在说」）
  if (vp && r) { r.speaker = vp.speaker; r.sim = vp.sim; if (vp.enrolled) { r.enrolled = true; r.samples = vp.samples } }
  return r
}

/* 0.49.2 分段响度（p90）：把 PCM 切 100ms 帧，取第 90 百分位的帧 rms——
 * 说话是断续的，整段均值会被停顿拉低；p90 抓的是「最响的那些帧」，
 * 稳稳区分开说话（≥0.077）与环境噪音（≤0.025）。 */
function speakLevel (f32) {
  const n = f32.length
  const frame = 1600 // 100ms @16k
  const lv = []
  for (let i = 0; i + frame <= n; i += frame) {
    let s = 0
    for (let j = i; j < i + frame; j++) s += f32[j] * f32[j]
    lv.push(Math.sqrt(s / frame))
  }
  if (!lv.length) return n ? Math.abs(f32[0]) : 0
  lv.sort((a, b) => a - b)
  return lv[Math.min(lv.length - 1, Math.floor(lv.length * 0.9))]
}

async function transcribeBase (base64, mime) {
  const c = cfg()
  // 2.1 本地识别：麦克风录音直接喂 faster-whisper（与刷B站共用同一套 venv，完全离线）
  if (c.asrProvider === 'local') {
    const tmpFiles = []
    try {
      const tr = require('../bili/transcribe')
      const asrSvc = require('../bili/asr-service')
      const home = path.join(app.getPath('userData'), 'bili-duty')
      const buf = Buffer.from(base64, 'base64')
      if (buf.length < 2000) return { ok: false, message: '录音太短' }
      const dir = path.join(home, 'asr')
      fs.mkdirSync(dir, { recursive: true })
      const f = path.join(dir, 'mic-' + Date.now() + '.webm')
      fs.writeFileSync(f, buf)
      tmpFiles.push(f)
      const model = c.asrLocalModel || 'small'
      const language = c.asrLang || 'auto'
      // 常驻服务优先（0.18.0）：模型只加载一次，每句 1~3 秒；
      // 一次性脚本每句都要冷启动 4~6 秒，常开麦克风下像卡死。
      const quick = await asrSvc.transcribe(home, f, { model, language })
      if (quick.ok) return { ok: true, text: quick.text, via: 'local-whisper-service', lang: quick.language, audioSec: quick.durationSec }
      log('[asr] 常驻服务不可用（' + quick.error + '），回退一次性转写')
      const r = await tr.transcribeAudioFile(home, f, { model, language })
      if (!r.ok) return { ok: false, message: r.error }
      return { ok: true, text: r.text, via: 'local-whisper', audioSec: r.durationSec }
    } catch (err) {
      return { ok: false, message: String(err && err.message) }
    } finally {
      for (const f of tmpFiles) { try { fs.rmSync(f, { force: true }) } catch { } }
    }
  }
  if (!c.asrBaseUrl) return { ok: false, message: '未配置语音识别端点' }
  const base = String(c.asrBaseUrl).replace(/\/+$/, '')
  const url = /\/transcriptions$/.test(base) ? base : base + '/audio/transcriptions'
  try {
    const buf = Buffer.from(base64, 'base64')
    const fd = new FormData()
    fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.webm')
    fd.append('model', c.asrModel || 'whisper-1')
    // auto（默认）不传 language，交给 Whisper 自动识别中/英/日
    if (c.asrLang && c.asrLang !== 'auto') fd.append('language', c.asrLang)
    const headers = {}
    if (c.asrApiKey || c.apiKey) headers.Authorization = 'Bearer ' + (c.asrApiKey || c.apiKey)
    const res = await fetch(url, { method: 'POST', headers, body: fd })
    if (!res.ok) return { ok: false, message: 'ASR ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 150) }
    const j = await res.json()
    return { ok: true, text: j.text || '' }
  } catch (err) {
    return { ok: false, message: String(err && err.message) }
  }
}

/* 识别串行队列（0.18.0 修复）：常开麦克风（micMode=always）下 VAD 会连续断句，
 * 每句话都立刻起一个 whisper 子进程 → 4、5 个 python 同时抢 CPU，每个要几十秒，
 * 用户看到的是「语音识别失败」（其实是全部超时）。串行后一次只跑一个，其余排队等。
 * 队列上限 3：再多说明她已经跟不上你说话了，直接告诉用户在识别，别无声堆爆内存。 */
let asrBusy = false
const asrQueue = []
const ASR_QUEUE_MAX = 3

function transcribeQueued (base64, mime, pcmB64, via) {
  return new Promise((resolve) => {
    asrQueue.push({ base64, mime, pcm: pcmB64, via, resolve })
    pumpAsr()
  })
}

function pumpAsr () {
  if (asrBusy) return
  const job = asrQueue.shift()
  if (!job) return
  asrBusy = true
  Promise.resolve()
    .then(() => transcribe(job.base64, job.mime, job.pcm, job.via))
    .then(
      (r) => job.resolve(r),
      (e) => job.resolve({ ok: false, message: String((e && e.message) || e) })
    )
    .finally(() => {
      asrBusy = false
      // 排队的下一句接着来
      setImmediate(pumpAsr)
    })
}

/* ---------------- IPC ---------------- */

/** AI 配置的对外视图（init / settings IPC 共用） */
// 0.45.87 动作词表构建（原 petVrmaActs 内联逻辑提出来，供动作测试面板列词用）：
// 默认映射=数据目录 motions 下各 .vrma 的文件名主干 + 中文别名 + config.petVrmaActs 覆盖。
function buildPetVrmaActs (c) {
  const WORD_ALIASES = {
    走路: 'walk', 散步: 'walk', 步行: 'walk', 走两步: 'walk',
    跳舞: 'dance', 舞蹈: 'dance', 跳支舞: 'dance', 跳个舞: 'dance',
    挥手: 'wave', 打招呼: 'wave', 再见: 'wave', 拜拜: 'wave',
    待机: 'idle', 休息: 'idle'
  }
  const map = {}
  try {
    const dir = path.join(app.getPath('userData'), 'motions')
    for (const f of fs.readdirSync(dir)) {
      if (!/\.vrma$/i.test(f)) continue
      map[f.replace(/\.vrma$/i, '')] = path.join(dir, f)
    }
  } catch { }
  for (const [alias, base] of Object.entries(WORD_ALIASES)) {
    if (map[base]) map[alias] = map[base]
  }
  Object.assign(map, (c.petVrmaActs && typeof c.petVrmaActs === 'object') ? c.petVrmaActs : {})
  return Object.keys(map).length ? map : null
}

// 0.45.87 动作测试面板列词：VRMA 词（motions/ 目录）+ 语义池/官方硬映射代表词。
// 0.46.14 诚实列词：spine 立绘下 VRMA 词全播不了、官方代表词大半不在权威词典
// （万岁/跳/蹲下/躺下/转圈/睡觉/说吧 只会「抖一下」= 用户眼里「点了没反应」，
//  真机排查被误导过）。按当前形象过滤，只列真的能响的词；VRM 模型维持原列表。
let spineWordsCache = null
function spinePlayableWords () {
  if (!spineWordsCache) {
    try {
      delete globalThis.SPINE_WORD_MAP
      require('../renderer/shared/spine-words.js')
      spineWordsCache = Object.keys(globalThis.SPINE_WORD_MAP || {})
    } catch { spineWordsCache = [] }
  }
  return spineWordsCache
}
function listActionWords () {
  const vis = (typeof pet.currentVisual === 'function') ? pet.currentVisual() : null
  const isSpine = !!(vis && !vis.vrm && (vis.mode === 'spine' || vis.spine))
  if (isSpine) {
    const ok = new Set(spinePlayableWords())
    // 常用代表词里挑词典命中的；坐/站词由 petBridge.act() 状态机受理（不依赖词典）恒列
    const wanted = ['挥手', '打招呼', '再见', '拜拜', '加油', '打气', '拍手', '鼓掌', '害羞', '思考',
      '思索', '质疑', '托腮', '伸懒腰', '悄悄话', '慌张', '吓一跳', '比耶', '轻笑', '耳语', '叉腰']
    const builtin = wanted.filter((w) => ok.has(w))
    builtin.push('坐下', '站起来', '坐地上')
    return { vrma: [], builtin }
  }
  const vrma = buildPetVrmaActs(cfg())
  const vrmaWords = vrma ? Object.keys(vrma) : []
  const builtin = ['坐下', '站起来', '挥手', '打招呼', '万岁', '加油', '跳', '蹲下', '躺下', '转圈', '睡觉', '坐地上', '说吧']
  return { vrma: vrmaWords, builtin }
}

function settingsView () {
  const c = cfg()
  return {
    apiBaseUrl: c.apiBaseUrl || '', apiModel: c.apiModel || '', apiKey: c.apiKey || '',
    visionOn: c.visionOn !== false,
    // 0.34.0 陪看字幕（OCR 读屏幕字幕 → 每轮拼进提示词；模型没有视觉时这是唯一的「看得到」）
    screenTextOn: !!c.screenTextOn,
    screenTextRect: c.screenTextRect || null,
    screenTextInterval: Number(c.screenTextInterval) || 1200,
    screenTextHideSelf: c.screenTextHideSelf !== false,
    // 0.36.0 语义判读（每句话过一次小模型，认意思而不是认字面）
    judgeOn: c.judgeOn !== false,
    // 0.37.0 她自己待着（没人跟她说话时自己找事做）
    curiosityOn: c.curiosityOn !== false,
    // 0.45.14 自动学习/游戏自动进入/自主活动量/碎碎念高频（试险）
    studyAutoOn: c.studyAutoOn !== false,
    gameAutoOn: c.gameAutoOn !== false,
    autonomyMaxMin: Number(c.autonomyMaxMin) || 6,
    autonomyDailyMax: Number(c.autonomyDailyMax) || 6,
    chatterBoostOn: c.chatterBoostOn === true,
    chatterDailyMax: Number(c.chatterDailyMax) || 5,
    // 0.46.0 自言自语系统：朗读（默认开、低频）与自主活动中自语上限
    chatterVoiceOn: c.chatterVoiceOn !== false,
    chatterVoiceChance: Math.min(1, Math.max(0, c.chatterVoiceChance == null ? 0.3 : Number(c.chatterVoiceChance))),
    chatterVoiceDailyMax: Math.max(1, Number(c.chatterVoiceDailyMax) || 12),
    autonomySoliloquyMax: Math.max(0, Number(c.autonomySoliloquyMax == null ? 3 : Number(c.autonomySoliloquyMax))),
    petOn: c.petOn !== false,
    petScale: c.petScale != null ? c.petScale : 1,
    petWalk: c.petWalk || 'off', // 走动三档：off / calm / lively（0.46.0 默认 off：坐姿素材，默认坐着不溜达）
    petFullscreenHide: c.petFullscreenHide !== false, // 全屏游戏/视频时自动让位
    readReply: c.readReply !== false, // 朗读 AI 回复（助手核心回复也发声），默认开（用户澄清气泡音≠朗读，保持原默认）
    replyLang: c.replyLang || 'zh',
    subLang: c.subLang || 'off',
    ttsMode: c.ttsMode || 'browser', ttsProvider: c.ttsProvider || 'openai',
    ttsBaseUrl: c.ttsBaseUrl || '', ttsModel: c.ttsModel || '', ttsApiKey: c.ttsApiKey || '',
    ttsVoice: c.ttsVoice || '', sysVoiceName: c.sysVoiceName || '',
    fishApiKey: c.fishApiKey || '',
    netProxy: c.netProxy || '',
    ttsRefAudio: c.ttsRefAudio || '', ttsTextLang: c.ttsTextLang || 'zh', ttsPromptText: c.ttsPromptText || '', ttsPromptLang: c.ttsPromptLang || 'zh',
    ttsSpeed: c.ttsSpeed || 1,
    // 0.22.0 本地回退链：Fish → SoVITS（快）→ IndexTTS（慢兜底）→ 系统语音
    sovitsOn: c.sovitsOn !== false,
    sovitsDir: c.sovitsDir || '',
    sovitsRef: c.sovitsRef || '',
    sovitsPromptText: c.sovitsPromptText || '',
    indexTtsOn: c.indexTtsOn !== false,
    indexTtsDir: c.indexTtsDir || '',
    indexTtsRef: c.indexTtsRef || '',
    userProfile: c.userProfile || {},
    fishBaseUrl: c.fishBaseUrl || 'https://api.fish.audio/v1/tts',
    fishModel: c.fishModel || 's2.1-pro-free',
    fishVoiceId: c.fishVoiceId || '', fishAsmrVoiceId: c.fishAsmrVoiceId || '',
    fishFormat: c.fishFormat || 'wav', fishLatency: c.fishLatency || 'normal',
    fishFeeling: c.fishFeeling || 0, fishTagDensity: c.fishTagDensity || 0,
    asrBaseUrl: c.asrBaseUrl || '', asrModel: c.asrModel || 'whisper-1', asrLang: c.asrLang || 'auto', asrApiKey: c.asrApiKey || '',
    // 2.x 语音：收音三模式 / 本地识别 / 打断 / 繁→简
    micMode: c.micMode || 'always',
    asrProvider: c.asrProvider || 'cloud',
    asrLocalModel: c.asrLocalModel || 'small',
    interruptOn: !!c.interruptOn,
    openccOn: !!c.openccOn,
    // 0.19.0 回应模式：active 积极 / quiet 安静（记着等下次开口）/ custom 自定义勾选
    reactionMode: c.reactionMode || 'active',
    reactionTypes: Array.isArray(c.reactionTypes) ? c.reactionTypes : null,
    // S3：模型（pet_set）也能改的外观项，渲染层启动时按这里初始化
    petBubbleScale: c.petBubbleScale != null ? c.petBubbleScale : 1,
    petFontScale: c.petFontScale != null ? c.petFontScale : 1,
    petTheme: c.petTheme || 'dark',
    petSound: c.petSound !== false,
    // 0.18.0 第一批 · 音效分类 / 说话声（气泡逐字音节，零音频资源，WebAudio 合成）
    petSoundKinds: Array.isArray(c.petSoundKinds) ? c.petSoundKinds : null,
    // 0.45.39 MMD 路线：动作词 → VRMA 文件。默认映射=数据目录 motions/*.vrma 的文件名主干，
    // config.petVrmaActs 可手动追加/覆盖（词 → 绝对路径）。
    // 0.45.40：中文别名表——文件叫 walk.vrma 也要【走路】能触发。
    petVrmaActs: buildPetVrmaActs(c),
    petSpeechOn: c.petSpeechOn === true,
    petSpeechPitch: c.petSpeechPitch || 'mid', // low / mid / high
    petSpeechRate: c.petSpeechRate || 'mid', // low / mid / high
    // 0.18.0 第一批 · 状态气泡 / 输入气泡 / 帧率 / 暂停
    petStatusBubble: c.petStatusBubble !== false,
    petInputBubble: c.petInputBubble !== false,
    petFps: c.petFps || 30, // 30 / 60 / 120 / 144
    petPaused: c.petPaused === true,
    // 5.5 悬停按钮：显示哪些动作（最多 6 个，候选 7 种）；没配置由渲染层用默认组
    petHoverButtons: Array.isArray(c.petHoverButtons) ? c.petHoverButtons : null,
    // 0.25.0 用量页：币种与汇率（只影响显示，不改记账本身）
    usageCurrency: String(c.usageCurrency || 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY',
    usageRate: Number(c.usageRate) > 0 ? Number(c.usageRate) : 7.2,
    petUser: c.petUser || '',
    // 7.6 新手引导：完成过一次就不再自动弹
    guideDone: c.guideDone === true,
    // S6.5：电脑操作权限（角色开程序要不要确认）+ 游戏模式
    permMode: c.permMode || 'ask-once',
    permAllowApps: String(c.permAllowApps || ''),
    gameMode: c.gameMode !== false,
    gameModeAuto: c.gameModeAuto !== false,
    gameModeMute: c.gameModeMute === true,
    gameModeGreet: c.gameModeGreet !== false,
    gameModeScale: c.gameModeScale != null ? c.gameModeScale : (c.petScale != null ? c.petScale : 1),
    gameModeCorner: c.gameModeCorner || 'bottom-right',
    // 0.38.0 游戏弹幕层：游戏模式里她的话改成弹幕横着飞 + 角落弹幕框
    danmakuOn: c.danmakuOn !== false,
    danmakuFontSize: Number(c.danmakuFontSize) || 30,
    danmakuSpeed: Number(c.danmakuSpeed) || 1,
    danmakuLock: c.danmakuLock !== false,
    // 0.18.0 M3 屏幕监控陪伴（0.42.0：只有一个「每小时大约几次」的旋钮，
    // watchIntervalSec 是内部看屏节拍，不再暴露给设置页）
    watchEnabled: c.watchEnabled === true,
    proactivePerHour: c.proactivePerHour != null ? c.proactivePerHour : (c.watchMaxPerHour != null ? c.watchMaxPerHour : 3),
    watchQuiet: c.watchQuiet === true,
    // 0.38.0 画面指纹去重（同一张画面不重复看）
    watchSkipSame: c.watchSkipSame !== false,
    // 0.21.0 自我层：负反馈开关（测试期可关）/ 历史字符预算 / 上下文诊断日志
    feedbackMode: c.feedbackMode === 'off' ? 'off' : 'on',
    historyChars: c.historyChars > 0 ? c.historyChars : 18000,
    diagContext: c.diagContext === true,
    // 0.22.0 补丁⑧⑨：学习模式 / 做梦 / 风格学习（此前漏了这几项，重开面板总是回默认值）
    studyOn: c.studyOn !== false,
    // 0.46.54 听觉通道开关（true=默认开；config.json global.companion.hearOn=false 关，
    // 改后重启生效——关掉的只是「特征聚合」，麦克风开关仍归语音捕捉管）
    hearOn: c.hearOn !== false,
    studyMinutes: c.studyMinutes != null ? c.studyMinutes : 45,
    studyBreak: c.studyBreak != null ? c.studyBreak : 10,
    studyRounds: c.studyRounds != null ? c.studyRounds : 3,
    dreamOn: c.dreamOn !== false,
    dreamIdleHours: c.dreamIdleHours != null ? c.dreamIdleHours : 3,
    dreamAutoApprove: c.dreamAutoApprove === true,
    styleOn: c.styleOn !== false,
    // 0.23 第 3 期：她的工具自迭代总开关
    userToolsOn: c.userToolsOn === true,
    // 0.22.0 黏人模式：太久没理她会阶梯式来找（关掉就完全不主动找人）
    idleNudgeOn: c.idleNudgeOn !== false,
    // 0.24.0 随身服务（出门方案第 1 期）：开关/端口/口令（口令给手机页面填一次）
    remoteOn: c.remoteOn === true,
    remotePort: Number(c.remotePort) || 8720,
    remoteStreamFps: Math.max(1, Math.min(30, Number(c.remoteStreamFps) || 10)),
    remoteStreamQ: Math.max(40, Math.min(95, Number(c.remoteStreamQ) || 75)),
    remoteStreamH: [0, 720, 1080, 1440].includes(Number(c.remoteStreamH)) ? Number(c.remoteStreamH) : 1080,
    remoteToken: String(c.remoteToken || ''),
    remoteTsIp: remote.status().tsIp || '',
    remoteTlsPort: Number(remote.status().tlsPort) || 0,
    remoteTsFqdn: remote.status().tsFqdn || '',
    remoteRunning: !!remote.status().running,
    // 0.24.0 电脑画像：她了解「主人平时在电脑上干什么」的只读档案
    pcProfileOn: c.pcProfileOn === true,
    // 0.44.0 记录键盘与输入内容（只在本地落盘；依赖 pcProfileOn 才有落盘目录）
    keyLogOn: c.keyLogOn === true,
    // 0.43.0 没人的时候她自己用电脑（默认关：这是真的会动键鼠的功能）
    autonomyOn: c.autonomyOn === true,
    // 0.45.0 三挡位：1 只看看 / 2 我的地盘（指定目录随意读写）/ 3 完全开放
    autonomyLevel: Math.min(3, Math.max(1, Number(c.autonomyLevel) || 1)),
    autonomyDir: String(c.autonomyDir || ''),
    // 0.45.2 空闲阈值可调（分钟，1~120，默认 5）
    autonomyIdleMin: Math.min(120, Math.max(1, Math.round(Number(c.autonomyIdleMin) || 5))),
    pcProfileDays: Math.max(1, Math.min(90, Number(c.pcProfileDays) || 14)),
    pcProfileStatus: (() => {
      try { return require('../profile').status({ wsDir: curWsDir }) } catch { return null }
    })()
  }
}

function registerIpc () {
  // 0.50.0 本地大模型自动路由：启动即按配置接线路由 + 后台首探（在线与否都不影响云端主路）
  try {
    applyLocalLlm()
    localLlm.probe().catch(() => { })
  } catch (e) { log('[localLlm] 初始化失败：' + (e && e.message)) }
  // 语音请求代理：启动时按配置初始化（空=跟随系统，direct=强制直连，其它=自定义规则）
  try { require('./tts').setTtsProxy(cfg().netProxy) } catch (err) { log('[companion] 初始化 TTS 代理失败:', err.message) }
  // 0.48.0 声纹：路径对齐 userData/voiceprint/，配置跟 global.companion 走；引擎后台预热
  try {
    const { app } = require('electron')
    const vpDir = path.join(app.getPath('userData'), 'voiceprint')
    const c0 = cfg()
    voiceprint.configure({
      modelPath: path.join(vpDir, 'eres2net.onnx'),
      templatePath: path.join(vpDir, 'template.json'),
      on: c0.voiceprintOn !== false,
      enroll: c0.voiceprintEnroll === true,
      same: c0.voiceprintSame, maybe: c0.voiceprintMaybe,
      log
    })
    voiceprint.ensureEngine().catch(() => { }) // 后台预热（首次可能下模型），失败留 reason 由 verify 诚实降级
    // 设置页 UI 暂未接：撤回途径=删 userData/voiceprint/template.json（导读已写明），状态看日志 [voiceprint]
  } catch (e) { log('[voiceprint] 初始化失败：' + (e && e.message)) }
  // 0.24.0 电脑画像：原始缓存落 <userData>/pc-profile/，摘要落角色工作区 pc/
  try {
    const { app } = require('electron')
    require('../profile').init({ dataRoot: app.getPath('userData'), log })
    // 0.24.0 健康记录：原始数据落 <userData>/health/log.jsonl（跟角色无关，是主人自己的身体数据）
    try { require('../health').init({ dataRoot: app.getPath('userData'), log }) } catch (e) { log('[health] 初始化失败: ' + e.message) }
    // 角色/工作区是异步加载的，等 8 秒再按开关决定要不要采样（首次采集也在里面）
    const t = setTimeout(() => { try { syncProfile() } catch (e) { log('[profile] 启动调度失败: ' + e.message) } }, 8000)
    if (t.unref) t.unref()
  } catch (e) { log('[profile] 初始化失败: ' + e.message) }
  // 自设（用户资料）开机同步进会话提示词
  syncUserProfile()
  // 她的记录（0.20.0）：日记 / 成长年表 / 长出来的习惯与好恶 / 当前关系状态
  ipcMain.handle('mind:snapshot', () => {
    try {
      const ws = require('../assistant').workspaceDirFor((character.get() || {}).id)
      if (!ws) return { ok: false, error: '还没初始化好，稍后再试' }
      const s = require('./self')
      let growth = ''
      try { growth = fs.readFileSync(path.join(ws, 'self', 'growth.md'), 'utf8') } catch { }
      return {
        ok: true,
        charName: (character.get() || {}).name || '',
        wsDir: ws,
        days: s.recentDays(ws, 7),
        growth,
        habits: s.getHabits(ws),
        tastes: s.getTastes(ws),
        state: s.getState(ws),
        today: s.dayStats(ws)
      }
    } catch (err) { return { ok: false, error: err && err.message } }
  })
  // 手动触发（验收用，否则要等到晚上才写得出来）
  ipcMain.handle('mind:write-now', async () => {
    try { return await inner.writeDayDiary() } catch (err) { return { ok: false, error: err && err.message } }
  })
  ipcMain.handle('mind:distill-now', async () => {
    try { return await inner.distill() } catch (err) { return { ok: false, error: err && err.message } }
  })
  /* 0.21.0 自我层：负反馈可回滚（测试期核心诉求）
   * 三个动作分工明确：
   *   feedback      看当前状态（安静度/冷淡/连续被无视/今日发言与回应率）
   *   feedback-reset 只清零情绪，事件流与日记一篇不动
   *   feedback-rollback 回到「几小时前」的状态（找当时最近的那条快照） */
  ipcMain.handle('mind:feedback', () => {
    try { return { ok: true, data: inner.overview() } } catch (err) { return { ok: false, error: err && err.message } }
  })
  ipcMain.handle('mind:feedback-reset', () => {
    try {
      const r = inner.resetFeedback()
      log('[inner] 情绪已清零（事件流与日记保留）')
      return r
    } catch (err) { return { ok: false, error: err && err.message } }
  })
  ipcMain.handle('mind:feedback-rollback', (_e, hours) => {
    try {
      const h = Math.max(0.1, Math.min(24 * 30, Number(hours) || 24))
      const r = inner.rollbackFeedback(Math.round(h * 3600 * 1000))
      if (r && r.ok) {
        log('[inner] 状态已回滚到 ' + new Date(r.at).toLocaleString('zh-CN', { hour12: false }) +
          '（quiet=' + r.state.quiet.toFixed(2) + ' cold=' + r.state.cold.toFixed(2) + '）')
      } else {
        log('[inner] 回滚失败：那个时间点没有快照')
      }
      return r
    } catch (err) { return { ok: false, error: err && err.message } }
  })
  // 0.37.0 她自己待着：设置页看「今天她自己做了几件 / 上一件是什么」
  ipcMain.handle('mind:curiosity', () => {
    try {
      const st = getCuriosity().status()
      const log2 = inner.selfLog(6)
      return {
        ok: true,
        data: Object.assign({}, st, {
          recent: log2.map((e) => ({ at: Number(e.t) || 0, text: String(e.text || '') })).reverse(),
          // 0.36.0 语义判读的现行状态（此前算好了却没人显示，用户根本无法确认它有没有在生效）
          judge: (() => { try { return inner.judgeStatus() } catch { return null } })()
        })
      }
    } catch (err) { return { ok: false, error: err && err.message } }
  })
  // 跨天检索（验收用：问「上周三」到底能不能找回那一天）
  ipcMain.handle('mind:recall', (_e, q, k) => {
    try {
      const hits = inner.searchDays(String(q || ''), Number(k) || 5)
      const ws = require('../assistant').workspaceDirFor((character.get() || {}).id)
      const s = require('./self')
      return { ok: true, hits: hits.map((h) => Object.assign({}, h, { text: ws ? s.readDay(ws, h.date).slice(0, 600) : '' })) }
    } catch (err) { return { ok: false, error: err && err.message } }
  })
  /* ---- 第 1 期：做梦 + 审查队列 ---- */
  ipcMain.handle('mind:dream-now', async () => {
    try { return await dreamRun('manual') } catch (err) { return { ok: false, error: err && err.message } }
  })
  /* ---- 0.45.2 自主活动：状态 + 测试跑（设置页「让她现在就跑一场」） ---- */
  ipcMain.handle('autonomy:status', () => {
    try { return autonomyInst ? autonomyInst.status() : { on: false, level: 1 } } catch { return null }
  })
  ipcMain.handle('autonomy:run-now', async () => {
    try {
      if (!autonomyInst) startAutonomy()
      const r = await autonomyInst.tick({ force: true })
      return r || { ok: false, why: 'running' }
    } catch (err) { return { ok: false, error: err && err.message } }
  })
  ipcMain.handle('mind:dream-status', () => {
    const ws = curWsDir
    if (!ws) return { ok: false }
    const st = self.getState(ws) || {}
    const items = review.load(ws)
    return {
      ok: true,
      lastDream: st.lastDream || '',
      lastDreamAt: Number(st.lastDreamAt) || 0,
      dreaming,
      pending: review.pending(items).length,
      autoApprove: cfg().dreamAutoApprove === true
    }
  })
  ipcMain.handle('mind:review-list', () => {
    if (!curWsDir) return { ok: false, pending: [], recent: [] }
    const items = review.load(curWsDir)
    return { ok: true, pending: review.pending(items), recent: review.recent(items, 12) }
  })
  ipcMain.handle('mind:review-decide', (_e, id, action) => {
    try {
      if (!curWsDir) return { ok: false, error: 'no-ws' }
      let items = review.load(curWsDir)
      const d = review.decide(items, String(id || ''), action === 'approve' ? 'approve' : 'reject')
      items = d.items
      let applied = false
      if (d.item && action === 'approve') {
        const before = applyReviewItem(d.item)
        items = review.markApplied(items, d.item.id, before).items
        applied = true
      }
      review.save(curWsDir, items)
      log('[review] ' + (action === 'approve' ? '批准' : '拒绝') + ' #' + String(id || '') + (applied ? '（已落地）' : ''))
      return { ok: true, applied }
    } catch (err) { return { ok: false, error: err && err.message } }
  })
  ipcMain.handle('mind:review-rollback', (_e, id) => {
    try {
      if (!curWsDir) return { ok: false, error: 'no-ws' }
      const items = review.load(curWsDir)
      const r = review.rollback(items, String(id || ''))
      if (r.item) review.save(curWsDir, r.items)
      log('[review] 回滚 #' + String(id || '') + (r.error ? ' 失败: ' + r.error : ' 成功'))
      return { ok: !r.error, error: r.error }
    } catch (err) { return { ok: false, error: err && err.message } }
  })
  /* ---- 第 3 期：她的工具自迭代（面板批准部署 / 停用 / 删除） ---- */
  ipcMain.handle('mind:ut-list', () => {
    try { return { ok: true, tools: require('../assistant/userTools').list() } }
    catch (err) { return { ok: false, error: err && err.message, tools: [] } }
  })
  ipcMain.handle('mind:ut-decide', (_e, name, action) => {
    try {
      const ut = require('../assistant/userTools')
      const n = String(name || '')
      if (action === 'enable') return ut.deploy(n)
      if (action === 'disable') return ut.undeploy(n)
      if (action === 'delete') return ut.remove(n)
      if (action === 'log') return { ok: true, runs: ut.runLog(n, 5) }
      return { ok: false, error: '未知操作 ' + action }
    } catch (err) { return { ok: false, error: err && err.message } }
  })
  ipcMain.handle('companion:init', () => {
    return {
      characters: character.list(),
      history: character.history(character.get().id),
      settings: settingsView()
    }
  })
  ipcMain.handle('companion:settings', () => settingsView())
  // 0.45.14 今日互动统计（社交数据面板）
  ipcMain.handle('companion:interact-stats', () => {
    statRoll()
    let rhythmToday = 0
    try { rhythmToday = (rhythmInst ? rhythmInst.status().todayCount : 0) } catch { }
    let autonomyToday = 0
    try { autonomyToday = (autonomyInst ? autonomyInst.status().todayCount : 0) } catch { }
    return {
      day: interactStats.day,
      saidToday: interactStats.said,
      rhythmToday,
      autonomyToday,
      reviewAddedToday: interactStats.reviewAdded,
      reachSentToday: interactStats.reachSent
    }
  })

  ipcMain.handle('companion:models', async (_e, baseUrl, apiKey) => llm.listModels({ baseUrl, apiKey }))
  // 0.50.0 本地大模型：设置页探测按钮 → 强制重探并回状态（在线/离线/自动选中的模型）
  ipcMain.handle('companion:local-llm-probe', async () => {
    applyLocalLlm()
    await localLlm.probe({ force: true })
    return localLlm.stats()
  })
  // 0.18.0 M3 屏幕监控陪伴：状态/配置（getWatch 首次调用时按现有配置排定时器）
  ipcMain.handle('watch:status', () => getWatch().status())
  ipcMain.handle('watch:patch', (_e, p) => { const next = getWatch().patch(p || {}); return { ok: true, config: next } })
  // 0.18.0 第二批：桌宠渲染层回报骨架里的动画名（只有角色所在的屏会回）
  ipcMain.on('pet:anim-report', (_e, d) => {
    const charId = String((d && d.charId) || '')
    const list = Array.isArray(d && d.list) ? d.list.slice(0, 300) : []
    if (!charId) return
    animCache.charId = charId
    animCache.list = list
    animCache.at = Date.now()
    log('[pet] 动作清单 ' + charId + ' → ' + list.length + ' 个')
  })
  // 0.18.0 第一批 · 闹钟（列表/新增/删除/启停）
  ipcMain.handle('companion:alarm-list', () => getAlarms().list())
  ipcMain.handle('companion:alarm-add', (_e, a) => getAlarms().add(a || {}))
  ipcMain.handle('companion:alarm-del', (_e, id) => getAlarms().remove(id))
  ipcMain.handle('companion:alarm-toggle', (_e, id, on) => getAlarms().setEnabled(id, !!on))
  // 桌宠暂停/继续（右键菜单/托盘用）：停掉自主走动与主动发声，恢复后照原档位继续
  // 0.18.0 第二批 · 动作清单（Spine moves）：渲染层是唯一知道骨架里有哪些动画的地方，
  // 所以由主进程发命令问它，它回 pet:anim-report；设置页再向主进程要缓存。
  ipcMain.handle('pet:anim-list', async () => {
    const ch = character.get()
    animCache.requestedAt = Date.now()
    bcast('pet:cmd', { kind: 'anim-list' })
    await new Promise((r) => setTimeout(r, 600))
    const fresh = animCache.charId && ch && animCache.charId === ch.id
    return { ok: true, charId: ch ? ch.id : '', list: fresh ? animCache.list : [], stale: !fresh }
  })
  ipcMain.handle('pet:anim-play', (_e, name) => {
    const n = String(name || '').slice(0, 120)
    if (!n) return { ok: false, error: '没有动作名' }
    bcast('pet:cmd', { kind: 'anim-play', name: n })
    return { ok: true }
  })
  ipcMain.handle('pet:set-paused', (_e, on) => {
    const next = !!on
    patchCfg({ petPaused: next })
    try { pet.setPaused(next) } catch { }
    bcast('pet:config', { petPaused: next })
    return next
  })
  /* ---- 0.24.0 电脑画像（只读档案：看状态 / 立即采 / 读某段 / 清空） ---- */
  ipcMain.handle('profile:status', () => {
    try { return { ok: true, ...require('../profile').status({ wsDir: curWsDir }) } } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('profile:collect', async (_e, opts) => {
    try {
      const prof = require('../profile')
      if (!curWsDir) return { ok: false, error: '还没拿到角色工作区' }
      const c = cfg()
      const days = Math.max(1, Math.min(90, Number((opts && opts.days) || c.pcProfileDays) || 14))
      const r = await prof.runCollect({ wsDir: curWsDir, days, force: true, log })
      return r
    } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('profile:read', (_e, section) => {
    try {
      const text = require('../profile').readSection(curWsDir, section)
      return { ok: !!text, text }
    } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('profile:clear', () => {
    try {
      const r = require('../profile').clear({ wsDir: curWsDir })
      log('[profile] 已清空画像档案（删除 ' + r.removed + ' 个文件）')
      return r
    } catch (e) { return { ok: false, error: e.message } }
  })

  // 0.44.0 只清键盘记录（设置页单独的按钮；记录是敏感数据，必须能单独删）
  ipcMain.handle('keys:clear', () => {
    try {
      const r = require('../profile/keys').clearAll()
      log('[keys] 已清空输入记录（删除 ' + r.files + ' 个文件）')
      return { ok: true, removed: r.files }
    } catch (e) { return { ok: false, error: e.message } }
  })

  /* ---- 0.24.0 健康记录（睡眠 / 血压 / 心态 / 体重） ---- */
  ipcMain.handle('health:log', (_e, entry) => {
    try {
      const h = require('../health')
      const r = h.record(Object.assign({ source: 'settings' }, entry || {}))
      if (r.ok) {
        try { h.writeSummary(curWsDir, { days: 14 }) } catch { }
        log('[health] 设置页记录 ' + r.entry.date)
      }
      return r
    } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('health:list', (_e, days) => {
    try { return { ok: true, rows: require('../health').list({ days: Math.max(1, Math.min(365, Number(days) || 30)) }) } } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('health:stats', (_e, days) => {
    try { return { ok: true, ...require('../health').stats({ days: Math.max(1, Math.min(365, Number(days) || 14)) }) } } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('health:clear', () => {
    try {
      const r = require('../health').clear()
      log('[health] 已清空全部健康记录')
      return r
    } catch (e) { return { ok: false, error: e.message } }
  })

  /* ---- 0.34.0 陪看字幕：OCR 读屏幕字幕 → 每轮拼进提示词 ---- */
  ipcMain.handle('screentext:status', () => {
    try { return { ok: true, ...screenText.status(), peek: screenText.peek() } } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('screentext:start', () => {
    try {
      attachScreenText()
      // 先落配置再启动：patchCfg 里那段「重排」在未运行时是空操作，不会把刚起来的定时器又停掉
      patchCfg({ screenTextOn: true })
      const r = screenText.start()
      if (!r.ok) return r
      return { ok: true, status: screenText.status() }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('screentext:stop', () => {
    try {
      const wasOn = screenText.status().on
      patchCfg({ screenTextOn: false })
      if (wasOn && screenText.status().on) screenText.stop('手动')
      return { ok: true, status: screenText.status() }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('screentext:rect', (_e, rect) => {
    try {
      const w = Math.round(Number(rect && rect.w) || 0)
      const h = Math.round(Number(rect && rect.h) || 0)
      if (w < 40 || h < 12) return { ok: false, error: '框太小了（至少 40×12）' }
      const r = { x: Math.round(Number(rect.x) || 0), y: Math.round(Number(rect.y) || 0), w, h }
      patchCfg({ screenTextRect: r })
      return { ok: true, rect: r }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('screentext:once', async () => {
    try { return await screenText.once() } catch (e) { return { ok: false, error: e.message } }
  })

  // 框字幕：每块屏盖一层选区层，松手把 DIP 矩形存进配置
  ipcMain.handle('screentext:pick', () => new Promise((resolve) => {
    try {
      require('./screentext/picker').pick((rect) => {
        if (!rect) return resolve({ ok: false, error: '没框（或者框太小）' })
        patchCfg({ screenTextRect: rect })
        resolve({ ok: true, rect })
      })
    } catch (e) { resolve({ ok: false, error: e.message }) }
  }))

  ipcMain.handle('companion:patch-settings', (_e, patch) => {
    // 陪看字幕：设置页每次保存都会带上全部字段，所以要先记下「改之前」的样子，
    // 才判断得出这次是不是真的动了屏幕字幕相关的东西（不然每次保存都把定时器停一遍）
    let stBefore = null
    try { stBefore = screenText.status() } catch { }
    patchCfg(patch)
    // 0.21.0 负反馈开关：改完立刻生效（关掉后不再累加；已记录的数值保留，要归零走 mind:feedback-reset）
    if (patch.feedbackMode != null) {
      try {
        const mode = inner.setFeedback(patch.feedbackMode)
        log('[inner] 负反馈 ' + (mode === 'off' ? '已关闭（不再累加情绪）' : '已开启'))
      } catch { }
    }
    // 0.24.0 随身服务：开关/端口变化 → 启动/停止/换口
    if (patch.remoteOn != null || patch.remotePort != null) syncRemote()
    // 0.37.0 她自己待着：开关实时启停（关掉后她已经记下的事不会删）
    if (patch.curiosityOn != null) {
      if (patch.curiosityOn) startCuriosity()
      else { stopCuriosity(); log('[curiosity] 已关闭') }
    }
    // 0.38.0 游戏弹幕层：开关/字号/速度改完立刻生效（弹幕窗开着的时候不用重启）
    if (patch.danmakuOn != null) {
      try {
        const dk = require('../danmaku')
        if (patch.danmakuOn === false) dk.stop('setting-off')
        else if (require('../gameMode').isActive()) dk.start('game')
      } catch (e) { log('[danmaku] 开关切换失败: ' + (e && e.message)) }
    }
    if (patch.danmakuLock != null) {
      try { require('../danmaku').setLock(patch.danmakuLock !== false) } catch { }
    }
    if (patch.danmakuFontSize != null || patch.danmakuSpeed != null) {
      try { require('../danmaku').config({}) } catch { }
    }
    // 0.24.0 电脑画像：开关/天数变化 → 启停采样、必要时补采
    // 0.44.0 keyLogOn 变化也要重建：键盘采集是独立的 PowerShell worker，得显式停/起
    if (patch.pcProfileOn != null || patch.pcProfileDays != null || patch.keyLogOn != null) syncProfile()
    // 桌面角色开关实时生效
    if (patch.petOn === true) pet.show()
    else if (patch.petOn === false) pet.hide()
    // 角色大小实时生效：广播给 overlay 重新按比例布置舞台
    if (patch.petScale != null) bcast('pet:config', { scale: patch.petScale })
    // 回复语言实时生效：overlay 触摸语音短语跟着切语种
    if (patch.replyLang != null) bcast('pet:config', { replyLang: patch.replyLang })
    // 朗读 AI 回复开关实时生效
    if (patch.readReply != null) bcast('pet:config', { readReply: !!patch.readReply })
    // 2.x 语音：收音模式 / 打断开关实时下发（overlay 麦克风行为）
    if (patch.micMode != null) bcast('pet:config', { micMode: patch.micMode })
    if (patch.interruptOn != null) bcast('pet:config', { interruptOn: !!patch.interruptOn })
    // 0.18.0 M3 屏幕监控：watch*/ts*（时间观念）字段有变化 → 重排看屏定时器（含总开关启停）
    if (Object.keys(patch).some((k) => String(k).startsWith('watch') || String(k).startsWith('ts'))) getWatch().patch({})
    // 0.34.0 陪看字幕：只在这几个字段**真的变了**时才重排（每次保存都带全字段，不能无脑重排）
    if (Object.keys(patch).some((k) => String(k).startsWith('screenText')) && stBefore) {
      const c = cfg()
      const changed =
        (patch.screenTextOn != null && !!patch.screenTextOn !== !!stBefore.enabled) ||
        (patch.screenTextRect != null && JSON.stringify(patch.screenTextRect || null) !== JSON.stringify(stBefore.rect || null)) ||
        (patch.screenTextInterval != null && Number(patch.screenTextInterval) !== Number(stBefore.interval)) ||
        (patch.screenTextHideSelf != null && !!patch.screenTextHideSelf !== !!stBefore.hideSelf)
      if (changed) {
        try {
          if (stBefore.on) screenText.stop('改配置')
          if (c.screenTextOn) screenText.start()
        } catch (e) { log('[screentext] 重排失败：' + (e && e.message)) }
      }
    }
    // 5.5 悬停按钮的「主题/音效」动作：改配置后实时广播换外观
    if (patch.petTheme != null) bcast('pet:config', { petTheme: patch.petTheme })
    if (patch.petSound != null) bcast('pet:config', { petSound: !!patch.petSound })
    // 0.18.0 第一批：气泡外观 / 说话声 / 状态气泡 / 输入气泡 / 帧率 / 暂停 实时下发
    if (patch.petBubbleScale != null) bcast('pet:config', { petBubbleScale: Number(patch.petBubbleScale) })
    if (patch.petFontScale != null) bcast('pet:config', { petFontScale: Number(patch.petFontScale) })
    if (patch.petSoundKinds != null) bcast('pet:config', { petSoundKinds: patch.petSoundKinds })
    if (patch.petVrmaActs !== undefined) bcast('pet:config', { petVrmaActs: patch.petVrmaActs })
    if (patch.petSpeechOn != null) bcast('pet:config', { petSpeechOn: !!patch.petSpeechOn })
    if (patch.petSpeechPitch != null) bcast('pet:config', { petSpeechPitch: patch.petSpeechPitch })
    if (patch.petSpeechRate != null) bcast('pet:config', { petSpeechRate: patch.petSpeechRate })
    if (patch.petStatusBubble != null) bcast('pet:config', { petStatusBubble: !!patch.petStatusBubble })
    if (patch.petInputBubble != null) bcast('pet:config', { petInputBubble: !!patch.petInputBubble })
    if (patch.petFps != null) bcast('pet:config', { petFps: Number(patch.petFps) || 30 })
    if (patch.petPaused != null) {
      try { pet.setPaused(!!patch.petPaused) } catch { }
      bcast('pet:config', { petPaused: !!patch.petPaused })
    }
    // S2 桌宠行为：走动档位 / 全屏让位，改完立刻重排（关掉让位要马上把角色放回来）
    if (patch.petWalk != null || patch.petFullscreenHide != null) {
      try {
        pet.refreshBehavior()
        pet.setSuspended(require('../fullscreen').isFull())
      } catch (err) { log('[companion] 桌宠行为刷新失败:', err.message) }
      // 0.22.0 修复：整层让位（overlay hide）也要跟着开关重排——
      // 不然关掉「全屏自动隐藏角色」后，全屏时整层还是被 main.js 收走
      if (fullscreenSyncFn) { try { fullscreenSyncFn(require('../fullscreen').isFull()) } catch { } }
    }
    return true
  })

  // 长期记忆账本（可视化 + 手动删除）——0.18.0 起统一读助手核心账本（面板/QQ/桌宠同一份，从聊天自动产生）
  ipcMain.handle('companion:memory-list', () => {
    const id = character.get().id
    migrateLegacyMemory(id)
    const facts = (require('../assistant').memoryFacts(id) || []).slice(-120).reverse()
    return facts.map((f) => ({ seq: f.seq, cat: f.cat, text: f.text, date: f.date, importance: f.importance, source: f.source }))
  })
  ipcMain.handle('companion:memory-del', (_e, seq) => {
    try { return require('../assistant').memoryRemoveBySeq(character.get().id, seq) } catch { return false }
  })

  ipcMain.handle('companion:set-active', (_e, id) => {
    const nc = switchChar(id)
    return { char: nc, history: character.history(id) }
  })

  ipcMain.handle('companion:save-character', (_e, char) => {
    character.upsert(char)
    const nc = character.get(char.id)
    pet.refresh(nc)
    // 自设跟角色卡走：存的是当前角色时，立刻把该卡的用户资料同步给助手会话
    try { if (nc && character.get().id === nc.id) syncUserProfile() } catch { }
    return nc
  })
  ipcMain.handle('companion:new-character', (_e, name) => {
    const id = character.newId(name || 'char')
    const char = { ...JSON.parse(JSON.stringify(character.get())), id, name: name || '新角色', worldBook: [], createdAt: Date.now() }
    character.upsert(char)
    return char
  })
  ipcMain.handle('companion:del-character', (_e, id) => {
    const chars = character.list()
    if (chars.length <= 1) return false
    character.remove(id)
    pet.refresh(character.get())
    return true
  })

  ipcMain.handle('companion:import-asset', async (_e, charId, kind) => {
    const filters = kind === 'vrm'
      ? [{ name: '3D 模型', extensions: ['vrm', 'glb'] }]
      : kind === 'spine'
        ? [{ name: 'Spine', extensions: ['skel', 'json', 'atlas', 'png'] }]
        : [{ name: '图片', extensions: ['png', 'webp', 'jpg', 'gif'] }]
    // Spine 支持一次多选（atlas + skel/json + png），单选时自动在同目录补齐同名三件套
    const props = kind === 'spine' ? ['openFile', 'multiSelections'] : ['openFile']
    const r = await dialog.showOpenDialog(win, { filters, properties: props })
    if (r.canceled || !r.filePaths.length) return kind === 'spine' ? [] : ''
    if (kind !== 'spine') return character.importAsset(charId, r.filePaths[0])
    // 归一化：正斜杠 + 统一小写扩展名判断
    let picked = r.filePaths.map((p) => path.normalize(p))
    // 自动补齐：对每个选中的主名（stem），同目录补齐同名 atlas / skel / json / png。
    // 之前只在单选时补，选 atlas+skel 两个文件时 png 不会跟进来，
    // 资产目录缺贴图 → 加载一直 Couldn't load image → 小蓝星
    const stemOf = (p) => path.basename(p).replace(/\.(atlas|skel|json|png)$/i, '')
    const isSpineExt = (p) => /\.(atlas|skel|json|png)$/i.test(p)
    const stems = [...new Set(picked.filter(isSpineExt).map(stemOf))]
    for (const stem of stems) {
      const dir = path.dirname(picked.find((p) => isSpineExt(p) && stemOf(p) === stem))
      for (const ext of ['.atlas', '.skel', '.json', '.png']) {
        const cand = path.join(dir, stem + ext)
        if (!picked.some((p) => p.toLowerCase() === cand.toLowerCase()) && fs.existsSync(cand)) picked.push(cand)
      }
    }
    return picked.map((p) => character.importAsset(charId, p))
  })

  // 桌面角色窗口 IPC（当前角色 getter / 配置回写）
  pet.registerIpc(() => character.get(), patchCfg)

  ipcMain.handle('companion:asset-url', (_e, p) => character.assetUrl(p))

  // 渲染层贴图兜底：自定义协议 fetch 偶发 Failed to fetch（Image 的 CORS 校验更严），
  // 这里直接主进程读本地文件转 dataURL 返回，彻底绕开协议链路
  ipcMain.handle('companion:asset-data', (_e, p) => {
    try {
      const abs = String(p || '').replace(/\\/g, '/')
      if (!/^[a-zA-Z]:\//.test(abs) || !fs.existsSync(abs)) return null
      const ext = (abs.match(/\.([a-z0-9]+)$/i) || [])[1] || ''
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext.toLowerCase()]
      if (!mime) return null
      return 'data:' + mime + ';base64,' + fs.readFileSync(abs).toString('base64')
    } catch (e) {
      log('[companion] asset-data 失败:', e && e.message)
      return null
    }
  })

  // 诊断：把渲染层 canvas 整帧存成 png，直接看画没画、画成什么样
  ipcMain.handle('companion:log-image', (_e, name, dataUrl) => {
    try {
      const b64 = String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '')
      if (!b64) return null
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, String(name || 'frame').replace(/[^\w.-]/g, '_'))
      fs.writeFileSync(file, Buffer.from(b64, 'base64'))
      log('[companion] 画面已保存:', file)
      return file
    } catch (e) {
      log('[companion] log-image 失败:', e && e.message)
      return null
    }
  })

  ipcMain.handle('companion:send', (_e, text) => {
    const t = String(text || '').trim()
    if (!t) return false
    const c = cfg()
    if (!c.apiBaseUrl || !c.apiModel) {
      send('companion:error', { seq: Date.now(), message: '还没有配置 AI 服务：打开设置 → AI，填入 API 地址与模型（本地模型填 http://127.0.0.1:11434/v1 这类端点即可）' })
      return false
    }
    handleMessage(character.get(), t)
    return true
  })
  ipcMain.handle('companion:stop', () => { if (genAbort) genAbort.abort(); return true })

  // 0.22.0 补丁⑧ 学习模式
  ipcMain.handle('study:start', () => studyStart())
  ipcMain.handle('study:stop', () => studyStop())
  ipcMain.handle('study:status', () => studyStatus())
  ipcMain.handle('companion:clear-history', (_e, id) => { character.saveHistory(id || character.get().id, []); return true })

  // 0.46.55 听觉：渲染层问「听觉开没开、用什么耳朵」。
  // hearSource: auto=先麦（听房间）失败再回环（听电脑自己）／mic=只听麦／sys=只听回环（戴耳机放歌场景）
  ipcMain.handle('companion:hear-state', () => {
    const on = cfg().hearOn !== false
    hear.configure({ on })
    const hs = String(cfg().hearSource || 'auto')
    return { on, source: hs === 'sys' || hs === 'mic' ? hs : 'auto' }
  })

  // 0.46.54 听觉：渲染层每秒一条声音特征摘要（不录音不转写，只有几十字节数字）。
  // hearOn 关着时收但不入库（渲染层侧的麦本来也由用户开关）。
  let hearLastLogAt = 0
  ipcMain.on('overlay:hear-sample', (_e, f) => {
    try {
      const on = cfg().hearOn !== false
      hear.configure({ on })
      if (!on) return
      if (hear.ingest(f) && !hearFirstLogged) {
        hearFirstLogged = true
        log('[hear] 首条听觉样本进来了（耳朵已工作，特征=响度/频段/起伏）')
      }
      // 0.46.55 每分钟一条听感留痕：真机迭代「像什么」映射表就靠它（同类坑#8：反馈节奏慢，主动盯）
      const nowT = Date.now()
      if (nowT - hearLastLogAt > 60 * 1000) {
        hearLastLogAt = nowT
        const d = hear.describe()
        if (d.ok) log('[hear] 此刻听感：' + d.text)
      }
    } catch (err) {
      log('[hear] 样本处理失败：' + (err && err.message))
    }
  })

  ipcMain.handle('companion:transcribe', async (_e, base64, mime, pcmB64, via) => {
    const t0 = Date.now()
    if (asrQueue.length >= ASR_QUEUE_MAX) {
      log('[asr] 队列已满（' + asrQueue.length + ' 句在等），丢弃最新一段')
      return { ok: false, message: '还在识别前面的话，等我说完再讲' }
    }
    const queued = asrQueue.length + (asrBusy ? 1 : 0)
    const r = await transcribeQueued(base64, mime, pcmB64, via)
    const ms = Date.now() - t0
    // 说话识别失败以前只弹气泡不落日志，用户报「识别失败」时无从查起 → 成败都记一行
    try {
      if (r && r.ok) {
        const txt = String(r.text || '')
        log('[asr] 成功 ' + ms + 'ms' + (queued ? '（等了 ' + queued + ' 句）' : '') + (r.via ? ' via=' + r.via : '') +
          (r.lang ? ' lang=' + r.lang : '') + (r.audioSec ? ' 音频' + Math.round(r.audioSec) + 's' : '') +
          ' ' + txt.length + ' 字' + (txt ? '：' + txt.slice(0, 50) : '（空文本，可能太轻/太短）'))
      } else {
        log('[asr] 失败 ' + ms + 'ms：' + ((r && r.message) || '未知原因'))
      }
    } catch { }
    return r
  })

  /* ---------------- 备份：设置（含 API Key）+ 角色卡 + 历史 + 记忆，全部本地文件 ---------------- */

  /** 读 userData/companion 下的 JSON（与 character.js 的落盘格式一致） */
  function readCompanionJson (rel, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'companion', rel), 'utf8')) } catch { return fallback }
  }
  function writeCompanionJson (rel, data) {
    const file = path.join(app.getPath('userData'), 'companion', rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8')
  }

  ipcMain.handle('companion:export-backup', async () => {
    try {
      const r = await dialog.showSaveDialog(win, {
        title: '导出 AuraDesk 全部设置（含 API Key，请妥善保管）',
        defaultPath: 'AuraDesk-backup-' + new Date().toISOString().slice(0, 10) + '.json',
        filters: [{ name: 'AuraDesk 备份', extensions: ['json'] }]
      })
      if (r.canceled || !r.filePath) return { ok: false, message: '' }
      const characters = readCompanionJson('characters.json', [])
      const backup = {
        app: 'AuraDesk', kind: 'full-backup', exportedAt: new Date().toISOString(),
        config: store.get(),
        characters,
        histories: {}, memories: {}
      }
      for (const ch of characters) {
        backup.histories[ch.id] = readCompanionJson(ch.id + '/history.json', [])
        backup.memories[ch.id] = readCompanionJson(ch.id + '/memory.json', {})
      }
      fs.writeFileSync(r.filePath, JSON.stringify(backup, null, 1), 'utf8')
      log('[companion] 备份已导出:', r.filePath)
      return { ok: true, path: r.filePath }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  ipcMain.handle('companion:import-backup', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '从备份文件导入（覆盖当前全部设置与角色数据）',
        filters: [{ name: 'AuraDesk 备份', extensions: ['json'] }],
        properties: ['openFile']
      })
      if (r.canceled || !r.filePaths.length) return { ok: false, message: '' }
      const backup = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
      if (backup.app !== 'AuraDesk' || backup.kind !== 'full-backup') {
        return { ok: false, message: '不是有效的 AuraDesk 备份文件' }
      }
      // 1) 应用配置整体替换（hydrate 合并默认值 + 版本迁移），立即落盘
      if (backup.config) store.replace(backup.config)
      // 2) 角色卡 / 历史 / 记忆
      if (Array.isArray(backup.characters)) {
        writeCompanionJson('characters.json', backup.characters)
        for (const ch of backup.characters) {
          if (backup.histories && backup.histories[ch.id]) writeCompanionJson(ch.id + '/history.json', backup.histories[ch.id])
          if (backup.memories && backup.memories[ch.id]) writeCompanionJson(ch.id + '/memory.json', backup.memories[ch.id])
        }
      }
      log('[companion] 备份已导入:', r.filePaths[0])
      // 3) 重启应用让桌面层/伴侣全部按新配置初始化（最干净）
      setTimeout(() => { app.relaunch(); app.exit(0) }, 1500)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  // Fish Audio 我的声音库（设置页下拉选择音色，不用再手抠 reference_id）
  ipcMain.handle('companion:fish-voices', async () => {
    const c = cfg()
    try {
      return { ok: true, voices: await tts.listFishVoices(c.fishApiKey || c.ttsApiKey || c.apiKey) }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  ipcMain.handle('companion:win', (_e, action) => {
    if (!win || win.isDestroyed()) return
    if (action === 'min') win.minimize()
    else if (action === 'close') win.close()
    else if (action === 'pin') {
      const on = !win.isAlwaysOnTop()
      win.setAlwaysOnTop(on, 'screen-saver')
      return on
    }
    return true
  })
  // 触摸反应语音：短语合成（200 字内）
  ipcMain.handle('companion:tts', async (_e, text) => speakWithCurrentConfig(text))
  // AI 回复朗读：整段合成（v0.5.0 起助手核心回复也要发声）
  ipcMain.handle('companion:speak', async (_e, text) => speakWithCurrentConfig(text))
}

/** 用当前 TTS 配置合成一段语音：{ok,url,speed,lang} 或 {ok:false,fallback:true} */
// 0.46.48 朗读代次：新朗读请求把旧的作废——被顶掉的合成不再继续跑
//（Fish 11s、IndexTTS CPU 兜底几分钟），合成完也不下发播放（用户 22:47：
// 聊天都到后面了还在读前面的话；被中断的就不该读）
let speakRunSeq = 0
let speakAbortCtl = null

async function speakWithCurrentConfig (text) {
  const my = ++speakRunSeq
  try { if (speakAbortCtl) speakAbortCtl.abort() } catch { }
  const ac = new AbortController()
  speakAbortCtl = ac
  // 本地兜底的排队/正在跑的任务一并作废（IndexTTS 一跑几分钟不取消=白烧 CPU）
  try { require('./ttsLocal').cancelPending('朗读已被新的打断') } catch { }
  const c = cfg()
  // 2.5 繁→简：开关打开就把台词转成简体再合成（繁体 TTS 声线少、还常读错字）
  // spokenOnly 先剥【动作】括段（主人 2026-10-31：说话没必要连动作也念出来）；
  // tts.speak 入口还会再剥一次——这里先剥是为了让 SoVITS/IndexTTS 本地回退也吃到干净文本
  let spoken = spokenOnly(String(text || ''))
  if (c.openccOn) {
    try {
      // 懒加载：没开开关就完全不碰这个包
      const OpenCC = require('opencc-js')
      const t2s = OpenCC.Converter({ from: 't', to: 'cn' })
      spoken = t2s(spoken)
    } catch (e) { log('[opencc] 转换失败，按原文朗读: ' + e.message) }
  }
  // lang 随语音结果带回：overlay 触摸反应的短语/系统兜底语种跟回复语言设置走。
  // voiceName 一并带回：browser 兜底朗读用（卡上的朗读音色优先，全局 sysVoiceName 兜底）——
  // 旧实现 overlay 只按语言挑第一个 Windows 语音，配置的音色名完全没被用上
  if (c.ttsMode !== 'api') {
    const cur = character.get() || null
    const voiceName = (cur && cur.voice && cur.voice.sysVoiceName) || c.sysVoiceName || ''
    return { ok: false, fallback: true, message: '语音合成未启用（当前为系统语音/关闭）', lang: c.replyLang || 'zh', voiceName }
  }
  try {
    const r = await tts.speak({
      provider: c.ttsProvider || 'openai',
      baseUrl: c.ttsProvider === 'fish' ? (c.fishBaseUrl || 'https://api.fish.audio/v1/tts') : (c.ttsBaseUrl || c.apiBaseUrl),
      apiKey: c.ttsProvider === 'fish' ? (c.fishApiKey || c.ttsApiKey || c.apiKey) : (c.ttsApiKey || c.apiKey),
      model: c.ttsModel || 'tts-1',
      // 音色跟角色卡走（当前卡优先，全局 ttsVoice 只兜底）——0.18.0 修正
      ...cardVoiceParams(c, character.get()),
      refAudio: c.ttsRefAudio, textLang: c.ttsTextLang, promptText: c.ttsPromptText, promptLang: c.ttsPromptLang,
      fishModel: c.fishModel, asmrVoiceId: c.fishAsmrVoiceId,
      format: c.fishFormat, latency: c.fishLatency, feeling: c.fishFeeling, tagDensity: c.fishTagDensity,
      speed: c.ttsSpeed || 1, text: spoken,
      signal: ac.signal
    })
    if (my !== speakRunSeq) return { ok: false, stale: true, lang: c.replyLang || 'zh' }
    return { ok: true, url: r.url, env: r.env, speed: r.speed, lang: c.replyLang || 'zh' }
  } catch (err) {
    // 0.46.48 被新朗读顶掉的请求：不再走本地兜底（回退链只服务最新一轮）
    if (my !== speakRunSeq || ac.signal.aborted) return { ok: false, stale: true, lang: c.replyLang || 'zh' }
    // 0.22.0 本地回退链（主人 2026-10-26 定案）：Fish 失败/超时 → SoVITS（快，5~20s）
    //   → IndexTTS（慢兜底，30~100s）→ 系统语音。前两级都是角色参考音色。
    if (c.sovitsOn !== false) {
      try {
        const sv = await ttsLocal.synthesizeSovits(spoken, c.replyLang || 'zh', () => cfg())
        if (my !== speakRunSeq) return { ok: false, stale: true, lang: c.replyLang || 'zh' }
        return { ok: true, url: sv.url, env: sv.env, lang: c.replyLang || 'zh', local: true }
      } catch (e2) {
        log('[tts-local] SoVITS 回退失败: ' + (e2 && e2.message))
      }
    }
    if (c.indexTtsOn !== false) {
      try {
        const loc = await ttsLocal.synthesize(spoken, c.replyLang || 'zh', () => cfg())
        if (my !== speakRunSeq) return { ok: false, stale: true, lang: c.replyLang || 'zh' }
        return { ok: true, url: loc.url, env: loc.env, lang: c.replyLang || 'zh', local: true }
      } catch (e2) {
        log('[tts-local] IndexTTS 回退失败: ' + (e2 && e2.message))
      }
    }
    const cur = character.get() || null
    const voiceName = (cur && cur.voice && cur.voice.sysVoiceName) || c.sysVoiceName || ''
    /* 0.46.56 系统语音兜底收敛（11-06 投诉「自定义 TTS 正常用着，系统自带的 TTS
       还是会自动说话」）：选了 API 语音（ttsMode=api）但整条链失败/超时 → 保持
       安静，不再突然冒出 Windows 系统嗓（而且本地兜底超时最长 180s+240s，
       系统语音会在气泡都消失了七分钟后才冒出来念一句，非常吓人）。
       fallback=true 只留给「用户主动选系统语音」的模式（ttsMode!=='api'）。 */
    if (c.ttsMode === 'api') {
      log('[tts] 全链失败，按 0.46.56 规则保持安静（不落系统语音）：' + err.message)
      return { ok: false, fallback: false, message: '语音合成失败：' + err.message, lang: c.replyLang || 'zh', voiceName }
    }
    return { ok: false, fallback: true, message: err.message, lang: c.replyLang || 'zh', voiceName }
  }
}

function stop () {
  if (genAbort) genAbort.abort()
  try { inner.stopDaily() } catch { }
  try { if (chatterInst) chatterInst.stop() } catch { }
  try { stopCuriosity() } catch { }
  try { stopNudge() } catch { }
  try { stopStudyAuto() } catch { }
  try { stopAutonomy() } catch { }
  try { stopStudyTimer() } catch { }
  try { stopDreamTimer() } catch { }
  try { remote.stop() } catch { }
  // 0.24.0 画像采样定时器也要收（不然退出后 interval 还挂着）
  try { require('../profile').stopSampling() } catch { }
  // 常驻转写进程要显式收掉，否则应用关了 python 还在后台占 200~300MB
  try { require('../bili/asr-service').shutdown() } catch { }
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

/** 开机按配置拉起桌面角色（默认开） */
function bootPet () {
  const g = store.get()
  pet.refresh(character.get())
  // 自我层（0.20.0）：绑当前角色的工作区 + 起日记调度（补昨天 + 每 5 分钟看一次该不该写）
  try { syncInner(character.get()); inner.startDaily() } catch (err) { log('[inner] 启动失败: ' + (err && err.message)) }
  // 做梦调度：开机补偿（隔天没做）+ 闲置触发 + 睡前触发，60s 一看
  dreamBootAt = Date.now()
  try { startDreamTimer() } catch (err) { log('[dream] 启动失败: ' + (err && err.message)) }
  // 废话通道：不期待回应的自言自语（每天最多 5 次，只在清醒时段，出气泡不出声）
  try { getChatter().start() } catch (err) { log('[chatter] 启动失败: ' + (err && err.message)) }
  // 0.42.0：共处时长（陪伴感的底料，60s 摸一次空闲时间，不截图不花钱）
  try { startTogether() } catch (err) { log('[together] 启动失败: ' + (err && err.message)) }
  try { startNudge() } catch (err) { log('[nudge] 启动失败: ' + (err && err.message)) }
  // 0.45.93 排好的主动 QQ 消息（她答应「几点发」的那条）——20 秒一查，重启接着兑现
  try { migrateRetiredPlans() } catch { }   // 0.47.1 旧排期计划清账
  // 0.45.12 自动学习模式：她发现他在学，就自己安静地陪（不是开关，是她的自觉）
  try { startStudyAuto() } catch (err) { log('[study] 自动模式启动失败: ' + (err && err.message)) }
  try { startAutonomy() } catch (err) { log('[autonomy] 启动失败: ' + (err && err.message)) }
  // 她自己待着（0.37.0）：没人跟她说话时，她自己找点事做并记下来
  try { startCuriosity() } catch (err) { log('[curiosity] 启动失败: ' + (err && err.message)) }
  if (!g.global.companion || g.global.companion.petOn !== false) pet.show()
  // 上一次退出时是暂停状态 → 继续暂停（用户右键恢复）
  try { pet.setPaused(!!(g.global.companion && g.global.companion.petPaused)) } catch { }
  // 闹钟：起进程即排定时器，开机 4 秒后补一次错过检查（15 分钟内补发）
  try { getAlarms().start() } catch (err) { log('[alarms] 启动失败: ' + (err && err.message)) }
  // 0.24.0 随身服务：开着就随应用一起起（手机随时能连）
  try { syncRemote() } catch (err) { log('[remote] 开机启动失败: ' + (err && err.message)) }
  // 本地识别预热：界面起来 12 秒后悄悄把 whisper 模型加载好（常驻进程），
  // 用户第一次按麦克风就不用等 4~6 秒冷启动。失败无所谓，真识别时会重试。
  try {
    const c = cfg()
    if (c.asrProvider === 'local') {
      const t = setTimeout(() => {
        try {
          const home = path.join(app.getPath('userData'), 'bili-duty')
          require('../bili/asr-service').warmup(home, c.asrLocalModel || 'small')
          log('[asr] 预热常驻转写进程（' + (c.asrLocalModel || 'small') + '）')
        } catch (err) { log('[asr] 预热失败: ' + (err && err.message)) }
      }, 12000)
      if (t && t.unref) t.unref()
    }
  } catch { }
}

app.on('before-quit', () => stop())

let fullscreenSyncFn = null // main 注入：syncOverlaysFullscreen——全屏让位开关变化时重排整层
/** 0.22.0：全屏让位开关变化时让 main 重排 overlay 整层（收起/放回同步生效） */
function setFullscreenSync (fn) { fullscreenSyncFn = typeof fn === 'function' ? fn : null }

/* ---------------- 0.24.0 出门方案第 1 期 · 随身服务（手机网页终端） ---------------- */

let obsPortFn = () => 0 // main 注入：obs.status() 读取器（她的形象流端口）
function setObsPortGetter (fn) { obsPortFn = typeof fn === 'function' ? fn : () => 0 }

/** 按配置启停随身服务（boot / 设置开关 / 端口改动都会走到） */
/* ---------------- 0.24.0 电脑画像：采样开关与采集调度 ---------------- */

/**
 * 画像开关变了就跟着变：
 *   开 → 启动「应用使用时长」采样 + 没有档案就后台采一次（不阻塞设置页）
 *   关 → 停采样（已采到的档案留着，重新打开还是原来的）
 */
/**
 * 每天重采一次（了解一个人不能只靠开箱那一次快照）。
 * 用档案文件时间判断而不是内存时间：重启后 fileAt 还在，不会每开一次就重采。
 */
let dailyProfileTimer = null
function ensureDailyProfile () {
  if (dailyProfileTimer) return
  dailyProfileTimer = setInterval(() => {
    try {
      const c = cfg()
      if (c.pcProfileOn !== true) return
      const wsDir = curWsDir || ''
      if (!wsDir) return
      const prof = require('../profile')
      const st = prof.status({ wsDir })
      if (st.running) return
      const at = st.fileAt || st.lastAt || 0
      if (Date.now() - at < 20 * 3600 * 1000) return
      const days = Math.max(1, Math.min(90, Number(c.pcProfileDays) || 14))
      log('[profile] 每日重采（上一次 ' + (at ? new Date(at).toLocaleString('zh-CN') : '从未') + '）')
      prof.runCollect({ wsDir, days, log }).catch((e) => log('[profile] 每日重采失败: ' + (e && e.message)))
    } catch { }
  }, 3600 * 1000)
  if (typeof dailyProfileTimer.unref === 'function') dailyProfileTimer.unref()
}

function syncProfile ({ forceCollect = false } = {}) {
  const c = cfg()
  let prof = null
  try { prof = require('../profile') } catch { return }
  const wsDir = curWsDir || ''
  if (c.pcProfileOn !== true) {
    try { prof.stopSampling() } catch { }
    return
  }
  ensureDailyProfile()
  if (!wsDir) {
    log('[profile] 还没有工作区（角色没加载完？），稍后再采')
    return
  }
  try { prof.startSampling({ wsDir, log, keys: c.keyLogOn === true }) } catch (e) { log('[profile] 采样启动失败: ' + e.message) }
  let has = false
  try { has = prof.status({ wsDir }).hasProfile } catch { }
  if (forceCollect || !has) {
    const days = Math.max(1, Math.min(90, Number(c.pcProfileDays) || 14))
    log('[profile] 开始采集（days=' + days + (forceCollect ? '，手动' : '，首次') + '）')
    prof.runCollect({ wsDir, days, log }).catch((e) => log('[profile] 采集失败: ' + (e && e.message)))
  }
}

function syncRemote () {
  const c = cfg()
  const want = c.remoteOn === true
  const st = remote.status()
  let running = st.running
  try {
    // 端口改了要重启（wantedPort 记录启动时的期望端口；实际端口可能因占用顺延，不能拿它比）
    if (want && running && st.wantedPort && st.wantedPort !== (Number(c.remotePort) || 8720)) {
      remote.stop()
      running = false
      log('[remote] 端口变更，重启随身服务')
    }
    if (want && !running) {
      remote.start({
        cfgGet: () => cfg(),
        cfgSet: (p) => patchCfg(p),
        // 手机上的对话走同一条聊天管线：记忆/自我层/风格/触摸全共享，桌面端实时可见
        send: (text, images) => require('../assistant').send(text, images),
        transcribe: (b64, mime) => transcribe(b64, mime),
        ttsSpeak: (text) => speakWithCurrentConfig(text),
        // 手机点摸：①广播给桌面层 → 角色当场播 motion_touch 反应动作+反应语（手机流里可见）
        //          ②并入触摸管线（情绪账本 + 2.5s 合并注入），桌面手机同一份账本
        touch: (part) => {
          try { require('../pet').remoteTouchTap(part) } catch { }
          try { require('../assistant').noteTouch(part) } catch { }
        },
        /* 0.24.0 第 3 期：手机本地攒的东西（健康/随手记/心情）点同步时才上来。
           这里只做落盘，绝不自动触发聊天——主人明确要「我来决定要不要同步」。 */
        sync: (items) => {
          const out = { ok: true, accepted: 0, skipped: 0, details: [] }
          const ws = curWsDir || ''
          const h = require('../health')
          for (const it of (items || [])) {
            const type = String((it && it.type) || '')
            const data = (it && it.data) || {}
            try {
              if (type === 'health') {
                const r = h.record(Object.assign({}, data, { source: 'mobile' }))
                if (r.ok) { out.accepted += 1; out.details.push({ type, ok: true, date: r.entry.date }) } else { out.skipped += 1; out.details.push({ type, ok: false, error: r.error }) }
              } else if (type === 'note' || type === 'mood') {
                const text = String(data.text || data.note || '').slice(0, 2000)
                if (!text) { out.skipped += 1; continue }
                let wrote = false
                try {
                  wrote = require('./self').appendEvent(ws, {
                    kind: type === 'mood' ? 'mood-mobile' : 'note-mobile',
                    text,
                    at: Number(it.at) || Date.now(),
                    meta: { from: 'mobile', mood: data.mood }
                  })
                } catch { }
                if (wrote) out.accepted += 1
                else out.skipped += 1
                out.details.push({ type, ok: wrote })
              } else {
                out.skipped += 1
                out.details.push({ type, ok: false, error: '未知类型' })
              }
            } catch (e) {
              out.skipped += 1
              out.details.push({ type, ok: false, error: e.message })
            }
          }
          if (out.accepted && ws) {
            try { h.writeSummary(ws, { days: 14 }) } catch { }
          }
          log('[sync] 手机同步：收到 ' + (items || []).length + '，接受 ' + out.accepted + '，跳过 ' + out.skipped)
          return out
        },
        statusInfo: () => {
          const cc = cfg()
          return {
            charName: (character.get() && character.get().name) || '',
            obsPort: Number(obsPortFn()) || 0,
            streamFps: Math.max(1, Math.min(30, Number(cc.remoteStreamFps) || 10)),
            streamQ: Math.max(40, Math.min(95, Number(cc.remoteStreamQ) || 75)),
            streamH: [0, 720, 1080, 1440].includes(Number(cc.remoteStreamH)) ? Number(cc.remoteStreamH) : 1080
          }
        },
        certDir: app.getPath('userData'),
        tailscaleServe: true,
        log
      }).then((r) => {
        if (r && r.ok) log('[remote] 随身服务已就绪（口令见设置页）')
        else if (r && r.error) log('[remote] 启动失败: ' + r.error)
      }).catch(() => { })
    } else if (!want && running) {
      remote.stop()
      log('[remote] 随身服务已关闭')
    }
  } catch (err) { log('[remote] sync 失败: ' + (err && err.message)) }
}

module.exports = { createWindow, registerIpc, stop, bootPet, setOverlayBroadcast, setFullscreenSync, switchChar, getWindow: () => win, imSynthesize, userProfileText, alarmAdd, alarmList, alarmCancel, goalAdd, goalProgress, goalClose, goalList, onUserSpoke, noteExchange, dreamRun, studyStart, studyStop, studyStatus, studyTool, studyActive: () => study.active(studySess), setStudyTrayRefresh: (fn) => { studyOnTrayRefresh = fn }, setObsPortGetter, setImApi, qqSendNow, qqReachPrompt, syncRemote, ttsSpeak: speakWithCurrentConfig, qqNote, desktopHistoryTail, noteGameSession, listActionWords }

/* ---------------- 0.18.0 M2 · IM 语音合成（QQ 发语音用） ----------------
 * 音色跟会话对应的角色卡走（主人 2026-10-25 定案：TTS 不是共用的）——
 * 按 roleId 精确找卡取 voice.apiVoice；找不到卡（如内置 ff14）才退全局 ttsVoice。
 * 合成结果落本地临时文件，由 im 层转 base64 走 OneBot record 段发送。
 * browser TTS 出不了文件 → 返回 reason 让调用方回退纯文本。 */
async function imSynthesize (text, roleId) {
  const c = cfg()
  if (!c || c.ttsMode !== 'api') return { ok: false, reason: 'browser-tts' }
  const clean = String(text || '').trim()
  if (!clean) return { ok: false, reason: 'empty' }
  // 精确匹配角色卡：character.get() 的兜底（返回第一张卡）会把不存在的 roleId 错绑到别人卡上
  let char = null
  try { char = character.list().find((x) => x.id === roleId) || null } catch { }
  const audio = await tts.speak({
    provider: c.ttsProvider || 'openai',
    // Fish 必须用自己的端点/Key——回退到 LLM 的 apiBaseUrl 会把请求发到 DeepSeek 等非 Fish 服务
    baseUrl: c.ttsProvider === 'fish' ? (c.fishBaseUrl || 'https://api.fish.audio/v1/tts') : (c.ttsBaseUrl || c.apiBaseUrl),
    apiKey: c.ttsProvider === 'fish' ? (c.fishApiKey || c.ttsApiKey || c.apiKey) : (c.ttsApiKey || c.apiKey),
    model: c.ttsModel || 'tts-1',
    ...cardVoiceParams(c, char),
    refAudio: c.ttsRefAudio, textLang: c.ttsTextLang, promptText: c.ttsPromptText, promptLang: c.ttsPromptLang,
    fishModel: c.fishModel, asmrVoiceId: c.fishAsmrVoiceId,
    format: c.fishFormat, latency: c.fishLatency, feeling: c.fishFeeling, tagDensity: c.fishTagDensity,
    speed: c.ttsSpeed || 1, text: clean
  })
  if (!audio || !audio.url) return { ok: false, reason: 'synth-failed' }
  // file:// URL → 本地绝对路径（im 层读文件转 base64）
  const { fileURLToPath } = require('node:url')
  let localPath = String(audio.url)
  try { localPath = fileURLToPath(audio.url) } catch { }
  return { ok: true, path: localPath, speed: audio.speed || 1 }
}
