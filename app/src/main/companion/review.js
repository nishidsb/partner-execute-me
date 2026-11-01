'use strict'
/**
 * 审查队列（第 1 期 · 自我演化的唯一收口）
 *
 * 为什么要有它：做梦 / 归纳 / 以后的人格提案，产出都是「想改她自己的东西」。
 * 直接写入 = 她自己悄悄改自己，错了没人知道。所以立个规矩：
 *   产出一律先进队列 → 批准才落地 → 落地前抓目标文件快照 → 随时可按条回滚。
 * 底层文件（characters.json / roles / persona）照旧只读（0.18.0 保护闸不变），
 * 队列能碰的只有「表现层」：习惯、好恶、记忆事实、风格样本。
 *
 * 队列本体 wsDir/review.jsonl，一行一条。纯逻辑与文件分离：
 *   enqueue/decide/markApplied/pending 是纯数组运算（可单测）；
 *   load/save/rollback 摸文件（测试用临时目录）。
 * 落地动作（applyApplier）由宿主注入——review 不认识 self/memory，只管流程。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 队列文件路径 */
function fileFor (wsDir) { return path.join(wsDir, 'review.jsonl') }

function load (wsDir) {
  try {
    return fs.readFileSync(fileFor(wsDir), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

/** 原子写（tmp + rename），最多留 400 条历史 */
function save (wsDir, items) {
  const list = (items || []).slice(-400)
  const file = fileFor(wsDir)
  const tmp = file + '.tmp'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, list.map((x) => JSON.stringify(x)).join('\n') + (list.length ? '\n' : ''), 'utf8')
  fs.renameSync(tmp, file)
  return list
}

/** 去重键：同类+内容前 80 字（空格归一） */
function dedupeKey (entry) {
  // 0.45.17：喜恶极性参与判重——「喜欢 X」和「不喜欢 X」是两条记忆，不能互相吞
  return (entry.kind || '?') + '|' + (entry.polarity ? entry.polarity + '|' : '') +
    String(entry.payload || '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * 入队。重复（队列里还有同键 pending）不算新提案——票数 +1、理由追加，等一次批准。
 * @returns {{items, item, dup:boolean}}
 */
function enqueue (items, entry, now) {
  const list = (items || []).slice()
  const key = dedupeKey(entry)
  const hit = list.find((x) => x.status === 'pending' && x.key === key)
  if (hit) {
    hit.votes = (Number(hit.votes) || 1) + 1
    hit.at = Number(now) || Date.now()
    if (entry.reason && hit.reason !== entry.reason) hit.reason = entry.reason
    return { items: list, item: hit, dup: true }
  }
  const item = {
    id: 'rv' + (Number(now) || Date.now()).toString(36) + Math.random().toString(36).slice(2, 6),
    kind: entry.kind || 'habit',        // habit | taste | memory | style | persona
    what: entry.what || '',             // habit 描述 / taste 的 what / 记忆事实 / 风格标签
    payload: entry.payload || '',       // 全文（taste 含「因为什么」）
    reason: entry.reason || '',         // 她的理由（做梦时「因为…」）
    key,
    votes: 1,
    at: Number(now) || Date.now(),
    status: 'pending'                   // pending → approved→applied / rejected / rolled
  }
  // persona 提案（第 2 期）带结构化 diff 字段，面板卡片要按「现状 → 想改成」渲染
  if (item.kind === 'persona') {
    item.aspect = String(entry.aspect || '').slice(0, 12)
    item.current = String(entry.current || '').slice(0, 60)
    item.proposed = String(entry.proposed || '').slice(0, 60)
    item.evidence = String(entry.evidence || entry.reason || '').slice(0, 120)
  }
  list.push(item)
  return { items: list, item, dup: false }
}

/** 批准 / 拒绝。只有 pending 能决策；approve 后由宿主落地再 markApplied。 */
function decide (items, id, action, now) {
  const list = (items || []).slice()
  const item = list.find((x) => x.id === id && x.status === 'pending')
  if (!item) return { items: list, item: null }
  if (action === 'approve') item.status = 'approved'
  else item.status = 'rejected'
  item.decidedAt = Number(now) || Date.now()
  return { items: list, item }
}

/** 落地完成登记：before = 目标文件快照 [{path, content}]，回滚全靠它 */
function markApplied (items, id, beforeFiles, now) {
  const list = (items || []).slice()
  const item = list.find((x) => x.id === id && x.status === 'approved')
  if (!item) return { items: list, item: null }
  item.status = 'applied'
  item.before = (beforeFiles || []).map((f) => ({ path: f.path, content: f.content }))
  item.appliedAt = Number(now) || Date.now()
  return { items: list, item }
}

/** 按条回滚：把快照原样写回去。没快照的旧条目拒绝（宁可不回也不猜） */
function rollback (items, id, now) {
  const list = (items || []).slice()
  const item = list.find((x) => x.id === id && x.status === 'applied')
  if (!item) return { items: list, item: null, error: 'not-applied' }
  if (!Array.isArray(item.before) || !item.before.length) return { items: list, item, error: 'no-snapshot' }
  for (const f of item.before) {
    try { fs.mkdirSync(path.dirname(f.path), { recursive: true }) } catch { }
    try { fs.writeFileSync(f.path, f.content, 'utf8') } catch (err) { return { items: list, item, error: err.message } }
  }
  item.status = 'rolled'
  item.rolledAt = Number(now) || Date.now()
  return { items: list, item }
}

function pending (items) { return (items || []).filter((x) => x.status === 'pending') }

/** 面板最近区：applied 在前（可回滚），rejected/rolled 殿后 */
function recent (items, n) {
  const rank = { applied: 0, approved: 1, rolled: 2, rejected: 3 }
  return (items || []).filter((x) => x.status !== 'pending')
    .sort((a, b) => (rank[a.status] - rank[b.status]) || (b.at - a.at)).slice(0, n || 10)
}

module.exports = { fileFor, load, save, dedupeKey, enqueue, decide, markApplied, rollback, pending, recent }
