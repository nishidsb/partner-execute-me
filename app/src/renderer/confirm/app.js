/**
 * 电脑操作确认窗渲染层：按钮 + 记住勾选 + 倒计时。
 * 倒计时到 0 由主进程兜底关闭（这里只是给用户看的进度，不负责拒绝逻辑）。
 */
const $ = (id) => document.getElementById(id)
const api = window.confirmAPI
let payload = null
let ticker = null

function render (p) {
  payload = p
  $('msg').textContent = p.message || '角色想操作你的电脑'
  $('detail').textContent = p.detail || ''
  $('icon').textContent = p.icon === 'warning' ? '!' : '?'
  $('icon').className = 'badge' + (p.icon === 'warning' ? ' warning' : '')
  $('rememberRow').hidden = !p.rememberLabel
  $('rememberLabel').textContent = p.rememberLabel || ''
  $('remember').checked = false

  // 带图确认：把截图直接摆出来，用户看得到才敢点「发送」
  const wrap = $('shotWrap')
  if (p.image) {
    $('shot').src = p.image
    wrap.hidden = false
    // 图占主要版面，文字说明缩成固定高度
    $('detail').style.flex = '0 0 auto'
    $('detail').style.maxHeight = '76px'
  } else {
    $('shot').removeAttribute('src')
    wrap.hidden = true
    $('detail').style.flex = ''
    $('detail').style.maxHeight = ''
  }

  const box = $('buttons')
  box.innerHTML = ''
  const btns = p.buttons || ['允许', '拒绝']
  // 哪些按钮带「记住」语义由主进程指定（例如「30 分钟内都允许」）
  const rememberAt = Number.isFinite(Number(p.rememberIndex)) ? Number(p.rememberIndex) : -1
  btns.forEach((label, i) => {
    const b = document.createElement('button')
    b.textContent = label
    b.dataset.index = String(i)
    if (i === 0) b.className = 'primary'
    else if (i === btns.length - 1) b.className = 'danger'
    b.addEventListener('click', () => answer(i, i === rememberAt || $('remember').checked))
    box.appendChild(b)
  })

  const total = Math.max(1000, Number(p.timeoutMs) || 60000)
  const begin = Date.now()
  if (ticker) clearInterval(ticker)
  ticker = setInterval(() => {
    const left = Math.max(0, total - (Date.now() - begin))
    $('countdown').textContent = Math.ceil(left / 1000) + 's'
    $('barFill').style.width = (left / total) * 100 + '%'
    if (left <= 0) { clearInterval(ticker); ticker = null }
  }, 200)
}

function answer (index, remember) {
  if (!payload) return
  const p = payload
  payload = null
  if (ticker) { clearInterval(ticker); ticker = null }
  try { api.answer({ index, remember: remember || $('remember').checked }) } catch {}
  // 主进程会隐藏窗口；这里不用自己关，避免连点两下
  void p
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') answer(-1, false)
  if (e.key === 'Enter') answer(0, false)
})

api.onPayload(render)
window.addEventListener('beforeunload', () => { if (ticker) clearInterval(ticker) })
