'use strict'
/**
 * S3 · 桌宠六工具的宿主实现（Electron 主进程侧）
 *
 * 助手核心（纯 ESM、零依赖）只声明工具，真正动作在这里落地：
 *  - pet_say / pet_ask / pet_act / pet_quiet → 广播 pet:cmd 给角色所在的那块屏
 *  - pet_move_to → 直接驱动 companion/pet 的走动（位置状态本来就在主进程）
 *  - pet_set → 写 companion 配置并通知渲染层（大小/气泡/字号/主题/音效/称呼）
 *
 * 设计原则：所有「说话、表情、走动」都由渲染层执行，主进程不做第二套坐标/动画，
 * 避免两块屏各播一次（双声道）与两处状态互相打架。
 */
const store = require('./store')
const { log } = require('./logger')

/** 提问气泡等回答的最长时间：超时按「没回答」返回，避免工具循环卡死 */
const ASK_TIMEOUT_MS = 60000
const SAY_MAX_CHARS = 600

let bcastFn = null
let pendingAsk = null // { id, resolve }
let quietTimer = null
let quietUntil = 0

/** main 启动时注入：向全部 overlay 窗口广播（与 pet 模块共用同一条通道） */
function attach ({ bcast } = {}) {
  bcastFn = typeof bcast === 'function' ? bcast : null
}

function bcast (ch, data) {
  try { if (bcastFn) bcastFn(ch, data) } catch (e) { log('[petBridge] 广播失败:', e && e.message) }
}

function petCfg () {
  const g = store.get()
  return (g.global && g.global.companion) || {}
}

function patchPetCfg (patch) {
  store.patchGlobal({ companion: { ...petCfg(), ...patch } })
}

/** 配置变更推给渲染层（大小/气泡/字号/主题/音效/安静） */
function pushPetConfig (extra) {
  const c = petCfg()
  bcast('pet:config', {
    scale: c.petScale,
    replyLang: c.replyLang,
    readReply: c.readReply,
    bubbleScale: c.petBubbleScale,
    fontScale: c.petFontScale,
    theme: c.petTheme,
    sound: c.petSound,
    quiet: Date.now() < quietUntil,
    // 0.19.0 回应模式：安静模式下渲染层只演动作、不出触摸反应语
    reactionMode: c.reactionMode || 'active',
    reactionTypes: Array.isArray(c.reactionTypes) ? c.reactionTypes : null,
    ...(extra || {})
  })
}

/* ------------------------------------------------------------ pet_say */

/** 把标记里的词拆成动作词（逗号/顿号/空格都算分隔） */
function splitWords (s) {
  return String(s || '').split(/[,，、\s]+/).map((w) => w.trim()).filter(Boolean)
}

async function say ({ script, speech, vol, dmHold } = {}) {
  const raw = String(script || '')
  if (!raw.trim()) throw new Error('script 为空：至少要说一句话或做一个动作')
  // 【…】先播动作再出新气泡；<…> 气泡出现后接着播
  const lead = []
  for (const m of raw.matchAll(/【([^】]*)】/g)) lead.push(...splitWords(m[1]))
  const inline = []
  for (const m of raw.matchAll(/<([^>]*)>/g)) inline.push(...splitWords(m[1]))
  const text = raw.replace(/【[^】]*】/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, SAY_MAX_CHARS)
  if (!text && !lead.length && !inline.length) throw new Error('script 里没有任何内容')
  // 一次说话会打断上一个没答的提问（与参考项目一致：新说/新问替换旧问题）
  if (pendingAsk) finishAsk({ answered: false, reason: '被新的说话打断' })
  // 0.38.0 弹幕层开着（游戏模式）：话走弹幕，气泡不再冒出来挡画面。
  // dm 标记让渲染层知道「这条已经有人显示了」，它只管演动作。
  let dm = false
  try { dm = require('./danmaku').isOn() } catch { }
  // 0.46.22 dmHold：调用方要先把这句话翻译好再上弹幕（原文几秒就飞出屏幕，
  // 事后 replaceLast 追不上——0.46.20 的补丁用户实测「弹幕还是没有翻译」）。
  // true = 这里先不推弹幕，由调用方拿到译文后自己 dk.say（失败/超时兜底推原文）。
  const holdDm = !!(dmHold && dm && text)
  const volN = Number(vol)
  bcast('pet:cmd', { kind: 'say', text, lead, inline, speak: speech !== false, dm, vol: Number.isFinite(volN) ? Math.min(1, Math.max(0.05, volN)) : undefined })
  if (dm && text && !holdDm) {
    try { require('./danmaku').say(text) } catch (e) { log('[petBridge] 弹幕推送失败:', e && e.message) }
  }
  const secs = Math.max(2, Math.ceil(text.length / 6))
  return {
    said: text || undefined,
    actions: lead.concat(inline),
    dmHeld: holdDm || undefined,
    estimateSeconds: secs,
    note: text ? '气泡已显示，停留时长跟着朗读走' : '只播了动作，没有说话'
  }
}

