'use strict'
/**
 * 她自己用电脑（autonomy，0.43.0）
 *
 * 设计动机（来自真实使用反馈）：
 * 「主人离开电脑时，希望角色能在空闲几分钟后面自己去看想看的
 *   做想做的，而不是打开之后停在那里，既不继续操作也不关闭，
 *   这些可以做个开关留下记录即可。」
 *
 * ── 这一版只做一件事：她去「看」点什么，并且**把这件事做完** ──────────
 * 三步：打开 → 翻两下 → 关掉。中间用「页面标题变了」证明她真的翻动了，
 * 而不是打开一个标签页摆在那里。
 *
 * ── 为什么不做「自由发挥」（点按钮、打字、发消息）────────────────────
 * 她的点击和打字是**真的**（cua 走 Win32 SendInput），误点一次删除/付款/发送
 * 就没有撤销。所以本模块的写死边界：
 *   · 只 openExternal 打开白名单域名，不点击页面里的任何元素
 *   · 不用 type，不往任何输入框写字
 *   · 不碰聊天软件、文件管理器
 *   · 收尾只按 Ctrl+W，而且**必须先确认前台是浏览器**——否则绝不按键
 *     （前台不是浏览器时按 Ctrl+W 可能关掉主人正在写的文档）
 *
 * ── 谁会触发 ────────────────────────────────────────────────────
 *   开关开（autonomyOn）+ 主进程空闲 ≥ 5 分钟 + 没有正在进行的对话 +
 *   距上次活动 ≥ 冷却（45~120 分钟，重尾，跟开口节奏器同一套理由）
 *
 * ── 产物 ────────────────────────────────────────────────────────
 *   一段「我一个人去看了什么」的文字，交给调用方写进她的日记/内心。
 *   不是「打开了什么 URL」——那没有意义。
 */

const COOLDOWN_MIN = 45
const COOLDOWN_MAX = 120
const IDLE_TRIGGER_MS = 5 * 60 * 1000    // 默认 5 分钟（0.45.2 起可在设置里调）
const FIRST_DELAY_MS = 10 * 60 * 1000    // 开关刚打开时的第一次（别让人等一小时以为坏了）

/** 空闲阈值（毫秒）：cfg.autonomyIdleMin 分钟，1~120，默认 5。
 *  用户 2026-10-30 要求做成可调——有人想让她半小时不动才动，有人想 2 分钟就来。 */
function idleMsOf (c) {
  const min = Math.min(120, Math.max(1, Math.round(Number(c && c.autonomyIdleMin) || 5)))
  return min * 60 * 1000
}
const TICK_MS = 30 * 1000
const LOAD_WAIT_MS = 5000
const SCROLL_TIMES = 2
const SCROLL_WAIT_MS = 1800
const MAX_SCRIPT_MS = 6 * 60 * 1000       // 默认每场上限；0.45.14 起可被 cfg.autonomyMaxMin 覆盖
/** 0.45.14 每场上限可调（分钟，1~30）：cfg.autonomyMaxMin */
function maxScriptMsOf (cfg) {
  /* 0.45.16：时长上限只是防失控的保险，不再是收尾依据——默认放宽到 20 分钟 */
  const m = Number(cfg && cfg.autonomyMaxMin)
  return Math.min(60, Math.max(1, isFinite(m) && m > 0 ? m : 20)) * 60 * 1000
}
const MAX_SPACE_FILE = 200 * 1024        // 地盘里单文件读写上限（防一次读爆/写爆）
const JOURNAL_MAX = 512 * 1024           // 操作日志上限，满了滚动一份
const JOURNAL_KEEP = 60 * 60 * 24 * 30 * 1000  // 日志留 30 天

/**
 * 0.45.0 三挡位（用户 2026-10-30 拍板，参照「仅可查看 / 工作区内修改 / 完全权限」）：
 *   1 只看看   —— 原样：白名单站点，只滚动，不点不打字
 *   2 我的地盘 —— 挡 1 + 在用户指定的目录里随意读写（fs 直改，不走 GUI），逐条留操作日志
 *   3 完全开放 —— 真的「她在用这台电脑」：屏幕+键鼠全套 cua 工具交给模型自己决定，
 *                 多看少动写进提示词，键鼠操作由 cua 引擎的用户让位机制兜底
 * 任何挡位都不变的三条硬底线：主人回来就停 / 正在对话不动 / 每一步进日志
 */

/** 只在这几个站点上活动。加站点等于加风险，想清楚再加。 */
const SITES = [
  { key: 'bili', host: 'bilibili.com', search: (q) => 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(q) },
  { key: 'zhihu', host: 'zhihu.com', search: (q) => 'https://www.zhihu.com/search?type=content&q=' + encodeURIComponent(q) },
  { key: 'wiki', host: 'zh.wikipedia.org', search: (q) => 'https://zh.wikipedia.org/wiki/Special:Search?search=' + encodeURIComponent(q) }
]

const BROWSER_PN = /^(msedge|chrome|firefox|brave|opera|vivaldi|360se|360chrome|qqbrowser|safari)$/i

const fs = require('node:fs')
const path = require('node:path')
const needs = require('./needs')   // 0.45.18 需求系统：压力驱动行为
const dayflow = require('./dayflow') // 0.45.19 连续时间体验：时间感
const projectsMod = require('./projects') // 0.45.19 跨天项目（re-export 用）
const { sanitizeSearchUrl } = require('./searchq') // 0.45.33 搜索词活人化（# 标题事故）

/* ------------------------------------------------------------ 挡 2：她的地盘 */

/** 路径守卫：解析后必须还在 dir 里面（符号链接/.. 都逃不出去）。
 *  返回绝对路径；越界返回 null。这是挡 2 唯一的安全闸，必须先于一切 fs 调用。 */
function spaceGuard (dir, p) {
  const base = String(dir || '')
  if (!base) return null
  const rel = String(p || '')
  if (!rel || rel.includes('\0')) return null
  const abs = path.resolve(base, rel)
  const norm = path.resolve(base) + path.sep
  if (abs !== path.resolve(base) && !abs.startsWith(norm)) return null
  return abs
}

/** 操作日志：挡 2 的每个 fs 动作、挡 3 的每次键鼠，全进这一份（她干了什么，一眼可查） */
function appendJournal (wsDir, entry) {
  try {
    if (!wsDir) return false
    const dir = path.join(wsDir, 'pc', 'autonomy')
    try { fs.mkdirSync(dir, { recursive: true }) } catch { }
    const file = path.join(dir, 'journal.jsonl')
    try {
      const st = fs.statSync(file)
      if (st.size > JOURNAL_MAX) {
        try { fs.renameSync(file, path.join(dir, 'journal.old.jsonl')) } catch { }
      }
    } catch { /* 还没有文件 */ }
    const row = Object.assign({ t: Date.now() }, entry || {})
    fs.appendFileSync(file, JSON.stringify(row) + '\n')
    return true
  } catch { return false }
}

/** 0.45.47 最近搜过的词：从操作日志抽最近 24h 的搜索 URL 里的 q。
 *  真机实锤（2026-10-31 journal）：同一个话题「搜索记录 是什么」一天连搜 7 场——
 *  话题池来自主人搜索记录（autonomyPool），她每场都挑同一条、又从没记下查到了什么。 */
