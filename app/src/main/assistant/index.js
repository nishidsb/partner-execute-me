/**
 * Ryza Assistant 助手核心服务壳（v0.2.0 重构第一阶段）
 *
 * 职责：把独立助手核心（src/assistant/core，ESM）接入 Electron 主进程：
 *  - 会话管理（按角色缓存 Session，切换角色即切会话）
 *  - assistant:* IPC 命名空间（send/roles/memory/history/provider）
 *  - 事件桥：流式 delta / 工具调用 / 完成 → 聊天窗 + overlay 桌宠气泡
 *  - 高风险工具 → 系统对话框确认（confirmFn 经 Session 透传）
 *  - 首次启动自动从 companion 配置导入模型凭据（开箱即用）
 *
 * 核心保持零依赖、纯 Node：服务壳只做进程内接线，不掺业务逻辑。
 * 与 companion 模块完全平行，零改动（回退路径 = 继续用托盘「AI…」）。
 */
const { ipcMain, BrowserWindow, app } = require('electron')
const path = require('path')
const { log } = require('../logger') // v0.4.2 修复：logger 导出的是 { log, logfile }，整体 require 导致 init 末尾抛 log is not a function
// S6：电脑操作确认窗（自绘，60 秒超时，不阻塞主进程）
const cuaConfirm = require('../cua/confirm')
// S6.x：模型能不能读图（决定截图有没有用 / prompt 要不要切盲操作）
const modelCaps = require('./modelCaps')

let cfgMod = null
let vendorMod = null
let modelsMod = null // S8：刷B站值班轮复用同一套厂商配置（createProvider）
let roles = null
let memory = null
let partner = null // S4：PARTNER.md 记忆工作区（ESM 模块，init 时注入）
let Session = null
let tools = null
let langMismatch = null // 语种粗判（session.js 导出），字幕是否要翻译靠它

let ready = false
let dataRoot = ''
let bcastFn = null // 向 overlay 广播（桌宠气泡联动）
let assistantWin = null // 聊天窗，由 main.js 注入
const sessions = new Map() // roleId → Session

// 核心目录（本文件在 src/main/assistant/，向上两级到 src/assistant/core/）
// 必须放模块级：registerIpc() 里的按需 import（用量报表）也要用，init() 的局部变量够不到
const CORE_ROOT = '../../assistant/core/'
const IMP = (p) => 'file:///' + path.join(__dirname, p).replace(/\\/g, '/')

function sendWin (ch, data) {
  if (assistantWin && !assistantWin.isDestroyed()) assistantWin.webContents.send(ch, data)
}
function bcastAll (ch, data) {
  sendWin(ch, data)
  if (bcastFn) bcastFn(ch, data)
}

/* ---------------- 电脑操作权限（S6 4.2 四档 + 单程序白名单） ----------------
 * 以前只要模型调 exec_command 就弹系统对话框，用户觉得「设置里配好了还每次问」。
 * 现在权限完全由设置页决定：
 *   ask-each-turn     每次都问
 *   ask-before-acting 每次动作前问（默认）
 *   ask-once          问一次，30 分钟内不再问
 *   never-ask         从不问（含命令行）
 * 另外「允许启动的应用」名单里的程序，open_app 永远不问。 */
const PERM_MODES = ['ask-each-turn', 'ask-before-acting', 'ask-once', 'never-ask']
const GRANT_MS = 30 * 60 * 1000

function companionCfg () {
  try {
    const store = require('../store')
    return (store.get().global || {}).companion || {}
  } catch { return {} }
}

function permSettings () {
  const c = companionCfg()
  // 默认 ask-once：第一次问一次，之后 30 分钟内不再打扰（用户嫌「每次都问」的直接原因）
  const mode = PERM_MODES.includes(String(c.permMode)) ? String(c.permMode) : 'ask-once'
  const allowApps = String(c.permAllowApps || '')
    .split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean)
  const allowTools = Array.isArray(c.permAllowTools) ? c.permAllowTools.slice() : []
  // 0.18.0 第二批：终端单独询问。默认开（permTerminalAsk !== false 就不放行），
  // 用户明确关掉才按普通档位走——exec_command 一条命令能做的事没有上限，不吃档位。
  const allowTerminal = c.permTerminalAsk === false
  return { mode, allowTools, allowApps, grantUntil: Number(c.permGrantUntil) || 0, allowTerminal }
}

/** 应用名是否在允许名单里（大小写/空格不敏感，支持包含） */
function appAllowed (name, perm) {
  const q = String(name || '').replace(/\s+/g, '').toLowerCase()
  if (!q) return false
  return (perm.allowApps || []).some((a) => {
    const k = String(a).replace(/\s+/g, '').toLowerCase()
    return k && (k === q || q.includes(k) || k.includes(q))
  })
}

function grantOnce () {
  try {
    const store = require('../store')
    store.patchGlobal({ companion: { ...companionCfg(), permGrantUntil: Date.now() + GRANT_MS } })
    log('[assistant] 电脑操作授权 30 分钟')
  } catch (e) { log('[assistant] 写授权失败:', e.message) }
}

/* ---------------- S6 电脑操作（CUA）总开关与风险确认（规格 4.6） ----------------
 * 十一个截图/点击/输入工具默认全部关闭：用户必须在聊天窗「电脑」页读完三条风险
 * 并逐条勾选后才能开启。开启状态存在 companion 配置里（和权限档位同一处）。
 * 门禁在核心 registry 的 gate 上：没开启时工具既不出现也不可调用。 */
const CUA_RISK_ITEMS = [
  '她看到的屏幕截图可能包含聊天记录、隐私照片、密码输入框等敏感内容，截图会随对话发给模型服务商',
  '她点击和打字是真实的：可能误点到删除、付款、发送等按钮，也可能把内容输到错误的窗口',
  '任务进行中请勿同时操作鼠标键盘——一旦你动鼠标，她会自动让位（最多等 15 秒），但动作已经发出的部分无法撤回'
]

function cuaSettings () {
  const c = companionCfg()
  const acks = Array.isArray(c.cuaRiskAcks) ? c.cuaRiskAcks : []
  // 模型能不能读图：读不了图 → 截图对它没用，UI 要提前说清楚，
  // prompt 也要切成盲操作模式（详情见 modelCaps.js 的注释）
  const cap = modelCaps.caps({
    baseUrl: c.apiBaseUrl || '',
    model: c.apiModel || '',
    visionOn: c.visionOn !== false
  })
  return {
    enabled: c.cuaEnabled === true,
    readAll: CUA_RISK_ITEMS.every((_t, i) => acks[i] === true),
    acks: CUA_RISK_ITEMS.map((_t, i) => acks[i] === true),
    ackAt: Number(c.cuaRiskAckAt) || 0,
    risks: CUA_RISK_ITEMS,
    vision: cap.vision,
    visionNote: cap.note,
    model: cap.model
  }
}

/** 写开启状态：只在三条都勾了时才允许开启 */
function setCuaEnabled (on, acks) {
  const store = require('../store')
  const c = companionCfg()
  const list = Array.isArray(acks) ? CUA_RISK_ITEMS.map((_t, i) => acks[i] === true) : (c.cuaRiskAcks || [])
  const allRead = CUA_RISK_ITEMS.every((_t, i) => list[i] === true)
  if (on && !allRead) return { ok: false, error: '请先把三条风险都勾选确认' }
  store.patchGlobal({
    companion: {
      ...c,
      cuaEnabled: !!on,
      cuaRiskAcks: list,
      cuaRiskAckAt: on ? Date.now() : (Number(c.cuaRiskAckAt) || 0)
    }
  })
  log('[assistant] 电脑操作 ' + (on ? '已开启' : '已关闭'))
  return { ok: true, enabled: !!on }
}

