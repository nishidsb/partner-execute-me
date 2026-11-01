/**
 * 电脑画像（**全只读**）—— 让她知道「主人在电脑上是什么样的人」
 *
 * 五路采集：浏览器历史 / B站收藏与观看 / 游戏与应用库 / 应用使用时长 / 常用文件夹文件名。
 * 三条硬约束（主人 2026-10-28 明确要求）：
 *   1. 只读：不写、不改、不删任何电脑上的文件
 *   2. 不出本机：原始数据存 <userData>/pc-profile/raw.json，摘要存 <workspace>/pc/*.md，
 *      除了读网页历史以外不发任何请求（B站走已登录的官方接口）
 *   3. 可撤回：设置页能一键清空，清空就是删文件
 *
 * 注入策略：给模型的是 profile.md 摘要（≤1800 字），细节靠 pc_profile(section) 工具按需翻。
 */
const fs = require('node:fs')
const path = require('node:path')

const browserMod = require('./browser')
const biliMod = require('./biliProfile')
const gamesMod = require('./games')
const usageMod = require('./usage')
const keysMod = require('./keys')
const filesMod = require('./files')
const steamMod = require('./steam')
const openedMod = require('./opened')
const sessionsMod = require('./sessions')
const appsMod = require('./apps')
const insightMod = require('./insight')

const SUMMARY_LIMIT = 1800
/** 提示词里「她了解的主人」这一整段的字数上限（印象 + 判断 + 事实） */
const BLOCK_LIMIT = 2400
/** 印象档案的条数上限：超过就折叠最旧的（了解一个人不需要日记本） */
const IMPRESSION_MAX = 40

const STATE = {
  inited: false,
  dataRoot: '',
  log: () => { },
  running: false,
  lastAt: 0,
  lastError: '',
  lastDuration: 0,
  parts: {}, // 每路结果概况 { browser: {ok, note}, ... }
  cfg: { days: 14 }
}

function rawFile () {
  return path.join(STATE.dataRoot || '', 'pc-profile', 'raw.json')
}

/** 摘要目录：跟角色工作区走（换角色各自一份画像） */
function pcDirOf (wsDir) {
  return wsDir ? path.join(wsDir, 'pc') : ''
}

function ensureDir (dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch { }
}


function writeRaw (obj) {
  try {
    ensureDir(path.dirname(rawFile()))
    fs.writeFileSync(rawFile(), JSON.stringify(obj))
  } catch (e) { STATE.log('[profile] 写 raw.json 失败: ' + e.message) }
}

/* --------------------------------------------------- 她的印象档案（可累积） */

/**
 * 为什么要有这个文件：
 *   insight.md 是「从数据推出来的判断」，每次采集都会重算，本身不留感情。
 *   印象档案是她**自己写下**的观察——「他其实不太喜欢被问工作」「上次说腰疼」。
 *   这部分是唯一会随时间长大的理解，也是「了解完整的我」真正的落点。
 *
 * 格式：- [YYYY-MM-DD] 一句话
 * 上限 IMPRESSION_MAX 条，超出折叠最旧的（不是删掉最新的）。
 */

const IMPRESSION_TITLE = '# 她记下的主人（她自己的观察，不是数据）'

function impressionFile (wsDir) {
  const dir = pcDirOf(wsDir)
  return dir ? path.join(dir, 'impression.md') : ''
}

function todayKey () {
  const d = new Date()
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function parseImpression (text) {
  const items = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/.exec(line)
    if (m) items.push({ date: m[1], text: m[2].trim() })
  }
  return items
}

function serializeImpression (items) {
  return [IMPRESSION_TITLE, ''].concat(items.map((x) => '- [' + x.date + '] ' + x.text)).join('\n') + '\n'
}

/** 读她记下的印象（工具 / 设置页 / 提示词共用） */
function readImpression (wsDir, { limit = 1600 } = {}) {
  const f = impressionFile(wsDir)
  if (!f) return ''
  let items = []
  try { items = parseImpression(fs.readFileSync(f, 'utf8')) } catch { return '' }
  if (!items.length) return ''
  const L = [IMPRESSION_TITLE, '> 这些是你自己观察到的，不是采集数据。看到不对的（主人纠正你）就改掉——用 pc_impression 的 remove+note。', '']
  /* 从新到旧拼，超字数就从最旧的开始丢（最近的观察最有用） */
  const keep = []
  let size = L.join('\n').length
  for (let i = items.length - 1; i >= 0; i--) {
    const line = '- [' + items[i].date + '] ' + items[i].text
    if (size + line.length > limit) break
    keep.unshift(line)
    size += line.length + 1
  }
  return L.concat(keep).join('\n')
}

/**
 * 写一条印象（或纠正旧的）。
 * @param {{note?:string, remove?:string, date?:string}} entry
 *        note 要记下的内容；remove 要删掉的旧印象关键词；两者都给=用新的替换旧的
 */
