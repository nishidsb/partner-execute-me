/**
 * 助手聊天窗渲染层：会话式交互（区别于 legacy companion 的单流聊天）。
 * - 角色下拉即时切换（每个角色独立会话/历史/记忆）
 * - 流式回复 + 工具调用可视化
 * - 记忆面板：查看/添加/删除长期记忆（下一轮对话自动检索注入）
 * - 模型配置内联（或从旧版伴侣导入凭据）
 */
const $ = (id) => document.getElementById(id)
const api = window.assistantAPI

let state = { roles: [], currentRole: 'assistant', provider: null }
let generating = false
let buf = ''
let pendingAi = null

/* ---------------- 消息渲染 ---------------- */
function addMsg (role, text, { who, cls } = {}) {
  const el = document.createElement('div')
  el.className = 'msg ' + (role === 'user' ? 'user' : 'ai') + (cls ? ' ' + cls : '')
  if (role !== 'user' && who) {
    const w = document.createElement('span')
    w.className = 'who'
    w.textContent = who
    el.appendChild(w)
  }
  el.appendChild(document.createTextNode(text))
  $('chat').appendChild(el)
  $('chat').scrollTop = $('chat').scrollHeight
  return el
}
function addSys (text) {
  const el = document.createElement('div')
  el.className = 'sysline'
  el.textContent = text
  $('chat').appendChild(el)
}

/* ---------------- 状态加载 ---------------- */
async function refreshState () {
  state = await api.state()
  const sel = $('roleSel')
  sel.innerHTML = ''
  for (const r of state.roles) {
    const o = document.createElement('option')
    o.value = r.id
    o.textContent = r.name + (r.builtin ? '' : ' *')
    sel.appendChild(o)
  }
  sel.value = state.currentRole
  const cur = state.roles.find((r) => r.id === state.currentRole)
  $('roleDesc').textContent = cur ? (cur.persona || '通用助手（无人设）') : ''
  renderProvider(state.provider)
}

function renderProvider (p) {
  if (!p) return
  $('mBase').value = p.baseUrl || ''
  $('mModel').value = p.model || ''
  $('mKey').value = p.apiKey || ''
  // 1.4：温度留空 = 不发该参数（推理模型拒绝它）；想固定就显式填数字
  $('mTemp').value = p.temperature != null ? p.temperature : ''
}

async function loadHistory () {
  $('chat').innerHTML = ''
  const h = await api.history()
  if (h && h.error) { addSys('加载历史失败: ' + h.error); return }
  if (!h || !h.length) { addSys('（新会话——和 ' + roleName() + ' 说点什么吧）'); return }
  const who = roleName()
  for (const m of h.slice(-60)) addMsg(m.role === 'user' ? 'user' : 'ai', m.content, { who })
}

const roleName = () => {
  const r = state.roles.find((x) => x.id === state.currentRole)
  return r ? r.name : state.currentRole
}

/* ---------------- 发送与流式 ---------------- */
// 1.10 聊天发图：≤8 张，dataURL 在本地暂存，随消息一起发（模型读不了图时核心会自动降级重试）
const pendingImages = []
function renderImgStrip () {
  const strip = $('imgStrip')
  strip.innerHTML = ''
  strip.hidden = !pendingImages.length
  pendingImages.forEach((d, i) => {
    const wrap = document.createElement('span')
    wrap.className = 'img-thumb'
    const img = document.createElement('img')
    img.src = d
    const x = document.createElement('button')
    x.textContent = '×'
    x.addEventListener('click', () => { pendingImages.splice(i, 1); renderImgStrip() })
    wrap.appendChild(img)
    wrap.appendChild(x)
    strip.appendChild(wrap)
  })
  $('btnImg').textContent = pendingImages.length ? `🖼${pendingImages.length}` : '🖼'
}

$('btnImg').addEventListener('click', () => $('imgInput').click())
$('imgInput').addEventListener('change', () => {
  const files = [...($('imgInput').files || [])]
  $('imgInput').value = ''
  for (const f of files) {
    if (pendingImages.length >= 8) { addSys('最多 8 张图片'); break }
    if (f.size > 8 * 1024 * 1024) { addSys(`图片过大（超过 8MB）：${f.name}`); continue }
    const rd = new FileReader()
    rd.onload = () => { pendingImages.push(String(rd.result)); renderImgStrip() }
    rd.readAsDataURL(f)
  }
})

