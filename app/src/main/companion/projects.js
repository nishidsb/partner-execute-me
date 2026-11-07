'use strict'
/**
 * 跨天项目 v2（0.46.64）——她不只有「这一场」，还有「这些天」
 *
 * ── v1（0.45.19）有什么 ─────────────────────────────────────────
 * 单一研究型模板（查资料→记笔记→写看法）+ 攒 4 笔自动收尾 + notes 只存汇报文字。
 * 真机跑了近一个月的结论：机制能用，但她做出来的项目全是「查资料」一种，
 * 「完成」是攒出来的不是做出来的——活人不会数着「再干 4 次就完工」。
 *
 * ── v2（0.46.64，自主制作与共同创作·阶段一）改了什么 ──────────────
 * 1. 五类型模板：research / writing / collection / organize / conceive，
 *    各有默认 steps 和「做完标准」（finishHint）。模板只是起点，注入时明确可跳步/加步/改向。
 * 2. 生命周期：active ↔ paused（搁置/继续）、改向（换题目不丢过程）、放弃（进 done
 *    标 abandoned，notes+artifacts 全保留——放下不等于删除）。
 * 3. 真实成果：artifacts 记录地盘内相对路径（stage/final），写入时逐一过 verifyArtifact
 *    （spaceGuard 包含性 + 存在 + 非空，宿主注入）。
 * 4. 作品情绪：mood 随收尾一句话入账（cap 8），不新建情绪系统。
 * 5. 完成硬闸：删掉「攒 4 笔自动完成」；完成只由她收尾时声明（【状态】完成），
 *    writing/collection 必须有校验通过的真实成果文件，否则拦下不收尾——
 *    没做出文件就不能声称完成了作品（主人 11-06 拍板：非空 + 地盘内）。
 * 6. 收尾协议 parseClose：【成果】路径、【状态】完成/搁置/放弃/继续/改向：新题、【心情】话，
 *    纯函数可测；clean 去标签后供旁白/记账，防止协议标记漏进她说出口的话。
 *
 * ── 兼容 ─────────────────────────────────────────────────────────
 * 旧 projects.json（v1 结构）load 时逐字段兜底：type→research、status→active、
 * artifacts/mood→[]、done 条目补 type/outcome。旧数据无损升级。
 */

const path = require('node:path')
const fs = require('node:fs')

const NOTE_CAP = 20
const DONE_CAP = 10
const TITLE_CAP = 24
const MOOD_CAP = 8
const ARTIFACT_CAP = 12

const TYPES = ['research', 'writing', 'collection', 'organize', 'conceive']
/** 选题加权（0.46.73 主人拍板「自主制作=做出来的东西」）：动手做的类型占大头——
 * 写作最重，构思/收藏次之，研究降为普通概率；整理偶尔来一次 */
const TYPE_WEIGHTS = { research: 2, writing: 3, collection: 2, organize: 1, conceive: 2 }
/** 需要「有真实作品文件」才能收尾的类型（0.46.73 构思也必须有落盘的构思文档） */
const NEEDS_FILE_TYPES = ['writing', 'collection', 'conceive']