function writeImpression (wsDir, entry = {}) {
  const f = impressionFile(wsDir)
  if (!f) return { ok: false, error: '还不知道工作区在哪（角色没加载？）' }
  const note = String(entry.note || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
  const remove = String(entry.remove || '').trim().toLowerCase()
  if (!note && !remove) return { ok: false, error: 'note 和 remove 至少要有一个' }

  let items = []
  try { items = parseImpression(fs.readFileSync(f, 'utf8')) } catch { }

  let removed = 0
  if (remove) {
    const keep = []
    for (const it of items) {
      if ((it.text + ' ' + it.date).toLowerCase().includes(remove)) { removed += 1; continue }
      keep.push(it)
    }
    items = keep
  }

  let added = false
  if (note) {
    /* 完全相同的不重复写；同一件事反复说会撑爆预算 */
    const dup = items.some((it) => it.text.toLowerCase() === note.toLowerCase())
    if (!dup) {
      items.push({ date: String(entry.date || todayKey()).slice(0, 10), text: note })
      added = true
    }
  }

  /* 超上限折叠最旧的，但留一行说明，别让她以为档案丢了 */
  let folded = 0
  if (items.length > IMPRESSION_MAX) {
    folded = items.length - IMPRESSION_MAX
    items = items.slice(folded)
  }

  ensureDir(path.dirname(f))
  try {
    fs.writeFileSync(f, serializeImpression(items))
  } catch (e) {
    return { ok: false, error: e.message }
  }
  return { ok: true, added, removed, folded, total: items.length }
}

/* ------------------------------------------------------------- 摘要生成 */

const fmtTime = (ms) => {
  try {
    const d = new Date(ms)
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  } catch { return '' }
}

/** 只要日期（月-日） */
const fmtDay = (ms) => {
  try {
    const d = new Date(ms)
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    return (d.getMonth() + 1) + '-' + p(d.getDate())
  } catch { return '' }
}

/** 只要时刻（时:分） */
const timeOf = (ms) => {
  try {
    const d = new Date(ms)
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    return p(d.getHours()) + ':' + p(d.getMinutes())
  } catch { return '' }
}

/** 从 24 小时计数里找出活跃时段（连续 3 小时窗口和最大的那段） */
function activeWindow (hourly) {
  if (!Array.isArray(hourly) || !hourly.length) return ''
  let best = { i: 0, sum: -1 }
  for (let i = 0; i < 24; i++) {
    const s = hourly[i] + hourly[(i + 1) % 24] + hourly[(i + 2) % 24]
    if (s > best.sum) best = { i, sum: s }
  }
  if (best.sum <= 0) return ''
  const fmt = (h) => (h < 10 ? '0' + h : '' + h) + ':00'
  return fmt(best.i) + '–' + fmt((best.i + 3) % 24)
}

function buildBrowsingMd (b) {
  if (!b || !b.ok) return ''
  const L = []
  L.push('# 主人逛过哪些网页（近 ' + b.days + ' 天的观察笔记，内容就在本节里）')
  L.push('')
  L.push('> 共 ' + b.totalVisits + ' 次访问，来自：' + b.sources.map((s) => s.browser + '/' + s.profile).join('、'))
  L.push('')
  const win = activeWindow(b.hourly)
  if (win) L.push('**最活跃时段**：' + win)
  L.push('')
  L.push('## 常去的网站')
  for (const d of b.domains.slice(0, 25)) {
    L.push('- ' + d.host + '（' + d.hits + ' 次，最近 ' + fmtTime(d.last) + '）' + (d.title ? ' — ' + d.title : ''))
  }
  L.push('')
  L.push('## 最近看过的页面')
  for (const r of b.recent.slice(0, 60)) {
    L.push('- [' + fmtTime(r.at) + '] ' + (r.title || r.host) + ' · ' + r.host)
  }
  return L.join('\n')
}

/** 搜索词：他主动想知道什么（比「看了什么页面」更接近内心） */
function buildSearchMd (b) {
  if (!b || !b.searches || !b.searches.length) return ''
  const L = []
  L.push('# 主人在搜索引擎问过什么（近 ' + b.days + ' 天的观察笔记，内容就在本节里）')
  L.push('')
  L.push('> 共 ' + b.searches.length + ' 条不同关键词。这是他自己敲进去的问题，比页面标题更能看出在想什么。')
  L.push('')
  L.push('## 最近搜的')
  for (const s of b.searches.slice(0, 80)) {
    L.push('- [' + fmtTime(s.at) + '] ' + s.q + (s.host ? '（' + s.host + '）' : ''))
  }
  return L.join('\n')
}

/** 书签：长期兴趣，和「最近浏览」互补 */
function buildBookmarksMd (b) {
  if (!b || !b.bookmarks || !b.bookmarks.length) return ''
  const L = []
  L.push('# 浏览器书签（只读，' + b.bookmarks.length + ' 个）')
  L.push('')
  L.push('> 书签是他主动存下来的，代表长期兴趣，不是一时冲动点进去的。')
  L.push('')
  const byHost = new Map()
  for (const bm of b.bookmarks) {
    const arr = byHost.get(bm.host) || []
    if (arr.length < 6) arr.push(bm.name)
    byHost.set(bm.host, arr)
  }
  for (const [host, names] of [...byHost.entries()].sort((a, b2) => b2[1].length - a[1].length).slice(0, 25)) {
    L.push('- **' + host + '**：' + names.join('、'))
  }
  return L.join('\n')
}

function buildBiliMd (b) {
  if (!b || !b.loggedIn) return ''
  const L = []
  L.push('# B站（只读）')
  L.push('')
  if (b.folders.length) {
    L.push('## 我的收藏夹')
    for (const f of b.folders) L.push('- ' + f.title + '（' + f.count + ' 个视频）')
    L.push('')
  }
  if (b.favorites.length) {
    L.push('## 收藏的内容')
    for (const f of b.favorites.slice(0, 40)) {
      L.push('- [' + f.folder + '] ' + f.title + (f.up ? '（UP：' + f.up + '）' : ''))
    }
    L.push('')
  }
  if (b.history.length) {
    L.push('## 最近看的视频')
    for (const h of b.history.slice(0, 30)) {
      const pct = h.duration ? Math.round((h.progress / h.duration) * 100) : 0
      L.push('- ' + h.title + (h.up ? '（UP：' + h.up + '）' : '') + (pct >= 5 ? ' · 看到 ' + pct + '%' : '') + (h.at ? ' · ' + fmtTime(h.at) : ''))
    }
  }
  return L.join('\n')
}

function buildGamesMd (g) {
  if (!g || !g.ok) return ''
  const L = []
  L.push('# 游戏与应用库（只读）')
  L.push('')
  if (g.steam.length) {
    L.push('## Steam（' + g.steam.length + '）')
    L.push(g.steam.slice(0, 80).map((x) => x.name).join('、'))
    L.push('')
  }
  if (g.epic.length) {
    L.push('## Epic（' + g.epic.length + '）')
    L.push(g.epic.slice(0, 40).map((x) => x.name).join('、'))
    L.push('')
  }
  const smGames = g.games.filter((x) => x.source === 'startmenu')
  if (smGames.length) {
    L.push('## 其他游戏（开始菜单里认出来的）')
    L.push(smGames.slice(0, 60).map((x) => x.name).join('、'))
    L.push('')
  }
  if (g.apps.length) {
    L.push('## 装着的其他程序（部分）')
    L.push(g.apps.slice(0, 80).map((x) => x.name).join('、'))
  }
  return L.join('\n')
}

function buildHabitsMd (u) {
  if (!u || !u.ok) return ''
  const L = []
  L.push('# 电脑使用习惯（只读，本机统计）')
  L.push('')
  L.push('统计了 ' + u.sampledDays + ' 天，前台累计约 ' + u.totalHours + ' 小时。')
  L.push('')
  L.push('## 各程序累计时长')
  for (const a of u.byApp.slice(0, 20)) L.push('- ' + a.app + '：' + a.minutes + ' 分钟（占 ' + a.share + '%）')
  L.push('')
  L.push('## 每天在干嘛')
  for (const d of u.byDay.slice(-14)) {
    L.push('- ' + d.date + '：' + d.totalMinutes + ' 分钟 · ' + d.top.map((x) => x.app + '(' + x.minutes + ')').join(' '))
  }
  if (u.titles.length) {
    L.push('')
    L.push('## 窗口标题里出现最多的（能看出具体在做什么）')
    for (const t of u.titles.slice(0, 20)) L.push('- ' + t.name + '（' + t.minutes + ' 分钟）')
  }
  return L.join('\n')
}

function buildFilesMd (f) {
  if (!f || !f.ok) return ''
  const L = []
  L.push('# 文件概况（只读，只有文件名）')
  L.push('')
  for (const d of f.dirs) L.push('- ' + d.group + '：' + d.path + '（' + d.files + ' 个文件 / ' + d.subdirs + ' 个子目录）')
  L.push('')
  L.push('## 文件类型分布')
  L.push(f.byExt.slice(0, 15).map((x) => x.ext + '×' + x.count).join('、'))
  L.push('')
  L.push('## 最近改过的文件')
  for (const r of f.recent.slice(0, 25)) L.push('- [' + fmtTime(r.at) + '] ' + r.name + '（' + r.group + '，' + r.mb + 'MB）')
  L.push('')
  L.push('## 最大的文件')
  for (const r of f.big.slice(0, 12)) L.push('- ' + r.name + '（' + r.group + '，' + r.mb + 'MB）')
  return L.join('\n')
}

/* ------------------------------------------------------------- 新增采集面的 md */

/** 设备运行时间：开机次数/每次多久/凌晨关机次数 */
function buildUptimeMd (s) {
  if (!s || !s.ok) return ''
  const L = []
  L.push('# 设备运行时间（只读：系统事件日志 + 本地采样）')
  L.push('')
  L.push('- 本次开机已运行 ' + s.uptimeHours + ' 小时')
  if (s.source === 'eventlog') {
    L.push('- 近 14 天平均每次开机 ' + s.avgUpHours + ' 小时，每天开机约 ' + s.bootsPerDay + ' 次')
    if (s.lateShutdowns) L.push('- 凌晨 1–6 点关机 ' + s.lateShutdowns + ' 次')
    L.push('')
    L.push('## 开机 → 关机')
    for (const x of s.sessions.slice(-25)) {
      const on = fmtTime(x.on)
      const off = x.off ? fmtTime(x.off) : '（还没关）'
      L.push('- ' + on + ' → ' + off + '　' + x.hours + ' 小时' + (x.abnormal ? '（没有正常关机记录）' : ''))
    }
  } else {
    L.push('- 读不到系统事件日志（权限或精简系统），只有本次运行时长')
  }
  if (s.days && s.days.length) {
    L.push('')
    L.push('## 每天真正在用的时段（来自前台采样）')
    for (const d of s.days.slice(-14)) {
      L.push('- ' + d.date + '：' + timeOf(d.first) + ' → ' + timeOf(d.last) + '（' + d.spanHours + ' 小时，累计在岗 ' + Math.round((d.activeMinutes || 0) / 60 * 10) / 10 + ' 小时）')
    }
  }
  return L.join('\n')
}

/** Steam 真实游玩时长：装了什么 ≠ 在玩什么 */
function buildSteamMd (s) {
  if (!s || !s.ok) return ''
  const L = []
  L.push('# Steam 真实游玩时长（只读 localconfig.vdf）')
  L.push('')
  const named = s.games.filter((g) => !/^App \d+$/.test(g.name))
  L.push('共 ' + s.games.length + ' 款有记录，累计 ' + s.totalHours + ' 小时' +
    (named.length < s.games.length ? '（其中 ' + (s.games.length - named.length) + ' 款已卸载、认不出名字）' : '') + '。')
  L.push('')
  for (const g of named.slice(0, 30)) {
    L.push('- ' + g.name + '：' + g.hours + ' 小时' + (g.lastPlayed ? '，最后玩 ' + fmtDay(g.lastPlayed) : ''))
  }
  return L.join('\n')
}

/** 最近打开过的文件（Recent 快捷方式 + 播放器历史） */
function buildOpenedMd (o) {
  if (!o || !o.ok) return ''
  const L = []
  L.push('# 最近打开过的文件（只读，只看文件名）')
  L.push('')
  if (o.byKind.length) L.push('分类：' + o.byKind.map((k) => k.label + ' ' + k.count).join('、'))
  if (o.players && o.players.length) L.push('播放器历史：' + o.players.join('、'))
  L.push('')
  const groups = ['video', 'audio', 'doc', 'image', 'code', 'archive']
  for (const kind of groups) {
    const rows = o.recent.filter((x) => x.kind === kind).slice(0, 12)
    if (!rows.length) continue
    L.push('## ' + (require('./opened').KIND_ZH[kind] || kind))
    for (const r of rows) L.push('- ' + (r.at ? '[' + fmtTime(r.at) + '] ' : '') + r.name)
    L.push('')
  }
  return L.join('\n').trim()
}

/** 已装程序清单 */
function buildProgramsMd (p) {
  if (!p || !p.ok) return ''
  const L = []
  L.push('# 已装程序（只读注册表 DisplayName）')
  L.push('')
  L.push('共 ' + p.total + ' 项（已折叠 ' + p.noiseCount + ' 个系统补丁/运行库）。')
  L.push('')
  for (const a of p.apps) L.push('- ' + a.name)
  return L.join('\n')
}

/** 总摘要：给模型看的那 1800 字。人话 + 少量事实，不做流水账 */
function buildProfileMd (raw) {
  const L = []
  L.push('# 主人电脑画像（自动采集·只读）')
  L.push('> 采集时间 ' + fmtTime(raw.at) + '，只读采集，不含密码/内容/隐私数据。细节可查 pc_profile 工具。')
  L.push('')
  const b = raw.browser
  if (b && b.ok) {
    const win = activeWindow(b.hourly)
    const tops = b.domains.slice(0, 8).map((d) => d.host + '×' + d.hits).join('、')
    L.push('## 上网')
    L.push('近 ' + b.days + ' 天 ' + b.totalVisits + ' 次访问。常去：' + tops + '。')
    if (win) L.push('最活跃时段 ' + win + '。')
    const titles = []
    for (const r of b.recent) {
      const t = String(r.title || '').trim()
      if (t && !titles.includes(t)) titles.push(t)
      if (titles.length >= 8) break
    }
    if (titles.length) L.push('最近在看的：' + titles.join(' / '))
    L.push('')
  }
  if (b && b.searches && b.searches.length) {
    L.push('## 最近在搜什么')
    L.push(b.searches.slice(0, 12).map((s) => '「' + String(s.q).slice(0, 30) + '」').join(' '))
    L.push('')
  }
  if (b && b.bookmarks && b.bookmarks.length) {
    const byHost = new Map()
    for (const bm of b.bookmarks) byHost.set(bm.host, (byHost.get(bm.host) || 0) + 1)
    const tops = [...byHost.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)
    L.push('## 书签里存的（长期兴趣）')
    L.push(tops.map(([h, n]) => h + '×' + n).join('、'))
    L.push('')
  }
  const bi = raw.bili
  if (bi && bi.loggedIn) {
    L.push('## B站')
    if (bi.folders.length) L.push('收藏夹：' + bi.folders.map((f) => f.title + '(' + f.count + ')').join('、'))
    if (bi.favorites.length) L.push('最近收藏：' + bi.favorites.slice(0, 8).map((f) => f.title).join(' / '))
    if (bi.history.length) L.push('最近在看：' + bi.history.slice(0, 10).map((h) => h.title).join(' / '))
    L.push('')
  }
  const u = raw.usage
  if (u && u.ok) {
    L.push('## 电脑使用')
    L.push('前台累计 ' + u.totalHours + ' 小时（' + u.sampledDays + ' 天）。最常用：' +
      u.byApp.slice(0, 6).map((a) => a.app + ' ' + a.minutes + '分').join('、'))
    const t = u.titles.slice(0, 8).map((x) => x.name).filter(Boolean)
    if (t.length) L.push('常出现的窗口：' + t.join(' / '))
    L.push('')
  }
  const up = raw.sessions
  if (up && up.ok) {
    L.push('## 设备运行时间')
    const bits = ['本次已开 ' + up.uptimeHours + ' 小时']
    if (up.source === 'eventlog') {
      bits.push('近 14 天平均每次开机 ' + up.avgUpHours + ' 小时')
      bits.push('每天约开 ' + up.bootsPerDay + ' 次')
      if (up.lateShutdowns) bits.push('凌晨 1–6 点关机 ' + up.lateShutdowns + ' 次')
    }
    L.push(bits.join('，') + '。')
    L.push('')
  }
  const st = raw.steam
  if (st && st.ok) {
    /* 名字认不出的（已卸载/非 Steam 库里的）不占摘要，只报个数量 */
    const named = st.games.filter((g) => !/^App \d+$/.test(g.name))
    const unknown = st.games.length - named.length
    L.push('## 真正在玩的（Steam 累计时长）')
    if (named.length) {
      L.push(named.slice(0, 6).map((g) => g.name + ' ' + g.hours + 'h').join('、') +
        '（共 ' + named.length + ' 款 ' + st.totalHours + ' 小时' +
        (unknown ? '，另有 ' + unknown + ' 款认不出名字' : '') + '）')
    } else {
      L.push('有 ' + st.games.length + ' 款游玩记录、累计 ' + st.totalHours + ' 小时，但都对不上名字（多半已卸载）')
    }
    L.push('')
  }
  const op = raw.opened
  if (op && op.ok) {
    const videos = op.recent.filter((x) => x.kind === 'video').slice(0, 3).map((x) => x.name)
    const docs = op.recent.filter((x) => x.kind === 'doc').slice(0, 4).map((x) => x.name)
    L.push('## 最近打开过什么')
    if (videos.length) L.push('影片：' + videos.join(' / '))
    if (docs.length) L.push('文档：' + docs.join(' / '))
    if (!videos.length && !docs.length) L.push(op.recent.slice(0, 5).map((x) => x.name).join(' / '))
    L.push('')
  }
  const pr = raw.programs
  if (pr && pr.ok) {
    /* 只挑「能说明他在做什么」的那几个，剩下的留给 programs.md */
    const KEY = /(Blender|Unity|Unreal|Visual Studio|VS Code|JetBrains|IntelliJ|PyCharm|Photoshop|Illustrator|Premiere|After Effects|DaVinci|剪映|OBS|FL Studio|Cubase|AutoCAD|MATLAB|Steam|WPS|Office|Obsidian|Notion|Git)/i
    const picks = pr.apps.map((a) => a.name).filter((n) => KEY.test(n)).slice(0, 12)
    L.push('## 装了哪些程序')
    L.push('共 ' + pr.total + ' 项。值得注意的：' + (picks.length ? picks.join('、') : '（没有特别的应用软件）'))
    L.push('')
  }
  const g = raw.games
  if (g && g.ok) {
    L.push('## 游戏')
    const names = [...g.steam, ...g.epic].map((x) => x.name)
    if (names.length) L.push('库里 ' + names.length + ' 个（Steam/Epic）：' + names.slice(0, 18).join('、'))
    const sm = g.games.filter((x) => x.source === 'startmenu').map((x) => x.name)
    if (sm.length) L.push('其他：' + sm.slice(0, 12).join('、'))
    L.push('')
  }
  const f = raw.files
  if (f && f.ok) {
    L.push('## 文件')
    const rec = f.recent.slice(0, 10).map((r) => r.name)
    if (rec.length) L.push('最近改过的：' + rec.join(' / '))
    L.push('文件类型：' + f.byExt.slice(0, 8).map((x) => x.ext + '×' + x.count).join('、'))
  }
  let text = L.join('\n').trim()
  if (text.length > SUMMARY_LIMIT) text = text.slice(0, SUMMARY_LIMIT) + '\n…（摘要已截断，细节用 pc_profile 工具查）'
  return text
}

/* ------------------------------------------------------------- 采集调度 */

async function runCollect ({ wsDir, days = 14, force = false, log } = {}) {
  if (STATE.running) return { ok: false, error: '正在采集中' }
  const dir = pcDirOf(wsDir)
  if (!dir) return { ok: false, error: '还不知道工作区在哪（角色没加载？）' }
  STATE.running = true
  STATE.lastError = ''
  const t0 = Date.now()
  const logFn = log || STATE.log
  const parts = {}

  const safe = async (name, fn) => {
    try {
      const r = await fn()
      parts[name] = r
      logFn('[profile] ' + name + ' 完成')
    } catch (e) {
      parts[name] = null
      logFn('[profile] ' + name + ' 失败: ' + (e && e.message))
    }
  }

  await Promise.all([
    safe('browser', () => browserMod.collect({ days })),
    safe('bili', () => biliMod.collect({ dataRoot: STATE.dataRoot })),
    safe('games', () => gamesMod.collect({ force })),
    safe('files', () => filesMod.collect({})),
    safe('steam', () => steamMod.collect({})),
    safe('opened', () => openedMod.collect({})),
    safe('programs', () => appsMod.collect({}))
  ])
  /* usage 是读已有统计文件，不触发扫描 */
  try { parts.usage = usageMod.collect({ days }) } catch { parts.usage = null }
  /* sessions 要用 usage 的每日首末时间，所以放在它后面 */
  await safe('sessions', () => sessionsMod.collect({ usage: parts.usage, days }))

  const raw = Object.assign({ at: Date.now(), days }, parts)

  /* 推断层：把清单翻译成「他是什么样的人」。
     健康记录有就拿来交叉验证（他说的几点睡 vs 电脑几点还亮），没有也不影响。 */
  let ins = null
  try {
    let health = null
    try { health = require('../health').stats({ days: 14 }) } catch { health = null }
    ins = insightMod.build(raw, { health })
    if (ins && ins.ok) {
      raw.insight = {
        at: ins.at,
        themes: ins.themes.map((t) => ({ key: t.key, label: t.label, score: t.score, ev: t.ev.slice(0, 3) })),
        rhythm: ins.rhythm,
        fresh: ins.fresh,
        style: ins.style,
        cross: ins.cross,
        narrative: ins.narrative
      }
    }
  } catch (e) { logFn('[profile] 推断失败: ' + (e && e.message)) }
  writeRaw(raw)

  ensureDir(dir)
  /* pc/ 整个目录长在记忆仓库里（跟 PARTNER.md 同一棵树），但不是所有东西都该进历史：
     采集出来的 md 是随时能重采的缓存，还含隐私（浏览记录、文件名），进 git 就是永久留底；
     而且每 20 小时全量重写一次，历史会被刷成一堆垃圾提交。
     只有 impression.md 例外——那是她自己记下的，必须能看、能回滚。*/
  try {
    const gi = path.join(dir, '.gitignore')
    const want = [
      '# 采集缓存：能随时重采，且含隐私，不进记忆历史',
      'profile.md', 'browsing.md', 'search.md', 'bookmarks.md',
      'bili.md', 'games.md', 'habits.md', 'files.md', 'insight.md',
      'steam.md', 'opened.md', 'uptime.md', 'programs.md',
      'usage.json', 'raw.json', '',
      '# impression.md 故意不在这里：那是她的记忆，要进 git 才能回滚'
    ].join('\n') + '\n'
    let cur = ''
    try { cur = fs.readFileSync(gi, 'utf8') } catch { }
    if (cur !== want) fs.writeFileSync(gi, want)
  } catch { }
  const files = {
    'profile.md': buildProfileMd(raw),
    'browsing.md': buildBrowsingMd(parts.browser),
    'search.md': buildSearchMd(parts.browser),
    'bookmarks.md': buildBookmarksMd(parts.browser),
    'bili.md': buildBiliMd(parts.bili),
    'games.md': buildGamesMd(parts.games),
    'habits.md': buildHabitsMd(parts.usage),
    'files.md': buildFilesMd(parts.files),
    'steam.md': buildSteamMd(parts.steam),
    'opened.md': buildOpenedMd(parts.opened),
    'uptime.md': buildUptimeMd(parts.sessions),
    'programs.md': buildProgramsMd(parts.programs),
    'insight.md': (ins && ins.ok) ? insightMod.mdOf(ins) : ''
  }
  const written = []
  for (const [name, text] of Object.entries(files)) {
    if (!text) continue
    try {
      fs.writeFileSync(path.join(dir, name), text)
      written.push(name)
    } catch (e) { logFn('[profile] 写 ' + name + ' 失败: ' + e.message) }
  }

  STATE.parts = {
    browser: { ok: !!(parts.browser && parts.browser.ok), note: parts.browser ? parts.browser.totalVisits + ' 次访问' : '无数据' },
    bili: { ok: !!(parts.bili && parts.bili.ok), note: parts.bili && parts.bili.loggedIn ? (parts.bili.favorites.length + ' 条收藏 / ' + parts.bili.history.length + ' 条历史') : '未登录' },
    games: { ok: !!(parts.games && parts.games.ok), note: parts.games ? (parts.games.steam.length + ' Steam / ' + parts.games.games.length + ' 游戏') : '无数据' },
    usage: { ok: !!(parts.usage && parts.usage.ok), note: parts.usage ? parts.usage.totalHours + ' 小时' : '还没积累' },
    files: { ok: !!(parts.files && parts.files.ok), note: parts.files ? parts.files.totalFiles + ' 个文件' : '无数据' },
    steam: { ok: !!(parts.steam && parts.steam.ok), note: parts.steam ? (parts.steam.games.length + ' 款 / ' + parts.steam.totalHours + ' 小时') : '没有 Steam 记录' },
    opened: { ok: !!(parts.opened && parts.opened.ok), note: parts.opened ? (parts.opened.total + ' 个最近文件') : '无数据' },
    sessions: {
      ok: !!(parts.sessions && parts.sessions.ok),
      note: parts.sessions
        ? (parts.sessions.source === 'eventlog'
            ? ('已开 ' + parts.sessions.uptimeHours + 'h / 平均 ' + parts.sessions.avgUpHours + 'h')
            : ('已开 ' + parts.sessions.uptimeHours + 'h（读不到事件日志）'))
        : '无数据'
    },
    programs: { ok: !!(parts.programs && parts.programs.ok), note: parts.programs ? (parts.programs.total + ' 项已装') : '无数据' },
    search: { ok: !!(parts.browser && parts.browser.searches && parts.browser.searches.length), note: parts.browser && parts.browser.searches ? (parts.browser.searches.length + ' 条搜索词') : '无数据' },
    insight: { ok: !!(ins && ins.ok), note: ins && ins.ok ? ('判断出 ' + ins.themes.length + ' 个兴趣主题' + (ins.cross.length ? '、' + ins.cross.length + ' 处矛盾' : '')) : '证据不足' }
  }
  STATE.lastAt = Date.now()
  STATE.lastDuration = Date.now() - t0
  STATE.running = false
  logFn('[profile] 采集完成 ' + STATE.lastDuration + 'ms → ' + written.join(', '))
  return { ok: true, written, duration: STATE.lastDuration, parts: STATE.parts }
}

/** 给 systemPrompt 用的摘要（读文件；limit 默认 900，因为整段还有印象与判断） */
function summaryFor (wsDir, { limit = 900 } = {}) {
  const dir = pcDirOf(wsDir)
  if (!dir) return ''
  try {
    const text = fs.readFileSync(path.join(dir, 'profile.md'), 'utf8').trim()
    if (!text) return ''
    /* 去掉文件自带的一级标题（调用方会加自己的小节标题） */
    const body = text.replace(/^#[^\n]*\n/, '').trim()
    return body.length > limit ? body.slice(0, limit) + '\n…（截断）' : body
  } catch { return '' }
}

/** 推断摘要：只取「她的判断」+「矛盾点」，主题清单太占字数，留给工具翻 */
function insightDigest (wsDir, { limit = 620 } = {}) {
  const dir = pcDirOf(wsDir)
  if (!dir) return ''
  let text = ''
  try { text = fs.readFileSync(path.join(dir, 'insight.md'), 'utf8') } catch { return '' }
  if (!text) return ''
  const out = []
  const m1 = /## 她的判断\n([\s\S]*?)(?:\n## |$)/.exec(text)
  if (m1 && m1[1].trim()) out.push(m1[1].trim())
  const m2 = /## 值得留意的矛盾\n([\s\S]*?)(?:\n## |$)/.exec(text)
  if (m2 && m2[1].trim()) {
    out.push('值得留意：' + m2[1].split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean).join('；'))
  }
  let s = out.join('\n\n')
  if (s.length > limit) s = s.slice(0, limit) + '…'
  return s
}

/**
 * 提示词整段：印象（她自己写的）→ 判断（推的）→ 事实（采的）
 *
 * 顺序有讲究：越靠前越是「她本来就该记得的」。事实放最后，因为它是原材料，
 * 而且最容易过时。整段受 BLOCK_LIMIT 约束，宁可少给事实也不砍印象。
 */
function promptBlock (wsDir) {
  const chunks = []
  const imp = readImpression(wsDir, { limit: 600 })
  if (imp) chunks.push(imp)
  const dig = insightDigest(wsDir, { limit: 700 })
  if (dig) chunks.push('## 你观察到的（从痕迹推的，可能不准，可以问）\n' + dig)
  const facts = summaryFor(wsDir, { limit: 760 })
  if (facts) chunks.push('## 事实底子（原始采集摘要）\n' + facts)
  if (!chunks.length) return ''
  const guide = [
    '## 怎么用这些',
    '1. 这是你本来就知道的事，别说成「根据记录显示」「我查到」——像老朋友一样自然带出来。',
    '2. 一次只挑一件相关的说，别把数据一口气倒出来。',
    '3. 「推的」那部分是猜的，说得不对他会纠正你，改就是了，别硬撑。',
    '4. 真学到关于他的新东西（习惯、喜好、忌讳、身体情况）→ 用 pc_impression 记一句，下次就记得了。',
    '5. 别变成监视式关心：「你昨天三点还没睡」说一次是关心，天天说就是烦。',
    '6. 他自己写过一份自我介绍（机主资料），那是「他想让你看到的他」；这些痕迹是「他实际在过的生活」。' +
    '冲突时先信自述，把痕迹当补充，别拿数据去对质。',
    '7. 这些和你 PARTNER.md 里的记忆是同一套，不是两个抽屉：稳定下来的（长期爱好、作息、忌讳、身体情况）' +
    '用 remember 写进 PARTNER.md，一次性的观察用 pc_impression。两边说法不一样时，以你最近确认过的那个为准，' +
    '别同时信两套。',
    '8. 下面的「# 标题」（主人搜过什么、逛过哪些网页、B站…）只是这份档案的目录，内容就写在那节里，' +
    '不是什么需要弄懂的神秘词条——绝对不要把它们原样拿去搜索引擎搜（2026-10-31 真机事故）。'
  ].join('\n')
  let text = '# 你了解的主人（电脑上的生活痕迹 · 只读采集 · 只在本机）\n' + guide + '\n\n' + chunks.join('\n\n')
  if (text.length > BLOCK_LIMIT) text = text.slice(0, BLOCK_LIMIT) + '\n…（已截断，细节用 pc_profile 查）'
  return text
}

/** 读某一段明细（工具用） */
function readSection (wsDir, section) {
  const dir = pcDirOf(wsDir)
  if (!dir) return ''
  const map = {
    profile: 'profile.md',
    browsing: 'browsing.md',
    browser: 'browsing.md',
    search: 'search.md',
    searches: 'search.md',
    bookmarks: 'bookmarks.md',
    bili: 'bili.md',
    games: 'games.md',
    habits: 'habits.md',
    usage: 'habits.md',
    files: 'files.md',
    steam: 'steam.md',
    playtime: 'steam.md',
    opened: 'opened.md',
    recent: 'opened.md',
    uptime: 'uptime.md',
    sessions: 'uptime.md',
    programs: 'programs.md',
    apps: 'programs.md',
    insight: 'insight.md',
    impression: 'impression.md'
  }
  const f = map[String(section || 'profile').toLowerCase()]
  if (!f) return ''
  try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return '' }
}

