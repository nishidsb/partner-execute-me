'use strict'
/**
 * 自动学习模式（0.45.12）
 *
 * 用户要求：学习模式不该是开关式的，她在就应该自己发现「他在学习」并自动进入陪伴状态。
 *
 * 场景判定（保守策略，宁可漏判不可误判）：
 * - 白名单应用：编辑器/IDE、文档阅读器、笔记软件、终端 —— 连续在场 ENTER_AFTER_MIN 才算「在学习」
 * - 浏览器不算（刷视频也是浏览器），除非标题命中课程关键词（课程/lecture/mooc/教程…）
 * - 游戏进程 / 全屏游戏永远不算
 *
 * 状态机（纯函数，测试喂假时钟）：
 * - scene 连续在场 ≥ ENTER_AFTER_MIN → enter（进入静音陪学）
 * - 学习会话期间场景消失 ≥ EXIT_AFTER_MIN → exit；单场封顶 SESSION_CAP_MIN
 * - 一场结束后 COOLDOWN_MIN 内不再自动进入（防来回切换反复进出）
 * - 手动会话进行中不自动进入（active 回调由宿主给）
 */

const ENTER_AFTER_MIN = 8      // 学习场景要稳定持续这么久才自动进入
const EXIT_AFTER_MIN = 5       // 场景消失这么久才退出（离开倒水/回消息不算走）
const SESSION_CAP_MIN = 150    // 自动陪学单场封顶
const COOLDOWN_MIN = 45        // 一场结束后多久内不再自动进入

/** 学习类应用：进程名/窗口标题命中即算场景（标题在 titleRe 里单独匹配） */
const STUDY_APP_PATTERNS = [
  { re: /code|vscode|devenv|idea|pycharm|goland|webstorm|clion|rider|sublime|vim|neovim|notepad\+\+|cursor|trae|zed/i, label: '写代码' },
  { re: /acrobat|sumatra|cajviewer|zotero|mendeley|calibre|foxit/i, label: '读文献' },
  { re: /notion|obsidian|typora|onenote|幕布|语雀|wolai|flowus/i, label: '记笔记' },
  { re: /word|wps|excel|powerpoint|ppt|latex|texstudio|overleaf|winword/i, label: '写东西' },
  { re: /windowsterminal|wt\.exe|powershell|cmd\.exe|wsl|iterm|conhost|cascadia/i, label: '敲命令行' },
  { re: /anki|quizlet|anki程序/i, label: '背卡片' }
]

/** 浏览器里也可能是学习：标题命中课程关键词才算（刷视频也是浏览器，不能算）
 *  0.46.74 补公考词：11-08 实锤他上午在浏览器做题两小时，自动陪学全程没进
 * （旧词表只认「课程/网课/教程」这类上课词，做题页面标题全是「资料分析/行测/套卷」），
 * 她就一路自言自语。这些是他真实在用的备考词，命中就算学习场景。 */
const COURSE_TITLE_RE = /(coursera|mooc|学堂在线|中国大学|b站课堂|课程|网课| lecture |tutorial|教程|习题|真题|考研|备考|lec\s?\d+|第\s?\d+\s*讲|行测|申论|资料分析|数量关系|判断推理|言语理解|常识判断|套卷|模考|粉笔|公考)/i

/** 游戏/娱乐：命中就永远不算学习场景（优先级最高） */
const FUN_RE = /(game|steam|epic|minecraft|原神|genshin|崩坏|星穹|honkai|league|lol客户端|valorant|csgo|cs2|dota|ffxiv|ff14|最终幻想|哔哩哔哩|bilibili|youtube|netflix|抖音|douyin|爱奇艺|腾讯视频)/i

/**
 * 判定一个前台窗口是不是学习场景。
 * win = { pn: 进程名, title: 窗口标题 }（launcher.scan 的字段）。
 * @returns null | { label }（label 是她说得上口的场景名）
 */
function sceneOf (win) {
  const pn = String((win && win.pn) || '')
  const title = String((win && win.title) || '')
  if (!pn && !title) return null
  if (FUN_RE.test(pn) || FUN_RE.test(title)) return null
  for (const p of STUDY_APP_PATTERNS) {
    if (p.re.test(pn) || p.re.test(title)) return { label: p.label }
  }
  // 浏览器：只认标题里的课程关键词
  if (/chrome|msedge|firefox|edge|browser|chrome\.exe/i.test(pn) && COURSE_TITLE_RE.test(title)) {
    const m = title.match(COURSE_TITLE_RE)
    return { label: '网课（' + (m ? m[0].trim() : '课程') + '）' }
  }
  return null
}

/** 空状态 */
function freshState (now) {
  return { sceneSince: 0, absentSince: 0, lastEndAt: 0, active: false, label: '' }
}

/**
 * 场景状态机推进（每分钟由宿主调一次）。
 * @param {object} st 上次状态（可空）
 * @param {object} o { now, scene: null|{label}, studyActive: bool, nowMs? }
 * @returns {st, action: 'none'|'enter'|'exit', label}
 */
function tick (st, o) {
  const t = Number(o && o.now) || Date.now()
  const scene = (o && o.scene) || null
  const studyActive = !!(o && o.studyActive)
  const s = Object.assign(freshState(t), st || {})

  // 学习会话进行中：只管「该不该退场」
  if (studyActive) {
    if (!scene) {
      if (!s.absentSince) s.absentSince = t
      if (t - s.absentSince >= EXIT_AFTER_MIN * 60 * 1000) {
        return { st: Object.assign(s, { active: false, lastEndAt: t, sceneSince: 0, absentSince: 0 }), action: 'exit', label: s.label }
      }
    } else {
      s.absentSince = 0
      s.label = scene.label
      // 单场封顶
      if (s.sceneSince && t - s.sceneSince >= SESSION_CAP_MIN * 60 * 1000) {
        return { st: Object.assign(s, { active: false, lastEndAt: t, sceneSince: 0 }), action: 'exit', label: s.label }
      }
    }
    return { st: s, action: 'none', label: s.label }
  }

  // 没在学习：看是否值得自动进入
  if (!scene) { s.sceneSince = 0; return { st: s, action: 'none', label: '' } }
  // 冷却中不进入
  if (s.lastEndAt && t - s.lastEndAt < COOLDOWN_MIN * 60 * 1000) {
    return { st: s, action: 'none', label: '' }
  }
  if (!s.sceneSince || s.label !== scene.label) {
    s.sceneSince = t
    s.label = scene.label
  }
  if (t - s.sceneSince >= ENTER_AFTER_MIN * 60 * 1000) {
    return { st: Object.assign(s, { active: true, absentSince: 0 }), action: 'enter', label: scene.label }
  }
  return { st: s, action: 'none', label: s.label }
}

/** 进入后的计时锚点（enter 时宿主要把它记成本轮开始） */
function markStarted (st, now) {
  return Object.assign({}, st, { sceneSince: (now || Date.now()) })
}

module.exports = {
  ENTER_AFTER_MIN, EXIT_AFTER_MIN, SESSION_CAP_MIN, COOLDOWN_MIN,
  STUDY_APP_PATTERNS, COURSE_TITLE_RE, FUN_RE,
  sceneOf, freshState, tick, markStarted
}
