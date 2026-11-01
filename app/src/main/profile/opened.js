/**
 * 电脑画像 · 最近打开过的文件（**只读，只看文件名**）
 *
 * 为什么单独做一个采集器：`files.js` 看的是「硬盘里有什么」，按修改时间排；
 * 但「他最近真的在用什么」是另一回事——一个文件可以躺两年没动，也可以一天打开五次。
 * Windows 的「最近使用」(Recent) 目录给的就是这个信号，任何程序打开文件都会在这里留一个 .lnk。
 *
 * 有播放器配置文件（VLC / PotPlayer / mpv）时再补一份播放历史，能拿到「看的是什么片」。
 * 硬约束：不解析 .lnk 指向的真实路径（那会暴露完整盘符路径），只取文件名和链接时间。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MAX_RECENT = 150

/** 扩展名 → 大类。不在表里的（快捷方式目录、临时文件）直接丢 */
const KIND = {
  video: 'mp4 mkv avi mov wmv flv webm m4v rmvb ts mpg mpeg 3gp m2ts',
  audio: 'mp3 flac wav m4a aac ogg ape opus',
  image: 'jpg jpeg png gif webp bmp psd heic',
  doc: 'pdf doc docx xls xlsx ppt pptx txt md rtf csv',
  code: 'js ts jsx tsx py java c cpp h go rs json html css sh',
  archive: 'zip rar 7z iso tar gz'
}
const KIND_MAP = new Map()
for (const [kind, list] of Object.entries(KIND)) {
  for (const e of list.split(' ')) KIND_MAP.set(e, kind)
}
const KIND_ZH = { video: '影片', audio: '音频', image: '图片', doc: '文档', code: '代码', archive: '压缩包' }


function kindOf (name) {
  const parts = String(name || '').split('.')
  if (parts.length < 2) return ''
  /* 「a.mp4.lnk」这种：去掉 .lnk 再取扩展名 */
  const clean = /\.lnk$/i.test(name) ? name.slice(0, -4) : name
  const p2 = clean.split('.')
  if (p2.length < 2) return ''
  return KIND_MAP.get(p2.pop().toLowerCase()) || ''
}

function recentDir () {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Microsoft', 'Windows', 'Recent')
}

/**
 * 读 Recent 目录。
 * @returns {Array<{name:string, kind:string, at:number}>}
 */
function collectRecent ({ max = MAX_RECENT } = {}) {
  const dir = recentDir()
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of ents) {
    if (!e.isFile()) continue
    if (!/\.lnk$/i.test(e.name)) continue
    const kind = kindOf(e.name)
    if (!kind) continue
    const name = e.name.slice(0, -4)
    let at = 0
    try { at = fs.statSync(path.join(dir, e.name)).mtimeMs } catch { continue }
    out.push({ name, kind, at })
  }
  out.sort((a, b) => b.at - a.at)
  /* 同名文件反复打开只留最近一次 */
  const seen = new Set()
  const dedup = []
  for (const it of out) {
    const k = it.name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    dedup.push(it)
    if (dedup.length >= max) break
  }
  return dedup
}

/** VLC 的最近播放（%APPDATA%\vlc\vlc-qt-interface.ini 的 [RecentsMRL] list=file:///…） */
function parseVlcIni (text) {
  const out = []
  let inSec = false
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (/^\[/.test(t)) { inSec = /^\[RecentsMRL\]/i.test(t); continue }
    if (!inSec) continue
    const m = t.match(/^list\s*=\s*(.+)$/i)
    if (!m) continue
    for (const raw of m[1].split(',')) {
      const u = raw.trim().replace(/^file:\/\/\//i, '')
      if (!u) continue
      let name = u
      try { name = decodeURIComponent(u) } catch { }
      name = name.split('/').pop()
      const kind = kindOf(name)
      if (kind) out.push({ name, kind, player: 'VLC', at: 0 })
    }
  }
  return out
}

/** PotPlayer 的 ini：最近列表没有固定段名，直接在全文里找带媒体扩展名的路径 */
function parsePotPlayerIni (text) {
  const out = []
  const re = /([^\r\n="]+\.(?:mp4|mkv|avi|mov|wmv|flv|webm|m4v|rmvb|ts|mp3|flac|wav|m4a|aac|ogg))(?=["\r\n]|$)/gi
  let m
  const seen = new Set()
  while ((m = re.exec(String(text || ''))) !== null) {
    const full = m[1].trim()
    const name = full.split(/[\\/]/).pop()
    const kind = kindOf(name)
    if (!kind || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({ name, kind, player: 'PotPlayer', at: 0 })
    if (out.length >= 40) break
  }
  return out
}

/** 各播放器的历史文件（有就加一份，没有不影响） */
function collectPlayers () {
  const appData = process.env.APPDATA || ''
  const cands = [
    { player: 'VLC', file: path.join(appData, 'vlc', 'vlc-qt-interface.ini'), parse: parseVlcIni },
    { player: 'PotPlayer', file: path.join(appData, 'PotPlayerMini64', 'PotPlayerMini64.ini'), parse: parsePotPlayerIni },
    { player: 'PotPlayer', file: path.join(appData, 'PotPlayerMini', 'PotPlayerMini.ini'), parse: parsePotPlayerIni }
  ]
  const out = []
  const hitPlayers = []
  for (const c of cands) {
    if (!fs.existsSync(c.file)) continue
    let text = ''
    try { text = fs.readFileSync(c.file, 'utf8') } catch { continue }
    const rows = c.parse(text)
    if (rows.length) { out.push(...rows); hitPlayers.push(c.player) }
  }
  return { rows: out, players: [...new Set(hitPlayers)] }
}

/**
 * @returns {{ok:boolean, recent:Array, byKind:Array, players:Array, total:number}}
 */
function collect ({ max = MAX_RECENT } = {}) {
  const recent = collectRecent({ max })
  const extra = collectPlayers()

  /* 播放器历史没有时间戳，排在 Recent 之后；同名的不重复记 */
  const seen = new Set(recent.map((r) => r.name.toLowerCase()))
  const merged = recent.slice()
  for (const r of extra.rows) {
    if (seen.has(r.name.toLowerCase())) continue
    seen.add(r.name.toLowerCase())
    merged.push(r)
  }

  const counts = new Map()
  for (const it of merged) counts.set(it.kind, (counts.get(it.kind) || 0) + 1)
  const byKind = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => ({ kind, label: KIND_ZH[kind] || kind, count: n }))

  return {
    ok: merged.length > 0,
    recent: merged.slice(0, max),
    byKind,
    players: extra.players,
    total: merged.length
  }
}

module.exports = { collect, collectRecent, collectPlayers, parseVlcIni, parsePotPlayerIni, kindOf, KIND_ZH }
