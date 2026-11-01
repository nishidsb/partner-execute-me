/**
 * 记忆工作区：PARTNER.md（单文件、每次整份进 prompt）+ Git 快照（可看/可回滚）。
 *
 * 对齐参考项目 Coopanion 的记忆体系（core/persona.ts）：
 *  - PARTNER.md 是「关于这个人」的提炼画像，每次请求整份注入，不做向量检索；
 *  - 模型每写一次记忆就提交一个 Git commit（作者区分模型 / 应用 / 你自己），
 *    每次启动打一个 start-<版本> 的 tag，历史因此可定位、可回退；
 *  - partner/ 放故事、日志等长内容（按需读，不占每轮上下文），blobs/ 不进仓库；
 *  - 人设文件用 SHA-256 记「上次写入时的样子」，升级时不覆盖你亲手改过的人设。
 *
 * 纯 Node、零依赖：Git 通过 child_process 调用（未安装 git 时降级为只写文件）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dataPath } from '../config.js'
import { logger } from '../logger.js'

export const PARTNER_FILE = 'PARTNER.md'
export const PARTNER_DIR = 'partner'
export const BLOBS_DIR = 'blobs'
export const HANDOFF_DIR = 'handoffs'

/** 模型自己写的记忆（工具调用） */
export const AUTHOR_MODEL = { name: 'ryza', email: 'ryza@partner.local' }
/** 应用自己做的动作（启动快照、整理文件、回滚） */
export const AUTHOR_APP = { name: 'ryza-assistant', email: 'app@partner.local' }
/** 你亲手改的（记忆页保存） */
export const AUTHOR_USER = { name: 'you', email: 'you@partner.local' }

export const SNAPSHOT_TAG = (version) => `start-${version}`

/** 整份注入的上限。真的写到这么长说明该把细节挪进 partner/ 了 */
const MAX_PROMPT_CHARS = 12000
/** 0.21.0：默认注入预算（比整份少一半——「近期日志」只留最近若干条，旧的靠 recall 查） */
const DEFAULT_PROMPT_BUDGET = 6000
/** 「近期日志」分区落在 prompt 里的条数（越旧越没用，还会把上下文吃光） */
const LOG_KEEP = 12
/** 分区标题（顺序即模板顺序） */
export const SECTIONS = [
  { key: 'about', title: '关于你', hint: '称呼、所在时区、在做什么、最近的状态' },
  { key: 'relation', title: '关系与约定', hint: '怎么相处、边界、你在意的事、约定好的称呼' },
  { key: 'fact', title: '长期事实', hint: '稳定的事实：设备、习惯、家人、项目名' },
  { key: 'log', title: '近期日志', hint: '时间线：最近发生的事，旧的合并或挪去 partner/' }
]

const NOTE = `${PARTNER_FILE}（下文）在你每次请求时都会被整份读入。请把它写成一份简短、提炼过的「关于这个人」的画像：` +
  `过时的内容合并或删掉。故事、日志、更长的笔记放进 ${PARTNER_DIR}/ 目录下的文件里，需要时用 recall_memory 读取。`

function safeId (id) {
  return String(id || '').replace(/[^\w.-]/g, '_') || 'default'
}

/**
 * 工作区路径。记忆跟角色卡走（scope=角色 id）：每个角色一个独立目录 + 独立 git 仓库。
 * 目录用 workspaces/<roleId>/（与旧全局 workspace/ 平级——子目录没法 rename 进自己，
 * 迁移时整个目录一把 rename 即可，git 历史原样保留）。
 * 不传 scope = 旧版全局工作区（仅作为迁移来源与兼容兜底，正常读写都应带 scope）。
 */
function ws (scope) {
  return scope ? dataPath('workspaces', safeId(scope)) : dataPath('workspace')
}
export function workspaceDir (scope) { return ws(scope) }
export function partnerFile (scope) { return path.join(ws(scope), PARTNER_FILE) }

function ensureDir (p) { fs.mkdirSync(p, { recursive: true }) }

export function sha256 (text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex')
}

/* ------------------------------------------------------------------ Git */

let gitOk = null
const repoReadySet = new Set() // 已 init 的 scope（每个角色一个独立仓库）

