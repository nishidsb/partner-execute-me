'use strict'
/**
 * 0.46.71 共同创作「写向」：之前只有 read_project_note（她读主人写的共享笔记），
 * 单向的——主人问「为什么不能根据她做过的自动写」之后补的这一半。
 * 把 projects.json 的真实状态渲染成 markdown，写到共享目录里的「莱莎这边的进展.md」：
 * 每次 block() 立新项目、record() 一场收尾、宿主启动回填时整份重写（幂等，不追加）。
 * 主人写的原笔记永远不会被这边碰——写向只落自己的文件。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 写向文件上限：进展笔记没必要大，防 done 堆多后写爆 */
const CAP = 8 * 1024

function fmt (at) {
  try { return new Date(at).toLocaleString('zh-CN', { hour12: false }) } catch { return String(at || '') }
}

/** 纯函数渲染：state=projects.json 的内存态（{active, done}），返回 markdown 文本 */
function render (state) {
  const s = state || {}
  const lines = []
  lines.push('# 莱莎这边的进展（自动更新）', '')
  lines.push('> 这份是莱莎自己维护的，项目每有动静就整份重写。主人的那份《给莱莎看的项目进展.md》她每次自主活动都会读、有话也直接回在那份里，做完的作品会放到旁边「莱莎的作品」文件夹。', '')
  const a = s.active
  if (a) {
    lines.push('## 正在做：《' + a.title + '》', '')
    const bits = ['类型：' + (a.type || '?')]
    if (a.status === 'paused') bits.push('状态：暂时搁下' + (a.pauseReason ? '（' + a.pauseReason + '）' : ''))
    bits.push('最近动静：' + fmt(a.updatedAt))
    lines.push('- ' + bits.join('｜'))
    if (a.why) lines.push('- 为什么做：' + a.why)
    const notes = (a.notes || []).slice(-3)
    if (notes.length) {
      lines.push('- 最近的记录：')
      for (const n of notes) lines.push('  - ' + String(n || '').slice(0, 120))
    }
    lines.push('')
  } else {
    lines.push('## 正在做：（暂时没有开着的项目）', '')
  }
  const done = (s.done || []).slice(0, 5)
  if (done.length) {
    lines.push('## 之前做过的', '')
    for (const d of done) {
      const tag = d.outcome === 'abandoned' ? '放着了' : '做完了'
      lines.push('- 《' + d.title + '》｜' + tag + '｜' + fmt(d.finishedAt))
      if (d.summary) lines.push('  - ' + String(d.summary).slice(0, 120))
    }
    lines.push('')
  }
  lines.push('（最后更新：' + fmt(Date.now()) + '）')
  return lines.join('\n')
}

/**
 * 落盘：cocreate 没开 / 没配共享笔记就不写（返回 false）。
 * 输出路径默认 = 共享笔记同目录「莱莎这边的进展.md」，可用 cocreate.outFile 覆盖。
 * 失败一律 log 留痕（0.46.5x 教训：静默失败必须留痕），绝不 throw。
 */
function write (state, cocreateCfg, log) {
  const cc = cocreateCfg || {}
  if (cc.on !== true || !cc.file) return false
  const out = cc.outFile || path.join(path.dirname(String(cc.file)), '莱莎这边的进展.md')
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    let body = render(state)
    if (Buffer.byteLength(body) > CAP) body = body.slice(0, CAP)
    fs.writeFileSync(out, body)
    if (log) log('[projects] 进展笔记已更新 → ' + out)
    return true
  } catch (e) {
    if (log) log('[projects] 进展笔记写入失败: ' + (e && e.message))
    return false
  }
}

/* ── 0.46.72 共同创作真正的「共同」：她能往共享笔记里写字 ──
 * 主人 22:44 拍板：「他不能写算什么共同创作」——只读窗不算共同创作。
 * 两条铁律：①只追加（append-only），他写的字一个都不许动；②cocreate 没开一律拒绝。 */

/** 追加上限：单次 4KB；文件超过 512KB 就拒绝（提示该归档了，不许无限膨胀） */
const APPEND_MAX = 4 * 1024
const NOTE_FILE_MAX = 512 * 1024