/* ---------------- 电脑操作确认（规格 4.2：允许 / 30 分钟内都允许 / 拒绝） ---------------- */
const TOOL_WHAT = {
  click: '在你电脑上点一下鼠标',
  move: '移动你的鼠标',
  drag: '按住鼠标拖动一段',
  scroll: '滚动鼠标滚轮',
  type: '替你敲键盘输入文字',
  key: '按一个组合键',
  focus: '把某个窗口切到前台',
  exec_command: '在你的电脑上执行命令行命令'
}

/** 需要确认的工具 → 确认窗（异步，60 秒无人应答按拒绝处理） */
async function confirmFn (name, args, risk) {
  const perm = permSettings()
  // 兜底：设置页里 allowTools 已经放行的工具（registry 也会判，这里防旧调用）
  if ((perm.allowTools || []).includes(name)) return true
  if (name === 'open_app' && appAllowed(args && args.name, perm)) return true
  // 0.45.92 每天排查「又在问我」时，这行是唯一能看出「问的是什么」的线索
  log('[assistant] 需要确认：' + name + '（档位 ' + perm.mode + '）')

  // 0.18.0 第二批：终端类专用确认——把命令原文摆在最显眼处，只给「执行这一次 / 拒绝」，
  // 不给「30 分钟内都允许」（那等于把一整类不可逆操作一次性放行）。
  const isTerminal = name === 'exec_command' || name === 'job_kill' || name === 'job_run_background'
  if (isTerminal) {
    const cmdText = String((args && (args.command || args.script_path)) || '').trim()
    const detail = [
      cmdText ? '命令：\n' + cmdText.slice(0, 900) : '',
      args && args.script_path ? '脚本文件：' + String(args.script_path).slice(0, 300) : '',
      name === 'job_kill' ? '要终止的后台作业：' + String((args && args.job_id) || '?') : '',
      '（终端命令能做的事没有上限：删文件、改配置、传数据都在其中。看清了再放行。）'
    ].filter(Boolean).join('\n')
    const tr = await cuaConfirm.ask({
      icon: 'warning',
      message: name === 'job_kill' ? '角色想终止一个后台作业' : '角色想在这台电脑上执行命令',
      detail,
      buttons: ['执行这一次', '拒绝'],
      rememberIndex: -1,
      timeoutMs: 60000
    })
    if (tr.index < 0) { log('[assistant] 终端确认超时/关窗 → 视为拒绝：' + name); return false }
    // 最后一个按钮是拒绝
    return tr.index === 0
  }

  let what = TOOL_WHAT[name]
  if (!what) {
    if (name === 'open_app') what = `打开程序「${(args && args.name) || '?'}」`
    else if (name === 'launch_game') what = `启动游戏「${(args && args.name) || '?'}」`
    else what = `执行操作「${name}」`
  }
  // 开程序时多给一个「以后这个程序都不问」——用户最烦的就是每次都被问同一件事
  const canRememberApp = name === 'open_app' && String((args && args.name) || '').trim()
  const buttons = canRememberApp
    ? ['允许', '以后这个程序都不问', '拒绝']
    : ['允许', '30 分钟内都允许', '拒绝']
  const r = await cuaConfirm.ask({
    icon: risk === 'high' || TOOL_WHAT[name] ? 'warning' : 'question',
    message: `角色想${what}`,
    detail: (args && Object.keys(args).length ? JSON.stringify(args, null, 2).slice(0, 900) : '') +
      (TOOL_WHAT[name] ? '\n（这会真的动你的鼠标键盘）' : ''),
    buttons,
    rememberIndex: 1,
    // 0.45.92 原来这里传空串，但 CSS 里 .remember{display:flex} 会盖掉 hidden，
    // 于是那个「记住」勾选框一直显示、没有文字、勾了主进程也不读 —— 勾了等于没勾。
    // 现在语义只走按钮（第二个按钮就是「记住」），勾选框彻底不放出来。
    rememberLabel: '',
    timeoutMs: 60000
  })
  if (r.index < 0) {
    log('[assistant] 确认超时/关窗 → 视为拒绝：' + name)
    return false
  }
  const denied = buttons.length - 1
  if (r.index === denied) return false
  // r.remember 是勾选框（历史遗留）——留着兼容，等价于按了「记住」
  const remembered = r.index === 1 || !!r.remember
  if (canRememberApp && remembered) { rememberApp(args.name); return true }
  if (!canRememberApp && remembered) { grantOnce(); return true }
  // ask-once 档位本身就是「问一次」：选了允许就把这半小时一起放过
  if (r.index === 0 && perm.mode === 'ask-once') { grantOnce(); return true }
  return r.index === 0
}

/** 把程序加进「允许直接打开的程序」名单（写 companion 配置，设置页能改） */
function rememberApp (name) {
  const one = String(name || '').trim()
  if (!one) return
  try {
    const store = require('../store')
    const c = companionCfg()
    const list = String(c.permAllowApps || '').split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean)
    if (!list.some((x) => x.toLowerCase() === one.toLowerCase())) list.push(one)
    store.patchGlobal({ companion: { ...c, permAllowApps: list.join(', ') } })
    log('[assistant] 已加入允许名单：' + one)
  } catch (e) { log('[assistant] 写允许名单失败:', e.message) }
}

