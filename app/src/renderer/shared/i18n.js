'use strict'
/* 界面多语言（S7 / 规格 7.4 + 7.5 的「界面」层）
 *
 * 机制对齐参考仓 Coopanion 的 i18n（AGPL，只对齐机制，实现重写）：
 *  - 11 个语言码：zh / zh-Hant / en / ja / ko / fr / de / es-419 / pt-BR / it / ru
 *  - 每语言一份 strings 文件；zh 与 en 是全量基线，其它语言缺的顶层组
 *    回退基线（zh-Hant 回 zh，其余回 en），按顶层组合并而非整表替换
 *  - BCP 47 locale 归一：zh-TW/zh-HK/zh-MO → zh-Hant；任意 es → es-419；
 *    任意 pt → pt-BR；其余主语言认名，认不出返回 null（调用方兜底 zh）
 *  - 语言来源优先级：用户显式设置 > 系统语言 > zh
 *
 * 本文件必须先于 strings.*.js 与 app.js 加载（strings 往 AuraI18n.STRINGS 挂）。
 */
;(function (root) {
  const LANGUAGES = ['zh', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es-419', 'pt-BR', 'it', 'ru']
  const STRINGS = {} // code -> { 组名: { key: 文案 } 或顶层标量 }
  let current = 'zh'
  let table = {}

  function isLanguage (v) { return typeof v === 'string' && LANGUAGES.indexOf(v) !== -1 }

  /** BCP 47 标签 → 语言码；认不出返回 null */
  function normalizeLocale (tag) {
    const t = String(tag || '').trim().toLowerCase()
    if (!t) return null
    const parts = t.split(/[-_]/)
    const primary = parts[0]
    const second = parts[1] || ''
    switch (primary) {
      case 'zh':
        if (second === 'hant' || second === 'tw' || second === 'hk' || second === 'mo' || second === 'cnt') return 'zh-Hant'
        return 'zh'
      case 'es': return 'es-419'
      case 'pt': return 'pt-BR'
      case 'en': return 'en'
      case 'ja': return 'ja'
      case 'ko': return 'ko'
      case 'fr': return 'fr'
      case 'de': return 'de'
      case 'it': return 'it'
      case 'ru': return 'ru'
      default: return null
    }
  }

  /** 部分翻译回退到哪份基线：zh-Hant 读 zh，其余读 en */
  function baseFor (code) { return (code === 'zh' || code === 'zh-Hant') ? 'zh' : 'en' }

  function isPlainObject (v) {
    return !!v && typeof v === 'object' && !Array.isArray(v)
  }

  /** 当前语言的文案表：缺的顶层组用基线补齐（组内整组合并，不逐 key 混搭） */
  function pick (code) {
    if (!isLanguage(code)) code = 'zh'
    const base = STRINGS[baseFor(code)] || {}
    const own = STRINGS[code]
    if (code === baseFor(code) || !isPlainObject(own)) return base
    const out = {}
    for (const k of Object.keys(base)) {
      const b = base[k]
      const o = own[k]
      if (o === undefined) { out[k] = b; continue }
      out[k] = (isPlainObject(b) && isPlainObject(o)) ? Object.assign({}, b, o) : o
    }
    return out
  }

  /** 用户设置('auto'/'zh'/乱值) → 实际语言码；auto / 认不出时跟系统，最后兜底 zh */
  function resolve (stored) {
    if (isLanguage(stored)) return stored
    try {
      if (typeof navigator !== 'undefined' && navigator.language) {
        const c = normalizeLocale(navigator.language)
        if (c) return c
      }
    } catch {}
    return 'zh'
  }

  function setLang (code) {
    current = isLanguage(code) ? code : resolve(code)
    table = pick(current)
    return current
  }

  /** t('ui.settings') / t('vendor.visionOk', name, model) */
  function t (key) {
    const parts = String(key || '').split('.')
    let v = table
    for (const p of parts) {
      if (v == null || typeof v !== 'object') { v = undefined; break }
      v = v[p]
    }
    if (v === undefined) return key
    if (typeof v === 'function') return v.apply(null, Array.prototype.slice.call(arguments, 1))
    return String(v)
  }

  /** 扫 DOM：data-i18n → textContent，data-i18n-ph → placeholder，data-i18n-title → title。
   * 含控件子元素的容器（如 <label>文字<input>）只能替换首个文本节点——
   * 直接改 textContent 会把里面的输入控件一起清掉（jsdom 回归测出过的真 bug） */
  function setText (el, txt) {
    if (!el.children.length) { el.textContent = txt; return }
    let n = el.firstChild
    while (n && n.nodeType !== 3) n = n.nextSibling
    if (n) n.textContent = txt
    else el.insertBefore(el.ownerDocument.createTextNode(txt), el.firstChild)
  }

  function applyDOM (rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null)
    if (!root) return
    const q = (attr) => Array.prototype.slice.call(root.querySelectorAll('[' + attr + ']'))
    for (const el of q('data-i18n')) setText(el, t(el.getAttribute('data-i18n')))
    for (const el of q('data-i18n-ph')) el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')))
    for (const el of q('data-i18n-title')) {
      const v = t(el.getAttribute('data-i18n-title'))
      el.setAttribute('title', v)
      el.setAttribute('aria-label', v)
    }
  }

  root.AuraI18n = {
    LANGUAGES,
    STRINGS,
    normalizeLocale,
    baseFor,
    pick,
    resolve,
    setLang,
    get lang () { return current },
    t,
    applyDOM
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = root.AuraI18n
})(typeof window !== 'undefined' ? window : globalThis)
