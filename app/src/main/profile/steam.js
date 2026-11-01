/**
 * 电脑画像 · Steam 真实游玩时长（**只读**）
 *
 * 为什么要它：`games.js` 只知道「装了什么」，装 45 个 ≠ 在玩。
 * Steam 把每款游戏的累计分钟数写在 `userdata/<账号>/config/localconfig.vdf` 里，
 * 读它才知道「他真正在玩的是哪两个」——这是「了解他」和「列清单」的区别。
 *
 * 硬约束：只读这个 vdf，不读账号密码、不联网、不上报。只取 appid / 分钟数 / 最后游玩时间。
 */
const fs = require('node:fs')
const path = require('node:path')

/** VDF 词法：带引号的字符串、大括号、裸词（数字/布尔） */
function tokenize (text) {
  const out = []
  let i = 0
  const s = String(text || '')
  while (i < s.length) {
    const c = s[i]
    if (c === '"') {
      let j = i + 1
      let buf = ''
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue }
        buf += s[j]
        j++
      }
      out.push(buf)
      i = j + 1
      continue
    }
    if (c === '{' || c === '}') { out.push(c); i++; continue }
    if (/\s/.test(c)) { i++; continue }
    let j = i
    let buf = ''
    while (j < s.length && !/[\s{}]/.test(s[j])) { buf += s[j]; j++ }
    out.push(buf)
    i = j
  }
  return out
}

/** 把 VDF 解析成普通对象（够用版：不处理 #include / 条件平台） */
function parseVdf (text) {
  const t = tokenize(text)
  let i = 0
  const parseObj = () => {
    const o = {}
    while (i < t.length) {
      const k = t[i++]
      if (k === '}') return o
      if (k === '{') continue
      if (t[i] === '{') { i++; o[k] = parseObj() } else { o[k] = t[i++] }
    }
    return o
  }
  return parseObj()
}

/** 大小写不敏感取子节点（Steam 自己也不统一：有的版本写 Software/Valve/Steam，有的是小写） */
function getCI (obj, name) {
  if (!obj || typeof obj !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name]
  const low = String(name).toLowerCase()
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === low) return obj[k]
  }
  return undefined
}

/**
 * 从 localconfig.vdf 文本里取游玩记录。
 * 结构：UserLocalConfigStore → Software → valve → steam → Apps → "<appid>" → { Playtime, LastPlayed }
 * @returns {{[appid:string]: {minutes:number, lastPlayed:number}}}
 */
function parseLocalConfig (text) {
  const root = parseVdf(text)
  const svc = getCI(root, 'UserLocalConfigStore') || root
  const apps = getCI(getCI(getCI(getCI(svc, 'Software'), 'Valve'), 'Steam'), 'Apps')
  const out = {}
  if (!apps || typeof apps !== 'object') return out
  for (const [appid, v] of Object.entries(apps)) {
    if (!/^\d+$/.test(appid) || !v || typeof v !== 'object') continue
    const minutes = Math.max(0, Math.round(Number(getCI(v, 'Playtime')) || 0))
    const lastPlayed = Math.max(0, Number(getCI(v, 'LastPlayed')) || 0)
    if (!minutes && !lastPlayed) continue
    out[appid] = { minutes, lastPlayed }
  }
  return out
}

/** 列出 userdata 下的账号目录（只取数字 id，不读账号名） */
function userDataDirs (root) {
  const base = path.join(root, 'userdata')
  let ents = []
  try { ents = fs.readdirSync(base, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of ents) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue
    if (e.name === '0') continue // 0 是匿名/公共配置，没有游玩记录
    const f = path.join(base, e.name, 'config', 'localconfig.vdf')
    if (fs.existsSync(f)) out.push(f)
  }
  return out
}

/** appid → 游戏名（优先用调用方给的，否则自己问 gameLib 要一份） */
function namesFromGameLib () {
  const map = new Map()
  try {
    const lib = require('../gameLib')
    for (const g of (lib.discover().steam || [])) {
      const id = String(g.appid || g.id || '').replace(/^st_/, '')
      if (id && g.name) map.set(id, g.name)
    }
  } catch { }
  return map
}

/**
 * @param {{roots?:string[], gameNames?:Map<string,string>}} o
 *   roots       Steam 安装目录列表（不传就自己找）
 *   gameNames   appid → 游戏名（不传就问 gameLib，读不到就叫 App <id>）
 * @returns {{ok:boolean, games:Array, totalHours:number, files:number}}
 */
function collect ({ roots = null, gameNames = null } = {}) {
  let list = roots
  if (!list) {
    try { list = require('../gameLib').steamRoots() } catch { list = [] }
  }
  const names = gameNames || namesFromGameLib()
  const merged = {}
  let files = 0
  for (const root of list || []) {
    for (const file of userDataDirs(root)) {
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch { continue }
      files++
      const one = parseLocalConfig(text)
      for (const [appid, rec] of Object.entries(one)) {
        const cur = merged[appid]
        if (!cur || rec.minutes > cur.minutes) merged[appid] = rec
      }
    }
  }

  const games = Object.entries(merged)
    .map(([appid, rec]) => ({
      appid,
      name: names.get(appid) || ('App ' + appid),
      hours: Math.round((rec.minutes / 60) * 10) / 10,
      minutes: rec.minutes,
      lastPlayed: rec.lastPlayed ? rec.lastPlayed * 1000 : 0
    }))
    .filter((g) => g.minutes >= 5)
    .sort((a, b) => b.minutes - a.minutes)

  const totalMinutes = games.reduce((n, g) => n + g.minutes, 0)
  return {
    ok: games.length > 0,
    games: games.slice(0, 60),
    totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    files
  }
}

module.exports = { collect, parseLocalConfig, parseVdf, tokenize, userDataDirs }