/** 五类型模板：steps 只是默认起点，blockOf 注入时明确「可跳步/加步/改向」 */
const TYPE_TEMPLATES = {
  research: {
    label: '研究',
    steps: ['查资料弄明白它是什么', '把值得留的记进自己的笔记', '写一小段自己的看法收尾'],
    finishHint: '形成一段足以表达你自己认识的总结',
    craftHint: '用 space_append 把查到的东西记进你的笔记文件，最后把你自己的看法也写进去——记下来的才是你的',
    titleOf: (t) => '弄清楚「' + t + '」',
    whyOf: () => '前几天就对它有点好奇，一直没腾出整块时间',
    fallback: '把手头的好奇理一理',
    fallbackWhy: '最近冒出来的疑问攒了几个'
  },
  writing: {
    label: '写作',
    steps: ['想清楚要写什么、大概什么样', '动笔写出初稿，存进自己的地盘', '自己读一遍，改到觉得过得去'],
    finishHint: '完成一篇你自己觉得过得去的作品，真实存在地盘里',
    craftHint: '这场就真的动手写：space_write 开（或续）你自己的作品文件，把想说的话一段一段写进去——写出来的文字才是作品，光在心里打腹稿不算做',
    titleOf: (t) => '围绕「' + t + '」写点自己想写的',
    whyOf: () => '一直有个想写写看的念头',
    fallback: '写点最近想写的',
    fallbackWhy: '有些话攒着攒着就想落到纸面'
  },
  collection: {
    label: '收藏',
    steps: ['定下要收什么、什么才值得留', '把真正喜欢的存进自己的地盘', '按自己的方式分好类'],
    finishHint: '收出一册有组织、回头找得到东西的收藏',
    craftHint: '真的往地盘里存东西：space_write/space_append 把值得留的存进去、分好类——存进去的才算收藏',
    titleOf: (t) => '收一收「' + t + '」相关的宝贝',
    whyOf: () => '看到好东西总想留下来',
    fallback: '把喜欢的宝贝归一册',
    fallbackWhy: '存散了的东西该有一本自己的册子'
  },
  organize: {
    label: '整理',
    steps: ['盘点现状，看看都有些什么', '定个归置的路子', '动手归置到位'],
    finishHint: '原来乱的那堆东西真的归了位、找得到',
    craftHint: '真的动手归置：space_move/space_write 把地盘里的东西理到位——归完要看得出来变整齐了',
    titleOf: (t) => '把「' + t + '」理出个头绪',
    whyOf: () => '一直堆着的东西该理理了',
    fallback: '把手头的笔记理一理',
    fallbackWhy: '自己的地盘该收拾了'
  },
  conceive: {
    label: '构思',
    steps: ['把要构思的东西定下来', '铺开了想，不怕跑偏', '把成形的部分写下来存好'],
    finishHint: '写出一份能表达设计想法的构思说明',
    craftHint: '用 space_write 把脑子里的影子写成一份构思文档：想到哪写到哪，写成真东西才算构思过',
    titleOf: (t) => '构思「' + t + '」',
    whyOf: () => '脑子里有个模糊的影子，想让它清楚起来',
    fallback: '把脑子里的影子画出来',
    fallbackWhy: '有些想法还没成形，但值得铺开想想'
  }
}

const fileOf = (wsDir) => wsDir ? path.join(wsDir, 'projects.json') : ''

/* ── 旧数据兼容：逐字段兜底，v1 projects.json 无损读入 ── */

function normActive (a) {
  if (!a || typeof a !== 'object') return null
  if (!TYPES.includes(a.type)) a.type = 'research'
  const tpl = TYPE_TEMPLATES[a.type]
  if (a.status !== 'paused') a.status = 'active'
  if (!Array.isArray(a.steps) || !a.steps.length) a.steps = tpl.steps.slice()
  if (!Array.isArray(a.notes)) a.notes = []
  if (!Array.isArray(a.artifacts)) a.artifacts = []
  if (!Array.isArray(a.mood)) a.mood = []
  a.noteIdx = Number(a.noteIdx) || 0
  a.createdAt = Number(a.createdAt) || Date.now()
  a.updatedAt = Number(a.updatedAt) || Date.now()
  return a
}

function normDone (d) {
  if (!d || typeof d !== 'object') return null
  if (!TYPES.includes(d.type)) d.type = 'research'
  if (!Array.isArray(d.artifacts)) d.artifacts = []
  if (d.outcome !== 'abandoned') d.outcome = 'finished'
  d.finishedAt = Number(d.finishedAt) || Date.now()
  return d
}

function normalize (s) {
  const out = (s && typeof s === 'object') ? s : { active: null, done: [] }
  if (!Array.isArray(out.done)) out.done = []
  out.done = out.done.map(normDone).filter(Boolean).slice(0, DONE_CAP)
  out.active = out.active ? normActive(out.active) : null
  return out
}

function load (wsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsDir), 'utf8'))
    return normalize(raw)
  } catch { return { active: null, done: [] } }
}

function save (wsDir, state) {
  try {
    if (!fileOf(wsDir)) return false
    fs.writeFileSync(fileOf(wsDir), JSON.stringify(normalize(state)), 'utf8')
    return true
  } catch { return false }
}

