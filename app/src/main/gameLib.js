'use strict'
/**
 * 游戏 / 程序库自动发现与启动（S6.5）
 *
 * 三个来源，全部只读本机文件，不联网：
 *   Steam  → 注册表 SteamPath + steamapps/libraryfolders.vdf + appmanifest_*.acf
 *   Epic   → %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item
 *   开始菜单 → 两个 Start Menu\Programs 目录里的 .lnk / .url
 *
 * 启动一律走 ShellExecute（Electron shell.openPath / openExternal）：
 *   steam://rungameid/<appid> / com.epicgames.launcher://apps/<app>?action=launch
 * 这样不用关心 Steam 装在哪、游戏是 Win32 还是 UWP。
 *
 * 条目结构（与 store.global.library 一致，另加 source）：
 *   { id, name, kind: 'exe'|'url'|'lnk', target, source, hue, cover }
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
// 纯 Node 下 require('electron') 拿到的是可执行文件路径（没有 shell）——
// 扫描逻辑因此可以脱离 Electron 单测，启动时才需要真宿主
let shell = null
try { shell = require('electron').shell || null } catch {}
const { log } = require('./logger')

const STEAM_URI = (appid) => 'steam://rungameid/' + appid
// 开始菜单里这些条目不是「程序」：卸载项、说明文档、运行库、驱动
const SKIP_RE = /(卸载|解除安装|uninstall|readme|manual|帮助|help|文档|说明|驱动|运行库|directx|vcredist|redistributable|steamworks|wallpaper engine|升级|更新程序|website|官网|主页|settings)/i

const MENUS = [
  path.join(process.env['ProgramData'] || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(process.env['APPDATA'] || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
].filter((p) => p && fs.existsSync(p))

function hue (s) {
  let h = 0
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360
  return h
}

/** 名字规范化：小写、去扩展名、去空格与「- 快捷方式」这类尾巴 */
function norm (s) {
  return String(s || '')
    .replace(/\.(lnk|url|exe)$/i, '')
    .replace(/[-_—]?\s*(快捷方式|shortcut)$/i, '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
}

/* ------------------------------------------------------------- Steam */

function steamRoots () {
  const out = []
  try {
    const r = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
      encoding: 'utf8', windowsHide: true, timeout: 4000
    })
    const m = r.match(/SteamPath\s+REG_SZ\s+(.+)/i)
    if (m) out.push(m[1].trim().replace(/\\\\/g, '\\'))
  } catch { /* 没装 Steam / 非 Windows */ }
  for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', 'D:\\Steam']) {
    if (fs.existsSync(p)) out.push(p)
  }
  /* 装在非 C 盘的人不少（注册表读不到时的退路）：挨个盘看根目录下的 Steam */
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    const p = drive + ':\\Steam'
    if (fs.existsSync(path.join(p, 'userdata')) || fs.existsSync(path.join(p, 'steamapps'))) out.push(p)
  }
  return [...new Set(out.filter((p) => fs.existsSync(p)))]
}

function libFolders (root) {
  const out = [root]
  const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf')
  try {
    const text = fs.readFileSync(vdf, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/"path"\s+"([^"]+)"/i)
      if (m) out.push(m[1].replace(/\\\\/g, '\\'))
    }
  } catch { /* 老版本 Steam 没有这个文件 */ }
  return [...new Set(out)]
}

function scanSteam () {
  const games = []
  for (const root of steamRoots()) {
    for (const lib of libFolders(root)) {
      const apps = path.join(lib, 'steamapps')
      let files = []
      try { files = fs.readdirSync(apps).filter((f) => /^appmanifest_\d+\.acf$/i.test(f)) } catch { continue }
      for (const f of files) {
        let text = ''
        try { text = fs.readFileSync(path.join(apps, f), 'utf8') } catch { continue }
        const get = (k) => {
          const m = text.match(new RegExp('"' + k + '"\\s+"([^"]*)"', 'i'))
          return m ? m[1] : ''
        }
        const appid = get('appid') || f.match(/\d+/)[0]
        const name = get('name')
        if (!name || !appid) continue
        // 只跳过明显的工具/运行库，别把「游戏原声」这类误杀太多
        if (/^(Steamworks|Steam Linux Runtime|Proton|SteamVR)/i.test(name)) continue
        games.push({
          id: 'st_' + appid,
          name,
          kind: 'url',
          target: STEAM_URI(appid),
          source: 'steam',
          appid,
          hue: hue(name)
        })
      }
    }
  }
  return games
}