/* ------------------------------------------------------------ pet_ask */

function finishAsk (result) {
  if (!pendingAsk) return false
  const p = pendingAsk
  pendingAsk = null
  clearTimeout(p.timer)
  bcast('pet:cmd', { kind: 'ask-dismiss', id: p.id })
  try { p.resolve(result) } catch {}
  return true
}

async function ask ({ question, options, allowOwnAnswer } = {}) {
  const q = String(question || '').trim()
  if (!q) throw new Error('question 为空')
  const opts = (Array.isArray(options) ? options : [])
    .map((s) => String(s || '').trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 3)
  if (!opts.length) throw new Error('options 至少要有一个选项')
  if (pendingAsk) finishAsk({ answered: false, reason: '被新的提问替换' })
  const id = 'ask-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingAsk || pendingAsk.id !== id) return
      pendingAsk = null
      bcast('pet:cmd', { kind: 'ask-dismiss', id })
      resolve({ answered: false, reason: '对方 ' + Math.round(ASK_TIMEOUT_MS / 1000) + ' 秒内没有回答' })
    }, ASK_TIMEOUT_MS)
    pendingAsk = { id, timer, resolve }
    bcast('pet:cmd', {
      kind: 'ask',
      id,
      question: q,
      options: opts,
      allowOwnAnswer: allowOwnAnswer !== false
    })
  })
}

/** 渲染层回报答案（点选项 / 自己写 / 关掉气泡） */
function answerAsk ({ id, answer } = {}) {
  if (!pendingAsk || pendingAsk.id !== id) return false
  const a = String(answer == null ? '' : answer).trim()
  finishAsk(a ? { answered: true, answer: a } : { answered: false, reason: '对方关掉了问题' })
  return true
}

/* ------------------------------------------------------- pet_move_to */

async function moveTo ({ to, run } = {}) {
  const pet = require('./companion/pet')
  if (typeof pet.moveToFraction !== 'function') throw new Error('伙伴模块不支持走动（版本过旧）')
  if (to === undefined || to === null || to === '') throw new Error('to 必填')
  const r = await pet.moveToFraction(to, !!run)
  if (!r || r.ok !== true) {
    return { ok: false, reason: (r && r.reason) || '没有走到目标', x: r && r.x }
  }
  return { ok: true, x: r.x, ms: r.ms, mode: run ? 'run' : 'walk' }
}

/* ---------------------------------------------------------- pet_act */

/* 0.45.35 坐/站是「状态」不是一次性动画（主人 2026-10-31：坐下是持续动作，还要找卡片联动）：
 * 这两类词不进动作广播，改走主进程 pet 状态机——坐下优先找 AuraDesk 卡片联动、
 * 持续坐姿直到被打断；站起来退出任何坐姿。其余动作词照旧播一次性动画。 */
