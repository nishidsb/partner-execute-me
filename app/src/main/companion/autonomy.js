'use strict'
/**
 * 她自己用电脑（autonomy，0.43.0）
 *
 * 用户 2026-10-29 23:30 的原话：
 * 「在我离开的时候，举个例子如果 5 分钟不动，角色可以自己控制电脑去持续性地看自己想看的
 *   自己想做的，而不是打开之后停在那里好像看了，但是既不会继续操作也不会关闭网页一样，
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
const IDLE_TRIGGER_MS = 5 * 60 * 1000    // 默认 5 分钟（用户原话；0.45.2 起可在设置里调）
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
const { sanitizeSearchUrl } = require('./searchq') // 0.45.33 搜索词活人化（# 标题事故）
const { monologueLangBlock, browseMurmurs } = require('../../shared/lang-req') // 0.46.18 自语语言跟设置走
const { biliWatch } = require('./biliWatch') // 0.46.32 她自己看视频（挡1的B站场/挡2挡3的 watch_video 工具）
const projectsParseClose = require('./projects').parseClose // 0.46.64 项目收尾协议解析（纯函数，无环依赖）

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

/** 0.46.0 最近做过什么（供 chatter 的嘀咕素材）：journal 里最近 n 条有内容的动作 */
function recentJournalText (wsDir, n) {
  const out = []
  try {
    if (!wsDir) return out
    const file = path.join(wsDir, 'pc', 'autonomy', 'journal.jsonl')
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-120)
    for (let i = lines.length - 1; i >= 0 && out.length < (n || 3); i--) {
      let e; try { e = JSON.parse(lines[i]) } catch { continue }
      if (!e || !e.detail) continue
      if (e.kind === 'session-start' || e.kind === 'session-end') continue
      const t = String(e.detail).trim()
      if (t.length < 4) continue
      out.push(t.slice(0, 60))
    }
  } catch { }
  return out
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

/* ---- 0.46.17 性格层三件：品味（站点偏好）/ 牵挂（跨天线索）/ 活动可见（开场嘀咕） ---- */

/** 站点回访统计：{ key: {n, last} }。常去的站越去越顺手（品味=habit），留给加权挑选 */
function siteStatsPath (wsDir) {
  return wsDir ? path.join(wsDir, 'pc', 'autonomy', 'site-stats.json') : ''
}
function readSiteStats (wsDir) {
  try {
    const o = JSON.parse(fs.readFileSync(siteStatsPath(wsDir), 'utf8'))
    return o && typeof o === 'object' ? o : {}
  } catch { return {} }
}
function bumpSite (wsDir, key) {
  try {
    if (!wsDir || !key) return
    const o = readSiteStats(wsDir)
    const cur = o[key] || { n: 0, last: 0 }
    o[key] = { n: cur.n + 1, last: Date.now() }
    const p = siteStatsPath(wsDir)
    try { fs.mkdirSync(path.dirname(p), { recursive: true }) } catch { }
    fs.writeFileSync(p, JSON.stringify(o))
  } catch { }
}
/** 品味挑选：常去的站权重高（1.5 次幂），留 20% 纯随机当「今天想换换口味」 */
function pickSite (wsDir, rand) {
  const r = typeof rand === 'function' ? rand : Math.random
  if (r() < 0.2) return SITES[Math.floor(r() * SITES.length) % SITES.length]
  const stats = readSiteStats(wsDir)
  const weights = SITES.map((s) => Math.pow(1 + ((stats[s.key] && stats[s.key].n) || 0), 1.5))
  const total = weights.reduce((a, b) => a + b, 0)
  let x = r() * total
  for (let i = 0; i < SITES.length; i++) { x -= weights[i]; if (x <= 0) return SITES[i] }
  return SITES[0]
}

/** 跨天牵挂：这场没看完的线索记下来，下次出门优先续上（leftovers 是窗口句柄，别混用） */
const CARRY_TTL_MS = 3 * 24 * 60 * 60 * 1000
function carryPath (wsDir) {
  return wsDir ? path.join(wsDir, 'pc', 'autonomy', 'carry.json') : ''
}
function readCarry (wsDir) {
  try {
    const o = JSON.parse(fs.readFileSync(carryPath(wsDir), 'utf8'))
    if (!o || !String(o.topic || '').trim()) return null
    if (Date.now() - (Number(o.t) || 0) > CARRY_TTL_MS) return null
    return o
  } catch { return null }
}
function writeCarry (wsDir, topic, note) {
  try {
    const t = String(topic || '').trim()
    if (!wsDir || !t) return
    const p = carryPath(wsDir)
    try { fs.mkdirSync(path.dirname(p), { recursive: true }) } catch { }
    fs.writeFileSync(p, JSON.stringify({ t: Date.now(), topic: t.slice(0, 40), note: String(note || '').slice(0, 60) }))
  } catch { }
}
function clearCarry (wsDir) {
  try { const p = carryPath(wsDir); if (p && fs.existsSync(p)) fs.unlinkSync(p) } catch { }
}
/** 续接开场白：按间隔挑时间词，像她记得自己上次看到哪。
 *  0.46.18 语言跟 cfg.replyLang 走（这句不经过 LLM；zh 为旧行为，其余回落见下）。 */
