'use strict'
/**
 * 字幕判定（纯函数，无 Electron 依赖，可单测）
 *
 * 背景：台词（朗读语言）与字幕（显示语言）是两个独立设置。
 * 例：回复语言=日语（Fish 音色只对日语自然）+ 字幕=中文 → 说日语、气泡显示中文。
 * 语音识别 / 看屏陪伴 / 时间观念 / 闹钟这些「主动发言」以前只把原文塞进气泡，
 * 用户看到的是一句没翻译的日语（0.18.0 修复点）。
 */

/** 语言代码 → 语言名（翻译提示词用） */
const LANG_NAME = { zh: '中文', en: '英文', ja: '日文' }

/**
 * 语言粗判（参考 dialogue_language_guard）：明显用错语种才返回 true。
 * 假名 = 日文；汉字（不含假名）= 中文；连续拉丁字母 = 英文词。
 */
function langMismatch (text, lang) {
  const t = String(text || '')
  if (!t) return false
  const hasKana = /[\u3040-\u30ff]/.test(t)
  const hasHan = /[\u4e00-\u9fff]/.test(t)
  const hasLatin = /[a-zA-Z]{3,}/.test(t)
  if (lang === 'ja') return !hasKana
  if (lang === 'zh') return hasKana || (!hasHan && hasLatin)
  if (lang === 'en') return hasKana || hasHan
  return false
}

/**
 * 这行台词要不要翻译成字幕？返回目标语言名（要翻）或 ''（不用翻）。
 *
 * 只按「台词实际语种 vs 字幕语言」判断，不看 replyLang：
 * 时间观念的台词固定日语（TTS 音色只对日语自然），跟 replyLang 设置无关，
 * 用 replyLang 做短路会在「回复语言=中文 + 台词=日语」时漏翻。
 * @param {string} text    台词原文
 * @param {string} subLang 字幕语言（off/zh/en/ja）
 */
function subtitleTarget (text, subLang) {
  const name = LANG_NAME[subLang] || ''
  const t = String(text || '').trim()
  if (!name || !t) return ''
  return langMismatch(t, subLang) ? name : ''
}

/**
 * 原文 + 译文的合体文案（历史实现，0.45.98 起 QQ 不再用）。
 *
 * 为什么废弃：译文拼在同一条里，模型看到自己的旧消息就学样，新回复也开始自带
 * 一段括号中文 → QQ 里一条消息两种语言、桌面 TTS 中日各念一遍（用户 11-02 报的
 * 就是这个）。现在 QQ 只发译文一条（见 companion/index.js 的 deliverReach），
 * 气泡依旧是「台词 + 字幕」两层。函数留着是因为还有单测按它的口径跑。
 */
function withTranslation (text, translated) {
  const t = String(text || '').trim()
  const tr = String(translated || '').trim()
  if (!tr || tr === t) return t
  return t + '\n（' + tr + '）'
}

module.exports = { LANG_NAME, langMismatch, subtitleTarget, withTranslation }
