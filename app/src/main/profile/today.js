'use strict'
/**
 * 电脑画像 · 「今天」（0.43.0）
 *
 * 设计动机（来自真实使用反馈）：
 * 「我说的活人感是指在电脑中活着，例如我今天通过键盘打了什么字打了多少，经常跟谁聊天聊什么
 *   看视频最近喜欢看什么，她也能知道……说实话现在这个电脑画像的功能实际上就跟没有加载进
 *   本体记忆一样是独立的一样。」
 *
 * 判断：他说得对，但病灶不在采集（profile/ 那套已经采了 14 天的浏览/搜索/书签/B站/游戏/
 * 文件/程序/使用时长），而在**注入的时间尺度**。
 *
 *   profile.promptBlock() 给的是一份 14 天的静态档案，2400 字，每次聊天塞同样的东西。
 *   那是「档案」，不是「记忆」。真人不是背你两周的浏览历史，而是知道**今天**你在干嘛。
 *
 * 所以这里补一层「今天」：只取当天切片，写成 200~400 字，**具体、带时间、会过期**。
 * 它进两个地方：
 *   1. systemPrompt（聊天时能自然提起「你今天…」）
 *   2. watchSharedBlock（她主动开口时唯一的素材来源——以前那里完全没有电脑痕迹，
 *      所以她主动搭话只能说「在干嘛」，说不出「你那个 bug 弄完了吗」）
 *
 * 刻意不做的事：
 *   - 不从标题猜内容。标题写什么就是什么，猜出来的会变成她编的话。
 *
 * 0.44.0 补了键盘层（keys.js）：用户明确要求「可以记按键可以记内容，但必须本地」。
 * 这里只负责把落盘的东西**压成一句人话**并做长度裁剪——原文留在本机，
 * 进 prompt 的是片段，不是流水账。
 */

const usageMod = require('./usage')
const keysMod = require('./keys')

const CHAT = /^(wechat|weixin|qq|tim|telegram|discord|lark|feishu|dingtalk|whatsapp|line|signal|momo)$/i
const BROWSER = /^(msedge|chrome|firefox|brave|opera|vivaldi|360se|360chrome|qqbrowser|safari)$/i
const EDITOR = /^(code|code - insiders|cursor|pycharm|idea|webstorm|goland|sublime_text|notepad|notepad\+\+|typora|obsidian|winword|excel|powerpnt)$/i
const GAME = /^(steam|wegame|genshinimpact|yuanshen|starrail|league of legends|dota2|cs2)$/i

const CACHE_MS = 60 * 1000
let cache = { at: 0, text: '', key: '' }

function hhmm (ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return p(d.getHours()) + ':' + p(d.getMinutes())
}

function dur (sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  if (s < 60) return '不到 1 分钟'
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (!h) return m + ' 分钟'
  return h + ' 小时' + (m ? ' ' + m + ' 分' : '')
}

/** 把「张三 - 微信」洗成「张三」。洗不出来就丢掉（标题是「微信」说明在主界面） */
function contactOf (title) {
  let t = String(title || '').trim()
  if (!t) return ''
  t = t.replace(/\s*[-–—]\s*(微信|WeChat|QQ|TIM|Telegram|Discord|飞书|钉钉|Lark)\s*$/i, '').trim()
  t = t.replace(/^\(\d+\)\s*/, '').trim()               // 未读计数
  if (!t || /^(微信|wechat|qq|tim|telegram|discord|飞书|钉钉)$/i.test(t)) return ''
  if (t.length > 24) return ''
  return t
}

/** 浏览器标题洗一下：去掉「 - Microsoft Edge」「 - Google Chrome」这种尾巴 */
function pageOf (title) {
  return String(title || '')
    .replace(/\s*[-–—]\s*(Microsoft Edge|Google Chrome|Mozilla Firefox|Brave|Vivaldi)\s*$/i, '')
    .replace(/^\(\d+\)\s*/, '')
    .trim()
    .slice(0, 40)
}