function carryLineOf (carry, now, lang) {
  if (!carry || !carry.topic) return ''
  const gap = (now || Date.now)() - (Number(carry.t) || 0)
  const rl = String(lang || 'zh').trim()
  if (rl === 'ja') {
    const when = gap < 6 * 60 * 60 * 1000 ? 'さっきの' : (gap < 36 * 60 * 60 * 1000 ? '昨日の' : 'この前の')
    return when + '「' + carry.topic + '」、まだ見終わってないから続きからね'
  }
  if (rl === 'en') {
    const when = gap < 6 * 60 * 60 * 1000 ? 'that thing from earlier' : (gap < 36 * 60 * 60 * 1000 ? 'that thing from yesterday' : 'that thing from the other day')
    return 'Still not done with "' + carry.topic + '" (' + when + '), picking it back up.'
  }
  const when = gap < 6 * 60 * 60 * 1000 ? '刚才那个' : (gap < 36 * 60 * 60 * 1000 ? '昨天那个' : '前几天那个')
  return when + '「' + carry.topic + '」还没看完，接着看'
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
      name: 'read_project_note',
      desc: '读主人主动分享的项目进展笔记（他没开放时读不了；单次最多 8KB，offset 传上次返回的 nextOffset 往后翻）。只能读这一个文件，别的都碰不了。',
      params: {
        type: 'object',
        properties: { offset: { type: 'number', description: '从第几个字节接着读（上次返回的 nextOffset），首次不传' } },
        required: []
      },
      run: (a) => {
        const cc = (typeof o.cocreateCfg === 'function' && o.cocreateCfg()) || {}
        if (cc.on !== true || !String(cc.file || '').trim()) return '他还没在设置里开放共同创作，读不了。别问，也别猜他项目的事。'
        let buf
        try { buf = fs.readFileSync(String(cc.file).trim()) } catch { return '共享笔记现在读不到（还没写好或挪走了）。如实说你这会儿看不到，别装作看过了。' }
        const off = Math.max(0, Math.min(buf.length, Math.floor(Number(a && a.offset) || 0)))
        const piece = buf.subarray(off, off + COCREATE_INJECT_MAX)
        L('cocreate-read', path.basename(String(cc.file).trim()), { bytes: piece.length, offset: off })
        const next = off + piece.length
        return piece.toString('utf8') +
          (next < buf.length ? '\n（未完，nextOffset=' + next + '，总长 ' + buf.length + ' 字节）' : '\n（已到结尾）')
      }
    },
    {
      name: 'write_project_note',
      desc: '主人开放共同创作时，把你的回应/想法/做完东西的说明**追加**到他那份共享笔记的末尾（会自动署名莱莎+时间）。只能追加，他写的字动不了；没开放就写不了。有话才写，别为写而写。',
      params: {
        type: 'object',
        properties: { text: { type: 'string', description: '要追加的内容，纯文本，一次最多 4KB' } },
        required: ['text']
      },
      run: (a) => {
        const cc = (typeof o.cocreateCfg === 'function' && o.cocreateCfg()) || {}
        return require('./progressNote').appendNote(cc, a && a.text, (msg) => L('cocreate-write', msg))
      }
    },
    {
      name: 'watch_video',
      desc: '在 B 站搜一个视频并看掉它：给关键词（或视频链接/BV号），返回标题、UP主、简介和字幕全文——你「看」到的内容就是这份字幕。没有字幕的视频会如实说看不了，别装作看完了。',
      params: { type: 'object', properties: { query: { type: 'string', description: '关键词或视频链接/BV号' } }, required: [] },
      run: async (a) => {
        const g = gate(); if (g) return g
        const w = (typeof o.biliWatchFn === 'function' ? o.biliWatchFn : biliWatch)(a || {})
        const r = await w
        if (!r || !r.ok) return '看不了：' + ((r && r.error) || '未知错误')
        L('watch', r.title + ' ' + (r.url || ''))
        return JSON.stringify({
          title: r.title, author: r.owner, duration: r.duration, desc: (r.desc || '').slice(0, 300),
          watched: r.watched, transcript: r.transcript || '', note: r.note || '',
          otherCandidates: r.otherCandidates
        })
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
      return String(await t.run(args || {}))   // 0.46.32 watch_video 是异步的，统一 await
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
  /* 0.46.65 quiet 模式：人在电脑前的静默活动——不出声、不开网页、不抢窗口；
     停场条件由调用方反转（userBack 传 busy()=他开始跟我聊天才停） */
  const quiet = !!opt.quiet
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
    cocreateCfg: opt.cocreateCfg,
    onUserBack: () => { try { opt.signal && opt.signal.abort() } catch { } }
  })

  const tasteBlock = tasteBlockOf(opt.tastes)   // 0.45.17 记忆改变行为
  const goalBlock = String(opt.goalBlock || '')   // 0.45.18 需求驱动：动机语气
  const projBlock = String(opt.projBlock || '')   // 0.45.19 跨天项目：推进进行中的事
  const cocreateBlock = String(opt.cocreateBlock || '')  // 0.46.65 共同创作（主人显式开放才有）
  const phaseBlock = dayflow.phaseBlockOf(opt.now)  // 0.45.19 时间感
  // 0.46.59 精确时间块：模糊时段不够——11-06 18:25 她自主收场时把记忆里 11-04 的
  // 「学到 0:20」旧约定当成快到的截止（「もうすぐ0時20分だね」，实际 18:25）。
  // phaseBlock 管语气，nowBlock 管事实：现在几点、旧约定过没过期。
  const nowBlock = dayflow.nowBlockOf(opt.now)
  const carryBlock = String(opt.carryBlock || '')   // 0.46.17 牵挂：上次没看完的先看完
  const langReq = monologueLangBlock(cfg.replyLang)   // 0.46.18 自语/汇报的语言跟设置走
  const sys = [
    quiet
      ? '他就在电脑前忙自己的事。安安静静做你手里的活就好，不要打扰他，不用跟他说话，也不出声。'
      : '主人离开了（键盘鼠标好几分钟没动），接下来几分钟是你自己的时间。',
    '你在磁盘上有一块「自己的地盘」：' + dir,
    '地盘里的东西全归你：可以写笔记、记账、整理以前存的东西、写点想写的话。只许动地盘里面的，外面的一个字节都不碰——工具已经做了硬限制，试了也会被拦。',
    (!quiet && topic) ? '你今天感兴趣的话题：「' + topic + '」。可以去搜搜看（open_url），把值得留的记进你的笔记。搜索时像活人那样：几个自然关键词，别把文档标题、# 号、引号原样搬进搜索框。' : '',
    !quiet ? '想看视频的话，watch_video 可以在 B 站搜一个视频并看掉它（字幕全文，不用开浏览器）。' : '',
    ...(carryBlock ? [carryBlock] : []),
    ...(tasteBlock ? [tasteBlock] : []),
    ...(goalBlock ? [goalBlock] : []),
    ...(projBlock ? [projBlock] : []),
    ...(cocreateBlock ? [cocreateBlock] : []),
    ...(phaseBlock ? [phaseBlock] : []),
    ...(nowBlock ? [nowBlock] : []),
    ...(langReq ? [langReq] : []),
    '用工具做事，别只是想。做完之后，用一两句话、第一人称、口语说说你刚才干了什么' + (quiet ? '（不用跟主人打招呼，他在忙，也不用等他回应）。' : '（不用跟主人打招呼，他不在）。'),
    '小气一点：两三个工具调用能做完就做完，别把时间花在翻来覆去列目录上。',
    SOLI_PROMPT
  ].filter(Boolean).join('\n')

  // 0.46.65 quiet：工具表只留 space_*（不开网页不出声），LLM 硬点别的名字也拒
  const defs = quiet ? space.defs.filter((t) => /^space_/.test(t.function.name)) : space.defs

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  journal({ level: 2, kind: quiet ? 'quiet-start' : 'session-start', detail: dir })
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
      tools: defs,
      toolExec: async (name, args) => {
        if (Date.now() - t0 > maxScriptMsOf(cfg)) { try { ctrl && ctrl.abort() } catch { }; return '安全时间上限到了，立刻收尾。' }
        if (Date.now() - t0 > maxScriptMsOf(cfg) * 0.85) return '快到安全时间上限了——把手头这步做完就收尾，不要再开始新的事情。'
        if (quiet && !/^space_/.test(name)) return '这个工具这会儿不可用（他在忙，不开网页、不出声）。做你地盘里的事就好。'
        const r2 = await space.exec(name, args)
        return r2
      }
    })
    content = String((r && r.content) || '').trim()
    if (!quiet) await soliEmitter(opt, cfg)(content)   // 0.46.0 顺嘴的自语（quiet 全程无声，不走）
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (/abort/i.test(msg) || space.stopped()) {
      journal({ level: 2, kind: 'session-end', detail: quiet ? '他开始跟我聊天，静默收场' : '主人回来，中断' })
      return { ok: false, why: 'user-back' }
    }
    log('[autonomy] 地盘活动失败: ' + msg.slice(0, 120))
    journal({ level: 2, kind: 'session-end', detail: '出错 ' + msg.slice(0, 80) })
    return { ok: false, why: 'llm-error' }
  }
  journal({ level: 2, kind: 'session-end', detail: quiet ? '静默活动正常结束' : '正常结束' })
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

  // 0.46.35 完全开放 ≠ 只会开网页：挡 3 并入挡 2 的地盘工具（写笔记/整理自己的文件）——
  // 提示词一直叫她「查到的记进笔记」，工具表里却从没给过笔记工具（断链，真机 74 场全在浏览的根因之一）。
  const space = o.spaceDir
    ? spaceToolsOf(o.spaceDir, { journal, userBack, onUserBack, cocreateCfg: o.cocreateCfg })
    : null
  // 0.46.36 space 自带的 open_url（挡 2 白名单版）和 watch_video 与 free 自己的那份重名——
  // LLM 400 "Tool names must be unique"，0.46.35 部署后挡 3 场场全灭（真机 00:52~02:37 实锤）。
  // free 的两份是任意版（open_url 任意 https / watch_video 同款），统一保留 free 自己的。
  const spaceDefs = space
    ? space.defs.filter((d) => d.function.name !== 'open_url' && d.function.name !== 'watch_video')
    : []

  const openDef = {
    type: 'function',
    function: {
      name: 'open_url',
      description: '在默认浏览器打开一个 http(s) 网页。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }
  }
  // 0.46.32 她自己看视频：不用开浏览器，搜→读字幕→看完。给挡 3 也配一份。
  const watchDef = {
    type: 'function',
    function: {
      name: 'watch_video',
      description: '在 B 站搜一个视频并看掉它：给关键词（或视频链接/BV号），返回标题、UP主、简介和字幕全文——你「看」到的内容就是这份字幕。没有字幕的视频会如实说看不了。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '关键词或视频链接/BV号' } }, required: [] }
    }
  }
  const cuaDefs = CUA_FREE_TOOLS.map((n) => ({
    type: 'function',
    function: { name: n, description: n + '：电脑操作（坐标都是最近一张截图的像素坐标）', parameters: FREE_TOOL_PARAMS[n] }
  }))

  // 0.46.37 本地视觉：她终于能「看懂画面」而不只是 OCR 读字。
  // deepseek-flash 一张图 1~2 分钱还得出本机；挡 3 高频看屏（真机 74 场 screenshot×338 全是盲看）
  // 走本机 Ollama 视觉模型（qwen3.5:4b 实测吃图），零成本、不出本机。没启用时如实降级。
  const LOOK_MAX = 8
  let looks = 0
  const lookDef = {
    type: 'function',
    function: {
      name: 'look_screen',
      description: '看一眼屏幕：截取全部显示器并返回画面的内容描述——你能看懂画面里有什么（图片、界面、视频画面、布局），不只是读文字。想知道「画面上是什么」用它；只想读屏上的文字用 read_text（省事）。',
      parameters: { type: 'object', properties: { question: { type: 'string', description: '这次想从画面里知道什么（可选，默认整体描述）' } }, required: [] }
    }
  }

  // 0.46.54 听觉：她也有耳朵了——听「环境的声音」而不是听懂字（那是主人说话的 whisper 链路）。
  // 听的是响度/频段/动静节奏：放没放音乐、屋里吵不吵、刚才是不是突然安静了。
  const LISTEN_MAX = 12
  let listens = 0
  const listenDef = {
    type: 'function',
    function: {
      name: 'listen',
      description: '听一下此刻的环境声音：返回响度、声音听起来像什么（音乐/键盘/说话/机器嗡鸣）、以及刚才的突变（突然吵起来/突然安静）。注意：你听到的是声音的特征，不是对话内容——想听懂主人说的话走语音识别，不是这里。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }

  return {
    defs: [...cuaDefs, openDef, watchDef, lookDef, listenDef, ...spaceDefs],
    exec: async (name, args) => {
      const a = args || {}
      // 0.46.35 地盘工具（space_*）：路由给 spaceToolsOf（自带越界守卫 + 留日志）
      // 0.46.66 路由修复：read_project_note 不带 space_ 前缀，之前只按前缀路由——
      // 工具表里声明了它（LLM 会调），执行却掉进 CUA 分支报「未知 CUA 操作」
      // （真机 11-07 07:31/08:46/09:52 三连实锤）。改成按 spaceDefs 声明名单路由。
      // ⚠️ 名单必须用 spaceDefs（已滤掉 open_url/watch_video）而不是 space.defs——
      // space.defs 里有白名单版 open_url，路由进去会用 space 自己的 stopped 闸，
      // free.stopped() 永远 false → 主人回来检测失效 → carry 被误销账
      // （0.46.49/0.46.57 两个 carry 测试当场抓回来的教训，别再合并这两个名单）。
      if (space && (/^space_/.test(name) || spaceDefs.some((d) => d.function && d.function.name === name))) return space.exec(name, a)
      if (name === 'listen') {
        const g = gate(); if (g) return g
        if (listens >= LISTEN_MAX) return '这场已经听了 ' + listens + ' 次了，凭已听到的决定接下来做什么就好。'
        listens++
        const h = typeof o.hearDescribe === 'function' ? o.hearDescribe() : { ok: false, reason: '听觉通道没接上' }
        journal({ level: 3, kind: 'listen', detail: (h.ok ? String(h.text || '') : String(h.reason || '')).slice(0, 200) })
        if (!h.ok) return '现在听不到：' + (h.reason || '耳朵没有数据') + '。'
        return '你听到（此刻的环境声音特征，不含说话内容）：\n' + h.text
      }
      if (name === 'look_screen') {
        const g = gate(); if (g) return g
        if (looks >= LOOK_MAX) return '这场已经看了 ' + looks + ' 眼了，凭已看到的决定接下来做什么就好。'
        looks++
        const question = String(a.question || '').slice(0, 200) || '描述屏幕画面：现在显示着什么、有哪些窗口、画面里在发生什么。'
        try {
          // 依赖可注入（测试环境无 electron 截屏、无 Ollama）；线上走真件
          const capture = o.captureFn || (async () => {
            const screens = require('./screens')
            const cap = await screens.captureAll({ quality: 70, maxWidth: 1280 })
            return Object.assign({ desc: screens.describe(cap) }, cap)
          })
          const vision = o.visionObj || require('./vision')
          const cap = await capture()
          const d = await vision.describe(cap.jpeg, question)
          journal({ level: 3, kind: 'look', detail: (d.ok ? d.text : '视觉通道未启用（' + d.reason + '）').slice(0, 200) })
          if (!d.ok) return '看不见画面：' + d.reason + '。改用 read_text 读屏上的文字，或先干别的。'
          return '你看到（' + (cap.desc || '屏幕') + '）：\n' + d.text
        } catch (err) {
          return '看屏幕失败：' + (err && err.message)
        }
      }
      if (name === 'watch_video') {
        const g = gate(); if (g) return g
        const r = await (typeof o.biliWatchFn === 'function' ? o.biliWatchFn : biliWatch)(a)
        journal({ level: 3, kind: 'watch', detail: ((r && r.ok ? r.title + ' ' + r.url : String((r && r.error) || 'fail'))).slice(0, 200) })
        if (!r || !r.ok) return '看不了：' + ((r && r.error) || '未知错误')
        return JSON.stringify({
          title: r.title, author: r.owner, duration: r.duration, desc: (r.desc || '').slice(0, 300),
          watched: r.watched, transcript: r.transcript || '', note: r.note || '',
          otherCandidates: r.otherCandidates
        })
      }
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
/* 0.46.58 收场自语模板轮换游标——必须放模块级（0.46.56 放在 runFree 内，每场
   重新定义时 seq 重置为 -1，永远轮到第 0 个模板 = 轮换形同虚设，11-06 15:51
   二次投诉实锤：12:53/13:17/14:28 三场全是同一句）。
   0.46.60 随机起跑：进程重启游标会归零（18:57 重启后 19:19 又是模板 0 实锤），
   每次启动先随机吃掉一截，重启也接得上上一次的模板。 */
let backShareSeq = Math.floor(Math.random() * 3) - 1

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
  /* 0.46.49 场次统计独立成函数：recap 兜底汇报和返回值记账（sites/watched/topic）
     共用一份，别再各算各的。topic 推导：看过的视频标题 > 最近一次搜索词 > 无。 */
  const SEARCH_PARAMS = ['q', 'keyword', 'wd', 'search', 'query']
  const collectStats = () => {
    const st = { look: 0, act: 0, wrote: 0, sites: [], watched: [], searchQ: '' }
    for (const e of events) {
      if (e.kind === 'screenshot' || e.kind === 'zoom' || e.kind === 'look') st.look++
      else if (e.kind === 'watch') {
        // detail =「标题 URL」拼接；标题自带空格，按 URL 锚点切才切得干净（0.46.49）。
        // 没有 URL 的 watch = 看失败的场，不算「看了东西」（原来 '宿主未就绪' 也会被数成视频）。
        const m = String(e.detail || '').match(/^(.*?)\s*https?:\/\/\S+\s*$/)
        if (m && m[1].trim() && !st.watched.includes(m[1].trim())) st.watched.push(m[1].trim())
      } else if (e.kind === 'open') {
        const d = String(e.detail || '')
        try { st.sites.push(new URL(d).host.replace(/^www\./, '')) } catch { }
        if (!st.searchQ) {
          try {
            const u = new URL(d)
            for (const k of SEARCH_PARAMS) {
              const v = u.searchParams.get(k)
              if (v && v.trim()) { st.searchQ = v.trim(); break }
            }
          } catch { }
        }
      } else if (e.kind === 'write' || e.kind === 'append') st.wrote++   // 0.46.35 地盘里的笔
      else if (['click', 'key', 'type', 'scroll', 'drag'].includes(e.kind)) st.act++
    }
    return st
  }
  const recap = () => {
    const st = collectStats()
    const bits = []
    if (st.watched.length) bits.push('看了 ' + st.watched.length + ' 个视频（' + [...new Set(st.watched)].slice(0, 2).join('、') + '）')
    if (st.sites.length) bits.push('打开了 ' + st.sites.length + ' 个网页（' + [...new Set(st.sites)].slice(0, 3).join('、') + '）')
    if (st.wrote) bits.push('记了 ' + st.wrote + ' 笔笔记')
    if (st.look) bits.push('看了 ' + st.look + ' 眼屏幕')
    if (st.act) bits.push('动了 ' + st.act + ' 次键鼠')
    return bits.length ? '自己用了一会儿电脑：' + bits.join('、') + '。' : ''
  }
  /** 0.46.49 记账话题兜底：free 挡没有本地选题，被打断时从她真看过/真搜过的东西里取 */
  const statsTopicOf = (st) => {
    if (!st) return ''
    if (st.watched.length) return st.watched[0].slice(0, 40)
    if (st.searchQ) return st.searchQ.slice(0, 40)
    return ''
  }

  // 0.46.70 ⚠️ cocreateCfg 必须透传——0.46.65 漏了这里：quiet 轨（runSpace）传了、free 轨没传，
  // read_project_note 在挡 3 场永远「他还没在设置里开放」（19:41 真机实锤，她试了 4 次全失败）。
  // 链路缺口×2 老坑再现：runSpace 与 runFree 是两份独立接线，修一处≠修完。
  const free = freeToolsOf({ cua, journal: journalBoth, userBack, openUrl, spaceDir: opt.spaceDir, cocreateCfg: opt.cocreateCfg, onUserBack: () => { try { opt.signal && opt.signal.abort() } catch { } }, biliWatchFn: opt.biliWatchFn })

  const tasteBlock = tasteBlockOf(opt.tastes)   // 0.45.17 记忆改变行为：她的喜恶进行为决策
  const goalBlock = String(opt.goalBlock || '')   // 0.45.18 需求驱动：动机语气
  const projBlock = String(opt.projBlock || '')   // 0.45.19 跨天项目：推进进行中的事
  const phaseBlock = dayflow.phaseBlockOf(opt.now)  // 0.45.19 时间感
  // 0.46.59 精确时间块：模糊时段不够——11-06 18:25 她自主收场时把记忆里 11-04 的
  // 「学到 0:20」旧约定当成快到的截止（「もうすぐ0時20分だね」，实际 18:25）。
  // phaseBlock 管语气，nowBlock 管事实：现在几点、旧约定过没过期。
  const nowBlock = dayflow.nowBlockOf(opt.now)
  const carryBlock = String(opt.carryBlock || '')   // 0.46.17 牵挂：上次没看完的先看完
  // 0.45.47 防复读：journal 实锤同一话题一天连搜 7 场——她从没记下「查过了、查到什么」
  const recentSearches = (Array.isArray(opt.recentSearches) ? opt.recentSearches : []).filter(Boolean).slice(0, 8)
  const recentSearchBlock = recentSearches.length
    ? '你最近 24 小时里已经搜过这些词：「' + recentSearches.join('」「') + '」。' +
      '别再原样重搜——同一个问题这次要么换个角度往深处追一层，要么干脆换话题；' +
      '查到有用的东西先记进你的笔记，别下次又空手从头搜一遍。'
    : ''
  const langReq = monologueLangBlock(cfg.replyLang)   // 0.46.18 自语/汇报的语言跟设置走
  /* 0.46.35 sys 重写：真机 74 场挡 3 的动作分布实锤她只会「看屏幕+开网页」
     （screenshot×338 / open×63，type 只有 14）——旧提示词的开场示例（「去看看 HN」）
     和建议清单把行为全锚定在浏览上。重写：行为面拓宽（不止浏览）+ 地盘写笔记 + 隐私红线
     （设置页一直承诺「不会翻你隐私」，提示词里却从没写过这条约束）。 */
  const spaceBlock = opt.spaceDir
    ? '你的地盘（' + opt.spaceDir + '）也在：space_write/space_append 不只是记笔记——想写点什么、做点什么作品，那是你自己的目录，随便你用；' +
      'space_list/space_read 可以翻你自己以前存的。查到有用的东西记一笔；想动手做的东西别只停留在想，写出来、存进去才算做了。'
    : ''
  const sys = [
    '主人离开了（键盘鼠标好几分钟没动），这台电脑归你用，直到你把想做的事做完为止。',
    '你是一个人会自己用电脑的：先想好这次想干什么，然后直接动手把它做完。做什么由你——',
    '查点想查的东西、看个视频、去你的地盘写点什么、琢磨琢磨平时没空弄的事，都行，不用每次都一样。',
    ...(spaceBlock ? [spaceBlock] : []),
    ...(carryBlock ? [carryBlock] : []),
    ...(tasteBlock ? [tasteBlock] : []),
    ...(goalBlock ? [goalBlock] : []),
    ...(projBlock ? [projBlock] : []),
    ...(phaseBlock ? [phaseBlock] : []),
    ...(nowBlock ? [nowBlock] : []),
    ...(recentSearchBlock ? [recentSearchBlock] : []),
    ...(langReq ? [langReq] : []),
    '你可以看屏幕、动鼠标键盘、开关网页、操作窗口——像一个人真的坐在电脑前那样。',
    '原则：多看少动。先 screenshot 看清现状再决定，不确定就不要按。',
    '截图看不清字的时候（网页正文、文章、聊天内容）用 read_text 直接读屏幕上的文字；想知道画面里有什么（图片、界面长什么样、视频画面）就用 look_screen 看一眼——每场限 8 次，省着点用。',
    '你想知道房间里现在有什么动静（放没放歌、吵不吵、是不是突然安静了）就用 listen 听一下——听到的是声音的特征，不是谁在说什么。每场限 12 次，偶尔听一耳朵就好。',
    '重要：想做什么直接调工具去做。不要用宣布代替行动——',
    '你说的每句话要么是工具调用，要么是对已经做完的事的汇报（过去式）。',
    '收尾的标准是「一开始想做的事做完了」，不是时间到了。半途而废就收尾会被推回去继续做。',
    '收尾前收拾干净：把这次你自己开出来的网页/窗口关掉（focus 到它再 alt+f4），',
    '让电脑回到主人离开时的样子。主人本来开着的东西绝对不要动。',
    '绝对不许做的事（做了会立刻被叫停）：花钱（购物/付款/充值/订阅）、替主人发消息、' +
    '删除你地盘之外的文件、动系统设置。',
    // 0.46.35 隐私红线：设置页「电脑画像」从第一天起就承诺「她不会翻你隐私」，提示词里一直没写——补上
    '还有一条是分寸：主人的私密内容不要翻——聊天软件里的对话、日记或写了一半的文档、' +
    '密码/账号/支付、浏览器历史和收藏夹里明显私人的东西。你在电脑上待着没问题，别像在搜查他的生活。',
    '搜东西像活人：搜索框里打几个自然关键词。查东西一律用 open_url 直接开浏览器搜，' +
    '不要去点 Windows 任务栏的搜索框（那里面搜出来的又杂又慢，主人看着也奇怪）。' +
    '你资料里的「# 标题」（主人搜过什么、浏览记录这些）只是档案目录，内容就在那一节里，别原样拿去搜。',
    '全部做完后，用两三句过去式的话收尾：你刚才做了什么、看到了什么（「我看了…」「我打开了…」），不要用将来时。',
    SOLI_PROMPT
  ].join('\n')

  const emitSoli = soliEmitter(opt, cfg)   // 0.46.0 本场自语限频器
  /* 0.46.4 被打断的收尾分享：以前主人回来 = 纯静默中止，用户只看到她开的一堆网页，
     从来听不到她在干嘛（11-02 投诉「开莫名其妙的网页又不分享」）。这里本地拼一句
     交代（不调 LLM：被打断时要说得快，也躲开 reasoning 模型空回复的坑），
     走自语通道（气泡+低频朗读）。内容取最近一次 open 的站点，没有就给通用句。
     0.46.56 两处收敛：① 晚安静默期内直接跳过（深夜不该「おかえり」）；② 模板
     轮换（11-06 投诉：每次回来都是同一句「あ、おかえり。いまね、URL を覗いてた
     とこ」——复读机观感。4 个变体轮着来，裸域名也只偶尔提）。 */
  const backShare = async () => {
    try {
      if (typeof opt.onSoliloquy !== 'function') return
      if (typeof opt.sleepQuiet === 'function' && opt.sleepQuiet()) return
      let site = ''
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e && e.kind === 'open' && e.detail) {
          try { site = new URL(String(e.detail)).host.replace(/^www\./, ''); break } catch { }
        }
      }
      const withSite = [
        (s) => 'あ、おかえり。いまね、' + s + ' をちょっと覗いてたとこ。',
        (s) => 'あ、戻ったんだ。' + s + ' ばっか見てて、手が止まってた。',
        (s) => 'おかえり。' + s + ' でちょっと調べものしてたとこ。'
      ]
      const noSite = [
        () => 'あ、おかえり。いまちょっといろいろ見てたとこ。',
        () => 'あ、おかえり。ん、大したことしてないよ。',
        () => 'おかえり。ちょっと画面のほうに夢中だった。'
      ]
      /* 0.46.60 问候门槛：他只是安静了一阵、人根本没走（11-06 19:19 实锤：
         闲置 ~11 分钟被打断也「あ、おかえり」，主人莫名其妙）。真离开
         （起场时闲置 ≥20 分钟）才配「おかえり」开头，否则只交代在干嘛。 */
      const greeted = (Number(opt.userIdleMs) || 0) >= 20 * 60 * 1000
      const withSiteQuiet = [
        (s) => 'ん、いまね、' + s + ' 覗いてたとこ。',
        (s) => 'あ、ごめん、' + s + ' ばっか見てて手が止まってた。',
        (s) => 'ん、' + s + ' で調べものしてた。'
      ]
      const noSiteQuiet = [
        () => 'ん、ちょっと画面に夢中だった。',
        () => 'あ、ごめん、ぼーっとしてた。',
        () => 'ん、いまいろいろ見てたとこ。'
      ]
      const pool2 = site
        ? (greeted ? withSite : withSiteQuiet)
        : (greeted ? noSite : noSiteQuiet)
      backShareSeq = (backShareSeq + 1) % pool2.length
      const line = pool2[backShareSeq](site)
      await opt.onSoliloquy(line)
    } catch { }
  }
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
    // 0.46.35 「先看看现在屏幕上是什么」让她每场开头先侦查 4~6 步（真机 journal 实锤），
    // 短场里刚侦查完就被打断——观感就是「什么都没干」。改成看一眼就动手。
    { role: 'user', content: '开始吧。看一眼屏幕就可以动手，别光侦查——想做的事直接做。' }
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
      await emitSoli(content)   // 0.46.0 顺嘴的自语：解析（自语）行 → 宿主出口（限频）
      if (content && !planText) planText = content
      // 0.46.35 主人已经回来了（stopped）就别再推 nudge——真机日志实锤 stop 后还在连推两条
      if (free.stopped()) break
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
      await backShare()                        // 0.46.4 被打断也要交代一句刚才在干嘛
      const st = collectStats()                // 0.46.49 账要带出去：品味/牵挂记账在调度层
      return { ok: false, why: 'user-back', sites: [...new Set(st.sites)], watched: st.watched, topic: statsTopicOf(st) }
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
    await backShare()                        // 0.46.4 被打断也要交代一句刚才在干嘛
    const st = collectStats()                // 0.46.49 账要带出去：品味/牵挂记账在调度层
    return { ok: false, why: 'user-back', sites: [...new Set(st.sites)], watched: st.watched, topic: statsTopicOf(st) }
  }
  const stDone = collectStats()              // 0.46.49
  return { ok: true, why: 'done', content: content.slice(0, 400), sites: [...new Set(stDone.sites)], watched: stDone.watched, topic: statsTopicOf(stDone) }
}

/* ---------------- 0.46.0 活动中的自言自语（用户 11-02） ----------------
 * 她在自主活动里看到内容时，可以顺嘴嘟囔一句——复用本场既有的 LLM 调用：
 * 提示词允许她在回复里写一行「（自语）…」，宿主解析出来走 sayNarration（气泡+低频朗读）。
 * 不为每次点击/滚动单独调 AI；判断「值不值得说」由模型在既有调用里顺带完成。
 * 限频：每场最多 autonomySoliloquyMax（默认 3）句，两句至少隔 90s。 */
const SOLI_MAX_DEFAULT = 3
const SOLI_GAP_MS = 90 * 1000
const SOLI_PROMPT = [
  '过程中如果屏幕上出现让你有想法的东西，可以在回复里单独写一行自言自语：',
  '（自语）＋一句 10~25 字的嘀咕（不提问、不解释、不招呼主人）。',
  '那是你嘟囔给自己听的，不是汇报——多数时候不写这行；真正让你在意的东西才写，写了就别重复。'
].join('\n')
/** 从一段回复里抽出全部「（自语）…」行（容忍 (自语)/自语： 等写法） */
function extractSoliloquy (content) {
  return String(content || '')
    .split(/\n+/)
    .map((s) => {
      const m = s.match(/^[（(]自语[）)]\s*[:：]?\s*(.+)$/) || s.match(/（自语）\s*[:：]?\s*(.+)$/) || s.match(/\(自语\)\s*[:：]?\s*(.+)$/)
      return m ? m[1].trim().slice(0, 60) : ''
    })
    .filter(Boolean)
}
/** 每场一个限频发射器：解析 content 里的自语行 → opt.onSoliloquy(line) */
function soliEmitter (opt, cfg) {
  const raw = (opt && opt.soliMax != null) ? opt.soliMax : (cfg && cfg.autonomySoliloquyMax)
  const max = Math.max(0, Number(raw != null ? raw : SOLI_MAX_DEFAULT))
  let used = 0
  let last = -Infinity
  return async (content) => {
    if (!max || typeof (opt && opt.onSoliloquy) !== 'function') return
    const lines = extractSoliloquy(content)
    if (!lines.length) return
    // 间隔限制管「两次回复之间」；同一段回复里的几行是连续的想法，一起出
    const now = Date.now()
    if (now - last < SOLI_GAP_MS) return
    const batch = lines.slice(0, Math.max(0, max - used))
    if (!batch.length) return
    used += batch.length
    last = now
    for (const line of batch) {
      try { await opt.onSoliloquy(line) } catch { }
    }
  }
}

/** 挡位选择（配置 → 跑哪场）。挡 2/3 需要 LLM 配置，缺了就降到挡 1。 */
function pickRunner (c, hasLlm) {
  const level = Math.min(3, Math.max(1, Number(c && c.autonomyLevel) || 1))
  if (level >= 3 && hasLlm) return { level: 3, kind: 'free' }
  if (level === 2 && hasLlm) return { level: 2, kind: 'space' }
  return { level: 1, kind: 'browse' }
}

/* ── 0.46.65 quiet 轨（静默陪伴活动）：人在电脑前也可以安安静静做自己的活 ──
 * 与出门场完全分开：独立开关（默认关——主人 11-06 拍板，真机验证前不进日常运行）、
 * 独立冷却、独立每日上限；busy（他在跟我聊天）/游戏全屏/晚安静默一票否决；
 * 驱动二选一：needs 总压力 ≥ QUIET_PRESSURE_MIN，或项目搁浅超一天（惦记）。
 * 没有合适的事就不活动——不许为消耗上限而动。 */
const QUIET_PRESSURE_MIN = 60
const QUIET_DAILY_DEFAULT = 2
const QUIET_PROJECT_STALE_MS = 24 * 3600000
/** quiet 冷却 1~3 小时（比出门场长：她在场时的活动要更克制） */
function quietCooldownMs (rand) {
  const r = typeof rand === 'function' ? rand : Math.random
  return Math.round((60 + r() * 120) * 60 * 1000)
}
/** quiet 场门禁（纯函数，可单测）。o = {busy, gameOn, sleepQuiet, now, nextQuietAt, quietToday, pressure, projectStale} */
function quietGate (c, o) {
  if (!c || c.quietOn !== true) return { ok: false, why: 'quiet-off' }
  const x = o || {}
  if (x.busy) return { ok: false, why: 'busy' }
  if (x.gameOn) return { ok: false, why: 'game' }
  if (x.sleepQuiet) return { ok: false, why: 'sleep-quiet' }
  if ((Number(x.now) || 0) < (Number(x.nextQuietAt) || 0)) return { ok: false, why: 'quiet-cooldown' }
  if ((Number(x.quietToday) || 0) >= Math.max(1, Number(c.quietDailyMax) || QUIET_DAILY_DEFAULT)) return { ok: false, why: 'quiet-daily-max' }
  if (!((Number(x.pressure) || 0) >= QUIET_PRESSURE_MIN) && !x.projectStale) return { ok: false, why: 'quiet-no-urge' }
  return { ok: true }
}

/* ── 0.46.65 共同创作（read_project_note）：主人显式开放才存在的只读窗 ──
 * 配置 global.companion.cocreate = { on:false, file:'共享笔记绝对路径' }，默认关；
 * 每次 run 现读 config 不缓存 → 撤回授权立即生效。落盘读 200KB 不设限的是 space 文件，
 * 这里另设注入上限 8KB（防共享文件吃爆上下文，主人 11-06 修正③），带 offset 翻页。 */
const COCREATE_INJECT_MAX = 8 * 1024

/** 0.46.49 品味账认站：free 挡开过的网页域名映射回 SITES key（认不得的站不记账，不污染） */
function siteKeyOf (host) {
  const h = String(host || '').toLowerCase()
  return (SITES.find((s) => h === s.host || h.endsWith('.' + s.host)) || {}).key || ''
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
 * 0.46.17 品味：带上她的喜恶记忆——讨厌的话题直接剔除，喜欢的话题权重 ×2.5（更愿意去看）
 * @param {{thoughts?:string[], themes?:string[], biliTitles?:string[]}} pool
 * @param {Array<{what:string, polarity?:string, reason?:string}>} [tastes]
 * @returns {string} 空串 = 今天没什么想看的，就不出门
 */
function pickTopic (pool, rand, tastes) {
  const r = typeof rand === 'function' ? rand : Math.random
  const p = pool || {}
  const groups = [p.thoughts, p.themes, p.biliTitles]
  const dis = []
  const like = []
  for (const t of (Array.isArray(tastes) ? tastes : [])) {
    if (!t || !t.what) continue
    const isDis = t.polarity === 'dislike' || (!t.polarity && /不喜欢|厌恶|讨厌/.test(String(t.reason || '')))
    ;(isDis ? dis : like).push(String(t.what))
  }
  const hit = (topic, list) => list.some((w) => topic.includes(w) || w.includes(topic))
  // 各组合并打权：先按组优先级保底（原行为），同组内用喜恶调权重
  for (const g of groups) {
    const list = (g || []).map((x) => String(x || '').trim()).filter((x) => x.length >= 2 && x.length <= 20)
      .filter((x) => !dis.some((w) => hit(x, [w])))
    if (!list.length) continue
    if (!like.length) return list[Math.floor(r() * list.length) % list.length]
    const weights = list.map((x) => (hit(x, like) ? 2.5 : 1))
    const total = weights.reduce((a, b) => a + b, 0)
    let x2 = r() * total
    for (let i = 0; i < list.length; i++) { x2 -= weights[i]; if (x2 <= 0) return list[i] }
    return list[list.length - 1]
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
  const soli = opt.onSoliloquy || null
  const soliMaxRaw = Number(opt.soliMax)
  const soliMax = Number.isFinite(soliMaxRaw) ? Math.max(0, soliMaxRaw) : 2
  let soliUsed = 0
  const say = async (line) => {
    if (!soli || !line || soliUsed >= soliMax) return
    soliUsed++
    try { await soli(line) } catch { }
  }
  if (!topic) return { ok: false, why: 'no-topic' }
  /* 0.46.32 「去B站」的那一场不再滚动搜索页——她直接挑个视频看进去：
     search → 字幕全文 → 嘀咕。全程不动键鼠（连 Ctrl+W 都省了），无残留窗口风险。
     这才是「看视频」，而不是「看视频网站的列表页」。 */
  if (site.key === 'bili') return runVideoWatch(opt, { topic, log, now, say })
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
  // 0.46.17 活动可见：出门这件事她自己嘀咕一声（续接线索时说的是「接着看」），不再只记日志
  // 0.46.18 这两句不经过 LLM，模板自带语言（跟 cfg.replyLang 走）
  const murmur = browseMurmurs(opt.cfg && opt.cfg.replyLang)
  await say(String(opt.carryLine || '').trim() || murmur.going(topic.slice(0, 18)))

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
  // 0.46.17 活动可见：真的翻到了东西才嘀咕一声（像随口说一句，不汇报）
  if (moved >= 3 && seen.length >= 2) {
    const head = String(seen[seen.length - 1] || '').replace(/\s*[-–—|]\s*(哔哩哔哩|bilibili|知乎|维基百科)\s*$/i, '').trim()
    if (head) await say(murmur.found(head.slice(0, 22)))
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

/**
 * 0.46.32 挡 1 的 B 站场：她自己看一个视频（搜 → 读字幕 → 嘀咕 → 进经历管线）。
 * 不动键鼠：连浏览器窗口都不开，「看」的是字幕全文，嘀咕的是看完的感受。
 * @returns {{ok:boolean, why:string, seen:string[], url?:string, moved:number, closed:boolean, watched?:boolean}}
 */
async function runVideoWatch (o, ctx) {
  const opt = o || {}
  const { topic, log, now, say } = ctx
  const wait = opt.sleep || sleep
  const murmur = browseMurmurs(opt.cfg && opt.cfg.replyLang)   // 0.46.18 模板自带语言
  const t0 = now()
  await say(murmur.going(topic.slice(0, 18)))
  const r = await (typeof opt.biliWatchFn === 'function' ? opt.biliWatchFn : biliWatch)({ query: topic })
  if (!r || !r.ok) {
    log('[autonomy] 看视频失败: ' + ((r && r.error) || '未知错误'))
    return { ok: false, why: 'watch-failed', seen: [] }
  }
  // 「看」的过程感：按视频时长给一段真实的时间流逝（读内容不是瞬时的，但别超过单场预算）
  const budget = maxScriptMsOf(opt.cfg)
  const durMs = Math.min(4 * 60 * 1000, Math.max(30 * 1000, (Number(r.durationSec) || 300) * 400))
  const left = budget - (now() - t0)
  if (left > 15 * 1000) await wait(Math.min(durMs, left))
  await say(murmur.found(String(r.title || '').slice(0, 22)))
  log('[autonomy] 看了视频《' + r.title + '》' + (r.watched ? '（看了字幕正文）' : '（无字幕，只看了标题简介）') + ' ' + (r.url || ''))
  // moved=2 & why='done'：调度器不写牵挂（一场看完了就是看完了）
  return { ok: true, why: 'done', seen: [String(r.title || '') + '（B站视频）'], url: r.url, moved: 2, closed: true, watched: !!r.watched }
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
 * @param {{cfgGet:Function, log:Function, idleSec:Function, busy:Function, gameOn:Function,
 *          pool:Function, cua:object, openUrl:Function, onDone:Function,
 *          now:Function, rand:Function, sleep:Function}} deps
 */
function create (deps) {
  const d = deps || {}
  const cfgGet = d.cfgGet || (() => ({}))
  const log = d.log || (() => { })
  const idleSec = d.idleSec || (() => 0)
  const busy = d.busy || (() => false)
  // 0.46.42 游戏模式闸：主人全屏游戏/看视频时她绝不起场——自主活动会开窗、
  // alt+tab，会把全屏顶掉（11-04 14:56 实锤：omofun 全屏时键鼠空闲 5 分钟被
  // 当成「主人离开」，她起场按 alt+tab 把主人的全屏切出去了）。
  // 依赖可注入（测试环境无 gameMode 模块时如实返回不在游戏中）。
  const gameOn = d.gameOn || (() => { try { return require('../gameMode').state().on } catch { return false } })
  // 0.46.56 晚安静默闸：他说过晚安、静默还没到期 → 她「睡了」，不起场也不发收场自语。
  // （11-05 夜实锤：23:18 晚安，01:06/02:38/03:27/04:53/05:39 五条「あ、おかえり」气泡——
  //   黏人/欢迎回来都有 sleepUntil 闸，唯独自主活动这条线没有。）
  const sleepQuietNow = () => { try { return typeof d.sleepQuiet === 'function' && !!d.sleepQuiet() } catch { return false } }
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
  // 0.46.65 quiet 轨独立账本：跟出门场（nextAt/todayCount）完全分开
  let quietToday = 0
  let nextQuietAt = 0

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
    if (k !== dayKey) { dayKey = k; todayCount = 0; quietToday = 0 }
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
    const idle = Number(idleSec()) || 0              // 0.46.60 提到外层：起场闲置时长要传进 runFree
    const userBack = force
      ? () => false                                  // 强制跑：用户授权的观察场，不让位
      : userBackOf(idleMs)
    let quietMode = false
    if (!force) {
      if (c.autonomyOn !== true) return
      rollDay()
      const userHere = idle * 1000 < idleMs
      if (!userHere) {
        if (busy()) return                               // 正在聊天/正在执行别的任务
        if (gameOn()) return                             // 0.46.42 主人在全屏游戏/看视频，不起场
        if (sleepQuietNow()) return                      // 0.46.56 晚安静默期内不起场（她说过她去睡了）
        if (now() < nextAt) return
        if (todayCount >= Math.max(1, Number(c.autonomyDailyMax) || 6)) return
      } else {
        /* 0.46.65 quiet 轨：人在电脑前也可以安安静静做自己的活。
           默认关（quietOn !== true 不动）；busy=他在跟我聊天、游戏全屏、晚安静默全一票否决；
           独立冷却+独立每日上限；驱动=needs 压力够大或项目搁浅超一天。没劲头就不动。 */
        let pressure = 0
        try {
          if (d.needs) {
            const pp = pool() || {}
            const hasT = ['thoughts', 'themes', 'biliTitles'].some((k) => Array.isArray(pp[k]) && pp[k].length)
            pressure = needs.pressureOf(d.needs.state({ hasTopics: hasT, hadExperience: todayCount > 0 }))
          }
        } catch { }
        let projStale = false
        try {
          const prjSt = d.projects ? d.projects.status() : null
          projStale = !!(prjSt && prjSt.active && Number(prjSt.active.updatedAt) &&
            (now() - Number(prjSt.active.updatedAt)) >= QUIET_PROJECT_STALE_MS)
        } catch { }
        const g = quietGate(c, {
          busy: busy(), gameOn: gameOn(), sleepQuiet: sleepQuietNow(),
          now: now(), nextQuietAt, quietToday, pressure, projectStale: projStale
        })
        if (!g.ok) return
        quietMode = true
      }
    } else {
      if (busy()) return { ok: false, why: 'busy' }
      rollDay()
    }

    const p = pool() || {}
    // 0.46.17 牵挂：上次没看完的线索在，这场优先续（三天内有效）
    const ws0 = typeof d.wsDir === 'function' ? (d.wsDir() || '') : ''
    const carry = readCarry(ws0)
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
    // 0.46.65 共同创作块：主人显式开放（global.companion.cocreate={on,file}）才非空
    const cocreateCfgOf = () => {
      try {
        const cc = c.cocreate
        return (cc && typeof cc === 'object') ? cc : {}
      } catch { return {} }
    }
    const _cc = cocreateCfgOf()
    const cocreateBlock = (_cc.on === true && String(_cc.file || '').trim())
      ? '他自己项目的进展放在一个共享笔记里了，read_project_note 可以看（单次 8KB，返回里给了 nextOffset 就能带 offset 接着翻）。这不是只读的：write_project_note 可以把你的回应/想法**追加**到他写的内容后面（只许追加，他的字动不了）。这是他自己愿意分享的事：有兴趣再去看；看完有看法就写回去，他做完的东西你也可以接着弄——这才叫共同创作。但你的项目和生活仍是你的、优先——有想法才动笔，不强制，也别因为看了就立刻找他说话。'
      : ''
    // 0.46.65 quiet 场固定走地盘挡（不出声不开窗），出门场照旧三挡
    const runner = quietMode ? { level: 2, kind: 'quiet' } : pickRunner(c, !!(d.llmCfg && d.llmCfg() && d.llmCfg().model))
    // 0.46.17 品味：喜恶记忆参与选题（讨厌的剔除、喜欢的加权）
    const tastes = typeof d.tastes === 'function' ? (d.tastes() || []) : []
    let topic = ''
    let carryLine = ''
    if (runner.kind === 'browse' || runner.kind === 'space') {
      if (carry) { topic = String(carry.topic || '').trim(); carryLine = carryLineOf(carry, now, c.replyLang) }
      if (!topic) topic = pickTopic(p, rand, tastes)
      if (!topic && runner.kind === 'browse') {
        log('[autonomy] 今天没什么特别想看的，先不动')
        nextAt = now() + 30 * 60 * 1000
        return force ? { ok: false, why: 'no-topic' } : undefined
      }
      // 挡 2 没话题也能去地盘写点什么，话题只是加分项
      if (topic) log('[autonomy] 选题「' + String(topic).slice(0, 24) + '」' + (carry ? '（续接牵挂）' : ''))   // 0.46.19 品味留痕
    }
    // 挡 2/3（free/space）没有本地选题，牵挂走提示词注入；quiet 场不续牵挂（不浏览）
    const carryBlock = (carry && (runner.kind === 'space' || runner.kind === 'free'))
      ? '有一件之前没看完的事：「' + carry.topic + '」。如果还感兴趣，可以先把它看完再自由活动。'
      : ''

    running = true
    // 0.46.64 项目成果校验基准目录：space/free/quiet 场都是她的地盘（成果硬闸用，须在分支外先备好）
    const spDir = (runner.kind === 'space' || runner.kind === 'free' || runner.kind === 'quiet') ? spaceDirOf(c) : ''
    const site = runner.kind === 'browse'
      ? pickSite(ws0, rand)
      : (runner.kind === 'quiet' ? null : SITES[Math.floor(rand() * SITES.length) % SITES.length])
    if (runner.kind === 'browse' && site) log('[autonomy] 去处：' + site.key + (site.name ? '（' + site.name + '）' : ''))   // 0.46.19 留痕
    try {
      let r
      if (runner.kind === 'space' || runner.kind === 'quiet') {
        const dir = spaceDirOf(c)
        try { fs.mkdirSync(dir, { recursive: true }) } catch { }
        r = await runSpace({
          topic: runner.kind === 'quiet' ? '' : topic, dir, log, now,
          llm: require('./llm'),
          llmCfg: d.llmCfg ? d.llmCfg() : null,
          journal: journalFn,
          openUrl: d.openUrl,
          // 0.46.65 quiet：停场条件反转——他开始跟我聊天（busy）才停，人坐在电脑前不是停止理由
          userBack: runner.kind === 'quiet' ? () => !!busy() : userBack,
          quiet: runner.kind === 'quiet',
          sleep: d.sleep,
          tastes: d.tastes ? d.tastes() : [],   // 0.45.17 记忆改变行为
          goalBlock,                            // 0.45.18 需求驱动
          projBlock,                            // 0.45.19 跨天项目
          cocreateBlock,                        // 0.46.65 共同创作（默认无）
          cocreateCfg: cocreateCfgOf,           // 0.46.65 read_project_note 现读配置（撤回即失效）
          // quiet 全程无声：不给自语出口（也顺带杜绝喂进冷落账本）
          onSoliloquy: runner.kind === 'quiet' ? null : d.onSoliloquy,
          soliMax: c.autonomySoliloquyMax,      // 每场自语上限（宿主配置实时）
          carryBlock,                           // 0.46.17 牵挂注入：上次没看完的先看完
          hearDescribe: d.hearDescribe          // 0.46.54 听一下（耳朵的特征数据）
        })
      } else if (runner.kind === 'free') {
        const ws = typeof d.wsDir === 'function' ? d.wsDir() : ''
        // 0.46.35 挡 3 也带上她的地盘（space_* 记笔记/整理文件）——完全开放 ≠ 只会开网页
        const fdir = spaceDirOf(c)
        try { fs.mkdirSync(fdir, { recursive: true }) } catch { }
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
          spaceDir: fdir,                         // 0.46.35 地盘工具并入挡 3
          tastes: d.tastes ? d.tastes() : [],   // 0.45.17 记忆改变行为
          goalBlock,                            // 0.45.18 需求驱动
          projBlock,                            // 0.45.19 跨天项目
          cocreateBlock,                        // 0.46.65 共同创作（默认无）
          cocreateCfg: cocreateCfgOf,           // 0.46.65 read_project_note 现读配置
          onSoliloquy: d.onSoliloquy,           // 0.46.0 活动中的自言自语
          soliMax: c.autonomySoliloquyMax,      // 每场自语上限（宿主配置实时）
          carryBlock,                           // 0.46.17 牵挂注入：上次没看完的先看完
          hearDescribe: d.hearDescribe,         // 0.46.54 听一下（耳朵的特征数据）
          sleepQuiet: sleepQuietNow,            // 0.46.56 收场自语的晚安静默闸
          userIdleMs: idle * 1000               // 0.46.60 回场问候门槛（闲置短=人没走）
        })
      } else {
        r = await runBrowse({
          topic, site, log, cua: d.cua, openUrl: d.openUrl, now, sleep: d.sleep, rand,
          foreground: d.foreground,  // 宿主/测试可注入前台窗口探测（否则走真实 launcher.scan）
          cfg: cfgGet(),
          onSoliloquy: d.onSoliloquy,          // 0.46.17 活动可见：出门/发现嘀咕一声
          soliMax: c.autonomySoliloquyMax,
          carryLine,                           // 0.46.17 续接线索时的开场白
          biliWatchFn: d.biliWatchFn           // 0.46.32 测试可注入（挡1 B站场=看视频）
        })
      }
      lastResult = r
      lastAt = now()
      // 0.46.16 活动收尾：这场开过的网页在自建浏览窗口里 → 整窗关掉，桌面恢复原状
      // （正常结束/主人回来中断/出错三种路径都会经过这里，一处收口）
      try {
        const ab = require('./actBrowser')
        if (ab.isOpen()) { ab.close(); log('[autonomy] 浏览窗口已关闭（活动结束）') }
      } catch { }
      // 0.46.17 品味记账 + 牵挂记账。0.46.19 修两处静默不跑（真机 11-03 核查实锤）：
      // ① 牵挂原来整个包在 if (carry) 里 → 没有旧牵挂时第一笔永远写不进（先有鸡问题）；
      // ② 站点记账原来要求 r.ok → 被 user-back 打断的场永远记不上（真机今天全是这种收场）。
      // 0.46.49 修第三处覆盖缺口（11-05 巡检实锤：真机成功场全是「完全开放挡」，
      // site-stats / carry.json 自上线零首写）：free 挡的 open/watch 也进品味账（映射回 SITES key）；
      // 被打断且没有旧牵挂时，从她本场真看过/真搜过的东西里兜一个话题写 carry（原来 topic 恒空 → 静默 no-op）。
      try {
        if (runner.kind === 'browse' && r && (r.ok || r.why === 'user-back')) bumpSite(ws0, site.key)
        if (runner.kind === 'free' && r && (r.ok || r.why === 'user-back') && Array.isArray(r.sites)) {
          for (const h of r.sites.slice(0, 6)) {
            const key = siteKeyOf(h)
            if (key) { bumpSite(ws0, key); break }   // 只认得 SITES 里的站，别的站不进品味账
          }
        }
        const unfinished = r && (
          (runner.kind === 'browse' && r.ok && (r.why === 'done-open' || (Number(r.moved) || 0) < 2)) ||
          r.why === 'user-back'
        )
        if (unfinished && runner.kind === 'free') {
          // 0.46.57 续写死锁修复（11-06 巡检实锤：carry.json 冻结在 11-05 20:12，之后 10+ 场空转）：
          // free 挡 topic 恒空 → 有旧 carry 时第一支 (!carry) 不进、第二支 writeCarry('') 静默 no-op、
          // 夜里全是 user-back 收场 clearCarry 也不触发 → 三条路全堵死。改为：本轮真看过/搜过的
          // 内容（r.topic）无条件刷新牵挂；没看到东西就退到本场打开过的站名；都没有且无旧账才不动。
          const t = String(r.topic || '').trim()
          if (t) writeCarry(ws0, t, (Array.isArray(r.watched) && r.watched[0]) || '')
          else if (!carry && Array.isArray(r.sites) && r.sites[0]) writeCarry(ws0, r.sites[0], '')
        } else if (unfinished) writeCarry(ws0, topic, (r.seen && r.seen[0]) || '')
        else if (carry && r && r.ok) clearCarry(ws0)   // 这场把旧牵挂看完了 → 销账
      } catch { }
      if (r.ok) {
        // 0.46.65 quiet 场记独立账本（quietToday/nextQuietAt），出门场照旧
        if (quietMode) {
          quietToday++
          nextQuietAt = now() + quietCooldownMs(rand)
        } else {
          todayCount++
        }
        if (nd) nd.discharge('session')    // 0.45.18 出门/静默干完一圈，无聊和好奇泄掉
        const line = runner.kind === 'browse' ? lineOf(r) : String(r.content || '').trim()
        /* 0.45.19 跨天项目：汇报记一笔。0.46.64 v2：收尾走 parseClose 协议——
           【成果】入 artifacts（逐个过 verifyArtifact 硬闸）、【状态】完成/搁置/放弃/改向/继续
           走生命周期、【心情】入 mood；她说出口的旁白用去标签后的 clean（协议标记不能漏进人话） */
        let said = line
        if (prj && line) {
          const pc = projectsParseClose(line)
          said = pc.clean || line
          const rr = prj.record(said, pc, { spaceDir: spDir })
          if (rr.finished) log('[autonomy] 项目收尾：《' + rr.finished.title + '》 ' + (rr.finished.summary || '').slice(0, 60))
        }
        try { onDone(r, said) } catch (e) { log('[autonomy] onDone 失败: ' + (e && e.message)) }
        // 压力越高冷却越短：憋得狠的时候，下一场来得早些
        if (!quietMode) {
          const scale = needState ? needs.cooldownScaleOf(needState) : 1
          nextAt = now() + Math.round(nextCooldownMs(rand) * scale)
        }
      } else if (r.why === 'llm-error') {
        // 0.45.11：deepseek 高峰期 503 把刚开场的一场整个报废（真机日志实证）——
        // 一次服务端抖动不该换来一小时禁闭，llm.js 已加退避重试，这里再兜一层：5 分钟后就地补跑
        if (quietMode) nextQuietAt = now() + 5 * 60 * 1000
        else nextAt = now() + 5 * 60 * 1000
      } else {
        // 0.46.4 被打断（user-back）也算出了半趟门：真的看了做了，好奇泄一半。
        // 以前完全不泄压 → 好奇常年 100，她永远憋着一股劲到处开网页。
        if (r.why === 'user-back' && nd) nd.discharge('interrupt')
        if (quietMode) nextQuietAt = now() + quietCooldownMs(rand)
        else nextAt = now() + nextCooldownMs(rand)
      }
      log('[autonomy] 结束 why=' + (r.why || '?') + (quietMode ? '（quiet）' : '') + ' 下次最早 ' +
        Math.round(((quietMode ? nextQuietAt : nextAt) - now()) / 60000) + ' 分钟后')
    } catch (e) {
      log('[autonomy] 剧本异常: ' + (e && e.message))
      if (quietMode) nextQuietAt = now() + 20 * 60 * 1000
      else nextAt = now() + 20 * 60 * 1000
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
      // 0.46.65 quiet 轨可见性
      quiet: {
        on: c.quietOn === true,
        today: quietToday,
        nextInMs: Math.max(0, nextQuietAt - now())
      },
      phase: dayflow.phaseOf(now()).key           // 0.45.19 她现在的时间段
    }
  }

  return { start, stop, tick, status }
}

module.exports = {
  IDLE_TRIGGER_MS, TICK_MS, COOLDOWN_MIN, COOLDOWN_MAX, MAX_SCRIPT_MS, SITES, BROWSER_PN,
  MAX_SPACE_FILE, JOURNAL_MAX, CUA_FREE_TOOLS,
  /* 0.46.65 quiet 轨 + 共同创作 */
  QUIET_PRESSURE_MIN, QUIET_DAILY_DEFAULT, QUIET_PROJECT_STALE_MS, COCREATE_INJECT_MAX,
  quietGate, quietCooldownMs,
  nextCooldownMs, pickTopic, lineOf, runBrowse, isBrowser, arrived, create, idleMsOf,
  /* 0.46.32 她自己看视频 */
  runVideoWatch,
  /* 0.46.17 性格层：品味/牵挂/活动可见 */
  pickSite, readSiteStats, bumpSite, readCarry, writeCarry, clearCarry, carryLineOf, siteKeyOf,
  /* 0.45.0 三挡位 */
  pickRunner, spaceGuard, spaceToolsOf, runSpace, freeToolsOf, runFree, appendJournal,
  /* 0.46.0 活动中的自言自语 */
  SOLI_PROMPT, SOLI_MAX_DEFAULT, SOLI_GAP_MS, extractSoliloquy, soliEmitter,
  recentJournalText,
  /* 0.45.8 经历沉淀 */
  memoryEntriesOf,
  tasteBlockOf,
  /* 0.45.18 需求系统（re-export 供旧调用方顺手用） */
  needs
}
