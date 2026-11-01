/**
 * 工作区自动整理（0.19.0）
 *
 * 参考项目行为：根目录文件多了就按月份归到 archive/ 里，文件树默认折叠，
 * 移动也记进版本历史（= git commit）。
 *
 * 规则（保守，宁可不动）：
 *   · 只碰工作区**根目录**里的 .md / .txt / .json
 *   · PARTNER.md 永不移动（人设与记忆主干）
 *   · 超过 maxAgeDays 天的移走；数量超过 maxFiles 的，从最旧的开始移
 *   · 永远至少留 4 个最近的文件在根目录，避免越整理越空
 *   · 目标 archive/YYYY-MM/，重名自动加 (2)(3)
 */
import fs from 'node:fs'
import path from 'node:path'

export const ARCHIVE_DIR = 'archive'
export const KEEP_FILES = ['PARTNER.md']
export const DEFAULT_MAX_FILES = 12
export const DEFAULT_MAX_AGE_DAYS = 30

/** 纯函数：给一批目录项，算出该移走哪些（方便测试，不碰磁盘） */
export function planArchive ({ entries = [], now = Date.now(), maxFiles = DEFAULT_MAX_FILES, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const keep = new Set(KEEP_FILES)
  const files = entries
    .filter((e) => e && e.isFile && !keep.has(e.name) && /\.(md|txt|json)$/i.test(e.name))
    .map((e) => ({ name: e.name, mtimeMs: Number(e.mtimeMs) || 0 }))
  if (!files.length) return []
  const keepCount = Math.max(4, maxFiles)
  const over = Math.max(0, files.length - keepCount)
  const deadline = now - maxAgeDays * 86400000
  const sorted = files.slice().sort((a, b) => a.mtimeMs - b.mtimeMs)
  const picked = new Set(files.filter((f) => f.mtimeMs < deadline).map((f) => f.name))
  for (let i = 0; i < over; i++) picked.add(sorted[i].name)
  return sorted.filter((f) => picked.has(f.name)).map((f) => f.name)
}

function monthDir (now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function uniqueTarget (dir, name) {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  let target = path.join(dir, name)
  let n = 2
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base} (${n})${ext}`)
    n++
  }
  return target
}

/**
 * 真正执行整理（同步、文件数很少，不值得异步）
 * @returns {{ moved: string[], dir: string }}
 */
export function applyArchive (workspaceDir, opts = {}) {
  const empty = { moved: [], dir: '' }
  try {
    if (!workspaceDir || !fs.existsSync(workspaceDir)) return empty
    const entries = fs.readdirSync(workspaceDir, { withFileTypes: true }).map((e) => {
      let mtimeMs = 0
      try { mtimeMs = fs.statSync(path.join(workspaceDir, e.name)).mtimeMs } catch { }
      return { name: e.name, isFile: e.isFile(), mtimeMs }
    })
    const names = planArchive({ entries, ...opts })
    if (!names.length) return empty
    const bucket = monthDir(opts.now || Date.now())
    const targetDir = path.join(workspaceDir, ARCHIVE_DIR, bucket)
    fs.mkdirSync(targetDir, { recursive: true })
    const moved = []
    for (const name of names) {
      try {
        fs.renameSync(path.join(workspaceDir, name), uniqueTarget(targetDir, name))
        moved.push(name)
      } catch { /* 单个失败不影响其它 */ }
    }
    return { moved, dir: path.join(ARCHIVE_DIR, bucket) }
  } catch {
    return empty
  }
}