async function doSend () {
  const v = $('input').value.trim()
  if ((!v && !pendingImages.length) || generating) return
  const imgs = pendingImages.splice(0, pendingImages.length)
  renderImgStrip()
  $('input').value = ''
  autoGrow()
  addMsg('user', v + (imgs.length ? (v ? ' ' : '') + `[图片×${imgs.length}]` : ''))
  generating = true
  setRunState(true)
  buf = ''
  typer.reset()
  pendingAi = addMsg('ai', '', { who: roleName(), cls: 'typing' })
  $('btnSend').disabled = true
  const r = await api.send(v, imgs)
  if (!r || r.ok === false) {
    generating = false
    setRunState(false)
    pendingAi.classList.remove('typing')
    if (r && r.error) pendingAi.textContent = '⚠ ' + r.error
    $('btnSend').disabled = false
  }
  // 成功路径由 assistant:done 事件收尾
}

// 0.45.14 流式打字机：增量进队列小步排出（首口立即、句末换气），不再整段糊上屏。
// typewriter.js 没加载（测试 stub 环境）时退化为「收到即上屏」的旧路径。
const TyperMod = window.RyzaTyper || {
  create: (o) => {
    const setText = (o && o.setText) || function () {}
    return { push: (t) => setText(String(t || '')), finish: (f) => { if (f != null) setText(String(f)) }, reset: () => setText(''), get text () { return '' } }
  }
}
const typer = TyperMod.create({
  setText: (t) => {
    if (pendingAi && pendingAi.childNodes[1]) {
      pendingAi.childNodes[1].textContent = t
      $('chat').scrollTop = $('chat').scrollHeight
    }
  }
})

api.onDelta(({ text, reset }) => {
  if (reset) {
    buf = ''
    typer.reset()
    // 本轮不是本窗发起的（例如在伙伴气泡里说的）→ 也要在本窗实时补上一条
    if (!pendingAi) pendingAi = addMsg('ai', '', { who: roleName(), cls: 'typing' })
    pendingAi.classList.add('typing')
  }
  buf += text
  typer.push(text)
})

/* 0.46.61 化妆性工具不进聊天窗：pet_act/pet_say 这些是「她在做动作」，不是信息。
   用户 11-06 反馈「pet_act 这些不需要显示」——工具条和已调用标注都跳过。 */
const COSMETIC_TOOL = /^pet_/i
const isCosmeticTool = (n) => COSMETIC_TOOL.test(String(n || ''))

api.onTool(({ name }) => {
  if (isCosmeticTool(name)) return
  const chip = $('toolchip')
  chip.hidden = false
  chip.textContent = '⚙ ' + roleName() + ' 正在调用工具 ' + name + ' …'
})

api.onDone(({ content, toolResults }) => {
  generating = false
  setRunState(false)
  refreshConsole()
  $('toolchip').hidden = true
  $('btnSend').disabled = false
  const finalText = content || buf || '（空回复）'
  typer.finish(finalText)
  if (pendingAi) {
    pendingAi.classList.remove('typing')
    pendingAi.childNodes[1].textContent = finalText
    if (toolResults && toolResults.length) {
      const visible = toolResults.filter((t) => !isCosmeticTool(t.name))
      if (visible.length) {
        const note = document.createElement('span')
        note.className = 'toolnote'
        note.textContent = '⚙ 已调用工具: ' + visible.map((t) => t.name).join(', ')
        pendingAi.appendChild(note)
      }
    }
  } else if (finalText) {
    addMsg('ai', finalText, { who: roleName() })
  }
  pendingAi = null
  $('chat').scrollTop = $('chat').scrollHeight
})

api.onError(({ message }) => {
  generating = false
  setRunState(false)
  $('toolchip').hidden = true
  $('btnSend').disabled = false
  if (pendingAi) {
    pendingAi.classList.remove('typing')
    pendingAi.childNodes[1].textContent = '⚠ ' + message
  } else {
    addMsg('ai', '⚠ ' + message, { who: roleName() })
  }
  pendingAi = null
})

/* ---------------- 输入框 ---------------- */
function autoGrow () {
  const el = $('input')
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}
$('input').addEventListener('input', autoGrow)
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    doSend()
  }
})
$('btnSend').addEventListener('click', doSend)

/* ---------------- 角色切换/新建/删除 ---------------- */
$('roleSel').addEventListener('change', async () => {
  const r = await api.switchRole($('roleSel').value)
  if (r && r.ok) {
    state.currentRole = r.currentRole
    $('roleDesc').textContent = (state.roles.find((x) => x.id === r.currentRole) || {}).persona || '通用助手（无人设）'
    await loadHistory()
    addSys('已切换到「' + roleName() + '」（独立的会话与记忆）')
  }
})