const ACT_SIT_RE = /坐下|坐好|坐下来|坐下來|坐地上|坐着|坐著|瘫坐|癱坐|歇会儿|歇會兒|歇会|坐会儿|坐會兒/
const ACT_STAND_RE = /^(起来|起來|站起来|站起來|站好|起身|别坐了|別坐了|不要坐了)$/

/* 0.45.43 动作闸（用户：动作过于重复频繁）：
 * 同一个动作词 5 分钟冷却 + 每分钟最多播 2 个；只管聊天链路的一次性动作词
 * （坐/站是状态机命令，不受闸）。被滤掉不报错——动作本来就是锦上添花。
 * 手动测试面板传 manual:true 豁免（点播就要响）。 */
const ACT_GOV = { lastAt: {}, minute: [] }
function governActions (words) {
  const now = Date.now()
  ACT_GOV.minute = ACT_GOV.minute.filter((t) => now - t < 60 * 1000)
  const out = []
  for (const w of words) {
    if (ACT_GOV.minute.length >= 2) break
    if (now - (ACT_GOV.lastAt[w] || 0) < 5 * 60 * 1000) continue
    ACT_GOV.lastAt[w] = now
    ACT_GOV.minute.push(now)
    out.push(w)
  }
  return out
}

/* 0.45.71 修：形参解构后函数体里还在用 args.manual → ReferenceError「args is not defined」，
 * 0.45.43 加动作闸那天起，她每次 pet_act 坐下/站起来都直接抛错（日志 10-31 09:28、12:34、23:42 三次实锤）。
 * 形参必须是 args 本体，解构挪进函数体。 */
async function act (args = {}) {
  const { actions } = args || {}
  const list = (Array.isArray(actions) ? actions : [])
    .map((w) => String(w || '').trim())
    .filter(Boolean)
    .slice(0, 6)
  if (!list.length) throw new Error('actions 为空')
  const pet = (() => { try { return require('./companion/pet') } catch { return null } })()
  const sits = list.filter((w) => ACT_SIT_RE.test(w) && !/躺|睡|趴/.test(w))
  const stands = list.filter((w) => ACT_STAND_RE.test(w))
  let sitResult = null
  const rest = []
  for (const w of list) {
    if (sits.includes(w) || stands.includes(w)) continue
    rest.push(w)
  }
  if (stands.length && pet && typeof pet.standOnCommand === 'function') {
    sitResult = pet.standOnCommand()
    log('[petBridge] pet_act 站起来 →', JSON.stringify(sitResult))
  } else if (sits.length && pet && typeof pet.sitOnCommand === 'function') {
    sitResult = pet.sitOnCommand()
    log('[petBridge] pet_act 坐下 →', JSON.stringify(sitResult))
  }
  if (sitResult) {
    // 坐/站已由状态机接管；剩余的普通动作词过闸后照旧播
    const restG = (args && args.manual) ? rest : governActions(rest)
    if (restG.length) bcast('pet:cmd', { kind: 'act', actions: restG })
    return { played: list, sit: sitResult, note: '坐下/站起来由状态机处理（持续姿态，卡片联动优先）' }
  }
  if (sits.length || stands.length) {
    // pet 模块不在（极端兜底）：坐/站词照旧透传给 overlay
    bcast('pet:cmd', { kind: 'act', actions: list })
    return { played: list, note: '动作已开始播放（不等待播完）' }
  }
  const governed = (args && args.manual) ? list : governActions(list)
  if (!governed.length) {
    log('[petBridge] 动作闸收着了：' + list.join('/'))
    return { played: [], note: '动作太密/太重复，这次收着没播' }
  }
  bcast('pet:cmd', { kind: 'act', actions: governed })
  return { played: governed, note: '动作已开始播放（不等待播完）' }
}

/* ---------------------------------------------------------- pet_set */

const ROAM_MAP = { free: 'lively', calm: 'calm', off: 'off' }

