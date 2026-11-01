'use strict'
/**
 * 弹幕断句（0.38.0）
 *
 * 为什么单独成文件：弹幕「一条=一句」的规则是纯文本处理，跟窗口/动画无关，
 * 单独抽出来才能被单测盯住。参考鱼搭子 1.5.3/1.5.7 踩过的坑（括号里的标点被劈开、
 * 颜文字被吞、收尾括号单独成一条），这里按同样口径重写，不拷源码。
 *
 * 规则：
 *  1. 句末只认 。！？；… 和换行；收尾括号 ）」』】"" 单独出现不算句末
 *  2. 括号/引号内部的标点不断句（「（笑）好。真的」只断一次）
 *  3. 单句过长先按逗号/顿号断，实在没有标点才按字数硬切
 *  4. 保留颜文字里的符号与空格，只把多空格压成一个
 */

const OPEN = '（(「『【[《〈{'
const CLOSE = '）)」』】]》〉}'
const ENDERS = '。！？!?；;…\n'
const TRAIL = '）)」』】]》〉}”"\'’'
const SOFT = '，,、､：:'
const MAX_LINE = 44

/** 去掉 markdown 装饰符号：弹幕是给人瞟一眼的，星号下划线只会变成噪点 */
function clean (s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[*_`~]+/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .trim()
}

/** 超长句：优先在逗号断，其次顿号，最后按字数硬切 */
function chunkLong (seg, max) {
  const out = []
  let rest = seg
  while (rest.length > max) {
    let cut = -1
    const lo = Math.max(1, Math.ceil(max * 0.45))
    const hi = Math.min(rest.length - 1, max)
    // 从 max 往回找最近的软标点，但别切掉太多（至少留 45%）
    for (let i = hi; i >= lo; i--) {
      if (SOFT.includes(rest[i])) { cut = i + 1; break }
    }
    // 英文没有逗号：退一步在空格断，别把单词劈成两半
    if (cut < 0) {
      for (let i = hi; i >= lo; i--) {
        if (rest[i] === ' ') { cut = i; break }
      }
    }
    if (cut < 0) cut = max
    const head = rest.slice(0, cut).trim()
    if (head) out.push(head)
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

/**
 * @param {string} text 整段话
 * @param {{max?:number}} [opts]
 * @returns {string[]} 一条一句（已去空、去首尾引号）
 */
function splitLines (text, opts) {
  const max = Math.max(8, Number(opts && opts.max) || MAX_LINE)
  const s = clean(text)
  if (!s) return []

  const segs = []
  let buf = ''
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (OPEN.includes(ch)) depth++
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1)
    if (ch === '\n' && depth === 0) {
      if (buf.trim()) segs.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
    // 引号里说完一句：「……吧。」——句号在括号内不结句，但收尾括号一落就该结了
    if (CLOSE.includes(ch) && depth === 0 && /[。！？!?；;…]$/.test(buf.slice(0, -1))) {
      if (buf.trim()) segs.push(buf.trim())
      buf = ''
      continue
    }
    if (ENDERS.includes(ch) && depth === 0) {
      // 句末后面紧跟的收尾括号/引号属于这一句，别让它们单独成条
      while (i + 1 < s.length && TRAIL.includes(s[i + 1])) buf += s[++i]
      if (buf.trim()) segs.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim()) segs.push(buf.trim())

  const out = []
  for (const seg of segs) {
    const t = seg.replace(/^[「『"'【\s]+/, '').replace(/[」』"'】\s]+$/, '').trim()
    if (!t) continue
    // 只有标点、没有实字的碎片（「……」「。」）不成条
    if (!/[\p{L}\p{N}]/u.test(t)) continue
    if (t.length <= max) out.push(t)
    else out.push(...chunkLong(t, max))
  }
  return out
}

module.exports = { splitLines, clean, chunkLong, MAX_LINE }
