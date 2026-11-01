'use strict'
/**
 * 字幕断句（纯函数，无 Electron 依赖，可单测）
 *
 * 从鱼搭子（dsh-fish-buddy）的实测经验搬过来，三条规矩**别改回去**：
 *   1. 同一段文字**连续 3 帧**才算这句真出现 —— 字幕淡入那两帧是残缺的；
 *   2. 跟当前这句**很像**（最长公共子序列占比 ≥ 0.6）就当同一句，留更完整的那版；
 *   3. 只在**字幕消失**时定稿 —— 换行不算，这样一句只推一次。
 *
 * 为什么不是「识别到就发」：OCR 每 1.2 秒读一帧，同一句会被读到七八次；
 * 直接发就是七八条重复字幕灌进上下文，既费 token 又把她的注意力搅乱。
 */

const STABLE_FRAMES = 3
const BLANK_FRAMES = 2
const SIMILAR_RATIO = 0.6

/** 算得上「字」的字符数（字母数字，含中日文） */
function wordCount (t) {
  let n = 0
  for (const ch of String(t || '')) {
    if (/[\p{L}\p{N}]/u.test(ch)) n++
  }
  return n
}

/**
 * 去掉首尾不是字的东西。
 * 实例：淡入那一帧会读出 `0那你就赶快回去` 这种，前面那个 0 是残影。
 */
function clean (t) {
  let s = String(t || '').trim()
  if (s.length >= 4 && s[0] === '0' && /[\p{L}\p{N}]/u.test(s[1]) && s.charCodeAt(1) > 127) {
    s = s.slice(1)
  }
  let left = 0
  let right = s.length
  const okHead = (ch) => /[\p{L}\p{N}]/u.test(ch) || '「『（(【'.includes(ch)
  const okTail = (ch) => /[\p{L}\p{N}]/u.test(ch) || '」』）)】'.includes(ch)
  while (left < right && !okHead(s[left])) left++
  while (right > left && !okTail(s[right - 1])) right--
  s = s.slice(left, right)
  return wordCount(s) >= 2 ? s : ''
}

function kanaCount (t) {
  let n = 0
  for (const ch of String(t || '')) {
    if (ch >= '\u3040' && ch <= '\u30ff') n++
  }
  return n
}

/** 有假名且占比不低 → 当日本那行（中日双语字幕时用来分家） */
function isJapanese (t) {
  const n = wordCount(t)
  if (n < 2) return false
  return kanaCount(t) / n >= 0.15
}

/** 最长公共子序列长度（滚动数组，O(min) 空间） */
function lcs (a, b) {
  let prev = new Array(b.length + 1).fill(0)
  for (const ca of a) {
    const cur = [0]
    for (let j = 1; j <= b.length; j++) {
      cur.push(ca === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]))
    }
    prev = cur
  }
  return prev[b.length]
}

/** 两句是不是同一句（包含关系直接算；否则看重合度） */
function sameSentence (a, b) {
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  return lcs(a, b) / Math.max(a.length, b.length) >= SIMILAR_RATIO
}

/** 一组候选里挑最完整的（字最多，其次整句最长） */
function bestOf (list) {
  let best = ''
  for (const s of list) {
    if (wordCount(s) > wordCount(best) || (wordCount(s) === wordCount(best) && s.length > best.length)) best = s
  }
  return best
}

/**
 * 断句器。喂「这一帧读到什么」，吐出「该定下来的句子」（没有就空串）。
 * 纯状态机，不碰 IO。
 */
function createSegmenter () {
  let last = ''
  let same = 0
  let cands = []
  let blank = 0

  const state = () => ({ last, same, cands: cands.slice(), blank })

  function feed (raw) {
    const text = clean(raw)
    if (!text) {
      last = ''
      same = 0
      blank += 1
      if (blank >= BLANK_FRAMES && cands.length) {
        const good = bestOf(cands)
        cands = []
        return good
      }
      return ''
    }
    blank = 0
    if (text === last) same += 1
    else { last = text; same = 1 }
    if (same < STABLE_FRAMES) return ''
    if (!cands.length) {
      cands = [text]
    } else if (sameSentence(bestOf(cands), text)) {
      cands.push(text)
    } else {
      const good = bestOf(cands)
      cands = [text]
      return good
    }
    return ''
  }

  /** 停掉陪看 / 切走的时候把手里还没定稿的那句收出来（不然它会永远挂着） */
  function flush () {
    if (!cands.length) return ''
    const good = bestOf(cands)
    cands = []
    return good
  }

  function reset () {
    last = ''
    same = 0
    cands = []
    blank = 0
  }

  return { feed, flush, reset, state }
}

module.exports = {
  STABLE_FRAMES,
  BLANK_FRAMES,
  SIMILAR_RATIO,
  clean,
  wordCount,
  kanaCount,
  isJapanese,
  lcs,
  sameSentence,
  bestOf,
  createSegmenter
}