function build (u, now, k) {
  if (!u || !u.ok) {
    // 没有使用痕迹但有键盘记录（画像刚开、usage 还没攒够 1 分钟）也算有话说
    if (!k || !k.ok) return ''
  }
  const lines = []
  const t = now || Date.now()

  const span = u && u.first && u.last ? dur((u.last - u.first) / 1000) : ''
  const start = hhmm(u && u.first)
  if (start) {
    const stillOn = u.idleSec >= 0 && u.idleSec < 300
    lines.push('今天 ' + start + ' 开始用电脑' + (span ? '，到现在一共 ' + span : '') +
      (stillOn ? '（刚刚还在动键鼠）' : ''))
  }
  if (u && u.activeSec >= 120) {
    lines.push('其中 ' + dur(u.activeSec) + '在真的操作（敲键盘/动鼠标），其余是挂着看或人不在')
  }

  const apps = (u && u.apps) || []
  const named = apps.slice(0, 4).map((a) => a.app + ' ' + dur(a.minutes * 60)).join('、')
  if (named) lines.push('主要在用：' + named)

  const chatApps = apps.filter((a) => CHAT.test(a.app))
  const contacts = []
  for (const a of chatApps) {
    for (const ti of a.titles || []) {
      const c = contactOf(ti)
      if (c && !contacts.includes(c)) contacts.push(c)
    }
  }
  if (contacts.length) {
    lines.push('聊天窗口出现过：' + contacts.slice(0, 5).join('、') + '（只知道跟谁在聊，内容不知道）')
  } else if (chatApps.length) {
    lines.push('在聊天软件里待了 ' + dur(chatApps.reduce((s, a) => s + a.minutes * 60, 0)) + '，但没看到具体是谁')
  }

  const pages = []
  for (const a of apps.filter((x) => BROWSER.test(x.app))) {
    for (const ti of a.titles || []) {
      const p = pageOf(ti)
      if (p && !pages.includes(p)) pages.push(p)
    }
  }
  if (pages.length) lines.push('浏览器里开着的：' + pages.slice(0, 5).join(' / '))

  /* 0.44.0：他真正打出来的字。放这一段的理由——「看了什么」和「写了什么」
     是他一天里最有信息量的两件事，拆开摆在一起她才有话可接。 */
  const kb = keyBlock(k)
  if (kb) lines.push(kb)

  const ed = apps.filter((a) => EDITOR.test(a.app))
  if (ed.length) {
    lines.push('对着 ' + ed.map((a) => a.app).slice(0, 2).join('、') + ' 的时间最多')
  }
  const gm = apps.filter((a) => GAME.test(a.app))
  if (gm.length) lines.push('玩了：' + gm.map((a) => a.app).join('、'))

  if (!lines.length) return ''

  /* 「多久没动」这一条单独给，因为它是她判断「人在不在」的直接依据，
     比 presence 的 5 分钟阈值更细。 */
  if (u && u.idleSec >= 300) {
    lines.push('最近 ' + Math.round(u.idleSec / 60) + ' 分钟没有键鼠动静')
  }

  return lines.join('\n')
}

/** 一万两千 → 1.2 万；860 → 860 */
function cnt (n) {
  const v = Math.max(0, Math.round(Number(n) || 0))
  if (v >= 10000) return (Math.round(v / 1000) / 10) + ' 万'
  return String(v)
}

/** 片段裁剪：换行压成空格（她读到换行会当成条目格式） */
function clip (s, n) {
  const t = String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 键盘那一块。k 形如 {ok, today:{keys,chars,apps}, snips:[{t,app,text}]}。
 * 只给 3 条片段、每条 70 字：原文在本机，进 prompt 的是样本。
 */
function keyBlock (k) {
  if (!k || !k.ok) return ''
  const out = []
  const t = k.today
  if (t && t.keys >= 30) {
    const who = (t.apps || []).slice(0, 3).map((a) => a.app).join('、')
    out.push('今天敲了大约 ' + cnt(t.keys) + ' 次键（约 ' + cnt(t.chars) + ' 个字）' + (who ? '，主要在 ' + who : ''))
  }
  const sn = (k.snips || []).filter((s) => clip(s.text, 70))
  if (sn.length) {
    out.push('最近他亲手打出来的字（原样，不是猜的）：')
    for (const s of sn.slice(-3)) out.push('  · ' + s.app + '：' + clip(s.text, 70))
  }
  return out.join('\n')
}

/**
 * 给 prompt 用的一段话。没有数据就返回空串（调用方不要硬塞）。
 * @param {string} pcDir  wsDir/pc
 * @param {number} now
 * @param {{keys?:boolean}} opts keys=true 时把键盘记录也算进来（keyLogOn 开着才传）
 */
function digest (pcDir, now, opts) {
  if (!pcDir) return ''
  const t = now || Date.now()
  const wantKeys = !!(opts && opts.keys)
  const ck = pcDir + '|' + (wantKeys ? 'k' : '')
  if (cache.text && cache.key === ck && t - cache.at < CACHE_MS) return cache.text
  let u = null
  try {
    /* usage 模块的 filePath 是 start() 时才设的。画像没开 → 采样没跑 → 这里就是空的。
       所以 digest 空 == 「她今天什么都不知道」，这个信号本身有用。 */
    u = usageMod.today()
  } catch { u = null }

  let k = null
  if (wantKeys) {
    try {
      const tot = keysMod.todayTotals()
      const r = keysMod.recent({ minutes: 40 })
      k = {
        ok: (tot && tot.ok) || (r && r.ok),
        today: tot,
        snips: (r && r.snippets) || []
      }
    } catch { k = null }
  }

  const body = build(u, t, k)
  const text = body
    ? '【今天他在电脑上做什么（只读痕迹，本机统计）】\n' + body +
      '\n（这是你今天看到的，不是他告诉你的。别报数、别说「根据记录」；一次挑一件相关的事自然带出来。' +
      '标题只说明他在哪个页面，别替他编内容。' +
      (k && k.ok ? '最后那几行是他亲手打的字，引用一两个词就够，别复述整段——被监视的感觉比不知道更糟。' : '') +
      '）'
    : ''
  cache = { at: t, text, key: ck }
  return text
}

/** 给测试用：不清缓存就没法钉住输出 */
function _clearCache () { cache = { at: 0, text: '', key: '' } }

module.exports = { digest, build, keyBlock, contactOf, pageOf, dur, cnt, clip, hhmm, _clearCache, CACHE_MS }
