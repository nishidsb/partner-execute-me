'use strict'
/**
 * S6.5 · 系统操作三工具的宿主实现（Electron 主进程侧）
 *
 * 助手核心只声明工具（core/tools/system.js），真正的动作在这里落地：
 *  - open_app   按名字启动本机程序（开始菜单 + 游戏库），如「QQ」「微信」「记事本」
 *  - launch_game 从游戏库启动游戏（Steam / Epic / 开始菜单任意来源），并自动进游戏模式
 *  - game_mode  进入 / 退出游戏模式（缩小到角落、静音、不走动、退出后原样恢复）
 *
 * 权限：三个工具都是 medium —— 由设置页「电脑操作权限」决定要不要弹确认，
 * 不再像 exec_command 那样每次都打断用户。
 */
const store = require('./store')
const gameLib = require('./gameLib')
const gameMode = require('./gameMode')
const launcher = require('./launcher')
const { log } = require('./logger')

function library () {
  const g = store.get()
  return (g.global && Array.isArray(g.global.library)) ? g.global.library : []
}

function companionCfg () {
  const g = store.get()
  return (g.global && g.global.companion) || {}
}

/** 名字里带这些词时按「游戏」处理（模型可能用 open_app 开游戏） */
function looksLikeGame (name) {
  const entry = gameLib.findByQuery(name, library())
  return !!(entry && (entry.source === 'steam' || entry.source === 'epic'))
}

/* ---------------- 电脑画像（0.24.0，只读） ---------------- */

/** 当前角色工作区（画像跟角色卡走）
 *  0.46.10 修复：原实现 require('./config')，但 src/main 下根本没有这个文件——
 *  MODULE_NOT_FOUND 被下面的 catch 吞掉后恒返回 ''，导致 pc_profile 永远「还没采到」、
 *  pc_refresh 必败「还没拿到角色工作区」（真机 2026-11-02 19:34 实锤：搜索记录数据
 *  明明就在工作区 pc/search.md，134 条）。定时采集端写的就是 companion 当前角色的
 *  工作区，这里对齐同一个源。 */
function currentWs () {
  try {
    const char = require('./companion/character').get()
    const id = char && char.id
    if (id) return require('./assistant').workspaceDirFor(id) || ''
  } catch { }
  return ''
}

function pcOn () {
  const c = companionCfg()
  return c.pcProfileOn === true
}

/** pc_profile：翻已采好的档案（不触发新采集，毫秒级） */
async function pcProfile ({ section, keyword } = {}) {
  if (!pcOn()) {
    return { ok: false, message: '电脑画像没开启（设置 → 通用 → 电脑画像 里打开），现在看不到主人的电脑使用情况' }
  }
  const profile = require('./profile')
  const ws = currentWs()
  const sec = String(section || 'profile').toLowerCase()
  let text = profile.readSection(ws, sec)
  if (!text) {
    return {
      ok: false,
      section: sec,
      message: '这一段还没采到（可能昨天才打开画像，或这一路没有数据）。可以调 pc_refresh 现采一次。'
    }
  }
  const kw = String(keyword || '').trim()
  if (kw) {
    const lines = text.split('\n').filter((l) => l.toLowerCase().includes(kw.toLowerCase()))
    text = lines.length
      ? '# 命中「' + kw + '」的记录\n' + lines.slice(0, 80).join('\n')
      : '档案里没有含「' + kw + '」的记录。'
  }
  const MAX = 6000
  const cut = text.length > MAX ? text.slice(0, MAX) + '\n…（太长已截断，用 keyword 缩小范围）' : text
  log('[profile] pc_profile section=' + sec + (kw ? ' kw=' + kw : '') + ' ' + cut.length + '字')
  return { ok: true, section: sec, chars: cut.length, text: cut }
}

/** pc_refresh：现采一次（浏览器历史 + B站 + 游戏库 + 文件 + 使用时长） */
async function pcRefresh () {
  if (!pcOn()) return { ok: false, message: '电脑画像没开启（设置 → 通用 → 电脑画像），先让主人打开' }
  const profile = require('./profile')
  const ws = currentWs()
  if (!ws) return { ok: false, message: '还没拿到角色工作区，暂时不能采集' }
  const r = await profile.runCollect({ wsDir: ws, days: 14, force: true, log })
  if (!r.ok) return { ok: false, message: r.error || '采集失败' }
  try {
    const a = require('./assistant')
    if (a && typeof a.commitWorkspace === 'function') a.commitWorkspace('重新采集电脑画像')
  } catch { }
  return {
    ok: true,
    tookMs: r.duration,
    written: r.written,
    parts: r.parts,
    message: '采完了（' + (r.duration / 1000).toFixed(1) + ' 秒）。想细看可以用 pc_profile 翻具体段落。'
  }
}

