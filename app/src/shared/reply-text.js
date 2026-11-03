/**
 * 回复文本清洗 · 0.45.98
 *
 * 用户 11-02 报的两个现象，其实是同一个病根：
 *  ① QQ 里收到的消息开头带着「（QQ）」两个字母；
 *  ② 电脑这边的 TTS 变成「日语念一遍、中文念一遍」。
 *
 * 病根：0.45.27 为了让她分得清「哪几条是 QQ 上的往来」，把（QQ）前缀**写进了账本正文**；
 * 0.45.94 为了 QQ 上能读懂日语，又把译文**拼进了同一条消息的正文**。
 * 模型看到自己以前的回复长这样，就照着学：新回复也自带（QQ）前缀、也自带一段括号译文。
 * 于是前缀漏到 QQ 用户眼前，括号里的中文被 TTS 当成台词一起念了。
 *
 * 这里放三个纯函数：入口先剥前缀（显示/朗读/发送都要干净），
 * 朗读前再把「括号里的另一种语言」当译文丢掉——她只需要念台词，译文是给人看的。
 *
 * 浏览器里挂 window.replyText，node 里可直接 require（单测用）。
 */
;(function (root) {
  'use strict'

  /** 开头的场合标注：（QQ）／[QQ]／【QQ】／(QQ:123456)／（气泡）／[桌面]……（可连写多层） */
  const TAG_RE = /^[\s\u3000]*[【\[（(]\s*(?:QQ|qq|气泡|桌面)\s*(?:[:：]\s*\d{3,})?\s*[】\]）)]\s*[:：]?\s*/

  /** 结尾的括号块（译文常见形态）；内部允许换行，但不超过 400 字 */
  const TAIL_RE = /[（(]\s*([^（）()]{2,400})\s*[)）]\s*$/

  /** 粗判语种：先看假名（日），再看汉字（中），最后连续拉丁字母（英） */
  function langOf (s) {
    const t = String(s || '')
    if (/[\u3040-\u30ff]/.test(t)) return 'ja'
    if (/[\u4e00-\u9fff]/.test(t)) return 'zh'
    if (/[A-Za-z]{3,}/.test(t)) return 'en'
    return ''
  }

  /**
   * 剥掉场合标注。每段开头都算（旧账本里一条多段、每段都带一个「（QQ）」）；
   * 连写两次（「（QQ）（气泡）好」）也能剥干净。
   * 只认「括号包住的 QQ/气泡/桌面」，正常句子开头不会被误伤。
   */
  function stripChannelTag (text) {
    return String(text || '').split('\n').map((line) => {
      let t = line
      for (let i = 0; i < 3; i++) {
        const next = t.replace(TAG_RE, '')
        if (next === t) break
        t = next
      }
      return t
    }).join('\n')
  }

  /** 整段都被括号包住？（「（中文译文）」这种独立成段的） */
  function wrapped (p) {
    const s = String(p || '').trim()
    return s.length > 2 && /^[（(]/.test(s) && /[)）]$/.test(s)
  }

  /**
   * 丢掉括号里的「另一种语言」——两处形态都处理：
   *  ① 独立成段的括号译文（旧账本里「日语一段 / （中文）一段」就是这么排的）；
   *  ② 同一段末尾的括号译文（「日语台词（中文）」）。
   * 同语种的括号（「（笑）」「（小声）」）原样保留——那是语气，不是译文。
   */
  function stripEchoTranslation (text) {
    const src = String(text || '').replace(/\r\n/g, '\n').trim()
    if (!src) return src
    const lines = src.split('\n')
    // 基准语种取「非括号段落」的语言：译文/语气括号不参与投票
    const base = langOf(lines.filter((l) => l.trim() && !wrapped(l)).join('\n')) || langOf(src)
    const kept = []
    for (const line of lines) {
      const p = line.trim()
      if (p && base && wrapped(p)) {
        const inner = p.slice(1, -1).trim()
        const b = langOf(inner)
        const longEnough = inner.replace(/[\s\u3000]/g, '').length >= 2
        if (b && b !== base && longEnough) {
          // 整行都是另一语言的译文 → 丢掉（顺手收掉它前面的空行，别留空洞）
          while (kept.length && !kept[kept.length - 1].trim()) kept.pop()
          continue
        }
      }
      kept.push(line)
    }
    let t = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    // ② 同一段末尾的括号译文
    for (let i = 0; i < 3; i++) {
      const m = TAIL_RE.exec(t)
      if (!m) break
      const inner = String(m[1] || '').trim()
      const body = t.slice(0, m.index).trim()
      if (!body || !inner) break
      const a = langOf(body)
      const b = langOf(inner)
      if (!a || !b || a === b) break
      if (inner.replace(/[\s\u3000]/g, '').length < 2) break
      t = body
    }
    return t
  }

  /** 朗读/发送用：剥前缀 + 丢括号译文 */
  function plainText (text) {
    return stripEchoTranslation(stripChannelTag(text))
  }

  /**
   * 结尾括号里那段「另一种语言」的译文——没有就返回 ''。
   * QQ 是纯文字通道，没有「台词 + 字幕」两层：宁可只发那半句译文（读得懂），
   * 也别把日语原文和中文译文糊成一条（用户 11-02：「为什么变成这样」）。
   */
  function echoTranslation (text) {
    const t = String(text || '').trim()
    const m = TAIL_RE.exec(t)
    if (!m) return ''
    const inner = String(m[1] || '').trim()
    const body = t.slice(0, m.index).trim()
    if (!body || !inner) return ''
    const a = langOf(body)
    const b = langOf(inner)
    if (!a || !b || a === b) return ''
    if (inner.replace(/[\s\u3000]/g, '').length < 2) return ''
    return inner
  }

  /**
   * 纯文字出口（QQ）该发什么：有括号译文就只发译文，否则发原文（已剥前缀）。
   * 这样一条消息只有一种语言——她「说日语、显示中文」的规则在这条通道上同样成立。
   */
  function readableText (text) {
    const t = stripChannelTag(text)
    return echoTranslation(t) || stripEchoTranslation(t)
  }

  const api = { stripChannelTag, stripEchoTranslation, echoTranslation, plainText, readableText, langOf }
  root.replyText = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