async function set (args = {}) {
  const applied = {}
  const unsupported = []

  if (args.roam != null) {
    const mode = ROAM_MAP[String(args.roam)]
    if (!mode) throw new Error('roam 只能是 free / calm / off')
    patchPetCfg({ petWalk: mode })
    try { require('./companion/pet').refreshBehavior() } catch {}
    applied.roam = args.roam
  }
  if (args.scale != null) {
    const s = Math.max(0.6, Math.min(2, Number(args.scale) || 1))
    patchPetCfg({ petScale: s })
    applied.scale = s
  }
  if (args.bubbleSize != null) {
    const s = Math.max(0.7, Math.min(1.6, Number(args.bubbleSize) || 1))
    patchPetCfg({ petBubbleScale: s })
    applied.bubbleSize = s
  }
  if (args.fontSize != null) {
    const s = Math.max(0.7, Math.min(1.6, Number(args.fontSize) || 1))
    patchPetCfg({ petFontScale: s })
    applied.fontSize = s
  }
  if (args.theme != null) {
    if (!['dark', 'light'].includes(String(args.theme))) throw new Error('theme 只能是 dark / light')
    patchPetCfg({ petTheme: String(args.theme) })
    applied.theme = String(args.theme)
  }
  if (args.sound != null) {
    patchPetCfg({ petSound: !!args.sound })
    applied.sound = !!args.sound
  }
  if (args.user != null) {
    const u = String(args.user).trim().slice(0, 16)
    if (!u) throw new Error('user 不能为空')
    patchPetCfg({ petUser: u })
    applied.user = u
  }
  if (args.snoreSeconds != null) {
    // 睡着时长：先落配置，等「睡觉」动作阶段再生效
    const s = Math.max(0, Math.min(3600, Number(args.snoreSeconds) || 0))
    patchPetCfg({ petSnoreSeconds: s })
    applied.snoreSeconds = s
  }
  for (const k of ['figure', 'scheme', 'hoverButtons']) {
    if (args[k] != null) unsupported.push(k)
  }
  if (!Object.keys(applied).length && !unsupported.length) throw new Error('没有要修改的项')
  pushPetConfig()
  return {
    applied,
    unsupported,
    note: unsupported.length ? '这些项要等形象包 / 悬停按钮阶段才支持：' + unsupported.join(', ') : '已生效'
  }
}

/* -------------------------------------------------------- pet_quiet */

function clearQuiet () {
  clearTimeout(quietTimer)
  quietTimer = null
  quietUntil = 0
  try { require('./companion/pet').setQuiet(false) } catch {}
}

async function quiet ({ minutes, sound, roam } = {}) {
  const m = Number(minutes)
  if (!isFinite(m) || m < 0) throw new Error('minutes 必须是不小于 0 的数字')
  if (m === 0) {
    clearQuiet()
    bcast('pet:cmd', { kind: 'quiet', on: false })
    pushPetConfig({ quiet: false })
    return { quiet: false, note: '已结束安静' }
  }
  const mins = Math.min(1440, m)
  clearTimeout(quietTimer)
  quietUntil = Date.now() + mins * 60000
  try { require('./companion/pet').setQuiet(true) } catch (e) { log('[petBridge] 暂停走动失败:', e && e.message) }
  bcast('pet:cmd', { kind: 'quiet', on: true, sound: !!sound, minutes: mins })
  pushPetConfig({ quiet: true })
  quietTimer = setTimeout(() => {
    quietTimer = null
    quietUntil = 0
    try { require('./companion/pet').setQuiet(false) } catch {}
    bcast('pet:cmd', { kind: 'quiet', on: false })
    pushPetConfig({ quiet: false })
    log('[petBridge] 安静结束，恢复声音与走动')
  }, mins * 60000)
  return { quiet: true, minutes: mins, sound: !!sound, roam: roam || 'off' }
}

/* ------------------------------------------------------------ 字幕补丁 */

/**
 * 主动台词的译文补丁（看屏陪伴 / 时间观念 / 闹钟）：
 * 台词先按原语言开口（朗读已经是原语言），翻译回来再把气泡文字换成字幕。
 * 只改显示，不动 TTS、不重置气泡停留时间（语音还没念完）。
 */