/** pc_impression：把她自己的观察写进印象档案（这是「了解」能累积的唯一入口） */
async function pcImpression ({ note, remove } = {}) {
  const profile = require('./profile')
  const ws = currentWs()
  if (!ws) return { ok: false, message: '还没拿到角色工作区，暂时记不了' }
  const r = profile.writeImpression(ws, { note, remove })
  if (!r.ok) return { ok: false, message: r.error || '写入失败' }
  const bits = []
  if (r.added) bits.push('记下了')
  if (r.removed) bits.push('抹掉了 ' + r.removed + ' 条旧的')
  if (!r.added && !r.removed) bits.push('这条已经记过了，没重复写')
  if (r.folded) bits.push('（太旧的 ' + r.folded + ' 条折叠了）')
  log('[profile] 印象更新 added=' + r.added + ' removed=' + r.removed + ' total=' + r.total)
  /* 同一条也进她的记忆账本。只写 impression.md 的话，这条观察只活在提示词里——
     每轮被硬塞进去，却永远不会被「想起」。账本有强度和召回，聊到相关话题时会自己浮上来。 */
  if (r.added && note) {
    try {
      const char = require('./companion/character').get()
      const role = char && char.id // 0.46.10：原来引用的 config 模块不存在（见 currentWs 注释）
      if (role) {
        require('./companion/memory').addEvent(role, {
          cat: 'fact', text: String(note).slice(0, 120), importance: 4, source: 'profile'
        })
      }
    } catch (e) { log('[profile] 印象进记忆账本失败: ' + (e && e.message)) }
  }
  /* 印象属于她的记忆，写进工作区就提交（历史只增不减，可回滚） */
  try {
    const a = require('./assistant')
    if (a && typeof a.commitWorkspace === 'function') a.commitWorkspace('她记下的印象：' + String(note || remove || '').slice(0, 30))
  } catch { }
  return {
    ok: true,
    added: r.added,
    removed: r.removed,
    total: r.total,
    message: bits.join('，') + '（现在一共 ' + r.total + ' 条）'
  }
}

async function openApp ({ name } = {}) {
  const q = String(name || '').trim()
  if (!q) throw new Error('name 为空：要打开哪个程序？')
  const hit = gameLib.findByQuery(q, library())
  if (!hit) {
    const sample = gameLib.candidates(library(), 12).join('、')
    throw new Error(`没在本机找到「${q}」。可用的程序有：${sample || '（开始菜单扫描失败）'}；也可以告诉我完整路径`)
  }
  // 已经在跑就切前台。旧实现直接再 launchEntry 一次：QQ/微信/Steam 这类程序第二实例
  // 只会弹「已经在运行」然后把新实例关掉，用户感受就是「她说打开了，可是什么都没发生」
  try {
    if (hit.kind === 'exe' || /\.exe$/i.test(String(hit.target || ''))) {
      await launcher.scan({ maxAge: 1500 })
      const w = launcher.findWindowForExe(hit.target)
      if (w) {
        if (w.fg) {
          log('[system] open_app ' + q + ' → 已经在跑且在前台，不再拉新实例')
          return { opened: hit.name, alreadyRunning: true, note: '已经在最前面了，没有重复打开' }
        }
        const ok = launcher.toggleByHandle(w.h)
        log('[system] open_app ' + q + ' → 已经在跑，切前台 ' + (ok ? 'ok' : '失败'))
        return {
          opened: hit.name,
          alreadyRunning: true,
          foreground: ok,
          note: ok ? '已经在运行，帮你切到前面了' : '它开着，但系统不让抢前台（点一下任务栏试试）'
        }
      }
    }
  } catch (err) { log('[system] 已运行判断失败（继续按新开处理）: ' + (err && err.message)) }
  const r = gameLib.launchEntry(hit)
  log('[system] open_app ' + q + ' → ' + hit.name + ' (' + hit.kind + ') via=' + r.via)
  // 开的是游戏 → 顺手进游戏模式（设置里可关）
  let gm = null
  const isGame = hit.source === 'steam' || hit.source === 'epic'
  if (isGame && companionCfg().gameModeAuto !== false) gm = gameMode.enter('open_app')
  return {
    opened: hit.name,
    source: hit.source || 'library',
    kind: hit.kind,
    target: hit.target,
    gameMode: gm && gm.on ? '已进入游戏模式（角色缩到角落陪你）' : undefined
  }
}

async function launchGame ({ name } = {}) {
  const q = String(name || '').trim()
  if (!q) throw new Error('name 为空：要玩哪个游戏？')
  const lib = library()
  const games = lib.filter((g) => g.source === 'steam' || g.source === 'epic' || /\.exe$/i.test(g.target || ''))
  const hit = gameLib.findByQuery(q, games.length ? games : lib)
  if (!hit) {
    // 没在库里 → 现场扫一遍 Steam/Epic（库里可能从没导入过）
    const d = gameLib.discover(true)
    const merged = [...d.steam, ...d.epic]
    const again = gameLib.findByQuery(q, merged)
    if (!again) {
      const names = merged.map((g) => g.name).slice(0, 15).join('、')
      throw new Error(`没找到游戏「${q}」。已扫描到：${names || '（Steam/Epic 库都没扫到，可能没装或装在别的用户下）'}`)
    }
    return launch(again)
  }
  return launch(hit)
}

