'use strict'
/**
 * 游戏模式自动进入（0.45.13）：像 studyAuto 一样「她的自觉」，不是开关。
 *
 * 主判据：前台窗口是无边框全屏（fullscreen.js 探测）+ 进程名不是浏览器/播放器
 * 等已知「全屏但不是游戏」的东西 → 进入候选；候选**持续 HOLD_MS** 才真的进
 * （短视频、临时全屏截图不触发）。
 * 辅判据：前台进程名命中已知游戏名单（gameAutoProcesses 配置，比如 ff14 窗口化玩）
 * → 直接进候选（不用等全屏），但同样要 HOLD_MS 防抖。
 *
 * 退出：全屏结束且这场是「自动进」的 → 自动退出，位置大小原样恢复。
 * 手动进的会话（托盘/她开的/launch_game）绝不自动打断。
 *
 * 0.45.73 重做（用户实锤）：**切屏不等于走了**。
 *   原来的逻辑一检测到前台不是游戏就立刻退，而打游戏的人会频繁切出去回消息、
 *   刷两分钟视频、查攻略——于是「退出→回来→重新计满 4 分钟→又退出」无限循环，
 *   每次回来位置要重新挪、弹幕层重开、开场白重念、玩了多久又从 0 开始。
 *   现在：
 *     · 离开宽限 LEAVE_GRACE_MS（默认 3 分钟，配置 gameAutoLeaveMin）内不退，
 *       计时/位置/弹幕全部保持原样；
 *     · 真退出了也不怕：同一款游戏 RESUME_WINDOW_MS（40 分钟）内再全屏 →
 *       立刻进（不用再等 HOLD），并且接着上一场的时间算（gameMode.accMs）；
 *     · 信任窗口 30 分钟 → 6 小时：同一款游戏当天第二次全屏只需 20 秒。
 *
 * 防翻车：
 *  - gameMode 总开关关着 → 永不进
 *  - 凌晨不自动进？——gameMode 静音，无妨，不设时段闸，跟手动一致
 */

const HOLD_MS = 4 * 60 * 1000
const HOLD_TRUST_MS = 20 * 1000
const TRUST_WINDOW_MS = 6 * 60 * 60 * 1000
const LEAVE_GRACE_MS = 3 * 60 * 1000
const RESUME_WINDOW_MS = 40 * 60 * 1000

/** 全屏但不是游戏的进程：浏览器（F11 全屏网页/视频）、播放器、演示、聊天、IDE */
const NOT_GAME = /^(chrome|msedge|firefox|qqbrowser|360se|360chrome|sogouexplorer|brave|opera|vivaldi|maxthon|potplayer|minimp4|vlc|mpv|wmplayer|films|tv|microsoft\.windows\.photos|powerpnt|wpp|et|qq|wechat|weixin|dingtalk|feishu|lark|code|idea|idea64|pycharm|pycharm64|devenv|sublime_text|notepad\+\+|typora|obsidian|steam|steams?webhelper|epicgameslauncher|e贴吧|xmind|snipaste|everything|listary|utools|uTools)$/i

function freshState (now) {
  return {
    cand: null,
    since: 0,
    inGame: null,
    trust: { name: '', at: 0 },
    awaySince: 0,   // 0.45.73：这一场游戏「切出去多久了」的起点（宽限用）
    last: null      // 0.45.73：上一场自动退出的记录 { name, at, minutes }
  }
}

/** 单步推进：tick(state, { now, full, pname, gameActive, gameEnteredBy, enabled, knownGames, leaveMs }) */
function tick (st, o) {
  const now = Number(o.now) || Date.now()
  const s = Object.assign(freshState(now), st || {})
  s.trust = Object.assign({ name: '', at: 0 }, s.trust || {})
  const grace = Number(o.leaveMs) > 0 ? Number(o.leaveMs) : LEAVE_GRACE_MS
  const out = { st: s, action: 'none', reason: '' }

  if (!o.enabled) {
    // 总闸关了：如果这场是我们自动进的，也退掉
    if (s.inGame && String(s.inGame.enteredBy || '').startsWith('auto:')) {
      s.inGame = null
      out.action = 'exit'
      out.reason = 'auto-exit(开关关闭)'
    }
    s.cand = null
    s.awaySince = 0
    return out
  }

  const name = String(o.pname || '').trim()
  const here = !!(o.full || isKnown(o, name)) && !(o.full && name && NOT_GAME.test(name))

  // 已在游戏模式：切出去只是「暂时不在」，宽限期内一律不退
  if (o.gameActive) {
    s.cand = null
    if (s.inGame && o.gameEnteredBy === s.inGame.enteredBy) {
      if (here) {
        if (s.awaySince) s.awaySince = 0
      } else if (!s.awaySince) {
        s.awaySince = now
        out.reason = 'away-start'   // 只上报，不动状态（宿主可留日志观察）
      } else if (now - s.awaySince >= grace) {
        s.last = { name: String(s.inGame.name || ''), at: now }
        s.inGame = null
        s.awaySince = 0
        out.action = 'exit'
        out.reason = 'auto-exit(游戏外超过 ' + Math.round(grace / 60000) + ' 分钟)'
      }
    } else {
      // 手动或其他来源进的会话：不插手，只同步记忆，等它自然结束
      s.inGame = null
      s.awaySince = 0
    }
    return out
  }

  // 没在游戏模式：先看是不是「刚走开又回来」（同一款游戏，40 分钟内）
  s.awaySince = 0
  if (!here) {
    s.cand = null
    return out
  }
  if (!name) {
    s.cand = null
    return out
  }
  if (s.last && s.last.name === name && (now - s.last.at) < RESUME_WINDOW_MS) {
    s.inGame = { name, enteredBy: 'auto:' + name }
    s.last = null
    s.cand = null
    s.trust = { name, at: now }
    out.action = 'enter'
    out.reason = s.inGame.enteredBy
    out.resume = true
    out.name = name
    out.detail = 'resume(又回到 ' + name + ')'
    return out
  }

  const trusted = s.trust.name && s.trust.name === name && (now - s.trust.at) < TRUST_WINDOW_MS
  const hold = trusted ? HOLD_TRUST_MS : HOLD_MS
  if (!s.cand || s.cand !== name) {
    s.cand = name
    s.since = now
    return out
  }
  if (now - s.since >= hold) {
    s.inGame = { name, enteredBy: 'auto:' + name }
    s.cand = null
    s.last = null
    s.trust = { name, at: now }
    out.action = 'enter'
    // reason 必须等于 inGame.enteredBy：gameMode.enter() 存的是它，
    // 退出比对靠 gameEnteredBy === inGame.enteredBy
    out.reason = s.inGame.enteredBy
    out.name = name
    out.detail = 'auto(' + (o.full ? '全屏' : '已知游戏') + ':' + name + ')'
  }
  return out
}

function isKnown (o, name) {
  const list = Array.isArray(o.knownGames) ? o.knownGames : []
  return list.some((x) => String(x || '').toLowerCase() === String(name || '').toLowerCase())
}

module.exports = {
  freshState, tick,
  HOLD_MS, HOLD_TRUST_MS, TRUST_WINDOW_MS, LEAVE_GRACE_MS, RESUME_WINDOW_MS, NOT_GAME
}