async function init ({ logDir, dataRoot: root, bcast } = {}) {
  if (ready) return
  // ESM 核心：目录内有 package.json type:module，动态 import 从 CJS 桥接
  // 路径相对本文件（src/main/assistant/）向上两级到 src/assistant/core/
  // v0.3.1 修复：此前写死 'src/assistant/core/' 相对 __dirname 拼接，打包后必然 ERR_MODULE_NOT_FOUND
  const l = await import(IMP(CORE_ROOT + 'logger.js'))
  l.initLogger(logDir)
  cfgMod = await import(IMP(CORE_ROOT + 'config.js'))
  vendorMod = await import(IMP(CORE_ROOT + 'vendors.js'))
  modelsMod = await import(IMP(CORE_ROOT + 'models/index.js'))
  const roleMod = await import(IMP(CORE_ROOT + 'roles/roleManager.js'))
  const memMod = await import(IMP(CORE_ROOT + 'memory/memoryStore.js'))
  const sessMod = await import(IMP(CORE_ROOT + 'core/session.js'))
  const toolMod = await import(IMP(CORE_ROOT + 'tools/index.js'))
  roles = roleMod.roles
  memory = memMod.memory
  Session = sessMod.Session
  langMismatch = sessMod.langMismatch
  sessRef = sessMod
  // 0.34.0 陪看白板：companion 模块可能比 assistant 先就绪，挂着的回调在这里补上
  if (pendingLive) {
    try { sessMod.setLiveContext(pendingLive[0], pendingLive[1]) } catch { }
  }
  // 0.46.28 生活线回调同款补挂
  if (pendingLife) {
    try { sessMod.setLifeBlocks(pendingLife) } catch { }
  }
  tools = toolMod.default
  // S3：桌宠六工具交给主进程实现（懒加载，避免与 pet 模块的 boot 顺序耦合）
  if (tools && typeof tools.setPetBridge === 'function') {
    tools.setPetBridge((name, args) => require('../petBridge').invoke(name, args))
  }
  // 0.45.93 主动发 QQ 四工具：走同一条 petBridge（companion 里才有 imApi 和计划队列）
  if (tools && typeof tools.setReachBridge === 'function') {
    tools.setReachBridge((name, args) => require('../petBridge').invoke(name, args))
  }
  // 0.46.6 闹钟三工具桥：alarm.js 的注释写着「与 pet_* 共用同一条桥」，实际却建了独立的
  // module 级 bridge，宿主从来没注入过——她每次设闹钟都报「闹钟未连接（宿主没有注入定时器）」
  // （ryza.log 10-31 起多次实证），只能用 remember 曲线救国。学习三工具同款（setStudyBridge
  // 也没人喂），petBridge 里 case 全都写好了，一并接上。
  if (tools && typeof tools.setAlarmBridge === 'function') {
    tools.setAlarmBridge((name, args) => require('../petBridge').invoke(name, args))
  }
  if (tools && typeof tools.setStudyBridge === 'function') {
    tools.setStudyBridge((name, args) => require('../petBridge').invoke(name, args))
  }
  // 0.46.28 生活线三工具桥（goal_set/list/update → companion/goals.js，同一条 petBridge）
  if (tools && typeof tools.setGoalBridge === 'function') {
    tools.setGoalBridge((name, args) => require('../petBridge').invoke(name, args))
  }
  // 0.46.31 看视频：bili_watch 走同一条宿主桥
  if (tools && typeof tools.setBiliBridge === 'function') {
    tools.setBiliBridge((name, args) => require('../petBridge').invoke(name, args))
  }
  // S6.5：开程序 / 开游戏 / 游戏模式
  if (tools && typeof tools.setSystemBridge === 'function') {
    tools.setSystemBridge((name, args) => require('../systemBridge').invoke(name, args))
  }
  // 0.24.0：电脑画像两工具（pc_profile / pc_refresh）——同样是只读档案，
  // 走 systemBridge 同一个实现，不再单独开一套桥
  if (tools && typeof tools.setProfileBridge === 'function') {
    tools.setProfileBridge((name, args) => require('../systemBridge').invoke(name, args))
  }
  // 0.24.0：健康记录两工具（health_log / health_read）——写自家的 jsonl，走独立桥
  if (tools && typeof tools.setHealthBridge === 'function') {
    tools.setHealthBridge((name, args) => require('../healthBridge').invoke(name, args))
  }
  // S6：CUA 十一工具（截图 / 点击 / 输入 / 窗口…）——执行在独立子进程里，
  // 主进程只经 cua 桥调用，引擎崩了不会带崩应用
  if (tools && typeof tools.setCuaBridge === 'function') {
    tools.setCuaBridge((name, args) => require('../cua').invoke(name, args))
  }
  // 门禁：用户没开启电脑操作时，这十一个工具既不出现在工具表里也不能被调用
  if (tools && typeof tools.setGate === 'function' && Array.isArray(toolMod.CUA_TOOLS)) {
    const cuaNames = toolMod.CUA_TOOLS
    const utNames = Array.isArray(toolMod.USER_TOOL_CHAT) ? toolMod.USER_TOOL_CHAT : []
    tools.setGate((name) => {
      if (cuaNames.includes(name)) return cuaSettings().enabled
      // 她的工具元工具（写/跑/列）按设置里的总开关放行；部署后的 utool_* 只在启用时才注册，无需 gate
      if (utNames.includes(name)) return companionCfg().userToolsOn === true
      return true
    })
  }
  // 模型读不了图时，提示词里别再让它「先截图再点」——那是自欺欺人
  if (tools && typeof tools.setCuaVision === 'function') tools.setCuaVision(cuaSettings().vision)

  dataRoot = root
  cfgMod.initDataDir(path.join(dataRoot, 'assistant'))
  // 0.23 第 3 期：她的工具自迭代（tools-user 工作区 + 沙箱校验 + 部署快照 + 独立 git）
  if (tools && typeof tools.setUserToolsBridge === 'function') {
    try {
      const ut = require('./userTools')
      ut.init(dataRoot)
      ut.setOnChange((m) => { try { tools.syncUserTools(m) } catch { } })
      tools.setUserToolsBridge((name, args) => ut.invoke(name, args))
      tools.syncUserTools(ut.manifest())
    } catch (e) { log('[assistant] 她的工具模块挂载失败: ' + (e.message || e)) }
  }
  // 1.3 ChatGPT 账号登录：令牌文件路径注入 + 登录/登出/状态 IPC
  try {
    const chatgptAuth = require('./chatgptAuth')
    chatgptAuth.init({ dataRoot })
    chatgptAuth.registerIpc()
  } catch (e) { log('[assistant] ChatGPT 登录模块挂载失败:', e.message) }
  roles.seedBuiltin()
  // S4：记忆工作区（PARTNER.md + git）。旧 JSON 事实一次性迁移进来，再打启动快照 tag
  try {
    const partnerMod = await import(IMP(CORE_ROOT + 'memory/partner.js'))
    partner = partnerMod.partner
    const cur = cfgMod.getConfig().currentRole
    const role = roles.get(cur)
    let legacy = []
    try { legacy = memory.list(cur) } catch {}
    // 记忆跟角色卡走：scope=当前角色 → workspace/<roleId>/ 独立工作区；
    // 旧的全局 workspace/ 首次会整体迁入当前角色目录（git 历史保留）
    partner.ensureWorkspace({ roleName: role && role.name, legacyFacts: legacy, scope: cur })
    // 版本号用 electron app.getVersion()（require('../../package.json') 相对路径
    // 算出来是 src/package.json，asar 包里必炸 → 记忆工作区快照初始化失败）
    partner.snapshot(app.getVersion(), cur)
    // 0.19.0 工作区自动整理：根目录旧文件按月份归进 archive/，移动同样进版本历史
    try {
      const archMod = await import(IMP(CORE_ROOT + 'memory/archive.js'))
      const ar = archMod.applyArchive(partner.workspaceDir(cur))
      if (ar.moved.length) {
        try { partner.commitAll(`整理：${ar.moved.length} 个旧文件移进 ${ar.dir}`, undefined, cur) } catch {}
        log('[memory] 工作区整理：' + ar.moved.length + ' 个文件 → ' + ar.dir)
      }
    } catch (e) { log('[memory] 自动整理跳过: ' + (e && e.message)) }
  } catch (e) {
    log('[assistant] 记忆工作区初始化失败（对话不受影响）:', e.message)
  }

  bcastFn = bcast || null

  // 首次启动：assistant 配置没有 key 时，从 companion 配置导入凭据（开箱即用）
  const cfg = cfgMod.loadConfig()
  if (!cfg.provider.apiKey) {
    try {
      const store = require('../store')
      const comp = (store.get().global || {}).companion || {}
      if (comp.apiKey) {
        cfg.provider.apiKey = comp.apiKey
        if (comp.apiBaseUrl) cfg.provider.baseUrl = comp.apiBaseUrl
        if (comp.apiModel) cfg.provider.model = comp.apiModel
        cfgMod.saveConfig()
        log('[assistant] 已从 companion 配置导入模型凭据 model=' + cfg.provider.model)
      }
    } catch (e) {
      log('[assistant] 导入 companion 凭据失败（可在聊天窗手动配置）:', e.message)
    }
  }

  registerIpc()
  ready = true
  log('[assistant] 助手核心就绪 dataDir=' + dataRoot + ' roles=' + roles.list().map((r) => r.id).join(','))
}

function setAssistantWin (w) { assistantWin = w }

/* ---------------- 触摸事件合并（S4/3.5） ----------------
 * 桌宠被摸时主进程会收到 pet:touch 广播（拖起/放下/甩出/撞边/部位点击）。
 * 一次「一直摸」会在几秒内产生几十条事件，逐条塞进上下文会把预算烧光，
 * 所以合并成一个 2.5 秒的窗口：窗口结束才注入一句「刚刚有人碰了你：摸头 ×3」。
 */
const TOUCH_NAME = {
  head: '摸了你的头', face: '戳了你的脸', body: '碰了你的身体', hand: '牵了你的手',
  leg: '碰了你的腿', breast: '碰了你的胸口', weast: '碰了你的腰',
  arm_l: '碰了你的左臂', arm_r: '碰了你的右臂',
  grab: '把你拎了起来', drop: '把你放下', throw: '把你甩了出去', crash: '让你撞到了边上'
}
let touchBuf = []
let touchTimer = null

/** 部位/事件 → 情绪动作分级（0.24.0 触摸负反馈）。
 *  旧版这里恒传 'touch'，self.noteAttention 里 pet/throw 的分级分支从未生效过
 *  （扔人也加好感）。现在按部位/事件映射真实动作，桌面与手机触摸共用这一张表。 */
