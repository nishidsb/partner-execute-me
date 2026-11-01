/**
 * 助手核心：会话调度。
 * 职责：组织上下文（角色人格 + 世界书命中 + 相关记忆）→ 调用模型 →
 *       工具调用循环（高风险经 confirmFn）→ 语言守卫 → 历史持久化。
 * 不依赖任何具体角色/模型服务/桌宠进程。
 */
import fs from 'node:fs'
import { getConfig, dataPath } from '../config.js'
import { createProvider } from '../models/index.js'
import { memory } from '../memory/memoryStore.js'
import * as tools from '../tools/registry.js'
import { logger } from '../logger.js'

const MAX_TOOL_ROUNDS = 5
const HISTORY_LIMIT = 200 // 持久化上限
const CONTEXT_LIMIT = 24 // 注入上下文的最近消息条数

function historyFile (roleId) {
  const safe = String(roleId || '').replace(/[^\w.-]/g, '_')
  return dataPath('history', `${safe}.json`)
}

export class Session {
  /**
   * @param {object} role 角色定义（roleManager.get 的结果）
   */
  constructor (role) {
    if (!role || !role.id) throw new Error('Session 需要有效角色')
    this.role = role
    this.reloadProvider()
    this.history = this.loadHistory()
  }

  reloadProvider () {
    this.provider = createProvider(getConfig().provider)
  }

  /** 持久化历史（最近 HISTORY_LIMIT 条） */
  saveHistory () {
    fs.mkdirSync(dataPath('history'), { recursive: true })
    fs.writeFileSync(historyFile(this.role.id), JSON.stringify(this.history.slice(-HISTORY_LIMIT), null, 2))
  }

  loadHistory () {
    try {
      const arr = JSON.parse(fs.readFileSync(historyFile(this.role.id), 'utf8'))
      return Array.isArray(arr) ? arr.slice(-HISTORY_LIMIT) : []
    } catch { return [] }
  }

  clearHistory () {
    this.history = []
    this.saveHistory()
  }

  /** 世界书条目：按用户输入命中 keywords 注入 */
  worldHits (userText) {
    const hits = []
    const lower = String(userText).toLowerCase()
    for (const w of this.role.worldInfo || []) {
      if (!Array.isArray(w.keywords)) continue
      if (w.keywords.some((k) => k && lower.includes(String(k).toLowerCase()))) {
        hits.push(String(w.text || ''))
      }
    }
    return hits
  }

  /** 组装 system prompt：人格 + 世界书 + 相关记忆 + 语言约束 */
  buildSystem (userText) {
    const parts = []
    if (this.role.persona) parts.push(this.role.persona)
    const hits = this.worldHits(userText)
    if (hits.length) parts.push('【世界观资料】\n' + hits.join('\n'))
    const relevant = memory.search(this.role.id, userText, getConfig().memoryTopK)
    if (relevant.length) {
      parts.push('【相关长期记忆】（与当前话题相关的既往事实）\n' + relevant.map((f) => '- ' + f.text).join('\n'))
    }
    if (this.role.replyLang) {
      const names = { zh: '中文', en: '英文', ja: '日文' }
      parts.push(`【语言要求】每一条回复都必须只使用${names[this.role.replyLang] || this.role.replyLang}，禁止夹杂其它语言的句子（专有名词除外）。`)
    }
    return parts.join('\n\n')
  }

