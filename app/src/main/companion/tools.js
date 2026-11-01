'use strict'
/**
 * AI 伴侣 · 贾维斯工具集
 * 把 Ryza Assistant 已有的桌面能力暴露给模型（function calling）：
 * 看时间、列运行程序、启动卡片程序、音量、显示桌面、打开网址。
 * 设备/启动器能力复用 launcher 助手（src/main/launcher.js + resources/launcher.ps1），不新开进程。
 *
 * 注意：0.21.0 之后真正的聊天入口是 assistant:send → handleSend（assistant 核心），
 * 本文件这套工具跑在旧通道 companion:send 上，模型默认看不到；
 * 新通道的同名能力在 src/assistant/core/tools/system.js（open_app / list_running /
 * set_volume / show_desktop …），宿主实现在 src/main/systemBridge.js。
 * 两边共用同一个 launcher，别再让其中一边悄悄退回「助手未就绪」。
 */
const { log } = require('../logger')

let launcher = null // 注入 src/main/launcher.js（复用 latestApps / helper 指令）
let deps = { broadcastAll: () => {} }
let studyHooks = null // 注入 { start, stop }（companion 的学习会话；0.22.0 补丁⑧）

function init (launcherMod, broadcastAll, launchGameFn, studyHookObj) {
  launcher = launcherMod
  deps.broadcastAll = broadcastAll
  if (launchGameFn) deps.launchGame = launchGameFn
  if (studyHookObj) studyHooks = studyHookObj
}

function defs (includeVision = true, textOnly = false) {
  const list = [
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: '获取当前日期与时间',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_running',
        description: '列出当前正在运行的程序（窗口标题列表，标注前台/最小化）',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'launch_program',
        description: '启动用户桌面卡片上的程序（按名字模糊匹配），已运行则切换到它',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '程序或游戏名（支持模糊）' } },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'set_volume',
        description: '设置系统音量（0-100）或静音切换',
        parameters: {
          type: 'object',
          properties: {
            volume: { type: 'integer', description: '0-100，不传则切换静音' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'show_desktop',
        description: '显示桌面（等价 Win+D）',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'study_start',
        description: '开启学习监督：你陪主人学习，并且会不定时自己看一眼他的屏幕——' +
          '在玩游戏/看视频会生气，一直不改会彻底生气。对方说「陪我学习 / 监督我 / 我要刷行测」时调用。已在学习中则不会重复开启',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: '学习目标，例如「行测和申论」。对方说了就传，之后你一直记得' },
            minutes: { type: 'integer', description: '打算学多久（分钟），没提就不传' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'study_peek',
        description: '现在就看一眼主人的屏幕，确认他是在学习还是在玩。' +
          '只在学习监督进行中可用；主人说「你自己看啊 / 我在学啊 / 你不信就看看」时调用',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'study_stop',
        description: '结束学习模式（温柔收场）。对方说「不学了/今天到这/结束学习」时调用',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_url',
        description: '用默认浏览器打开网址',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        }
      }
    }
  ]
  if (includeVision && !textOnly) {
    list.push({
      type: 'function',
      function: {
        name: 'see_screen',
        description: '截取当前电脑屏幕画面（这是你真正的眼睛）。用户问「你看到了什么 / 看看我的桌面 / 屏幕上是什么 / 帮我看看 / 你看得到吗 / 你是不是看不到」，或任何需要确认画面内容的时候，都必须先调用本工具、看了再回答，不要凭印象说看不到',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '想从画面里确认什么（可选）' }
          }
        }
      }
    })
  }
  // 0.45.64 无视觉模型（如 deepseek-flash）给文字版「眼睛」：只能拿窗口标题，
  // 但至少是实时探测。不提供 see_screen —— 塞图片进去只会 400，让她更摸不着头脑。
  if (includeVision && textOnly) {
    list.push({
      type: 'function',
      function: {
        name: 'screen_now',
        description: '查看此刻屏幕上开着什么程序、前台窗口标题是什么（你看不到画面细节，只能拿到这些文字信息）。主人问「我在干嘛 / 我在看什么 / 屏幕上是什么」时用它',
        parameters: { type: 'object', properties: {} }
      }
    })
  }
  return list
}