/** 按加权随机挑类型，尽量避开上一个项目的类型（连续两单全是「查资料」就不像活人） */
function pickType (rand, lastType) {
  const r = typeof rand === 'function' ? rand : Math.random
  let pool = []
  for (const t of TYPES) { const w = TYPE_WEIGHTS[t] || 1; for (let i = 0; i < w; i++) pool.push(t) }
  if (TYPES.includes(lastType)) {
    const filtered = pool.filter((t) => t !== lastType)
    if (filtered.length) pool = filtered
  }
  return pool[Math.floor(r() * pool.length) % pool.length]
}

/** 立一个新项目：按类型套模板，theme 来自话题池（截断），可空 */
function newProject (theme, now, type) {
  const tp = TYPE_TEMPLATES[TYPES.includes(type) ? type : 'research']
  const t = String(theme || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_CAP)
  return {
    title: t ? tp.titleOf(t) : tp.fallback,
    why: t ? tp.whyOf(t) : tp.fallbackWhy,
    type: TYPES.includes(type) ? type : 'research',
    status: 'active',
    steps: tp.steps.slice(),
    noteIdx: 0,
    notes: [],
    artifacts: [],
    mood: [],
    pauseReason: '',
    createdAt: Number(now) || Date.now(),
    updatedAt: Number(now) || Date.now()
  }
}

