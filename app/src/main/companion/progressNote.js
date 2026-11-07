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
  lines.push('> 这份是莱莎自己维护的，项目每有动静就整份重写。主人写的那份《给莱莎看的项目进展.md》她每次自主活动都会现读——两份互不干扰。', '')
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

module.exports = { render, write, CAP }
