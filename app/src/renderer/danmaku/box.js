'use strict'
/**
 * 弹幕框（0.38.0）：攒着最近几句，新的一直在最下面
 *
 * 锁着的时候整窗穿透（鼠标直接给游戏），所以框上不放假按钮——
 * 解锁只能靠组合键或设置页，这一点跟参考项目的取舍一致。
 */
;(function () {
  const list = document.getElementById('list')
  const hint = document.getElementById('hint')
  const who = document.getElementById('who')
  const MAX_ROWS = 40
  const zh = String(navigator.language || '').toLowerCase().indexOf('zh') === 0

  if (!zh) { who.textContent = 'Her'; hint.textContent = 'Alt+H to unlock' }

  function hhmm () {
    const d = new Date()
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }

  function appendRow (text, opts) {
    const row = document.createElement('div')
    row.className = 'row'
    const t = document.createElement('span')
    t.className = 't'
    t.textContent = (opts && opts.time) || hhmm()
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = text
    row.appendChild(t)
    row.appendChild(x)
    list.appendChild(row)
    while (list.children.length > MAX_ROWS) list.removeChild(list.firstChild)
    // 用户手动往上翻过就别硬拉回来（不然看不到历史）
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60
    if (nearBottom) list.scrollTop = list.scrollHeight
  }

  function setLock (locked) {
    document.body.classList.toggle('locked', !!locked)
    if (zh) hint.textContent = locked ? 'Alt+H 解锁' : '拖动我 · Alt+H 锁上'
    else hint.textContent = locked ? 'Alt+H to unlock' : 'Drag me · Alt+H to lock'
  }

  window.dk.onLines((lines) => {
    if (!Array.isArray(lines)) return
    for (const l of lines) {
      const s = String(l || '').trim()
      if (s) appendRow(s)
    }
  })

  window.dk.onReplace((t) => {
    const s = String(t || '').trim()
    if (!s) return
    const last = list.lastElementChild
    if (last && last.lastElementChild) last.lastElementChild.textContent = s
  })

  window.dk.onLock(setLock)
})()
