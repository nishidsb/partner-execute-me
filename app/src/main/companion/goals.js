'use strict'
/**
 * 0.46.28 她自己的生活线（goals）
 *
 * 用户 11-03「还有什么补充才能更像活着的」四件套之一。此前的系统全是「当下反应」
 * （需求压力/好奇心/牵挂 3 天 TTL），没有周~月尺度的叙事弧——活人还有「正在过的生活」：
 * 想学什么、在追什么、给自己定的月度小目标，会宣布、推进、卡住、完成并回味。
 *
 * 落盘 <工作区>/goals.json（跟角色走）。她自己用 goal_* 工具建/记/结；
 * promptBlock 进系统提示词；7 天没进展自动标记「卡住」（她会自己念叨）。
 * 纯逻辑与 IO 分离，node:test 可直接跑。
 */

const fs = require('node:fs')
const path = require('node:path')

const STUCK_MS = 7 * 86400000 // 一周没动静 = 卡住
const MAX_GOALS = 12
const DONE_GLOW_MS = 3 * 86400000 // 刚完成的 3 天内进「回味期」

function createGoals ({ wsDir, now = () => Date.now(), log = () => { } }) {
  const file = path.join(wsDir, 'goals.json')

  function read () {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(j) ? j : []
    } catch { return [] }
  }

  function write (list) {
    try {
      fs.mkdirSync(wsDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(list, null, 1), 'utf8')
    } catch (err) { log('[goals] 保存失败: ' + (err && err.message)) }
  }

  /** 7 天没进展的 active 目标标记卡住（写回由调用方决定） */
  function sweep (list) {
    const t = now()
    let changed = false
    for (const g of list) {
      if (g && g.status === 'active' && !g.stuck && t - (g.updatedAt || g.createdAt) > STUCK_MS) {
        g.stuck = true
        changed = true
      }
    }
    return changed
  }

  function add ({ title, detail = '' } = {}) {
    const t = String(title || '').trim().slice(0, 60)
    if (!t) return { ok: false, error: '目标得有名字' }
    const list = read()
    if (list.length >= MAX_GOALS) return { ok: false, error: '最多 ' + MAX_GOALS + ' 个目标，先放下旧的再开新的' }
    const goal = {
      id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title: t,
      detail: String(detail || '').trim().slice(0, 200),
      status: 'active',
      stuck: false,
      createdAt: now(),
      updatedAt: now(),
      progress: []
    }
    list.push(goal)
    write(list)
    log('[goals] 新目标「' + t + '」')
    return { ok: true, goal }
  }

  function progress ({ id, note } = {}) {
    const n = String(note || '').trim().slice(0, 120)
    if (!n) return { ok: false, error: '进展要写一句' }
    const list = read()
    const g = list.find((x) => x && x.id === id && x.status === 'active')
    if (!g) return { ok: false, error: '没找到进行中的目标' + (id ? '（' + id + '）' : '') }
    g.progress.push({ at: now(), note: n })
    if (g.progress.length > 10) g.progress.shift()
    g.updatedAt = now()
    g.stuck = false
    write(list)
    return { ok: true }
  }

  /** status: 'done' 完成 | 'abandon' 放下 */
  function close ({ id, status = 'done', note = '' } = {}) {
    const list = read()
    const g = list.find((x) => x && x.id === id && x.status === 'active')
    if (!g) return { ok: false, error: '没找到进行中的目标' }
    g.status = status === 'abandon' ? 'abandoned' : 'done'
    g.doneAt = now()
    const n = String(note || '').trim().slice(0, 120)
    if (n) g.progress.push({ at: now(), note: n })
    write(list)
    log('[goals] ' + (status === 'abandon' ? '放下' : '完成') + '「' + g.title + '」')
    return { ok: true }
  }

  function listRaw () {
    const list = read()
    if (sweep(list)) write(list)
    return list
  }

  /** 进系统提示词的段落；没有目标返回 ''（整段不占预算） */
  function promptBlock () {
    const list = listRaw()
    const act = list.filter((g) => g && g.status === 'active')
    const done = list.filter((g) => g && g.status === 'done' && now() - (g.doneAt || 0) < DONE_GLOW_MS)
    if (!act.length && !done.length) return ''
    const lines = act.slice(0, 6).map((g) => {
      const last = g.progress && g.progress.length ? ' 最新：' + g.progress[g.progress.length - 1].note : ''
      return '· 进行中「' + g.title + '」' + (g.detail ? '（' + g.detail + '）' : '') +
        (g.stuck ? '——已经一周没动静，你自己也觉得卡住了' : last)
    })
    for (const g of done.slice(0, 2)) lines.push('· 刚完成「' + g.title + '」——完成了的事可以自然地回味')
    return '【她自己的生活线（正在过的生活）】\n' + lines.join('\n') +
      '\n这些是你自己给自己定的事。进展要自然带出来，别像汇报工作；想开新目标、记进展或了结时用 goal_set / goal_update 真写进去。'
  }

  return { add, progress, close, listRaw, promptBlock, file }
}

module.exports = { createGoals, STUCK_MS, MAX_GOALS, DONE_GLOW_MS }