/** 没有 active 就立新项目（选题来自 themes，避开 done[] 最近的主题；类型避开上一个的） */
function ensure (state, themes, now, rand) {
  const s = normalize(state)
  if (s.active) return s
  const avoid = (s.done || []).map((d) => d.title)
  const pool = (Array.isArray(themes) ? themes : [])
    .map((t) => String(t || '').trim())
    .map((t) => t.replace(/^#+\s*/, '').trim())   // 0.46.66 抓屏选题带进「# 搜索记录」这类 markdown 头，标题里不该有
    .filter((t) => t.length >= 2 && t.length <= 40)
  const theme = pool.find((t) => !avoid.some((a) => a.includes(t) || t.includes(a))) || pool[0] || ''
  const lastType = (s.done && s.done[0] && s.done[0].type) || ''
  s.active = newProject(theme, now, pickType(rand, lastType))
  return s
}

/**
 * 动机块：注入 runSpace/runFree 的 sys。没项目不出声。
 * v2：带类型/成果现状/做完标准/搁置态，以及收尾协议（【成果】【状态】【心情】）。
 */
function blockOf (state) {
  const a = state && state.active
  if (!a) return ''
  const tpl = TYPE_TEMPLATES[TYPES.includes(a.type) ? a.type : 'research']
  const lines = []
  if (a.status === 'paused') {
    lines.push('你有个搁置着的小项目：《' + a.title + '》（' + tpl.label + '）' +
      (a.pauseReason ? '——当时是「' + String(a.pauseReason).slice(0, 40) + '」' : '') + '。')
    lines.push('还感兴趣的话这次可以捡起来（收尾带【状态】继续），不感兴趣也随你，放着不丢人。')
  } else {
    lines.push('你有个进行中的小项目：《' + a.title + '》（' + tpl.label + '·' + a.why + '）。')
    const arts = Array.isArray(a.artifacts) ? a.artifacts : []
    if (arts.length) lines.push('你已经有这些成果：' + arts.map((x) => x.path).join('、') + '。')
    const step = a.steps[Math.min(a.noteIdx || 0, a.steps.length - 1)]
    lines.push('这次可以顺手推进它：' + step + '。不用一场做完，推进一点就行。')
    lines.push('想动手的话这场就真的动手做：' + tpl.craftHint + '。')
  }
  lines.push('可以跳过步骤、中途加步骤，觉得没意思了就换方向或者放下。这个项目「做完」的标准：' + tpl.finishHint + '。真到了才说做完；没做出真实文件，就不能说完成了作品。')
  lines.push('收尾时在最后带上这些标记（没有就都不带，别编）：这场写了或存了成果文件就加【成果】文件名（多个用、隔开，相对你地盘的路径）；这次想收尾就加【状态】完成；想放一放就【状态】搁置；彻底不要了就【状态】放弃；想换个方向就【状态】改向：新题目；搁置过的想捡回来就【状态】继续；有感触可以带一句【心情】一句话。')
  return lines.join('\n')
}

/** 活动收尾记一笔（有汇报才记）。只管 notes/noteIdx，生命周期在 recordLifecycle */
function note (state, line, now) {
  const s = normalize(state)
  const a = s.active
  const text = String(line || '').trim()
  if (!a || !text) return s
  a.notes = (a.notes || []).concat([text.slice(0, 200)]).slice(-NOTE_CAP)
  a.noteIdx = Math.min((a.noteIdx || 0) + 1, a.steps.length - 1)
  a.updatedAt = Number(now) || Date.now()
  return s
}

/**
 * 收尾协议解析（纯函数）：从收尾汇报里抽出【成果】/【状态】/【心情】，
 * 返回 { clean, artifacts, status, newTitle, mood }。clean 是去掉标记后的干净话——
 * 那才是她会说出口的部分，协议标记不能漏进旁白。
 */
function parseClose (text) {
  const raw = String(text || '')
  const out = { clean: raw.trim(), artifacts: [], status: '', newTitle: '', mood: '' }
  const re = /【(成果|状态|心情)】([^\n【】]*)/g
  let m
  while ((m = re.exec(raw))) {
    const val = String(m[2] || '').trim()
    if (m[1] === '成果') {
      for (const p of val.split(/[、,，;；]/)) {
        const q = p.trim().replace(/^[「『"']+|[」』"']+$/g, '')
        if (q && q.length <= 120 && out.artifacts.length < 8 && !out.artifacts.includes(q)) out.artifacts.push(q)
      }
    } else if (m[1] === '状态') {
      const mm = /^(完成|搁置|放弃|继续|改向)\s*[:：]?\s*(.*)$/.exec(val)
      if (mm) { out.status = mm[1]; out.newTitle = String(mm[2] || '').trim().slice(0, TITLE_CAP) }
    } else if (m[1] === '心情') {
      if (val && !out.mood) out.mood = val.slice(0, 60)
    }
  }
  if (out.artifacts.length || out.status || out.mood) {
    out.clean = raw.replace(/【(?:成果|状态|心情)】[^\n【】]*/g, '').replace(/[ \t]+$/gm, '').trim()
  }
  return out
}

/**
 * 收尾（纯函数，硬闸在这里）：完成由她声明，不由笔数攒出来。
 * writing/collection 必须至少有一个能过 verify 的真实成果文件（存在+非空+在地盘内）；
 * research/conceive/organize 允许以总结收尾（有的类型成果本来就不是文件）。
 * @returns {{state, finished, blocked}} blocked=被硬闸拦下的原因（空串=没拦）
 */
function finishProject (s, t, verify) {
  const a = s && s.active
  if (!a) return { state: s, finished: null, blocked: '' }
  if (NEEDS_FILE_TYPES.includes(a.type)) {
    const arts = Array.isArray(a.artifacts) ? a.artifacts : []
    if (!arts.length) return { state: s, finished: null, blocked: a.type + ' 收尾必须有真实成果文件' }
    if (typeof verify !== 'function') return { state: s, finished: null, blocked: '没有成果校验器，不许收尾' }
    let ok = false
    for (const f of arts) { if (verify(f.path)) { ok = true; break } }
    if (!ok) return { state: s, finished: null, blocked: '成果文件校验没过（不存在/空文件/不在地盘）' }
  }
  const notes = Array.isArray(a.notes) ? a.notes : []
  const last = notes.length ? notes[notes.length - 1] : ''
  const finished = {
    title: a.title,
    type: a.type,
    summary: String(last).slice(0, 160),
    artifacts: (Array.isArray(a.artifacts) ? a.artifacts : []).slice(),
    outcome: 'finished',
    finishedAt: Number(t) || Date.now()
  }
  s.done = [finished].concat(s.done || []).slice(0, DONE_CAP)
  s.active = null
  return { state: s, finished, blocked: '' }
}

/** 搁置：不是删除，notes/artifacts 全保留，理由留在 pauseReason */
function pauseProject (s, reason, t) {
  const a = s && s.active
  if (!a) return s
  a.status = 'paused'
  a.pauseReason = String(reason || '').slice(0, 60)
  a.updatedAt = Number(t) || Date.now()
  return s
}

/** 捡回来 */
function resumeProject (s, t) {
  const a = s && s.active
  if (!a) return s
  a.status = 'active'
  a.pauseReason = ''
  a.updatedAt = Number(t) || Date.now()
  return s
}

/** 改向：换题目重铺步骤，过程全保留 */
function redirectProject (s, newTitle, t) {
  const a = s && s.active
  if (!a) return s
  const tpl = TYPE_TEMPLATES[TYPES.includes(a.type) ? a.type : 'research']
  const old = a.title
  a.title = String(newTitle || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_CAP) || a.title
  a.why = '《' + old + '》做到一半换了方向'
  a.steps = tpl.steps.slice()
  a.noteIdx = 0
  a.status = 'active'
  a.pauseReason = ''
  a.updatedAt = Number(t) || Date.now()
  return s
}

/** 放弃：进 done 标 abandoned（搁置不等于删除，过程和成果全保留） */
function abandonProject (s, t) {
  const a = s && s.active
  if (!a) return { state: s, abandoned: null }
  const notes = Array.isArray(a.notes) ? a.notes : []
  const abandoned = {
    title: a.title,
    type: a.type,
    summary: String(notes.length ? notes[notes.length - 1] : '').slice(0, 160),
    artifacts: (Array.isArray(a.artifacts) ? a.artifacts : []).slice(),
    outcome: 'abandoned',
    finishedAt: Number(t) || Date.now()
  }
  s.done = [abandoned].concat(s.done || []).slice(0, DONE_CAP)
  s.active = null
  return { state: s, abandoned }
}

/**
 * 一场活动收尾的全过程（纯函数）：记 notes → 落 artifacts（逐个过校验）→ 记 mood →
 * 按【状态】走生命周期。io.verify(relPath)→bool 由宿主注入（spaceGuard+存在+非空）。
 * @returns {{state, finished, abandoned, event, blocked}}
 */
function recordLifecycle (s, line, pc, t, io, log) {
  s = note(s, line, t)
  const a = s.active
  const out = { state: s, finished: null, abandoned: null, event: '', blocked: '' }
  if (!a) return out
  const verify = (io && typeof io.verify === 'function') ? io.verify : null
  // 成果落账：路径必须过校验（不在地盘/文件空/不存在的一律不记，也不许拿来收尾）
  for (const rel of ((pc && pc.artifacts) || [])) {
    if ((a.artifacts || []).some((x) => x.path === rel)) continue
    if (!verify || !verify(rel)) {
      if (log) log('[projects] 成果路径没过校验（不在地盘/不存在/空文件），不入账：' + rel)
      continue
    }
    a.artifacts.push({ path: rel, kind: (pc && pc.status === '完成') ? 'final' : 'stage', at: t })
    if (a.artifacts.length > ARTIFACT_CAP) a.artifacts = a.artifacts.slice(-ARTIFACT_CAP)
  }
  if (pc && pc.mood) {
    a.mood = (a.mood || []).concat([{ at: t, feeling: pc.mood }]).slice(-MOOD_CAP)
  }
  a.updatedAt = t
  const status = pc && pc.status
  if (status === '搁置') {
    pauseProject(s, (pc.clean || line || '').slice(0, 60), t)
    out.event = '搁置'
  } else if (status === '继续') {
    resumeProject(s, t)
    out.event = '继续'
  } else if (status === '改向') {
    if (pc.newTitle) { redirectProject(s, pc.newTitle, t); out.event = '改向' }
  } else if (status === '放弃') {
    const r = abandonProject(s, t)
    out.state = r.state
    out.abandoned = r.abandoned
    out.event = '放弃'
  } else if (status === '完成') {
    const r = finishProject(s, t, verify)
    if (r.finished) {
      out.state = r.state
      out.finished = r.finished
      out.event = '完成'
    } else {
      out.blocked = r.blocked
      if (log) log('[projects] 想收尾但被硬闸拦下（' + r.blocked + '）：《' + a.title + '》')
    }
  }
  return out
}

/** 调试/状态面板 */
function statusOf (state) {
  const s = normalize(state)
  const a = s.active
  return {
    active: a ? {
      title: a.title, type: a.type, status: a.status,
      notes: (a.notes || []).length, artifacts: (a.artifacts || []).length,
      updatedAt: Number(a.updatedAt) || 0,        // 0.46.65 quiet 轨「项目搁浅」驱动用
      paused: a.status === 'paused',
      pauseReason: String(a.pauseReason || '')
    } : null,
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
  /** 0.46.71 写向钩子：项目状态有变化就通知宿主同步「莱莎这边的进展.md」（d.onSync） */
  function emitSync () {
    if (typeof d.onSync === 'function') { try { d.onSync(state) } catch { } }
  }

  return {
    /** 没有 active 就立新项目；返回注入块。开题走 onEvent 进记忆 */
    block (themes) {
      ensureState()
      const had = !!state.active
      ensure(state, themes, now(), d.rand)
      commit()
      if (!had && state.active && typeof d.onEvent === 'function') {
        try { d.onEvent('开题', state.active.title) } catch { }
      }
      if (!had && state.active) emitSync()
      return blockOf(state)
    },
    /**
     * 一场活动收尾：parsed=parseClose 的结果（可空，内部会补解析）。
     * opts.spaceDir=这场活动的地盘目录（成果校验的基准）。
     * 返回 { finished, abandoned, event, blocked }（都可为空）。
     * 完成/放弃/改向/搁置走 onEvent 进记忆（带日期锚点，addEvent 内部锚定）。
     */
    record (line, parsed, opts) {
      ensureState()
      const pc = (parsed && typeof parsed === 'object') ? parsed : parseClose(line)
      const sp = String((opts && opts.spaceDir) || '')
      const r = recordLifecycle(state, pc.clean || line, pc, now(), {
        verify: (rel) => (typeof d.verifyArtifact === 'function') ? !!d.verifyArtifact(sp, rel) : false
      }, log)
      commit()
      if (r.finished) log('[projects] 项目收尾：《' + r.finished.title + '》')
      if (r.abandoned) log('[projects] 项目放弃：《' + r.abandoned.title + '》')
      if (r.event) log('[projects] 项目' + r.event + '：现在《' + (state.active ? state.active.title : '（已收）') + '》')
      if (r.event && r.event !== '继续' && typeof d.onEvent === 'function') {
        const title = r.finished ? r.finished.title : (r.abandoned ? r.abandoned.title : (state.active ? state.active.title : ''))
        try { if (title) d.onEvent(r.event, title) } catch { }
      }
      // 0.46.72 作品交付：真完成（硬闸过了、有真实成果文件）→ 通知宿主送到主人看得见的地方
      if (r.finished && typeof d.onDeliver === 'function') {
        try { d.onDeliver(r.finished, sp) } catch { }
      }
      emitSync()
      return r
    },
    /** 0.46.71 宿主启动时回填一次进展笔记（否则要等到下一场活动才有文件） */
    sync () { ensureState(); emitSync() },
    /** 搁置/放弃项目的未竟方向，供选题池尾部（goals 仍是最高优先） */
    extras () {
      ensureState()
      const out = []
      if (state.active && state.active.status === 'paused') {
        out.push('把搁置的《' + state.active.title + '》捡起来看看还想不想做')
      }
      for (const dn of (state.done || []).slice(0, 2)) {
        if (dn.outcome === 'abandoned') out.push('《' + dn.title + '》当时放着了，现在有新想法可以换个弄法')
      }
      return out
    },
    reset () { state = null },
    status () { return statusOf(ensureState()) }
  }
}

module.exports = {
  NOTE_CAP, DONE_CAP, TITLE_CAP, MOOD_CAP, ARTIFACT_CAP,
  TYPES, TYPE_WEIGHTS, NEEDS_FILE_TYPES, TYPE_TEMPLATES,
  load, save, normalize, pickType, newProject, ensure, blockOf, note, parseClose,
  finishProject, pauseProject, resumeProject, redirectProject, abandonProject,
  recordLifecycle, statusOf, create
}