  /**
   * 主流程：用户一句话 → 回复。
   * @returns {{content, toolResults, ms}}
   */
  async send (userText, { onDelta, confirmFn } = {}) {
    const started = Date.now()
    this.history.push({ role: 'user', content: String(userText), at: Date.now() })
    const toolResults = []
    const toolDefs = tools.listDefs()

    // 角色可用工具白名单
    const allowed = this.role.tools || null
    const activeDefs = allowed ? toolDefs.filter((d) => allowed.includes(d.function.name)) : toolDefs

    const messages = () => [
      { role: 'system', content: this.buildSystem(userText) },
      ...this.history.slice(-CONTEXT_LIMIT).map((m) => {
        // tool 结果消息必须保留 tool_call_id，否则 OpenAI 兼容端点 422
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.tool_call_id, name: m.name, content: m.content }
        }
        // assistant 的工具调用请求必须还原 tool_calls 结构
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id, type: 'function',
              function: { name: t.name, arguments: t.arguments }
            }))
          }
        }
        return { role: m.role, content: m.content }
      })
    ]

    let reply = ''
    try {
      // 工具调用循环（最多 MAX_TOOL_ROUNDS 轮）
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const res = await this.provider.chat({ messages: messages(), tools: activeDefs, onDelta, signal: null })
        // 兜底：模型把工具调用当文本输出时，解析 <tool_call> 标签
        const textParsed = parseTextToolCalls(res.content || '')
        reply = textParsed.content || res.content
        const pendingCalls = res.toolCalls && res.toolCalls.length ? res.toolCalls : textParsed.toolCalls
        if (!pendingCalls.length) break
        if (round === MAX_TOOL_ROUNDS) { logger.warn('工具调用超过轮数上限，强制结束'); break }

        // 把 assistant 的工具调用请求与结果一起回填
        this.history.push({ role: 'assistant', content: textParsed.content, toolCalls: pendingCalls, at: Date.now() })
        for (const tc of pendingCalls) {
          let args = {}
          try { args = JSON.parse(tc.arguments || '{}') } catch { /* 参数坏 → 空参执行，让错误回给模型 */ }
          let resultStr
          try {
            const r = await tools.exec(tc.name, args, { confirmFn })
            toolResults.push(r)
            resultStr = JSON.stringify(r.result)
          } catch (err) {
            toolResults.push({ name: tc.name, ok: false, error: err.message })
            resultStr = '错误: ' + err.message
          }
          logger.info(`[tool] ${tc.name} → ${resultStr.slice(0, 120)}`)
          this.history.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: resultStr.slice(0, 4000), at: Date.now() })
        }
      }
    } catch (err) {
      this.history.pop() // 用户的这轮不入历史（失败重试不污染）
      this.saveHistory()
      throw err
    }

    // 语言守卫：replyLang 固定且回复明显不符时，追加纠错指令重试一次
    if (getConfig().languageGuard && this.role.replyLang && reply) {
      const check = langMismatch(reply, this.role.replyLang)
      if (check) {
        logger.warn(`[guard] 回复语言不符(${check})，定向纠正重试`)
        try {
          this.history.push({ role: 'assistant', content: reply, at: Date.now() })
          this.history.push({ role: 'user', content: `（系统提示）你上一条回复混入了${check}。请用纯${this.role.replyLang === 'zh' ? '中文' : this.role.replyLang === 'ja' ? '日文' : '英文'}重新回答刚才的问题，禁止夹杂其它语言。`, at: Date.now() })
          const res2 = await this.provider.chat({ messages: messages(), tools: activeDefs, onDelta: null })
          if (res2.content && !langMismatch(res2.content, this.role.replyLang)) reply = res2.content
          this.history.pop(); this.history.pop() // 纠错轮不入长期历史
        } catch (e) { logger.warn('[guard] 纠正重试失败，保留原回复:', e.message) }
      }
    }

    this.history.push({ role: 'assistant', content: reply, at: Date.now() })
    this.saveHistory()
    return { content: reply, toolResults, ms: Date.now() - started }
  }
}

/** 粗判回复语言是否符合要求：假名→ja；汉字+假名混排→ja；纯 CJK 汉字→zh */
export function langMismatch (text, expect) {
  const s = String(text || '')
  const kana = (s.match(/[\u3040-\u30ff]/g) || []).length
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const latinWords = (s.match(/[A-Za-z]{3,}/g) || []).length
  if (expect === 'ja') return kana === 0 && han > 4 ? '纯中文' : null
  if (expect === 'zh') return kana > 2 ? '日语' : null
  if (expect === 'en') return kana > 2 || (han > 6 && latinWords === 0) ? '中日文' : null
  return null
}

/**
 * 文本形式工具调用兜底：部分模型（尤其非官方别名/量化服务）会把工具调用
 * 当普通文本输出（Qwen/Hermes 风格 <tool_call>{...}</tool_call> 标签）。
 * 解析成功则从回复文本中剥离并转为 toolCalls 结构，保证核心不被模型退化行为击穿。
 */
export function parseTextToolCalls (content) {
  const calls = []
  // 形式 1：<tool_call>{JSON}</tool_call>（Qwen/Hermes 风格完整对象）
  const cleaned = String(content || '').replace(
    /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi,
    (_m, json) => {
      try {
        const obj = JSON.parse(json)
        const name = obj.name || (obj.function && obj.function.name)
        if (name) {
          calls.push({
            id: 'text_tc_' + calls.length + '_' + Date.now().toString(36),
            name,
            arguments: JSON.stringify(obj.arguments ?? obj.parameters ?? (obj.function && obj.function.arguments) ?? {})
          })
        }
      } catch { /* 坏 JSON 忽略 */ }
      return ''
    }
  )
  // 形式 2：<tool_call>工具名</tool_call>（部分服务退化为裸名，无参数）
  const cleaned2 = cleaned.replace(
    /<tool_call>\s*([a-zA-Z_][\w.]*)\s*<\/tool_call>/gi,
    (_m, name) => {
      calls.push({
        id: 'text_tc_' + calls.length + '_' + Date.now().toString(36),
        name,
        arguments: '{}'
      })
      return ''
    }
  )
  // 形式 3：行内 tool_call:name / tool_call：name（无标签的伪调用文本）
  let cleaned3 = cleaned2
  if (!calls.length) {
    cleaned3 = cleaned2.replace(
      /^\s*tool_call\s*[:：]\s*([a-zA-Z_][\w.]*)\s*$/gim,
      (_m, name) => {
        calls.push({
          id: 'text_tc_' + calls.length + '_' + Date.now().toString(36),
          name,
          arguments: '{}'
        })
        return ''
      }
    )
  }
  return { content: cleaned3.trim(), toolCalls: calls }
}