/* -------------------------------------------------------------- Epic */

function scanEpic () {
  const dir = path.join(process.env['ProgramData'] || 'C:\\ProgramData',
    'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  const games = []
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => /\.item$/i.test(f)) } catch { return games }
  for (const f of files) {
    let j = null
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
    const name = j.DisplayName || j.AppName
    if (!name) continue
    // 引擎 / 插件不是游戏
    if (/^(UE_|Unreal Engine|Epic Games Launcher)/i.test(name)) continue
    const app = j.AppName || j.CatalogItemId
    games.push({
      id: 'ep_' + (j.AppName || f),
      name,
      kind: 'url',
      target: 'com.epicgames.launcher://apps/' + encodeURIComponent(app) + '?action=launch&silent=true',
      source: 'epic',
      hue: hue(name)
    })
  }
  return games
}

/* ---------------------------------------------------------- 开始菜单 */

/** 递归收集开始菜单快捷方式：{ name, lnk, isUrl }（5 分钟内复用结果） */
let smCache = null
function scanStartMenu (limit = 1200, force = false) {
  if (!force && smCache && Date.now() - smCache.at < 300000) return smCache.list
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 6) return
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (out.length >= limit) return
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!/\.(lnk|url)$/i.test(e.name)) continue
      const name = e.name.replace(/\.(lnk|url)$/i, '')
      if (!name || SKIP_RE.test(name) || SKIP_RE.test(path.basename(path.dirname(p)))) continue
      out.push({ name, lnk: p, isUrl: /\.url$/i.test(e.name) })
    }
  }
  for (const d of MENUS) walk(d, 0)
  smCache = { at: Date.now(), list: out }
  return out
}

/* --------------------------------------------------- App Paths（已注册的程序）

   开始菜单不一定有快捷方式（绿色版 / 只注册了 App Paths 的安装包），
   这里读 Windows 标准的 App Paths 注册表键，拿到 exe 完整路径。
   键名就是 exe 名（WeChat.exe），正好用来按名字匹配。 */

let apCache = null