function recentQueriesOf (wsDir, nowMs) {
  const out = []
  try {
    if (!wsDir) return out
    const file = path.join(wsDir, 'pc', 'autonomy', 'journal.jsonl')
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-300)
    for (const l of lines) {
      let e; try { e = JSON.parse(l) } catch { continue }
      if (!e || e.kind !== 'open' || (nowMs - (e.t || 0)) > 24 * 60 * 60 * 1000) continue
      let q = ''
      try { q = new URL(String(e.detail)).searchParams.get('q') || '' } catch { }
      if (q) out.push(q)
    }
  } catch { }
  return [...new Set(out)].slice(-8)
}

/** 0.45.47 残留窗口记录：她被主人回来打断时来不及收拾，开出来的浏览器窗就这么
 *  冻在屏幕上（用户实锤观感：「时不时弹出这个然后又不动」）。主人回来后绝不能动
 *  键鼠——所以记下句柄，下一场开场（主人已离开 ≥ 阈值）再安全地关掉。 */
function leftoversPath (wsDir) {
  return wsDir ? path.join(wsDir, 'pc', 'autonomy', 'leftovers.json') : ''
}
function readLeftovers (wsDir) {
  try {
    const raw = fs.readFileSync(leftoversPath(wsDir), 'utf8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => Number.isFinite(x)) : []
  } catch { return [] }
}
function writeLeftovers (wsDir, hwnds) {
  try {
    const p = leftoversPath(wsDir)
    if (!p) return
    try { fs.mkdirSync(path.dirname(p), { recursive: true }) } catch { }
    fs.writeFileSync(p, JSON.stringify([...(hwnds || [])]))
  } catch { }
}

/** 挡 2 工具表：fs 直改，全部过 spaceGuard，全部进日志。
 *  刻意不走 GUI 文件管理器（点错位置不可逆且无法审计），fs + 路径守卫是能审计的「随意」。 */
function spaceToolsOf (dir, opts) {
  const o = opts || {}
  const journal = o.journal || (() => { })
  const userBack = o.userBack || (() => false)
  const onUserBack = o.onUserBack || (() => { })
  let stopped = false

  /** 每个工具调用的公共前置：主人回来了就别再动她的地盘 */
  function gate (name) {
    if (stopped) return '已停止：主人回来了'
    if (userBack()) {
      stopped = true
      try { onUserBack() } catch { }
      journal({ level: 2, kind: 'stop', detail: '主人回来，停止地盘活动' })
      return '已停止：主人回来了'
    }
    if (!dir) return '没有指定地盘目录'
    return null
  }

  function L (kind, rel, extra) {
    journal(Object.assign({ level: 2, kind, detail: String(rel || '') }, extra || {}))
  }

  const defs = [
    {
      name: 'space_list',
      desc: '列出你地盘里的文件（sub 传子目录名，不传列根目录）。返回名字+大小+修改时间。',
      params: { type: 'object', properties: { sub: { type: 'string', description: '子目录，可空' } } },
      run: (a) => {
        const g = gate(); if (g) return g
        const abs = spaceGuard(dir, a.sub || '.')
        if (!abs) return '路径越界'
        let rows
        try { rows = fs.readdirSync(abs, { withFileTypes: true }) } catch { return '目录不存在' }
        const out = rows.slice(0, 100).map((r) => {
          let extra = r.isDirectory() ? '/' : ''
          if (r.isFile()) {
            try {
              const st = fs.statSync(path.join(abs, r.name))
              extra = ' ' + Math.max(1, Math.round(st.size / 1024)) + 'KB'
            } catch { }
          }
          return r.name + extra
        })
        L('list', a.sub || '.')
        return out.length ? out.join('\n') : '（空的）'
      }
    },
    {
      name: 'space_read',
      desc: '读你地盘里的一个文本文件（最多 200KB，超长截断）。',
      params: { type: 'object', properties: { path: { type: 'string', description: '相对地盘的路径' } }, required: ['path'] },
      run: (a) => {
        const g = gate(); if (g) return g
        const abs = spaceGuard(dir, a.path)
        if (!abs) return '路径越界'
        let buf
        try { buf = fs.readFileSync(abs) } catch { return '读不到这个文件' }
        L('read', a.path, { bytes: buf.length })
        return buf.subarray(0, MAX_SPACE_FILE).toString('utf8')
      }
    },
    {
      name: 'space_write',
      desc: '在你的地盘里新建或整体覆盖一个文本文件（会创建缺失的子目录）。',
      params: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      },
      run: (a) => {
        const g = gate(); if (g) return g
        const abs = spaceGuard(dir, a.path)
        if (!abs) return '路径越界'
        const body = String(a.content == null ? '' : a.content)
        if (Buffer.byteLength(body, 'utf8') > MAX_SPACE_FILE) return '内容太大（上限 200KB），分几次写'
        try { fs.mkdirSync(path.dirname(abs), { recursive: true }) } catch { }
        try { fs.writeFileSync(abs, body, 'utf8') } catch (e) { return '写失败: ' + e.message }
        L('write', a.path, { bytes: Buffer.byteLength(body, 'utf8') })
        return '已写入'
      }
    },
    {
      name: 'space_append',
      desc: '往你地盘里的一个文本文件末尾追加内容（文件不存在会新建）。',
      params: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      },
      run: (a) => {
        const g = gate(); if (g) return g
        const abs = spaceGuard(dir, a.path)
        if (!abs) return '路径越界'
        const body = String(a.content == null ? '' : a.content)
        if (Buffer.byteLength(body, 'utf8') > MAX_SPACE_FILE) return '内容太大'
        try { fs.mkdirSync(path.dirname(abs), { recursive: true }) } catch { }
        try { fs.appendFileSync(abs, body, 'utf8') } catch (e) { return '写失败: ' + e.message }
        L('append', a.path, { bytes: Buffer.byteLength(body, 'utf8') })
        return '已追加'
      }
    },
    {
      name: 'space_delete',
      desc: '删除你地盘里的一个文件。目录删不动（只能删文件），地盘外永远删不动。',
      params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: (a) => {
        const g = gate(); if (g) return g
        const abs = spaceGuard(dir, a.path)
        if (!abs) return '路径越界'
        let st
        try { st = fs.statSync(abs) } catch { return '文件不存在' }
        if (!st.isFile()) return '只允许删文件，目录不动'
        try { fs.unlinkSync(abs) } catch (e) { return '删失败: ' + e.message }
        L('delete', a.path, { bytes: st.size })
        return '已删除'
      }
    },
    {
      name: 'space_move',
      desc: '在你地盘内部移动/重命名一个文件（不能跨出地盘）。',
      params: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to']
      },
      run: (a) => {
        const g = gate(); if (g) return g
        const from = spaceGuard(dir, a.from)
        const to = spaceGuard(dir, a.to)
        if (!from || !to) return '路径越界'
        if (from === to) return '原地不动'
        try { fs.mkdirSync(path.dirname(to), { recursive: true }) } catch { }
        try { fs.renameSync(from, to) } catch (e) { return '移动失败: ' + e.message }
        L('move', a.from + ' → ' + a.to)
        return '已移动'
      }
    },
    {
      name: 'open_url',
      desc: '在浏览器打开一个网页（只允许 B站/知乎/中文维基的搜索或页面）。搜索词像活人那样用几个自然关键词。',
      params: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      run: (a) => {
        const g = gate(); if (g) return g
        const s = sanitizeSearchUrl(String(a.url || ''))
        if (!s.pass) return s.why
        const url = String(s.url || '')
        if (!/^https:\/\/[^/]*(bilibili\.com|zhihu\.com|wikipedia\.org)\//.test(url)) return '这个站点不在允许列表里'
        if (typeof o.openUrl === 'function') { try { o.openUrl(url) } catch { return '打开失败' } }
        L('open', url)
        return '已在浏览器打开' + (s.changed ? '（搜索词已按活人习惯清洗：' + s.q + '）' : '')
      }
    }
  ]
  return {
    defs: defs.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.desc, parameters: t.params }
    })),
    exec: async (name, args) => {
      const t = defs.find((x) => x.name === name)
      if (!t) return '没有这个工具'
      return String(t.run(args || {}))
    },
    stopped: () => stopped
  }
}