/** Git 是否可用（一台机器上一次判断就够） */
export function gitAvailable () {
  if (gitOk !== null) return gitOk
  try {
    execFileSync('git', ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' })
    gitOk = true
  } catch {
    gitOk = false
    logger.warn('[partner] 未找到 git，记忆只保存文件、不产生历史')
  }
  return gitOk
}

function gitRun (args, author = AUTHOR_APP, scope) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (author) {
    env.GIT_AUTHOR_NAME = author.name
    env.GIT_AUTHOR_EMAIL = author.email
    env.GIT_COMMITTER_NAME = author.name
    env.GIT_COMMITTER_EMAIL = author.email
  }
  return execFileSync('git', args, {
    cwd: ws(scope), encoding: 'utf8', timeout: 15000, windowsHide: true, env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function ignored (scope) {
  const file = path.join(ws(scope), '.gitignore')
  ensureDir(ws(scope))
  let lines = []
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) } catch {}
  const want = [`${BLOBS_DIR}/`, '.DS_Store', 'Thumbs.db']
  let changed = false
  for (const w of want) if (!lines.includes(w)) { lines.push(w); changed = true }
  if (changed) fs.writeFileSync(file, lines.join('\n') + '\n')
}

/** 仓库就绪（按 scope 各一次）：init + .gitignore。没有 git 时静默跳过 */
export function ensureRepo (scope) {
  const key = safeId(scope)
  if (repoReadySet.has(key)) return gitAvailable()
  ensureDir(ws(scope))
  ensureDir(path.join(ws(scope), PARTNER_DIR))
  ensureDir(path.join(ws(scope), BLOBS_DIR))
  if (!gitAvailable()) return false
  try {
    ignored(scope)
    try { gitRun(['rev-parse', '--is-inside-work-tree'], AUTHOR_APP, scope) } catch { gitRun(['init'], AUTHOR_APP, scope) }
    repoReadySet.add(key)
    return true
  } catch (e) {
    logger.warn('[partner] git 初始化失败：' + e.message)
    return false
  }
}

/** 提交工作区全部改动；无改动返回 null */
export function commitAll (message, author = AUTHOR_APP, scope) {
  if (!ensureRepo(scope)) return null
  try {
    const change = gitRun(['status', '--porcelain'], AUTHOR_APP, scope).trim()
    if (!change) return null
    gitRun(['add', '-A'], AUTHOR_APP, scope)
    gitRun(['commit', '-m', String(message || '记忆更新').slice(0, 200)], author, scope)
    const hash = gitRun(['rev-parse', 'HEAD'], AUTHOR_APP, scope).trim()
    logger.info(`[partner] commit ${hash.slice(0, 7)} (${author.name}) ${String(message || '').slice(0, 60)}`)
    return hash
  } catch (e) {
    logger.warn('[partner] 提交失败：' + e.message)
    return null
  }
}

/** 历史（新的在前）。没有 git 或空仓库返回 [] */
export function history (limit = 50, scope) {
  if (!ensureRepo(scope)) return []
  try {
    const out = gitRun(['log', `--pretty=format:%H%x09%an%x09%ae%x09%at%x09%s`, '-n', String(limit)], AUTHOR_APP, scope)
    return out.split('\n').filter(Boolean).map((line) => {
      const [hash, name, email, at, ...rest] = line.split('\t')
      return { hash, author: name, email, at: Number(at) * 1000, message: rest.join('\t') }
    })
  } catch { return [] }
}

/** 某个提交里的 PARTNER.md 原文 */
export function showAt (hash, scope) {
  if (!hash || !/^[0-9a-f]{4,40}$/i.test(String(hash))) throw new Error('提交号不合法')
  if (!ensureRepo(scope)) throw new Error('git 不可用')
  return gitRun(['show', `${hash}:${PARTNER_FILE}`], AUTHOR_APP, scope)
}

/** 回滚：把 PARTNER.md 与 partner/ 恢复成某个提交的样子，再提交一次（历史只增不减） */
export function revertTo (hash, scope) {
  if (!hash || !/^[0-9a-f]{4,40}$/i.test(String(hash))) throw new Error('提交号不合法')
  if (!ensureRepo(scope)) throw new Error('git 不可用')
  gitRun(['checkout', String(hash), '--', PARTNER_FILE], AUTHOR_APP, scope)
  try { gitRun(['checkout', String(hash), '--', PARTNER_DIR], AUTHOR_APP, scope) } catch { /* 该版本没有 partner/ 就跳过 */ }
  const commit = commitAll(`回滚记忆到 ${String(hash).slice(0, 7)}`, AUTHOR_APP, scope)
  return { ok: true, hash: commit, content: readDoc(scope) }
}

/** 启动快照：先把没提交的改动收进 commit，再给当前状态打 start-<版本> tag */
export function snapshot (version, scope) {
  if (!ensureRepo(scope)) return null
  const tag = SNAPSHOT_TAG(version)
  try {
    const tags = gitRun(['tag', '--list', tag], AUTHOR_APP, scope).trim()
    if (tags) {
      commitAll(`启动前的改动（${version}）`, AUTHOR_APP, scope)
      return { tag, existed: true }
    }
    commitAll(`启动快照 ${version}`, AUTHOR_APP, scope)
    gitRun(['tag', '-a', tag, '-m', `版本 ${version} 启动时的记忆工作区`], AUTHOR_APP, scope)
    logger.info(`[partner] 已打快照 tag ${tag}`)
    return { tag, existed: false }
  } catch (e) {
    logger.warn('[partner] 启动快照失败：' + e.message)
    return null
  }
}

/* -------------------------------------------------------------- 文件内容 */

function template () {
  return `# PARTNER\n\n` +
    SECTIONS.map((s) => `## ${s.title}\n（${s.hint}）\n`).join('\n') +
    `\n> 这份文件每次对话都会整份读入，请保持简短。细节放 ${PARTNER_DIR}/。\n`
}

export function readDoc (scope) {
  try { return fs.readFileSync(partnerFile(scope), 'utf8') } catch { return '' }
}

/** 直接写入整份文件（记忆页保存、回滚时用） */
export function writeDoc (text, { author = AUTHOR_USER, message = '更新 PARTNER.md', scope } = {}) {
  ensureRepo(scope)
  fs.writeFileSync(partnerFile(scope), String(text == null ? '' : String(text).replace(/\r\n/g, '\n')), 'utf8')
  const hash = commitAll(message, author, scope)
  return { ok: true, hash }
}

/**
 * 旧版全局工作区一次性迁入角色目录（scope）：整个目录 rename 成 workspaces/<role>/
 * （含 .git，git 历史原样保留；workspaces/ 与旧 workspace/ 平级，rename 合法）。
 * 只在「旧 PARTNER.md 存在且角色目录还没有」时动手；返回是否搬了。
 */
let legacyDirMigrated = false
export function migrateLegacyDir (scope) {
  if (!scope || legacyDirMigrated) return false
  const from = ws()
  const to = ws(scope)
  try {
    if (!fs.existsSync(path.join(from, PARTNER_FILE))) return false // 没有旧工作区
    if (fs.existsSync(path.join(to, PARTNER_FILE))) { legacyDirMigrated = true; return false } // 角色已有自己的
    ensureDir(path.dirname(to))
    try {
      fs.renameSync(from, to)
    } catch {
      // rename 失败（跨盘/被占用）：逐项移动兜底
      ensureDir(to)
      for (const name of fs.readdirSync(from)) {
        try { fs.renameSync(path.join(from, name), path.join(to, name)) } catch { /* 单项失败不阻断 */ }
      }
    }
    legacyDirMigrated = true
    logger.info(`[partner] 旧记忆工作区已整体迁入角色目录 ${safeId(scope)}（git 历史保留）`)
    return true
  } catch (e) {
    logger.warn('[partner] 旧工作区迁移失败（不影响使用，仍读旧目录）: ' + e.message)
    return false
  }
}

/** 确保工作区与 PARTNER.md 存在；首次启动把旧 JSON 记忆迁移进来。
 *  migrateDir=false 时不做旧目录迁移（惰性初始化别的角色时用，防止把旧工作区吞给错误角色） */
export function ensureWorkspace ({ roleName = '', legacyFacts = [], scope, migrateDir = true } = {}) {
  if (migrateDir) migrateLegacyDir(scope)
  ensureRepo(scope)
  if (!fs.existsSync(partnerFile(scope))) {
    fs.writeFileSync(partnerFile(scope), template(), 'utf8')
    commitAll('初始化 PARTNER.md', AUTHOR_APP, scope)
  }
  migrateLegacy(legacyFacts, scope)
}

/** 旧版 memory/<roleId>.json 的事实一次性并入 PARTNER.md 的「长期事实」 */
const migratedSet = new Set()
export function migrateLegacy (facts, scope) {
  const key = safeId(scope)
  if (migratedSet.has(key)) return 0
  migratedSet.add(key)
  const list = (facts || []).filter((f) => f && f.text)
  if (!list.length) return 0
  const doc = readDoc(scope)
  if (doc.includes('<!-- migrated:legacy-facts -->')) return 0
  const lines = list.map((f) => `- ${String(f.text).slice(0, 300)}`)
  appendToSection('fact', lines, {
    author: AUTHOR_APP,
    message: `迁移旧的 ${list.length} 条记忆`,
    scope
  })
  appendRaw('\n<!-- migrated:legacy-facts -->\n', { author: AUTHOR_APP, message: '标记旧记忆已迁移', scope })
  logger.info(`[partner] 已把 ${list.length} 条旧记忆迁移进 PARTNER.md`)
  return list.length
}

/** 按 `## 标题` 追加若干行；分区不存在就补一个 */
export function appendToSection (titleOrKey, lines, { author = AUTHOR_MODEL, message = null, scope } = {}) {
  ensureRepo(scope)
  const sec = SECTIONS.find((s) => s.key === titleOrKey || s.title === titleOrKey)
  const title = sec ? sec.title : String(titleOrKey)
  const doc = readDoc(scope) || template()
  const add = lines
    .map((l) => (String(l).startsWith('- ') ? String(l) : `- ${String(l)}`))
    .join('\n')
  const head = `## ${title}`
  const i = doc.indexOf(head)
  if (i < 0) {
    fs.writeFileSync(partnerFile(scope), `${doc.replace(/\s*$/, '\n')}\n## ${title}\n${add}\n`, 'utf8')
  } else {
    // 插到本分区末尾：找到下一个同级标题，没有就插到文末
    const after = doc.slice(i + head.length)
    const m = after.match(/\n## /)
    const at = m ? i + head.length + m.index : doc.length
    const before = doc.slice(0, at).replace(/\s*$/, '\n')
    const rest = doc.slice(at)
    fs.writeFileSync(partnerFile(scope), `${before}${add}\n${rest}`, 'utf8')
  }
  const hash = commitAll(message || `记住：${String(lines[0] || '').slice(0, 40)}`, author, scope)
  return { ok: true, hash, section: title }
}

function appendRaw (text, { author = AUTHOR_APP, message = '更新记忆文件', scope } = {}) {
  const doc = readDoc(scope)
  fs.writeFileSync(partnerFile(scope), doc.replace(/\s*$/, '\n') + text, 'utf8')
  return commitAll(message, author, scope)
}

function today () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 记一条：默认进「长期事实」，可指定 about/relation/log */
export function remember (text, { section = 'fact', author = AUTHOR_MODEL, scope } = {}) {
  const t = String(text || '').trim()
  if (!t) throw new Error('记忆内容不能为空')
  if (t.length > 800) throw new Error('一条记忆不要超过 800 字，长的请写成 partner/ 下的文件')
  const line = section === 'log' ? `- ${today()} ${t}` : `- ${t}`
  return appendToSection(section, [line], { author, message: `记住：${t.slice(0, 50)}`, scope })
}

/** 忘掉：删除包含该片段的行（至少 2 个字符，且不能一次删掉大半份记忆） */
export function forget (fragment, { author = AUTHOR_MODEL, scope } = {}) {
  const q = String(fragment || '').trim()
  if (q.length < 2) throw new Error('要忘掉的内容至少 2 个字符（避免误删）')
  const doc = readDoc(scope)
  const lines = doc.split('\n')
  const kept = lines.filter((l) => !(l.startsWith('- ') && l.includes(q)))
  const removed = lines.length - kept.length
  if (!removed) return { ok: false, removed: 0 }
  // 保护：一次删掉太多条说明片段太泛（比如只写「的」），退回让模型写具体些
  const entries = lines.filter((l) => l.startsWith('- ')).length
  if (removed > 5 && removed > entries / 2) {
    throw new Error(`这段内容会删掉 ${removed}/${entries} 条记忆，太宽泛了，请写得更具体`)
  }
  fs.writeFileSync(partnerFile(scope), kept.join('\n'), 'utf8')
  const hash = commitAll(`忘掉：${q.slice(0, 50)}`, author, scope)
  return { ok: true, removed, hash }
}

/** 把整份文档拆成分区（记忆页展示 / recall 用） */
export function parseSections (doc = readDoc()) {
  const out = []
  let cur = { title: '（开头）', body: [] }
  for (const line of String(doc).split('\n')) {
    const m = line.match(/^##\s+(.+)$/)
    if (m) { out.push(cur); cur = { title: m[1].trim(), body: [] }; continue }
    cur.body.push(line)
  }
  out.push(cur)
  return out.filter((s) => s.title !== '（开头）' || s.body.join('').trim())
}

/** partner/ 下的文件清单 */
export function listPartnerFiles (scope) {
  const dir = path.join(ws(scope), PARTNER_DIR)
  ensureDir(dir)
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const st = fs.statSync(path.join(dir, d.name))
        return { name: d.name, size: st.size, at: st.mtimeMs }
      })
  } catch { return [] }
}

