'use strict'
/**
 * 台词相似度（纯函数，可单测）· 0.45.85
 *
 * 用户 11-01 实锤：她对屏幕上同一行残留文字（trackid）在一个半小时里嘀咕了 7 次，
 * 每次都是 LLM 重新编的变体——「防复读镜子」（把最近几句喂回提示词）拦不住，
 * 模型面前摆着同一个刺激物就忍不住再修辞一遍。
 *
 * 解法：生成结果再过一道**硬闸**——跟最近说过的话做 token 集合 Jaccard，
 * 超过阈值直接吞掉（不出口）。分词用 CJK bigram + ASCII 词，主题词
 * （字母/尾巴/暗号/记号）在变体之间必然反复出现，句式再怎么换也会命中。
 */

/** 0.46.42 复读闸时间窗：撞车只比最近 90 分钟内说过的话。
 *  用户 11-04 实锤：inner.recentVoices 无时间界，她话说得少的下午，
 *  「最近 8 句」能横跨两三个小时——12:33 的台词 14:49 还在拦新句，
 *  生成出来的十几句几乎全被咽回去（一小时没开口）；同时旧台词挂着
 *  「最近说过」的名头进提示词镜子，又误导模型围着旧话题打转。
 *  90min 保留 0.45.85「一个半小时六变体」场景的防护。 */
const REPEAT_WINDOW_MS = 90 * 60 * 1000

/** 分词：连续 CJK 段切 bigram，ASCII 段切小写词。长度 1 的 CJK 段整段算一个 token。 */
function tokenize (s) {
  const t = String(s || '')
  const tokens = new Set()
  const cjkRe = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uff66-\uff9f]+/g
  let m
  while ((m = cjkRe.exec(t)) !== null) {
    const seg = m[0]
    if (seg.length === 1) { tokens.add(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2))
  }
  const asciiRe = /[a-z0-9]{2,}/gi
  while ((m = asciiRe.exec(t)) !== null) tokens.add(m[0].toLowerCase())
  return tokens
}

/** Jaccard 相似度 0~1（任一方空集返回 0） */
function similarity (a, b) {
  const A = tokenize(a)
  const B = tokenize(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/** 单字 token 集合（CJK 字 + ASCII 词），算 overlap 系数用 */
function tokenize1 (s) {
  const t = String(s || '')
  const set = new Set()
  for (const ch of t) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uff66-\uff9f]/.test(ch)) set.add(ch)
  }
  const m = t.match(/[a-z0-9]{2,}/gi)
  if (m) for (const w of m) set.add(w.toLowerCase())
  return set
}

/** overlap 系数：交集 / 较小集合大小（短句不占便宜的前提见 isRepeat 的最小交集数） */
function overlapCoef (a, b) {
  const A = tokenize1(a)
  const B = tokenize1(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / Math.min(A.size, B.size)
}

/**
 * 复读判定（真实台词校准，11-01）：
 * 同一刺激物的 LLM 变体（「那串字母…暗号/记号/喊名字」×5）pairwise
 * bigram-Jaccard 只有 0.04~0.32，单字 overlap 有 0.43~0.67；无关句对
 * overlap ≤0.28。两个指标取或，另要求最少共享 5 个 token 防短句误伤。
 */
const JACCARD_HIT = 0.25
const OVERLAP_HIT = 0.34
const MIN_INTER = 5

function isRepeat (text, history) {
  const T = tokenize(text)
  const T1 = tokenize1(text)
  let best = 0
  let against = ''
  for (const h of history || []) {
    const j = similarity(text, h)
    const O = tokenize1(h)
    let inter = 0
    for (const x of T1) if (O.has(x)) inter++
    const ov = inter / Math.min(T1.size, O.size || 1)
    const hit = j >= JACCARD_HIT || (inter >= MIN_INTER && ov >= OVERLAP_HIT)
    const score = Math.max(j, ov)
    if (hit && score > best) { best = score; against = String(h) }
  }
  return { repeat: best > 0 && !!against, score: best, against }
}

/** 跟一组历史台词的最大相似度。返回 {max, against}（没有历史返回 0）。 */
function maxSimilarity (text, history) {
  let max = 0
  let against = ''
  for (const h of history || []) {
    const s = similarity(text, h)
    if (s > max) { max = s; against = String(h) }
  }
  return { max, against }
}

module.exports = { tokenize, tokenize1, similarity, overlapCoef, isRepeat, maxSimilarity, JACCARD_HIT, OVERLAP_HIT, MIN_INTER, REPEAT_WINDOW_MS }