const TOUCH_ACTION = {
  head: 'pet', hand: 'pet', face: 'poke', body: 'poke', leg: 'poke',
  arm_l: 'poke', arm_r: 'poke',
  breast: 'invade', weast: 'invade',
  grab: 'grab', drop: 'drop', throw: 'throw', crash: 'crash'
}

function flushTouch () {
  touchTimer = null
  const parts = touchBuf.splice(0)
  if (!parts.length) return
  const count = new Map()
  for (const p of parts) count.set(p, (count.get(p) || 0) + 1)
  const text = [...count.entries()]
    .map(([p, n]) => `${TOUCH_NAME[p] || p}${n > 1 ? ` ×${n}` : ''}`)
    .join('、')
  // 0.24.0：烦躁阶梯——烦了就在注入里带一句她的「心里话」，下次回话自然带出来
  let hint = ''
  try {
    const lv = require('../companion/inner').annoyedLevel()
    if (lv === 'high') hint = '\n（你已经被碰得很烦了：可以直接让他别再碰，语气可以不满、可以小心眼，不用端着，但别真翻脸。）'
    else if (lv === 'mid') hint = '\n（被碰得有点多了，你有点想躲开他的手。）'
  } catch { }
  try {
    const { session } = getSession()
    session.pushNotice(`刚刚有人碰了你：${text}${hint}`)
    log('[touch] 已合并注入：' + text + (hint ? '（烦躁提示）' : ''))
  } catch { /* 核心没就绪就丢掉，不影响触摸反馈 */ }
}

/** 主进程收到 pet:touch 时调用（同一窗口内合并） */
function noteTouch (part) {
  if (!ready || !part) return
  const p = String(part)
  // 自我层：被碰这件事要进她自己的经历账本（日记和关系状态都靠它）；
  // 0.24.0 起传真实动作分级（摸头=安抚 / 高频戳=烦躁 / 扔摔=生气）
  try { require('../companion/inner').noteTouch(TOUCH_ACTION[p] || 'touch', p) } catch { }
  // 回应模式（0.19.0）：安静 = 只记着，等主人下次开口一起说；自定义 = 没勾的类别也记着
  let decision = 'now'
  try {
    const c = require('../store').get().global.companion || {}
    decision = require('../companion/reaction').decide(c.reactionMode, c.reactionTypes, part)
  } catch { }
  if (decision === 'ignore') return
  touchBuf.push(String(part))
  if (touchBuf.length > 60) touchBuf.splice(0, touchBuf.length - 60)
  if (decision === 'now') {
    if (touchTimer) clearTimeout(touchTimer)
    touchTimer = setTimeout(flushTouch, 2500)
  }
}

/* ---------------- 自主动作感知（0.33.0） ----------------
 * 长待机小彩蛋（idle_fidget 伸懒腰）是渲染层自己播的，不是模型指挥的——
 * 以前它只是「一个动画」，她自己都不知道刚伸过懒腰。渲染层播下时上报
 * pet:self-report，这里注一句进通知队列，下次说话自然带着这份记忆。 */
const SELF_ACT_NAME = {
  idle_fidget: '自己伸了个懒腰、活动了一下身体'
}
let selfActLast = 0

/** 渲染层上报自主动作时调用（pet:self-report） */
function noteSelfAct (kind) {
  if (!ready || !kind) return
  const text = SELF_ACT_NAME[String(kind)]
  if (!text) return
  const t = Date.now()
  if (t - selfActLast < 10000) return // 防抖：同一个小动作 10s 内只记一次
  selfActLast = t
  try {
    const { session } = getSession()
    session.pushNotice(`（你刚刚${text}）`)
    log('[self-act] 已注入：' + text)
  } catch { /* 核心没就绪就丢掉 */ }
}

/** 取（或建）某角色的会话；不传 id 用当前激活角色 */
function getSession (roleId) {
  const id = roleId || cfgMod.getConfig().currentRole
  if (!sessions.has(id)) {
    const role = roles.get(id)
    if (!role) throw new Error('角色不存在: ' + id)
    sessions.set(id, new Session(role))
  }
  return { session: sessions.get(id), id }
}

function providerSet (patch) {
  try {
    const cfg = cfgMod.getConfig()
    for (const k of ['baseUrl', 'apiKey', 'model', 'temperature', 'type', 'reasoningEffort']) {
      if (patch[k] !== undefined) {
        if (k === 'apiKey' && /^\*\*\*/.test(patch[k])) continue // 脱敏回传不覆盖
        cfg.provider[k] = patch[k]
      }
    }
    cfgMod.saveConfig()
    for (const s of sessions.values()) s.reloadProvider()
    log('[assistant] 模型配置已更新 model=' + cfg.provider.model)
    return { ok: true, provider: cfgMod.describeProvider() }
  } catch (err) { return { ok: false, error: err.message } }
}

const LANG_NAME = { zh: '中文', en: '英文', ja: '日文' }

/**
 * 设置页的「AI 回复语言 / 显示字幕」存在 companion 配置里。
 * v0.3.1 修复：聊天合并到助手核心后没桥接这两个设置 → 选「日语」实际回中文、
 * TTS 也就照着中文念（语音语言 = 台词语言）。这里每次发消息都现读，改设置立刻生效。
 */
function langSettings () {
  try {
    const store = require('../store')
    const c = (store.get().global || {}).companion || {}
    return { reply: String(c.replyLang || ''), sub: String(c.subLang || 'off') }
  } catch { return { reply: '', sub: 'off' } }
}

