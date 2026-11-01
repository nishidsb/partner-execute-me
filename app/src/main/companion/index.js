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
const curiosity = require('./curiosity')
const rhythm = require('./rhythm')
const presence = require('./presence')
const rebuke = require('./rebuke')

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
      const { screen } = require('electron')
      const cua = require('../cua')
      const b = screen.getPrimaryDisplay().bounds
      return cua._shoot({ x: b.x, y: b.y, w: b.width, h: b.height, maxW: 1280, maxH: 1280, tag: 'watch' }, false)
    },
    chat: async ({ messages }) => {
      const c = cfg()
      return llm.chatStream({
        baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
        messages, temperature: c.temperature != null ? c.temperature : 0.8
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

/* ---------------- 0.18.0 第一批 · 闹钟（对齐 Coopanion alarms，语义重写） ----------------
 * 到点：状态气泡（alarm）+ 台词气泡 + 朗读（复用 pet_say 链路，多屏只由宿主发声）+ 系统通知。
 * 语言跟随回复语言；错过 15 分钟内补发一次并说明原定时间。 */
let alarmsModInst = null
function getAlarms () {
  if (alarmsModInst) return alarmsModInst
  alarmsModInst = alarmsMod.createAlarms({
    home: character.base(),
    now: () => Date.now(),
    log: (m) => log(m),
    onFire: (a) => {
      const c = cfg()
      const rl = c.replyLang === 'auto' ? 'zh' : (c.replyLang || 'zh')
      const label = a.label || (rl === 'ja' ? 'アラーム' : rl === 'en' ? 'the alarm' : '闹钟')
      const text = rl === 'ja'
        ? `ご主人様、${label}のお時間です`
        : rl === 'en'
          ? `Master, it's time for ${label}`
          : `主人，${label}的时间到了`
      // 状态气泡 + 音效（overlay 收到 pet:alarm 后画 ⏰ 并响一声）
      try { bcast('pet:alarm', { label: a.label || '', time: a.time, lateMin: a.lateMin || 0 }) } catch { }
      // 台词：复用 pet_say（气泡 + TTS + 字幕 + 写进会话历史，多屏只有宿主发声）
      sayProactive(text, { kind: 'alarm' }).catch((err) => log('[alarms] 播放失败: ' + (err && err.message)))
      try {
        const { Notification } = require('electron')
        if (Notification && Notification.isSupported && Notification.isSupported()) {
          new Notification({
            title: '⏰ ' + (a.label || '闹钟'),
            body: a.time + (a.lateMin ? `（原定 ${a.time}，迟到 ${a.lateMin} 分钟）` : '')
          }).show()
        }
      } catch { }
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
    llmCfg: { baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel },
    persona: String(char.persona || ''),
    personaName: String(char.name || ''),
    // 0.21.0：负反馈开关（测试期可关；关了只影响「会不会累加」，已有数值要归零用设置页的回滚/清零）
    feedback: c.feedbackMode === 'off' ? 'off' : 'on',
    // 0.36.0 语义判读开关（默认开；关掉就只按词表认，不再多发请求）
    judgeOn: () => cfg().judgeOn !== false,
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
const SYSTEM_BUDGET = 12000

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
  if (memText) sections.push({ key: 'memory', text: memText, priority: 40 })
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
  sections.push({ key: 'time', text: '【当前时间】' + new Date().toLocaleString('zh-CN', { hour12: false }), priority: 20 })
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

/* 0.45.72 聊天史带时间与来源（真实使用反馈：一大早就出现记忆错乱——深夜说完的话，
 * 第二天早上被她当成「刚才」发生的事）。
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
  try {
    const obs = inner.observesToday(5)
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
  const t = String(text || '').trim()
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
    r = await pb.invoke('pet_say', { script: text, speech: true })
  } catch (err) {
    log('[companion] 主动台词播放失败: ' + (err && err.message))
  }
  subtitleFor(t).then((display) => {
    if (display) {
      try { pb.subtitle({ text: display }) } catch { }
      log('[companion] 主动台词字幕：' + display.slice(0, 40))
    }
    try { require('../assistant').pushExternalReply(t, display) } catch { }
  }).catch(() => {
    try { require('../assistant').pushExternalReply(t, '') } catch { }
  })
  return r
}

/**
 * 废话通道出口（0.20.0）：只出气泡、不朗读。和 sayProactive 的区别是整套设计的关键：
 * 这条不期待回应，被无视也不会伤到她（inner 层语义不变）。
 * 0.45.26 全出口入账：账本里要留底（via:chatter）——不进账≠不存在，主人要求所有行为聊天都进记忆。
 */
async function sayNarration (text) {
  const t = String(text || '').trim()
  if (!t) return null
  try {
    const rr = await require('../petBridge').invoke('pet_say', { script: t, speech: false })
    statBump('said')
    try { require('../assistant').ledgerNote({ via: 'chatter', assistant: t }) } catch { }
    return rr
  } catch (err) {
    log('[chatter] 出气泡失败: ' + (err && err.message))
    return null
  }
}

let chatterInst = null
let curioInst = null
function getChatter () {
  if (chatterInst) return chatterInst
  chatterInst = chatter.createChatter({
    cfgGet: () => cfg(),
    log,
    state: () => inner.state(),
    isBusy: () => !!genAbort,
    persona: () => { try { return (character.get() || {}).persona || '' } catch { return '' } },
    // 0.35.0：碎碎念要接得上现实，否则就是另一个不相干的人
    presence: presenceState,
    sharedBlock: watchSharedBlock,
    // 0.45.44：把自己最近几句递回去防复读（「配合ノート」连说一晚的教训）
    recentVoices: (n) => { try { return inner.recentVoices(n).join('\n') } catch { return '' } },
    displeasure: () => { try { return inner.displeasure() } catch { return 0 } },
    gapScale: rebuke.gapScale,
    rhythm: getRhythm(),
    say: sayNarration,
    note: (text) => { try { inner.noteNarration(text) } catch { } }
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
let nudgeTimer = null
let nudgeRec = { stage: 0, light: false, lastProactiveAt: 0, nextTryAt: 0, baseAt: 0, sleepUntil: 0 }
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

/** 阶梯台词：persona + 情境提示，语言跟 replyLang 设置走 */
async function nudgeLineByHint (hint) {
  const c = cfg()
  if (!c.apiBaseUrl || !c.apiModel) return ''
  const rl = c.replyLang || 'zh'
  const langRule = rl === 'auto'
    ? '用与角色平时说话相同的语言。'
    : '只使用' + ({ zh: '中文', en: '英文', ja: '日文' }[rl] || '中文') + '。'
  // 0.45.44 防复读：把最近几句主动说过的话递回去（没有这面镜子，
  // 模型每次都凑同一个道具——真机实锤「配合ノート」连说一晚）
  let voices = ''
  try { voices = inner.recentVoices(4).join('\n') } catch { }
  try {
    const res = await llm.chatStream({
      baseUrl: c.apiBaseUrl, apiKey: c.apiKey, model: c.apiModel,
      messages: [
        { role: 'system', content: String((character.get() || {}).persona || '').slice(0, 900) },
        // 0.35.0：不带上下文她就会说出跟你们最近聊的毫无关系的话（用户 10-29 反馈）
        // 0.45.42：watchSharedBlock 自身已按优先级排好并在 4000 截断，这里不再二次砍半
        ...(watchSharedBlock() ? [{ role: 'system', content: '【你知道的事（记忆与最近对话，主动开口要接得上）】\n' + watchSharedBlock() }] : []),
        ...(voices ? [{ role: 'system', content: '【你最近几次主动说过的话（别再重复这些话题、道具和句式，换点别的来说）】\n' + voices }] : []),
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

function makeNudgeLine (stage, mins) {
  const hint = String(idleNudge.STAGE_PROMPTS[stage] || idleNudge.STAGE_PROMPTS[4])
    .replace('{mins}', String(mins))
  return nudgeLineByHint(hint)
}

/** 0.45.12 欢迎回来：离开一阵子刚回到电脑前，迎一句。
 *  0.45.19 隔了 ≥4 小时会把「上次聊到什么」递进情境，她能自然接上旧话头。 */
function makeWelcomeLine (mins) {
  const hint = String(idleNudge.STAGE_PROMPTS.welcome || '').replace('{mins}', String(mins))
  let gap = ''
  try { gap = dayflow.gapBlockOf(dayflow.loadLast(curWsDir), Date.now()) } catch { }
  return nudgeLineByHint(gap ? hint + '\n\n' + gap : hint)
}

/* ---------------- 0.45.12 QQ 主动找主人 ----------------
 * 主人不在电脑前时桌面通道全体哑火（0.35.0 的正确让位），但她在 QQ 上可以找他。
 * 红线与节流在 reach.js（只发主人名单、2 小时间隔、每天 3 次、凌晨静默）。 */
const reach = require('./reach')
let imApi = null   // main.js 注入 { connected(), cfg(), sendPrivate(uid, text) }
function setImApi (api) { imApi = typeof api === 'function' || (api && typeof api === 'object') ? api : null }
let reachRec = { lastAt: 0, day: '', count: 0 }

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

/** QQ 场合的找他台词：阶梯语气 + 「这是手机聊天，说短点」 */
async function makeReachLine (stage, mins) {
  const base = String(idleNudge.STAGE_PROMPTS[stage] || idleNudge.STAGE_PROMPTS[4])
    .replace('{mins}', String(mins))
  const hint = base + '\n\n【场合变了】主人现在不在电脑前。你要去 QQ 上给他发消息——像随手发的手机消息，短，一两句，别长篇大论。'
  return nudgeLineByHint(hint)
}

/** 主人不在电脑前 + 黏人阶梯到点 → 试探 QQ（内部全部节流，失败静默） */
async function tryQqReach (stage, idleMs) {
  try {
    const now = Date.now()
    const ic = imApi ? imApi.cfg() : null
    const gate = reach.shouldReach(reachRec, ic, { now, connected: imApi ? imApi.connected() : false })
    if (!gate.ok) return
    const mins = Math.max(1, Math.floor(idleMs / 60000))
    const text = await makeReachLine(stage, mins)
    if (!text) return
    await imApi.sendPrivate(gate.uid, text)
    reachRec = reach.onSent(reachRec, now)
    statBump('reachSent')
    nudgeRec = idleNudge.onSent(nudgeRec, stage)   // 发了就算这个阶段开过口
    log('[reach] 主人不在电脑前，QQ 找他（第 ' + stage + ' 阶）：' + text.slice(0, 40))
    // 0.45.23 发出去的话进本体聊天史——下次见面她记得「我在 QQ 上找过他、说的什么」
    qqNote({ self: '（我用 QQ 发消息找他）' + text })
    try { inner.noteNarration('主人不在电脑前，我去 QQ 上找他说了句话') } catch { }
  } catch (e) {
    log('[reach] QQ 找人失败: ' + (e && e.message))
  }
}

/* 0.45.72 睡前的那句 QQ（真实使用反馈：睡前她也没有主动来 QQ）。
 *
 * 之前有过「寂寞了可以在 QQ 上找他」的约定——
 * 然后整夜一条也没发。
 * 根因在 nudge tick：`if (sleepUntil) return` 挡在 tryQqReach 前面，而 onSleepDeclared
 * 又把 baseAt 推到他该醒的时刻，于是「去睡了」之后 QQ 通道等于物理断开。
 * 这里不等阶梯：他一道晚安，她就真去 QQ 说一句（reach 的全套红线照旧生效）。 */
const SLEEP_REACH_HINT = '主人刚刚说他要去睡了。你们之前说好了「想说话的话可以在 QQ 上找他」。' +
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
    const gate = reach.shouldReach(reachRec, ic, { now, connected: imApi ? imApi.connected() : false })
    if (!gate.ok) { log('[reach] 睡前没去 QQ：' + gate.why); return }
    const text = await nudgeLineByHint(SLEEP_REACH_HINT)
    if (!text) { log('[reach] 睡前那句没生成出来，这次不发了'); return }
    await imApi.sendPrivate(gate.uid, text)
    reachRec = reach.onSent(reachRec, now)
    lastGoodnightAt = now
    statBump('reachSent')
    log('[reach] 他道晚安了，我去 QQ 说了一句：' + text.slice(0, 40))
    qqNote({ self: text })
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
  if (idleNudge.declaresSleep(text)) {
    nudgeRec = idleNudge.onSleepDeclared(nudgeRec)
    log('[nudge] 主人去睡了，静默到 ' + new Date(nudgeRec.sleepUntil).toLocaleString('zh-CN', { hour12: false }))
    // 0.45.72：桌面闭嘴，但她说过要去 QQ 找他 —— 这句必须真发生
    tryQqGoodnight().catch(() => { })
  } else {
    nudgeRec = idleNudge.onUserTalk(nudgeRec)
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
  try { if (idleNudge.declaresSleep(text)) sleepWantedAt = Date.now() } catch { }
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
    const st = inner.state()
    const last = Number(st.lastUserAt) || 0
    if (last && !nudgeRec.baseAt) nudgeRec.baseAt = last
  } catch { }
  nudgeTimer = setInterval(async () => {
    try {
      const c = cfg()
      if (c.idleNudgeOn === false) return
      // 学习会话期间黏人模式闭嘴：她正盯着学习，不能同时喊「你怎么不理我」
      if (study.active(studySess)) return
      const now = Date.now()
      if (genAbort) return                                  // 正在聊天不打扰
      const st = presenceState()

      /* 0.45.12 黏人加强版·欢迎回来：离开一阵子刚坐回电脑前，迎一句。
         计时法：here 时不断刷新 lastActiveAt；从 away/gone 回到 here 的那一刻，
         now - lastActiveAt 就是这次离开的时长。 */
      if (st === 'here') {
        const absence = welcomeRec.lastActiveAt ? now - welcomeRec.lastActiveAt : 0
        welcomeRec.lastActiveAt = now
        saveWelcomeRec()
        const dp = (() => { try { return Number(inner.displeasure()) } catch { return 0 } })()
        if (absence > 0 && idleNudge.welcomeWorthy(absence, welcomeRec.lastWelcomeAt, now) && dp < 0.6) {
          const gate = getRhythm().ask('time')
          if (gate.ok) {
            const text = await makeWelcomeLine(Math.floor(absence / 60000))
            if (text) {
              await sayProactive(text, { kind: 'welcome' })
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
      const text = await makeNudgeLine(stage, Math.floor(idle / 60000))
      // 生成期间主人说话了（计时被清零/挪走）→ 作废不发
      if (nudgeRec.baseAt !== started) { log('[nudge] 生成期间主人说话了，作废'); return }
      if (!text) { nudgeRec = idleNudge.onFail(nudgeRec); return }
      await sayProactive(text, { kind: 'nudge' })
      try { getRhythm().note('time') } catch { } // 告诉另外三条通道：刚说过话，别贴上来
      nudgeRec = idleNudge.onSent(nudgeRec, stage)
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
 * 设计动机（来自真实使用反馈）：空闲几分钟不动时，希望角色能自己控制电脑去持续看想看的、
 * 做想做的，而不是打开之后停在那里不继续也不关闭」。
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
    projectsInst = projectsMod.create({ wsDir: () => curWsDir, log })
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
  } catch { }
  return out
}

function startAutonomy () {
  if (autonomyInst) return autonomyInst
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
    llmCfg: () => ({ baseUrl: cfg().apiBaseUrl, apiKey: cfg().apiKey, model: cfg().apiModel }),
    idleSec: () => {
      try { return require('electron').powerMonitor.getSystemIdleTime() } catch { return 0 }
    },
    busy: () => !!genAbort, // 正在对话/生成中不抢电脑
    pool: autonomyPool,
    cua: require('../cua'),
    openUrl: (u) => require('electron').shell.openExternal(u),
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
    }
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
      timeoutMs: 15000
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
    const res = await llm.chatStream({
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
    try { nudgeRec = idleNudge.onUserTalk(nudgeRec) } catch { } // 她刚忙完自己的事，黏人计时重置
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
    const res = await llm.chatStream({
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
 * 设计动机（来自真实使用反馈）：学习模式要真的能帮主人学习，而不是只是一个开关——
 * 约好后不定时过来看一眼屏幕，在玩游戏或看
 * 其他视频就过来指责（阶梯式生气），所有行为都记录进长期记忆。
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

/** 视觉判定：一次非流式请求，只要一行 JSON（thinking 模式不影响，实测可用） */
async function judgeByVision (c, b64, fg, goal, note) {
  const base = String(c.apiBaseUrl || '').replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions'
  const head = '主人的学习目标是：' + (goal || '未指定') +
    '\n前台窗口：' + (fg ? (String(fg.pn || '?') + '｜' + String(fg.title || '')) : '未知') +
    (note ? '\n' + String(note).slice(0, 200) : '') +
    '\n请判定这张屏幕截图。'
  const body = {
    model: c.apiModel,
    messages: [
      { role: 'system', content: WATCH_JUDGE_SYS },
      {
        role: 'user',
        content: [
          { type: 'text', text: head },
          { type: 'image_url', image_url: { url: /^data:image\//.test(String(b64)) ? String(b64) : 'data:image/jpeg;base64,' + b64 } }
        ]
      }
    ],
    temperature: 0,
    max_tokens: 200,
    stream: false
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => { try { ctl.abort() } catch { } }, 30000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (c.apiKey || '') },
      body: JSON.stringify(body),
      signal: ctl.signal
    })
    if (!res.ok) {
      // 400/422 = 这个接口不收图，记一笔（下次别再白截一张图）
      if (res.status === 400 || res.status === 422) {
        try { patchCfg({ visionNoImage: true }) } catch { }
      }
      throw new Error('HTTP ' + res.status)
    }
    const j = await res.json()
    const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
    return studyWatch.normalizeVerdict(txt)
  } finally {
    clearTimeout(timer)
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
    const res = await llm.chatStream({
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
 *  真实使用反馈：要的是角色真生气自己说出来的话，不是固定语句——固定台词一听就假，
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
 * 真实使用反馈：学习模式里发生过的事都要进记忆，退出后不能什么都不记得。
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
    self.patchState(ws, { mood: mood, cold: cold })
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
 * 真实使用反馈：需要的是自动进入的学习模式，不是开关式的。
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

async function transcribe (base64, mime) {
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

function transcribeQueued (base64, mime) {
  return new Promise((resolve) => {
    asrQueue.push({ base64, mime, resolve })
    pumpAsr()
  })
}

function pumpAsr () {
  if (asrBusy) return
  const job = asrQueue.shift()
  if (!job) return
  asrBusy = true
  Promise.resolve()
    .then(() => transcribe(job.base64, job.mime))
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
    petOn: c.petOn !== false,
    petScale: c.petScale != null ? c.petScale : 1,
    petWalk: c.petWalk || 'calm', // 走动三档：off / calm / lively
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
    petVrmaActs: (() => {
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
    })(),
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
    gameModeMute: c.gameModeMute !== false,
    gameModeGreet: c.gameModeGreet !== false,
    gameModeScale: c.gameModeScale != null ? c.gameModeScale : 0.7,
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
  // 语音请求代理：启动时按配置初始化（空=跟随系统，direct=强制直连，其它=自定义规则）
  try { require('./tts').setTtsProxy(cfg().netProxy) } catch (err) { log('[companion] 初始化 TTS 代理失败:', err.message) }
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

  ipcMain.handle('companion:transcribe', async (_e, base64, mime) => {
    const t0 = Date.now()
    if (asrQueue.length >= ASR_QUEUE_MAX) {
      log('[asr] 队列已满（' + asrQueue.length + ' 句在等），丢弃最新一段')
      return { ok: false, message: '还在识别前面的话，等我说完再讲' }
    }
    const queued = asrQueue.length + (asrBusy ? 1 : 0)
    const r = await transcribeQueued(base64, mime)
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
async function speakWithCurrentConfig (text) {
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
      speed: c.ttsSpeed || 1, text: spoken
    })
    return { ok: true, url: r.url, speed: r.speed, lang: c.replyLang || 'zh' }
  } catch (err) {
    // 0.22.0 本地回退链（主人 2026-10-26 定案）：Fish 失败/超时 → SoVITS（快，5~20s）
    //   → IndexTTS（慢兜底，30~100s）→ 系统语音。前两级都是角色参考音色。
    if (c.sovitsOn !== false) {
      try {
        const sv = await ttsLocal.synthesizeSovits(spoken, c.replyLang || 'zh', () => cfg())
        return { ok: true, url: sv.url, lang: c.replyLang || 'zh', local: true }
      } catch (e2) {
        log('[tts-local] SoVITS 回退失败: ' + (e2 && e2.message))
      }
    }
    if (c.indexTtsOn !== false) {
      try {
        const loc = await ttsLocal.synthesize(spoken, c.replyLang || 'zh', () => cfg())
        return { ok: true, url: loc.url, lang: c.replyLang || 'zh', local: true }
      } catch (e2) {
        log('[tts-local] IndexTTS 回退失败: ' + (e2 && e2.message))
      }
    }
    const cur = character.get() || null
    const voiceName = (cur && cur.voice && cur.voice.sysVoiceName) || c.sysVoiceName || ''
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

module.exports = { createWindow, registerIpc, stop, bootPet, setOverlayBroadcast, setFullscreenSync, switchChar, getWindow: () => win, imSynthesize, userProfileText, alarmAdd, alarmList, alarmCancel, onUserSpoke, noteExchange, dreamRun, studyStart, studyStop, studyStatus, studyTool, studyActive: () => study.active(studySess), setStudyTrayRefresh: (fn) => { studyOnTrayRefresh = fn }, setObsPortGetter, setImApi, syncRemote, remoteStatus: () => remote.status(), ttsSpeak: speakWithCurrentConfig, qqNote, desktopHistoryTail, noteGameSession }

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