/**
 * 挡 2 跑一场：她一个人在自己的地盘里待一会儿（可能翻点东西、可能写点什么）。
 * 用 llm.chatStream 的工具循环（最多 4 轮），主人回来 → 中止。
 * @returns {Promise<{ok:boolean, why?:string, content?:string, rounds?:number}>}
 */
async function runSpace (o) {
  const opt = o || {}
  const log = opt.log || (() => { })
  const wait = opt.sleep || sleep
  const llm = opt.llm
  const cfg = opt.llmCfg || {}
  const dir = String(opt.dir || '')
  const userBack = opt.userBack || (() => false)
  const journal = opt.journal || (() => { })
  const openUrl = opt.openUrl
  const topic = String(opt.topic || '').trim()
  if (!llm || typeof llm.chatStream !== 'function') return { ok: false, why: 'no-llm' }
  if (!dir) return { ok: false, why: 'no-dir' }

  // 前置盘点：把地盘现状塞进第一句话，省一轮 list
  let inventory = '（还是空的，你可以从零开始写点什么）'
  try {
    const rows = fs.readdirSync(dir).slice(0, 20)
    if (rows.length) inventory = rows.join('、')
  } catch { }

  const space = spaceToolsOf(dir, {
    journal, userBack, openUrl,
    onUserBack: () => { try { opt.signal && opt.signal.abort() } catch { } }
  })

  const tasteBlock = tasteBlockOf(opt.tastes)   // 0.45.17 记忆改变行为
  const goalBlock = String(opt.goalBlock || '')   // 0.45.18 需求驱动：动机语气
  const projBlock = String(opt.projBlock || '')   // 0.45.19 跨天项目：推进进行中的事
  const phaseBlock = dayflow.phaseBlockOf(opt.now)  // 0.45.19 时间感
  const sys = [
    '主人离开了（键盘鼠标好几分钟没动），接下来几分钟是你自己的时间。',
    '你在磁盘上有一块「自己的地盘」：' + dir,
    '地盘里的东西全归你：可以写笔记、记账、整理以前存的东西、写点想写的话。只许动地盘里面的，外面的一个字节都不碰——工具已经做了硬限制，试了也会被拦。',
    topic ? '你今天感兴趣的话题：「' + topic + '」。可以去搜搜看（open_url），把值得留的记进你的笔记。搜索时像活人那样：几个自然关键词，别把文档标题、# 号、引号原样搬进搜索框。' : '',
    ...(tasteBlock ? [tasteBlock] : []),
    ...(goalBlock ? [goalBlock] : []),
    ...(projBlock ? [projBlock] : []),
    ...(phaseBlock ? [phaseBlock] : []),
    '用工具做事，别只是想。做完之后，用一两句话、第一人称、口语说说你刚才干了什么（不用跟主人打招呼，他不在）。',
    '小气一点：两三个工具调用能做完就做完，别把时间花在翻来覆去列目录上。'
  ].filter(Boolean).join('\n')

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  journal({ level: 2, kind: 'session-start', detail: dir })
  const t0 = Date.now()
  let content = ''
  try {
    const r = await llm.chatStream({
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      temperature: 0.9,
      signal: ctrl ? ctrl.signal : undefined,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: '你的地盘现在有：' + inventory + '。开始吧。' }
      ],
      tools: space.defs,
      toolExec: async (name, args) => {
        if (Date.now() - t0 > maxScriptMsOf(cfg)) { try { ctrl && ctrl.abort() } catch { }; return '安全时间上限到了，立刻收尾。' }
        if (Date.now() - t0 > maxScriptMsOf(cfg) * 0.85) return '快到安全时间上限了——把手头这步做完就收尾，不要再开始新的事情。'
        const r2 = await space.exec(name, args)
        return r2
      }
    })
    content = String((r && r.content) || '').trim()
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (/abort/i.test(msg) || space.stopped()) {
      journal({ level: 2, kind: 'session-end', detail: '主人回来，中断' })
      return { ok: false, why: 'user-back' }
    }
    log('[autonomy] 地盘活动失败: ' + msg.slice(0, 120))
    journal({ level: 2, kind: 'session-end', detail: '出错 ' + msg.slice(0, 80) })
    return { ok: false, why: 'llm-error' }
  }
  journal({ level: 2, kind: 'session-end', detail: '正常结束' })
  // 中止信号可能被流吞掉（fetch 已完成才让位）：循环停了就不算一场完整的活动
  if (space.stopped()) {
    journal({ level: 2, kind: 'session-end', detail: '主人回来，中断' })
    return { ok: false, why: 'user-back' }
  }
  // 别让主人回来第一眼撞上还在写的文件句柄——没这个风险，等一下纯粹是节奏
  await wait(200)
  return { ok: true, why: 'done', content: content.slice(0, 400), rounds: 0 }
}

/* ------------------------------------------------------------ 挡 3：完全开放 */

/** 挡 3 工具表：cua 全套（除 wechat_send——她永远不该替主人发消息）+ 任意网页。
 *  schema 从 assistant/core/tools/cua.js 抄过来（那边是 ESM registry，这里自持一份
 *  免得 CJS 里动态 import 测试跑不稳）；参数语义两边保持一致。 */
const CUA_FREE_TOOLS = ['screenshot', 'zoom', 'read_text', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'windows', 'focus', 'wait']

const XY_P = {
  x: { type: 'number', description: '横坐标：最近一张截图里的像素 x（左上角为 0）' },
  y: { type: 'number', description: '纵坐标：最近一张截图里的像素 y（左上角为 0）' }
}

const FREE_TOOL_PARAMS = {
  screenshot: {
    type: 'object',
    properties: { all: { type: 'string', description: '"true" 时合成所有屏幕；默认只截当前屏' } },
    required: []
  },
  zoom: {
    type: 'object',
    properties: { ...XY_P, w: { type: 'number' }, h: { type: 'number' } },
    required: ['x', 'y']
  },
  read_text: {
    type: 'object',
    properties: {},
    description: '识别当前屏幕上的文字（OCR）。截图看不清网页正文/聊天内容时用它。',
    required: []
  },
  click: {
    type: 'object',
    properties: {
      ...XY_P,
      button: { type: 'string', description: 'left / right / middle，默认 left' },
      count: { type: 'number', description: '1 或 2（双击），默认 1' },
      label: { type: 'string', description: '你要点的东西是什么（进操作日志）' }
    },
    required: ['x', 'y']
  },
  move: { type: 'object', properties: { ...XY_P }, required: ['x', 'y'] },
  drag: {
    type: 'object',
    properties: { ...XY_P, toX: { type: 'number' }, toY: { type: 'number' }, durationMs: { type: 'number' } },
    required: ['x', 'y', 'toX', 'toY']
  },
  scroll: {
    type: 'object',
    properties: { dy: { type: 'number', description: '正=向下，负=向上，一格约 120' }, dx: { type: 'number' }, ...XY_P },
    required: ['dy']
  },
  type: {
    type: 'object',
    properties: { text: { type: 'string', description: '要输入的文本' } },
    required: ['text']
  },
  key: {
    type: 'object',
    properties: { keys: { type: 'string', description: '组合键，如 ctrl+s、alt+tab、enter' } },
    required: ['keys']
  },
  windows: {
    type: 'object',
    properties: { includeMinimized: { type: 'string', description: '"true" 连最小化窗口一起列' } },
    required: []
  },
  focus: {
    type: 'object',
    properties: { title: { type: 'string', description: '窗口标题的一部分' }, hwnd: { type: 'number' } },
    required: []
  },
  wait: {
    type: 'object',
    properties: { ms: { type: 'number', description: '等待毫秒，最大 10000' } },
    required: []
  }
}