async function handleSend (_e, text, images) {
  if (!ready) return { ok: false, error: '助手核心未就绪' }
  const t = String(text || '').trim()
  const imgs = (Array.isArray(images) ? images : [])
    .filter((u) => typeof u === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(u) && u.length <= 11 * 1024 * 1024)
    .slice(0, 8) // 1.10：≤8 张，dataURL 本体 ≤11MB（原图约 8MB）
  if (!t && !imgs.length) return { ok: false, error: '内容为空' }
  // 安静回应模式下，攒着的互动在主人开口这一刻先注入，让她「一起回应」
  try { if (touchBuf.length) flushTouch() } catch { }
  // 0.22.0 补丁⑦：主人开口 → 黏人计时清零 + 自我层事件（不调用会在她眼里永远是「主人没理我」）
  try { require('../companion').onUserSpoke(t) } catch { }
  const { session } = getSession()
  // 0.33.0 自我状态感知：主人开口时把「她此刻在干嘛」也告诉她自己——
  // 走动 / 坐卡片 / 被拎着 / 趴窗台……以前这些只是状态机在转，她自己没意识
  try {
    const act = require('../companion/pet').describeActivity()
    if (act) session.pushNotice('（你此刻的状态：' + act + '）')
  } catch { }
  const lang = langSettings()
  const perm = permSettings()
  const comp = companionCfg()
  // 每次发消息都按当前 provider/模型刷新一次视觉能力（用户可能刚换了模型）
  if (tools && typeof tools.setCuaVision === 'function') tools.setCuaVision(cuaSettings().vision)
  const seq = Date.now()
  bcastAll('assistant:delta', { seq, text: '', reset: true })
  try {
    const r = await session.send(t, {
      onDelta: (chunk) => bcastAll('assistant:delta', { seq, text: chunk }),
      onTool: (name) => bcastAll('assistant:tool', { seq, name }),
      confirmFn,
      // 0.45.92 之前这里漏了 allowTerminal —— permSettings 算出来了、registry 也在等它，
      // 唯独没人传。结果「终端命令单独询问」这个开关是死的：关了照样每条命令问一次。
      // 0.45.93 用户明确要求「不需要询问我是否执行」：开关关掉就是一条都不问（原先我加的
      // 「危险命令仍问一次」也算打扰，撤掉了——他要的是不被打断，风险由他自己认）。
      policy: { mode: perm.mode, allowTools: perm.allowTools, grantUntil: perm.grantUntil, allowTerminal: perm.allowTerminal },
      replyLang: lang.reply,
      // 截图要不要发给模型：纯文本模型 / 用户关掉了「允许截屏看桌面」就纯文本跑。
      // 模型本身读不了图时也直接关掉——否则每轮都要先吃一次 400 再降级重跑。
      vision: (comp.visionOn !== false) && cuaSettings().vision,
      images: imgs
    })
    // 0.45.34 正文内嵌 <pet_act> 接住：模型（deepseek 系）偶尔不发 function call，
    // 把动作写成正文 XML——解析出来真播，从台词/字幕/历史里剥掉，别把标签显示出去
    try {
      const inl = require('../petBridge').extractInlineAct(r.content)
      if (inl.actions.length) {
        r.content = inl.text
        const lastMsg = session.history[session.history.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') lastMsg.content = inl.text
        try { session.saveHistory() } catch { }
        Promise.resolve(require('../petBridge').invoke('pet_act', { actions: inl.actions }))
          .catch((e) => log('[assistant] 内嵌动作播放失败:', e && e.message))
        log('[assistant] 正文内嵌动作已接住并播放：' + inl.actions.join('/'))
      }
    } catch { }
    // 台词（content，朗读用）与字幕（display，显示用）分流：
    // 回复语言=日语 + 显示字幕=中文 → 说日语、气泡/聊天窗显示中文
    let display = r.content
    const subName = LANG_NAME[lang.sub]
    if (subName && r.content && langMismatch && langMismatch(r.content, lang.sub)) {
      const tr = await session.translate(r.content, subName)
      if (tr) {
        display = tr
        // 历史里也带字幕：回看聊天记录时台词 + 译文都在
        const last = session.history[session.history.length - 1]
        if (last && last.role === 'assistant') {
          last.sub = tr
          try { session.saveHistory() } catch {}
        }
      }
    }
    bcastAll('assistant:done', { seq, content: r.content, display, toolResults: r.toolResults, ms: r.ms })
    // 长期记忆：每轮完整回复后本地提取 + 攒轮次（每 4 轮 LLM 整理，对齐参考 memory_framework）
    memoryExtract(cfgMod.getConfig().currentRole, t, r.content)
    // 第 1 期 风格 few-shot：真实对话对入池（环形 200 条，注入时取最近几条）
    try { require('../companion').noteExchange(t, r.content) } catch { }
    // 0.46.75 回复记账（对齐 companion 链 inner.noteReply）：11-08 实锤他连发两条消息，
    // 第二条回复把第一条的开头内容原样又讲了一遍——回复链的镜子里从来没有她自己的
    // 回复，因为只有 companion 链记了账。不记账 → recentVoices 照不到 → 复读无人拦。
    try { require('../companion/inner').noteReply(r.content) } catch { }
    log('[assistant] 回复语言=' + (lang.reply || 'auto') + ' 字幕=' + lang.sub + (display !== r.content ? '（已翻译）' : '') + ' ms=' + r.ms)
    return { ok: true, ...r, display }
  } catch (err) {
    log('[assistant] send 失败:', err.message)
    bcastAll('assistant:error', { seq, message: err.message })
    return { ok: false, error: err.message }
  }
}

/** 切换激活角色（持久化 + 预热会话）——IPC 与托盘共用 */
function switchRole (id) {
  const role = roles.get(id)
  if (!role) return { ok: false, error: '角色不存在' }
  const cfg = cfgMod.getConfig()
  cfg.currentRole = id
  cfgMod.saveConfig()
  try { getSession(id) } catch {} // 预热会话
  log('[assistant] 切换角色 → ' + id)
  return { ok: true, currentRole: id }
}

function registerIpc () {
  ipcMain.handle('assistant:send', handleSend)
  ipcMain.handle('assistant:state', () => {
    const cfg = cfgMod.getConfig()
    return {
      provider: cfgMod.describeProvider(cfg.provider),
      currentRole: cfg.currentRole,
      roles: roles.list().map(({ id, name, persona, builtin }) => ({
        id, name, builtin, persona: String(persona || '').slice(0, 80)
      })),
      memoryTopK: cfg.memoryTopK,
      languageGuard: cfg.languageGuard
    }
  })
  ipcMain.handle('assistant:switch-role', (_e, id) => switchRole(id))
  /** 0.18.0 第一批：上下文圆环 —— 当前会话估算 token / 厂商上限 / 折叠阈值 */
  ipcMain.handle('assistant:context', () => {
    try {
      const { session } = getSession()
      const vi = session.vendorInfo ? session.vendorInfo() : { ctx: 0 }
      const tokens = session.estTokens ? session.estTokens() : 0
      const limit = vi && vi.ctx ? vi.ctx : 0
      const threshold = limit ? Math.round(limit * 0.85) : 0
      return {
        tokens,
        limit,
        threshold,
        ratio: limit ? Math.min(1, tokens / limit) : 0,
        folded: Math.max(0, (session.history || []).filter((m) => m && m.internal).length)
      }
    } catch (err) { return { tokens: 0, limit: 0, threshold: 0, ratio: 0, folded: 0, error: String(err && err.message) } }
  })
  ipcMain.handle('assistant:save-role', (_e, def) => {
    try { return { ok: true, role: roles.save(def) } } catch (err) { return { ok: false, error: err.message } }
  })
  /**
   * 角色同步（形象/声音侧 → 对话侧）：只覆盖 id/name/persona/worldInfo，
   * 其余字段（params/tools/builtin）沿用磁盘上已有角色，避免把用户配置抹掉。
   * 这样「角色管理」里改的人设就是聊天时真正生效的人格，不再是两套角色。
   */
  ipcMain.handle('assistant:sync-role', (_e, def) => {
    try {
      const old = roles.get(def && def.id) || {}
      const merged = { ...old, id: def.id, name: def.name != null ? def.name : old.name, persona: def.persona != null ? def.persona : old.persona }
      if (Array.isArray(def.worldInfo)) merged.worldInfo = def.worldInfo
      // 0.18.0 第二批：角色卡上的系统提示词（追加 / 替换人设）
      if (def.systemPrompt !== undefined) merged.systemPrompt = String(def.systemPrompt || '').slice(0, 20000)
      if (def.systemReplace !== undefined) merged.systemReplace = !!def.systemReplace
      const saved = roles.save(merged)
      // 人格或提示词真的变了才重建会话缓存（避免在生成中白白丢掉上下文）
      if (old.persona !== saved.persona || old.name !== saved.name ||
        String(old.systemPrompt || '') !== String(saved.systemPrompt || '') ||
        !!old.systemReplace !== !!saved.systemReplace) sessions.delete(saved.id)
      return { ok: true, role: saved }
    } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('assistant:delete-role', (_e, id) => {
    try {
      roles.remove(id)
      sessions.delete(id)
      if (cfgMod.getConfig().currentRole === id) {
        const cfg = cfgMod.getConfig()
        cfg.currentRole = 'assistant'
        cfgMod.saveConfig()
      }
      return { ok: true }
    } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('assistant:history', () => {
    try {
      const { session } = getSession()
      // 只回给界面「能读的对话」：
      //  - tool 角色是发给模型的工具结果（JSON 字符串），界面上渲染出来是乱码般的文本
      //  - 带 toolCalls 的 assistant 消息 content 为空，渲染出来是空白气泡
      // 两者以前都被当成 AI 消息渲染 → 历史看起来像「没记录 / 记坏了」。
      return session.history
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.internal && String(m.content || '').trim())
        .map(({ role, content, sub, at }) => ({ role, content, sub: sub || '', at }))
    } catch (err) { return { error: err.message } }
  })
  ipcMain.handle('assistant:clear-history', () => {
    const { session } = getSession()
    session.clearHistory()
    return { ok: true }
  })
  ipcMain.handle('assistant:memory-list', (_e, roleId) => memory.list(roleId || cfgMod.getConfig().currentRole))
  ipcMain.handle('assistant:memory-add', (_e, roleId, text) => {
    try { return { ok: true, fact: memory.add(roleId || cfgMod.getConfig().currentRole, text) } } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('assistant:memory-remove', (_e, roleId, factId) => ({ ok: memory.remove(roleId || cfgMod.getConfig().currentRole, factId) }))
  ipcMain.handle('assistant:memory-clear', (_e, roleId) => { memory.clear(roleId || cfgMod.getConfig().currentRole); return { ok: true } })

  /* ---------------- S4：记忆工作区（PARTNER.md + Git 历史/回滚，按角色分目录） ---------------- */
  ipcMain.handle('assistant:partner-get', () => {
    try {
      const cur = cfgMod.getConfig().currentRole
      const role = roles.get(cur)
      return {
        ok: true,
        content: partner.readDoc(cur),
        dir: partner.workspaceDir(cur),
        git: partner.gitAvailable(),
        files: partner.listPartnerFiles(cur),
        history: partner.history(60, cur),
        roleName: role && role.name,
        roleEdited: !!(role && role.builtinOverride)
      }
    } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('assistant:partner-save', (_e, text) => {
    try {
      const r = partner.writeDoc(text, { message: '你编辑了 PARTNER.md', scope: cfgMod.getConfig().currentRole })
      return { ok: true, commit: r.hash ? r.hash.slice(0, 7) : null }
    } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('assistant:partner-show', (_e, hash) => {
    try { return { ok: true, content: partner.showAt(hash, cfgMod.getConfig().currentRole) } } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('assistant:partner-revert', (_e, hash) => {
    try {
      const r = partner.revertTo(hash, cfgMod.getConfig().currentRole)
      return { ok: true, content: r.content, commit: r.hash ? r.hash.slice(0, 7) : null }
    } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('assistant:provider-get', () => cfgMod.describeProvider())
  ipcMain.handle('assistant:provider-set', (_e, patch) => providerSet(patch || {}))
  // 0.18.0 第二批：系统提示词预览——把「此刻真正发给模型的那一大段」原样给界面看，
  // 让用户能确认自己的追加提示词生效了、记忆注入长什么样（只读，不落盘）。
  ipcMain.handle('assistant:preview-system', (_e, roleId) => {
    try {
      const { session, id } = getSession(roleId)
      return { ok: true, role: id, system: session.buildSystem('') }
    } catch (err) { return { ok: false, error: err.message } }
  })
  // 0.18.0 第二批：联网搜索配置（web_search 后端）。key 与地址只落本地 config.json，不上传。
  ipcMain.handle('assistant:web-get', () => {
    try {
      const w = (cfgMod.getConfig().web) || {}
      return { ok: true, web: { provider: w.provider || 'duckduckgo', searxngUrl: w.searxngUrl || '', tavilyKey: w.tavilyKey ? '***' + String(w.tavilyKey).slice(-4) : '', maxResults: w.maxResults || 5 } }
    } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('assistant:web-set', (_e, patch) => {
    try {
      const cfg = cfgMod.getConfig()
      const cur = cfg.web || {}
      const p = patch && typeof patch === 'object' ? patch : {}
      const next = { ...cur }
      if (['duckduckgo', 'bing', 'searxng', 'tavily'].includes(p.provider)) next.provider = p.provider
      if (typeof p.searxngUrl === 'string') next.searxngUrl = p.searxngUrl.trim().slice(0, 500)
      // 脱敏回传（***abcd）不覆盖真 key
      if (typeof p.tavilyKey === 'string' && !/^\*\*\*/.test(p.tavilyKey)) next.tavilyKey = p.tavilyKey.trim().slice(0, 200)
      if (p.maxResults !== undefined) next.maxResults = Math.min(Math.max(Number(p.maxResults) || 5, 1), 10)
      cfg.web = next
      cfgMod.saveConfig()
      log('[assistant] 联网搜索配置已更新 provider=' + next.provider)
      return { ok: true }
    } catch (err) { return { ok: false, error: err.message } }
  })
  // S7：厂商预设表（渲染层设置页下拉用，选中即回填 baseUrl/模型/取 Key 地址）
  ipcMain.handle('assistant:vendors', () => (vendorMod ? vendorMod.VENDORS : []))
  // 1.5/1.9：思考力度档位下发 + 用量/成本汇总（单价取当前厂商估算）
  ipcMain.handle('assistant:provider-extras', async () => {
    const p = cfgMod.getConfig().provider || {}
    const v = vendorMod ? vendorMod.vendorByBaseUrl(p.baseUrl) : null
    // 1.3：当前 provider 是 ChatGPT 账号接入时，把登录状态一并带给设置页
    let chatgpt = null
    if (p.type === 'chatgpt') {
      try { chatgpt = await require('./chatgptAuth').status() } catch {}
    }
    return {
      reasoningEffort: p.reasoningEffort || 'none',
      effortModels: vendorMod && v ? vendorMod.effortModelsOf(v.id) : [],
      vision: vendorMod && v ? v.vision.includes(String(p.model || '').trim()) : null,
      chatgpt
    }
  })
  let usageMod = null
  ipcMain.handle('assistant:usage', async (_e, opts) => {
    try {
      if (!usageMod) usageMod = await import(IMP(CORE_ROOT + 'core/usage.js'))
      const p = cfgMod.getConfig().provider || {}
      const v = vendorMod ? vendorMod.vendorByBaseUrl(p.baseUrl) : null
      const price = vendorMod && v ? vendorMod.priceOf(v.id) : null
      // 0.25.0 用量页：按「每个模型各自的单价」算钱，换过厂商/模型的历史花费才不会算错
      let modelPrices = null
      if (vendorMod && Array.isArray(vendorMod.VENDORS)) {
        modelPrices = {}
        for (const ven of vendorMod.VENDORS) {
          const pr = vendorMod.priceOf(ven.id)
          if (!pr) continue
          for (const m of (ven.models || [])) modelPrices[m] = pr
        }
      }
      const o = opts && typeof opts === 'object' ? opts : {}
      const report = usageMod.usageReport({
        from: o.from,
        to: o.to,
        granularity: o.granularity,
        groupBy: o.groupBy,
        price,
        modelPrices,
        currency: o.currency || 'CNY',
        rate: Number(o.rate) > 0 ? Number(o.rate) : 7.2
      })
      return { ok: true, ...usageMod.usageSummary({ days: 7, price }), model: p.model, report }
    } catch (e) { return { ok: false, error: e.message } }
  })
  // 7.8：开机自启（登录时启动；用户级，不写注册表 Run 之外的东西）
  ipcMain.handle('assistant:autostart-get', () => ({ enabled: app.getLoginItemSettings().openAtLogin }))
  ipcMain.handle('assistant:autostart-set', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath })
    return { enabled: app.getLoginItemSettings().openAtLogin }
  })

  /* ---------------- S6：电脑操作开关 / 风险告知（规格 4.6） ---------------- */
  ipcMain.handle('assistant:cua-state', () => {
    const s = cuaSettings()
    const perm = permSettings()
    let engine = false
    try { engine = require('../cua').isRunning() } catch {}
    return { ...s, permMode: perm.mode, engine }
  })
  ipcMain.handle('assistant:cua-set', (_e, patch) => {
    const p = patch || {}
    try {
      if (p.acks || p.enabled !== undefined) {
        const r = setCuaEnabled(p.enabled === undefined ? cuaSettings().enabled : !!p.enabled, p.acks)
        if (!r.ok) return r
      }
      if (p.permMode) {
        const mode = PERM_MODES.includes(String(p.permMode)) ? String(p.permMode) : 'ask-once'
        const store = require('../store')
        store.patchGlobal({ companion: { ...companionCfg(), permMode: mode } })
      }
      return { ok: true, ...cuaSettings(), permMode: permSettings().mode }
    } catch (err) { return { ok: false, error: err.message } }
  })
  // 排障：跑一次引擎自检（截图 + 窗口枚举 + 空闲），把结果给界面看
  ipcMain.handle('assistant:cua-selftest', async () => {
    try {
      const cua = require('../cua')
      const idle = await cua.invoke('idle', {})
      const wins = await cua.invoke('windows', {})
      return { ok: true, engine: cua.isRunning(), idleMs: idle && idle.idleMs, windows: wins && wins.count }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
  ipcMain.handle('assistant:import-creds', () => {
    try {
      const store = require('../store')
      const comp = (store.get().global || {}).companion || {}
      if (!comp.apiKey) return { ok: false, error: 'companion 配置里没有可导入的 API Key' }
      return providerSet({ apiKey: comp.apiKey, baseUrl: comp.apiBaseUrl, model: comp.apiModel })
    } catch (err) { return { ok: false, error: err.message } }
  })
}

/**
 * 工具 open_computer_panel：把聊天窗带到前台并自动展开「电脑」面板。
 * 开关本身必须用户手点（三条风险确认是安全设计，不能由模型代劳），
 * 但「找入口」这一步不该把用户卡死 —— 模型可以带路。
 */
async function openCuaPanel () {
  try {
    const w = createWindow()
    if (!w) return { ok: false, error: '聊天窗打不开' }
    // 窗口刚创建时页面还没加载，晚一点再发；已就绪时这条 send 也会正常到达
    setTimeout(() => {
      try { if (w && !w.isDestroyed()) w.webContents.send('assistant:open-cua-panel') } catch {}
    }, 500)
    return { ok: true, note: '聊天窗已带到前台并展开「电脑」面板，等用户勾选三条风险后打开开关' }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 助手聊天窗（新交互入口，区别于 legacy companion 窗） */
function createWindow () {
  if (assistantWin && !assistantWin.isDestroyed()) {
    if (!assistantWin.isVisible()) assistantWin.show()
    assistantWin.focus()
    return assistantWin
  }
  assistantWin = new BrowserWindow({
    width: 520, height: 740,
    minWidth: 420, minHeight: 560,
    frame: false,
    backgroundColor: '#14161d',
    resizable: true,
    show: false,
    title: 'Partner.execute(me);',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/assistant.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  assistantWin.loadFile(path.join(__dirname, '../../renderer/assistant/index.html'))
  assistantWin.once('ready-to-show', () => assistantWin.show())
  assistantWin.on('closed', () => { assistantWin = null })
  return assistantWin
}

/** 托盘角色子菜单数据（未就绪返回空，托盘只显示基础项） */
function trayRoles () {
  if (!ready) return []
  try {
    const cfg = cfgMod.getConfig()
    return roles.list().map((r) => ({ id: r.id, name: r.name, current: r.id === cfg.currentRole }))
  } catch { return [] }
}

/**
 * S8：给「刷B站值班轮」一个独立 provider（跟聊天同一套厂商配置，但会话完全隔离 ——
 * 值班那一轮跑在另一个「人」身上，不该往聊天气泡里冒话）。
 * core 未就绪 / 未配 key 时返回 null，duty 侧自己兜住。
 */
function getProvider () {
  try {
    if (!ready || !modelsMod || !cfgMod) return null
    const p = cfgMod.getConfig().provider
    if (!p || !p.apiKey) return null
    return modelsMod.createProvider(p)
  } catch { return null }
}

/**
 * S11：IM 接入上下文 —— 群聊/私聊大脑用的人设材料。
 * 不传 roleId 用当前桌面角色（「同一个她」），传了就用指定角色（群聊独立人设）。
 * PARTNER.md 每次现读：桌面端改完记忆，群里下一句话就生效。
 */
function getContext (roleId) {
  if (!ready || !roles) return null
  const cfg = cfgMod.getConfig()
  const id = roleId || cfg.currentRole
  const role = roles.get(id)
  if (!role) return null
  let partnerDoc = ''
  // 记忆跟角色卡走：读该角色自己的记忆工作区（群聊多角色各自独立）
  try {
    partnerDoc = partner.readDoc(id) || ''
    if (!partnerDoc) {
      // 该角色还没有自己的记忆工作区 → 惰性初始化（旧 JSON 事实也按角色各自迁；
      // 旧全局目录只允许迁给当前桌面角色，防止被群聊角色误吞）
      let legacy = []
      try { legacy = memory.list(id) } catch {}
      partner.ensureWorkspace({ roleName: role.name, legacyFacts: legacy, scope: id, migrateDir: id === cfg.currentRole })
      partnerDoc = partner.readDoc(id) || ''
    }
  } catch { }
  return {
    currentRole: cfg.currentRole,
    roleName: role.name,
    persona: role.persona || '',
    partnerDoc: String(partnerDoc)
  }
}

function listRoles () {
  if (!ready || !roles) return []
  try { return roles.list().map((r) => ({ id: r.id, name: r.name })) } catch { return [] }
}

/* ---- S10 World 扩展的三条桥（core ESM 里的工具表 / 会话提示词注入） ---- */
let sessRef = null
// 0.34.0：陪看白板（字幕 → 提示词）。companion 注册得比 init 早，所以先存着，init 时补挂。
let pendingLive = null
// 0.46.28：生活线回调同款 pending（companion 注册早于核心 init 时先存，init 后补挂）
let pendingLife = null

/** 0.34.0 陪看白板：每轮现取一段「你正在看的字幕」，空串不注入；commit 在一轮答完后推进游标 */
function setLiveContext (fn, commitFn) {
  pendingLive = [fn, commitFn]
  try { if (sessRef && sessRef.setLiveContext) sessRef.setLiveContext(fn, commitFn) } catch { }
}

/** 0.46.28 她的生活线/作息/仪式感：companion 注册「每轮现算」回调（作息/目标/天数都会变） */
function setLifeBlocks (fn) {
  pendingLife = fn
  try { if (sessRef && sessRef.setLifeBlocks) sessRef.setLifeBlocks(fn) } catch { }
}

function registerTool (def) {
  if (!tools || typeof tools.register !== 'function') throw new Error('助手核心还没就绪')
  tools.register(def)
}

function unregisterTool (name) {
  if (!tools || typeof tools.unregister !== 'function') return false
  return tools.unregister(name)
}

function setWorldPrompts (fn) {
  try { if (sessRef && sessRef.setWorldPrompts) sessRef.setWorldPrompts(fn) } catch { }
}

/** 0.45.27 追加式世界段：QQ 场合说明等用这个，不跟 world 扩展抢 setWorldPrompts 的单槽 */
function addWorldPrompts (fn) {
  try { if (sessRef && sessRef.addWorldPrompts) sessRef.addWorldPrompts(fn) } catch { }
}

/* ---- 0.18.0 M8：长期记忆账本桥（对齐参考 memory_framework，记忆从聊天自动产生） ---- */

/** 用户资料（自设：称呼/自画像/关系定位/互动偏好/需要避开）→ 会话提示词整段注入 */
function setUserProfile (text) {
  try { if (sessRef && sessRef.setUserProfileText) sessRef.setUserProfileText(text) } catch { }
}

/** 外部发言（屏幕陪伴主动搭话 / 时间观念 / 闹钟）写入当前会话历史并广播 —— 总聊天框能看到她说的话
 *  display 是字幕（subLang 翻译结果），聊天窗显示字幕、history 保留台词 + sub
 *  external:true 让桌宠 overlay 跳过气泡与朗读——那些已经由 pet_say 播过了，
 *  再走一遍 assistant:done 会变成同一句话朗读两次（双声道）。 */
function pushExternalReply (text, display) {
  const t = String(text || '').trim()
  const d = String(display || '').trim()
  if (!t || !ready) return { ok: false }
  try {
    const { session } = getSession()
    session.history.push({ role: 'assistant', content: t, ...(d ? { sub: d } : {}), at: Date.now(), via: 'proactive' })
    try { session.saveHistory() } catch { }
    bcastAll('assistant:done', { seq: Date.now(), content: d || t, display: d, raw: t, toolResults: [], external: true })
    return { ok: true }
  } catch (err) { return { ok: false, error: err && err.message } }
}

/** 0.45.26 全出口入账：任何通道她说的话/发生的往来都能写进当前会话历史——
 *  桌宠气泡对话、碎碎念旁白、自主活动收尾汇报、QQ 私聊……一个不漏。
 *  via 标记来源（qq/pet/chatter/autonomy/proactive），条目 external:true；assistant 台词可带 sub 字幕。
 *  主人的要求（10-30）：所有功能中涉及到的行为聊天都必须进记忆。
 *  0.45.27 场合可见：qq/pet 通道的条目带（QQ）/（气泡）前缀——上下文组装只发 role/content，
 *  via 字段模型看不到；不带前缀她就不知道那几条消息是 QQ 上发生的（真机实锤 22:28「QQ の中身は見えない」）。
 *  0.45.98 改成「标注只在请求里加」：以前把（QQ）写进 content，模型照抄进回复，
 *  QQ 对面直接看到「（QQ）好，六点…」。现在 content 只存台词本身，via 保留在字段里，
 *  session.messages() 组装上下文时再给 user 侧补 [QQ]/[桌面] 标注（见那边的注释）。 */
function ledgerNote ({ via, user, assistant: aText, self, sub }) {
  try {
    if (!ready) return { ok: false }
    const { session } = getSession()
    const at = Date.now()
    const v = String(via || 'ext')
    if (user) session.history.push({ role: 'user', content: String(user), at, external: true, via: v })
    if (aText) session.history.push({ role: 'assistant', content: String(aText), ...(sub ? { sub: String(sub) } : {}), at: at + 1, external: true, via: v })
    if (self) session.history.push({ role: 'assistant', content: String(self), at: at + 2, external: true, via: v }) // self 自带说明（如 reach 的「我用 QQ 发消息找他」），不加 tag
    try { session.saveHistory() } catch { }
    return { ok: true }
  } catch (err) { return { ok: false, error: err && err.message } }
}

/** 0.45.25 QQ 与本体同一本账：qqNote 现在是 ledgerNote 的 qq 通道别名 */
function qqNote (o) { return ledgerNote(Object.assign({ via: 'qq' }, o)) }

/** 本体（assistant 会话）最近 n 条纯文本往来，给 QQ 侧当上下文（剥掉工具链/图片消息） */
function historyTail (n) {
  try {
    const { session } = getSession()
    return (session.history || [])
      .filter((m) => m && !m.internal && (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.trim())
      .slice(-(Number(n) || 16))
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 300) }))
  } catch { return [] }
}

/** 聊天完成钩子：本地提取事实 + 攒轮次；每 4 个用户轮次由 LLM 整理成最近/长期记忆 */
function memoryExtract (roleId, userText, assistantText) {
  try {
    if (!ready || !memory) return []
    const id = roleId || cfgMod.getConfig().currentRole
    const added = memory.extractTurn(id, userText, assistantText)
    const prov = getProvider()
    if (prov && typeof prov.chat === 'function') {
      memory.maybeConsolidate(id, {
        complete: async (messages) => {
          const r = await prov.chat({ messages })
          return r && r.content
        }
      }).catch(() => { })
    }
    return added
  } catch { return [] }
}

function memoryFacts (roleId) {
  try { return ready && memory ? memory.list(roleId || cfgMod.getConfig().currentRole) : [] } catch { return [] }
}

/** 手动写入一条（旧角色卡记忆迁移 / 设置页添加用；核心账本自动去重） */
function memoryAddFact (roleId, text, opts) {
  try {
    if (!ready || !memory) return null
    return memory.add(roleId || cfgMod.getConfig().currentRole, text, opts || {})
  } catch { return null }
}

function memoryRemoveFact (roleId, factId) {
  try { return ready && memory ? memory.remove(roleId || cfgMod.getConfig().currentRole, factId) : false } catch { return false }
}

function memoryRemoveBySeq (roleId, seq) {
  try { return ready && memory ? memory.removeBySeq(roleId || cfgMod.getConfig().currentRole, seq) : false } catch { return false }
}

/** IM 注入用：相关长期记忆 + 最近记忆，拼成一段可直接进 system 的文本 */
function memoryRecallText (roleId, query, k = 5) {
  try {
    if (!ready || !memory) return ''
    const id = roleId || cfgMod.getConfig().currentRole
    const recent = memory.recent(id, 2)
    // 0.22.0 分级渲染（全文/大概记得/只剩个印象），被想起的顺带强化
    const hits = memory.recallForPrompt(id, query || '', k)
    const lines = []
    for (const r of recent) lines.push('- ' + r.text)
    for (const f of hits) lines.push('- ' + f.shown)
    return lines.length ? '【你记得的事（自然带入，别背出来）】\n' + lines.join('\n') : ''
  } catch { return '' }
}

/** 0.22.0 每日衰减落盘（桌宠定时器调） */
function memoryDecaySweep (roleId) {
  try {
    if (!memory) return 0
    const id = roleId || cfgMod.getConfig().currentRole
    return memory.decaySweep(id) || 0
  } catch { return 0 }
}

module.exports = { init, setAssistantWin, getSession, switchRole, createWindow, openCuaPanel, trayRoles, noteTouch, noteSelfAct, isReady: () => ready, getProvider, getContext, listRoles, registerTool, unregisterTool, setWorldPrompts, addWorldPrompts, setLiveContext, setLifeBlocks, setUserProfile, pushExternalReply, qqNote, ledgerNote, historyTail, memoryExtract, memoryAddFact, memoryFacts, memoryRemoveFact, memoryRemoveBySeq, memoryRecallText, memoryDecaySweep,
  /** 0.24.0 随身服务用：编程式发一条消息（等价 assistant:send，走同一条管线，桌面端能看到全过程） */
  send: (text, images) => handleSend(null, text, images),
  /** 角色工作区路径（自我层 self/ 建在它下面；partner 还没就绪时按同样规则自己拼，避免启动早期写到空目录） */
  workspaceDirFor: (roleId) => {
    const id = String(roleId || '')
    if (!id) return ''
    try { if (partner) return partner.workspaceDir(id) } catch { }
    try {
      const safe = id.replace(/[^\w.-]/g, '_') || 'default'
      return path.join(dataRoot || app.getPath('userData'), 'assistant', 'workspaces', safe)
    } catch { return '' }
  },
  /**
   * 0.24.0 电脑画像：印象 / 判断写进工作区后提交（记忆仓库历史只增不减）。
   * 提交失败不影响对话，只是这一段不进版本历史。
   */
  commitWorkspace: (message) => {
    try {
      if (!partner) return false
      const cur = cfgMod.getConfig().currentRole
      partner.commitAll(message || '更新电脑画像', undefined, cur)
      return true
    } catch { return false }
  },
  /**
   * 0.24.0 画像→长期记忆：把「关于他」的事实写进 PARTNER.md 的「长期事实」。
   * 做梦审查批准后由 companion 调（她不直接碰记忆仓库），写完自动提交。
   * 返回 false 表示没写（没就绪/内容为空/已经记过/写文件异常），调用方记日志即可。
   */
  rememberFact: (text) => {
    try {
      if (!partner) return false
      const t = String(text || '').trim()
      if (!t) return false
      const cur = cfgMod.getConfig().currentRole
      if (!cur) return false
      /* 做梦会一遍遍梦到同一件事，没有这道闸，「长期事实」几天后就全是重复的作息 */
      try {
        const guard = require('../factGuard')
        if (guard.hasSimilarFact(partner.readDoc(cur) || '', t)) return false
      } catch { }
      partner.remember(t, { section: 'fact', scope: cur })
      return true
    } catch (e) { log('[memory] 写长期事实失败: ' + (e && e.message)); return false }
  } }