function subtitle ({ text } = {}) {
  const t = String(text || '').trim()
  if (!t) return { ok: false }
  bcast('pet:cmd', { kind: 'say-sub', text: t.slice(0, SAY_MAX_CHARS) })
  // 弹幕层开着时，弹幕那边也要跟着换字（不然弹幕还是原语言、气泡没了就永远读不到译文）
  try { require('./danmaku').replaceLast(t) } catch {}
  return { ok: true }
}

/* ------------------------------------------------- 正文内嵌动作标记（0.45.34）
 * 真机事故（用户 2026-10-31 00:30）：模型（deepseek 系）不发 function call，
 * 把 pet_act 写成正文里的 <pet_act><actions>["坐下"]</actions></pet_act>——
 * 没人解析就原样显示（用户看到一堆「错误」标签），动作也没播（「坐不下」）。
 * 出口统一接住：解析出动作词、从文本里剥掉。调用方决定要不要真播。 */
function parseActWords (body) {
  const s = String(body || '').trim()
  if (!s) return []
  let arr = null
  try { const j = JSON.parse(s); if (Array.isArray(j)) arr = j } catch { }
  if (!arr) arr = s.replace(/】\s*【/g, '，') // 【坐下】【摇头】连写先拆开
    .replace(/^[\[\]“”"'，、\s]+|[\[\]“”"'，、\s]+$/g, '').split(/[,，、\n]+/)
  return arr
    .map((x) => String(x).trim().replace(/^["'【】\[\]\s]+|["'【】\[\]\s]+$/g, ''))
    .filter(Boolean)
    .slice(0, 6)
}

function extractInlineAct (text) {
  const actions = []
  let t = String(text || '')
  // 0.46.9 AgentAtelierR 同款：正文内嵌 [action:语义标签] / [action:grp_fg_106]（自动调用规则）。
  // 标识符样的都剥掉并归一成 'action:xxx' 词（未知语义渲染层按 none 处理、不播也不显示），
  // 非标识符（含空格/符号的普通方括号文本）原样保留不误伤。
  t = t.replace(/\[action\s*:\s*([^\[\]\r\n]+)\]/gi, (m, raw) => {
    const v = String(raw || '').trim().toLowerCase()
    if (/^grp_[a-z0-9_]+$/.test(v) || /^[a-z_]+$/.test(v)) { actions.push('action:' + v); return ' ' }
    return m
  })
  // 0.46.43 畸变裸标签：模型偶尔把 [action:shy] 写丢前缀成 [shy]，正文原样漏出
  //（11-04 15:36 实锤「う……当たり。[shy]」）。只认 11 个正牌语义标签的裸写，
  // 命中按同义动作处理并剥掉（她本意是想演）；其它方括号词原样保留不误伤。
  t = t.replace(/\[\s*(acknowledge|disagree|think|explain|excited|wave|shy|surprised|comfort|playful|invite)\s*\]/gi, (m, v) => {
    actions.push('action:' + String(v).toLowerCase())
    return ' '
  })
  /* 0.46.13 舞台指示兜底映射（用户两天第三次「手势还是没动」后的换路打法）：
   * 模型（deepseek 系、日语人格）在正文里写的是【少し照れる】【少し首をかしげる】
   * 这类舞台指示，[action:] 语法喂了每轮也不理——200 条历史全是【…】惯性，指令压不过。
   * 与其继续喂规则，不如把她的既有习惯当输入：识别【…】内的日/中动作关键词，
   * 映射成语义标签（11 标签计划，真机 /act 四路径已验证）或词表里有的中文动作词，
   * 并从正文剥掉（顺带 TTS 不再念出「【少し照れる】」）。认不出关键词的【…】
   * 原样保留（可能是正经强调文本，不误伤）。每条回复最多取 2 个（动作闸之外的第二道限）。
   * 词/标签都必须是渲染层已验证存在的：语义标签走 playSemanticAction 计划，
   * 中文词走 SPINE_WORD_MAP（278 词覆盖 95+53 组）。 */
  const STAGE_DIR_ACTIONS = [
    [/照れ|恥ずか|テレ|害羞|脸红/, 'action:shy'],
    [/頷|うなず|点头|そうだね|わかった/, 'action:acknowledge'],
    [/首を振|いやいや|うんうん|摇头|不同意|不行/, 'action:disagree'],
    [/首をかし|首を傾|かしげ|歪头|考え|思案|思考|沉思|琢磨/, 'action:think'],
    [/驚き|驚く|びく|びっくり|ドキッ|はっと|吓一跳|惊讶|惊慌|慌张/, 'action:surprised'],
    [/手を振|手を揺|挥着手|挥手|バイバイ|じゃあね|またね/, 'action:wave'],
    [/いたずら|悪戯|ニヤ|にやり|俏皮|得意|得逞/, 'action:playful'],
    [/嬉し|楽しい|わーい|やった|兴奋|激动/, 'action:excited'],
    [/元気出|なでなで|安慰|摸摸|加油/, 'action:comfort'],
    [/こっち|おいで|招手|过来|邀请/, 'action:invite'],
    [/説明|说明|解説|解释|你看啊/, 'action:explain'],
    /* 0.46.14 补漏：真机 21:55 【少し笑う】没接住——「笑う」不在旧表（只有微笑/笑み），
     * 而这正是她最高频的舞台指示。注意顺序：ふふっ 是笑声语气归俏皮、笑う 归轻笑。 */
    [/笑う|笑っ|笑顔|くすり|くすっ|ふふ|微笑|笑み|にっこり|轻笑|偷笑|嘿嘿/, '轻笑'],
    [/目を丸|まじまじ|瞪|凝视/, 'action:surprised'],
    [/腕を組|抱臂|双臂交叉/, '抱臂'],
    [/頬杖|托腮/, '托腮'],
    [/伸び|伸懒腰/, '伸懒腰'],
    [/拍手|鼓掌|パチパチ/, '拍手'],
    [/耳打ち|内緒|悄悄话|耳语/, '悄悄话'],
    [/ガッツ|握拳|打气/, '加油'],
    [/座る|腰を下ろ|坐下/, '坐下'],
    [/立ち上が|站起来|起身/, '站起来']
  ]
  let stageDirCount = 0
  t = t.replace(/【([^【】]{1,14})】/g, (m, body) => {
    if (stageDirCount >= 2) return m
    for (const [re, w] of STAGE_DIR_ACTIONS) {
      if (re.test(body)) { actions.push(w); stageDirCount++; return ' ' }
    }
    return m
  })
  // 带标准 <actions> 包装的（容许漏写收尾标签）
  t = t.replace(/<pet_act>\s*<actions>([\s\S]*?)<\/actions>\s*(?:<\/pet_act>)?/gi, (m, body) => {
    const w = parseActWords(body)
    if (w.length) actions.push(...w)
    return ' '
  })
  // 裸 <pet_act>坐下</pet_act> / <pet_act>【坐下】【摇头】</pet_act>
  t = t.replace(/<pet_act>([\s\S]*?)<\/pet_act>/gi, (m, body) => {
    const w = parseActWords(body)
    if (w.length) actions.push(...w)
    return ' '
  })
  // 漏了收尾标签的残尾巴（<pet_act> 开头直到文本末尾）
  t = t.replace(/<pet_act>\s*(?:<actions>)?([\s\S]*)$/i, (m, body) => {
    const w = parseActWords(body)
    if (w.length) actions.push(...w)
    return ' '
  })
  return { text: t.replace(/\s{2,}/g, ' ').trim(), actions }
}

/* ------------------------------------------------------------- 入口 */

async function invoke (name, args) {
  switch (name) {
    case 'pet_say': return say(args)
    case 'pet_ask': return ask(args)
    case 'pet_move_to': return moveTo(args)
    case 'pet_act': return act(args)
    case 'pet_set': return set(args)
    case 'pet_quiet': return quiet(args)
    // 0.18.0 第一批：闹钟（懒加载 companion，避免 petBridge ↔ companion 循环依赖）
    case 'alarm_set': {
      const r = require('./companion').alarmAdd(args || {})
      if (!r || !r.ok) throw new Error((r && r.error) || '闹钟没设成')
      return { ok: true, id: r.alarm.id, time: r.alarm.time, label: r.alarm.label, daily: r.alarm.daily }
    }
    case 'alarm_list': {
      const list = require('./companion').alarmList()
      return {
        count: list.length,
        alarms: list.map((a) => ({
          id: a.id,
          time: a.time,
          label: a.label,
          daily: a.daily !== false,
          enabled: a.enabled !== false,
          nextAt: a.nextAt ? new Date(a.nextAt).toLocaleString('zh-CN') : ''
        }))
      }
    }
    case 'alarm_cancel': return require('./companion').alarmCancel(args || {})
    // 0.46.28 生活线三工具（她自己的目标：定/看/更新 → companion/goals.js 按工作区落盘）
    case 'goal_set': {
      const r = require('./companion').goalAdd(args || {})
      if (!r || !r.ok) throw new Error((r && r.error) || '目标没记上')
      return { ok: true, id: r.goal.id, title: r.goal.title, status: r.goal.status }
    }
    case 'goal_list': {
      const list = require('./companion').goalList()
      return {
        count: list.length,
        goals: list.map((g) => ({
          id: g.id, title: g.title, status: g.status, stuck: !!g.stuck,
          detail: g.detail || '',
          latest: g.progress && g.progress.length ? g.progress[g.progress.length - 1].note : ''
        }))
      }
    }
    case 'goal_update': {
      const a = args || {}
      const r = a.action === 'progress'
        ? require('./companion').goalProgress(a)
        : require('./companion').goalClose(a)
      if (!r || !r.ok) throw new Error((r && r.error) || '没更新上')
      return { ok: true }
    }
    // 0.46.31 看视频：关键词/链接 → 视频信息+字幕全文（companion/biliWatch.js 薄接线刷B站模块）
    case 'bili_watch':
      return require('./companion/biliWatch').biliWatch(args || {})
    // 0.45.93 主动发 QQ：立刻发 / 排一条 / 查 / 取消（她答应了就要真发得出去）
    case 'qq_send': {
      const t = String((args && args.text) || '').trim()
      if (!t) throw new Error('要发的内容是空的')
      const r = await require('./companion').qqSendNow(t, 'qq_send')
      if (!r || !r.ok) throw new Error((r && r.error) || '没发出去')
      return { ok: true, sent: true, text: r.text, at: new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false }) }
    }
    case 'qq_plan': {
      const r = await require('./companion').qqPlanAdd(args || {})
      if (!r || !r.ok) throw new Error((r && r.error) || '没排上')
      return r
    }
    case 'qq_plan_list': return require('./companion').qqPlanList()
    case 'qq_plan_cancel': return require('./companion').qqPlanCancel(args || {})
    // 0.45.71 学习监督：真实聊天通道的 study_* 也走这条桥（懒加载，理由同上）
    case 'study_start':
    case 'study_peek':
    case 'study_stop':
      return require('./companion').studyTool(name, args || {})
    default: throw new Error('未知的伙伴工具: ' + name)
  }
}

function registerIpc () {
  const { ipcMain } = require('electron')
  ipcMain.on('pet:ask-answer', (_e, payload) => {
    const ok = answerAsk(payload || {})
    if (!ok) log('[petBridge] 收到过期的提问回答:', payload && payload.id)
  })
}

module.exports = { attach, invoke, registerIpc, answerAsk, pushPetConfig, subtitle, extractInlineAct, isQuiet: () => Date.now() < quietUntil }