function freeToolsOf (o) {
  const cua = o.cua
  const journal = o.journal || (() => { })
  const userBack = o.userBack || (() => false)
  const onUserBack = o.onUserBack || (() => { })
  let stopped = false

  function gate (name) {
    if (stopped) return '已停止：主人回来了'
    if (userBack()) {
      stopped = true
      try { onUserBack() } catch { }
      journal({ level: 3, kind: 'stop', detail: '主人回来，停止' })
      return '已停止：主人回来了'
    }
    return null
  }

  const openDef = {
    type: 'function',
    function: {
      name: 'open_url',
      description: '在默认浏览器打开一个 http(s) 网页。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }
  }
  const cuaDefs = CUA_FREE_TOOLS.map((n) => ({
    type: 'function',
    function: { name: n, description: n + '：电脑操作（坐标都是最近一张截图的像素坐标）', parameters: FREE_TOOL_PARAMS[n] }
  }))

  return {
    defs: [...cuaDefs, openDef],
    exec: async (name, args) => {
      const a = args || {}
      if (name === 'open_url') {
        const g = gate(); if (g) return g
        const s = sanitizeSearchUrl(String(a.url || ''))
        if (!s.pass) return s.why
        const url = String(s.url || '')
        if (!/^https:\/\//.test(url)) return '只允许 https 网页'
        try { await (o.openUrl || (() => { }))(url) } catch { return '打开失败' }
        journal({ level: 3, kind: 'open', detail: url.slice(0, 200) })
        return '已在浏览器打开' + (s.changed ? '（搜索词已按活人习惯清洗：' + s.q + '）' : '')
      }
      const g = gate(); if (g) return g
      if (typeof cua === 'undefined' || !cua || typeof cua.invoke !== 'function') return '电脑操作引擎不可用'
      const r = await cua.invoke(name, a)
      journal({ level: 3, kind: name, detail: JSON.stringify(a).slice(0, 200) })
      if (r && r.deferred) {
        stopped = true
        try { onUserBack() } catch { }
        journal({ level: 3, kind: 'stop', detail: '主人回来，动作已让位' })
        return '主人回来了，动作已让位未执行。停下收尾。'
      }
      // 截图返回 {image, note}；其余返回各种形状——统一压成文本
      if (r && typeof r === 'object') {
        return { text: String(r.note || r.text || r.reason || JSON.stringify(r).slice(0, 300)), image: r.image }
      }
      return String(r)
    },
    stopped: () => stopped
  }
}

/**
 * 挡 3 跑一场：她真的自己用这台电脑（看屏幕 → 决定 → 动手 → 再看）。
 * cua 引擎自带用户让位；这里再加主人回来中止 + 总时长上限。
 */
async function runFree (o) {
  const opt = o || {}
  const log = opt.log || (() => { })
  const llm = opt.llm
  const cfg = opt.llmCfg || {}
  const cua = opt.cua
  const userBack = opt.userBack || (() => false)
  const journal = opt.journal || (() => { })
  const openUrl = opt.openUrl
  const wsDir = String(opt.wsDir || '')   // 0.45.47 残留窗口记账的落点（被打断时的窗口下一场收拾）
  if (!llm || typeof llm.chatStream !== 'function') return { ok: false, why: 'no-llm' }
  if (!cua || typeof cua.invoke !== 'function') return { ok: false, why: 'no-cua' }

  /* 0.45.9：流水留底——收尾汇报可能整场是空的（她工具轮数用光直接散场，一句话没说），
     那样 onDone 拿不到东西，旁白和记忆提炼全都静默跳过（0.45.8 真机：三场全空）。
     记一份事件清单，最后用来兜底合成一句「她干了什么」。 */
  const events = []
  const journalBoth = (e) => { try { events.push(e) } catch { }; try { journal(e) } catch { } }
  const recap = () => {
    const c = { look: 0, act: 0 }
    const sites = []
    for (const e of events) {
      if (e.kind === 'screenshot' || e.kind === 'zoom') c.look++
      else if (e.kind === 'open') {
        try { sites.push(new URL(String(e.detail)).host.replace(/^www\./, '')) } catch { }
      } else if (['click', 'key', 'type', 'scroll', 'drag'].includes(e.kind)) c.act++
    }
    const bits = []
    if (sites.length) bits.push('打开了 ' + sites.length + ' 个网页（' + [...new Set(sites)].slice(0, 3).join('、') + '）')
    if (c.look) bits.push('看了 ' + c.look + ' 眼屏幕')
    if (c.act) bits.push('动了 ' + c.act + ' 次键鼠')
    return bits.length ? '自己用了一会儿电脑：' + bits.join('、') + '。' : ''
  }

  const free = freeToolsOf({ cua, journal: journalBoth, userBack, openUrl, onUserBack: () => { try { opt.signal && opt.signal.abort() } catch { } } })

  const tasteBlock = tasteBlockOf(opt.tastes)   // 0.45.17 记忆改变行为：她的喜恶进行为决策
  const goalBlock = String(opt.goalBlock || '')   // 0.45.18 需求驱动：动机语气
  const projBlock = String(opt.projBlock || '')   // 0.45.19 跨天项目：推进进行中的事
  const phaseBlock = dayflow.phaseBlockOf(opt.now)  // 0.45.19 时间感
  // 0.45.47 防复读：journal 实锤同一话题一天连搜 7 场——她从没记下「查过了、查到什么」
  const recentSearches = (Array.isArray(opt.recentSearches) ? opt.recentSearches : []).filter(Boolean).slice(0, 8)
  const recentSearchBlock = recentSearches.length
    ? '你最近 24 小时里已经搜过这些词：「' + recentSearches.join('」「') + '」。' +
      '别再原样重搜——同一个问题这次要么换个角度往深处追一层，要么干脆换话题；' +
      '查到有用的东西先记进你的笔记，别下次又空手从头搜一遍。'
    : ''
  const sys = [
    '主人离开了（键盘鼠标好几分钟没动），这台电脑归你用，直到你把想做的事做完为止。',
    '开场先用一句话说清这次你想做什么（比如「去看看 HN 上有什么新东西」），然后直接动手去做，把它做完。',
    ...(tasteBlock ? [tasteBlock] : []),
    ...(goalBlock ? [goalBlock] : []),
    ...(projBlock ? [projBlock] : []),
    ...(phaseBlock ? [phaseBlock] : []),
    ...(recentSearchBlock ? [recentSearchBlock] : []),
    '你可以看屏幕、动鼠标键盘、开关网页——像一个人真的坐在电脑前那样。',
    '原则：多看少动。先 screenshot 看清现状再决定，不确定就不要按。',
    '截图看不清字的时候（网页正文、文章、聊天记录）用 read_text 直接读屏幕上的文字。',
    '重要：想做什么直接调工具去做。不要用宣布代替行动——',
    '你说的每句话要么是工具调用，要么是对已经做完的事的汇报（过去式）。',
    '收尾的标准是「一开始想做的事做完了」，不是时间到了。半途而废就收尾会被推回去继续做。',
    '收尾前收拾干净：把这次你自己开出来的网页/窗口关掉（focus 到它再 alt+f4），',
    '让电脑回到主人离开时的样子。主人本来开着的东西绝对不要动。',
    '绝对不许做的事（做了会立刻被叫停）：花钱（购物/付款/充值/订阅）、替主人发消息、删除文件或系统设置。',
    '建议做的事：看看你感兴趣的网页（open_url）、把看到的有意思的东西记在心里（之后聊天可以提）。',
    '搜东西像活人：搜索框里打几个自然关键词。查东西一律用 open_url 直接开浏览器搜，' +
    '不要去点 Windows 任务栏的搜索框（那里面搜出来的又杂又慢，主人看着也奇怪）。' +
    '你资料里的「# 标题」（主人搜过什么、浏览记录这些）只是档案目录，内容就在那一节里，别原样拿去搜。',
    '全部做完后，用两三句过去式的话收尾：你刚才做了什么、看到了什么（「我看了…」「我打开了…」），不要用将来时。'
  ].join('\n')

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  journal({ level: 3, kind: 'session-start', detail: '完全开放挡' })
  const t0 = Date.now()
  /* 恢复原样的兜底：开场记下所有窗口句柄，正常散场后把她新开出来的浏览器窗口关掉。
     只动 cls=Chrome_WidgetWin_1（Chromium 系浏览器）且不属于本应用、标题不含自家关键词的，
     其他一概不碰（她按提示词自己收，代码只兜最常见——open_url 留下的浏览器窗）。 */
  const ownPid = (typeof process !== 'undefined' && process.pid) || 0
  const isOwnWin = (w) => w.pid === ownPid || /ryza|莱莎|真寻|world\.execute|partner\.execute/i.test(String(w.title || ''))
  const isBrowserWin = (w) => w && w.cls === 'Chrome_WidgetWin_1' && !isOwnWin(w)
  const listWindows = async () => {
    try { return ((await cua.invoke('windows', { includeMinimized: true })) || {}).windows || [] } catch { return [] }
  }
  /** 0.45.47 开场先收拾上一场被打断留下的浏览器窗（此刻主人已离开，动键鼠安全） */
  try {
    const stale = readLeftovers(wsDir)
    if (stale.length) {
      const cur = await listWindows()
      const alive = new Map(cur.map((w) => [w.hwnd, w]))
      let closed = 0
      for (const h of stale) {
        const w = alive.get(h)
        if (!w || !isBrowserWin(w)) continue
        try {
          await cua.invoke('focus', { hwnd: w.hwnd })
          await sleep(350)
          await cua.invoke('key', { keys: 'alt+f4' })
          journal({ level: 2, kind: 'cleanup', detail: '关掉上一场残留的浏览器窗「' + String(w.title || '').slice(0, 60) + '」' })
          closed++
          await sleep(450)
        } catch { }
      }
      writeLeftovers(wsDir, [])
      if (closed) log('[autonomy] 收拾了 ' + closed + ' 个上一场残留的浏览器窗')
    }
  } catch { }
  const beforeHwnds = new Set()
  try {
    const snap = await listWindows()
    for (const w of snap) beforeHwnds.add(w.hwnd)
  } catch { }
  /** 0.45.47 被打断时记下她开出来的新浏览器窗——本场不能动键鼠（主人回来了），
   *  但下一场开场要收拾。把残留从「永远冻在屏幕上」变成「下一场开场自动关掉」。 */
  const saveLeftovers = async () => {
    try {
      const after = await listWindows()
      const fresh = after.filter((w) => !beforeHwnds.has(w.hwnd) && isBrowserWin(w)).map((w) => w.hwnd)
      writeLeftovers(wsDir, fresh)
    } catch { }
  }
  const cleanupOpen = async () => {
    if (free.stopped() || !beforeHwnds.size) return
    try {
      const after = await listWindows()
      for (const w of after) {
        if (beforeHwnds.has(w.hwnd)) continue
        if (!isBrowserWin(w)) continue            // 只兜浏览器窗
        try {
          await cua.invoke('focus', { hwnd: w.hwnd })
          await sleep(350)
          await cua.invoke('key', { keys: 'alt+f4' })
          journal({ level: 2, kind: 'cleanup', detail: '关掉她开出来的浏览器窗「' + String(w.title || '').slice(0, 60) + '」' })
          await sleep(450)
        } catch { }
      }
    } catch { }
  }

  const msgs = [
    { role: 'system', content: sys },
    { role: 'user', content: '开始吧。先看看现在屏幕上是什么。' }
  ]
  /* 0.45.6：她有时只回一句「我会先截屏看看」（将来时的计划）就停——模型把宣布当成了收尾。
     检测到意图式回复就追一条「别只说，去做」（最多推 2 次）。
     0.45.16：收尾不看时钟看任务——她开场说了想做什么，没做完就被推回去做完；
     「最少逛几分钟」的推送废除。时长上限只剩保险作用（85% 软提醒，100% 硬掐）。 */
  const MAX_SCRIPT = maxScriptMsOf(cfg)
  const NUDGE = '别只说计划——你刚才说的是「我要做什么」，不是「我做了什么」。直接调工具去做（screenshot / open_url / click…），等真的做完了再用过去式收尾。'
  const NOT_STARTED = '你还没真正动手做过任何事，不能就这么空口收尾——先用工具去做你想做的事，做完再用过去式收尾。'
  const planCheckOf = (plan) => plan
    ? '对照你一开始想做的事（「' + String(plan).slice(0, 80) + '」）：都做完了吗？想做的做完、自己开的网页关干净，再正式收尾。'
    : '再检查一遍：你这次想做的事都做完了吗？自己开出来的网页关干净了吗？确认都完成了再正式收尾。'
  const intentOnly = (s) => /^(好的[，,。]?|那[我她他]?)?(?:我会|我先|我打算|我准备|让我|我这就|我来看|接下来我|首先我|i will|let me|まずは)/i.test(String(s || '').trim()) && String(s || '').length < 160
  let content = ''
  let bestContent = ''                       // 0.45.9：最后一段像样的汇报（非空且非纯计划）
  let planText = ''                          // 0.45.16：她开场说的「这次想做什么」，收尾对照用
  let noActionPushed = 0
  let planPushed = 0
  try {
    for (let pass = 0; pass < 8; pass++) {
      const r = await llm.chatStream({
        baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
        temperature: 0.9,
        signal: ctrl ? ctrl.signal : undefined,
        messages: msgs,
        maxRounds: 16,                      // 0.45.16 目标驱动收尾：行为做完为止，轮数预算放宽
        tools: free.defs,
        toolExec: async (name, args) => {
          if (Date.now() - t0 > MAX_SCRIPT) { try { ctrl && ctrl.abort() } catch { }; return '安全时间上限到了，立刻收尾。' }
          if (Date.now() - t0 > MAX_SCRIPT * 0.85) return '快到安全时间上限了——把手头这步做完就收尾，不要再开始新的事情。'
          return free.exec(name, args)
        }
      })
      content = String((r && r.content) || '').trim()
      if (content && !planText) planText = content
      if (intentOnly(content)) {
        if (pass >= 2 || Date.now() - t0 > MAX_SCRIPT * 0.6) break
        log('[autonomy] 她只宣布了计划没动手，推她一把（第 ' + (pass + 1) + ' 次）')
        journalBoth({ level: 2, kind: 'nudge', detail: '只说了计划，被推去实际做' })
        msgs.push({ role: 'assistant', content })
        msgs.push({ role: 'user', content: NUDGE })
        continue
      }
      if (content) bestContent = content
      // 收尾判定（0.45.16）：先查动没动手（nudge 推送不算动作），再对照开场计划——不看时钟
      const acted = events.some((e) => e.kind !== 'nudge')
      if (!acted && noActionPushed < 2) {
        noActionPushed++
        log('[autonomy] 她什么都没做就想收尾，推她去做')
        journalBoth({ level: 2, kind: 'nudge', detail: '没动手就想收尾，被推' })
        msgs.push({ role: 'assistant', content })
        msgs.push({ role: 'user', content: NOT_STARTED })
        continue
      }
      if (acted && planPushed < 2 && Date.now() - t0 < MAX_SCRIPT * 0.85) {
        planPushed++
        log('[autonomy] 收尾前对照她的计划（第 ' + planPushed + ' 次）')
        journalBoth({ level: 2, kind: 'nudge', detail: '收尾前对照计划推一次' })
        msgs.push({ role: 'assistant', content })
        msgs.push({ role: 'user', content: planCheckOf(planText) })
        continue
      }
      break
    }
    if (!content || intentOnly(content)) content = bestContent || recap()
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (/abort/i.test(msg) || free.stopped()) {
      await saveLeftovers()                    // 0.45.47 残留记账：下一场开场收拾
      journal({ level: 3, kind: 'session-end', detail: '主人回来，中断' })
      return { ok: false, why: 'user-back' }
    }
    log('[autonomy] 完全开放挡失败: ' + msg.slice(0, 120))
    journal({ level: 3, kind: 'session-end', detail: '出错 ' + msg.slice(0, 80) })
    return { ok: false, why: 'llm-error' }
  }
  await cleanupOpen()                        // 恢复原样：关掉她开出来的浏览器窗
  writeLeftovers(wsDir, [])   // 0.45.47 正常收场=没有残留
  journal({ level: 3, kind: 'session-end', detail: '正常结束' })
  if (free.stopped()) {
    await saveLeftovers()                    // 0.45.47 残留记账：下一场开场收拾
    journal({ level: 3, kind: 'session-end', detail: '主人回来，中断' })
    return { ok: false, why: 'user-back' }
  }
  return { ok: true, why: 'done', content: content.slice(0, 400) }
}

/** 挡位选择（配置 → 跑哪场）。挡 2/3 需要 LLM 配置，缺了就降到挡 1。 */
function pickRunner (c, hasLlm) {
  const level = Math.min(3, Math.max(1, Number(c && c.autonomyLevel) || 1))
  if (level >= 3 && hasLlm) return { level: 3, kind: 'free' }
  if (level === 2 && hasLlm) return { level: 2, kind: 'space' }
  return { level: 1, kind: 'browse' }
}

/**
 * 做梦式解析结果 → 审查册条目（自主活动的经历沉淀，0.45.8）。
 * 她出门逛一圈不该只留运维流水——喜欢/讨厌/想记住的/关于主人的新事实
 * 走跟做梦同一条管线（审查册 → 自动批准 → 长期记忆），聊天时才真的「记得自己去过哪」。
 */
function memoryEntriesOf (parsed) {
  const p = parsed || {}
  const entries = []
  for (const t of p.likes || []) {
    if (t && t.what) entries.push({ kind: 'taste', what: t.what, payload: t.what + (t.why ? '｜' + t.why : ''), reason: '自主活动：喜欢', polarity: 'like' })
  }
  for (const t of p.dislikes || []) {
    if (t && t.what) entries.push({ kind: 'taste', what: t.what, payload: t.what + (t.why ? '｜' + t.why : ''), reason: '自主活动：不喜欢', polarity: 'dislike' })
  }
  for (const h of p.hisFacts || []) {
    if (h && h.fact) entries.push({ kind: 'fact', what: h.fact, payload: h.fact, reason: '自主活动·关于他' })
  }
  for (const m of p.memories || []) {
    if (m && m.fact) entries.push({ kind: 'memory', what: m.fact, payload: m.fact, reason: '自主活动（重要度 ' + m.importance + '）' })
  }
  return entries
}

/** 0.45.17 记忆改变行为：把她的喜恶记忆变成行为决策的注入块。
    极性来自条目上的 polarity 字段或 reason 里的「不喜欢」。 */
function tasteBlockOf (tastes) {
  const likes = []
  const dislikes = []
  for (const t of (Array.isArray(tastes) ? tastes : [])) {
    if (!t || !t.what) continue
    const dis = t.polarity === 'dislike' || (!t.polarity && /不喜欢|厌恶|讨厌/.test(String(t.reason || '')))
    ;(dis ? dislikes : likes).push(String(t.what))
  }
  const lines = []
  if (likes.length) lines.push('你之前记下过自己喜欢：' + likes.slice(0, 5).join('；') + '。这次活动可以顺着这些来。')
  if (dislikes.length) lines.push('你之前记下过自己不喜欢：' + dislikes.slice(0, 5).join('；') + '。别往这些上凑，也别把它们当话题。')
  return lines.join('\n')
}

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }

/** 冷却：跟开口节奏器同一个理由（Barabási 2005，人类间隔重尾），这里只要一个偏长的尾巴 */
function nextCooldownMs (rand) {
  const r = typeof rand === 'function' ? rand : Math.random
  const lo = COOLDOWN_MIN * 60 * 1000
  const hi = COOLDOWN_MAX * 60 * 1000
  // 80% 落在 [lo, lo*2]，20% 甩到接近 hi —— 均匀分布会显得像排班
  if (r() < 0.8) return Math.round(lo + r() * lo)
  return Math.round(lo * 2 + r() * (hi - lo * 2))
}

/**
 * 从「她的兴趣」里挑一个话题。
 * 来源优先级：她最近在想的（inner 的日记关键词）> 画像里推断出的主题 > 主人常看的 B 站标题
 * @param {{thoughts?:string[], themes?:string[], biliTitles?:string[]}} pool
 * @returns {string} 空串 = 今天没什么想看的，就不出门
 */
function pickTopic (pool, rand) {
  const r = typeof rand === 'function' ? rand : Math.random
  const p = pool || {}
  const groups = [p.thoughts, p.themes, p.biliTitles]
  for (const g of groups) {
    const list = (g || []).map((x) => String(x || '').trim()).filter((x) => x.length >= 2 && x.length <= 20)
    if (list.length) return list[Math.floor(r() * list.length) % list.length]
  }
  return ''
}

/** 前台窗口：{pn, t, fg}。拿不到返回 null（拿不到就不动） */
async function foreground () {
  try {
    const snap = await require('../launcher').scan({ maxAge: 4000 })
    const list = (snap && snap.windows) || []
    const fg = list.find((w) => w && w.fg)
    if (!fg) return null
    return { pn: String(fg.pn || '').replace(/\.exe$/i, ''), title: String(fg.t || ''), hwnd: fg.hwnd || 0 }
  } catch { return null }
}

function isBrowser (w) {
  return !!(w && BROWSER_PN.test(w.pn || ''))
}

/** 页面标题里出现目标域名 → 她确实到了那个站点 */
function arrived (w, host) {
  const t = String((w && w.title) || '').toLowerCase()
  return t.includes(String(host || '').split('.')[0])
}

/**
 * 跑一次。调用方负责判断「该不该跑」（开关/空闲/冷却）。
 * @param {{topic:string, site:object, log:Function, cua:object, openUrl:Function,
 *          now:Function, sleep:Function}} o
 * @returns {Promise<{ok:boolean, why?:string, seen?:string[], url?:string}>}
 */
async function runBrowse (o) {
  const opt = o || {}
  const log = opt.log || (() => { })
  const now = opt.now || Date.now
  const wait = opt.sleep || sleep
  const cua = opt.cua
  const openUrl = opt.openUrl
  const topic = String(opt.topic || '').trim()
  const site = opt.site || SITES[0]
  if (!topic) return { ok: false, why: 'no-topic' }
  if (typeof openUrl !== 'function') return { ok: false, why: 'no-opener' }

  const t0 = now()
  const fgOf = typeof opt.foreground === 'function' ? opt.foreground : foreground
  const before = await fgOf()
  if (!before) return { ok: false, why: 'no-foreground', seen: [] }

  const url = site.search(topic)
  log('[autonomy] 出门看看「' + topic + '」→ ' + url)
  try { await openUrl(url) } catch (e) {
    log('[autonomy] 打开失败: ' + (e && e.message))
    return { ok: false, why: 'open-failed', seen: [] }
  }

  await wait(LOAD_WAIT_MS)
  let cur = await fgOf()

  /* 打开失败（前台没变，或者前台不是浏览器）→ 绝不动键鼠。
     这一步是安全底线：宁可这一趟什么都没做，也不能在未知窗口上按 Ctrl+W。 */
  const changed = cur && (cur.title !== before.title || cur.hwnd !== before.hwnd)
  if (!isBrowser(cur) || !changed) {
    log('[autonomy] 没确认到浏览器前台，直接收手（不动键鼠）')
    return { ok: false, why: 'not-opened', seen: [] }
  }

  const seen = []
  if (arrived(cur, site.host)) seen.push(cur.title)
  else seen.push(cur.title)

  /* 「持续性地看」= 真的往下翻，而且每翻一次都确认标题/页面还在。
     两次都不动说明页面是死的（加载失败/白屏），收尾走人，别硬演。 */
  let moved = 0
  const browseMaxMs = maxScriptMsOf(opt.cfg)
  for (let i = 0; i < SCROLL_TIMES; i++) {
    if (now() - t0 > browseMaxMs) break
    try {
      const r = await cua.invoke('scroll', { dy: 520 })
      if (r && r.deferred) { log('[autonomy] 主人回来了，提前收尾'); break }
    } catch (e) { log('[autonomy] 滚动失败: ' + (e && e.message)); break }
    await wait(SCROLL_WAIT_MS)
    const after = await fgOf()
    if (isBrowser(after)) { moved++; seen.push(after.title) }
  }

  /* 收尾：只在「前台确实是浏览器」时按 Ctrl+W。
     再确认一次，因为滚动那几秒里主人可能已经回来了（焦点会跳到别的窗口）。 */
  const ready = await fgOf()
  let closed = false
  if (isBrowser(ready)) {
    try {
      const r = await cua.invoke('key', { keys: 'ctrl+w' })
      closed = !(r && r.deferred)
      if (closed) log('[autonomy] 关掉标签页')
    } catch (e) { log('[autonomy] 关闭失败: ' + (e && e.message)) }
  } else {
    log('[autonomy] 前台已经不是浏览器了，不按 Ctrl+W（免得关掉别的东西）')
  }

  const uniq = [...new Set(seen.map((s) => String(s || '').trim()).filter(Boolean))]
  return { ok: true, why: closed ? 'done' : 'done-open', seen: uniq, url, moved, closed }
}

/** 把一次活动写成「她自己的一天」里的一句话（给日记/内心用） */
function lineOf (r) {
  if (!r || !r.ok) return ''
  const seen = (r.seen || []).filter(Boolean)
  if (!seen.length) return ''
  const head = seen[0].replace(/\s*[-–—|]\s*(哔哩哔哩|bilibili|知乎|维基百科)\s*$/i, '').trim()
  if (!head) return ''
  const more = seen.length > 1 ? '，后来还翻到「' + seen[1].slice(0, 24) + '」' : ''
  return '自己跑去看了会儿「' + head.slice(0, 30) + '」' + more
}

/**
 * 建一个调度器。真机接线由 companion/index.js 负责（它才知道空闲秒数、对话状态）。
 * @param {{cfgGet:Function, log:Function, idleSec:Function, busy:Function,
 *          pool:Function, cua:object, openUrl:Function, onDone:Function,
 *          now:Function, rand:Function, sleep:Function}} deps
 */
function create (deps) {
  const d = deps || {}
  const cfgGet = d.cfgGet || (() => ({}))
  const log = d.log || (() => { })
  const idleSec = d.idleSec || (() => 0)
  const busy = d.busy || (() => false)
  const pool = d.pool || (() => ({}))
  const now = d.now || Date.now
  const rand = d.rand || Math.random
  const onDone = d.onDone || (() => { })

  let timer = null
  let running = false
  let nextAt = 0
  let lastAt = 0
  let lastResult = null
  let todayCount = 0
  let dayKey = ''

  /** 挡 2 的地盘目录：用户指定的优先；没指定就落在角色工作区里的 her-space */
  function spaceDirOf (c) {
    const custom = String((c && c.autonomyDir) || '').trim()
    if (custom) return custom
    const ws = typeof d.wsDir === 'function' ? d.wsDir() : ''
    return ws ? path.join(ws, 'her-space') : ''
  }
  const journalFn = (entry) => appendJournal(typeof d.wsDir === 'function' ? d.wsDir() : '', entry)
  /** 主人回来了？空闲 < 阈值即视为回来（挡 2/3 每个工具调用前都会问一遍；阈值随设置走） */
  const userBackOf = (ms) => () => ((Number(idleSec()) || 0) * 1000 < ms)

  function rollDay () {
    const dt = new Date(now())
    const k = dt.getFullYear() + '-' + (dt.getMonth() + 1) + '-' + dt.getDate()
    if (k !== dayKey) { dayKey = k; todayCount = 0 }
  }

  /**
   * 跑一次调度。opts.force = 设置页「让她现在就跑一场」（测试按钮）：
   * 绕过空闲/冷却/每日上限，但保留 busy 检查（正在聊天就不抢）。
   * 让位闸整个不套：这是用户亲手授权的观察场——他必须待在电脑前才看得到她跑，
   * 而人在电脑前任何 idle 阈值（哪怕 3 秒）都会让她在第一秒自杀（0.45.3 真机实证）。
   * 场次本身有 MAX_SCRIPT_MS 封顶，不会失控。
   * @returns {Promise<{ok:boolean, why?:string, content?:string}|undefined>}
   */
  async function tick (opts) {
    const force = !!(opts && opts.force)
    if (running) return force ? { ok: false, why: 'running' } : undefined
    const c = cfgGet() || {}
    const idleMs = idleMsOf(c)
    const userBack = force
      ? () => false                                  // 强制跑：用户授权的观察场，不让位
      : userBackOf(idleMs)
    if (!force) {
      if (c.autonomyOn !== true) return
      rollDay()
      const idle = Number(idleSec()) || 0
      if (idle * 1000 < idleMs) return                 // 主人在，不占电脑
      if (busy()) return                               // 正在聊天/正在执行别的任务
      if (now() < nextAt) return
      if (todayCount >= Math.max(1, Number(c.autonomyDailyMax) || 6)) return
    } else {
      if (busy()) return { ok: false, why: 'busy' }
      rollDay()
    }

    const p = pool() || {}
    /* 0.45.18 需求系统：时间推进三股压力，最强的一股决定这场活动的动机语气；
       总压力还会缩短冷却（憋得狠出门早）。needs 没接线时一切照旧。 */
    const nd = d.needs || null
    let needState = null
    if (nd) {
      const hasTopics = ['thoughts', 'themes', 'biliTitles'].some((k) => Array.isArray(p[k]) && p[k].length)
      needState = nd.state({ hasTopics, hadExperience: todayCount > 0 })
    }
    const goalBlock = needState ? needs.goalBlockOf(needState) : ''
    // 0.45.19 跨天项目：没有进行中的就从话题池立一个；block 注入 sys
    const prj = d.projects || null
    const projBlock = prj ? prj.block(p.themes || []) : ''
    const runner = pickRunner(c, !!(d.llmCfg && d.llmCfg() && d.llmCfg().model))
    let topic = ''
    if (runner.kind === 'browse' || runner.kind === 'space') {
      topic = pickTopic(p, rand)
      if (!topic && runner.kind === 'browse') {
        log('[autonomy] 今天没什么特别想看的，先不动')
        nextAt = now() + 30 * 60 * 1000
        return force ? { ok: false, why: 'no-topic' } : undefined
      }
      // 挡 2 没话题也能去地盘写点什么，话题只是加分项
    }

    running = true
    const site = SITES[Math.floor(rand() * SITES.length) % SITES.length]
    try {
      let r
      if (runner.kind === 'space') {
        const dir = spaceDirOf(c)
        try { fs.mkdirSync(dir, { recursive: true }) } catch { }
        r = await runSpace({
          topic, dir, log, now,
          llm: require('./llm'),
          llmCfg: d.llmCfg ? d.llmCfg() : null,
          journal: journalFn,
          openUrl: d.openUrl,
          userBack,
          sleep: d.sleep,
          tastes: d.tastes ? d.tastes() : [],   // 0.45.17 记忆改变行为
          goalBlock,                            // 0.45.18 需求驱动
          projBlock                             // 0.45.19 跨天项目
        })
      } else if (runner.kind === 'free') {
        const ws = typeof d.wsDir === 'function' ? d.wsDir() : ''
        r = await runFree({
          log, now,
          llm: require('./llm'),
          llmCfg: d.llmCfg ? d.llmCfg() : null,
          cua: d.cua,
          journal: journalFn,
          openUrl: d.openUrl,
          userBack,
          wsDir: ws,                              // 0.45.47 残留窗口记账 + 防复读的位置
          recentSearches: recentQueriesOf(ws, now()),  // 0.45.47 最近 24h 搜过的词
          tastes: d.tastes ? d.tastes() : [],   // 0.45.17 记忆改变行为
          goalBlock,                            // 0.45.18 需求驱动
          projBlock                             // 0.45.19 跨天项目
        })
      } else {
        r = await runBrowse({
          topic, site, log, cua: d.cua, openUrl: d.openUrl, now, sleep: d.sleep, rand,
          foreground: d.foreground,  // 宿主/测试可注入前台窗口探测（否则走真实 launcher.scan）
          cfg: cfgGet()
        })
      }
      lastResult = r
      lastAt = now()
      if (r.ok) {
        todayCount++
        if (nd) nd.discharge('session')    // 0.45.18 出门一圈，无聊和好奇泄掉
        const line = runner.kind === 'browse' ? lineOf(r) : String(r.content || '').trim()
        // 0.45.19 跨天项目：汇报记一笔；攒够进展就收尾（收尾信息并进旁白）
        if (prj && line) {
          const fin = prj.record(line)
          if (fin) log('[autonomy] 项目收尾：《' + fin.title + '》 ' + (fin.summary || '').slice(0, 60))
        }
        try { onDone(r, line) } catch (e) { log('[autonomy] onDone 失败: ' + (e && e.message)) }
        // 压力越高冷却越短：憋得狠的时候，下一场来得早些
        const scale = needState ? needs.cooldownScaleOf(needState) : 1
        nextAt = now() + Math.round(nextCooldownMs(rand) * scale)
      } else if (r.why === 'llm-error') {
        // 0.45.11：deepseek 高峰期 503 把刚开场的一场整个报废（真机日志实证）——
        // 一次服务端抖动不该换来一小时禁闭，llm.js 已加退避重试，这里再兜一层：5 分钟后就地补跑
        nextAt = now() + 5 * 60 * 1000
      } else {
        nextAt = now() + nextCooldownMs(rand)
      }
      log('[autonomy] 结束 why=' + (r.why || '?') + ' 下次最早 ' +
        Math.round((nextAt - now()) / 60000) + ' 分钟后')
    } catch (e) {
      log('[autonomy] 剧本异常: ' + (e && e.message))
      nextAt = now() + 20 * 60 * 1000
      if (force) return { ok: false, why: 'error' }
    } finally {
      running = false
    }
    // tick() 常规调用不需要返回值；force（设置页测试跑）要把结果带回给 UI
    if (force) return lastResult
  }

  function start () {
    stop()
    /* 第一次不掷 45~120 分钟的冷却：刚打开开关的人一小时后才看到她出门，会以为坏了。
       给一个 10 分钟的小间隔，之后进入正常节奏（跟 0.42.0 节奏器「第一句封顶 10 分钟」同一个理由）。
       但只认「第一次」：配置重载也会走到 start()，每次都重置的话，
       改一个设置就再等 10 分钟，永远到不了触发点（0.45.0 真机踩中）。 */
    if (!nextAt) nextAt = now() + (lastAt ? nextCooldownMs(rand) : FIRST_DELAY_MS)
    timer = setInterval(() => { tick().catch(() => { }) }, TICK_MS)
    if (timer.unref) timer.unref()
    log('[autonomy] 已启动（主人离开 ' + Math.round(idleMsOf(cfgGet()) / 60000) +
      ' 分钟后她会自己看看东西，首次最早 ' + Math.round(FIRST_DELAY_MS / 60000) + ' 分钟后）')
    return true
  }

  function stop () {
    if (timer) { clearInterval(timer); timer = null }
  }

  function status () {
    const c = cfgGet() || {}
    return {
      on: c.autonomyOn === true,
      level: pickRunner(c, !!(d.llmCfg && d.llmCfg() && d.llmCfg().model)).level,
      idleMin: Math.round(idleMsOf(c) / 60000),
      running,
      todayCount,
      lastAt,
      nextInMs: Math.max(0, nextAt - now()),
      last: lastResult,
      needs: d.needs ? d.needs.status() : null,   // 0.45.18 三股压力可见
      project: d.projects ? d.projects.status() : null,   // 0.45.19 进行中的项目
      phase: dayflow.phaseOf(now()).key           // 0.45.19 她现在的时间段
    }
  }

  return { start, stop, tick, status }
}

module.exports = {
  IDLE_TRIGGER_MS, TICK_MS, COOLDOWN_MIN, COOLDOWN_MAX, MAX_SCRIPT_MS, SITES, BROWSER_PN,
  MAX_SPACE_FILE, JOURNAL_MAX, CUA_FREE_TOOLS,
  nextCooldownMs, pickTopic, lineOf, runBrowse, isBrowser, arrived, create, idleMsOf,
  /* 0.45.0 三挡位 */
  pickRunner, spaceGuard, spaceToolsOf, runSpace, freeToolsOf, runFree, appendJournal,
  /* 0.45.8 经历沉淀 */
  memoryEntriesOf,
  tasteBlockOf,
  /* 0.45.18 需求系统（re-export 供旧调用方顺手用） */
  needs
}