function scanAppPaths () {
  if (apCache && Date.now() - apCache.at < 600000) return apCache.list
  const list = []
  const seen = new Set()
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'
  ]
  for (const r of roots) {
    let out = ''
    try {
      out = execFileSync('reg', ['query', r, '/s'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    } catch { continue }
    let cur = ''
    for (const line of out.split(/\r?\n/)) {
      const key = line.match(/App Paths\\([^\\]+)\s*$/i)
      if (key) { cur = key[1].trim(); continue }
      if (!cur || !/\.exe$/i.test(cur)) continue
      if (!/REG_SZ/i.test(line)) continue
      const p = line.replace(/^.*?REG_SZ\s+/, '').trim().replace(/^"|"$/g, '')
      if (!/^[a-zA-Z]:[\\/].*\.exe$/i.test(p) || !fs.existsSync(p)) continue
      const lower = p.toLowerCase()
      if (!seen.has(lower)) {
        seen.add(lower)
        list.push({ name: cur.replace(/\.exe$/i, ''), exe: p })
      }
      cur = ''
    }
  }
  apCache = { at: Date.now(), list }
  return list
}

/* 口语中文名 → 注册/快捷方式里的英文名（用户说「微信」，程序叫 WeChat） */
const ALIAS = {
  微信: ['wechat', 'weixin'],
  企业微信: ['wxwork'],
  钉钉: ['dingtalk'],
  飞书: ['feishu', 'lark'],
  网易云音乐: ['cloudmusic', 'netease'],
  浏览器: ['chrome', 'msedge', 'firefox'],
  记事本: ['notepad'],
  计算器: ['calc'],
  任务管理器: ['taskmgr'],
  命令提示符: ['cmd'],
  资源管理器: ['explorer'],
  截图工具: ['snippingtool', 'screenclip'],
  设置: ['systemsettings', 'ms-settings'],
  抠图: ['koutu'],
  qq: ['qq'],
  腾讯qq: ['qq']
}

function expandQuery (q) {
  const out = new Set([q])
  for (const [k, v] of Object.entries(ALIAS)) {
    const nk = norm(k)
    if (nk === q || q.includes(nk) || nk.includes(q)) v.forEach((x) => out.add(norm(x)))
  }
  return [...out]
}

/* ------------------------------------------------------------- 统一 */

/**
 * 全量扫描：返回 { steam, epic, startmenu }
 * 只在用户点「导入」或模型第一次要开游戏时调用（有 10 分钟缓存）
 */
let cache = null
function discover (force) {
  if (cache && !force && Date.now() - cache.at < 600000) return cache.data
  const started = Date.now()
  let steam = []
  let epic = []
  try { steam = scanSteam() } catch (e) { log('[gameLib] Steam 扫描失败:', e.message) }
  try { epic = scanEpic() } catch (e) { log('[gameLib] Epic 扫描失败:', e.message) }
  const startmenu = scanStartMenu(1200, !!force)
  const data = { steam, epic, startmenu, at: Date.now() }
  cache = { at: Date.now(), data }
  log('[gameLib] 扫描完成 steam=' + steam.length + ' epic=' + epic.length + ' startmenu=' + startmenu.length + ' ms=' + (Date.now() - started))
  return data
}

function invalidate () { cache = null; smCache = null; apCache = null }

/* ------------------------------------------------------------- 启动 */

function launchEntry (entry) {
  if (!entry || !entry.target) throw new Error('启动项没有路径')
  if (!shell) throw new Error('启动器不可用（不在 Electron 主进程里）')
  // 盘符路径 = 本地文件；其余（steam://、com.epicgames.launcher://、ms-settings:）
  // 一律交给协议处理器
  const isFsPath = /^[a-zA-Z]:[\\/]/.test(entry.target) || /^\\\\/.test(entry.target)
  if (entry.kind === 'url' || !isFsPath) {
    shell.openExternal(entry.target)
    return { ok: true, via: 'url', target: entry.target }
  }
  const p = entry.target
  if (!fs.existsSync(p)) throw new Error('文件不存在：' + p)
  shell.openPath(p).then((err) => { if (err) log('[gameLib] openPath 失败:', err) })
  return { ok: true, via: path.extname(p).replace('.', '') || 'path', target: p }
}

/**
 * 在库里按名字找（支持「QQ」「原神」「Steam」这类口语）：
 * 匹配顺序 精确 → 前缀 → 包含；开始菜单条目也算候选。
 */
function findByQuery (query, library) {
  const q = norm(query)
  if (!q) return null
  const queries = expandQuery(q)
  const items = []
  for (const g of (library || [])) items.push({ ...g, from: 'library' })
  for (const s of scanStartMenu()) {
    items.push({
      id: 'sm_' + s.lnk,
      name: s.name,
      kind: s.isUrl ? 'url' : 'lnk',
      target: s.lnk,
      source: 'startmenu',
      hue: hue(s.name),
      from: 'startmenu'
    })
  }
  for (const a of scanAppPaths()) {
    items.push({
      id: 'ap_' + a.exe,
      name: a.name,
      kind: 'exe',
      target: a.exe,
      source: 'apppath',
      hue: hue(a.name),
      from: 'apppath'
    })
  }
  const scored = []
  for (const it of items) {
    const n = norm(it.name)
    if (!n) continue
    let score = 0
    for (const qq of queries) {
      if (n === qq) score = Math.max(score, 100)
      else if (n.startsWith(qq)) score = Math.max(score, 80)
      else if (n.includes(qq)) score = Math.max(score, 60)
      else if (qq.includes(n) && n.length >= 2) score = Math.max(score, 40)
    }
    if (!score) continue
    // 同一个程序在库和开始菜单都有：库里那条更可信
    if (it.from === 'library') score += 5
    scored.push({ it, score, len: n.length })
  }
  // 名字越短越像用户说的那个（「QQ」优先于「QQ游戏大厅」）
  scored.sort((a, b) => b.score - a.score || a.len - b.len)
  return scored.length ? scored[0].it : null
}

/** 有哪些程序可开（给模型一个可读清单，避免它瞎猜名字） */
function candidates (library, limit = 40) {
  const names = []
  const seen = new Set()
  for (const g of (library || [])) {
    const k = norm(g.name)
    if (!k || seen.has(k)) continue
    seen.add(k); names.push(g.name)
  }
  for (const s of scanStartMenu()) {
    const k = norm(s.name)
    if (!k || seen.has(k)) continue
    seen.add(k); names.push(s.name)
    if (names.length >= limit * 3) break
  }
  return names.slice(0, limit)
}

module.exports = { discover, invalidate, launchEntry, findByQuery, candidates, scanStartMenu, scanSteam, scanEpic, norm, steamRoots }
