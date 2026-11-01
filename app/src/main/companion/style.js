'use strict'
/**
 * 风格 few-shot（第 1 期）：从真实对话里攒「主人说 ↔ 她答得好」的样本对，
 * 聊天时注入少量最近样本，让她说话越来越像「你们的相处方式」。
 *
 * 定位与记忆库错开：记忆库存**事实**（陈述句），这里存**说法**（对话对）。
 * 纯追加的环形池（cap 200），坏了删一条就行，不走审查队列；
 * 注入走 context.js 装配管线，自带小预算（800 字符），不挤别的段。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 池文件 */
function fileFor (wsDir) { return path.join(wsDir, 'style-samples.jsonl') }

function load (wsDir) {
  try {
    return fs.readFileSync(fileFor(wsDir), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

function save (wsDir, pool) {
  const file = fileFor(wsDir)
  const tmp = file + '.tmp'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, pool.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

/** 样本是否值得收：两边都短小有内容、不是工具调用流水 */
function valid (userText, reply) {
  const u = String(userText || '').trim()
  const r = String(reply || '').trim()
  if (u.length < 2 || r.length < 6) return false
  if (u.length > 200 || r.length > 600) return false
  if (/^\[|^\{|^\{"/.test(r)) return false // JSON/标记开头的多半是工具结构
  return true
}

/**
 * 入池（纯，返回新池）。同问同答去重；超 cap 挤掉最旧的。
 * @param {Array} pool
 * @param {{user:string, reply:string, lang?:string, at?:number}} s
 */
function addSample (pool, s, cap) {
  const list = (pool || []).slice()
  const user = String(s.user || '').trim()
  const reply = String(s.reply || '').trim()
  const sig = user.slice(0, 60) + '=>' + reply.slice(0, 80)
  if (list.some((x) => x.sig === sig)) return { pool: list, dup: true }
  list.push({ sig, user, reply, lang: s.lang || '', at: Number(s.at) || Date.now() })
  const c = Math.max(20, Number(cap) || 200)
  while (list.length > c) list.shift()
  return { pool: list, dup: false }
}

/** 取最近 n 条（优先同语言，不够再拿别的语言凑） */
function pick (pool, lang, n) {
  const list = (pool || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0))
  const want = Math.max(1, Number(n) || 4)
  if (!lang) return list.slice(0, want)
  const same = list.filter((x) => x.lang === lang)
  const out = same.slice(0, want)
  for (const x of list) {
    if (out.length >= want) break
    if (!out.includes(x)) out.push(x)
  }
  return out
}

/** 组 systemPrompt 段落（含 800 字符预算封顶） */
function buildSection (samples) {
  const list = (samples || []).filter((x) => x && x.user && x.reply)
  if (!list.length) return ''
  const head = '【对话风格示例 · 她最近和主人说话的真实样子】\n（只学语气和长度感，不要复述内容）\n'
  const lines = list.map((x) => '主人：' + x.user + '\n她：' + x.reply).join('\n---\n')
  return (head + lines).slice(0, 800)
}

module.exports = { fileFor, load, save, valid, addSample, pick, buildSection }