async function exec (name, args) {
  switch (name) {
    case 'get_time': {
      const d = new Date()
      return '现在时间：' + d.toLocaleString('zh-CN', { hour12: false })
    }
    case 'list_running': {
      if (!launcher || !launcher.scan) return '桌面状态模块没加载成功，看日志里的 [launcher] 行'
      const snap = await launcher.scan()
      const win = (snap && snap.windows) || []
      if (!win.length) {
        return launcher.isAlive
          ? '当前没有检测到运行中的窗口'
          : '窗口扫描没起来（launcher 子进程没就绪），过几秒再问我'
      }
      const lines = win.filter((w) => w.t).slice(0, 18)
        .map((w) => `${w.fg ? '[前台] ' : ''}${w.t}${w.pn ? '（' + w.pn + '）' : ''}${w.min ? '（最小化）' : ''}`)
      return lines.length ? lines.join('\n') : '有窗口在跑，但都没标题（可能都是后台/托盘程序）'
    }
    case 'launch_program': {
      if (!launcher) return '桌面状态模块没加载成功，看日志里的 [launcher] 行'
      const q = String(args.name || '').trim()
      if (!q) return '要开哪个程序？'
      const card = launcher.findCard(q)
      if (!card) {
        const names = launcher.cards().map((x) => x.name).filter(Boolean).slice(0, 12)
        return '桌面卡片里没有「' + q + '」。已有的：' + (names.length ? names.join('、') : '（一张都没有）')
      }
      // 已经在跑就先切过去；注意已经在前台时**绝不能**再 toggle（worker 会把它最小化）
      const snap = await launcher.scan({ maxAge: 800 })
      const a = (snap && snap.apps && snap.apps[card.id]) || null
      if (a && a.h) {
        if (a.fg) return '「' + card.name + '」已经在前台了'
        const ok = launcher.toggleByHandle(a.h)
        return ok
          ? '「' + card.name + '」已经在运行，切到前台了'
          : '「' + card.name + '」在运行，但没能抢到前台（系统拦了焦点切换）'
      }
      // 旧实现在这里什么也不做却回「正在启动」＝假装成功；现在如实回报
      const r = launcher.launchCard(card.id)
      if (!r.ok) return '没能启动「' + card.name + '」：' + r.msg
      log('[tools] launch_program 已发起启动: ' + card.name + ' → ' + JSON.stringify(r.result))
      return '已经在打开「' + card.name + '」了'
    }
    case 'set_volume': {
      if (!launcher || !launcher.helperCmdPublic) return '桌面状态模块没加载成功，看日志里的 [launcher] 行'
      if (args.volume == null) {
        if (!launcher.helperCmdPublic('mute')) return '静音没切成（launcher 子进程不在）'
        const v = await launcher.waitVol()
        if (v.m) return '已静音'
        return v.v != null ? '已取消静音（当前音量 ' + v.v + '）' : '已取消静音'
      }
      const n = Math.max(0, Math.min(100, Math.trunc(Number(args.volume) || 0)))
      if (!launcher.helperCmdPublic('vol ' + n)) return '音量没调成（launcher 子进程不在）'
      const v = await launcher.waitVol()
      if (v && v.v != null) return '音量已设为 ' + v.v
      return '音量已设为 ' + n
    }
    case 'show_desktop': {
      if (!launcher || !launcher.helperCmdPublic) return '桌面状态模块没加载成功，看日志里的 [launcher] 行'
      return launcher.helperCmdPublic('desk') ? '已显示桌面' : '没能显示桌面（launcher 子进程不在）'
    }
    case 'study_start': {
      if (!studyHooks) return '学习模式未就绪'
      const r = await studyHooks.start({ goal: args.goal, targetMin: args.minutes })
      if (!r.ok) {
        if (r.reason === 'off') return '学习模式开关还没打开（设置 → 学习模式）'
        if (r.reason === 'no-api') return '还没配置 AI 服务，开不了学习模式'
        if (r.reason === 'already') return '已经在陪主人学习了（第 ' + (r.state.round || 1) + ' 轮）'
        return '没能开启学习模式'
      }
      return '学习监督已开启。你接下来会不定时自己看一眼他的屏幕（**主屏和副屏都会看**，' +
        '别只盯着主屏）：在学就安静陪着，在玩会先说一句小生气，一直不改会彻底生气' +
        (args.goal ? '（目标已记下：' + String(args.goal) + '）' : '（他没说具体学什么，开场可以问一句）') +
        '\n这场学习的一切都会记账并且记住：抽查看到什么、被抓几次、补了多少时间——' +
        '以后他问「我今天学了多久」你要答得出真数字，不许含糊。'
    }
    case 'study_peek': {
      if (!studyHooks || typeof studyHooks.peek !== 'function') return '学习监督未就绪'
      const r = await studyHooks.peek('主人让我看')
      if (!r) return '这一眼没看清（截屏失败或判定不出来）——别编，就说没看清'
      const seen = ({ study: '他在学', fun: '他在玩', unsure: '看不清他在干嘛', away: '他不在电脑前（黑屏/锁屏）', idle: '他没在学，也不是在玩' })[r.verdict] || '看不清'
      return '你看到了：' + seen + '。你现在的情绪等级：' + (r.level || '未知') +
        '（这次' + (r.kind ? '已经说了一句' : '没说话') + '）'
    }
    case 'study_stop': {
      if (!studyHooks) return '学习模式未就绪'
      const r = await studyHooks.stop()
      if (!r.ok) return '现在没有进行中的学习会话'
      return '已结束学习模式，记得温柔收场'
    }
    case 'open_url': {
      const u = String(args.url || '')
      if (!/^https?:\/\//.test(u)) return '网址格式不对'
      require('electron').shell.openExternal(u)
      return '已打开 ' + u
    }
    case 'screen_now': {
      // 文字版眼睛：前台程序 + 当前开着的窗口标题（实时探测，不是记忆）
      try {
        const snap = await require('../launcher').scan({ maxAge: 4000 })
        const list = (snap && snap.windows) || []
        const fg = list.find((w) => w && w.fg)
        const name = (w) => String((w && w.pn) || '').replace(/\.exe$/i, '')
        const top = list.filter((w) => w && w.t).slice(0, 10)
          .map((w) => '· ' + String(w.t).slice(0, 80) + (name(w) ? '（' + name(w) + '）' : ''))
        return '前台：' + (fg ? String(fg.t || '(无标题)') + '（' + name(fg) + '）' : '探测不到（可能被全屏独占或权限限制）') +
          (top.length ? '\n开着的窗口：\n' + top.join('\n') : '') +
          '\n（只有这些文字信息，画面细节你看不到，别补。）'
      } catch (err) {
        return '探测失败：' + (err && err.message)
      }
    }
    case 'see_screen': {
      // 返回对象（含图）由 llm.js 组装成多模态 tool 消息。
      // 0.45.69 起截**全部**显示器并拼成一张（以前只截主屏，副屏上的视频/游戏等于隐身）
      try {
        const screens = require('./screens')
        const cap = await screens.captureAll({ quality: 82 })
        log('[companion] see_screen 截屏', cap.jpeg.length, 'bytes｜' + screens.describe(cap))
        return {
          text: '已截取屏幕（图片如下）｜' + screens.describe(cap),
          image: 'data:image/jpeg;base64,' + cap.jpeg.toString('base64')
        }
      } catch (err) {
        return '截屏失败：' + (err && err.message)
      }
    }
    default:
      return '未知工具'
  }
}

/**
 * 0.45.64 被动看屏：对话链路在每轮开始前自动截一张，作为多模态输入喂给模型。
 *
 * 为什么需要：see_screen 是「主动工具」，日志实测调用 0 次——她从来不看，对屏幕的
 * 一切描述都是拿窗口标题和历史记录编的，于是「记忆里的屏幕画面」永远停在很早以前，
 * 前后对话也自相矛盾。这跟提示词写得多强硬无关，工具不被调用就是没数据。
 *
 * @param {object} opts { maxAgeMs } 距上次截图小于该值就返回 null（省钱：密集对话不重复截）
 * @returns {Promise<{url:string, at:number}|null>} 失败一律 null，绝不抛
 */
let lastShotAt = 0
async function autoShot ({ maxAgeMs = 90000 } = {}) {
  const now = Date.now()
  if (lastShotAt && now - lastShotAt < maxAgeMs) return null
  try {
    const r = await exec('see_screen', {})
    if (!r || typeof r !== 'object' || !r.image) return null
    lastShotAt = now
    const raw = String(r.image)
    return { url: /^data:image\//.test(raw) ? raw : 'data:image/jpeg;base64,' + raw, at: now }
  } catch { return null }
}

module.exports = { init, defs, exec, autoShot }
