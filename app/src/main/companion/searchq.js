'use strict'
/**
 * 搜索 URL 的「活人化」清洗（主人 2026-10-31 拍板三选项选 1 后的另一面：
 * 开浏览器权限保留，但搜法要像人）。
 * 事故样本：她把画像档案的「# 搜索记录」章节标题连 # 带引号塞进了 Bing：
 *   "​# 搜索记录" 是什么   ← 活人不会这么搜
 * 规则：只认搜索参数（q/wd/word/keyword/kw/query/text/search），剥掉
 * #号/星号/反引号/各种引号/【】方括号再收拢空格；剥完为空才拒（整串都是
 * 符号 = 不是人话），拒的时候把话说清楚让她重搜——工具回话本身就是教学。
 * 普通网页 URL / 非搜索 URL 原样放行。
 * 注意：builtin.js（ESM）用 createRequire 引这里，别挪位置。
 */
const SEARCH_KEYS = ['q', 'wd', 'word', 'keyword', 'kw', 'query', 'text', 'search']
const NOISE_RE = /[#*`>【】〔〕｛｝\[\]「」『』“”‘’"'\u3000]+/g

function sanitizeSearchUrl (u) {
  let url
  try { url = new URL(String(u || '')) } catch { return { pass: true, url: u } }
  const key = SEARCH_KEYS.find((k) => url.searchParams.has(k))
  if (!key) return { pass: true, url: u }
  const raw = String(url.searchParams.get(key) || '')
  const q = raw.replace(NOISE_RE, ' ').replace(/\s+/g, ' ').trim()
  if (!q) {
    return { pass: false, raw, why: '搜索词剥掉符号后什么都没剩下（原文：' + raw.slice(0, 40) + '）。像活人那样搜：几个自然关键词，不要把文档标题、# 号、引号原样搬进搜索框。' }
  }
  if (q === raw) return { pass: true, url: u }
  url.searchParams.set(key, q)
  return { pass: true, url: url.href, changed: true, raw, q }
}

module.exports = { sanitizeSearchUrl }
