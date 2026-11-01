'use strict'
/**
 * 「关于他」的长期事实去重闸。
 *
 * 为什么需要：做梦是周期性的，同一个作息/同一场考试会被反复梦到。
 * 没有这道闸，PARTNER.md 的「长期事实」几周后就是二十条同义句。
 *
 * 判定用二元组重合率（中文按两字切、去掉标点空格）：
 * 同一条事实换个说法，重合率依然很高；不同的事哪怕词像，也很难过 60%。
 */

/** 二元组集合 */
function bigramsOf (s) {
  const z = String(s || '').replace(/[\s，。、；：！？…—·「」『』“”‘’"'（）()[\]【】,.!?;:-]/g, '')
  const out = new Set()
  for (let i = 0; i + 1 < z.length; i++) out.add(z.slice(i, i + 2))
  return out
}

/**
 * 文本是否已经出现在记忆文档里（只看 '-' 开头的条目行）。
 * @param {string} doc PARTNER.md 全文
 * @param {string} text 待写入的一条事实
 * @param {number} [threshold=0.6] 重合率阈值
 */
function hasSimilarFact (doc, text, threshold = 0.6) {
  const a = bigramsOf(text)
  if (!a.size) return false
  const bar = Number(threshold) || 0.6
  for (const line of String(doc || '').split(/\r?\n/)) {
    if (!/^-\s/.test(line)) continue
    const b = bigramsOf(line)
    if (!b.size) continue
    let hit = 0
    for (const g of a) if (b.has(g)) hit++
    if (hit / a.size >= bar) return true
  }
  return false
}

module.exports = { hasSimilarFact, bigramsOf }
