/**
 * 电脑画像 · 浏览器历史（**只读**）
 *
 * 主人要求「她能看到我看了什么」，这里把 Edge / Chrome / Brave / Chromium / Firefox 的
 * 历史库搬出来做成结构化摘要。硬约束：
 *   1. 只读——历史库先复制到临时目录再打开，原库一个字节都不碰（浏览器正锁着它）
 *   2. 只留摘要——页面只存「标题 + 域名 + 时间」，URL 去掉 query/hash。
 *      唯一例外是**搜索词**：只从搜索引擎/站内搜索的固定参数（q/wd/keyword…）里取，
 *      取不到就丢弃，绝不保存完整参数串（token、视频 id、会话 id 一律不进档案）
 *   3. 不联网——所有数据留在本机 <workspace>/pc/
 *
 * Chromium 系用 sql.js（内嵌 wasm，零原生编译、零 wasm 定位问题）读 SQLite。
 * 时间戳：Chromium = 1601-01-01 起的微秒；Firefox = 1970-01-01 起的微秒。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const CHROME_EPOCH_MS = 11644473600000 // 1601-01-01 → 1970-01-01 的毫秒差

/** 装了哪些浏览器（只列真实存在的） */
const CHROMIUM_BROWSERS = [
  { id: 'edge', name: 'Edge', root: ['Microsoft', 'Edge', 'User Data'] },
  { id: 'chrome', name: 'Chrome', root: ['Google', 'Chrome', 'User Data'] },
  { id: 'brave', name: 'Brave', root: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
  { id: 'chromium', name: 'Chromium', root: ['Chromium', 'User Data'] }
]

let sqlPromise = null
function loadSql () {
  if (!sqlPromise) {
    /* dist/sql-wasm-inline.js = 单文件内嵌 wasm，打包进 asar 也不用 locateFile 找 wasm */
    const initSqlJs = require('sql.js/dist/sql-wasm-inline.js')
    sqlPromise = initSqlJs()
  }
  return sqlPromise
}

/** 域名：去掉 www. 前缀，保留二级域名（search.bilibili.com → bilibili.com 归并更实用，但先细分） */
function hostOf (url) {
  try {
    const u = new URL(url)
    return (u.hostname || '').replace(/^www\./, '')
  } catch { return '' }
}

/** 存库/入上下文用：剥掉 query 与 hash（避免把 token、视频 id 全存下来） */
function cleanUrl (url) {
  try {
    const u = new URL(url)
    return u.origin + u.pathname
  } catch { return String(url || '').slice(0, 200) }
}

/**
 * 搜索引擎的查询词（0.24.0 补）。
 *
 * 为什么单独抽：搜索词是「他此刻在想什么」最直接的信号——比页面标题准得多。
 * 「原神 深渊 阵容」「python 报错 xxx」这类信息在标题里根本看不到。
 * 只认搜索引擎/站内搜索的固定参数名，其它 query 一概丢掉（不存 token、不存视频 id）。
 */
const SEARCH_HOSTS = [
  { host: 'bing.com', param: 'q' },
  { host: 'cn.bing.com', param: 'q' },
  { host: 'google.com', param: 'q' },
  { host: 'baidu.com', param: 'wd' },
  { host: 'sogou.com', param: 'query' },
  { host: 'so.com', param: 'q' },
  { host: 'duckduckgo.com', param: 'q' },
  { host: 'search.bilibili.com', param: 'keyword' },
  { host: 'bilibili.com', param: 'keyword' },
  { host: 'youtube.com', param: 'search_query' },
  { host: 'zhihu.com', param: 'q' },
  { host: 'xiaohongshu.com', param: 'keyword' },
  { host: 's.taobao.com', param: 'q' },
  { host: 'search.jd.com', param: 'keyword' },
  { host: 'amazon.com', param: 'k' },
  { host: 'douban.com', param: 'q' },
  { host: 'weixin.sogou.com', param: 'query' }
]

/** 从一条 URL 里取搜索词；不是搜索页就返回 '' */
function searchQueryOf (url) {
  let u = null
  try { u = new URL(url) } catch { return '' }
  const host = (u.hostname || '').replace(/^www\./, '').toLowerCase()
  for (const s of SEARCH_HOSTS) {
    if (host !== s.host && !host.endsWith('.' + s.host)) continue
    const raw = u.searchParams.get(s.param)
    if (!raw) continue
    const q = decodeTry(raw).replace(/\s+/g, ' ').trim()
    if (q.length < 2 || q.length > 80) return ''
    if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(q)) return ''
    return q
  }
  return ''
}

