/**
 * 电脑画像 · 文件与磁盘（**只读**，只看名字不看内容）
 *
 * 扫主人常用的几个文件夹（桌面/文档/下载/图片/视频/音乐）的顶层 + 一层子目录，
 * 只记录 **文件名、大小、修改时间**——不打开文件、不读内容、不改不删。
 * 目的：让她知道「你硬盘里有什么、最近在折腾什么」，而不是让她翻你的东西。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const MAX_PER_DIR = 250
const MAX_TOTAL = 2500

/** 优先用 Electron 的系统目录（中文 Windows 的「桌面」也能拿对），拿不到退回 homedir */
function baseDirs () {
  let p = {}
  try {
    const { app } = require('electron')
    p = {
      desktop: app.getPath('desktop'),
      documents: app.getPath('documents'),
      downloads: app.getPath('downloads'),
      pictures: app.getPath('pictures'),
      videos: app.getPath('videos'),
      music: app.getPath('music')
    }
  } catch {
    const h = os.homedir()
    p = {
      desktop: path.join(h, 'Desktop'),
      documents: path.join(h, 'Documents'),
      downloads: path.join(h, 'Downloads'),
      pictures: path.join(h, 'Pictures'),
      videos: path.join(h, 'Videos'),
      music: path.join(h, 'Music')
    }
    /* OneDrive 接管了「桌面/文档」时真实的目录在 OneDrive 下 */
    const od = path.join(h, 'OneDrive')
    if (fs.existsSync(od)) {
      for (const k of ['desktop', 'documents', 'pictures']) {
        const alt = path.join(od, path.basename(p[k]))
        if (!fs.existsSync(p[k]) && fs.existsSync(alt)) p[k] = alt
      }
    }
  }
  const out = []
  const seen = new Set()
  for (const [key, dir] of Object.entries(p)) {
    if (!dir || seen.has(dir)) continue
    try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
    seen.add(dir)
    out.push({ key, dir })
  }
  return out
}

/** 目录名过滤：这些是缓存/系统目录，扫了没意义还慢 */
const SKIP_DIR = /^(\$RECYCLE\.BIN|System Volume Information|node_modules|\.git|AppData|Windows|Program Files.*|__pycache__|\.cache|\.gradle|\.nuget)$/i

function extOf (name) {
  const e = path.extname(name).toLowerCase().replace('.', '')
  return e || '(无扩展名)'
}

/**
 * @returns {{ok:boolean, dirs:Array, byExt:Array, recent:Array, big:Array, totalFiles:number}}
 */
function collect ({ maxPerDir = MAX_PER_DIR, maxTotal = MAX_TOTAL } = {}) {
  const items = []
  const dirs = []
  const seen = new Set()

  const push = (full, name, st, group) => {
    if (items.length >= maxTotal) return
    const key = full.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    items.push({
      name,
      group,
      dir: path.dirname(full),
      ext: extOf(name),
      bytes: st.size,
      at: st.mtimeMs
    })
  }

  for (const { key, dir } of baseDirs()) {
    let files = 0
    let subdirs = 0
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents.slice(0, maxPerDir * 2)) {
      if (files >= maxPerDir || items.length >= maxTotal) break
      const full = path.join(dir, e.name)
      try {
        if (e.isDirectory()) {
          if (SKIP_DIR.test(e.name)) continue
          subdirs += 1
          /* 子目录只取一层，只收文件名 + 大小（够判断「这是个什么项目/文件夹」） */
          let sub = []
          try { sub = fs.readdirSync(full, { withFileTypes: true }) } catch { continue }
          for (const s of sub.slice(0, 40)) {
            if (s.isDirectory()) continue
            try {
              const st = fs.statSync(path.join(full, s.name))
              push(path.join(full, s.name), s.name, st, key)
              files += 1
            } catch { }
          }
        } else {
          const st = fs.statSync(full)
          push(full, e.name, st, key)
          files += 1
        }
      } catch { }
    }
    dirs.push({ group: key, path: dir, files, subdirs })
  }

  const byExtMap = new Map()
  for (const it of items) {
    const cur = byExtMap.get(it.ext) || { ext: it.ext, count: 0, bytes: 0 }
    cur.count += 1
    cur.bytes += it.bytes
    byExtMap.set(it.ext, cur)
  }
  const byExt = [...byExtMap.values()].sort((a, b) => b.count - a.count).slice(0, 30)
    .map((x) => ({ ext: x.ext, count: x.count, mb: Math.round((x.bytes / 1048576) * 10) / 10 }))

  const recent = items.slice().sort((a, b) => b.at - a.at).slice(0, 40)
    .map((x) => ({ name: x.name, group: x.group, mb: Math.round((x.bytes / 1048576) * 10) / 10, at: x.at }))

  const big = items.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 20)
    .map((x) => ({ name: x.name, group: x.group, mb: Math.round((x.bytes / 1048576) * 10) / 10, at: x.at }))

  return { ok: items.length > 0, dirs, byExt, recent, big, totalFiles: items.length }
}

module.exports = { collect, baseDirs }