$('btnNewRole').addEventListener('click', () => { $('rolePanel').hidden = !$('rolePanel').hidden; $('memPanel').hidden = true; $('modelPanel').hidden = true; $('cuaPanel').hidden = true; $('actPanel').hidden = true })

$('rSave').addEventListener('click', async () => {
  const id = $('rId').value.trim().toLowerCase().replace(/[^\w-]/g, '')
  if (!id) { $('roleMsg').textContent = '需要角色 ID'; return }
  const r = await api.saveRole({
    id, name: $('rName').value.trim() || id,
    persona: $('rPersona').value.trim(),
    replyLang: $('rLang').value
  })
  if (r.ok) {
    $('roleMsg').textContent = '已创建'
    $('rId').value = $('rName').value = $('rPersona').value = ''
    await refreshState()
    setTimeout(() => { $('rolePanel').hidden = true }, 500)
  } else {
    $('roleMsg').textContent = '失败: ' + r.error
  }
})
$('roleClose').addEventListener('click', () => { $('rolePanel').hidden = true })

/* ---------------- 记忆面板 ---------------- */
async function refreshMem () {
  $('memRole').textContent = roleName()
  const facts = await api.memoryList(state.currentRole)
  const ul = $('memList')
  ul.innerHTML = ''
  if (!facts.length) { addMemEmpty(); return }
  for (const f of facts) {
    const li = document.createElement('li')
    const txt = document.createElement('div')
    txt.className = 'txt'
    txt.textContent = f.text
    const at = document.createElement('span')
    at.className = 'at'
    at.textContent = new Date(f.at).toLocaleString()
    txt.appendChild(at)
    const del = document.createElement('button')
    del.className = 'del'
    del.textContent = '✕'
    del.title = '删除这条记忆'
    del.addEventListener('click', async () => {
      await api.memoryRemove(state.currentRole, f.id)
      refreshMem()
    })
    li.appendChild(txt)
    li.appendChild(del)
    ul.appendChild(li)
  }
}
function addMemEmpty () {
  const li = document.createElement('li')
  li.textContent = '（暂无记忆——添加后每轮对话自动检索相关条目注入）'
  $('memList').appendChild(li)
}

