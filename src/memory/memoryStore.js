/**
 * 记忆与数据层：长期记忆按角色独立存储（data/memory/<roleId>.json）。
 * 检索：关键词打分（英文按单词、CJK 按 2-gram），避免过早引入向量库。
 * 备份：backup() 把当前记忆快照存到 data/memory/backups/。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../config.js'

const MAX_FACTS = 1000

function roleFile (roleId) {
  return dataPath('memory', `${sanitizeId(roleId)}.json`)
}

function sanitizeId (id) {
  const s = String(id || '').replace(/[^\w.-]/g, '_')
  if (!s) throw new Error('角色 id 不能为空')
  return s
}

function loadRole (roleId) {
  try {
    return JSON.parse(fs.readFileSync(roleFile(roleId), 'utf8'))
  } catch {
    return []
  }
}

function saveRole (roleId, facts) {
  fs.mkdirSync(dataPath('memory'), { recursive: true })
  fs.writeFileSync(roleFile(roleId), JSON.stringify(facts.slice(-MAX_FACTS), null, 2))
}

/** 简易分词：英文/数字按连续串，CJK 连续段拆 2-gram（1 字段保留原字） */
export function tokenize (text) {
  const tokens = []
  const s = String(text || '').toLowerCase()
  for (const m of s.matchAll(/[a-z0-9]+|[\u4e00-\u9fff\u3040-\u30ff]+/g)) {
    const seg = m[0]
    if (!/[\u4e00-\u9fff\u3040-\u30ff]/.test(seg) || seg.length < 2) {
      tokens.push(seg)
      continue
    }
    if (seg.length <= 2) { tokens.push(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2))
  }
  return tokens
}

/** 关键词检索：每个词在 fact 中出现计 1 分（去重词），取 top-k */
export function searchFacts (facts, query, k = 5) {
  const words = [...new Set(tokenize(query))]
  if (!words.length) return []
  const scored = []
  for (const f of facts) {
    const hay = String(f.text || '').toLowerCase()
    let score = 0
    for (const w of words) {
      if (!w) continue
      let idx = 0, n = 0
      while ((idx = hay.indexOf(w, idx)) >= 0) { n++; idx += w.length; if (n >= 3) break }
      score += n
    }
    if (score > 0) scored.push({ fact: f, score })
  }
  scored.sort((a, b) => b.score - a.score || b.fact.at - a.fact.at)
  return scored.slice(0, k).map((s) => s.fact)
}

export const memory = {
  add (roleId, text) {
    const t = String(text || '').trim()
    if (!t) throw new Error('记忆内容不能为空')
    const facts = loadRole(roleId)
    const fact = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: t.slice(0, 500), at: Date.now() }
    facts.push(fact)
    saveRole(roleId, facts)
    return fact
  },
  remove (roleId, factId) {
    const facts = loadRole(roleId)
    const i = facts.findIndex((f) => f.id === factId)
    if (i < 0) return false
    facts.splice(i, 1)
    saveRole(roleId, facts)
    return true
  },
  list (roleId) { return loadRole(roleId) },
  search (roleId, query, k = 5) { return searchFacts(loadRole(roleId), query, k) },
  clear (roleId) { saveRole(roleId, []) },
  backup (roleId) {
    const src = roleFile(roleId)
    if (!fs.existsSync(src)) return null
    const dir = dataPath('memory', 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, `${sanitizeId(roleId)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.copyFileSync(src, dest)
    return dest
  }
}