/** URLSearchParams 已经解过一次码，个别站点双重编码，这里兜一下 */
function decodeTry (s) {
  const once = String(s || '')
  if (!/%[0-9a-f]{2}/i.test(once)) return once
  try { return decodeURIComponent(once) } catch { return once }
}

/**
 * 读 Chromium 书签（只读 Bookmarks JSON，不碰原文件写权限）。
 * 书签是长期兴趣，和「最近浏览」互补：一个是「一直喜欢」，一个是「最近在看」。
 */
function readChromiumBookmarks (rootParts) {
  const base = path.join(process.env.LOCALAPPDATA || '', ...rootParts)
  const out = []
  let profiles = []
  try { profiles = fs.readdirSync(base) } catch { return out }
  for (const n of profiles) {
    if (n !== 'Default' && !/^Profile \d+$/.test(n)) continue
    const f = path.join(base, n, 'Bookmarks')
    let data = null
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    const walk = (node, depth) => {
      if (!node || depth > 8) return
      if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return }
      if (node.type === 'url' && node.url) {
        const name = String(node.name || '').trim()
        if (name && /^https?:/i.test(node.url)) out.push({ name: name.slice(0, 60), host: hostOf(node.url) })
        return
      }
      if (Array.isArray(node.children)) walk(node.children, depth + 1)
    }
    const roots = data.roots || {}
    for (const k of Object.keys(roots)) walk(roots[k], 0)
  }
  /* 去重（多 profile 同名）+ 域名聚合 */
  const seen = new Set()
  const uniq = []
  for (const b of out) {
    const key = b.name + '|' + b.host
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(b)
  }
  return uniq.slice(0, 120)
}

/** 找某个 Chromium 浏览器的所有可用 profile 目录（Default / Profile 1 / …，只要里面真有 History） */
function chromiumProfiles (rootParts) {
  const base = path.join(process.env.LOCALAPPDATA || '', ...rootParts)
  const out = []
  let names = []
  try { names = fs.readdirSync(base) } catch { return out }
  for (const n of names) {
    if (n !== 'Default' && !/^Profile \d+$/.test(n)) continue
    const f = path.join(base, n, 'History')
    try {
      const st = fs.statSync(f)
      if (st.size > 4096) out.push({ profile: n, file: f, size: st.size })
    } catch { /* 没装/没历史 */ }
  }
  return out
}

/** 把历史库安全地搬到临时文件（浏览器锁着原库，只读复制不影响它） */
function copyToTemp (file) {
  const tmp = path.join(os.tmpdir(), 'ryza-hist-' + crypto.randomBytes(6).toString('hex') + '.db')
  fs.copyFileSync(file, tmp)
  // WAL 模式下的最新数据可能在 -wal 里；有就一起复制（存在才复制，缺了也不致命）
  for (const suffix of ['-wal', '-shm']) {
    try { if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, tmp + suffix) } catch { }
  }
  return tmp
}

function cleanup (tmp) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmp + suffix) } catch { }
  }
}

/**
 * 读一个 Chromium 历史库。days 天内的访问记录，按 URL 聚合成一条（取最近一次时间）。
 * 返回 { rows: [{url,title,at,hits,h7,first}], total, hourly }
 *
 * 注意 hourly 必须按 **visit 明细** 统计：早期版本用「URL 的最后访问时间」加权，
 * 结果 100 次访问全被算到那一小时，作息判断整个失真（这是真机上踩到的坑）。
 */