$('btnMemory').addEventListener('click', () => { $('memPanel').hidden = !$('memPanel').hidden; $('modelPanel').hidden = true; $('rolePanel').hidden = true; $('cuaPanel').hidden = true; $('actPanel').hidden = true; if (!$('memPanel').hidden) refreshMem() })
$('memClose').addEventListener('click', () => { $('memPanel').hidden = true })
$('memAddBtn').addEventListener('click', async () => {
  const t = $('memInput').value.trim()
  if (!t) return
  await api.memoryAdd(state.currentRole, t)
  $('memInput').value = ''
  refreshMem()
})
$('memInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('memAddBtn').click() })

/* ---------------- 动作测试面板（0.45.37） ----------------
   手动点播动作词，走主进程 petBridge pet_act 同一条链路（坐/站照样接持续姿态）。
   只做验证入口，平时动作仍由她自己决定。 */
const ACT_WORDS = [
  // 姿态类（持续）
  '坐下', '站起来',
  // 语义池代表词
  '挥手', '打招呼', '万岁', '加油', '跳', '蹲下', '躺下', '转圈',
  // 官方硬映射
  '睡觉', '坐地上', '说吧'
]
function renderActGrid (words) {
  const grid = $('actGrid')
  grid.innerHTML = ''
  for (const w of words) {
    const b = document.createElement('button')
    b.className = 'act-btn'
    b.textContent = w
    b.addEventListener('click', () => playAct([w]))
    grid.appendChild(b)
  }
}
renderActGrid(ACT_WORDS)
$('actClose').addEventListener('click', () => { $('actPanel').hidden = true })
// 0.45.87 打开面板时动态拉 motions/ 目录的全部 VRMA 动作词（含待机池里的鼓掌/思考/看手机等），
// 与官方词合并去重——动作加了不用改代码，面板自动跟上。
$('btnAct').addEventListener('click', async () => {
  const p = $('actPanel')
  p.hidden = !p.hidden
  $('memPanel').hidden = true
  $('modelPanel').hidden = true
  $('rolePanel').hidden = true
  $('cuaPanel').hidden = true
  if (!p.hidden) {
    try {
      const r = await api.petListActs()
      if (r && r.ok) {
        const merged = [...new Set([...(r.vrma || []), ...ACT_WORDS, ...(r.builtin || [])])]
        renderActGrid(merged)
      }
    } catch { }
  }
})
async function playAct (words) {
  $('actMsg').textContent = '播放中：' + words.join('、')
  try {
    const r = await api.petAct(words)
    $('actMsg').textContent = r && r.error ? '失败：' + r.error : '已播放：' + words.join('、')
  } catch (e) { $('actMsg').textContent = '失败：' + (e && e.message) }
  setTimeout(() => { $('actMsg').textContent = '' }, 2600)
}
$('actPlay').addEventListener('click', () => {
  const w = String($('actInput').value || '').trim()
  if (w) playAct([w])
})
$('actInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('actPlay').click() })

/* ---------------- 模型面板 ---------------- */
$('btnModel').addEventListener('click', () => { $('modelPanel').hidden = !$('modelPanel').hidden; $('memPanel').hidden = true; $('rolePanel').hidden = true; $('cuaPanel').hidden = true; $('actPanel').hidden = true })
$('modelClose').addEventListener('click', () => { $('modelPanel').hidden = true })
$('mSave').addEventListener('click', async () => {
  const t = String($('mTemp').value).trim()
  const r = await api.providerSet({
    baseUrl: $('mBase').value.trim(),
    model: $('mModel').value.trim(),
    apiKey: $('mKey').value.trim(),
    // 留空 = null（不发 temperature）；填数字才发
    temperature: t === '' ? null : (Number(t) || null)
  })
  $('modelMsg').textContent = r.ok ? '已保存并生效' : '失败: ' + r.error
  if (r.ok) renderProvider(r.provider)
})
$('mImport').addEventListener('click', async () => {
  const r = await api.importCreds()
  $('modelMsg').textContent = r.ok ? '导入成功' : '失败: ' + r.error
  if (r.ok) renderProvider(r.provider)
})

/* ---------------- 电脑操作（CUA）面板 ---------------- */
let cuaState = null

async function loadCua () {
  cuaState = await api.cuaState()
  const risks = cuaState.risks || []
  const box = $('cuaRisks')
  box.innerHTML = ''
  risks.forEach((text, i) => {
    const row = document.createElement('label')
    row.className = 'cua-risk' + (cuaState.acks[i] ? ' read' : '')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !!cuaState.acks[i]
    cb.dataset.i = String(i)
    const span = document.createElement('span')
    span.textContent = text
    row.appendChild(cb)
    row.appendChild(span)
    cb.addEventListener('change', () => {
      row.classList.toggle('read', cb.checked)
      syncCuaEnable()
    })
    box.appendChild(row)
  })
  $('cuaEnable').checked = !!cuaState.enabled
  $('cuaPerm').value = cuaState.permMode || 'ask-once'
  syncCuaEnable()
  $('cuaMsg').textContent = cuaState.enabled ? '已开启' : '当前关闭'
  // 模型读不了图时把话说明白：否则用户会以为「开了就能看屏幕」
  const v = $('cuaVision')
  if (v) {
    if (cuaState.vision === false) {
      v.textContent = '⚠ 当前模型读不了图：' + (cuaState.visionNote || '') +
        '。截图对它没用，只能用「开程序 / 回微信 / 按快捷键」这类固定流程。想看屏幕请换成支持读图的模型。'
      v.classList.add('warn')
    } else {
      v.textContent = '✓ 当前模型（' + (cuaState.model || '未知') + '）可以读图，截图有效。'
      v.classList.remove('warn')
    }
  }
}

function cuaAcks () {
  return [...document.querySelectorAll('#cuaRisks input')].map((x) => x.checked)
}

/** 三条没读完就不让勾「允许」——风险告知页的意义就在这里 */
function syncCuaEnable () {
  const all = cuaAcks()
  const readAll = all.length > 0 && all.every(Boolean)
  const en = $('cuaEnable')
  if (!readAll) en.checked = false
  en.disabled = !readAll
  en.parentElement.classList.toggle('on', en.checked)
  if (!readAll) $('cuaMsg').textContent = '把上面三条都勾选后才能开启'
}

$('cuaEnable').addEventListener('change', () => {
  $('cuaEnable').parentElement.classList.toggle('on', $('cuaEnable').checked)
})

$('btnCua').addEventListener('click', () => {
  const p = $('cuaPanel')
  p.hidden = !p.hidden
  $('memPanel').hidden = true
  $('modelPanel').hidden = true
  $('actPanel').hidden = true
  $('rolePanel').hidden = true
  if (!p.hidden) loadCua().catch((e) => { $('cuaMsg').textContent = '读取失败: ' + e.message })
})
$('cuaClose').addEventListener('click', () => { $('cuaPanel').hidden = true })

// 模型调了 open_computer_panel：自动展开「电脑」面板（开关仍要用户自己勾选打开）
if (api.onOpenCuaPanel) {
  api.onOpenCuaPanel(() => {
    $('cuaPanel').hidden = false
    $('memPanel').hidden = true
    $('modelPanel').hidden = true
    $('rolePanel').hidden = true
    loadCua().catch((e) => { $('cuaMsg').textContent = '读取失败: ' + e.message })
    // 轻微闪两下标题，告诉用户「是她带你来的这里」
    const head = document.querySelector('#cuaPanel .panel-head b')
    if (head) {
      let n = 0
      const t = setInterval(() => {
        head.style.opacity = head.style.opacity === '0.25' ? '1' : '0.25'
        if (++n >= 6) { clearInterval(t); head.style.opacity = '' }
      }, 320)
    }
  })
}

$('cuaSave').addEventListener('click', async () => {
  const acks = cuaAcks()
  const r = await api.cuaSet({
    enabled: $('cuaEnable').checked,
    acks,
    permMode: $('cuaPerm').value
  })
  if (r && r.ok) {
    cuaState = r
    $('cuaMsg').textContent = r.enabled ? '✓ 已开启（下一条消息生效）' : '✓ 已关闭'
    if (!r.enabled && $('cuaEnable').checked) {
      $('cuaEnable').checked = false
      $('cuaEnable').parentElement.classList.remove('on')
    }
  } else {
    $('cuaMsg').textContent = '保存失败: ' + ((r && r.error) || '未知错误')
  }
})

$('cuaTest').addEventListener('click', async () => {
  $('cuaMsg').textContent = '正在测试引擎…'
  const r = await api.cuaSelftest()
  if (r && r.ok) {
    $('cuaMsg').textContent = `✓ 引擎正常：${r.windows} 个窗口可见，用户空闲 ${(r.idleMs / 1000).toFixed(1)} 秒`
  } else {
    $('cuaMsg').textContent = '✗ 引擎异常: ' + ((r && r.error) || '未知')
  }
})

/* ---------------- 控制台顶栏（0.19.0） ----------------
 * 一行看完：运行状态 / 模型 / 今日用量 / 累计输入 / 缓存命中 / 上下文占用。
 * 数据来自 assistant:usage 与 assistant:context，10 秒轮询一次（都很轻）。 */
function fmtTok (n) {
  n = Number(n) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
function setCb (id, text, tone) {
  const el = $(id)
  if (!el) return
  el.textContent = text
  if (tone) el.dataset.tone = tone
  else delete el.dataset.tone
}
function setRunState (busy) {
  setCb('cbState', busy ? '生成中…' : '就绪', busy ? 'busy' : 'ok')
}
async function refreshConsole () {
  try {
    const u = await api.usage()
    if (u && u.ok) {
      const t = u.today || {}
      const tot = u.total || {}
      setCb('cbToday', `今日 ${t.calls || 0} 次 · ${fmtTok(t.prompt)}/${fmtTok(t.completion)}`)
      setCb('cbTotal', `累计 ${fmtTok(tot.prompt)} 入`)
      setCb('cbCache', t.prompt > 0 && t.cached > 0 ? `缓存 ${Math.round((t.cached / t.prompt) * 100)}%` : '缓存 —')
      setCb('cbVendor', u.model || '—')
    }
  } catch { /* 用量拿不到不影响聊天 */ }
  try {
    const cx = await api.context()
    if (cx && cx.tokens != null) {
      const pct = Math.round((Number(cx.ratio) || 0) * 100)
      setCb('cbCtx', `上下文 ${fmtTok(cx.tokens)}${cx.limit ? ' / ' + fmtTok(cx.limit) + ' · ' + pct + '%' : ''}`,
        pct >= 95 ? 'bad' : pct >= 70 ? 'warn' : '')
    }
  } catch { }
}

/* ---------------- 窗口控制 ---------------- */
$('btnClose').addEventListener('click', () => window.close())
document.getElementById('titlebar').addEventListener('dblclick', () => {})

/* ---------------- 启动 ---------------- */
;(async () => {
  await refreshState()
  await loadHistory()
  // 控制台顶栏：先渲染一次，再每 10 秒跟着用量/上下文更新（都很轻，不会打断输入）
  refreshConsole()
  setInterval(refreshConsole, 10000)
  // 1.10：当前模型支持视觉才显示发图按钮
  try {
    const ex = await api.extras()
    if (ex && ex.vision) $('btnImg').hidden = false
  } catch { /* 拿不到就保持隐藏 */ }
  $('input').focus()
})().catch((e) => addSys('初始化失败: ' + e.message))
