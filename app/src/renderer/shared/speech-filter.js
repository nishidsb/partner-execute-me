/**
 * 语音识别结果「像不像话」过滤（0.38.0）
 *
 * 为什么需要：常开麦克风会对着静音、空调声、椅子响一直断句，识别出来的东西
 * 经常是「嗯。」「그.」「。」这种碎片，直接进对话就是她莫名其妙回一句。
 * 参考项目（鱼搭子 1.5.1）用「去标点后至少两个字」这一条，这里按同样口径实现，
 * 但拆成纯函数放在共享层，桌面角色和设置页两边都用同一套判断。
 *
 * 只做「明显不对」的拦截，不猜内容：宁可漏放一句「嗯」，也别把「不去。」截掉。
 */
;(function (root) {
  'use strict'

  // 常见 ASR 噪声碎片：单字语气词 + 单字母韩文/日文假名误识（静音时特别爱冒这个）
  const NOISE = new RegExp(
    '^(?:' +
    '[嗯啊哦额呃唔唉哎欸诶噢喔哟呀哈嘿唉]|' +
    '[음그어아오응]|' +
    '[えあうんーお]|' +
    '[a-z]' +
    ')$', 'i')

  // 日语长音拖长（「えー」「あーー」）：识别引擎在静音时最爱输出这个
  const KANA_FILLER = /^[えあうんおー]{1,4}$/

  /* 0.49.0 纯应声判定：听见了，但不值得接话。
   * 真人在旁边听人说话，语气词只是「嗯、哦、哈哈」这种存在感——不是问句也不是
   * 请求，接了反而像「只要有声音就回应」的机器。这里只收「非词汇」的应声：
   * 嗯/哦/啊/呃/噢/喔/诶/欸/嘿/哈/嘻/呵/呜/呀/哟 的叠字（嗯嗯、哦哦、哈哈哈），
   * 加少数固定词。谢/好/对 这类有实义的应答不拦——那是真的在跟你说话。 */
  const FILLER_CHARS = '嗯哦啊呃噢喔诶欸嘿哈嘻呵呜呀哟'
  const FILLER = new RegExp(
    '^([' + FILLER_CHARS + '])\\1{1,4}$' + // 叠字：嗯嗯 / 哦哦 / 哈哈哈…
    '|^(?:嗯呐|嗯哼|嗯呢|哦豁|啊这|诶嘿|欸嘿|噢耶|哇哦)$'
  )
  function isFiller (text) {
    const c = core(text)
    if (!c || c.length > 8) return false
    return FILLER.test(c)
  }

  /** 去掉标点、符号、空白，只留「实字」 */
  function core (s) {
    return String(s || '')
      .replace(/[\p{P}\p{S}\s\u3000]/gu, '')
      .trim()
  }

  /**
   * @param {string} text 识别结果
   * @returns {{ok:boolean, reason?:string, text?:string}}
   */
  function looksLikeSpeech (text) {
    const raw = String(text || '').trim()
    if (!raw) return { ok: false, reason: 'empty' }
    const c = core(raw)
    if (!c) return { ok: false, reason: 'punctuation' }
    // 中文一字不成句（「不」「嗯」多半是噪声）；英文/数字两个字符起才可能是话
    const hasCJK = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(c)
    if (hasCJK && c.length < 2) return { ok: false, reason: 'too-short' }
    if (!hasCJK && c.length < 2) return { ok: false, reason: 'too-short' }
    if (NOISE.test(c)) return { ok: false, reason: 'noise' }
    if (KANA_FILLER.test(c)) return { ok: false, reason: 'noise' }
    // 实字占比太低（整句都是符号、乱码方块）：不算话
    const real = (raw.match(/[\p{L}\p{N}]/gu) || []).length
    if (real === 0) return { ok: false, reason: 'no-letters' }
    if (real / raw.length < 0.5) return { ok: false, reason: 'mostly-symbols' }
    // 同一个字重复 5 次以上（识别卡带）：只留一次
    const uniq = new Set(c.split(''))
    if (c.length >= 5 && uniq.size === 1) return { ok: false, reason: 'stutter' }
    return { ok: true, text: raw }
  }

  const api = { looksLikeSpeech, isFiller, core }
  root.speechFilter = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