/**
 * 往共享笔记末尾追加一段她的话（署名+时间戳）。返回给 LLM 工具的话术（成功/拒绝都如实说）。
 * append-only：fs.appendFile，他原有的内容物理上碰不到。
 */
function appendNote (cocreateCfg, text, log) {
  const cc = cocreateCfg || {}
  const file = String(cc.file || '').trim()
  if (cc.on !== true || !file) return '他还没在设置里开放共同创作，写不了。别问，也别猜他项目的事。'
  const body = String(text || '').trim()
  if (!body) return '想写的内容是空的，没写。'
  let st
  try { st = fs.statSync(file) } catch { return '共享笔记现在读不到（还没写好或挪走了），写不了。如实说，别装作写过了。' }
  if (!st.isFile()) return '共享笔记路径不是个文件，写不了。'
  if (st.size > NOTE_FILE_MAX) return '共享笔记太大了（超过 512KB），追加不进去。可以在话里跟他说一声该归档了。'
  let piece = body
  if (Buffer.byteLength(piece) > APPEND_MAX) piece = piece.slice(0, APPEND_MAX)
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
  const line = '\n\n---\n**莱莎**（' + stamp + '）：\n' + piece + '\n'
  try {
    fs.appendFileSync(file, line)
    if (log) log(path.basename(file) + ' +' + Buffer.byteLength(line) + 'B')
    return '已追加到共享笔记末尾（署名莱莎）。他写的内容没动。'
  } catch (e) {
    if (log) log('追加失败: ' + (e && e.message))
    return '写失败了（' + (e && e.message) + '）。如实说，别装作写过了。'
  }
}

/**
 * 作品交付：项目真完成时，把她的成果文件从她的地盘**复制**（不动原件）到共享目录
 * 「莱莎的作品/」下，并在共享笔记里追加一条带文件名的说明——
 * 「角色不能自己做东西算什么自主制作」：做是一直有的（成果硬闸），缺的是让主人看得见。
 * guard=spaceGuard（abs 必须还在她地盘内才许复制）；cocreate 没开就不送，作品仍在她地盘里。
 * @returns {string|null} 追加进笔记的说明文字（没送成/没开返回 null）
 */
function deliverArtifacts (finished, spaceDir, cocreateCfg, guard, log) {
  const cc = cocreateCfg || {}
  if (cc.on !== true || !cc.file) return null
  const f = finished || {}
  const arts = (Array.isArray(f.artifacts) ? f.artifacts : []).slice(0, 5)
  if (!arts.length || !spaceDir || typeof guard !== 'function') return null
  const outDir = path.join(path.dirname(String(cc.file).trim()), '莱莎的作品')
  const names = []
  for (const art of arts) {
    const rel = String((art && art.path) || '')
    const abs = guard(spaceDir, rel)
    if (!abs) { if (log) log('作品越界跳过：' + rel); continue }
    let content
    try { content = fs.readFileSync(abs) } catch (e) { if (log) log('作品读不到跳过：' + rel + ' ' + (e && e.message)); continue }
    if (!content.length) { if (log) log('作品是空的跳过：' + rel); continue }
    // 文件名带项目标题前缀防撞车；非法字符清掉
    const base = path.basename(rel).replace(/[\\/:*?"<>|]/g, '_')
    const tag = String(f.title || '').replace(/[\\/:*?"<>|#\n]/g, '').trim().slice(0, 20)
    const name = (tag ? tag + ' - ' : '') + base
    try {
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, name), content)
      names.push('莱莎的作品/' + name)
    } catch (e) {
      if (log) log('作品复制失败：' + rel + ' ' + (e && e.message))
    }
  }
  if (!names.length) return null
  const msg = '《' + String(f.title || '').slice(0, 60) + '》做完了，作品放在：' + names.join('、')
  try { fs.appendFileSync(String(cc.file).trim(), '\n\n---\n**莱莎**（' + new Date().toLocaleString('zh-CN', { hour12: false }) + '）：\n' + msg + '\n') } catch { }
  if (log) log('[projects] 作品已交付 → ' + outDir + '（' + names.length + ' 件）')
  return msg
}

module.exports = { render, write, appendNote, deliverArtifacts, CAP, APPEND_MAX, NOTE_FILE_MAX }