async function readChromium (file, { days = 14, limit = 4000 } = {}) {
  const SQL = await loadSql()
  const tmp = copyToTemp(file)
  let db = null
  try {
    db = new SQL.Database(fs.readFileSync(tmp))
    const nowMicro = BigInt(Date.now() + CHROME_EPOCH_MS) * 1000n
    const since = nowMicro - BigInt(days) * 86400n * 1000000n
    const since7 = nowMicro - 7n * 86400n * 1000000n
    const sql =
      'SELECT u.url, u.title, MAX(v.visit_time) AS t, COUNT(v.id) AS c, ' +
      'SUM(CASE WHEN v.visit_time > ' + since7.toString() + ' THEN 1 ELSE 0 END) AS c7, ' +
      'MIN(v.visit_time) AS tmin ' +
      'FROM urls u JOIN visits v ON v.url = u.id ' +
      'WHERE v.visit_time > ' + since.toString() + ' ' +
      'GROUP BY u.id ORDER BY t DESC LIMIT ' + Math.trunc(limit)
    const res = db.exec(sql)
    const rows = []
    const toMs = (v) => Number(BigInt(String(v)) / 1000n - BigInt(CHROME_EPOCH_MS))
    if (res && res[0]) {
      for (const r of res[0].values) {
        rows.push({
          url: String(r[0] || ''),
          title: String(r[1] || ''),
          at: toMs(r[2]),
          hits: Number(r[3] || 1),
          h7: Number(r[4] || 0),
          first: r[5] != null ? toMs(r[5]) : toMs(r[2])
        })
      }
    }
    /* 小时分布：按访问明细逐条累加 */
    const hourly = new Array(24).fill(0)
    try {
      const hv = db.exec('SELECT visit_time FROM visits WHERE visit_time > ' + since.toString())
      if (hv && hv[0]) {
        for (const row of hv[0].values) {
          const h = new Date(toMs(row[0])).getHours()
          if (h >= 0 && h < 24) hourly[h] += 1
        }
      }
    } catch { }
    let total = 0
    try { total = Number(db.exec('SELECT COUNT(*) FROM urls')[0].values[0][0]) } catch { }
    return { rows, total, hourly }
  } finally {
    try { if (db) db.close() } catch { }
    cleanup(tmp)
  }
}

/** Firefox 的 places.sqlite（PRTime = 微秒 since 1970） */
async function readFirefox ({ days = 14, limit = 2000 } = {}) {
  const base = path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles')
  let dirs = []
  try { dirs = fs.readdirSync(base) } catch { return { rows: [], total: 0, hourly: new Array(24).fill(0) } }
  const rows = []
  const hourly = new Array(24).fill(0)
  let total = 0
  const SQL = await loadSql()
  for (const d of dirs) {
    const file = path.join(base, d, 'places.sqlite')
    if (!fs.existsSync(file)) continue
    const tmp = copyToTemp(file)
    let db = null
    try {
      db = new SQL.Database(fs.readFileSync(tmp))
      const nowMicro = BigInt(Date.now()) * 1000n
      const since = nowMicro - BigInt(days) * 86400n * 1000000n
      const since7 = nowMicro - 7n * 86400n * 1000000n
      const res = db.exec(
        'SELECT p.url, p.title, MAX(v.visit_date) AS t, COUNT(v.id) AS c, ' +
        'SUM(CASE WHEN v.visit_date > ' + since7.toString() + ' THEN 1 ELSE 0 END) AS c7, ' +
        'MIN(v.visit_date) AS tmin ' +
        'FROM moz_places p JOIN moz_historyvisits v ON v.place_id = p.id ' +
        'WHERE v.visit_date > ' + since.toString() + ' ' +
        'GROUP BY p.id ORDER BY t DESC LIMIT ' + Math.trunc(limit))
      const toMs = (v) => Number(BigInt(String(v)) / 1000n)
      if (res && res[0]) {
        for (const r of res[0].values) {
          rows.push({
            url: String(r[0] || ''), title: String(r[1] || ''),
            at: toMs(r[2]), hits: Number(r[3] || 1),
            h7: Number(r[4] || 0),
            first: r[5] != null ? toMs(r[5]) : toMs(r[2])
          })
        }
      }
      try {
        const hv = db.exec('SELECT visit_date FROM moz_historyvisits WHERE visit_date > ' + since.toString())
        if (hv && hv[0]) {
          for (const row of hv[0].values) {
            const h = new Date(toMs(row[0])).getHours()
            if (h >= 0 && h < 24) hourly[h] += 1
          }
        }
      } catch { }
      try { total += Number(db.exec('SELECT COUNT(*) FROM moz_places')[0].values[0][0]) } catch { }
      break // 只读第一个有历史的 profile（多开 profile 场景少见，避免重复计数）
    } catch { /* 单个 profile 坏了不影响别的 */ } finally {
      try { if (db) db.close() } catch { }
      cleanup(tmp)
    }
  }
  return { rows, total, hourly }
}

/**
 * 采集全部浏览器历史。
 * @returns {{ok:boolean, sources:Array, days:number, totalVisits:number,
 *            domains:Array<{host,hits,visits,last,title}>, recent:Array, hourly:number[]}}
 */