/** 在 PARTNER.md 与 partner/ 里检索片段（不做向量，关键词/子串即可） */
export function recall (query, k = 5, scope) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const hits = []
  for (const line of readDoc(scope).split('\n')) {
    if (line.startsWith('- ') && line.toLowerCase().includes(q)) hits.push({ source: PARTNER_FILE, text: line.replace(/^- /, '').trim() })
  }
  const dir = path.join(ws(scope), PARTNER_DIR)
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isFile()) continue
      const file = path.join(dir, d.name)
      let txt = ''
      try { txt = fs.readFileSync(file, 'utf8') } catch { continue }
      const lines = txt.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          hits.push({ source: `${PARTNER_DIR}/${d.name}`, text: lines.slice(Math.max(0, i - 1), i + 2).join(' ').trim().slice(0, 300) })
          if (hits.length > k * 4) break
        }
      }
    }
  } catch { /* 目录不存在就算了 */ }
  return hits.slice(0, k)
}

/** 2-gram（中文按两字切，英文按词），用于「记忆行 ↔ 本次输入」的相关度打分 */
function grams (text) {
  const s = String(text || '').toLowerCase()
  const out = new Set()
  for (const m of s.matchAll(/[a-z0-9]{2,}|[\u4e00-\u9fff\u3040-\u30ff]+/g)) {
    const seg = m[0]
    if (!/[\u4e00-\u9fff\u3040-\u30ff]/.test(seg)) { out.add(seg); continue }
    if (seg.length <= 2) { out.add(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
  }
  return out
}

/**
 * 0.21.0 精简：不再整份塞进 prompt。
 *   1. 「近期日志」只留最近 LOG_KEEP 条（更早的写一句提示，需要时用 recall_memory 查）
 *   2. 仍然超预算时，把「长期事实 / 近期日志」里与本次输入无关的行继续砍（about/relation 不动）
 * 返回 { body, dropped } —— dropped 用于日志与结尾提示。
 */
export function condenseDoc (doc, { query = '', budget = DEFAULT_PROMPT_BUDGET } = {}) {
  const sections = parseSections(doc)
  const limit = Number(budget) > 0 ? Number(budget) : DEFAULT_PROMPT_BUDGET
  let dropped = 0
  // 第一步：日志分区只留最近若干条
  const trimmed = sections.map((sec) => {
    const isLog = /日志/.test(sec.title)
    const body = sec.body.join('\n').replace(/\s+$/, '')
    if (!isLog) return { title: sec.title, text: body }
    const lines = body.split('\n')
    const bullets = lines.filter((l) => l.trim().startsWith('- '))
    if (bullets.length <= LOG_KEEP) return { title: sec.title, text: body }
    const keep = bullets.slice(-LOG_KEEP)
    dropped += bullets.length - keep.length
    return {
      title: sec.title,
      text: `（更早的 ${bullets.length - keep.length} 条已省略，需要时用 recall_memory 查）\n` + keep.join('\n')
    }
  })
  const render = (list) => list.map((s) => (s.title ? `## ${s.title}\n${s.text}` : s.text)).join('\n\n')
  let out = render(trimmed)
  if (out.length <= limit) return { body: out, dropped }

  // 第二步：按相关度砍 fact / log 的行，about / relation 不动
  const qg = grams(query)
  const scored = trimmed.map((sec) => {
    const isSoft = /日志|事实/.test(sec.title)
    if (!isSoft) return sec
    const lines = sec.text.split('\n')
    const kept = lines.filter((l) => {
      if (!l.trim().startsWith('- ')) return true
      if (!qg.size) return true
      const lg = grams(l)
      for (const g of qg) if (lg.has(g)) return true
      return false
    })
    dropped += lines.length - kept.length
    return { title: sec.title, text: kept.join('\n') }
  })
  out = render(scored)
  // 第三步：还超就硬截断（至少留住前半份画像）
  if (out.length > limit) {
    out = out.slice(0, limit) + `\n（已按预算截断，其余用 recall_memory 查）`
    dropped += 1
  }
  return { body: out, dropped }
}

/** 整份注入的文本（含使用说明）。没有内容时返回空串。
 *  opts.query 用于相关度精简，opts.budget 默认 DEFAULT_PROMPT_BUDGET（6000） */
export function buildPrompt (scope, opts) {
  const doc = readDoc(scope).trim()
  if (!doc) return ''
  const o = opts || {}
  const budget = Number(o.budget) > 0 ? Number(o.budget) : DEFAULT_PROMPT_BUDGET
  let body = ''
  let dropped = 0
  try {
    const r = condenseDoc(doc, { query: String(o.query || ''), budget })
    body = r.body
    dropped = r.dropped
  } catch {
    body = doc.slice(0, MAX_PROMPT_CHARS)
  }
  if (body.length > MAX_PROMPT_CHARS) {
    body = body.slice(0, MAX_PROMPT_CHARS) +
      `\n\n（${PARTNER_FILE} 太长已截断，剩下的请用 recall_memory 读，或把细节挪进 ${PARTNER_DIR}/）`
  }
  const tail = dropped ? `\n\n（为了省上下文，这份画像已精简掉 ${dropped} 条较旧或与当前话题无关的内容，需要时用 recall_memory 查）` : ''
  return `【关于这个人的记忆 · ${PARTNER_FILE}】\n${NOTE}\n\n${body}${tail}`
}

/** 上下文压力提示（S4/3.6）：历史里累计的字符数超过阈值时让模型自己整理 */
export const CONTEXT_SOFT_LIMIT = 60000

export function contextPressure (chars) {
  if (chars < CONTEXT_SOFT_LIMIT) return ''
  return `【上下文压力】这次会话已经很长（约 ${Math.round(chars / 1000)}k 字符）。` +
    `如果还有长期要紧的事，先用 remember 写进 ${PARTNER_FILE}；过时的条目可以 forget 掉。`
}

/** 交接文件：把一段历史落成 handoffs/ 下的笔记 */
export function writeHandoff (text, { reason = '长会话', scope } = {}) {
  ensureRepo(scope)
  const dir = path.join(ws(scope), HANDOFF_DIR)
  ensureDir(dir)
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const name = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.md`
  const file = path.join(dir, name)
  fs.writeFileSync(file, `# 交接 · ${reason}\n\n${String(text || '').trim()}\n`, 'utf8')
  commitAll(`写交接笔记 ${name}`, AUTHOR_APP, scope)
  return { file, rel: `${HANDOFF_DIR}/${name}` }
}

/** 仅测试用：切换数据目录后重置模块级缓存 */
export function resetCache () { gitOk = null; repoReadySet.clear(); migratedSet.clear(); legacyDirMigrated = false }

export const partner = {
  PARTNER_FILE, PARTNER_DIR, SNAPSHOT_TAG,
  workspaceDir, partnerFile, gitAvailable, ensureRepo, ensureWorkspace, migrateLegacyDir,
  readDoc, writeDoc, remember, forget, recall, buildPrompt, condenseDoc, parseSections, resetCache,
  listPartnerFiles, history, showAt, revertTo, snapshot, commitAll, sha256,
  writeHandoff, contextPressure, CONTEXT_SOFT_LIMIT, DEFAULT_PROMPT_BUDGET
}
