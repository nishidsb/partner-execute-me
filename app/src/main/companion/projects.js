'use strict'
/**
 * 跨天项目（0.45.19）——她不只有「这一场」，还有「这些天」
 *
 * ── 为什么要有这个 ───────────────────────────────────────────────
 * 0.45.18 之后她会憋、会想做什么，但每场活动都是孤立的一次性消费：
 * 看完就完了，昨天跟今天之间没有线。活人不是这样的——
 * 他有「最近在弄的那个东西」，今天推进一点，明天接着弄，弄完了
 * 有收尾的踏实，然后开下一个。这就是成长弧的最小实现。
 *
 * ── 设计 ─────────────────────────────────────────────────────────
 * 一个时刻只有一个进行中的项目（人的注意力就是这样）：
 *   { title, why, steps[3], noteIdx, notes[], createdAt, updatedAt }
 * 生命周期全在本地（不依赖 LLM，稳定可测）：
 *   ensure()  没有 active 项目就从话题池挑一个立起来（选题避开刚做完的）
 *   blockOf() 注入自主活动 sys：「你有个进行中的项目…这次可以推进…」
 *   note()    每场活动收尾把汇报记一笔（cap 20）
 *   maybeFinish() 攒够 4 笔就算做完 → 总结进 done[]（cap 10）→ 下次 ensure 新项目
 * 项目素材 = autonomyPool 的话题（主人搜过什么，她最近就关心什么）。
 */

const path = require('node:path')
const fs = require('node:fs')

const NOTE_CAP = 20
const DONE_CAP = 10
const FINISH_AFTER = 4          // 攒 4 笔进展就算做完
const TITLE_CAP = 24

const fileOf = (wsDir) => wsDir ? path.join(wsDir, 'projects.json') : ''

function load (wsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsDir), 'utf8'))
    if (!raw || typeof raw !== 'object') return { active: null, done: [] }
    return { active: raw.active || null, done: Array.isArray(raw.done) ? raw.done.slice(0, DONE_CAP) : [] }
  } catch { return { active: null, done: [] } }
}

function save (wsDir, state) {
  try {
    if (!fileOf(wsDir)) return false
    fs.writeFileSync(fileOf(wsDir), JSON.stringify(state), 'utf8')
    return true
  } catch { return false }
}

/** 立一个新项目：模板化措辞，title 来自话题（截断），避开展近做完的 */
function newProject (theme, now, avoid) {
  const t = String(theme || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_CAP)
  const av = Array.isArray(avoid) ? avoid : []
  const s = {
    title: t ? '弄清楚「' + t + '」' : '把手头的笔记理一理',
    why: t ? '前几天就对它有点好奇，一直没腾出整块时间' : '自己的地盘该收拾了',
    steps: ['查资料弄明白它是什么', '把值得留的记进自己的笔记', '写一小段自己的看法收尾'],
    noteIdx: 0,
    notes: [],
    createdAt: Number(now) || Date.now(),
    updatedAt: Number(now) || Date.now()
  }
  return s
}

/** 没有 active 就立新项目（选题来自 themes，避开 done[] 最近的主题） */
function ensure (state, themes, now) {
  const s = state || { active: null, done: [] }
  if (s.active) return s
  const avoid = (s.done || []).map((d) => d.title)
  const pool = (Array.isArray(themes) ? themes : [])
    .map((t) => String(t || '').trim())
    .filter((t) => t.length >= 2 && t.length <= 40)
  const theme = pool.find((t) => !avoid.some((a) => a.includes(t) || t.includes(a))) || pool[0] || ''
  s.active = newProject(theme, now, avoid)
  return s
}

/** 动机块：注入 runSpace/runFree 的 sys。没项目不出声 */
function blockOf (state) {
  const a = state && state.active
  if (!a) return ''
  const step = a.steps[Math.min(a.noteIdx, a.steps.length - 1)]
  const left = Math.max(0, FINISH_AFTER - (a.notes ? a.notes.length : 0))
  const lines = [
    '你有个进行中的小项目：《' + a.title + '》（' + a.why + '）。',
    '这次可以顺手推进它：' + step + '。不用一场做完，推进一点就行' +
      (left > 0 ? '（大约还差 ' + left + ' 次就收尾了）' : '') + '。'
  ]
  if (left <= 1) lines.push('这个项目快收尾了，这次做完的话，把小结写进你的笔记。')
  return lines.join('\n')
}

/** 活动收尾记一笔（有汇报才记） */
function note (state, line, now) {
  const s = state || { active: null, done: [] }
  const a = s.active
  const text = String(line || '').trim()
  if (!a || !text) return s
  a.notes = (a.notes || []).concat([text.slice(0, 200)]).slice(-NOTE_CAP)
  a.noteIdx = Math.min((a.noteIdx || 0) + 1, a.steps.length - 1)
  a.updatedAt = Number(now) || Date.now()
  return s
}

/** 攒够进展就收尾：总结进 done[]，active 清空（下次 ensure 开新项目） */
function maybeFinish (state, now) {
  const s = state || { active: null, done: [] }
  const a = s.active
  if (!a) return { state: s, finished: null }
  if ((a.notes || []).length < FINISH_AFTER) return { state: s, finished: null }
  const last = a.notes[a.notes.length - 1]
  const finished = {
    title: a.title,
    summary: String(last || '').slice(0, 160),
    finishedAt: Number(now) || Date.now()
  }
  s.done = [finished].concat(s.done || []).slice(0, DONE_CAP)
  s.active = null
  return { state: s, finished }
}

/** 调试/状态面板 */
function statusOf (state) {
  const s = state || { active: null, done: [] }
  return {
    active: s.active ? { title: s.active.title, notes: (s.active.notes || []).length, toFinish: Math.max(0, FINISH_AFTER - (s.active.notes || []).length) } : null,
    doneCount: (s.done || []).length
  }
}

/** 运行时实例：autonomy 只跟它说话 */
function create (deps) {
  const d = deps || {}
  const now = d.now || Date.now
  const log = d.log || (() => { })
  const wsDirOf = typeof d.wsDir === 'function' ? d.wsDir : () => ''
  let state = null

  function ensureState () {
    if (!state) state = load(wsDirOf())
    return state
  }
  function commit () { try { save(wsDirOf(), state) } catch { } }

  return {
    /** 没有 active 就立新项目；返回注入块 */
    block (themes) {
      ensureState()
      ensure(state, themes, now())
      commit()
      return blockOf(state)
    },
    /** 一场活动收尾：记一笔 + 判断收尾。返回 finished（收尾台词用） */
    record (line) {
      ensureState()
      note(state, line, now())
      const r = maybeFinish(state, now())
      commit()
      if (r.finished) log('[projects] 项目收尾：《' + r.finished.title + '》')
      return r.finished
    },
    reset () { state = null },
    status () { return statusOf(ensureState()) }
  }
}

module.exports = {
  NOTE_CAP, DONE_CAP, FINISH_AFTER,
  load, save, newProject, ensure, blockOf, note, maybeFinish, statusOf, create
}