/**
 * 做梦素材：把她在他电脑上注意到的东西，投进「整理记忆」那条管道。
 *
 * 为什么需要这个——画像本来是口孤井：采集完落成几个 md，每轮对话硬塞进提示词，
 * 然后就停了。她从来没机会把「他半夜都在打原神」变成自己的长期记忆。
 * 这里把原料摘出来交给做梦流程，由她提炼成习惯/好恶/长期事实，走 review 队列落地。
 *
 * 注意：只给现象，不给结论式指令——提炼是她的事，不是我们的。
 */
function dreamMaterial (wsDir, { limit = 1200 } = {}) {
  const dir = pcDirOf(wsDir)
  if (!dir) return ''
  const chunks = []

  /* 1. 她自己写过、但可能只在提示词里飘过的观察 */
  let items = []
  try { items = parseImpression(fs.readFileSync(path.join(dir, 'impression.md'), 'utf8')) } catch { }
  if (items.length) {
    chunks.push('她自己的印象（她之前写下的）：\n' + items.slice(-12).map((x) => '- ' + x.text).join('\n'))
  }

  /* 2. 推断层的叙述（作息、主题、新冒出来的兴趣、行为风格） */
  let ins = ''
  try { ins = fs.readFileSync(path.join(dir, 'insight.md'), 'utf8') } catch { }
  if (ins) {
    const out = []
    for (const rawLine of ins.split(/\r?\n/)) {
      let l = rawLine.trim()
      if (!l) continue
      if (l.charAt(0) === '>') continue                    // 写给她看的提示语，不是素材
      if (/^#\s/.test(l)) continue                         // 一级标题是抬头，别占预算
      l = l.replace(/^#+\s*/, '').replace(/\*\*/g, '')
      if (!l) continue
      /* 主题行只留结论，砍掉证据链——证据是她要用时才翻的细节，占做梦的预算不值 */
      const t = /^-\s*(.+?)（(\d+)\s*分）\s*[:：].*$/.exec(l)
      if (t) { out.push('- ' + t[1] + '（' + t[2] + ' 分）'); continue }
      out.push(l)
    }
    const body = out.join('\n').trim()
    if (body) chunks.push('从电脑痕迹推出来的（可能不准）：\n' + body)
  }

  if (!chunks.length) return ''
  let text = chunks.join('\n\n')
  if (text.length > limit) text = text.slice(0, limit) + '…'
  return text
}

function status ({ wsDir } = {}) {
  const dir = pcDirOf(wsDir)
  const list = dir ? (fs.existsSync(dir) ? fs.readdirSync(dir) : []) : []
  let impressionCount = 0
  if (dir) {
    try { impressionCount = parseImpression(fs.readFileSync(path.join(dir, 'impression.md'), 'utf8')).length } catch { }
  }
  /* 档案文件的时间比内存里的 lastAt 可靠：重启后它还在 */
  let fileAt = 0
  if (dir) {
    try { fileAt = fs.statSync(path.join(dir, 'profile.md')).mtimeMs } catch { }
  }
  return {
    inited: STATE.inited,
    running: STATE.running,
    lastAt: STATE.lastAt || fileAt,
    fileAt,
    lastError: STATE.lastError,
    lastDuration: STATE.lastDuration,
    parts: STATE.parts,
    files: list,
    hasProfile: list.includes('profile.md'),
    hasInsight: list.includes('insight.md'),
    impressionCount
  }
}

function clear ({ wsDir } = {}) {
  const dir = pcDirOf(wsDir)
  let removed = 0
  if (dir) {
    for (const f of ['profile.md', 'browsing.md', 'search.md', 'bookmarks.md', 'bili.md',
      'games.md', 'habits.md', 'files.md', 'insight.md', 'impression.md',
      'steam.md', 'opened.md', 'uptime.md', 'programs.md']) {
      try { fs.unlinkSync(path.join(dir, f)); removed += 1 } catch { }
    }
  }
  try { fs.unlinkSync(rawFile()); removed += 1 } catch { }
  try { usageMod.clearFile() } catch { }
  /* 0.44.0 键盘记录也在「清空档案」的范围里——这是一条硬约束：
     「清空」按钮必须能删掉所有她看到的关于你的东西，键盘流水不能成为漏网之鱼。 */
  try {
    const kr = keysMod.clearAll()
    removed += kr.files
  } catch { }
  STATE.lastAt = 0
  STATE.parts = {}
  return { ok: true, removed }
}

function init ({ dataRoot, log } = {}) {
  STATE.dataRoot = dataRoot || ''
  if (typeof log === 'function') STATE.log = log
  STATE.inited = true
}

/** 使用习惯采样开关（画像开启时才有意义，别白耗性能） */
function startSampling ({ wsDir, log, keys = false } = {}) {
  const dir = pcDirOf(wsDir)
  if (!dir) return false
  ensureDir(dir)
  const ok = usageMod.start({ pcDir: dir, log: log || STATE.log })
  /* 0.44.0 键盘与输入内容：单独开关（keyLogOn）。它比使用时长敏感得多，
     所以不复用 pcProfileOn——关掉画像不等于允许记按键。 */
  if (keys) {
    try { keysMod.start({ pcDir: dir, log: log || STATE.log }) } catch (e) { (log || STATE.log)('[keys] 启动失败: ' + (e && e.message)) }
  } else {
    try { keysMod.stop() } catch { }
  }
  return ok
}

function stopSampling () {
  try { usageMod.stop() } catch { }
  try { keysMod.stop() } catch { }
}

module.exports = {
  init, runCollect, summaryFor, insightDigest, promptBlock, readSection, status, clear,
  startSampling, stopSampling, pcDirOf, rawFile, dreamMaterial,
  readImpression, writeImpression, impressionFile, parseImpression,
  _buildProfileMd: buildProfileMd,
  SUMMARY_LIMIT, BLOCK_LIMIT, IMPRESSION_MAX
}