function launch (hit) {
  const r = gameLib.launchEntry(hit)
  log('[system] launch_game ' + hit.name + ' → ' + hit.target)
  const c = companionCfg()
  let gm = null
  if (c.gameModeAuto !== false) gm = gameMode.enter('launch_game')
  return {
    launched: hit.name,
    source: hit.source || 'library',
    via: r.via,
    gameMode: gm && gm.on ? '已进入游戏模式' : (gm && gm.reason) || undefined
  }
}

async function gameModeTool ({ on, minutes } = {}) {
  // minutes：可选的「玩多久后自动退出」提示（当前实现固定 2 小时上限，这里只回显）
  const want = on == null ? null : (String(on) === 'true' || on === true || String(on) === '1')
  const r = gameMode.toggle(want, 'model')
  return { ...r, state: gameMode.state(), requestedMinutes: minutes != null ? Number(minutes) : undefined }
}

/** 「电脑操作」面板弹到面前（工具 open_computer_panel）：
 *  开关本身必须用户手点（三条风险），但入口可以由模型带路 —— 否则对方永远找不到右上角那个按钮 */
async function openComputerPanel () {
  // 延迟 require：assistant/index.js 启动时反过来依赖本模块，直接顶层 require 会循环。
  // 注意路径：两者都在 src/main/ 下，必须是 './assistant'（写成 '../assistant' 会去 src/assistant 找，直接 Cannot find module）
  const assistant = require('./assistant')
  if (typeof assistant.openCuaPanel !== 'function') throw new Error('宿主还没就绪，稍后再试')
  return await assistant.openCuaPanel()
}

/** 看看开着哪些窗口（工具 list_running） */
async function listRunning () {
  const snap = await launcher.scan()
  const win = (snap && snap.windows) || []
  if (!win.length) {
    return {
      running: [],
      note: launcher.isAlive
        ? '当前没有检测到运行中的窗口'
        : '窗口扫描还没起来（launcher 子进程没就绪），过几秒再问一次'
    }
  }
  const list = win.filter((w) => w.t).slice(0, 20).map((w) => ({
    title: String(w.t).slice(0, 80),
    process: w.pn || '',
    foreground: !!w.fg,
    minimized: !!w.min
  }))
  return {
    running: list,
    count: list.length,
    note: list.length ? undefined : '有窗口在跑，但都没有标题（都是后台/托盘程序）'
  }
}

/** 音量 / 静音（工具 set_volume）。volume 缺省 = 切换静音 */
async function setVolume ({ volume } = {}) {
  const raw = volume == null ? '' : String(volume).trim()
  if (!raw || raw.toLowerCase() === 'toggle') {
    if (!launcher.helperCmdPublic('mute')) throw new Error('静音没切成：桌面状态子进程不在（看日志里的 [launcher] 行）')
    const v = await launcher.waitVol()
    return { muted: !!v.m, volume: v.v, note: v.m ? '已静音' : '已取消静音' }
  }
  const n = Math.max(0, Math.min(100, Math.trunc(Number(raw))))
  if (!Number.isFinite(n)) throw new Error('音量要给 0-100 的数字，例如 "30"')
  if (!launcher.helperCmdPublic('vol ' + n)) throw new Error('音量没调成：桌面状态子进程不在（看日志里的 [launcher] 行）')
  const v = await launcher.waitVol()
  const real = v && v.v != null ? v.v : n
  return {
    volume: real,
    muted: !!(v && v.m),
    note: real !== n ? '系统按 2% 步进取整，实际是 ' + real : undefined
  }
}

/** 显示桌面（工具 show_desktop，等价 Win+D） */
async function showDesktop () {
  if (!launcher.helperCmdPublic('desk')) throw new Error('没能显示桌面：桌面状态子进程不在（看日志里的 [launcher] 行）')
  return { ok: true, note: '窗口已收起（再叫一次会恢复）' }
}

async function invoke (name, args = {}) {
  switch (name) {
    case 'open_app': return openApp(args)
    case 'launch_game': return launchGame(args)
    case 'game_mode': return gameModeTool(args)
    case 'open_computer_panel': return openComputerPanel(args)
    case 'list_running': return listRunning(args)
    case 'set_volume': return setVolume(args)
    case 'show_desktop': return showDesktop(args)
    case 'pc_profile': return pcProfile(args)
    case 'pc_refresh': return pcRefresh()
    case 'pc_impression': return pcImpression(args)
    default: throw new Error('未知的系统工具: ' + name)
  }
}

module.exports = { invoke, looksLikeGame }