async function collect ({ days = 14, limit = 4000 } = {}) {
  const sources = []
  const all = []
  const hourAgg = new Array(24).fill(0)
  for (const b of CHROMIUM_BROWSERS) {
    const profs = chromiumProfiles(b.root)
    for (const p of profs) {
      try {
        const r = await readChromium(p.file, { days, limit: Math.max(500, Math.round(limit / Math.max(1, profs.length))) })
        if (r.rows.length) {
          sources.push({ browser: b.name, profile: p.profile, recent: r.rows.length, total: r.total })
          for (const row of r.rows) all.push({ ...row, browser: b.name })
          if (r.hourly) for (let i = 0; i < 24; i++) hourAgg[i] += r.hourly[i]
        }
      } catch { /* 库版本不兼容/读不了就跳过 */ }
    }
  }
  try {
    const ff = await readFirefox({ days, limit })
    if (ff.rows.length) {
      sources.push({ browser: 'Firefox', profile: '*', recent: ff.rows.length, total: ff.total })
      for (const row of ff.rows) all.push({ ...row, browser: 'Firefox' })
      if (ff.hourly) for (let i = 0; i < 24; i++) hourAgg[i] += ff.hourly[i]
    }
  } catch { }

  /* ---- 聚合 ---- */
  all.sort((a, b) => b.at - a.at)
  const byHost = new Map()
  const hourly = new Array(24).fill(0)
  const searches = []
  const seenQ = new Set()
  const now = Date.now()
  for (const r of all) {
    const host = hostOf(r.url)
    if (!host) continue
    /* 搜索词：同一关键词只留最近一次（all 已按时间倒序） */
    const q = searchQueryOf(r.url)
    if (q) {
      const k = q.toLowerCase()
      if (!seenQ.has(k)) {
        seenQ.add(k)
        searches.push({ q, host, at: r.at })
      }
    }
    const h7 = Number(r.h7) || 0
    const h7p = Math.max(0, (Number(r.hits) || 0) - h7)
    const first = r.first || r.at
    const cur = byHost.get(host)
    if (!cur) {
      byHost.set(host, {
        host,
        hits: r.hits,
        visits: 1,
        last: r.at,
        first,
        title: r.title.slice(0, 80),
        h7,
        h7p
      })
    } else {
      cur.hits += r.hits
      cur.visits += 1
      cur.h7 += h7
      cur.h7p += h7p
      if (r.at > cur.last) { cur.last = r.at; if (r.title) cur.title = r.title.slice(0, 80) }
      if (first < cur.first) cur.first = first
    }
  }
  /* 小时分布兜底：万一明细查询失败（老库/权限），退回按 URL 最后时间加权，好歹有个形状 */
  const hourSum = hourAgg.reduce((a, c) => a + c, 0)
  if (!hourSum) {
    for (const r of all) {
      const h = new Date(r.at).getHours()
      if (h >= 0 && h < 24) hourAgg[h] += Math.max(1, r.hits)
    }
  }
  const domains = [...byHost.values()].sort((a, b) => b.hits - a.hits).slice(0, 60)

  /* 书签：长期兴趣（读 JSON，不走 sql.js，很快） */
  let bookmarks = []
  for (const b of CHROMIUM_BROWSERS) {
    try {
      const list = readChromiumBookmarks(b.root)
      if (list.length) bookmarks = bookmarks.concat(list)
    } catch { }
  }
  {
    const seenB = new Set()
    bookmarks = bookmarks.filter((x) => {
      const k = x.name + '|' + x.host
      if (seenB.has(k)) return false
      seenB.add(k)
      return true
    }).slice(0, 120)
  }

  /* 最近记录：同一 URL 只留一条，标题剥掉「- 哔哩哔哩」这类站点后缀噪音 */
  const seen = new Set()
  const recent = []
  for (const r of all) {
    const key = cleanUrl(r.url)
    if (seen.has(key)) continue
    seen.add(key)
    recent.push({
      title: String(r.title || '').replace(/\s*[-_|]\s*(哔哩哔哩|bilibili|百度|知乎|YouTube|Google)$/i, '').trim().slice(0, 90),
      url: key,
      host: hostOf(r.url),
      at: r.at
    })
    if (recent.length >= 300) break
  }

  return {
    ok: all.length > 0,
    sources,
    days,
    totalVisits: all.length,
    domains,
    recent,
    searches: searches.slice(0, 200),
    bookmarks,
    hourly: hourAgg
  }
}

module.exports = { collect, hostOf, cleanUrl, chromiumProfiles, searchQueryOf }
