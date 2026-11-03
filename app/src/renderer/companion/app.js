'use strict'
/* AI 伴侣渲染层：流式聊天 + 立绘/Spine/3D 形象 + 语音输入/播报 */
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** node integration 关闭，拿不到 path 模块：自实现 basename（/ 与 \ 都认） */
const basename = (p) => String(p || '').replace(/\\/g, '/').split('/').pop()
/** 0.25.0 用量页状态（区间/粒度/指标/分组/币种/汇率）；声明在顶部，设置回填时也会写它 */
const U = { range: 7, gran: 'day', metric: 'token', group: 'none', currency: 'CNY', rate: 7.2, from: '', to: '' }
/** 记忆页自动保存：上次落盘的内容 + 防抖句柄 */
let memLastSaved = ''
let memDirtyTimer = null

/* ---------------- 界面多语言（S7） ----------------
 * 语言来源：localStorage 快路径（避免闪烁）> companion 配置 uiLang > 系统语言 > zh。
 * 文案在模块加载时取好，切语言保存后整窗 reload（对齐参考实现的做法）。
 * 另有 normal/advanced 双模式：uiMode 只隐藏 [data-adv]，不改任何配置。 */
const I18N = window.AuraI18n
const UI_LANG_KEY = 'aura.uiLang'
const UI_MODE_KEY = 'aura.uiMode'
let uiMode = 'normal'
try { uiMode = localStorage.getItem(UI_MODE_KEY) === 'advanced' ? 'advanced' : 'normal' } catch {}
try { I18N.setLang(localStorage.getItem(UI_LANG_KEY) || 'auto') } catch { I18N.setLang('auto') }
I18N.applyDOM()
refineSettingLabels()
const t = I18N.t

/** 设置页「标题 + 说明」自动拆分（0.18.0 UI 重构）
 * 旧文案把说明塞在标题里（「角色走动（她自己会在当前屏幕溜达，不会跨屏）」），
 * 几十项堆下来就是一堵文字墙。这里在 i18n 落地后按「（…）/ ——…」切一刀：
 * 前半当标题加粗、后半当灰色小字说明。4 种语言自动生效，改文案不用动代码；
 * 没有括号或破折号的标题原样保留。切语言会 reload，所以跑一次就够。 */
function refineSettingLabels () {
  const labels = document.querySelectorAll('#tabSettings .sp-page > label')
  for (const el of labels) {
    if (el.classList.contains('cd-check')) continue
    for (const old of el.querySelectorAll(':scope > .sp-tx')) old.remove()
    const n = el.firstChild
    // 只拆「纯文本开头」的 label；标题在 span 里的（带 data-i18n 的容器）保持原样
    if (!n || n.nodeType !== 3) continue
    const txt = String(n.textContent || '').trim()
    if (!txt) continue
    const m = txt.match(/^(.{2,32}?)\s*(?:[（(](.+)[)）]|—{1,2}\s*(.+))$/)
    if (!m) continue
    const title = m[1].trim()
    const desc = String(m[2] || m[3] || '').trim()
    if (!title || !desc) continue
    n.textContent = ''
    const wrap = document.createElement('div')
    wrap.className = 'sp-tx'
    const tt = document.createElement('span')
    tt.className = 'sp-t'
    tt.textContent = title
    const dd = document.createElement('span')
    dd.className = 'sp-d'
    dd.textContent = desc
    wrap.appendChild(tt)
    wrap.appendChild(dd)
    el.insertBefore(wrap, n.nextSibling)
  }
}

let S = { characters: [], history: [], settings: {} }
let char = null
let generating = false
let pendingAi = null // 流式中的消息元素

/* ---------------- 消息渲染 ---------------- */
function addMsg (role, text, cls) {
  const d = document.createElement('div')
  d.className = 'msg ' + (cls || role)
  d.textContent = text || ''
  $('chat').appendChild(d)
  $('chat').scrollTop = $('chat').scrollHeight
  return d
}
function trimChat () {
  const chat = $('chat')
  while (chat.children.length > 120) chat.removeChild(chat.firstChild)
}

function renderHistory () {
  $('chat').innerHTML = ''
  for (const m of S.history.slice(-60)) {
    const txt = m.content + (m.role !== 'user' && m.sub && m.sub !== m.content ? '\n' + m.sub : '')
    addMsg(m.role === 'user' ? 'user' : 'ai', txt)
  }
}

/* ---------------- 聊天：统一走助手核心 ----------------
 * 历史 / 角色 / 记忆全部来自 assistant:*，与伙伴气泡、托盘入口是同一份会话。
 * 旧的 companion 聊天后端在 AI 移除时已删除，这里曾挂着一个永远不会有回应的空壳，
 * 同时又存在另一个 assistant 聊天窗 —— 两个窗都能"聊天"却互不相通，此处合并为单通道。
 */
const A = window.assistantAPI || null
let lastDeltaSeq = null

// 工具名 → 人话（状态条上显示，不往对话里插噪声）
const TOOL_KEYS = ['get_time', 'system_info', 'calc', 'open_url', 'exec_command']

function setBusy (b) {
  generating = b
  $('btnSend').disabled = b
  // 助手核心暂不提供中断能力：隐藏假停止按钮，避免点了没反应
  $('btnStop').hidden = true
}

function renderAssistantHistory (list) {
  $('chat').innerHTML = ''
  const arr = Array.isArray(list) ? list.slice(-80) : []
  if (!arr.length) {
    const el = document.createElement('div')
    el.className = 'msg sysnote'
    el.textContent = t('chat.empty')
    $('chat').appendChild(el)
    return
  }
  for (const m of arr) addMsg(m.role === 'user' ? 'user' : 'ai', m.content + (m.sub && m.sub !== m.content ? '\n' + m.sub : ''))
  $('chat').scrollTop = $('chat').scrollHeight
}

if (A) {
  // 0.45.14 流式打字机：收到的增量先进队列小步排出（首口立即、句末换气），不再整段糊上屏。
  // typewriter.js 没加载（测试 stub 环境）时退化为「收到即上屏」的旧路径。
  const TyperMod = window.RyzaTyper || {
    create: (o) => {
      const setText = (o && o.setText) || function () {}
      return { push: (t) => setText(String(t || '')), finish: (f) => { if (f != null) setText(String(f)) }, reset: () => setText(''), get text () { return '' } }
    }
  }
  const aiTyper = TyperMod.create({
    setText: (t) => {
      if (pendingAi) {
        pendingAi.textContent = t
        $('chat').scrollTop = $('chat').scrollHeight
      }
    }
  })
  A.onDelta(({ seq, text, reset }) => {
    // seq 变化 / reset = 新一轮生成（语言守卫纠正会重生成一次）→ 丢掉上一轮半截
    if (reset || seq !== lastDeltaSeq) {
      lastDeltaSeq = seq
      if (pendingAi) { pendingAi.remove(); pendingAi = null }
      aiTyper.reset()
    }
    if (!pendingAi) { pendingAi = addMsg('ai', '', 'ai typing') }
    aiTyper.push(text)
  })

  A.onTool(({ name }) => {
    const chip = $('cpToolChip')
    if (!chip) return
    chip.hidden = false
    chip.textContent = '⚙ ' + (TOOL_KEYS.includes(name) ? t('tool.' + name) : t('tool.using') + name) + '…'
  })

  A.onDone(({ content, display, toolResults }) => {
    setBusy(false)
    const chip = $('cpToolChip'); if (chip) chip.hidden = true
    // display = 字幕（设置里「显示字幕」的语言），content = 台词原文（朗读用）
    const shown = display || content
    if (pendingAi) {
      pendingAi.classList.remove('typing')
      aiTyper.finish((shown != null && shown !== '') ? shown : (aiTyper.text || t('chat.emptyReply')))
      if (toolResults && toolResults.length) {
        const t = document.createElement('div')
        t.className = 'tools'
        t.textContent = toolResults.map((x) => x.name).join(' · ')
        pendingAi.appendChild(t)
      }
      pendingAi = null
    } else {
      // 没有正在生成的气泡 = 外部发言（屏幕陪伴主动搭话）直接落聊天框
      if (shown) addMsg('ai', shown)
    }
    trimChat()
    // 朗读统一由伙伴层负责（readReply 开关、气泡与语音同步），这里不再重复播放，避免双份回声
    if (!$('charDrawer').hidden && !$('tabPersona').hidden) renderTimeline()
  })

  A.onError(({ message }) => {
    setBusy(false)
    const chip = $('cpToolChip'); if (chip) chip.hidden = true
    if (pendingAi) { pendingAi.classList.remove('typing'); pendingAi = null }
    addMsg('', String(message || t('chat.err')).replace(/\s+/g, ' ').slice(0, 300), 'syserr')
  })
}

/** 旁白/台词分段显示：*斜体旁白* 与正文分开 */
function stripTags (s) {
  return String(s || '')
    .replace(/<(?:think|tool_call|function_call)[^>]*>[\s\S]*?<\/(?:think|tool_call|function_call)>/gi, '')
    .replace(/<answer>|<\/answer>|<code>|<\/code>/gi, '')
    .trim()
}
function renderAiText (raw) {
  // 简易分段：整段 *...* 或（...）开头的行当旁白
  const el = document.createElement('div')
  el.className = 'msg ai'
  for (const line of String(raw).split('\n')) {
    const t = line.trim()
    if (!t) continue
    const seg = document.createElement('div')
    if (/^\*.*\*$/.test(t) || /^（.*）$/.test(t)) { seg.className = 'msg narr'; seg.textContent = t.replace(/^\*|\*$|^（|）$/g, '') }
    else seg.textContent = t
    el.appendChild(seg)
  }
  return el
}

/* ---------------- 发送 ---------------- */
async function sendText () {
  const v = $('input').value.trim()
  if (!v || generating) return
  $('input').value = ''
  $('input').style.height = 'auto'
  try { localStorage.removeItem(draftKey()) } catch { }
  // 发送新消息即打断正在播的语音（对齐参考 _cancelSpeechPlayback）
  try {
    if (curAudio) { curAudio.pause(); curAudio = null }
    document.body.id = ''
    if (window.speechSynthesis) speechSynthesis.cancel()
  } catch {}
  addMsg('user', v)
  pendingAi = null
  lastDeltaSeq = null
  setBusy(true)
  if (!A) { setBusy(false); addMsg('', t('chat.notReady'), 'syserr'); return }
  // 不等整个生成完成（事件流负责刷新界面），只兜住 IPC 层异常
  Promise.resolve(A.send(v)).catch((e) => {
    setBusy(false)
    addMsg('', t('chat.sendFail') + (e && e.message), 'syserr')
  })
}
$('btnSend').addEventListener('click', sendText)
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() }
})
$('input').addEventListener('input', function () {
  this.style.height = 'auto'
  this.style.height = Math.min(88, this.scrollHeight) + 'px'
  saveDraft()
})

/* ---------------- 0.18.0 第一批：草稿保存 + 上下文圆环 ---------------- */
/** 草稿按角色分开存（localStorage，本机） */
function draftKey () {
  const id = ($('charSelect') && $('charSelect').value) || 'default'
  return 'ryza.chatDraft.' + id
}
function saveDraft () {
  try {
    const v = $('input').value
    if (v && v.trim()) localStorage.setItem(draftKey(), v)
    else localStorage.removeItem(draftKey())
  } catch { }
}
function loadDraft () {
  try {
    const v = localStorage.getItem(draftKey())
    if (v && !$('input').value) {
      $('input').value = v
      $('input').dispatchEvent(new Event('input'))
    }
  } catch { }
}
/** 上下文圆环：估算 token / 厂商上限，接近折叠阈值变黄、将满变红；hover 看详情 */
async function ctxRingRefresh () {
  const el = $('ctxRing')
  if (!el || !A || !A.context) return
  try {
    const c = await A.context()
    if (!c || !c.limit) { el.hidden = true; return }
    const pct = Math.min(100, Math.round((c.ratio || 0) * 100))
    el.hidden = false
    el.style.setProperty('--p', pct)
    el.classList.toggle('warn', (c.ratio || 0) >= 0.7)
    el.classList.toggle('full', (c.ratio || 0) >= 0.95)
    el.title = '上下文 ' + c.tokens + ' / ' + c.limit + ' tokens（' + pct + '%）\n' +
      '到 ' + c.threshold + ' 会自动折叠旧对话' + (c.folded ? '\n已折叠摘要 ' + c.folded + ' 条' : '')
  } catch { }
}
setTimeout(ctxRingRefresh, 1500)
setInterval(ctxRingRefresh, 6000)

/* ---------------- 语音输入（Whisper 兼容端点） ---------------- */
let recorder = null
let chunks = []
$('btnMic').addEventListener('pointerdown', async () => {
  if (recorder) return
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    chunks = []
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (e) => chunks.push(e.data)
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      $('btnMic').classList.remove('rec')
      const blob = new Blob(chunks, { type: 'audio/webm' })
      if (blob.size < 1200) return
      const b64 = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())))
      addMsg('', t('mic.doing'), 'syserr')
      const r = await window.companion.transcribe(b64, 'audio/webm')
      const last = $('chat').lastChild
      if (last && last.textContent === t('mic.doing')) last.remove()
      if (r.ok && r.text) {
        // 0.38.0：同一套「像不像话」过滤，别把「嗯。」「그.」当一句话发出去
        const v = window.speechFilter ? window.speechFilter.looksLikeSpeech(r.text) : { ok: true, text: r.text }
        if (!v.ok) { addMsg('', t('mic.unheard'), 'syserr'); return }
        $('input').value = v.text || r.text
        sendText()
      }
      else if (r.message) addMsg('', t('mic.fail') + r.message, 'syserr')
    }
    recorder.start()
    $('btnMic').classList.add('rec')
  } catch { addMsg('', t('mic.unavailable'), 'syserr') }
})
const micUp = () => { if (recorder && recorder.state === 'recording') { recorder.stop(); recorder = null } }
$('btnMic').addEventListener('pointerup', micUp)
$('btnMic').addEventListener('pointerleave', micUp)

/* ---------------- TTS 播放 ---------------- */
let curAudio = null
function playAudio (url, speed) {
  try {
    if (curAudio) curAudio.pause()
    curAudio = new Audio(url)
    // 语速：Fish API 本身不支持 speed，用播放速率实现
    if (speed && speed !== 1) curAudio.playbackRate = speed
    document.body.id = 'speaking'
    curAudio.onended = () => { document.body.id = '' }
    curAudio.play()
  } catch {}
}
function speakBrowser (text) {
  try {
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text.slice(0, 400))
    const v = char && char.voice ? char.voice : {}
    u.pitch = v.pitch != null ? v.pitch : 1
    u.rate = v.rate != null ? v.rate : 1
    // 朗读音色与回复语言解耦：设置里选了具体音色（任意语种）就用它，
    // 没选则按回复语言挑系统语音，最后兜底中文
    const rl = (S.settings && S.settings.replyLang) || 'zh'
    const langTag = { zh: 'zh', ja: 'ja', en: 'en' }[rl] || 'zh'
    const voices = speechSynthesis.getVoices()
    // 音色跟角色卡走：卡上选了系统语音就用卡的，没选才用全局默认
    const want = (v && v.sysVoiceName) || (S.settings && S.settings.sysVoiceName)
    const picked = (want && voices.find((x) => x.name === want)) ||
      voices.find((x) => x.lang && String(x.lang).toLowerCase().startsWith(langTag)) ||
      voices.find((x) => /zh|Chinese/i.test(x.lang))
    if (picked) u.voice = picked
    u.lang = picked ? picked.lang : ({ zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' }[rl] || 'zh-CN')
    document.body.id = 'speaking'
    u.onend = () => { document.body.id = '' }
    speechSynthesis.speak(u)
  } catch {}
}

/* ---------------- 形象（立绘 / Spine / 3D VRM / 形象包） ---------------- */
let vrmRuntime = null
let spineRuntime = null
let spineRafStarted = false
let figureLoop = null

async function assetUrl (p) { return p ? window.companion.assetUrl(p) : '' }

async function showFigure (v) {
  const f = v && v.figure
  if (!f || !f.pack || !window.AuraFigure) { $('stageFallback').hidden = false; return }
  const payload = await window.companion.figureResolve(f.pack, f)
  if (!payload) { $('stageFallback').hidden = false; return }
  const canvas = $('figureCanvas')
  if (!figureLoop) figureLoop = window.AuraFigure.startLoop(canvas, payload, { interval: 50 })
  else await figureLoop.update(payload)
}

async function showVisual () {
  // 0.45.43：形象区已按用户要求整个移除（#stage display:none）——不再初始化
  // VRM/Spine 渲染器（省 GPU），桌面形象由桌宠 overlay 层独立负责，不受影响
  return
  const v = (char && char.visual) || {}
  const mode = v.mode || 'still'
  $('stillImg').hidden = mode !== 'still'
  $('spineCanvas').hidden = mode !== 'spine'
  $('vrmCanvas').hidden = mode !== 'vrm'
  $('figureCanvas').hidden = mode !== 'figure'
  $('stageFallback').hidden = true
  if (mode !== 'figure' && figureLoop) { try { figureLoop.stop() } catch {} figureLoop = null }
  try {
    if (mode === 'still') {
      const url = await assetUrl(v.image)
      if (url) { $('stillImg').src = url; $('stillImg').hidden = false }
      else { $('stillImg').hidden = true; $('stageFallback').hidden = false }
    } else if (mode === 'spine') {
      await showSpine(v)
    } else if (mode === 'vrm') {
      await showVrm(v)
    } else if (mode === 'figure') {
      await showFigure(v)
    }
  } catch (err) {
    console.error('[visual]', err)
    $('stageFallback').hidden = false
  }
}

/* 读骨架文件头部版本号（二进制 .skel 在前 8 字节 hash 后跟 "4.2.43"；
   .json 在 "spine":"4.2.43" 字段），返回 "4.2" 这样的主次版本 */
async function detectSpineVersion (skelUrl) {
  try {
    const res = await fetch(skelUrl)
    const buf = new Uint8Array(await res.arrayBuffer())
    let s = ''
    for (let i = 0; i < Math.min(buf.length, 160); i++) s += String.fromCharCode(buf[i])
    const m = s.match(/(\d+)\.(\d+)\.\d+/)
    return m ? m[1] + '.' + m[2] : null
  } catch { return null }
}

/* 消除逐三角形 clip 的抗锯齿缝隙：spine-canvas 的 drawTriangle 用 path+clip+drawImage，
   相邻三角形边缘会露出网格状细缝（截图里身上的网格线）。
   补丁：把三角形沿质心向外扩 ~1.2 屏幕像素（u/v 采样不变，外扩部分 clamp 采样贴图边缘），
   相邻三角形互相重叠 1px，视觉无缝 */
function patchSpineSeam (SPINE) {
  if (!SPINE || !SPINE.SkeletonRenderer || SPINE.SkeletonRenderer.prototype.__seamPatched) return
  SPINE.SkeletonRenderer.prototype.__seamPatched = true
  const orig = SPINE.SkeletonRenderer.prototype.drawTriangle
  SPINE.SkeletonRenderer.prototype.drawTriangle = function (img, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2) {
    const s = this.__scale || 1
    const grow = 1.2 / (s || 1)
    const cx = (x0 + x1 + x2) / 3
    const cy = (y0 + y1 + y2) / 3
    const push = (px, py) => {
      const dx = px - cx
      const dy = py - cy
      const len = Math.hypot(dx, dy) || 1
      return [px + dx / len * grow, py + dy / len * grow]
    }
    ;[x0, y0] = push(x0, y0)
    ;[x1, y1] = push(x1, y1)
    ;[x2, y2] = push(x2, y2)
    orig.call(this, img, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2)
  }
}

/* Spine：spine-canvas 加载 atlas + skel(.json/.skel)，播放 idle 动画，说话切 talk */
async function showSpine (v) {
  const libs = window.AuraLibs
  if (!libs || (!libs.SPINE && !libs.AuraSpine)) {
    // 开源版不含 Spine 运行时（再分发条款与开源协议不兼容）：优雅降级到兜底图，不崩
    console.warn('[spine] 本构建不含 Spine 运行时（开源版默认移除）。持有授权可自行安装并 npm run libs 重建。')
    $('stageFallback').hidden = false
    return
  }
  if (!v.spine || !v.spine.atlas || !v.spine.skel) { $('stageFallback').hidden = false; return }
  const atlasUrl = await assetUrl(v.spine.atlas)
  const skelUrl = await assetUrl(v.spine.skel)
  if (spineRuntime && spineRuntime.sig === atlasUrl + skelUrl) return
  disposeSpine()
  // Spine 运行时严格锁版本（4.3 读不了 4.2 导出的骨架，报 Bone name must not be null），
  // 从骨架文件头部扫版本号，选对应运行时；识别不出就用最新 4.3 兜底
  const ver = await detectSpineVersion(skelUrl)
  /* 优先 WebGL（GPU 画 mesh）：canvas 2D 逐三角形裁剪在这套精致皮肤上单帧 ~100ms，
   * 60fps 循环会把渲染进程钉在 100% CPU，整机鼠标都跟着发飘（0.5.2 实测：
   * 面板一开着 CPU 就吃满一个核）。GL 只画在离屏 canvas，再 blit 到 2D 画布
   * —— 本机合成器对 WebGL canvas 的透明合成有薄纱 bug，2D 上屏最稳。*/
  let GL = (libs.AuraSpineGL && ver && libs.AuraSpineGL[ver]) || null
  let SPINE = GL || (libs.AuraSpine && ver && libs.AuraSpine[ver]) || libs.SPINE
  const canvas = $('spineCanvas')
  const scale = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale))
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale))
  let glCanvas = null
  let managedGl = null
  let ctx2d = null
  let useGL = false
  if (GL) {
    try {
      glCanvas = document.createElement('canvas')
      glCanvas.width = canvas.width
      glCanvas.height = canvas.height
      managedGl = new GL.ManagedWebGLRenderingContext(glCanvas, { alpha: true, premultipliedAlpha: true, antialias: false })
      managedGl.gl.pixelStorei(managedGl.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      ctx2d = canvas.getContext('2d', { willReadFrequently: false })
      useGL = true
    } catch (e) {
      console.warn('[spine] WebGL 初始化失败，降级 canvas:', e && e.message)
      GL = null
      glCanvas = null
      managedGl = null
      SPINE = (libs.AuraSpine && ver && libs.AuraSpine[ver]) || libs.SPINE
    }
  }
  if (!useGL) patchSpineSeam(SPINE)
  console.warn('[spine] 骨架版本', ver || '未知', '→ 运行时', useGL ? 'webgl ' + ver : (SPINE === libs.SPINE ? '4.3 canvas（兜底）' : ver + ' canvas'))
  const ctx = useGL ? null : canvas.getContext('2d')
  // spine-canvas 4.3 构造签名是 (pathPrefix, downloader)——没有 ctx 参数，
  // 之前把 ctx 传进去了，prefix 串被当成 downloader 导致 downloadText 报错
  const assetManager = useGL
    ? new GL.AssetManager(managedGl, atlasUrl.replace(/[^/]*$/, ''))
    : new SPINE.AssetManager(atlasUrl.replace(/[^/]*$/, ''))
  // 贴图页预转 dataURL：spine 用 Image+crossOrigin=anonymous 读贴图，
  // 自定义协议下该请求的 CORS 校验比 fetch 严（实测 fetch 通、Image 被拦）；
  // 先 fetch 把 atlas 引用的页面图转成 data: 塞进 downloader.rawDataUris，
  // spine 加载贴图时直接用 dataURL，彻底绕开协议/CORS
  try {
    const atlasText = await (await fetch(atlasUrl)).text()
    const prefix = atlasUrl.replace(/[^/]*$/, '')
    // 贴图在磁盘上的目录（v.spine.atlas 是本地绝对路径），fetch 失败时走主进程读文件兜底
    const diskDir = String(v.spine.atlas || '').replace(/\\/g, '/').replace(/[^/]*$/, '')
    const pages = [...new Set([...atlasText.matchAll(/([^\s"']+?\.(?:png|jpe?g|webp))/gi)].map((m) => m[1]))]
    for (const name of pages) {
      try {
        const full = prefix + name
        let dataUrl = null
        for (let i = 0; i < 3 && !dataUrl; i++) {
          try {
            const blob = await (await fetch(full)).blob()
            dataUrl = await new Promise((ok, bad) => {
              const r = new FileReader()
              r.onload = () => ok(r.result)
              r.onerror = () => bad(new Error('readAsDataURL 失败'))
              r.readAsDataURL(blob)
            })
          } catch (e) {
            if (i === 2 && window.companion.assetData) {
              dataUrl = await window.companion.assetData(diskDir + name).catch(() => null)
            } else {
              await new Promise((ok) => setTimeout(ok, 200))
            }
          }
        }
        if (!dataUrl) throw new Error('预载三次均失败')
        assetManager.downloader.rawDataUris[full] = dataUrl
        assetManager.downloader.rawDataUris[name] = dataUrl
      } catch (e) { console.warn('[spine] 预载贴图失败', name, e.message) }
    }
  } catch (e) { console.warn('[spine] atlas 预读失败', e.message) }
  assetManager.loadTextureAtlas(basename(decodeURIComponent(atlasUrl)))
  const skelName = basename(decodeURIComponent(skelUrl))
  if (/\.json$/i.test(skelName)) assetManager.loadText(skelName)
  else assetManager.loadBinary(skelName)
  // spine-canvas 4.3 没有 onLoadAll 回调，用 isLoadingComplete() 轮询；
  // errors 里会记录真实加载失败原因（fetch 失败/404 等）
  await new Promise((resolve, reject) => {
    const t0 = Date.now()
    const poll = () => {
      if (assetManager.isLoadingComplete()) {
        const errs = Object.values(assetManager.errors || {})
        if (errs.length) reject(new Error('Spine 资源加载失败: ' + String(errs[0]).slice(0, 200)))
        else resolve()
      } else if (Date.now() - t0 > 15000) reject(new Error('Spine 资源加载超时'))
      else setTimeout(poll, 80)
    }
    poll()
  })
  // 4.3 取数统一用 require(相对文件名)（内部自拼 pathPrefix），
  // 老 API requireAtlas/requireText/requireBinary 已删除
  const atlas = assetManager.require(basename(decodeURIComponent(atlasUrl)))
  let skeletonData
  const skelData = assetManager.require(skelName)
  if (/\.json$/i.test(skelName)) {
    skeletonData = new SPINE.SkeletonJson(new SPINE.AtlasAttachmentLoader(atlas)).readSkeletonData(skelData)
  } else {
    skeletonData = new SPINE.SkeletonBinary(new SPINE.AtlasAttachmentLoader(atlas)).readSkeletonData(skelData)
  }
  const skeleton = new SPINE.Skeleton(skeletonData)
  // 附件可能挂在命名皮肤里（导出时勾了皮肤）：default skin 为空时骨骼照常摆位
  // （bounds/动画都正常）但什么都画不出来。列出皮肤并显式选一个
  const skins = skeletonData.skins || []
  console.warn('[spine] 皮肤列表:', skins.map((s) => s.name).join(',') || '(无)')
  if (skins.length) {
    const pick = skins.find((s) => /default|base|normal/i.test(s.name)) || skins[skins.length - 1]
    skeleton.setSkin(skins.length > 1 ? pick : skins[0])
    skeleton.setSlotsToSetupPose()
    console.warn('[spine] 使用皮肤:', pick.name)
  }
  console.warn('[spine] 槽位附件:', skeleton.slots.filter((sl) => sl.getAttachment()).length + '/' + skeleton.slots.length)
  // 所有 4.x 的 AnimationState 构造参数都是 AnimationStateData（不是 SkeletonData）：
  // 直接传 SkeletonData 会让内部 this.data.skeletonData 为 undefined，
  // 一调 setAnimation 就报 Cannot read properties of undefined (reading 'findAnimation')
  const state = new SPINE.AnimationState(new SPINE.AnimationStateData(skeletonData))
  // idle 选择：优先全身待机（motion_*_idle），眉毛/脸部/特效类 idle 幅度太小
  // 会被当成「静态」，所以放最后兜底
  const anims = skeletonData.animations
  const idle = anims.find((a) => /^motion_[A-Z]_\d+_idle$/i.test(a.name))
    || anims.find((a) => /motion.*idle/i.test(a.name))
    || anims.find((a) => /stand|wait|待机/i.test(a.name))
    || anims.find((a) => /idle|待机/i.test(a.name) && !/facial|face|effect/i.test(a.name))
    || anims.find((a) => /idle|待机/i.test(a.name))
    || anims[0]
  console.warn('[spine] 加载成功: 动画', skeletonData.animations.map((a) => a.name).join(','), '→ 播放', idle && idle.name)
  // setAnimation 在 4.0/4.1/4.2 里只认动画名字符串（内部 this.data.skeletonData.findAnimation(name)），
  // 传 Animation 对象会在这些版本炸掉，所以统一传名字
  if (idle) state.setAnimation(0, idle.name, true)
  let talkTrack = -1
  let firstFrame = true
  /* 两条渲染路径：
   *  - WebGL（默认）：GPU 画 mesh，30fps 几乎不占主线程；GL 画在离屏 canvas，
   *    每帧 blit 到显示用 2D canvas（本机合成器对 WebGL canvas 的透明合成有薄纱 bug）
   *  - canvas 2D（兜底）：没有 WebGL 时逐三角形裁剪绘制，单帧 ~100ms，只在极端环境用
   */
  if (useGL) {
    const sceneRenderer = new GL.SceneRenderer(glCanvas, managedGl)
    const gl = managedGl.gl
    const dpr = window.devicePixelRatio || 1
    // 相机按 setup pose 的包围盒锁定：动画会让包围盒持续变化，跟着重算角色会忽大忽小。
    // 取包围盒前必须先刷一次世界变换，否则拿到的是未初始化的垃圾值 → 缩放错乱
    skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.none : undefined)
    const bOff = new SPINE.Vector2()
    const bSize = new SPINE.Vector2()
    skeleton.getBounds(bOff, bSize, [])
    const bw = bSize.x || 1
    const bh = bSize.y || 1
    const cam = sceneRenderer.camera
    cam.position.set(bOff.x + bw / 2, bOff.y + bh / 2, 0)
    let lastSizeTag = ''
    const sizeGL = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h }
      const tag = w + 'x' + h
      if (tag !== lastSizeTag) {
        lastSizeTag = tag
        // canvas 改尺寸不会自动同步 viewport（跨屏/hidden→显示踩过大坑），这里显式对齐
        try { gl.viewport(0, 0, w, h); gl.scissor(0, 0, w, h) } catch {}
      }
      cam.setViewport(canvas.width, canvas.height)
      let z = Math.max(bw / canvas.width, bh / canvas.height) / 0.95
      if (!isFinite(z) || z <= 0) z = 1
      cam.zoom = z
    }
    sizeGL()
    spineRuntime = {
      sig: atlasUrl + skelUrl,
      render: true,
      resize: sizeGL,
      step (dtIn) {
        sizeGL()
        const dt = dtIn > 0 ? dtIn : 1 / 30
        if (skeleton.update) skeleton.update(dt)
        state.update(dt)
        // 必须 apply：不把动画姿势写回骨架，画的永远是 setup pose 静图
        state.apply(skeleton)
        skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.update : undefined)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        sceneRenderer.begin()
        sceneRenderer.drawSkeleton(skeleton, true) // 贴图预乘 → PMA 混合
        sceneRenderer.end()
        // 无 preserveDrawingBuffer：blit 必须紧跟在 end() 同一个任务里
        ctx2d.clearRect(0, 0, canvas.width, canvas.height)
        ctx2d.drawImage(glCanvas, 0, 0)
      }
    }
  } else {
    spineRuntime = {
      sig: atlasUrl + skelUrl,
      render: true,
      step (dtIn) {
        const dt = dtIn > 0 ? dtIn : 1 / 30
        state.update(dt)
        skeleton.updateWorldTransform(SPINE.Physics ? SPINE.Physics.update : undefined)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        // 适配：骨架包围盒缩放居中
        const offset = new SPINE.Vector2()
        const size = new SPINE.Vector2()
        skeleton.getBounds(offset, size, [])
        const s = Math.min(canvas.width / (size.x || 1), canvas.height / (size.y || 1)) * 0.92
        if (firstFrame) {
          firstFrame = false
          console.warn('[spine] 首帧: canvas', canvas.width + 'x' + canvas.height, 'bounds', Math.round(offset.x) + ',' + Math.round(offset.y), Math.round(size.x) + 'x' + Math.round(size.y), 'scale', s.toFixed(3))
        }
        ctx.save()
        // spine 世界坐标 y 向上、canvas y 向下：必须 scale(s, -s) 翻转 y 并把 bounds
        // 底边对到画布底部——不翻转会整只画到画布上方之外（无异常但画面空白）
        ctx.translate((canvas.width - size.x * s) / 2 - offset.x * s, canvas.height - 6 + offset.y * s)
        ctx.scale(s, -s)
        const renderer = new SPINE.SkeletonRenderer(ctx)
        // 默认 drawImages 只画 Region 四边形，Mesh 全部跳过（精致皮肤几乎全是
        // mesh → 整帧 0 像素）。必须开 triangleRendering 才走 mesh 逐三角形渲染
        renderer.triangleRendering = true
        renderer.__scale = s
        renderer.draw(skeleton)
        ctx.restore()
      }
    }
  }
  state.addListener({
    event: () => {},
    // 4.0~4.2 的 setAnimation 只认动画名字符串，传 Animation 对象会炸
    complete: (e) => { if (e.trackIndex === talkTrack) { talkTrack = -1; if (idle) state.setAnimation(0, idle.name, true) } }
  })
  spineRuntime.playTalk = () => {
    const talk = skeletonData.animations.find((a) => /talk|speak|说话/i.test(a.name))
    if (talk) { talkTrack = 1; state.setAnimation(1, talk.name, false) }
  }
  // 驱动用 setInterval 而非 rAF：窗口被判定遮挡时 rAF 的 BeginFrame 会被暂停
  // （计时器不会），配合主进程禁用 CalculateNativeWinOcclusion 双保险。
  // 30fps 够顺滑；面板不可见（最小化/被关到后台）时整段跳过，绝不在后台空转烧 CPU
  if (!spineRafStarted) {
    spineRafStarted = true
    let errCount = 0
    let lastT = performance.now()
    setInterval(() => {
      if (!spineRuntime || !spineRuntime.render) return
      if (document.hidden) return
      const now = performance.now()
      const dt = Math.min(0.1, (now - lastT) / 1000)
      lastT = now
      try { spineRuntime.step(dt) } catch (e) { if (++errCount <= 3) console.warn('[spine] step 异常:', e.message) }
    }, 33)
  }
}
function disposeSpine () {
  if (spineRuntime) { spineRuntime.render = false; spineRuntime = null }
}

/* three.js + VRM */
/* 3D：渲染逻辑在 shared/vrm-stage.js（取景按包围盒、自带动画、眨眼、口型）。
   以前这里写死 camera(0,1.35,-1.6)+lookAt(0,1.25,0)，预览里标准身高只露上半身。 */
async function showVrm (v) {
  if (!v.vrm) { $('stageFallback').hidden = false; return }
  const url = await assetUrl(v.vrm)
  if (vrmRuntime && vrmRuntime.sig === url && vrmRuntime.alive) return
  disposeVrm()
  if (!window.AuraVrm) {
    console.error('[visual] vrm-stage 未加载')
    $('stageFallback').hidden = false
    return
  }
  const stage = window.AuraVrm.create({
    canvas: $('vrmCanvas'),
    libs: window.AuraLibs,
    url,
    sig: url,
    fps: 30,
    grid: true
  })
  vrmRuntime = stage
  try {
    await stage.ready
  } catch (err) {
    if (vrmRuntime === stage) disposeVrm()
    throw err
  }
}
function disposeVrm () {
  if (vrmRuntime) { try { vrmRuntime.dispose() } catch {} vrmRuntime = null }
}

/* ---------------- 视图切换：聊天 / 角色 ----------------
 * 同一个窗口、同一个角色：聊天与角色管理不再是两个互相独立的"世界"
 */
let editing = null

function setView (v) {
  const toChar = v === 'char'
  $('charDrawer').hidden = !toChar
  $('tabChat').classList.toggle('on', !toChar)
  $('tabChar').classList.toggle('on', toChar)
  if (toChar) {
    if (char) refreshDrawer() // 启动早期（角色还没拉到）时不渲染抽屉
    $('charDrawer').scrollTop = 0
  } else {
    $('chat').scrollTop = $('chat').scrollHeight
    try { $('input').focus() } catch {}
  }
  // 0.22.0 补丁⑥：托盘/overlay 的「角色设置…」直达设置子页（AuraDesk 残留窗口已删）
  if (v === 'settings') {
    try { showDrawerTab('settings'); showSp('mind') } catch (e) { log('[view] 直达设置失败: ' + e.message) }
  }
}
function openDrawer () { setView('char') }

/* 把「角色管理」里的人格 / 世界书同步给对话侧（assistant role）——
 * 之前形象角色与对话角色是两套数据，改这里的人设聊天时不生效 */
async function syncRole (c) {
  if (!A || !c) return
  try {
    const st = await A.state()
    const worldInfo = (c.worldBook || [])
      .filter((w) => w && String(w.content || '').trim())
      .map((w) => ({
        keywords: String(w.keywords || '').split(/[,，;；\s]+/).filter(Boolean),
        text: String(w.content || '')
      }))
    await A.syncRole({
      id: c.id, name: c.name, persona: c.persona, worldInfo,
      // 0.18.0 第二批：系统提示词（角色卡·人设页）跟着一起同步
      systemPrompt: c.systemPrompt || '',
      systemReplace: !!c.systemReplace
    })
    // 对话角色始终跟随界面上显示的角色（否则"改了她的人设却不生效"）
    if (!st || st.currentRole !== c.id) await A.switchRole(c.id)
  } catch (e) {
    console.warn('[role sync]', e && e.message)
    // 助手核心启动稍慢时重试一次（顺便把那时才拿得到的历史补上）
    setTimeout(() => { syncRole(c).then(() => loadAssistantHistory()).catch(() => {}) }, 1500)
  }
}
/** 0.18.0 第二批：系统提示词（角色卡·人设页） */
function collectSystemPrompt () {
  editing.systemPrompt = $('fSystemPrompt').value.slice(0, 20000)
  editing.systemReplace = $('fSystemReplace').checked
}
function refreshDrawer () {
  const sel = $('charSelect')
  sel.innerHTML = S.characters.map((c) => `<option value="${esc(c.id)}" ${c.id === char.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
  editing = JSON.parse(JSON.stringify(char))
  $('fName').value = editing.name
  // 音色跟角色卡走：API 音色（openai 名 / Fish ID）+ 系统语音
  $('fVoiceApi').value = (editing.voice && editing.voice.apiVoice) || ''
  $('fVoiceSys').value = (editing.voice && editing.voice.sysVoiceName) || ''
  // 自设跟角色卡走（0.18.0 M8 修正）：卡上优先，空 = 用设置页共用默认
  const cup = editing.userProfile || {}
  $('fUserAddress').value = cup.address || ''
  $('fUserPortrait').value = cup.portrait || ''
  $('fUserRelation').value = cup.relationship || ''
  $('fUserInteraction').value = cup.interaction || ''
  $('fUserBoundaries').value = cup.boundaries || ''
  $('fPersona').value = editing.persona
  // 0.18.0 第二批：系统提示词编辑器（只能在界面里改）
  $('fSystemPrompt').value = editing.systemPrompt || ''
  $('fSystemReplace').checked = !!editing.systemReplace
  $('sysPreview').hidden = true
  renderWorld()
  renderVisMode()
  renderMemory()
  renderTimeline()
  // 0.18.0 第一批：切换到这张角色卡就恢复她自己的草稿（发送后清空）
  try {
    $('input').value = localStorage.getItem(draftKey()) || ''
    $('input').dispatchEvent(new Event('input'))
  } catch { }
}

/** 把卡编辑器里的音色写回角色卡（两个保存按钮共用） */
function collectVoice () {
  editing.voice = Object.assign({}, editing.voice || {}, {
    apiVoice: $('fVoiceApi').value.trim(),
    sysVoiceName: $('fVoiceSys').value
  })
}

/** 把卡编辑器里的自设（用户资料）写回角色卡（跟角色卡走，不共用；0.18.0 M8 修正） */
function collectUserProfile () {
  editing.userProfile = {
    address: $('fUserAddress').value.trim(),
    portrait: $('fUserPortrait').value.trim(),
    relationship: $('fUserRelation').value.trim(),
    interaction: $('fUserInteraction').value.trim(),
    boundaries: $('fUserBoundaries').value.trim()
  }
}

/* 抽屉 tab 切换：人设 / 形象 / 记忆 / 游戏 / 设置（全部 AI 设置整合在此，不再分散到主设置页） */
function showDrawerTab (t) {
  for (const b of $('drawerTabs').children) b.classList.toggle('on', b.dataset.t === t)
  $('tabPersona').hidden = t !== 'persona'
  $('tabVisual').hidden = t !== 'visual'
  $('tabMemory').hidden = t !== 'memory'
  $('tabGame').hidden = t !== 'game'
  $('tabSettings').hidden = t !== 'settings'
  if (t === 'settings') { renderCpSettings(); biliRefresh(); imRender(); wxRender(); worldRender() }
  if (t === 'memory') loadMemory()
  if (t === 'game') loadGame()
}
for (const b of $('drawerTabs').children) {
  b.addEventListener('click', () => showDrawerTab(b.dataset.t))
}

/* 设置页子分页（S11.1：全部堆一页太臃肿 → 通用/模型/伙伴/语音/刷B站/聊天接入）。
 * 只切 hidden，配置读写不变；记住上次停留的子页 */
const SP_KEY = 'aura.sp'
let spCur = 'general'
try { spCur = localStorage.getItem(SP_KEY) || 'general' } catch { }
function showSp (sp) {
  spCur = sp
  for (const b of $('spNav').children) b.classList.toggle('on', b.dataset.sp === sp)
  for (const p of document.querySelectorAll('.sp-page')) p.hidden = p.dataset.sp !== sp
  try { localStorage.setItem(SP_KEY, sp) } catch { }
}
if ($('spNav')) {
  for (const b of $('spNav').children) b.addEventListener('click', () => showSp(b.dataset.sp))
  showSp(spCur)
}

/* ---------------- 抽屉「记忆」tab（S4：PARTNER.md 查看/编辑 + Git 历史回滚） ---------------- */
function fmtMemoTime (ms) {
  try {
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch { return '' }
}

async function loadMemory () {
  const tip = $('memTip')
  if (!A || !A.partnerGet) { $('memPathTip').textContent = t('mem.coreNotReady'); return }
  let r = null
  try { r = await A.partnerGet() } catch (e) { $('memPathTip').textContent = t('mem.readFail') + (e && e.message); return }
  if (!r || !r.ok) { $('memPathTip').textContent = t('mem.readFail') + ((r && r.error) || t('pv.unknown')); return }
  const doc = r.content || ''
  // 自动保存后刷新历史时会再调一次 loadMemory：用户正在输入就别抢内容/光标
  if (document.activeElement !== $('memDoc') || !$('memDoc').value) $('memDoc').value = doc
  memLastSaved = doc
  $('memPathTip').textContent =
    (r.git ? t('mem.gitOk') : t('mem.gitMissing')) +
    ' · ' + (r.dir || '') +
    (r.roleEdited ? ' · ' + t('mem.roleEdited') : '')

  const h = $('memHistory')
  h.innerHTML = ''
  if (!r.history || !r.history.length) h.innerHTML = '<div class="mem-empty">' + esc(t('mem.histEmpty')) + '</div>'
  else {
    for (const c of r.history) {
      const who = c.author === 'you' ? t('mem.whoYou') : c.author === 'ryza' ? t('mem.whoRyza') : t('mem.whoApp')
      const cls = c.author === 'you' ? ' w-user' : c.author === 'ryza' ? '' : ' w-app'
      const d = document.createElement('div')
      d.className = 'mem-hist'
      d.innerHTML = `<span class="mem-hist-who${cls}">${esc(who)}</span>` +
        `<span class="mem-hist-msg"></span>` +
        `<span class="mem-hist-time">${fmtMemoTime(c.at)}</span>`
      d.querySelector('.mem-hist-msg').textContent = c.message
      d.querySelector('.mem-hist-msg').title = c.hash
      const bView = document.createElement('button')
      bView.className = 'mem-mini'
      bView.textContent = t('mem.view')
      bView.onclick = async () => {
        const s = await A.partnerShow(c.hash)
        if (s && s.ok) {
          $('memDoc').value = s.content
          tip.textContent = t('mem.loaded', c.hash.slice(0, 7))
        } else tip.textContent = t('mem.readFail') + ((s && s.error) || '')
      }
      const bRv = document.createElement('button')
      bRv.className = 'mem-mini'
      bRv.textContent = t('mem.rollback')
      bRv.onclick = async () => {
        if (!confirm(t('mem.rollbackConfirm', c.hash.slice(0, 7)))) return
        const s = await A.partnerRevert(c.hash)
        if (s && s.ok) {
          $('memDoc').value = s.content || ''
          tip.textContent = t('mem.rolledBack', c.hash.slice(0, 7)) + (s.commit ? '（' + s.commit + '）' : '')
          await loadMemory()
        } else tip.textContent = t('mem.rollbackFail') + ((s && s.error) || '')
      }
      d.appendChild(bView)
      d.appendChild(bRv)
      h.appendChild(d)
    }
  }

  const f = $('memFiles')
  f.innerHTML = ''
  if (!r.files || !r.files.length) f.innerHTML = '<div class="mem-empty">' + esc(t('mem.filesEmpty')) + '</div>'
  else {
    for (const x of r.files) {
      const d = document.createElement('div')
      d.className = 'mem-item'
      d.innerHTML = '<span class="mem-cat"></span><span class="mem-text"></span>'
      d.querySelector('.mem-cat').textContent = t('mem.catNote')
      d.querySelector('.mem-text').textContent = x.name + ' · ' + (Math.round(x.size / 102.4) / 10) + 'KB'
      f.appendChild(d)
    }
  }
}

$('memSave').addEventListener('click', async () => {
  const tip = $('memTip')
  if (!A || !A.partnerSave) return
  const v = $('memDoc').value
  const r = await A.partnerSave(v)
  if (r && r.ok) {
    memLastSaved = v
    tip.textContent = t('mem.saved') + (r.commit ? t('mem.savedCommit', r.commit) : t('mem.savedNoChange'))
    setTimeout(loadMemory, 500)
  } else tip.textContent = t('mem.saveFail') + ((r && r.error) || '')
})
$('memReload').addEventListener('click', () => { $('memTip').textContent = ''; loadMemory() })

/* 0.25.0 记忆页改版（Coopanion #23）：四个分页签 + 编辑自动保存。
 * 分页签只切 hidden，读写逻辑不变；上次停在哪个签会记住。 */
const MEM_TAB_KEY = 'aura.memTab'
function showMemTab (name) {
  if (!$('memTabs')) return
  for (const b of $('memTabs').children) b.classList.toggle('on', b.dataset.mt === name)
  for (const p of document.querySelectorAll('#tabMemory .mpane')) p.hidden = p.dataset.mp !== name
  try { localStorage.setItem(MEM_TAB_KEY, name) } catch { }
  if (name === 'facts') renderMemory().catch(() => { })
}
if ($('memTabs')) {
  for (const b of $('memTabs').children) b.addEventListener('click', () => showMemTab(b.dataset.mt))
  let lastTab = 'doc'
  try { lastTab = localStorage.getItem(MEM_TAB_KEY) || 'doc' } catch { }
  showMemTab(lastTab)
}

function memAutoTip (txt) { if ($('memAutoTip')) $('memAutoTip').textContent = txt }

/** 停手 1.2 秒自动落盘；内容没变就不写（不产生空提交） */
function memScheduleSave () {
  if (memDirtyTimer) clearTimeout(memDirtyTimer)
  memAutoTip(t('mem.autoSaving'))
  memDirtyTimer = setTimeout(async () => {
    memDirtyTimer = null
    const v = $('memDoc').value
    if (!A || !A.partnerSave) return
    if (v === memLastSaved) { memAutoTip(t('mem.autoHint')); return }
    try {
      const r = await A.partnerSave(v)
      if (r && r.ok) {
        memLastSaved = v
        memAutoTip(t('mem.autoSaved') + ' ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }))
        if (r.commit) loadMemory() // 有新提交才刷新历史
      } else memAutoTip(t('mem.saveFail') + ((r && r.error) || ''))
    } catch (e) { memAutoTip(t('mem.saveFail') + (e && e.message)) }
  }, 1200)
}
if ($('memDoc')) $('memDoc').addEventListener('input', memScheduleSave)

/* ---------------- 抽屉「设置」tab（自设置页整体迁入） ---------------- */

/* S7：厂商预设下拉。选中 → 回填地址/模型 + 挂取 Key 链接与视觉提示；
 * 保存时把协议类型（openai/anthropic/gemini）一并写进助手核心 provider */
let VENDOR_LIST = []
async function setupVendors () {
  try { VENDOR_LIST = (await A.vendors()) || [] } catch { VENDOR_LIST = [] }
  const sel = $('cpVendor')
  for (const v of VENDOR_LIST) {
    const opt = document.createElement('option')
    opt.value = v.id
    opt.textContent = v.name
    sel.appendChild(opt)
  }
  sel.addEventListener('change', onVendorPick)
}
function onVendorPick () {
  const v = VENDOR_LIST.find((x) => x.id === $('cpVendor').value)
  const key = $('cpVendorKey')
  const hint = $('cpVendorHint')
  if (!v) { key.hidden = true; hint.hidden = true; syncChatgptRow(); return }
  $('cpApiBase').value = v.baseUrl
  $('cpApiModel').value = v.model
  key.href = v.keyUrl
  key.hidden = !v.keyUrl
  hint.hidden = false
  hint.textContent = v.vision.length ? t('vendor.visionOk', v.model) : t('vendor.noVision', v.name)
  syncChatgptRow()
}
/* 1.3 ChatGPT 账号登录：选中「ChatGPT 账号（登录）」厂商时露出登录行（免 API Key） */
function syncChatgptRow () {
  const v = VENDOR_LIST.find((x) => x.id === $('cpVendor').value)
  const isGpt = !!v && v.type === 'chatgpt'
  $('cpChatgptRow').hidden = !isGpt
  if (isGpt && A) refreshChatgptState()
}
async function refreshChatgptState () {
  const st = $('cpChatgptState')
  try {
    const s = await A.chatgptStatus()
    $('cpChatgptOut').hidden = !(s && s.loggedIn)
    $('cpChatgptBtn').textContent = (s && s.loggedIn) ? t('chatgpt.relogin') : t('chatgpt.login')
    if (s && s.pending) st.textContent = t('chatgpt.pending')
    else if (s && s.loggedIn) st.textContent = t('chatgpt.loggedIn', s.account || '')
    else st.textContent = t('chatgpt.hint')
  } catch { st.textContent = '' }
}
$('cpChatgptBtn').addEventListener('click', async () => {
  if (!A) return
  $('cpChatgptBtn').disabled = true
  $('cpChatgptState').textContent = t('chatgpt.opening')
  try {
    const r = await A.chatgptLogin()
    if (r && r.ok) {
      await refreshChatgptState()
      cpSave() // 登录成功即把 chatgpt provider 存盘（type/baseUrl/model 已由厂商预设回填）
    } else {
      $('cpChatgptState').textContent = t('chatgpt.fail') + ((r && r.error) ? ' ' + r.error : '')
    }
  } catch (e) {
    $('cpChatgptState').textContent = t('chatgpt.fail') + (e && e.message ? ' ' + e.message : '')
  } finally { $('cpChatgptBtn').disabled = false }
})
$('cpChatgptOut').addEventListener('click', async () => {
  if (!A) return
  try { await A.chatgptLogout() } catch {}
  await refreshChatgptState()
})
function vendorIdForCurrent () {
  const v = VENDOR_LIST.find((x) => x.baseUrl === $('cpApiBase').value.trim())
  return v ? v.id : ''
}

async function renderCpSettings () {
  let cs = {}
  try { cs = await window.companion.settings() } catch {}
  $('cpApiBase').value = cs.apiBaseUrl || ''
  $('cpApiKey').value = cs.apiKey || ''
  $('cpApiModel').value = cs.apiModel || ''
  // 建模接入以助手核心为准（聊天真正调用的 provider）；旧配置仅作兜底
  if (A) {
    try {
      const p = await A.providerGet()
      if (p) {
        if (p.baseUrl) $('cpApiBase').value = p.baseUrl
        if (p.model) $('cpApiModel').value = p.model
      }
    } catch {}
    await setupVendors()
    $('cpVendor').value = vendorIdForCurrent()
    onVendorPick()
    // 1.5 思考力度：按当前厂商支持的模型清单决定是否露出
    try {
      const ex = await A.providerExtras()
      if (ex) {
        $('cpEffort').value = ex.reasoningEffort || 'none'
        $('cpEffort').disabled = !(ex.effortModels && ex.effortModels.length)
        $('cpEffortHint').textContent = (ex.effortModels && ex.effortModels.length)
          ? ''
          : t('api.effortUnsupported')
      }
    } catch {}
    // 1.9 用量图表 + 7.8 自启状态
    usageRefresh()
    // 0.18.0 第二批：联网搜索配置回填
    try {
      if (typeof A.webGet === 'function') {
        const w = await A.webGet()
        const ww = (w && w.web) || {}
        $('cpWebProvider').value = ww.provider || 'duckduckgo'
        $('cpWebSearx').value = ww.searxngUrl || ''
        $('cpWebTavily').value = ww.tavilyKey || ''
        $('cpWebCount').value = Number(ww.maxResults) || 5
      }
    } catch {}
    try {
      const asr = await A.autostartGet()
      $('cpAutostart').checked = !!(asr && asr.enabled)
    } catch {}
  }
  $('cpVision').checked = cs.visionOn !== false
  // 0.25.0 用量页：币种与汇率跟着设置走（只影响显示）
  if ($('uCur')) {
    U.currency = String(cs.usageCurrency || 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY'
    $('uCur').value = U.currency
  }
  if ($('uRate')) {
    U.rate = Number(cs.usageRate) > 0 ? Number(cs.usageRate) : 7.2
    $('uRate').value = U.rate
  }
  $('cpPetOn').checked = cs.petOn !== false
  $('cpReadReply').checked = cs.readReply !== false
  $('cpPetWalk').value = cs.petWalk || 'off'
  $('cpPetFullscreen').checked = cs.petFullscreenHide !== false
  $('cpPetScale').value = Math.round((cs.petScale != null ? cs.petScale : 1) * 100)
  $('cpPetScaleV').textContent = ($('cpPetScale').value / 100).toFixed(1) + '×'
  // 0.18.0 M3 屏幕监控陪伴（0.42.0：只剩一个「每小时大约几次」的旋钮）
  $('cpWatch').checked = cs.watchEnabled === true
  $('cpProactivePerHour').value = Number(cs.proactivePerHour != null ? cs.proactivePerHour : cs.watchMaxPerHour) || 3
  $('cpWatchQuiet').checked = cs.watchQuiet === true
  if ($('cpWatchSame')) $('cpWatchSame').checked = cs.watchSkipSame !== false
  // 0.18.0 M9 时间观念
  $('cpTsOn').checked = cs.timeSenseOn !== false
  $('cpTsAway').value = Number(cs.tsAwayMin) || 15
  $('cpTsWork').value = Number(cs.tsWorkMin) || 90
  $('cpTsSleepNudge').checked = cs.tsSleepNudge !== false
  $('cpTsMorning').checked = cs.tsMorning !== false
  watchTipRefresh(cs)
  // 5.5 悬停按钮设置已随功能移除（0.45.29）
  // 0.18.0 第一批：气泡滑块 / 帧率 / 状态气泡 / 音效 / 说话声
  const bs = Math.round((cs.petBubbleScale != null ? cs.petBubbleScale : 1) * 100)
  const fs2 = Math.round((cs.petFontScale != null ? cs.petFontScale : 1) * 100)
  $('cpBubbleScale').value = bs
  $('cpBubbleScaleV').textContent = bs + '%'
  $('cpFontScale').value = fs2
  $('cpFontScaleV').textContent = fs2 + '%'
  $('cpPetFps').value = String(cs.petFps || 30)
  $('cpStatusBubble').checked = cs.petStatusBubble !== false
  $('cpInputBubble').checked = cs.petInputBubble !== false
  $('cpSoundOn').checked = cs.petSound !== false
  // 0.45.39 兜底默认与 pet.js 同步：自动音（move/ui/snore）默认关
  const kinds = Array.isArray(cs.petSoundKinds) ? cs.petSoundKinds : ['touch', 'face', 'alarm']
  for (const box of document.querySelectorAll('#cpSoundKinds input[data-skind]')) {
    box.checked = kinds.includes(box.dataset.skind)
  }
  $('cpSpeechOn').checked = cs.petSpeechOn === true
  $('cpSpeechPitch').value = cs.petSpeechPitch || 'mid'
  $('cpSpeechRate').value = cs.petSpeechRate || 'mid'
  // 0.19.0 回应模式
  $('cpReactionMode').value = cs.reactionMode || 'active'
  const rtypes = Array.isArray(cs.reactionTypes) ? cs.reactionTypes : ['pet', 'poke', 'drop', 'throw']
  for (const box of document.querySelectorAll('#cpReactionTypes input[data-rtype]')) {
    box.checked = rtypes.includes(box.dataset.rtype)
  }
  // 0.21.0 她的内心：负反馈开关 / 历史字符预算 / 上下文诊断
  if ($('cpFeedbackMode')) $('cpFeedbackMode').checked = cs.feedbackMode !== 'off'
  if ($('cpHistoryChars')) $('cpHistoryChars').value = cs.historyChars > 0 ? cs.historyChars : 18000
  if ($('cpDiagContext')) $('cpDiagContext').checked = cs.diagContext === true
  if ($('cpIdleNudge')) $('cpIdleNudge').checked = cs.idleNudgeOn !== false
  if ($('cpChatterBoost')) $('cpChatterBoost').checked = cs.chatterBoostOn === true
  if ($('cpChatterVoice')) $('cpChatterVoice').checked = cs.chatterVoiceOn !== false
  interactRefresh().catch(() => { })
  syncReactionVisible()
  syncSpeechVisible()
  alarmRefresh()
  $('cpReplyLang').value = cs.replyLang || 'zh'
  $('cpSubLang').value = cs.subLang || 'off'
  // 0.18.0 M8 自设（用户资料）
  const up = cs.userProfile || {}
  $('cpUserAddress').value = up.address || ''
  $('cpUserPortrait').value = up.portrait || ''
  $('cpUserRelation').value = up.relationship || ''
  $('cpUserInteraction').value = up.interaction || ''
  $('cpUserBoundaries').value = up.boundaries || ''
  $('cpTtsMode').value = cs.ttsMode || 'browser'
  $('cpTtsProvider').value = cs.ttsProvider || 'openai'
  $('cpTtsBase').value = cs.ttsBaseUrl || ''
  $('cpTtsModel').value = cs.ttsModel || ''
  $('cpTtsKey').value = cs.ttsApiKey || ''
  // 音色跟角色卡走（0.18.0）：设置页只剩共用默认，音色在角色卡「人设」里编辑
  fillSysVoices()
  $('cpTtsRefAudio').value = cs.ttsRefAudio || ''
  $('cpTtsPromptText').value = cs.ttsPromptText || ''
  $('cpFishBase').value = cs.fishBaseUrl || 'https://api.fish.audio/v1/tts'
  $('cpFishModel').value = cs.fishModel || 's2.1-pro-free'
  $('cpFishVoice').value = cs.fishVoiceId || ''
  $('cpFishKey').value = cs.fishApiKey || ''
  $('cpNetProxy').value = cs.netProxy || ''
  $('cpFishKey').value = cs.fishApiKey || ''
  $('cpFishAsmr').value = cs.fishAsmrVoiceId || ''
  $('cpFishFormat').value = cs.fishFormat || 'wav'
  $('cpFishLatency').value = cs.fishLatency || 'normal'
  $('cpFishFeeling').value = cs.fishFeeling || 0
  $('cpFishDensity').value = cs.fishTagDensity || 0
  $('cpSpeed').value = Math.round((cs.ttsSpeed || 1) * 100)
  syncFishLabels()
  // S7：界面语言 / 双模式 + 高级项显隐（标准模式藏 [data-adv]）
  try { $('cpUiLang').value = (localStorage.getItem(UI_LANG_KEY) || cs.uiLang || 'auto') } catch { $('cpUiLang').value = 'auto' }
  for (const b of $('uiModeSeg').children) b.classList.toggle('on', b.dataset.m === uiMode)
  syncSettingsVisible()
  $('cpAsrBase').value = cs.asrBaseUrl || ''
  $('cpAsrModel').value = cs.asrModel || 'whisper-1'
  $('cpAsrKey').value = cs.asrApiKey || ''
  $('cpAsrLang').value = cs.asrLang || 'auto'
  // 2.1-2.4 收音模式 / 识别方式 / 本地模型 / 打断 / 繁→简
  $('cpMicMode').value = cs.micMode || 'always'
  $('cpAsrProvider').value = cs.asrProvider || 'cloud'
  $('cpAsrLocalModel').value = cs.asrLocalModel || 'small'
  $('cpOpencc').checked = cs.openccOn === true
  if ($('cpSovits')) $('cpSovits').checked = cs.sovitsOn !== false
  if ($('cpIndexTts')) $('cpIndexTts').checked = cs.indexTtsOn !== false
  // 0.22.0 补丁⑧ 学习模式
  if ($('cpStudyOn')) $('cpStudyOn').checked = cs.studyOn !== false
  if ($('cpStudyAutoOn')) $('cpStudyAutoOn').checked = cs.studyAutoOn !== false
  if ($('cpDreamOn')) $('cpDreamOn').checked = cs.dreamOn !== false
  if ($('cpDreamHours')) $('cpDreamHours').value = Number(cs.dreamIdleHours) || 3
  if ($('cpDreamAuto')) $('cpDreamAuto').checked = cs.dreamAutoApprove === true
  if ($('cpStyleOn')) $('cpStyleOn').checked = cs.styleOn !== false
  // 第 3 期：她的工具自迭代
  if ($('cpUToolsOn')) $('cpUToolsOn').checked = cs.userToolsOn === true
  if ($('cpUToolsList')) loadUToolsPanel()
  // 0.24.0 健康记录
  if ($('cpHealthOn')) $('cpHealthOn').checked = cs.healthOn !== false
  if ($('cpHdDate') && !$('cpHdDate').value) $('cpHdDate').value = pcTodayStr()
  healthRefresh()
  // 0.24.0 电脑画像
  if ($('cpPcOn')) $('cpPcOn').checked = cs.pcProfileOn === true
  // 0.44.0 键盘与输入内容
  if ($('cpKeyOn')) $('cpKeyOn').checked = cs.keyLogOn === true
  if ($('cpAuto')) $('cpAuto').checked = cs.autonomyOn === true
  // 0.45.0 自主活动三挡位
  pcSyncAutoLevels(cs)
  if ($('cpAutoDir')) $('cpAutoDir').value = String(cs.autonomyDir || '')
  // 0.45.2 空闲阈值可调（分钟）
  if ($('cpAutoIdle')) $('cpAutoIdle').value = Number(cs.autonomyIdleMin) || 5
  // 0.45.14 每场最长分钟 / 每天最多场次
  if ($('cpAutoMax')) $('cpAutoMax').value = Number(cs.autonomyMaxMin) || 20
  if ($('cpAutoCount')) $('cpAutoCount').value = Number(cs.autonomyDailyMax) || 6
  if ($('cpPcDays')) $('cpPcDays').value = Number(cs.pcProfileDays) || 14
  pcRefreshPanel(cs.pcProfileStatus)
  pcAutoRefresh().catch(() => { })
  // 0.34.0 陪看字幕
  if ($('cpStOn')) $('cpStOn').checked = cs.screenTextOn === true
  // 0.36.0 语义判读（默认开）
  if ($('cpJudgeOn')) $('cpJudgeOn').checked = cs.judgeOn !== false
  // 0.37.0 她自己待着（默认开）
  if ($('cpCurio')) $('cpCurio').checked = cs.curiosityOn !== false
  if ($('cpStInterval')) $('cpStInterval').value = Number(cs.screenTextInterval) || 1200
  if ($('cpStHideSelf')) $('cpStHideSelf').checked = cs.screenTextHideSelf !== false
  screenTextRectText(cs.screenTextRect)
  screenTextRefresh()
  // 0.24.0 随身服务：地址/口令展示（打开开关并保存后才生成）
  if ($('cpRemoteOn')) $('cpRemoteOn').checked = cs.remoteOn === true
  if ($('cpRemotePort')) $('cpRemotePort').value = Number(cs.remotePort) || 8720
  if ($('cpStreamFps')) $('cpStreamFps').value = Number(cs.remoteStreamFps) || 10
  if ($('cpStreamQ')) $('cpStreamQ').value = Number(cs.remoteStreamQ) || 75
  if ($('cpStreamH')) $('cpStreamH').value = String([0, 720, 1080, 1440].includes(Number(cs.remoteStreamH)) ? Number(cs.remoteStreamH) : 1080)
  if ($('cpRemoteAddr')) $('cpRemoteAddr').textContent = remoteAddrText(cs)
  if ($('cpRemoteToken')) $('cpRemoteToken').textContent = cs.remoteToken || '（同上）'
  if ($('cpStudyMin')) $('cpStudyMin').value = Number(cs.studyMinutes) || 45
  if ($('cpStudyBreak')) $('cpStudyBreak').value = Number(cs.studyBreak) || 10
  if ($('cpStudyRounds')) $('cpStudyRounds').value = Number(cs.studyRounds) || 3
  if ($('cpStudyPenalty')) $('cpStudyPenalty').value = cs.studyPenaltyMin != null ? Number(cs.studyPenaltyMin) : 5
  if ($('cpStudyEssayOn')) $('cpStudyEssayOn').checked = cs.studyEssayOn === true
  if ($('cpStudyEssayWords')) $('cpStudyEssayWords').value = Number(cs.studyEssayWords) || 1000
  $('cpInterrupt').checked = cs.interruptOn === true
  syncAsrVisible()
  // S6.5 电脑操作权限：默认「问一次」（30 分钟内不再打扰），想完全安静就选「从不询问」
  $('cpPermMode').value = cs.permMode || 'ask-once'
  $('cpTerminalAsk').checked = cs.permTerminalAsk !== false
  $('cpPermAllowApps').value = Array.isArray(cs.permAllowApps) ? cs.permAllowApps.join(', ') : String(cs.permAllowApps || '')
  // 回填完再算一次朗读闸（回填时 cpReadReply / cpTtsMode 才刚有值）
  if (typeof syncReadGate === 'function') syncReadGate()
  // 0.22.0 补丁⑥：从 AuraDesk 残留设置窗口迁来的四块（她的记录/负反馈/快捷键/OBS/数据目录）
  if ($('cpMindState')) loadMindPanel()
  if ($('cpFbStat')) loadFbPanel()
  if ($('cpCurioStat')) loadCurioPanel()
  if ($('studyState')) studyPaint()
  if ($('cpHkToggle')) loadGlobalPanel()
  if ($('cpObsUrl')) loadObsPanel()
  if ($('cpDdPath')) loadDatadirPanel()
}
/* ============ 0.22.0 补丁⑥：自 AuraDesk 残留设置窗口迁入的面板 ============
 * 她的记录（日记/归纳）+ 负反馈（情绪/回滚/翻旧账）：走 mind:* 通道（主进程已有实现）
 * 快捷键 / OBS / 数据目录：走 settings:patch-global、datadir:*、obs:* 既有通道 */
const G = window.companion || {}
/** 新通道在旧 jsdom/旧主进程里可能不存在：统一走 inv，不存在时返回 reject（调用方都有 catch） */
const inv = (name, ...args) => (typeof G[name] === 'function' ? G[name](...args) : Promise.reject(new Error('unavailable:' + name)))

/** 第 3 期：她的工具面板（批准部署 / 停用 / 删除） */
async function loadUToolsPanel () {
  const el = $('cpUToolsList')
  if (!el) return
  const r = await inv('utList').catch(() => null)
  const list = (r && r.tools) || []
  el.textContent = ''
  if (!list.length) { el.textContent = t('ut.empty'); return }
  for (const it of list) {
    const row = document.createElement('div')
    row.style.marginBottom = '6px'
    const head = document.createElement('div')
    const tag = it.enabled ? t('ut.enabledTag') : t('ut.disabledTag')
    head.textContent = tag + ' ' + it.name + ' v' + (it.version || 1) + (it.description ? ' — ' + it.description : '')
    row.appendChild(head)
    const bar = document.createElement('div')
    bar.style.cssText = 'display:flex;gap:6px;margin-top:3px;flex-wrap:wrap'
    const mk = (label, fn) => {
      const b = document.createElement('button')
      b.className = 'cd-btn'; b.textContent = label
      b.onclick = async () => { b.disabled = true; await inv('utDecide', it.name, fn).catch(() => null); b.disabled = false; await loadUToolsPanel() }
      bar.appendChild(b)
    }
    if (it.hasFile) {
      if (!it.enabled) mk(t('ut.enable'), 'enable')
      else mk(t('ut.disable'), 'disable')
    }
    mk(t('ut.delete'), 'delete')
    row.appendChild(bar)
    el.appendChild(row)
  }
}

async function loadMindPanel () {
  const fmtState = (r) => {
    const st = r.state || {}
    const tt = r.today || {}
    const bits = []
    if (st.quiet >= 0.55) bits.push(t('mind.stQuietHard'))
    else if (st.quiet >= 0.3) bits.push(t('mind.stQuiet'))
    else bits.push(t('mind.stCalm'))
    if (st.cold >= 0.3) bits.push(t('mind.stCold'))
    if ((st.ignoreStreak || 0) >= 3) bits.push(t('mind.stIgnored'))
    bits.push(t('mind.stToday').replace('{s}', tt.says || 0).replace('{a}', tt.answered || 0))
    return bits.join(' · ')
  }
  const fmtTraits = (r) => {
    const bits = []
    for (const h of r.habits || []) bits.push(t('mind.habit') + h.desc)
    for (const x of r.tastes || []) {
      bits.push((x.kind === 'hate' ? t('mind.hate') : t('mind.like')) + x.what + (x.reason ? '（' + x.reason + '）' : ''))
    }
    return bits.length ? bits.map((x) => '· ' + x).join('\n') : t('mind.noTraits')
  }
  const fmtDays = (r) => {
    const list = r.days || []
    if (!list.length) return t('mind.noDays')
    return list.map((d) => '［' + d.date + '］\n' + d.text).join('\n\n')
  }
  const loadMind = async () => {
    const r = await inv('mindSnapshot').catch(() => null)
    const se = $('cpMindState'); if (!se) return
    if (!r || !r.ok) { se.textContent = t('mind.readFail') + ((r && r.error) || ''); return }
    se.textContent = (r.charName ? r.charName + ' · ' : '') + fmtState(r)
    $('cpMindTraits').textContent = fmtTraits(r)
    $('cpMindDays').textContent = fmtDays(r)
    $('cpMindGrowth').textContent = String(r.growth || '').trim() || t('mind.noGrowth')
  }
  await loadMind()
  $('cpMindWrite').onclick = async () => {
    const b = $('cpMindWrite'); const old = b.textContent
    b.textContent = t('mind.writing'); b.disabled = true
    const r = await inv('mindWriteNow').catch(() => null)
    b.textContent = old; b.disabled = false
    if (r && r.ok) { await loadMind(); return }
    const se = $('cpMindState')
    if (se) se.textContent = t('mind.writeFail') + ((r && r.error) || '')
  }
  $('cpMindDistill').onclick = async () => {
    const b = $('cpMindDistill'); const old = b.textContent
    b.textContent = t('mind.distilling'); b.disabled = true
    const r = await inv('mindDistillNow').catch(() => null)
    b.textContent = old; b.disabled = false
    if (r && r.ok) { await loadMind(); return }
    const se = $('cpMindState')
    if (se) se.textContent = t('mind.distillFail') + ((r && r.error) || '')
  }
  // ---- 第 1 期：做梦 + 审查队列 ----
  const kindName = (k) => t('review.kind.' + (k === 'taste' || k === 'memory' || k === 'persona' || k === 'fact' ? k : 'habit'))
  const loadDream = async () => {
    const st = await inv('dreamStatus').catch(() => null)
    const el = $('cpDreamStatus')
    if (el) {
      if (st && st.ok && st.lastDream) {
        el.textContent = t('dream.last').replace('{d}', st.lastDream) +
          (st.pending ? ' · ' + t('dream.pendingCount').replace('{n}', st.pending) : '')
      } else el.textContent = t('dream.never')
    }
    const rv = await inv('reviewList').catch(() => null)
    const pend = $('cpReviewPending')
    const rec = $('cpReviewRecent')
    if (pend) {
      pend.textContent = ''
      const list = (rv && rv.pending) || []
      if (!list.length) pend.textContent = t('review.empty')
      for (const it of list) {
        const row = document.createElement('div')
        row.style.marginBottom = '6px'
        if (it.kind === 'persona') {
          // 第 2 期：人格提案卡——「现状 → 想改成」+ 她的证据，视觉上和普通条目分开
          row.style.cssText += ';border:1px solid var(--line,#8884);border-radius:8px;padding:6px 8px;background:var(--card,#8881)'
          const head = document.createElement('div')
          head.style.cssText = 'font-weight:600'
          head.textContent = '[' + kindName(it.kind) + '] ' + (it.aspect || '') + '：' + (it.proposed || it.what || '')
          row.appendChild(head)
          const diff = document.createElement('div')
          diff.style.cssText = 'white-space:pre-wrap;margin-top:2px'
          diff.textContent = t('review.personaDiff')
            .replace('{cur}', it.current || t('review.personaNoCurrent'))
            .replace('{new}', it.proposed || '')
          row.appendChild(diff)
          if (it.evidence || it.reason) {
            const why = document.createElement('div')
            why.style.cssText = 'opacity:.75;margin-top:2px'
            why.textContent = '（' + (it.evidence || it.reason) + '）'
            row.appendChild(why)
          }
        } else {
          row.textContent = '[' + kindName(it.kind) + '] ' + (it.payload || it.what) + (Number(it.votes) > 1 ? ' ×' + it.votes : '') +
            (it.reason ? '\n（' + it.reason + '）' : '')
        }
        const bar = document.createElement('div')
        bar.style.cssText = 'display:flex;gap:6px;margin-top:3px'
        const ok = document.createElement('button'); ok.className = 'cd-btn'; ok.textContent = t('review.approve')
        const no = document.createElement('button'); no.className = 'cd-btn'; no.textContent = t('review.reject')
        ok.onclick = async () => { await inv('reviewDecide', it.id, 'approve').catch(() => null); await loadDream() }
        no.onclick = async () => { await inv('reviewDecide', it.id, 'reject').catch(() => null); await loadDream() }
        bar.appendChild(ok); bar.appendChild(no)
        row.appendChild(bar)
        pend.appendChild(row)
      }
    }
    if (rec) {
      rec.textContent = ''
      const list = (rv && rv.recent) || []
      if (!list.length) rec.textContent = t('review.empty')
      for (const it of list) {
        const row = document.createElement('div')
        row.style.marginBottom = '6px'
        const stTxt = it.status === 'applied' ? t('review.applied') : it.status === 'rolled' ? t('review.rolled')
          : it.status === 'approved' ? t('review.approved') : t('review.rejected')
        row.textContent = '[' + stTxt + '][' + kindName(it.kind) + '] ' + (it.payload || it.what)
        if (it.status === 'applied') {
          const bar = document.createElement('div')
          bar.style.cssText = 'display:flex;gap:6px;margin-top:3px'
          const rb = document.createElement('button'); rb.className = 'cd-btn'; rb.textContent = t('review.rollback')
          rb.onclick = async () => { await inv('reviewRollback', it.id).catch(() => null); await loadDream() }
          bar.appendChild(rb)
          row.appendChild(bar)
        }
        rec.appendChild(row)
      }
    }
  }
  await loadDream()
  const dreamBtn = $('cpDreamNow')
  if (dreamBtn) {
    dreamBtn.onclick = async () => {
      const old = dreamBtn.textContent
      dreamBtn.textContent = t('dream.doing'); dreamBtn.disabled = true
      const r = await inv('dreamNow').catch(() => null)
      dreamBtn.textContent = old; dreamBtn.disabled = false
      if (!r || !r.ok) {
        const el = $('cpDreamStatus')
        if (el) el.textContent = t('dream.fail') + ((r && r.error) || '')
      }
      await loadDream()
      await loadMind()
    }
  }
}

function loadFbPanel () {
  const fmtFb = (d) => {
    if (!d) return t('fb.noData')
    const st = d.state || {}
    const tt = d.today || {}
    const bits = [
      t('fb.quiet') + Math.round((st.quiet || 0) * 100) + '%',
      t('fb.cold') + Math.round((st.cold || 0) * 100) + '%',
      t('fb.mood') + Math.round((st.mood == null ? 0.5 : st.mood) * 100) + '%',
      t('fb.ignoreStreak') + (st.ignoreStreak || 0)
    ]
    let s = bits.join(' · ') + '\n' + t('mind.stToday').replace('{s}', tt.says || 0).replace('{a}', tt.answered || 0)
    s += '\n' + t('fb.feedback') + (d.feedback === 'off' ? t('fb.off') : t('fb.on'))
    s += ' · ' + t('fb.days').replace('{d}', d.days || 0).replace('{i}', d.indexed || 0)
    if (st.rolledBackAt) s += '\n' + t('fb.lastRoll') + new Date(st.rolledBackAt).toLocaleString('zh-CN', { hour12: false })
    return s
  }
  const loadFb = async () => {
    const r = await inv('mindFeedback').catch(() => null)
    const el = $('cpFbStat'); if (!el) return
    el.textContent = (r && r.ok) ? fmtFb(r.data) : (t('fb.readFail') + ((r && r.error) || ''))
  }
  loadFb()
  const doRoll = async (hours, btn) => {
    const old = btn.textContent
    btn.textContent = t('fb.rolling'); btn.disabled = true
    const r = await inv('mindFeedbackRollback', hours).catch(() => null)
    btn.textContent = old; btn.disabled = false
    if (r && r.ok) await loadFb()
    else { const el = $('cpFbStat'); if (el) el.textContent = t('fb.rollFail') }
  }
  $('cpFbRoll6').onclick = () => doRoll(6, $('cpFbRoll6'))
  $('cpFbRoll24').onclick = () => doRoll(24, $('cpFbRoll24'))
  $('cpFbRoll168').onclick = () => doRoll(168, $('cpFbRoll168'))
  $('cpFbReset').onclick = async () => {
    await inv('mindFeedbackReset').catch(() => null)
    await loadFb()
  }
  $('cpFbSearch').onclick = async () => {
    const q = String($('cpFbQuery').value || '').trim()
    const box = $('cpFbHits'); if (!box) return
    if (!q) { box.textContent = t('fb.needWord'); return }
    box.textContent = t('fb.searching')
    const r = await inv('mindRecall', q, 5).catch(() => null)
    const hits = (r && r.ok && r.hits) || []
    if (!hits.length) { box.textContent = t('fb.noHits'); return }
    box.textContent = hits.map((h) => '［' + h.date + '］' + (h.summary || '') + '\n' + String(h.text || '').slice(0, 200)).join('\n\n')
  }
}

/** 0.37.0 她自己待着 + 语义判读：她今天自己做了什么，判读到底在不在跑 */
async function loadCurioPanel () {
  const el = $('cpCurioStat'); if (!el) return
  const r = await inv('mindCuriosity').catch(() => null)
  if (!r || !r.ok || !r.data) { el.textContent = t('curio.readFail') + ((r && r.error) || ''); return }
  const d = r.data
  const hhmm = (ms) => {
    const x = new Date(Number(ms) || 0)
    return String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0')
  }
  const lines = []
  lines.push(d.running
    ? t('curio.count').replace('{n}', String(d.todayCount)).replace('{max}', String(d.maxPerDay))
    : t('curio.off'))
  const recent = Array.isArray(d.recent) ? d.recent : []
  if (recent.length) {
    lines.push(t('curio.recent'))
    for (const it of recent.slice(0, 5)) lines.push('· ' + hhmm(it.at) + ' ' + String(it.text || '').slice(0, 70))
  } else {
    lines.push(t('curio.none'))
  }
  const j = d.judge || null
  if (j) {
    lines.push(t('curio.judge')
      .replace('{ok}', String(j.ok || 0))
      .replace('{fail}', String(j.fail || 0))
      .replace('{cached}', String(j.cached || 0))
      .replace('{skipped}', String(j.skipped || 0)))
  }
  el.textContent = lines.join('\n')
}

async function loadGlobalPanel () {
  // 快捷键：全局配置（settings:patch-global）；主进程收到改动即重挂 globalShortcut
  let g = {}
  try { g = (await inv('globalConfig')) || {}; g = g.global || {} } catch {}
  $('cpHkToggle').value = g.hotkeyToggle || ''
  $('cpHkType').value = g.hotkeyType || ''
  $('cpHkTalk').value = g.hotkeyTalk || ''
  const bind = (inputId, btnId, key) => {
    $(btnId).onclick = async () => {
      const val = $(inputId).value.trim()
      await inv('patchGlobal', { [key]: val })
      $(btnId).textContent = t('hk.saved')
      setTimeout(() => { $(btnId).textContent = t('hk.save') }, 1200)
    }
  }
  bind('cpHkToggle', 'cpHkToggleSave', 'hotkeyToggle')
  bind('cpHkType', 'cpHkTypeSave', 'hotkeyType')
  bind('cpHkTalk', 'cpHkTalkSave', 'hotkeyTalk')
}

async function loadDatadirPanel () {
  const info = await inv('dataDirInfo').catch(() => null)
  const el = $('cpDdPath')
  if (el) el.textContent = info ? (info.root + (info.portable ? t('dd.portable') : '')) : t('dd.readFail')
  if ($('cpDdOpen')) $('cpDdOpen').onclick = () => inv('dataDirOpen').catch(() => {})
  if ($('cpDdPick')) {
    $('cpDdPick').onclick = async () => {
      const r = await inv('dataDirPick').catch(() => null)
      if (r && r.error) { const e = $('cpDdPath'); if (e) e.textContent = r.error }
    }
  }
}

function loadObsPanel () {
  const showObs = (st) => {
    const el = $('cpObsUrl'); if (!el) return
    if (!st || !st.running) {
      el.textContent = st && st.lastError ? (t('pet.obsNotRun') + st.lastError) : t('pet.obsStopped')
      return
    }
    const watching = st.clients > 0 ? (t('pet.obsClients').replace('{n}', st.clients)) : t('pet.obsNoClient')
    el.textContent = st.url + ' · ' + st.fps + 'fps' + watching
  }
  const fillScreens = async () => {
    const sel = $('cpObsScreen'); if (!sel) return
    let data = { displays: [] }
    try { data = (await inv('displays')) || { displays: [] } } catch {}
    const cfg = ((await inv('globalConfig').catch(() => null)) || {}).global || {}
    const g = cfg || {}
    if ($('cpObs')) $('cpObs').checked = g.obsEnabled === true
    if ($('cpObsPort')) $('cpObsPort').value = g.obsPort || 8712
    if ($('cpObsFps')) $('cpObsFps').value = String(Number(g.obsFps) || 10)
    const cur = g.obsScreen || ''
    sel.innerHTML = '<option value="">' + t('pet.obsFollow') + '</option>' +
      (data.displays || []).map((d, i) =>
        '<option value="' + d.key + '"' + (cur === d.key ? ' selected' : '') + '>' +
        (d.primary ? t('pet.obsPrimary') : (t('pet.obsDisplay') + (i + 1))) + '</option>').join('')
  }
  fillScreens()
  Promise.resolve(inv('obsStatus')).then((st) => {
    if ($('cpObsUrl')) showObs(st)
  }).catch(() => {})
  if ($('cpObsOpen')) $('cpObsOpen').onclick = async () => { showObs(await inv('obsOpen')) }
  if ($('cpObsPortSave')) {
    $('cpObsPortSave').onclick = async () => {
      const n = Number($('cpObsPort').value)
      if (!(n >= 1024 && n <= 65535)) { $('cpObsUrl').textContent = t('pet.obsPortRange'); return }
      await inv('patchGlobal', { obsPort: n })
      showObs(await inv('obsStatus'))
    }
  }
  if ($('cpObsFps')) {
    $('cpObsFps').onchange = async () => { await inv('patchGlobal', { obsFps: Number($('cpObsFps').value) }) }
  }
  if ($('cpObsScreen')) {
    $('cpObsScreen').onchange = async () => { await inv('patchGlobal', { obsScreen: $('cpObsScreen').value }) }
  }
  if ($('cpObs')) {
    $('cpObs').onchange = async () => {
      await inv('patchGlobal', { obsEnabled: $('cpObs').checked })
      // 服务重启要一两秒，晚点读状态
      setTimeout(async () => { try { showObs(await inv('obsStatus')) } catch {} }, 1500)
    }
  }
}
function syncFishLabels () {
  $('cpFishFeelingV').textContent = $('cpFishFeeling').value
  $('cpFishDensityV').textContent = $('cpFishDensity').value
  $('cpSpeedV').textContent = ($('cpSpeed').value / 100).toFixed(1)
}
/** Fish 专属字段只选 Fish 时显示；OpenAI 兼容字段只选 openai 时显示 */
function syncFishVisible () {
  const p = $('cpTtsProvider').value
  $('cpFish').hidden = p !== 'fish'
  $('cpTtsBase').hidden = p !== 'openai'
  $('cpTtsRefAudio').hidden = p !== 'gptsovits'
  $('cpTtsPromptText').hidden = p !== 'gptsovits'
}
/** 2.2 识别方式联动：云端显示端点三件套，本地显示模型名 */
function syncAsrVisible () {
  const local = $('cpAsrProvider').value === 'local'
  const cloud = $('cpAsrCloudRows')
  if (cloud) cloud.hidden = local
  const lm = $('cpAsrLocalModel')
  if (lm) lm.hidden = !local
}
/** S7 normal/advanced 双模式（只隐藏不卸载）：
 * 标准模式把所有 [data-adv] 藏起来；高级模式全显示。
 * 必须先跑 syncFishVisible（provider/模式联动），再叠加高级隐藏——
 * 顺序反了会把该藏的项（如 provider 不是 openai 时的 TTS 地址）在标准模式下亮出来 */
function syncSettingsVisible () {
  syncFishVisible()
  syncAsrVisible()
  if (uiMode !== 'advanced') {
    for (const el of document.querySelectorAll('[data-adv]')) el.hidden = true
  } else {
    for (const el of document.querySelectorAll('[data-adv]')) el.hidden = false
    syncFishVisible()
    syncAsrVisible()
  }
}
/** 枚举本机全部系统语音（中日英法…都有），音色可与回复语言不同——填进角色卡编辑器 */
function fillSysVoices () {
  const sel = $('fVoiceSys')
  if (!sel || !window.speechSynthesis) return
  const list = speechSynthesis.getVoices()
  if (!list.length) return
  const cur = sel.value
  sel.innerHTML = '<option value="">自动（跟随回复语言）</option>' +
    list.map((v) => '<option value="' + String(v.name).replace(/"/g, '&quot;') + '">' + v.name + '（' + v.lang + '）</option>').join('')
  sel.value = cur || ''
}
if (window.speechSynthesis) {
  speechSynthesis.onvoiceschanged = fillSysVoices
  setTimeout(fillSysVoices, 300)
}
const cpGather = () => ({
  apiBaseUrl: $('cpApiBase').value.trim(),
  apiKey: $('cpApiKey').value.trim(),
  apiModel: $('cpApiModel').value.trim(),
  visionOn: $('cpVision').checked,
  petOn: $('cpPetOn').checked,
  readReply: $('cpReadReply').checked,
  petWalk: $('cpPetWalk').value,
  petFullscreenHide: $('cpPetFullscreen').checked,
  petScale: Number($('cpPetScale').value) / 100,
  // 5.5 悬停按钮设置已随功能移除（0.45.29）
  // 0.18.0 第一批：气泡 / 帧率 / 状态气泡 / 音效 / 说话声
  petBubbleScale: Number($('cpBubbleScale').value) / 100,
  petFontScale: Number($('cpFontScale').value) / 100,
  petFps: Number($('cpPetFps').value) || 30,
  petStatusBubble: $('cpStatusBubble').checked,
  petInputBubble: $('cpInputBubble').checked,
  petSound: $('cpSoundOn').checked,
  petSoundKinds: [...document.querySelectorAll('#cpSoundKinds input[data-skind]:checked')].map((b) => b.dataset.skind),
  petSpeechOn: $('cpSpeechOn').checked,
  petSpeechPitch: $('cpSpeechPitch').value,
  petSpeechRate: $('cpSpeechRate').value,
  // 0.19.0 回应模式（安静/自定义模式下 main 侧只记着互动，等下次开口一起回应）
  reactionMode: $('cpReactionMode').value,
  reactionTypes: [...document.querySelectorAll('#cpReactionTypes input[data-rtype]:checked')].map((b) => b.dataset.rtype),
  // 0.21.0 她的内心
  feedbackMode: $('cpFeedbackMode').checked ? 'on' : 'off',
  historyChars: Number($('cpHistoryChars').value) || 18000,
  diagContext: $('cpDiagContext').checked,
  idleNudgeOn: $('cpIdleNudge').checked,
  chatterBoostOn: $('cpChatterBoost') ? $('cpChatterBoost').checked : false,
  chatterVoiceOn: $('cpChatterVoice') ? $('cpChatterVoice').checked : true,
  watchEnabled: $('cpWatch').checked,
  proactivePerHour: Number($('cpProactivePerHour').value) || 3,
  watchQuiet: $('cpWatchQuiet').checked,
  watchSkipSame: $('cpWatchSame') ? $('cpWatchSame').checked : true,
  // 0.18.0 M9 时间观念
  timeSenseOn: $('cpTsOn').checked,
  tsAwayMin: Number($('cpTsAway').value) || 15,
  tsWorkMin: Number($('cpTsWork').value) || 90,
  tsSleepNudge: $('cpTsSleepNudge').checked,
  tsMorning: $('cpTsMorning').checked,
  replyLang: $('cpReplyLang').value,
  subLang: $('cpSubLang').value,
  // 0.18.0 M8 自设（用户资料）
  userProfile: {
    address: $('cpUserAddress').value.trim(),
    portrait: $('cpUserPortrait').value.trim(),
    relationship: $('cpUserRelation').value.trim(),
    interaction: $('cpUserInteraction').value.trim(),
    boundaries: $('cpUserBoundaries').value.trim()
  },
  ttsMode: $('cpTtsMode').value,
  ttsProvider: $('cpTtsProvider').value,
  ttsBaseUrl: $('cpTtsBase').value.trim(),
  ttsModel: $('cpTtsModel').value.trim(),
  ttsApiKey: $('cpTtsKey').value.trim(),
  // 音色（ttsVoice/sysVoiceName）跟角色卡走，不再从设置页写全局——保留旧全局值作兜底
  ttsRefAudio: $('cpTtsRefAudio').value.trim(),
  ttsPromptText: $('cpTtsPromptText').value.trim(),
  ttsSpeed: $('cpSpeed').value / 100,
  fishBaseUrl: $('cpFishBase').value.trim() || 'https://api.fish.audio/v1/tts',
  fishApiKey: $('cpFishKey').value.trim(),
  netProxy: $('cpNetProxy').value.trim(),
  fishModel: $('cpFishModel').value.trim() || 's2.1-pro-free',
  fishVoiceId: $('cpFishVoice').value.trim(),
  fishAsmrVoiceId: $('cpFishAsmr').value.trim(),
  fishFormat: $('cpFishFormat').value,
  fishLatency: $('cpFishLatency').value,
  fishFeeling: Number($('cpFishFeeling').value) || 0,
  fishTagDensity: Number($('cpFishDensity').value) || 0,
  asrBaseUrl: $('cpAsrBase').value.trim(),
  asrModel: $('cpAsrModel').value.trim(),
  asrLang: $('cpAsrLang').value,
  asrApiKey: $('cpAsrKey').value.trim(),
  // 2.1-2.4 语音：收音模式 / 识别方式 / 本地模型 / 打断 / 繁→简
  micMode: $('cpMicMode').value,
  asrProvider: $('cpAsrProvider').value,
  asrLocalModel: $('cpAsrLocalModel').value.trim() || 'small',
  openccOn: $('cpOpencc').checked,
  sovitsOn: $('cpSovits') ? $('cpSovits').checked : true,
  indexTtsOn: $('cpIndexTts').checked,
  // 0.22.0 补丁⑧ 学习模式
  studyOn: $('cpStudyOn') ? $('cpStudyOn').checked : true,
  studyAutoOn: $('cpStudyAutoOn') ? $('cpStudyAutoOn').checked : true,
  dreamOn: $('cpDreamOn') ? $('cpDreamOn').checked : true,
  dreamIdleHours: Math.round(Number($('cpDreamHours') && $('cpDreamHours').value) || 3),
  dreamAutoApprove: $('cpDreamAuto') ? $('cpDreamAuto').checked : false,
  userToolsOn: $('cpUToolsOn') ? $('cpUToolsOn').checked : false,
  // 0.24.0 健康记录
  healthOn: $('cpHealthOn') ? $('cpHealthOn').checked : true,
  // 0.24.0 电脑画像
  pcProfileOn: $('cpPcOn') ? $('cpPcOn').checked : false,
  keyLogOn: $('cpKeyOn') ? $('cpKeyOn').checked : false,
  autonomyOn: $('cpAuto') ? $('cpAuto').checked : false,
  autonomyLevel: (() => {
    const el = document.querySelector('input[name="cpAutoLevel"]:checked')
    return el ? Number(el.value) || 1 : 1
  })(),
  autonomyDir: $('cpAutoDir') ? $('cpAutoDir').value.trim() : '',
  // 0.45.2 空闲阈值（分钟，1~120）
  autonomyIdleMin: Math.round(Math.min(120, Math.max(1, Number($('cpAutoIdle') && $('cpAutoIdle').value) || 5))),
  // 0.45.14 每场最长（分钟，1~30）/ 每天最多（场，1~48）
  autonomyMaxMin: Math.round(Math.min(60, Math.max(1, Number($('cpAutoMax') && $('cpAutoMax').value) || 20))),
  autonomyDailyMax: Math.round(Math.min(48, Math.max(1, Number($('cpAutoCount') && $('cpAutoCount').value) || 6))),
  pcProfileDays: Math.round(Number($('cpPcDays') && $('cpPcDays').value) || 14),
  // 0.34.0 陪看字幕（字幕框 screenTextRect 只由「框字幕」写，这里不碰）
  screenTextOn: $('cpStOn') ? $('cpStOn').checked : false,
  judgeOn: $('cpJudgeOn') ? $('cpJudgeOn').checked : true,
  // 0.37.0 她自己待着
  curiosityOn: $('cpCurio') ? $('cpCurio').checked : true,
  screenTextInterval: Math.round(Number($('cpStInterval') && $('cpStInterval').value) || 1200),
  screenTextHideSelf: $('cpStHideSelf') ? $('cpStHideSelf').checked : true,
  // 0.24.0 随身服务
  remoteOn: $('cpRemoteOn') ? $('cpRemoteOn').checked : false,
  remotePort: Math.round(Number($('cpRemotePort') && $('cpRemotePort').value) || 8720),
  remoteStreamFps: Math.round(Number($('cpStreamFps') && $('cpStreamFps').value) || 10),
  remoteStreamQ: Math.round(Number($('cpStreamQ') && $('cpStreamQ').value) || 75),
  remoteStreamH: Number($('cpStreamH') && $('cpStreamH').value),
  styleOn: $('cpStyleOn') ? $('cpStyleOn').checked : true,
  studyMinutes: Math.round(Number($('cpStudyMin') && $('cpStudyMin').value) || 45),
  studyBreak: Math.round(Number($('cpStudyBreak') && $('cpStudyBreak').value) || 10),
  studyRounds: Math.round(Number($('cpStudyRounds') && $('cpStudyRounds').value) || 3),
  // 0.45.69：补时（0=关闭）+ 申论字数检查（选择性）。
  // 输入框被清空 ≠ 关闭补时：空值回落到默认 5，只有明确填 0 才是关
  studyPenaltyMin: (() => {
    const raw = $('cpStudyPenalty') ? String($('cpStudyPenalty').value).trim() : ''
    if (raw === '') return 5
    return Math.max(0, Math.min(30, Math.round(Number(raw) || 0)))
  })(),
  studyEssayOn: $('cpStudyEssayOn') ? $('cpStudyEssayOn').checked : false,
  studyEssayWords: Math.max(200, Math.min(5000, Math.round(Number($('cpStudyEssayWords') && $('cpStudyEssayWords').value) || 1000))),
  interruptOn: $('cpInterrupt').checked,
  // S6.5：电脑操作权限档位 + 允许名单
  permMode: $('cpPermMode').value,
  permTerminalAsk: $('cpTerminalAsk').checked,
  permAllowApps: $('cpPermAllowApps').value.trim()
})
async function cpSave () {
  await window.companion.patchSettings(cpGather())
  // 模型接入只有一处：同步写进助手核心的 provider（聊天实际调用的是这一份）
  // S7：厂商预设还带协议类型（openai/anthropic/gemini）；自定义地址保持原类型不动
  if (A) {
    try {
      const picked = VENDOR_LIST.find((x) => x.id === $('cpVendor').value)
      const patch = {
        baseUrl: $('cpApiBase').value.trim(),
        model: $('cpApiModel').value.trim(),
        apiKey: $('cpApiKey').value.trim(),
        reasoningEffort: $('cpEffort').value || 'none'
      }
      if (picked) patch.type = picked.type
      await A.providerSet(patch)
      // 0.18.0 第二批：联网搜索后端（web_search）——key/地址只落本地 config.json
      if (typeof A.webSet === 'function') {
        await A.webSet({
          provider: $('cpWebProvider').value,
          searxngUrl: $('cpWebSearx').value.trim(),
          tavilyKey: $('cpWebTavily').value.trim(),
          maxResults: Number($('cpWebCount').value) || 5
        })
      }
    } catch (e) { console.warn('[provider sync]', e && e.message) }
  }
  $('cpSaveTip').textContent = t('save.ok') + new Date().toLocaleTimeString('zh-CN', { hour12: false })
  setTimeout(() => { $('cpSaveTip').textContent = '' }, 3000)
  // 0.24.0 随身服务：保存后立刻回读状态刷新地址/口令（服务启动是异步的，1.2s 后再兜一轮）
  remoteInfoRefresh()
  setTimeout(remoteInfoRefresh, 1200)
}

/** 随身服务地址/口令：只动这四个元素，不碰表单其它字段（正在输入的内容不受影响） */
async function remoteInfoRefresh () {
  if (!$('cpRemoteAddr')) return
  let cs = {}
  try { cs = await window.companion.settings() } catch { return }
  if ($('cpRemoteOn')) $('cpRemoteOn').checked = cs.remoteOn === true
  if ($('cpRemotePort') && document.activeElement !== $('cpRemotePort')) $('cpRemotePort').value = Number(cs.remotePort) || 8720
  if ($('cpStreamFps') && document.activeElement !== $('cpStreamFps')) $('cpStreamFps').value = Number(cs.remoteStreamFps) || 10
  if ($('cpStreamQ') && document.activeElement !== $('cpStreamQ')) $('cpStreamQ').value = Number(cs.remoteStreamQ) || 75
  if ($('cpStreamH')) $('cpStreamH').value = String([0, 720, 1080, 1440].includes(Number(cs.remoteStreamH)) ? Number(cs.remoteStreamH) : 1080)
  $('cpRemoteAddr').textContent = remoteAddrText(cs)
  if ($('cpRemoteToken')) $('cpRemoteToken').textContent = cs.remoteToken || '（同上）'
}

/** 两个入口：http（看/聊，直接开）+ ts.net 真证书（语音/摄像头，浏览器完全信任）/ 自签 https（首次要点继续前往） */
function remoteAddrText (cs) {
  if (!cs.remoteRunning) return t('remote.addrPending')
  const host = cs.remoteTsIp || '127.0.0.1'
  const token = cs.remoteToken || ''
  const port = Number(cs.remotePort) || 8720
  const tls = Number(cs.remoteTlsPort) || 0
  const lines = ['http://' + host + ':' + port + '/?t=' + token + '（看她/聊天）']
  if (cs.remoteTsFqdn) lines.push('https://' + cs.remoteTsFqdn + '/?t=' + token + '（语音/摄像头，真证书无警告）')
  else if (tls) lines.push('https://' + host + ':' + tls + '/?t=' + token + '（语音/摄像头，首次点「高级→继续前往」）')
  return lines.join('\n')
}
// 0.42.0：屏幕陪伴的提示行——现在只说「她大概多久会开口一次」，
// 不再展示「每 N 秒看一眼」这类内部节拍（那是实现细节，不是用户该调节的东西）
function watchTipRefresh (cs) {
  const el = $('cpWatchTip')
  if (!el) return
  if (!$('cpWatch').checked) { el.textContent = t('watch.offTip'); return }
  const per = Number($('cpProactivePerHour').value) || 3
  const q = $('cpWatchQuiet').checked
  const avg = Math.max(1, Math.round(60 / Math.max(1, per)))
  el.textContent = String(t('watch.onTip') || '')
    .replace('{per}', String(per))
    .replace('{avg}', String(avg)) + (q ? ' ' + t('watch.quietOn') : '')
}
;['cpWatch', 'cpProactivePerHour', 'cpWatchQuiet'].forEach((id) => { const el = $(id); if (el) el.addEventListener('change', () => watchTipRefresh()) })

/* ---------------- 0.24.0 电脑画像：状态面板 / 采集 / 预览 / 清空 ---------------- */
const PC_PART_NAME = { browser: '上网', search: '搜索', bili: 'B站', games: '游戏', usage: '使用时长', files: '文件', insight: '判断' }

/** 0.45.0 自主活动三挡位的显隐与选中状态（cs 可空：空时只按当前 DOM 刷新显隐） */
function pcSyncAutoLevels (cs) {
  const box = $('cpAutoLevels')
  if (!box) return
  const on = cs ? cs.autonomyOn === true : !!($('cpAuto') && $('cpAuto').checked)
  const lv = cs ? (Number(cs.autonomyLevel) || 1)
    : (Number((document.querySelector('input[name="cpAutoLevel"]:checked') || {}).value) || 1)
  box.style.display = on ? '' : 'none'
  document.querySelectorAll('input[name="cpAutoLevel"]').forEach((el) => { el.checked = Number(el.value) === lv })
  const row = $('cpAutoDirRow')
  if (row) row.style.display = (on && lv >= 2) ? '' : 'none'
}

/** 0.45.2 自主活动状态一行字 + 测试跑。状态来自 autonomy:status（未启动/未接线时给占位）。 */
const LEVEL_NAME = { 1: '只看看', 2: '我的地盘', 3: '完全开放' }
function pcAutoStatusText (st) {
  if (!st) return '自主活动：—'
  if (!st.on) return '自主活动：关'
  const parts = ['自主活动：开（' + (LEVEL_NAME[st.level] || st.level) + '挡）']
  if (st.idleMin) parts.push('空闲阈值 ' + st.idleMin + ' 分钟')
  if (st.todayCount) parts.push('今天已活动 ' + st.todayCount + ' 次')
  if (st.running) parts.push('正在活动…')
  else if (st.nextInMs > 0) parts.push('下次最早 ' + Math.max(1, Math.round(st.nextInMs / 60000)) + ' 分钟后')
  const last = st.last || {}
  if (lastAtText(st.lastAt)) parts.push('上次：' + lastAtText(st.lastAt) + (last.why ? '（' + last.why + '）' : ''))
  return parts.join(' · ')
}
function lastAtText (t) {
  if (!t) return ''
  try { return new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '' }
}
// 0.45.14 今日互动统计（社交数据面板简版）：她今天主动说了几次话、QQ 找了几次、自己跑了几场
async function interactRefresh () {
  const el = $('cpInteractStat')
  if (!el) return
  try {
    const s = await GM.interactStats()
    el.textContent = [
      '【今日互动】',
      '主动开口（含碎碎念/黏人/看屏搭话）：' + (s.saidToday || 0) + ' 句',
      '自主活动：' + (s.autonomyToday || 0) + ' 场',
      '记忆沉淀进审查册：+' + (s.reviewAddedToday || 0) + ' 条',
      'QQ 上找你：' + (s.reachSentToday || 0) + ' 次'
    ].join('\n')
  } catch {
    el.textContent = '【今日互动】读取失败'
  }
}

async function pcAutoRefresh () {
  const el = $('cpAutoStatus')
  if (!el) return
  try {
    const st = await inv('autonomyStatus').catch(() => null)
    el.textContent = pcAutoStatusText(st)
  } catch { el.textContent = '自主活动：—' }
}
async function pcAutoRunNow () {
  const el = $('cpAutoStatus')
  const rep = $('cpAutoReport')
  // 0.45.5：汇报独立成持久区块，状态行不再覆盖它（上一版 1 秒后就被状态行冲掉，用户根本看不完）
  if (rep) { rep.style.display = 'none'; rep.textContent = '' }
  const t0 = Date.now()
  const ticker = setInterval(() => {
    if (el) el.textContent = '正在活动…（已 ' + Math.round((Date.now() - t0) / 1000) + ' 秒，她可能在看屏幕、翻页面，别催）'
  }, 1000)
  if (el) el.textContent = '正在活动…'
  try {
    const r = await inv('autonomyRunNow').catch(() => null)
    if (r && r.ok) {
      const what = String(r.content || '').trim()
      if (rep && what) {
        rep.textContent = '她刚才出去活动了，自己说：「\n' + what + '\n」（完整流水在她的日记和 pc/autonomy/journal.jsonl）'
        rep.style.display = ''
      } else if (rep) {
        rep.textContent = '她刚才出去活动了一场（这场没说话，流水在 pc/autonomy/journal.jsonl）'
        rep.style.display = ''
      }
      if (el) el.textContent = '活动完成 ✓（详情见下方）'
    } else {
      const why = (r && r.why) || (r && r.error) || 'unknown'
      if (el) el.textContent = '没跑成：' + why + '（正在聊天时她不会抢电脑；挡位和 LLM 配置也要在）'
    }
  } catch { if (el) el.textContent = '没跑成（见主日志）' }
  clearInterval(ticker)
  pcAutoRefresh().catch(() => { })
}

function pcRefreshPanel (st) {
  const el = $('cpPcState')
  if (!el) return
  if (!st) { el.textContent = '—'; return }
  const parts = st.parts || {}
  const rows = Object.keys(PC_PART_NAME).map((k) => {
    const p = parts[k]
    if (!p) return PC_PART_NAME[k] + '：未采集'
    return PC_PART_NAME[k] + '：' + (p.ok ? '✓ ' : '✕ ') + (p.note || '')
  })
  const when = st.lastAt ? new Date(st.lastAt).toLocaleString('zh-CN', { hour12: false }) : '还没采过'
  el.textContent = '上次采集：' + when +
    (st.lastDuration ? '（耗时 ' + (st.lastDuration / 1000).toFixed(1) + ' 秒）' : '') +
    (st.running ? ' · 正在采集…' : '') +
    (st.impressionCount ? ' · 她记下了 ' + st.impressionCount + ' 条关于你的印象' : '') +
    '\n' + rows.join('    ')
}

async function pcDoScan () {
  const el = $('cpPcState')
  if (el) el.textContent = '正在采集…（浏览器历史多的时候要几秒）'
  try {
    const days = Math.round(Number($('cpPcDays') && $('cpPcDays').value) || 14)
    const r = await window.companion.pcCollect({ days })
    if (!r || !r.ok) {
      if (el) el.textContent = '采集失败：' + ((r && (r.error || r.message)) || '未知原因')
      return
    }
    pcRefreshPanel(await window.companion.pcStatus())
    const pv = $('cpPcPreview')
    if (pv && pv.style.display !== 'none') pcShowPreview()
  } catch (e) { if (el) el.textContent = '采集失败：' + e.message }
}

async function pcShowPreview () {
  const pv = $('cpPcPreview')
  if (!pv) return
  try {
    const r = await window.companion.pcRead('profile')
    pv.style.display = 'block'
    pv.textContent = (r && r.text) ? r.text : '（还没有档案，先点「立即采集」）'
  } catch (e) { pv.textContent = '读取失败：' + e.message }
}

/**
 * 「看她眼中的你」：她记下的印象 + 她推出来的判断。
 * 这个面板存在的意义是**可纠正**——主人能看到她怎么理解自己，说得不对就去跟她说，
 * 她会用 pc_impression 的 remove+note 改掉。
 */
async function pcShowEye () {
  const pv = $('cpPcPreview')
  if (!pv) return
  try {
    const imp = await window.companion.pcRead('impression')
    const ins = await window.companion.pcRead('insight')
    const parts = []
    if (imp && imp.text) parts.push(imp.text)
    if (ins && ins.text) parts.push(ins.text)
    pv.style.display = 'block'
    pv.textContent = parts.length
      ? parts.join('\n\n————————\n\n')
      : '（她还没形成判断。先采一次，或者让她多陪你几天——她会在聊天里自己记下观察）'
  } catch (e) { pv.textContent = '读取失败：' + e.message }
}

let pcClearArmed = 0
async function pcDoClear () {
  const btn = $('cpPcClear')
  const el = $('cpPcState')
  if (!pcClearArmed) {
    pcClearArmed = Date.now()
    if (btn) btn.textContent = '再点一次确认清空（含她记下的印象）'
    setTimeout(() => {
      pcClearArmed = 0
      if (btn) btn.textContent = (window.t && t('pcprofile.clear')) || '清空档案'
    }, 4000)
    return
  }
  pcClearArmed = 0
  if (btn) btn.textContent = (window.t && t('pcprofile.clear')) || '清空档案'
  try {
    const r = await window.companion.pcClear()
    if (el) el.textContent = r && r.ok ? '已清空（删掉 ' + r.removed + ' 个档案文件）' : '清空失败：' + ((r && r.error) || '未知原因')
    const pv = $('cpPcPreview')
    if (pv) { pv.style.display = 'none'; pv.textContent = '' }
  } catch (e) { if (el) el.textContent = '清空失败：' + e.message }
}

/* 0.44.0 只清键盘/输入记录。两步确认和 pcDoClear 同款——删掉的东西要一致地难删。 */
let keyClearArmed = 0
async function pcDoKeyClear () {
  const btn = $('cpKeyClear')
  const el = $('cpPcState')
  if (!keyClearArmed) {
    keyClearArmed = Date.now()
    if (btn) btn.textContent = '再点一次确认清空输入记录'
    setTimeout(() => {
      keyClearArmed = 0
      if (btn) btn.textContent = (window.t && t('pcprofile.keyclear')) || '清空输入记录'
    }, 4000)
    return
  }
  keyClearArmed = 0
  if (btn) btn.textContent = (window.t && t('pcprofile.keyclear')) || '清空输入记录'
  try {
    const r = await window.companion.keysClear()
    if (el) el.textContent = r && r.ok ? '已清空输入记录（删掉 ' + r.removed + ' 个文件）' : '清空失败：' + ((r && r.error) || '未知原因')
  } catch (e) { if (el) el.textContent = '清空失败：' + e.message }
}
function pcTodayStr () {
  const d = new Date()
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/* ---------------- 0.24.0 健康记录：表单 / 列表 ---------------- */
function healthRowText (r) {
  const bits = []
  if (r.sleep) {
    const s = r.sleep
    bits.push('睡眠 ' + (s.bed || '?') + '→' + (s.wake || '?') + (s.hours ? ' ' + s.hours + 'h' : ''))
  }
  if (r.bp) bits.push('血压 ' + r.bp.sys + '/' + (r.bp.dia || '-') + (r.bp.pulse ? ' 心率 ' + r.bp.pulse : ''))
  if (r.mood) bits.push('心态 ' + (r.mood.score != null ? r.mood.score + '/10' : '') + (r.mood.note ? '（' + r.mood.note + '）' : ''))
  if (r.weight != null) bits.push('体重 ' + r.weight + 'kg')
  return r.date + '  ' + (bits.join(' · ') || '（无数据）')
}

async function healthRefresh () {
  const el = $('cpHdList')
  if (!el || !window.companion || !window.companion.healthList) return
  try {
    const r = await window.companion.healthList(30)
    if (!r || !r.ok) return
    const rows = (r.rows || []).slice().reverse()
    el.style.display = 'block'
    if (!rows.length) { el.textContent = '（还没有记录，填一次试试）'; return }
    const st = await window.companion.healthStats(14)
    const head = []
    if (st && st.ok) {
      if (st.sleep && st.sleep.nights) head.push('近 14 晚平均 ' + st.sleep.avgHours + ' 小时' + (st.sleep.avgBed ? '（' + st.sleep.avgBed + ' 入睡）' : ''))
      if (st.bp && st.bp.readings) head.push('血压均 ' + st.bp.avgSys + '/' + (st.bp.avgDia || '-'))
      if (st.mood && st.mood.entries) head.push('心态均 ' + st.mood.avg + '/10')
    }
    el.textContent = (head.length ? head.join('   ') + '\n\n' : '') + rows.slice(0, 30).map(healthRowText).join('\n')
  } catch { }
}

async function healthSave () {
  const st = $('cpHdState')
  const num = (id) => {
    const el = $(id)
    const v = el ? String(el.value || '').trim() : ''
    return v
  }
  const entry = {
    date: ($('cpHdDate') && $('cpHdDate').value) || pcTodayStr(),
    sleepBed: num('cpHdBed'), sleepWake: num('cpHdWake'),
    bpSys: num('cpHdSys'), bpDia: num('cpHdDia'), pulse: num('cpHdPulse'),
    mood: num('cpHdMood'), moodNote: num('cpHdNote'),
    weight: num('cpHdWeight')
  }
  if (!entry.sleepBed && !entry.sleepWake && !entry.bpSys && !entry.mood && !entry.weight) {
    if (st) st.textContent = '至少要填一项（睡眠 / 血压 / 心态 / 体重）'
    return
  }
  try {
    const r = await window.companion.healthLog(entry)
    if (st) st.textContent = r && r.ok ? '已记录 ' + r.entry.date : '记录失败：' + ((r && r.error) || '未知原因')
    if (r && r.ok) {
      /* 记完清掉输入，但保留日期，方便同一天连记血压多次 */
      for (const id of ['cpHdBed', 'cpHdWake', 'cpHdSys', 'cpHdDia', 'cpHdPulse', 'cpHdMood', 'cpHdNote', 'cpHdWeight']) {
        const el = $(id); if (el) el.value = ''
      }
      healthRefresh()
    }
  } catch (e) { if (st) st.textContent = '记录失败：' + e.message }
}

let healthClearArmed = 0
async function healthClear () {
  const btn = $('cpHdClear')
  const st = $('cpHdState')
  if (!healthClearArmed) {
    healthClearArmed = Date.now()
    if (btn) btn.textContent = '再点一次确认清空'
    setTimeout(() => {
      healthClearArmed = 0
      if (btn) btn.textContent = (window.t && t('health.clear')) || '清空全部记录'
    }, 4000)
    return
  }
  healthClearArmed = 0
  if (btn) btn.textContent = (window.t && t('health.clear')) || '清空全部记录'
  try {
    const r = await window.companion.healthClear()
    if (st) st.textContent = r && r.ok ? '健康记录已清空' : '清空失败'
    healthRefresh()
  } catch (e) { if (st) st.textContent = '清空失败：' + e.message }
}

$('cpSave').addEventListener('click', cpSave)

/* ---- 0.34.0 陪看字幕：框字幕 / 试一下 / 状态 ---- */
function screenTextRectText (rect) {
  const el = $('cpStRect')
  if (!el) return
  el.textContent = rect && rect.w
    ? '字幕框：' + Math.round(rect.w) + '×' + Math.round(rect.h) + ' @ ' + Math.round(rect.x) + ',' + Math.round(rect.y)
    : '还没框字幕区 —— 点「框字幕」，把屏幕上那一行字幕圈住'
}

async function screenTextRefresh () {
  const el = $('cpStState')
  if (!el || !window.companion || !window.companion.screenTextStatus) return
  try {
    const r = await window.companion.screenTextStatus()
    if (!r || !r.ok) { el.textContent = '状态读取失败：' + ((r && r.error) || '未知'); return }
    if (r.rect) screenTextRectText(r.rect)
    if (!r.on) {
      el.textContent = r.enabled ? '开关开着但没在跑（先框字幕，再点「试一下」确认能读）' : '没在陪看'
      return
    }
    const bits = ['正在陪看', '读了 ' + r.ticks + ' 帧', '定稿 ' + r.hits + ' 句', '待发 ' + r.pending + ' 句']
    if (r.lastMs) bits.push('单帧 ' + r.lastMs + 'ms')
    if (r.peek && r.peek.text) bits.push('刚读到「' + String(r.peek.text).slice(0, 24) + '」')
    if (r.error) bits.push('出错：' + r.error)
    el.textContent = bits.join(' · ')
  } catch (e) { el.textContent = '状态读取失败：' + e.message }
}

async function screenTextPick () {
  const el = $('cpStState')
  if (el) el.textContent = '在屏幕上拖一个框，把字幕那一行圈住…'
  try {
    const r = await window.companion.screenTextPick()
    if (!r || !r.ok) { if (el) el.textContent = (r && r.error) || '没框到'; return }
    screenTextRectText(r.rect)
    if (el) el.textContent = '框好了 —— 点「试一下」确认能读出字'
    screenTextRefresh()
  } catch (e) { if (el) el.textContent = '框选失败：' + e.message }
}

async function screenTextTest () {
  const el = $('cpStState')
  if (el) el.textContent = '正在读一帧（第一次要加载模型，稍等一两秒）…'
  try {
    const r = await window.companion.screenTextOnce()
    if (!r || !r.ok) { if (el) el.textContent = '读失败：' + ((r && r.error) || '未知'); return }
    if (el) {
      el.textContent = r.text
        ? '读到了：' + r.text + '（' + r.ms + 'ms，' + r.w + '×' + r.h + '）'
        : '这一帧没读出字 —— 框是不是框到黑边/空处了？'
    }
  } catch (e) { if (el) el.textContent = '读失败：' + e.message }
}

// 0.24.0 健康记录
if ($('cpHealthOn')) $('cpHealthOn').addEventListener('change', () => { cpSave().catch(() => { }) })
if ($('cpHdSave')) $('cpHdSave').addEventListener('click', () => { healthSave() })
if ($('cpHdClear')) $('cpHdClear').addEventListener('click', () => { healthClear() })
// 0.24.0 电脑画像：开关/天数一改就保存（保存后主进程会启停采样），三个按钮各管一件事
if ($('cpPcOn')) $('cpPcOn').addEventListener('change', () => { cpSave().catch(() => { }) })
// 0.44.0 键盘记录开关
if ($('cpKeyOn')) $('cpKeyOn').addEventListener('change', () => { cpSave().catch(() => { }) })
if ($('cpPcDays')) $('cpPcDays').addEventListener('change', () => { cpSave().catch(() => { }) })
// 0.45.0 自主活动三挡位：挡位变化只控制「地盘目录」一行的显隐并保存；目录一改就保存
if ($('cpAuto')) $('cpAuto').addEventListener('change', () => { pcSyncAutoLevels(); cpSave().catch(() => { }) })
document.querySelectorAll('input[name="cpAutoLevel"]').forEach((el) => {
  el.addEventListener('change', () => { pcSyncAutoLevels(); cpSave().catch(() => { }) })
})
if ($('cpAutoDir')) $('cpAutoDir').addEventListener('change', () => { cpSave().catch(() => { }) })
// 0.45.2 空闲阈值：一改就保存（阈值小了立刻生效——autonomy 每次调度都会重新读配置）
if ($('cpAutoIdle')) $('cpAutoIdle').addEventListener('change', () => { cpSave().catch(() => { }) })
if ($('cpAutoRun')) $('cpAutoRun').addEventListener('click', () => { pcAutoRunNow() })
if ($('cpPcScan')) $('cpPcScan').addEventListener('click', () => { pcDoScan() })
if ($('cpPcView')) $('cpPcView').addEventListener('click', () => { pcShowPreview() })
if ($('cpPcEye')) $('cpPcEye').addEventListener('click', () => { pcShowEye() })
if ($('cpPcClear')) $('cpPcClear').addEventListener('click', () => { pcDoClear() })
if ($('cpKeyClear')) $('cpKeyClear').addEventListener('click', () => { pcDoKeyClear() })
// 0.24.0 随身服务：开关/端口一改就保存，保存后由 cpSave 回读刷新地址/口令行
if ($('cpRemoteOn')) $('cpRemoteOn').addEventListener('change', () => { cpSave().catch(() => { }) })
if ($('cpRemotePort')) $('cpRemotePort').addEventListener('change', () => { cpSave().catch(() => { }) })
// 0.34.0 陪看字幕：开关/间隔/藏自己一改就保存（主进程按新配置重排），框选和试读各一个按钮
if ($('cpStOn')) $('cpStOn').addEventListener('change', () => { cpSave().then(() => screenTextRefresh()).catch(() => { }) })
if ($('cpJudgeOn')) $('cpJudgeOn').addEventListener('change', () => { cpSave().catch(() => { }) })
if ($('cpStInterval')) $('cpStInterval').addEventListener('change', () => { cpSave().then(() => screenTextRefresh()).catch(() => { }) })
if ($('cpStHideSelf')) $('cpStHideSelf').addEventListener('change', () => { cpSave().catch(() => { }) })
if ($('cpStPick')) $('cpStPick').addEventListener('click', () => { screenTextPick() })
if ($('cpStTest')) $('cpStTest').addEventListener('click', () => { screenTextTest() })

/* ---------------- 1.9 用量图表 + 7.8 自启 ---------------- */
/* 0.25.0 用量页升级（Coopanion #15）：区间 × 粒度 × 指标 × 分组 + 活跃度格子图。
 * 数据全部由 core/usage.js 的 reportFromDays 算好，这里只负责画。
 * 状态放在文件开头（设置回填 renderCpSettings 会用到，避免 TDZ）。 */
const uDayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function uOpts () {
  const today = uDayStr(new Date())
  const base = { granularity: U.gran, groupBy: U.group, currency: U.currency, rate: U.rate }
  if (U.range === 'custom' && U.from && U.to) return { ...base, from: U.from <= U.to ? U.from : U.to, to: U.from <= U.to ? U.to : U.from }
  const n = U.range === 0 ? 1 : Number(U.range) || 7
  return { ...base, from: uDayStr(new Date(Date.now() - (n - 1) * 86400000)), to: today }
}

const uCurSym = () => (String(U.currency).toUpperCase() === 'USD' ? '$' : '¥')
function uTok (n) {
  const v = Number(n) || 0
  if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M'
  if (v >= 10000) return (v / 10000).toFixed(1) + '万'
  return String(Math.round(v))
}
const uCost = (n) => uCurSym() + (Number(n) || 0).toFixed(2)

function renderUsage (rep) {
  const bars = $('uBars')
  const sum = $('uSummary')
  const table = $('uTable')
  const heatHost = $('uHeat')
  if (!bars) return
  const byCost = U.metric === 'cost'
  const val = (b) => (byCost ? b.cost : b.tokens)

  // --- 柱状（区间内每个桶一根）---
  const max = Math.max(0.0001, ...rep.buckets.map(val))
  const step = rep.buckets.length > 45 ? 6 : rep.buckets.length > 20 ? 3 : 1
  bars.innerHTML = rep.buckets.map((b, i) => {
    const v = val(b)
    const h = v <= 0 ? 2 : Math.max(3, Math.round(v / max * 74))
    const show = i % step === (rep.buckets.length - 1) % step
    const tip = `${b.label}：${uTok(b.tokens)} tokens · ${uCost(b.cost)} · ${b.calls} 次`
    return `<div class="u-bar${v <= 0 ? ' u-empty' : ''}" title="${esc(tip)}">` +
      `<i style="height:${h}px"></i>` +
      `<b>${show ? esc(b.label) : ''}</b></div>`
  }).join('')

  // --- 汇总行 ---
  const t0 = rep.totals
  const hitRate = t0.prompt > 0 ? Math.round((t0.cached / t0.prompt) * 100) : 0
  const perDay = rep.rangeDays > 0 ? t0.tokens / rep.rangeDays : 0
  sum.textContent = `${rep.from} ~ ${rep.to} · ${rep.rangeDays} 天 · ${t0.calls} 次调用 · ` +
    `${uTok(t0.tokens)} tokens · ${uCost(t0.cost)} · 缓存命中 ${hitRate}% · 日均 ${uTok(perDay)}`

  // --- 明细表：按分组时列分组；不分组且桶不多时列每桶 ---
  const rows = []
  if (rep.groupBy !== 'none' && rep.groups.length) {
    rows.push(['<span class="u-name">' + esc(t('usage.colName')) + '</span>', esc(t('usage.mToken')), esc(t('usage.mCost')), esc(t('usage.colCalls'))])
    const gmax = Math.max(0.0001, ...rep.groups.map(val))
    for (const g of rep.groups) {
      const v = byCost ? g.cost : g.tokens
      const w = Math.max(2, Math.round(v / gmax * 100))
      rows.push([
        `<span class="u-name" title="${esc(g.key)}">${esc(g.label)}<span class="u-track"><i style="width:${w}%"></i></span></span>`,
        uTok(g.tokens), uCost(g.cost), String(g.calls)
      ])
    }
  } else if (rep.buckets.length <= 14) {
    rows.push(['<span class="u-name">' + esc(t('usage.colBucket')) + '</span>', esc(t('usage.mToken')), esc(t('usage.mCost')), esc(t('usage.colCalls'))])
    for (const b of rep.buckets) rows.push([`<span class="u-name">${esc(b.key)}</span>`, uTok(b.tokens), uCost(b.cost), String(b.calls)])
  }
  table.innerHTML = rows.map((r, i) => `<div class="u-tr${i === 0 ? ' u-th' : ''}">` + r.map((c) => `<span>${c}</span>`).join('') + '</div>').join('')
  table.hidden = !rows.length

  // --- 活跃度格子图（每天一格，颜色按当天用量四分档）---
  const hmax = Math.max(1, ...rep.heat.map((h) => h.tokens))
  heatHost.innerHTML = rep.heat.map((h) => {
    const r = h.tokens / hmax
    const lv = h.tokens <= 0 ? 0 : r > 0.75 ? 4 : r > 0.45 ? 3 : r > 0.18 ? 2 : 1
    return `<div class="u-cell" data-lv="${lv}" title="${esc(`${h.date}：${uTok(h.tokens)} tokens · ${uCost(h.cost)} · ${h.calls} 次`)}"></div>`
  }).join('')
}

async function usageRefresh () {
  const sum = $('uSummary')
  const bars = $('uBars')
  if (!bars || !A) return
  try {
    const r = await A.usage(uOpts())
    if (!r || !r.ok || !r.report) { if (sum) sum.textContent = t('usage.fail') + ((r && r.error) || ''); return }
    renderUsage(r.report)
  } catch (e) { if (sum) sum.textContent = t('usage.fail') + (e && e.message) }
}

if ($('uRange')) {
  for (const b of $('uRange').children) {
    b.addEventListener('click', () => {
      for (const x of $('uRange').children) x.classList.toggle('on', x === b)
      const v = b.dataset.r
      if (v === 'custom') {
        U.range = 'custom'
        $('uCustomRow').hidden = false
        if (!$('uTo').value) {
          $('uTo').value = uDayStr(new Date())
          $('uFrom').value = uDayStr(new Date(Date.now() - 6 * 86400000))
        }
        U.from = $('uFrom').value
        U.to = $('uTo').value
        usageRefresh()
        return
      }
      $('uCustomRow').hidden = true
      U.range = Number(v)
      usageRefresh()
    })
  }
}
if ($('uApply')) {
  $('uApply').addEventListener('click', () => {
    U.from = $('uFrom').value
    U.to = $('uTo').value
    usageRefresh()
  })
}
for (const [host, key, attr] of [['uGran', 'gran', 'g'], ['uMetric', 'metric', 'm']]) {
  const el = $(host)
  if (!el) continue
  for (const b of el.children) {
    b.addEventListener('click', () => {
      for (const x of el.children) x.classList.toggle('on', x === b)
      U[key] = b.dataset[attr]
      usageRefresh()
    })
  }
}
if ($('uGroup')) $('uGroup').addEventListener('change', () => { U.group = $('uGroup').value; usageRefresh() })
if ($('uCur')) {
  $('uCur').addEventListener('change', () => {
    U.currency = $('uCur').value
    // 币种/汇率跟着设置一起落盘（下次启动还在）
    try { window.companion.patchSettings({ usageCurrency: U.currency, usageRate: U.rate }) } catch { }
    usageRefresh()
  })
}
if ($('uRate')) {
  $('uRate').addEventListener('change', () => {
    const r = Number($('uRate').value)
    U.rate = r > 0 ? r : 7.2
    try { window.companion.patchSettings({ usageCurrency: U.currency, usageRate: U.rate }) } catch { }
    usageRefresh()
  })
}
if ($('uRefresh')) $('uRefresh').addEventListener('click', () => usageRefresh())


$('cpAutostart').addEventListener('change', async () => {
  if (!A) return
  try { await A.autostartSet($('cpAutostart').checked) } catch {}
})
// 备份：导出/导入全部设置（含 API Key）+ 角色卡 + 历史 + 记忆，纯本地文件
$('cpExportBtn').addEventListener('click', async () => {
  const tip = $('cpDataTip')
  try {
    await cpSave()
    tip.textContent = t('data.exporting')
    const r = await window.companion.exportBackup()
    tip.textContent = r.ok ? t('data.exported') + r.path : ((r.message || t('data.canceled')) )
  } catch (err) { tip.textContent = t('data.exportFail') + (err && err.message) }
})
$('cpImportBtn').addEventListener('click', async () => {
  const tip = $('cpDataTip')
  try {
    const r = await window.companion.importBackup()
    if (r.ok) { tip.textContent = t('data.imported'); return }
    tip.textContent = r.message || t('data.canceled')
  } catch (err) { tip.textContent = t('data.importFail') + (err && err.message) }
})
$('cpPetScale').addEventListener('input', () => { $('cpPetScaleV').textContent = ($('cpPetScale').value / 100).toFixed(1) + '×' })

/* ---- 0.18.0 第一批：气泡滑块 / 音效 / 说话声 / 闹钟 ---- */
// 0.19.0 回应模式：只有「自定义」才显示勾选行（积极/安静时那张表没有意义）
function syncReactionVisible () {
  const rows = $('cpReactionTypes')
  if (rows) rows.hidden = $('cpReactionMode').value !== 'custom'
}
$('cpReactionMode').addEventListener('change', () => { syncReactionVisible(); cpSave().catch(() => { }) })
for (const box of document.querySelectorAll('#cpReactionTypes input[data-rtype]')) {
  box.addEventListener('change', () => { cpSave().catch(() => { }) })
}
function syncSpeechVisible () {
  const rows = $('cpSpeechRows')
  if (rows) rows.hidden = !$('cpSpeechOn').checked
}
// 滑块拖动即时预览（广播），松手落盘
for (const [id, vid, key] of [['cpBubbleScale', 'cpBubbleScaleV', 'petBubbleScale'], ['cpFontScale', 'cpFontScaleV', 'petFontScale']]) {
  const el = $(id)
  if (!el) continue
  el.addEventListener('input', () => {
    $(vid).textContent = el.value + '%'
    try { window.companion.patchSettings({ [key]: Number(el.value) / 100 }) } catch { }
  })
  el.addEventListener('change', () => { cpSave().catch(() => { }) })
}
$('cpSpeechOn').addEventListener('change', () => { syncSpeechVisible(); cpSave().catch(() => { }) })

/** 「朗读 AI 回复」总开关 与「语音合成」模式是同一件事的两处入口（模式里的 off 也等于关朗读）。
 *  总开关关掉或模式选 off 时，把合成整块置灰 —— 不禁用：禁用控件读不到值，保存时会把配置写丢 */
function syncReadGate () {
  const on = $('cpReadReply').checked && $('cpTtsMode').value !== 'off'
  const ttsBox = $('cpTtsMode').closest('label')
  if (ttsBox) ttsBox.classList.toggle('sp-dim', !on)
  const fish = $('cpFish')
  if (fish) fish.classList.toggle('sp-dim', !on)
}
if ($('cpReadReply')) $('cpReadReply').addEventListener('change', () => { syncReadGate(); cpSave().catch(() => { }) })

/** 闹钟列表：勾选框启停 + 🗑 删除（配置页面板） */
async function alarmRefresh () {
  const box = $('cpAlarmList')
  if (!box) return
  try {
    const list = await window.companion.alarmList()
    box.textContent = ''
    if (!list || !list.length) {
      const hint = document.createElement('div')
      hint.className = 'hint'
      hint.textContent = t('alarm.empty')
      box.appendChild(hint)
      return
    }
    for (const a of list) {
      const row = document.createElement('label')
      row.className = 'cd-check'
      row.style.cssText = 'display:flex;align-items:center;gap:6px'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = a.enabled !== false
      cb.addEventListener('change', async () => {
        try { await window.companion.alarmToggle(a.id, cb.checked) } catch { }
        alarmRefresh()
      })
      const span = document.createElement('span')
      span.textContent = (a.daily === false ? '' : '每天 ') + a.time + (a.label ? ' · ' + a.label : '')
      const del = document.createElement('button')
      del.className = 'cd-btn'
      del.style.cssText = 'margin-left:auto;padding:2px 8px'
      del.textContent = '🗑'
      del.title = t('alarm.del')
      del.addEventListener('click', async (e) => {
        e.preventDefault()
        try { await window.companion.alarmDel(a.id) } catch { }
        alarmRefresh()
      })
      row.appendChild(cb)
      row.appendChild(span)
      row.appendChild(del)
      box.appendChild(row)
    }
  } catch { }
}
$('cpAlarmAdd').addEventListener('click', async () => {
  const time = $('cpAlarmTime').value
  const label = $('cpAlarmLabel').value.trim()
  const daily = $('cpAlarmDaily').checked
  try {
    const r = await window.companion.alarmAdd({ time, label, daily })
    const tip = $('cpAlarmTip')
    if (r && r.ok) { tip.textContent = t('alarm.added'); $('cpAlarmLabel').value = ''; alarmRefresh() } else tip.textContent = (r && r.error) || t('alarm.addFail')
  } catch (err) { $('cpAlarmTip').textContent = String(err && err.message) }
})
// 5.5 悬停按钮设置已随功能移除（0.45.29）
$('cpTtsProvider').addEventListener('change', () => { syncSettingsVisible(); cpSave() })
$('cpTtsMode').addEventListener('change', () => { syncSettingsVisible(); syncReadGate(); cpSave() })
$('cpAsrProvider').addEventListener('change', () => { syncAsrVisible(); cpSave() })
// S7：界面语言切换 → 保存后整窗重载（文案是模块加载时取好的）
$('cpUiLang').addEventListener('change', async (e) => {
  const v = e.target.value
  try { localStorage.setItem(UI_LANG_KEY, v) } catch {}
  try { await window.companion.patchSettings({ uiLang: v }) } catch {}
  location.reload()
})
// S7：标准 / 高级模式（即时生效，不用重载——只隐藏不改配置）
for (const b of $('uiModeSeg').children) {
  b.addEventListener('click', async () => {
    uiMode = b.dataset.m
    try { localStorage.setItem(UI_MODE_KEY, uiMode) } catch {}
    for (const x of $('uiModeSeg').children) x.classList.toggle('on', x.dataset.m === uiMode)
    try { await window.companion.patchSettings({ uiMode }) } catch {}
    syncSettingsVisible()
  })
}
$('cpFishFeeling').addEventListener('input', syncFishLabels)
$('cpFishDensity').addEventListener('input', syncFishLabels)
$('cpSpeed').addEventListener('input', syncFishLabels)
// 试听：保存当前设置后用当前档位合成并播放
$('cpPreviewBtn').addEventListener('click', async () => {
  const tip = $('cpPreviewTip')
  try {
    $('cpPreviewBtn').disabled = true
    tip.textContent = t('pv.doing')
    await cpSave()
    const r = await window.companion.tts($('cpFishPreview').value.trim().slice(0, 300))
    if (r && r.url) {
      tip.textContent = ''
      playAudio(r.url, r.speed)
    } else {
      tip.textContent = t('pv.fail') + ((r && r.message) || (r && r.fallback ? t('pv.noTts') : t('pv.unknown')))
    }
  } catch (err) {
    tip.textContent = t('pv.fail') + (err && err.message)
  } finally {
    $('cpPreviewBtn').disabled = false
  }
})
// Fish 我的声音库：拉列表 → 下拉选择 → 自动填入 reference_id（不用再手抠 ID）
$('cpFishVoiceFetch').addEventListener('click', async () => {
  const tip = $('cpFishVoiceTip')
  try {
    $('cpFishVoiceFetch').disabled = true
    tip.textContent = t('voices.doing')
    await cpSave()
    const r = await window.companion.fishVoices()
    if (!r || !r.ok) { tip.textContent = t('pv.fail') + ((r && r.message) || t('pv.unknown')); return }
    const sel = $('cpFishVoiceSel')
    sel.innerHTML = '<option value="">' + esc(t('voices.pickOne')) + '</option>' +
      r.voices.map((v) => '<option value="' + v.id + '">' + esc(v.title) + '</option>').join('')
    sel.hidden = false
    tip.textContent = r.voices.length ? t('voices.count', r.voices.length) : t('voices.none')
  } catch (err) {
    tip.textContent = t('pv.fail') + (err && err.message)
  } finally {
    $('cpFishVoiceFetch').disabled = false
  }
})
$('cpFishVoiceSel').addEventListener('change', function () {
  if (this.value) { $('cpFishVoice').value = this.value; cpSave() }
})
$('cpFetchModels').addEventListener('click', async () => {
  await cpSave()
  const btn = $('cpFetchModels')
  btn.textContent = t('api.fetching')
  let models = []
  try { models = await window.companion.models($('cpApiBase').value.trim(), $('cpApiKey').value.trim()) } catch {}
  const sel = $('cpApiModel')
  if (Array.isArray(models) && models.length) {
    const cur = sel.value
    sel.innerHTML = models.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('')
    btn.textContent = t('api.loaded', models.length)
  } else {
    btn.textContent = t('api.fail')
  }
  setTimeout(() => { btn.textContent = t('api.fetch') }, 2500)
})
function renderWorld () {
  const list = $('worldList')
  list.innerHTML = ''
  for (const w of editing.worldBook || []) {
    const d = document.createElement('div')
    d.className = 'world-item'
    d.innerHTML = `<input placeholder="${esc(t('persona.worldKwPh'))}" value="${esc(w.keywords)}">` +
      `<textarea placeholder="${esc(t('persona.worldTextPh'))}">${esc(w.content)}</textarea>` +
      `<button class="cd-btn del">${esc(t('persona.worldDel'))}</button>`
    d.children[0].addEventListener('input', (e) => { w.keywords = e.target.value })
    d.children[1].addEventListener('input', (e) => { w.content = e.target.value })
    d.children[2].addEventListener('click', () => {
      editing.worldBook = editing.worldBook.filter((x) => x !== w)
      renderWorld()
    })
    list.appendChild(d)
  }
}
$('btnWorldAdd').addEventListener('click', () => {
  editing.worldBook = editing.worldBook || []
  editing.worldBook.push({ keywords: '', content: '' })
  renderWorld()
})
async function loadAssistantHistory () {
  if (!A) return
  try { renderAssistantHistory(await A.history()) } catch { renderAssistantHistory([]) }
}

$('charSelect').addEventListener('change', async (e) => {
  const r = await window.companion.setActive(e.target.value)
  char = r.char
  // 切角色 = 形象与人格一起切（对话侧同步切到同一个 role）
  await syncRole(char)
  try { await A.switchRole(char.id) } catch {}
  await loadAssistantHistory()
  refreshDrawer()
  showVisual()
})
$('btnCharNew').addEventListener('click', async () => {
  const c = await window.companion.newCharacter(t('drawer.newChar', S.characters.length + 1))
  await window.companion.setActive(c.id)
  char = c
  S.characters = (await window.companion.init()).characters
  await syncRole(char)
  await loadAssistantHistory()
  refreshDrawer()
})
$('btnCharDel').addEventListener('click', async () => {
  if (S.characters.length <= 1) return
  await window.companion.delCharacter(char.id)
  const init = await window.companion.init()
  S.characters = init.characters
  char = S.characters[0]
  await syncRole(char)
  try { await A.switchRole(char.id) } catch {}
  await loadAssistantHistory()
  refreshDrawer()
  showVisual()
})
$('btnCharClose').addEventListener('click', () => setView('chat'))
// 0.18.0 第二批：看「此刻真正发给模型的系统提示词」（先保存再看，预览的是已生效版本）
$('btnSysPreview').addEventListener('click', async () => {
  const el = $('sysPreview')
  el.hidden = false
  el.textContent = '读取中…'
  try {
    const r = await A.previewSystem(editing && editing.id)
    el.textContent = (r && r.ok) ? (r.system || '(空)') : ('读取失败：' + ((r && r.error) || '未知错误'))
  } catch (e) { el.textContent = '读取失败：' + (e && e.message) }
})
$('btnCharSave').addEventListener('click', async () => {
  editing.name = $('fName').value.trim() || editing.name
  editing.persona = $('fPersona').value
  collectSystemPrompt()
  collectVoice()
  collectUserProfile()
  await window.companion.saveCharacter(editing)
  char = editing
  $('charName').textContent = char.name
  $('charSelect').innerHTML = S.characters.map((c) =>
    c.id === char.id ? `<option value="${esc(c.id)}" selected>${esc(c.name)}</option>` : `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
  // 人设改动立刻对聊天生效
  await syncRole(char)
  setView('chat')
  showVisual()
})
function renderVisMode () {
  const mode = editing.visual.mode || 'still'
  for (const b of $('visMode').children) b.classList.toggle('on', b.dataset.m === mode)
  const hints = {
    still: t('visual.hintStill'),
    spine: t('visual.hintSpine'),
    vrm: t('visual.hintVrm'),
    figure: t('visual.hintFigure')
  }
  $('visHint').textContent = hints[mode]
}

/* ---------------- 长期记忆账本 ---------------- */
/** 对话时间线：全部聊天记录（history 已持久化），参考 Horae append-only 账本 */
function renderTimeline () {
  const list = $('timelineList')
  const items = (S.history || []).slice(-60)
  if (!items.length) {
    list.innerHTML = '<div class="mem-empty">' + esc(t('chat.empty')) + '</div>'
    return
  }
  list.innerHTML = ''
  for (const m of items) {
    const d = document.createElement('div')
    d.className = 'tl-item'
    const time = m.at ? new Date(m.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
    d.innerHTML = `<span class="tl-role ${m.role === 'user' ? 'me' : 'ai'}">${m.role === 'user' ? esc(t('mem.whoYou')) : 'AI'}</span>` +
      `<span class="mem-text">${esc(stripTags(m.content)).slice(0, 120)}</span>` +
      `<span class="tl-time">${time}</span>`
    list.appendChild(d)
  }
  list.scrollTop = list.scrollHeight
}

async function renderMemory () {
  // 0.25.0：同一份数据渲染到两处——角色卡「人设」页的 memList + 记忆页「她记得的事」memFacts
  const hosts = [$('memList'), $('memFacts')].filter(Boolean)
  if (!hosts.length) return
  for (const list of hosts) list.innerHTML = '<div class="mem-empty">' + esc(t('mem.loading')) + '</div>'
  let events = []
  try { events = await window.companion.memoryList() } catch {}
  const catName = { promise: t('mem.catPromise'), preference: t('mem.catPreference'), relation: t('mem.catRelation'), fact: t('mem.catFact'), task: t('mem.catTask') }
  for (const list of hosts) {
    list.innerHTML = ''
    if (!events.length) {
      list.innerHTML = '<div class="mem-empty">' + esc(t('mem.listEmpty')) + '</div>'
      continue
    }
    for (const ev of events) {
      const d = document.createElement('div')
      d.className = 'mem-item'
      d.innerHTML = `<span class="mem-cat c-${esc(ev.cat || 'fact')}">${esc(catName[ev.cat] || t('mem.catFact'))}</span>` +
        `<span class="mem-text">${esc(ev.text)}</span>` +
        '<button class="mem-del" title="✕">✕</button>'
      d.children[2].addEventListener('click', async () => {
        await window.companion.memoryDel(ev.seq)
        renderMemory()
      })
      list.appendChild(d)
    }
  }
}
for (const b of $('visMode').children) {
  b.addEventListener('click', async () => {
    editing.visual.mode = b.dataset.m
    renderVisMode()
    // 选「形象包」但还没有包 → 直接把装扮窗打开（空态有拖入提示），别让用户对着 ✦ 发呆
    if (b.dataset.m === 'figure' && !(editing.visual.figure && editing.visual.figure.pack)) {
      if (window.companion.figureOpen) await window.companion.figureOpen()
    } else {
      showVisual()
    }
  })
}
// 装扮窗口改了东西：主窗跟着换形象（形象包应用后 mode 会变成 figure）
if (window.companion.onFigureChanged) {
  window.companion.onFigureChanged(async (st) => {
    try {
      const s = await window.companion.init()
      if (s && s.characters) {
        const found = s.characters.find((c) => char && c.id === char.id)
        if (found) { char = found; editing = JSON.parse(JSON.stringify(found)) }
      }
      showVisual()
      if (!$('charDrawer').hidden) refreshDrawer()
    } catch (e) { console.warn('[figure] 刷新失败', e && e.message) }
  })
}
$('btnDress').addEventListener('click', async () => { if (window.companion.figureOpen) await window.companion.figureOpen() })
$('btnFigImport').addEventListener('click', async () => {
  const out = await window.companion.figureImport('zip')
  if (!out || out.canceled) return
  if (!out.ok) { $('visHint').textContent = t('visual.importFail') + (out.reason || t('pv.unknown')); return }
  $('visHint').textContent = t('visual.imported') + (out.name || out.id) + t('visual.importedEnd')
  await window.companion.figureOpen()
})
$('btnImport').addEventListener('click', async () => {
  const mode = editing.visual.mode || 'still'
  // 形象包不走「导入单个文件」，而是整包 zip + 装扮窗
  if (mode === 'figure') {
    const out = await window.companion.figureImport('zip')
    if (!out || out.canceled) return
    if (!out.ok) { $('visHint').textContent = t('visual.importFail') + (out.reason || t('pv.unknown')); return }
    $('visHint').textContent = t('visual.imported') + (out.name || out.id) + t('visual.importedEnd')
    await window.companion.figureOpen()
    return
  }
  if (mode === 'still') {
    const p = await window.companion.importAsset(char.id, 'image')
    if (p) editing.visual.image = p
  } else if (mode === 'spine') {
    // 一次导入：可多选 atlas/skel/json/png；只选一个时主进程自动补齐同目录同名文件
    const files = await window.companion.importAsset(char.id, 'spine')
    const spine = editing.visual.spine = editing.visual.spine || {}
    const hasSkel = files.some((p) => /\.skel$/i.test(p))
    for (const p of files) {
      if (/\.atlas$/i.test(p)) spine.atlas = p
      else if (/\.skel$/i.test(p)) spine.skel = p
      else if (/\.json$/i.test(p) && !hasSkel && !spine.skel) spine.skel = p
      else if (/\.png$/i.test(p) && !/cover/i.test(p)) spine.png = p
    }
  } else {
    const p = await window.companion.importAsset(char.id, 'vrm')
    if (p) editing.visual.vrm = p
  }
  $('visHint').textContent = t('visual.importedRaw') + JSON.stringify(mode === 'spine' ? editing.visual.spine : editing.visual[mode] || '').slice(0, 160)
})

/* ---------------- 抽屉「游戏」tab（S6.5：游戏模式 + 游戏库） ---------------- */
const GM = window.companion
let gmPickItems = []
let gmPickSel = new Set()
let gmPickQ = ''

function gmSourceName (s) {
  return s === 'steam' ? 'Steam' : s === 'epic' ? 'Epic' : s === 'startmenu' ? t('game.srcMenu') : t('game.srcManual')
}

async function loadGame () {
  if (!GM || !GM.gameState) return
  const st = await GM.gameState()
  const on = !!(st && st.on)
  $('gmState').textContent = on ? t('game.on', st.minutes) : t('game.off')
  $('gmToggle').textContent = on ? t('game.exit') : t('game.enter')
  const scale = (st && st.scale) || 0.7
  $('gmScale').value = Math.round(scale * 100)
  $('gmScaleV').textContent = (Math.round(scale * 100) / 100).toFixed(2) + '×'
  $('gmCorner').value = (st && st.corner) || 'bottom-right'
  $('gmMute').checked = !(st && st.mute === false)
  try {
    const cs = await GM.settings()
    $('gmAuto').checked = cs.gameModeAuto !== false
    if ($('gmAutoDetect')) $('gmAutoDetect').checked = cs.gameAutoOn !== false
    $('gmGreet').checked = cs.gameModeGreet !== false
    // 0.38.0 游戏弹幕层：字号/速度/锁定/开关都从设置里回填（不在 settings() 白名单里的
    // 字段会读成 undefined，界面上看起来就是「每次打开都回默认」，这里一并兜住）
    if ($('gmDmOn')) $('gmDmOn').checked = cs.danmakuOn !== false
    if ($('gmDmLock')) $('gmDmLock').checked = cs.danmakuLock !== false
    if ($('gmDmSize')) {
      const fs = Number(cs.danmakuFontSize) || 30
      $('gmDmSize').value = fs
      $('gmDmSizeV').textContent = fs + 'px'
    }
    if ($('gmDmSpeed')) {
      const sp = Math.round((Number(cs.danmakuSpeed) || 1) * 100)
      $('gmDmSpeed').value = sp
      $('gmDmSpeedV').textContent = (sp / 100).toFixed(1) + '×'
    }
  } catch {}
  await refreshDmState()
  await renderGameList()
}

/** 弹幕层当前开没开、弹幕框锁没锁（要让人看得见，否则「试一条」没反应时无从判断） */
async function refreshDmState () {
  if (!GM || !GM.dmStatus || !$('gmDmState')) return
  try {
    const s = await GM.dmStatus()
    $('gmDmState').textContent = s && s.on
      ? t('dm.stateOn', s.locked ? t('dm.locked') : t('dm.unlocked'))
      : t('dm.stateOff')
  } catch {}
}

async function renderGameList () {
  if (!GM || !GM.gameList) return
  const list = await GM.gameList()
  const box = $('gmList')
  box.innerHTML = ''
  if (!list || !list.length) { box.innerHTML = '<div class="mem-empty">' + esc(t('game.empty')) + '</div>'; return }
  for (const g of list.slice(0, 60)) {
    const d = document.createElement('div')
    d.className = 'mem-item'
    d.innerHTML = '<span class="mem-cat"></span><span class="mem-text"></span>'
    d.querySelector('.mem-cat').textContent = gmSourceName(g.source)
    d.querySelector('.mem-text').textContent = g.name
    const bRun = document.createElement('button')
    bRun.className = 'mem-mini'
    bRun.textContent = t('game.launch')
    bRun.onclick = async () => {
      $('gmTip').textContent = t('game.launching', g.name)
      const r = await GM.gameLaunch(g.id)
      $('gmTip').textContent = r && r.ok
        ? t('game.launchOk', r.name, !!r.gameMode)
        : t('game.launchFail') + ((r && r.error) || t('pv.unknown'))
      await loadGame()
    }
    const bDel = document.createElement('button')
    bDel.className = 'mem-mini'
    bDel.textContent = t('game.remove')
    bDel.onclick = async () => { await GM.gameRemove(g.id); await renderGameList() }
    d.appendChild(bRun)
    d.appendChild(bDel)
    box.appendChild(d)
  }
  if (list.length > 60) {
    const more = document.createElement('div')
    more.className = 'mem-empty'
    more.textContent = t('game.more', list.length - 60)
    box.appendChild(more)
  }
}

function gmRenderPick () {
  const box = $('gmPickList')
  if (!box) return
  const q = gmPickQ.trim().toLowerCase()
  const list = gmPickItems.filter((g) => !q || String(g.name).toLowerCase().includes(q))
  box.innerHTML = ''
  if (!list.length) { box.innerHTML = '<div class="mem-empty">' + esc(t('game.noMatch')) + '</div>'; return }
  for (const g of list.slice(0, 80)) {
    const d = document.createElement('label')
    d.className = 'mem-item'
    d.style.cursor = 'pointer'
    d.innerHTML = '<input type="checkbox" ' + (gmPickSel.has(g.id) ? 'checked' : '') + '><span class="mem-text"></span>'
    d.querySelector('.mem-text').textContent = g.name
    d.querySelector('input').onchange = (e) => {
      if (e.target.checked) gmPickSel.add(g.id); else gmPickSel.delete(g.id)
    }
    box.appendChild(d)
  }
}

if (GM && GM.gameToggle && $('gmToggle')) {
  $('gmToggle').onclick = async () => {
    const st = await GM.gameState()
    const r = await GM.gameToggle(!(st && st.on))
    if (r && r.on === false && r.reason) $('gmTip').textContent = r.reason
    await loadGame()
  }
  $('gmScale').addEventListener('input', () => {
    $('gmScaleV').textContent = (Number($('gmScale').value) / 100).toFixed(2) + '×'
  })
  $('gmScale').addEventListener('change', async () => {
    await GM.gameConfig({ gameModeScale: Number($('gmScale').value) / 100 })
  })
  $('gmCorner').addEventListener('change', () => GM.gameConfig({ gameModeCorner: $('gmCorner').value }))
  $('gmMute').addEventListener('change', () => GM.gameConfig({ gameModeMute: $('gmMute').checked }))
  $('gmGreet').addEventListener('change', () => GM.gameConfig({ gameModeGreet: $('gmGreet').checked }))
  $('gmAuto').addEventListener('change', () => GM.gameConfig({ gameModeAuto: $('gmAuto').checked }))
  if ($('gmAutoDetect')) $('gmAutoDetect').addEventListener('change', () => GM.gameConfig({ gameAutoOn: $('gmAutoDetect').checked }))
  // 0.38.0 游戏弹幕层
  if ($('gmDmOn')) $('gmDmOn').addEventListener('change', async () => {
    await GM.gameConfig({ danmakuOn: $('gmDmOn').checked })
    await refreshDmState()
  })
  if ($('gmDmSize')) {
    $('gmDmSize').addEventListener('input', () => { $('gmDmSizeV').textContent = $('gmDmSize').value + 'px' })
    $('gmDmSize').addEventListener('change', () => GM.gameConfig({ danmakuFontSize: Number($('gmDmSize').value) }))
  }
  if ($('gmDmSpeed')) {
    $('gmDmSpeed').addEventListener('input', () => { $('gmDmSpeedV').textContent = (Number($('gmDmSpeed').value) / 100).toFixed(1) + '×' })
    $('gmDmSpeed').addEventListener('change', () => GM.gameConfig({ danmakuSpeed: Number($('gmDmSpeed').value) / 100 }))
  }
  if ($('gmDmLock')) $('gmDmLock').addEventListener('change', async () => {
    await GM.gameConfig({ danmakuLock: $('gmDmLock').checked })
    await refreshDmState()
  })
  if ($('gmDmTest')) $('gmDmTest').addEventListener('click', async () => {
    try {
      const r = await GM.dmTest()
      $('gmDmState').textContent = r && r.ok ? t('dm.tested', r.lines) : t('dm.testFail')
    } catch { $('gmDmState').textContent = t('dm.testFail') }
    setTimeout(refreshDmState, 3000)
  })
  if ($('gmDmUnlock')) $('gmDmUnlock').addEventListener('click', async () => {
    try { await GM.dmLock(false) } catch {}
    if ($('gmDmLock')) $('gmDmLock').checked = false
    await refreshDmState()
  })

  const importFrom = async (src) => {
    $('gmTip').textContent = t('game.scanning')
    const r = await GM.gameImport(src)
    $('gmTip').textContent = r && r.ok
      ? t('game.scanned', r.scanned, r.added)
      : t('game.scanFail') + ((r && r.error) || t('pv.unknown'))
    await renderGameList()
  }
  $('gmScanSteam').onclick = () => importFrom('steam')
  $('gmScanEpic').onclick = () => importFrom('epic')
  $('gmAdd').onclick = async () => {
    const r = await GM.gameAddFile()
    if (r && r.ok) { $('gmTip').textContent = r.added ? t('game.added', r.name) : t('game.exists'); await renderGameList() }
  }
  $('gmScanMenu').onclick = async () => {
    $('gmTip').textContent = t('game.scanningMenu')
    const r = await GM.gameScan('startmenu')
    gmPickItems = (r && r.startmenu) || []
    gmPickSel = new Set()
    $('gmPickWrap').hidden = false
    gmRenderPick()
    $('gmTip').textContent = t('game.menuTip', gmPickItems.length)
  }
  $('gmPickSearch').addEventListener('input', () => { gmPickQ = $('gmPickSearch').value; gmRenderPick() })
  $('gmPickImport').onclick = async () => {
    if (!gmPickSel.size) { $('gmTip').textContent = t('game.pickNone'); return }
    const r = await GM.gameImportStartMenu([...gmPickSel])
    $('gmTip').textContent = t('game.importedN', r && r.added ? r.added : 0)
    $('gmPickWrap').hidden = true
    await renderGameList()
  }
}

/* ---------------- 窗口控制 ---------------- */
$('btnMin').addEventListener('click', () => window.companion.win('min'))
$('btnClose').addEventListener('click', () => window.companion.win('close'))
/* 0.45.41：🧹 清空 / 📌 置顶按钮已按用户要求移除 */
// 顶部视图 tab：聊天 / 角色
$('tabChat').addEventListener('click', () => setView('chat'))
$('tabChar').addEventListener('click', () => setView('char'))
// 「记忆」「模型」不再另开面板：直接跳到角色的对应分页，配置只有一处
$('btnMemory').addEventListener('click', () => {
  setView('char')
  showDrawerTab('memory')
})
$('btnModel').addEventListener('click', () => { setView('char'); showDrawerTab('settings') })

/* ---------------- 动作测试面板（0.45.87 从助手控制台搬进主窗） ----------------
   手动点播动作词，走 petBridge pet_act 同一条链路；网格动态列 motions/ 全部动作。
   0.45.90 词表换成 spine 词典有出处的词（挥手指问候、拍手/比耶/耳语等需她坐下时才演，
   因为那些动画只在坐姿骨架里；坐下/站起来接主进程坐卡状态机）。 */
const ACT_BUILTIN = ['坐下', '站起来', '挥手', '打招呼', '再见', '叉腰', '抱臂', '害羞', '过来', '卖萌', '拍手', '鼓掌', '加油', '比耶', '耳语', '悄悄话', '伸懒腰', '晃脚', '慌张', '等一下', '托腮']
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
async function playAct (words) {
  $('actMsg').textContent = '播放中：' + words.join('、')
  try {
    const r = await window.companion.petAct(words)
    $('actMsg').textContent = r && r.error ? '失败：' + r.error : '已播放：' + words.join('、')
  } catch (e) { $('actMsg').textContent = '失败：' + (e && e.message) }
  setTimeout(() => { $('actMsg').textContent = '' }, 2600)
}
$('btnAct').addEventListener('click', async () => {
  const p = $('actPanel')
  p.hidden = !p.hidden
  if (!p.hidden) {
    $('charDrawer').hidden = true
    try {
      const r = await window.companion.petListActs()
      if (r && r.ok) {
        renderActGrid([...new Set([...(r.vrma || []), ...ACT_BUILTIN, ...(r.builtin || [])])])
      } else renderActGrid(ACT_BUILTIN)
    } catch { renderActGrid(ACT_BUILTIN) }
  }
})
$('actClose').addEventListener('click', () => { $('actPanel').hidden = true })
$('actPlay').addEventListener('click', () => {
  const w = String($('actInput').value || '').trim()
  if (w) playAct([w])
})
$('actInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('actPlay').click() })
// 主进程可以要求打开某个视图（托盘 / 伙伴 ⚙ 按钮）
if (window.companion.onView) window.companion.onView((v) => setView(v === 'char' || v === 'settings' ? v : 'chat'))
// 托盘里切了角色：主窗同步换角色（形象 + 人格）
if (window.companion.onCharSwitched) {
  window.companion.onCharSwitched(async (c) => {
    if (!c) return
    char = c
    $('charName').textContent = char.name
    try { await A.switchRole(char.id) } catch {}
    await loadAssistantHistory()
    if (!$('charDrawer').hidden) refreshDrawer()
    showVisual()
  })
}
// 形象 tab 里也有一个保存按钮
// 0.18.0 第二批：Spine 动作清单（向主进程要；主进程问角色所在的屏，屏回报骨架里的动画名）
$('btnAnimList').addEventListener('click', async () => {
  const box = $('animList')
  const tip = $('animTip')
  box.innerHTML = ''
  tip.textContent = t('visual.movesLoading')
  try {
    const r = await window.companion.animList()
    const list = (r && r.list) || []
    if (!list.length) {
      tip.textContent = (r && r.stale) ? t('visual.movesNone') : t('visual.movesEmpty')
      return
    }
    tip.textContent = list.length + ' ' + t('visual.movesUnit')
    for (const a of list) {
      const b = document.createElement('button')
      b.className = 'cd-btn'
      b.textContent = a.zh ? a.zh + ' ' + a.name : a.name
      b.onclick = () => { try { window.companion.animPlay(a.name) } catch {} }
      box.appendChild(b)
    }
  } catch (e) { tip.textContent = t('visual.movesNone') }
})
$('btnCharSave2').addEventListener('click', async () => {
  editing.name = $('fName').value.trim() || editing.name
  editing.persona = $('fPersona').value
  collectSystemPrompt()
  collectVoice()
  collectUserProfile()
  await window.companion.saveCharacter(editing)
  char = editing
  $('charName').textContent = char.name
  await syncRole(char)
  setView('chat')
  showVisual()
})

/* ---------------- S8 刷B站（值班轮） ---------------- */
let biliQrTimer = null
let biliStatusTimer = null

function biliSave () {
  const patch = {
    keywords: $('biliKeywords').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    perDay: Number($('biliPerDay').value) || 0,
    reportLevel: $('biliReportLevel').value,
    autoComment: $('biliAutoComment').checked,
    mentionName: $('biliMentionName').value.trim(),
    commentPerRound: Number($('biliCpr').value) || 0,
    peakValley: $('biliPeakValley').checked,
    noon: $('biliNoon').checked,
    night: $('biliNight').checked,
    dmMode: $('biliDmMode').value,
    dmUid: $('biliDmUid').value.trim(),
    replyToComments: $('biliReplyComments').checked,
    replyPerRound: Number($('biliRpr').value) || 1,
    transcribe: $('biliTranscribe').checked,
    asrModel: $('biliAsrModel').value,
    favFolderId: Number($('biliFavFolder').value) || 0
  }
  biliSyncSub()
  return window.companion.biliConfig(patch).catch(() => {})
}

/** 子开关联动：峰谷总开关 → noon/night；私信方式 → 收件人行；楼中楼 → 每轮条数；转写 → 模型/按钮 */
function biliSyncSub () {
  $('biliPvSub').hidden = !$('biliPeakValley').checked
  $('biliDmUidRow').hidden = $('biliDmMode').value === 'off'
  $('biliRprRow').hidden = !$('biliReplyComments').checked
  $('biliAsrSub').hidden = !$('biliTranscribe').checked
}

async function biliRenderStatus (st) {
  if (!st || !st.ok) { $('biliState').textContent = t('bili.stateFail'); return }
  const cfg = st.config || {}
  if (!$('biliKeywords').dataset.filled) {
    $('biliKeywords').value = (cfg.keywords || []).join(', ')
    $('biliPerDay').value = cfg.perDay ?? 5
    $('biliReportLevel').value = cfg.reportLevel || 'full'
    $('biliAutoComment').checked = !!cfg.autoComment
    $('biliMentionName').value = cfg.mentionName || ''
    $('biliCpr').value = cfg.commentPerRound ?? 1
    $('biliPeakValley').checked = !!cfg.peakValley
    $('biliNoon').checked = cfg.noon !== false
    $('biliNight').checked = cfg.night !== false
    $('biliDmMode').value = cfg.dmMode || 'off'
    $('biliDmUid').value = cfg.dmUid || ''
    $('biliReplyComments').checked = !!cfg.replyToComments
    $('biliRpr').value = cfg.replyPerRound ?? 1
    $('biliTranscribe').checked = !!cfg.transcribe
    $('biliAsrModel').value = cfg.asrModel || 'small'
    $('biliFavFolder').value = String(cfg.favFolderId || 0)
    $('biliKeywords').dataset.filled = '1'
    biliSyncSub()
    biliFavRefresh()
  }
  $('biliRunBtn').disabled = !!st.running
  // 谷时窗口状态一行（哪个开着、在不在窗口里、今天这个窗口跑过没）
  const w = st.windows || {}
  const wParts = []
  for (const k of ['noon', 'night']) {
    if (w[k]) wParts.push(`${w[k].label}${w[k].switchOn ? '' : t('bili.winOff')}${w[k].opening ? t('bili.winNow') : ''}${w[k].ranInWindow ? t('bili.winRan') : ''}`)
  }
  const asr = st.asr || {}
  $('biliAsrState').textContent = asr.installing ? t('bili.asrInstalling')
    : asr.depsReady && asr.ytDlpReady ? t('bili.asrReady')
      : t('bili.asrNotReady')
  $('biliState').textContent = (st.loggedIn ? t('bili.loggedIn') : t('bili.notLoggedIn')) +
    ' · ' + t('bili.pickedToday').replace('%n', String(st.pickedToday ?? 0)).replace('%m', String(cfg.perDay ?? 0)) +
    (cfg.peakValley && wParts.length ? '\n' + wParts.join(' · ') : '') +
    (st.running ? ' · ' + t('bili.running') : '') +
    (st.lastResult && st.lastResult.reply ? '\n' + st.lastResult.reply : '')
}

/** 0.39.0：把已存的 B 站配置回填进表单。
 *  这页以前只有 biliSave（写），没有任何地方读回来：重开设置页看到的是 HTML 里的默认值，
 *  这时随手改一项再保存，就会把关键词、私聊 UID、每轮评论数这些一起盖成默认值——
 *  不是显示不对，是真的丢配置。审计第 ④ 类（通道注册了没人调）扫出来的。 */
async function biliFill () {
  if (!window.companion || !window.companion.biliConfigGet) return
  let c = null
  try { const r = await window.companion.biliConfigGet(); c = r && r.ok ? r.config : null } catch { return }
  if (!c) return
  const setVal = (id, v) => { const el = $(id); if (el && v !== undefined && v !== null) el.value = v }
  const setChk = (id, v) => { const el = $(id); if (el) el.checked = !!v }
  setVal('biliKeywords', (c.keywords || []).join(', '))
  setVal('biliPerDay', c.perDay)
  setVal('biliReportLevel', c.reportLevel)
  setChk('biliAutoComment', c.autoComment)
  setVal('biliMentionName', c.mentionName || '')
  setVal('biliCpr', c.commentPerRound)
  setChk('biliPeakValley', c.peakValley)
  setChk('biliNoon', c.noon)
  setChk('biliNight', c.night)
  setVal('biliDmMode', c.dmMode)
  setVal('biliDmUid', c.dmUid || '')
  setChk('biliReplyComments', c.replyToComments)
  setVal('biliRpr', c.replyPerRound)
  setChk('biliTranscribe', c.transcribe)
  setVal('biliAsrModel', c.asrModel)
  // 收藏夹下拉是异步拉的，此刻可能还没有对选项：先记下想要的值，拉完再选
  const fav = $('biliFavFolder')
  if (fav) { fav.dataset.want = String(c.favFolderId || 0); fav.value = fav.dataset.want }
  biliSyncSub()
}

async function biliRefresh () {
  await biliFill()
  try { await biliRenderStatus(await window.companion.biliStatus()) } catch { $('biliState').textContent = t('bili.stateFail') }
}

for (const id of ['biliKeywords', 'biliPerDay', 'biliReportLevel', 'biliAutoComment', 'biliMentionName', 'biliCpr',
  'biliPeakValley', 'biliNoon', 'biliNight', 'biliDmMode', 'biliDmUid', 'biliReplyComments', 'biliRpr', 'biliTranscribe', 'biliAsrModel', 'biliFavFolder']) {
  $(id).addEventListener('change', biliSave)
}

/** S9-M4：拉我创建的收藏夹进下拉（保留当前选择） */
async function biliFavRefresh () {
  if (!window.companion.biliFavFolders) return
  try {
    const r = await window.companion.biliFavFolders()
    const sel = $('biliFavFolder')
    // 0.39.0：回填时（biliFill）选项还没拉回来，选不上，把目标值挂在 dataset 上带到这一步
    const cur = sel.dataset.want || sel.value
    if (r && r.ok) {
      sel.innerHTML = `<option value="0">${esc(t('bili.favOff'))}</option>` +
        (r.list || []).map((f) => `<option value="${f.id}">${esc(f.title)}（${f.count}）</option>`).join('')
      sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '0'
      delete sel.dataset.want
    } else if (r && r.error) {
      $('biliTip').textContent = t('bili.favRefreshFail') + r.error
    }
  } catch { /* 状态行不因此打扰 */ }
}

$('biliFavRefresh').addEventListener('click', () => biliFavRefresh())
$('biliFavToday').addEventListener('click', async () => {
  const tip = $('biliTip')
  tip.textContent = t('bili.favWorking')
  try {
    const r = await window.companion.biliFavToday()
    tip.textContent = r && r.ok
      ? t('bili.favDone').replace('%n', String((r.added || []).length)).replace('%s', String(r.skipped || 0)) + (r.error ? ' ' + r.error : '')
      : t('bili.favRefreshFail') + ((r && r.error) || '')
  } catch (e) { tip.textContent = t('bili.favRefreshFail') + e.message }
})

$('biliAsrBtn').addEventListener('click', async () => {
  const st = $('biliAsrState')
  st.textContent = t('bili.asrStarting')
  try {
    const r = await window.companion.biliAsrSetup()
    st.textContent = r && r.ok ? t('bili.asrStarted') + (r.logFile || '') : t('bili.asrFail') + ((r && r.error) || '')
  } catch (e) { st.textContent = t('bili.asrFail') + e.message }
  setTimeout(() => { biliRefresh().catch(() => {}) }, 1500)
})

$('biliLoginBtn').addEventListener('click', async () => {
  const tip = $('biliQrTip')
  try {
    const r = await window.companion.biliLoginStart()
    if (!r || !r.ok) { tip.textContent = t('bili.qrFail') + ((r && r.error) || ''); return }
    if (r.qr) {
      $('biliQr').src = r.qr
      $('biliQr').hidden = false
      tip.textContent = t('bili.qrHint')
    } else tip.textContent = r.url || t('bili.qrFail')
    clearInterval(biliQrTimer)
    const deadline = Date.now() + 180_000
    biliQrTimer = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(biliQrTimer); tip.textContent = t('bili.qrExpired'); return }
      try {
        const p = await window.companion.biliLoginPoll(r.key)
        if (p && p.state === 'ok') {
          clearInterval(biliQrTimer)
          tip.textContent = t('bili.qrOk')
          $('biliQr').hidden = true
          await biliRefresh()
        } else if (p && p.state === 'scanned') tip.textContent = t('bili.qrScanned')
        else if (p && p.state === 'expired') { clearInterval(biliQrTimer); tip.textContent = t('bili.qrExpired') }
      } catch { /* 轮询失败下一轮再试 */ }
    }, 2500)
  } catch (e) { tip.textContent = t('bili.qrFail') + e.message }
})

$('biliWhoBtn').addEventListener('click', async () => {
  const r = await window.companion.biliWhoami().catch((e) => ({ ok: false, error: e.message }))
  $('biliQrTip').textContent = r && r.loggedIn
    ? t('bili.whoOk').replace('%s', r.uname || '').replace('%d', String(r.mid || ''))
    : t('bili.whoNo') + ((r && (r.error || r.hint)) || '')
})

/* 0.39.0 学习模式：主进程一直有 study:start / stop / status 三条通道，preload 没暴露、
   界面上也没有按钮——设置页能填「45 分钟一轮、共 3 轮」，却没有任何地方能开始，
   只能靠托盘菜单或跟她说「陪我学习」。审计第 ④ 类（通道注册了没人调）扫出来的。 */
async function studyPaint () {
  const box = $('studyState')
  if (!box || !window.companion.studyStatus) return
  let s = null
  try { s = await window.companion.studyStatus() } catch { return }
  /* 0.45.69：不在学习时也要显示今天的账（他关掉模式后还想知道今天学了多少） */
  if (!s || !s.active) {
    box.textContent = t('study.idle') + (s && s.today ? '｜今日：' + s.today : '')
    return
  }
  let line = t('study.running')
    .replace('{round}', s.round).replace('{rounds}', s.rounds).replace('{mins}', s.minsInRound)
  /* 0.45.68 监督状态：她到底在盯什么、气到什么程度，得看得见 */
  if (s.supervise) {
    const lv = ({ fine: '心态平和', mild: '有点不痛快', angry: '真的生气了', furious: '彻底生气了' })[s.mood] || ''
    line += '｜监督「' + (s.goal || '未指定') + '」' +
      (s.strikes ? '，抓到分心 ' + s.strikes + ' 次' : '，还没抓到过') +
      (lv ? '，' + lv : '') +
      (s.penaltyMin ? '，已补时 ' + s.penaltyMin + ' 分钟' : '') +
      (s.essayOn ? '，盯申论 ' + s.essayWords + ' 字' : '') +
      (s.sulking ? '（正在赌气，不理人）' : '')
  }
  if (s.screens > 1) line += '｜看 ' + s.screens + ' 块屏'
  if (s.today) line += '\n今日：' + s.today
  box.textContent = line
  box.style.whiteSpace = 'pre-line'
}

if ($('studyStartBtn')) {
  $('studyStartBtn').addEventListener('click', async () => {
    const r = await window.companion.studyStart().catch((e) => ({ ok: false, reason: e.message }))
    if (r && r.ok === false) {
      const why = r.reason === 'off' ? t('study.whyOff')
        : r.reason === 'no-api' ? t('study.whyNoApi')
          : r.reason === 'already' ? t('study.whyAlready')
            : String(r.reason || '')
      $('studyState').textContent = why
      return
    }
    setTimeout(studyPaint, 400)
  })
  $('studyStopBtn').addEventListener('click', async () => {
    await window.companion.studyStop().catch(() => { })
    setTimeout(studyPaint, 400)
  })
}

$('biliRunBtn').addEventListener('click', async () => {
  await biliSave()
  const btn = $('biliRunBtn')
  btn.disabled = true
  $('biliTip').textContent = t('bili.runStarted')
  const r = await window.companion.biliRun().catch((e) => ({ started: false, error: e.message }))
  if (!r || r.started === false) {
    btn.disabled = false
    $('biliTip').textContent = t('bili.runFail') + ((r && r.error) || '')
    return
  }
  // 轮询状态：跑完（running=false）即刷新
  clearInterval(biliStatusTimer)
  biliStatusTimer = setInterval(async () => {
    try {
      const st = await window.companion.biliStatus()
      await biliRenderStatus(st)
      if (st && !st.running) {
        clearInterval(biliStatusTimer)
        btn.disabled = false
        $('biliTip').textContent = t('bili.runDone')
        await biliRefresh()
      }
    } catch { /* 下次轮询再试 */ }
  }, 5000)
})

$('biliReportBtn').addEventListener('click', async () => {
  const r = await window.companion.biliReport().catch((e) => ({ ok: false, error: e.message }))
  const v = $('biliReportView')
  if (r && r.exists) { v.value = r.text; v.hidden = false; $('biliTip').textContent = '' }
  else { v.hidden = true; $('biliTip').textContent = t('bili.noReport') }
})

$('biliVerifyBtn').addEventListener('click', async () => {
  $('biliTip').textContent = t('bili.verifying')
  const r = await window.companion.biliVerify().catch((e) => ({ ok: false, error: e.message }))
  $('biliTip').textContent = r && r.ok ? t('bili.verifyDone') : t('bili.verifyFail') + ((r && r.error) || '')
  if (r && r.text) { $('biliReportView').value = r.text; $('biliReportView').hidden = false }
})

$('biliOpenDirBtn').addEventListener('click', () => { window.companion.biliOpenDir('out') })

/* ---------------- S11 群聊接入（QQ/微信） ---------------- */
let imRoles = []

function imDescribeConn (st) {
  const c = st && st.conn
  if (!c) return t('im.connNone')
  if (c.connected && c.selfId) return `✓ ${t('im.connOn')} ${c.nickname || ''} (QQ:${c.selfId})` + (c.attempts ? ` · ${t('im.connRetry')}×${c.attempts}` : '')
  if (c.attempts) return `⏳ ${t('im.connRetry')}×${c.attempts}`
  return t('im.connOff')
}

async function imRender () {
  if (!window.companion.imStatus) return
  let st = null
  try { st = await window.companion.imStatus() } catch { return }
  if (!st || !st.config) return
  const c = st.config || {}
  $('imEnabled').checked = !!c.enabled
  $('imWsUrl').value = c.wsUrl || 'ws://127.0.0.1:3001'
  $('imToken').value = st.tokenMasked || ''
  if (st.tokenMasked) $('imToken').dataset.masked = '1'
  $('imPersonaMode').value = c.personaMode || 'current'
  $('imPersonaRole').hidden = (c.personaMode || 'current') !== 'role'
  $('imGroupRate').value = Number(c.groupRate) || 0
  $('imGroupRateV').textContent = (Number(c.groupRate) || 0) + '%'
  $('imPrivate').checked = c.privateEnabled !== false
  $('imVoice').checked = c.voiceEnabled !== false
  $('imStickerDir').value = c.stickerDir || ''
  $('imPrivateAccounts').value = Array.isArray(c.privateAccounts) ? c.privateAccounts.join(',') : ''
  $('imOwners').value = Array.isArray(c.ownerAccounts) ? c.ownerAccounts.join(',') : ''
  $('wxOwners').value = Array.isArray(c.wxOwnerAccounts) ? c.wxOwnerAccounts.join(',') : ''
  $('imPcTools').checked = c.pcToolsOn !== false
  $('imPcTerminalAsk').checked = c.pcTerminalAsk !== false
  // 0.45.93 主动消息：时段策略（全时段 / 谷时）+ 收件人
  // 0.45.97：去掉「两次至少隔 / 每天最多」两个设置项——随机节奏，本来就不该让人调
  $('imReachOn').checked = c.reachOn !== false
  $('imReachWindow').value = c.reachWindowMode === 'valley' ? 'valley' : 'all'
  $('imReachFrom').value = c.reachValleyFrom || '23:00'
  $('imReachTo').value = c.reachValleyTo || '08:00'
  $('imReachAccount').value = c.reachAccount || ''
  imSyncReachWindow()
  $('imGroups').value = Array.isArray(c.groups) ? c.groups.join(',') : ''
  $('imHourly').value = Number(c.perGroupHourly) || 20
  // 微信人设（brain 配置里，跟 QQ 分开）
  $('wxPersonaMode').value = c.wxPersonaMode || 'current'
  $('wxPersonaRole').hidden = (c.wxPersonaMode || 'current') !== 'role'
  $('imConn').textContent = imDescribeConn(st)
  $('imTip').textContent = (st.lastError ? '⚠ ' + st.lastError : '')
  $('ff14Server').value = c.ff14Server || '银泪湖'
  $('ff14ForAll').checked = c.ff14ForAll !== false
  mrFf14Fill(c.ff14RoleId || '')
  // 角色下拉（连接状态不阻塞：拿不到就空着，下一次设置页打开再填）
  if (!imRoles.length) {
    try {
      const r = await window.companion.imListRoles()
      imRoles = (r && r.roles) || []
      const sel = $('imPersonaRole')
      const cur = c.personaRole || ''
      sel.innerHTML = imRoles.map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.name || x.id)}</option>`).join('')
      const selWx = $('wxPersonaRole')
      const curWx = c.wxPersonaRole || ''
      selWx.innerHTML = imRoles.map((x) => `<option value="${esc(x.id)}" ${x.id === curWx ? 'selected' : ''}>${esc(x.name || x.id)}</option>`).join('')
      mrFf14Fill(c.ff14RoleId || '') // 角色列表到货后重填（下拉里才看得到莱莎）
    } catch { }
  }
  mrRender(c.roleSlots)
}

/* ---------------- 多角色槽位（0.12.0） ---------------- */
/** FF14 能力绑定下拉：不启用 / 各角色 / 内置 FF14 人设 */
function mrFf14Fill (cur) {
  const sel = $('mrFf14Role')
  if (!sel) return
  const nameCount = {}
  for (const x of imRoles) nameCount[x.name || x.id] = (nameCount[x.name || x.id] || 0) + 1
  const opts = [`<option value="" ${!cur ? 'selected' : ''}>${esc(t('mr.ff14Off'))}</option>`]
  for (const x of imRoles) {
    const label = nameCount[x.name || x.id] > 1 ? `${x.name || x.id}（${x.id}）` : (x.name || x.id)
    opts.push(`<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(label)}</option>`)
  }
  opts.push(`<option value="ff14" ${cur === 'ff14' ? 'selected' : ''}>${esc(t('mr.ff14Role'))}</option>`)
  sel.innerHTML = opts.join('')
}

function mrRoleOptions (cur) {
  // 重名角色在文案里带 id 区分（历史导入可能出现两个「莱莎」）
  const nameCount = {}
  for (const x of imRoles) nameCount[x.name || x.id] = (nameCount[x.name || x.id] || 0) + 1
  const opts = [`<option value="" ${!cur ? 'selected' : ''}>${esc(t('mr.pickRole'))}</option>`]
  for (const x of imRoles) {
    const label = nameCount[x.name || x.id] > 1 ? `${x.name || x.id}（${x.id}）` : (x.name || x.id)
    opts.push(`<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(label)}</option>`)
  }
  opts.push(`<option value="ff14" ${cur === 'ff14' ? 'selected' : ''}>${esc(t('mr.ff14Role'))}</option>`)
  return opts.join('')
}

function mrRender (slots) {
  const box = $('mrRows')
  const list = Array.isArray(slots) ? slots : []
  // ⚠️ 先补足行数再统一填选项 —— 之前「先填后补」，补出来的行 select 是空的（下拉连莱莎都没有的根因）
  while (box.children.length < list.length) mrAddRow()
  while (box.children.length < 3) mrAddRow()
  const rows = [...box.children]
  rows.forEach((row, i) => {
    const s = list[i] || {}
    const sel = row.querySelector('select')
    sel.innerHTML = mrRoleOptions(s.roleId || '')
    row.querySelector('input').value = Array.isArray(s.chats) ? s.chats.join(',') : ''
  })
}

function mrAddRow () {
  const box = $('mrRows')
  if (box.children.length >= 8) return
  const row = document.createElement('div')
  row.className = 'row'
  row.style.flexWrap = 'wrap'
  row.innerHTML = `<select style="max-width:40%"></select><input style="flex:1;min-width:120px" data-i18n-ph="mr.chatsPh" placeholder="负责的会话：QQ号/群号(group:123)/微信会话名，逗号分隔；留空=默认">`
  box.appendChild(row)
  const sel = row.querySelector('select')
  sel.innerHTML = mrRoleOptions('') // 手动加行也立即有选项（此时 imRoles 多半已加载）
  sel.addEventListener('change', imSave)
  row.querySelector('input').addEventListener('change', imSave)
  I18N.applyDOM(row)
}

function mrCollect () {
  const slots = []
  for (const row of $('mrRows').children) {
    const roleId = row.querySelector('select').value
    const chats = row.querySelector('input').value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
    if (roleId) slots.push({ id: 'r' + (slots.length + 1), roleId, chats })
  }
  return slots
}

function imCollect () {
  const tok = $('imToken')
  const patch = {
    enabled: $('imEnabled').checked,
    wsUrl: $('imWsUrl').value.trim(),
    personaMode: $('imPersonaMode').value,
    personaRole: $('imPersonaRole').value,
    groupRate: Number($('imGroupRate').value) || 0,
    privateEnabled: $('imPrivate').checked,
    voiceEnabled: $('imVoice').checked,
    stickerDir: $('imStickerDir').value.trim(),
    privateAccounts: $('imPrivateAccounts').value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
    ownerAccounts: $('imOwners').value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
    wxOwnerAccounts: $('wxOwners').value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
    pcToolsOn: $('imPcTools').checked,
    pcTerminalAsk: $('imPcTerminalAsk').checked,
    reachOn: $('imReachOn').checked,
    reachWindowMode: $('imReachWindow').value === 'valley' ? 'valley' : 'all',
    reachValleyFrom: $('imReachFrom').value || '23:00',
    reachValleyTo: $('imReachTo').value || '08:00',
    reachAccount: $('imReachAccount').value.trim(),
    groups: $('imGroups').value.split(/[,，\s]+/).map((s) => s.replace(/\D/g, '')).filter(Boolean),
    perGroupHourly: Number($('imHourly').value) || 20,
    wxPersonaMode: $('wxPersonaMode').value,
    wxPersonaRole: $('wxPersonaRole').value,
    roleSlots: mrCollect(),
    ff14RoleId: $('mrFf14Role') ? $('mrFf14Role').value : '',
    ff14Server: $('ff14Server').value.trim() || '银泪湖',
    ff14ForAll: $('ff14ForAll').checked
  }
  if (!(tok.dataset.masked === '1' && /^\*\*\*/.test(tok.value))) patch.token = tok.value.trim()
  return patch
}

let imSaveTimer = null
const imSave = () => { clearTimeout(imSaveTimer); imSaveTimer = setTimeout(async () => {
  try { await window.companion.imConfig(imCollect()) } catch (e) { $('imTip').textContent = t('im.saveFail') + (e && e.message) }
}, 400) }
;['imWsUrl', 'imToken', 'imPersonaMode', 'imPersonaRole', 'imGroups', 'imHourly', 'imPrivateAccounts', 'imOwners', 'wxOwners', 'wxPersonaMode', 'wxPersonaRole'].forEach((id) => {
  const el = $(id)
  if (el) el.addEventListener('change', () => { if (id === 'imPersonaMode') $('imPersonaRole').hidden = el.value !== 'role'; if (id === 'wxPersonaMode') $('wxPersonaRole').hidden = el.value !== 'role'; imSave() })
})
$('imGroupRate').addEventListener('input', () => { $('imGroupRateV').textContent = $('imGroupRate').value + '%' })
$('imEnabled').addEventListener('change', imSave)
$('imGroupRate').addEventListener('change', imSave)
$('imPrivate').addEventListener('change', imSave)
$('imVoice').addEventListener('change', imSave)
$('imStickerDir').addEventListener('change', imSave)
// 0.45.93 主动消息时段：切到「谷时」才显示起止时间；改了立刻存
function imSyncReachWindow () {
  const row = $('imReachWindowRow')
  if (row) row.hidden = $('imReachWindow').value !== 'valley'
}
;['imReachOn', 'imReachWindow', 'imReachFrom', 'imReachTo', 'imReachAccount'].forEach((id) => {
  const el = $(id)
  if (!el) return
  el.addEventListener('change', () => { if (id === 'imReachWindow') imSyncReachWindow(); imSave() })
})
$('mrAdd').addEventListener('click', mrAddRow)
$('mrFf14Role').addEventListener('change', imSave)
$('ff14Server').addEventListener('change', imSave)
$('ff14ForAll').addEventListener('change', imSave)

/* ---------------- 微信 UI 自动化（S11-M2） ---------------- */
async function wxRender () {
  if (!window.companion.wxStatus) return
  let st = null
  try { st = await window.companion.wxStatus() } catch { return }
  if (!st || !st.config) return
  const c = st.config || {}
  $('wxEnabled').checked = !!c.enabled
  $('wxChatName').value = c.chatName || ''
  $('wxPollSec').value = Number(c.pollSec) || 30
  const bits = []
  if (st.lastChat) bits.push(t('im.wxLastChat') + st.lastChat)
  if (st.replies) bits.push(t('im.wxReplies') + st.replies)
  if (st.polls) bits.push(t('im.wxPolls') + st.polls)
  if (st.lastError) bits.push('⚠ ' + st.lastError)
  $('wxTip').textContent = bits.join(' · ')
}

let wxSaveTimer = null
const wxSave = () => { clearTimeout(wxSaveTimer); wxSaveTimer = setTimeout(async () => {
  try {
    await window.companion.wxConfig({
      enabled: $('wxEnabled').checked,
      chatName: $('wxChatName').value.trim(),
      pollSec: Number($('wxPollSec').value) || 30
    })
  } catch (e) { $('wxTip').textContent = t('im.saveFail') + (e && e.message) }
}, 400) }
;['wxEnabled', 'wxChatName', 'wxPollSec'].forEach((id) => {
  const el = $(id)
  if (el) el.addEventListener('change', wxSave)
})
$('wxProbeBtn').addEventListener('click', async () => {
  const tip = $('wxTip')
  try {
    $('wxProbeBtn').disabled = true
    tip.textContent = t('im.wxProbing')
    await wxSave()
    const r = await window.companion.wxProbe()
    if (r && r.ok && r.replied) tip.textContent = '✓ ' + t('im.wxProbeReplied') + r.replied
    else if (r && r.ok) tip.textContent = t('im.wxProbeSkip') + (r.skip || r.chat || '')
    else tip.textContent = '✕ ' + ((r && r.error) || t('im.wxProbeFail'))
  } catch (e) { tip.textContent = '✕ ' + (e && e.message) }
  finally { $('wxProbeBtn').disabled = false }
})

/* ---------------- S10 World 扩展体系 ---------------- */
const worldStatusText = {
  loaded: '✓ 运行中', disabled: '⏸ 已停用', failed: '✕ 故障', 'pending-restart': '… 待装载'
}

async function worldRender () {
  if (!window.companion.worldList) return
  const box = $('worldRows')
  let r
  try { r = await window.companion.worldList() } catch { return }
  if (!r || !r.ok) { box.textContent = t('world.listFail'); return }
  if (!r.worlds.length) { box.innerHTML = `<div class="hint">${esc(t('world.empty'))}</div>`; return }
  box.innerHTML = ''
  for (const w of r.worlds) box.appendChild(worldRow(w))
}

function worldRow (w) {
  const el = document.createElement('div')
  el.className = 'row'
  el.style.flexWrap = 'wrap'
  el.style.alignItems = 'flex-start'
  el.style.border = '1px solid rgba(128,128,128,.25)'
  el.style.borderRadius = '8px'
  el.style.padding = '8px'
  el.style.marginBottom = '8px'
  const status = worldStatusText[w.status] || w.status
  const cfgHtml = (w.configSchema || []).map((c) => {
    const v = w.config ? w.config[c.key] : c.default
    if (c.type === 'boolean') return `<label class="cd-check" style="flex-basis:100%"><input type="checkbox" data-wcfg="${esc(c.key)}" ${v ? 'checked' : ''}> ${esc(c.label)}</label>`
    return `<label style="flex-basis:100%"><span>${esc(c.label)}</span><input data-wcfg="${esc(c.key)}" value="${esc(String(v ?? ''))}"></label>`
  }).join('')
  el.innerHTML = `
    <div style="flex-basis:100%;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <b>${esc(w.name)}</b> <span style="opacity:.6">v${esc(w.version)} · ${esc(w.author || '')}</span>
      <span style="opacity:.75">${esc(status)}${Number(w.failCount) ? `（失败 ×${w.failCount}）` : ''}</span>
      ${w.toolNames && w.toolNames.length ? `<span style="opacity:.5">工具：${w.toolNames.map(esc).join('、')}</span>` : ''}
      <span style="flex:1"></span>
      <label class="cd-check" style="margin:0"><input type="checkbox" data-wenable ${w.enabled ? 'checked' : ''}> <span data-i18n="world.enabled">启用</span></label>
      ${w.panel ? '<button class="cd-btn" data-wpanel data-i18n="world.panel">面板</button>' : ''}
      <button class="cd-btn" data-wuninstall data-i18n="world.uninstall">卸载</button>
    </div>
    ${w.description ? `<div class="hint" style="flex-basis:100%">${esc(w.description)}</div>` : ''}
    ${w.lastError ? `<div class="hint" style="flex-basis:100%;color:#ff8f8f">${esc(w.lastError)}</div>` : ''}
    ${cfgHtml}`
  el.querySelector('[data-wenable]').addEventListener('change', async (e) => {
    e.target.disabled = true
    try { await window.companion.worldSetEnabled(w.id, e.target.checked) } catch { }
    e.target.disabled = false
    worldRender()
  })
  const ub = el.querySelector('[data-wuninstall]')
  if (ub) ub.addEventListener('click', async () => {
    if (!confirm(t('world.confirmUninstall').replace('%n', w.name))) return
    try { await window.companion.worldUninstall(w.id) } catch { }
    worldRender()
  })
  const pb = el.querySelector('[data-wpanel]')
  if (pb) pb.addEventListener('click', () => window.companion.worldOpenPanel(w.id))
  for (const input of el.querySelectorAll('[data-wcfg]')) {
    input.addEventListener('change', () => {
      const key = input.dataset.wcfg
      const value = input.type === 'checkbox' ? input.checked : input.value
      window.companion.worldConfig(w.id, { [key]: value }).catch(() => { })
    })
  }
  I18N.applyDOM(el)
  return el
}

$('worldRefresh').addEventListener('click', worldRender)
$('worldInstallZip').addEventListener('click', async () => {
  const tip = $('worldMarketRows')
  tip.textContent = t('world.installing')
  try {
    const r = await window.companion.worldInstallZip()
    tip.textContent = r && r.ok ? t('world.installOk').replace('%n', r.manifest ? r.manifest.name : (r.id || '')) + (r.load && !r.load.ok ? ' · ' + t('world.loadFail') + r.load.error : '')
      : (r && r.canceled ? '' : t('world.installFail') + ((r && r.error) || ''))
  } catch (e) { tip.textContent = t('world.installFail') + e.message }
  worldRender()
})
$('worldMarketBtn').addEventListener('click', async () => {
  const url = $('worldMarketUrl').value.trim()
  const box = $('worldMarketRows')
  if (!url) { box.textContent = t('world.needUrl'); return }
  box.textContent = t('world.marketLoading')
  try {
    const r = await window.companion.worldMarket(url)
    if (!r || !r.ok) { box.textContent = t('world.marketFail') + ((r && r.error) || ''); return }
    const list = r.worlds || []
    if (!list.length) { box.textContent = t('world.marketEmpty'); return }
    box.innerHTML = ''
    for (const w of list) {
      const row = document.createElement('div')
      row.className = 'row'
      row.style.flexWrap = 'wrap'
      const compat = w.compatible ? '' : ` <span style="color:#ff8f8f">[${esc(t('world.osMismatch'))}]</span>`
      row.innerHTML = `<div style="flex-basis:100%"><b>${esc(w.name)}</b> v${esc(w.version)} · ${esc(w.author || '')}
        ${w.rating ? `★${w.rating}` : ''}${w.reviews ? `(${w.reviews})` : ''}${compat}
        ${w.tags && w.tags.length ? `<span style="opacity:.5">${w.tags.map(esc).join(' / ')}</span>` : ''}</div>
        <div class="hint" style="flex-basis:100%">${esc(w.description || '')}</div>`
      const btn = document.createElement('button')
      btn.className = 'cd-btn'
      btn.textContent = t('world.installBtn')
      btn.disabled = !w.compatible
      btn.addEventListener('click', async () => {
        btn.disabled = true
        btn.textContent = t('world.installing')
        try {
          const r2 = await window.companion.worldInstallUrl(w.download)
          btn.textContent = r2 && r2.ok ? t('world.installOkShort') : t('world.installFail') + ((r2 && r2.error) || '')
        } catch (e) { btn.textContent = t('world.installFail') + e.message }
        worldRender()
      })
      row.appendChild(btn)
      box.appendChild(row)
    }
  } catch (e) { box.textContent = t('world.marketFail') + e.message }
})

/** 自建输入弹窗（Electron 渲染层禁用 window.prompt，这里轻量实现：返回 Promise<string|null>） */
function uiPrompt (title, value = '') {
  return new Promise((resolve) => {
    const ov = document.createElement('div')
    ov.style.cssText = 'position:fixed;inset:0;z-index:400;background:rgba(13, 13, 13,.62);display:flex;align-items:center;justify-content:center'
    const card = document.createElement('div')
    card.style.cssText = 'width:min(360px,86vw);background:#232227;border:1px solid rgba(186, 185, 185,.35);border-radius:14px;padding:16px 18px 12px'
    const tip = document.createElement('div')
    tip.textContent = title
    tip.style.cssText = 'font-size:13px;color:#f4f4f5;margin-bottom:10px'
    const inp = document.createElement('input')
    inp.value = value
    inp.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:8px 10px;color:#f2f3f4;font-size:13px'
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px'
    const done = (v) => { ov.remove(); resolve(v) }
    const mk = (txt, primary) => {
      const b = document.createElement('button')
      b.textContent = txt
      b.style.cssText = 'border:0;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:12.5px;' + (primary
        ? 'background:#bab9c1;color:#fff' : 'background:rgba(255,255,255,.1);color:#e2e3e6')
      return b
    }
    const cancel = mk(t('ui.cancel')); cancel.onclick = () => done(null)
    const ok = mk(t('ui.ok'), true); ok.onclick = () => done(inp.value.trim())
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim()); if (e.key === 'Escape') done(null) }
    row.append(cancel, ok)
    card.append(tip, inp, row)
    ov.appendChild(card)
    document.body.appendChild(ov)
    inp.focus(); inp.select()
  })
}

$('imConnectBtn').addEventListener('click', async () => {
  const tip = $('imTip')
  await imSave()
  tip.textContent = t('im.connecting')
  try {
    const r = await window.companion.imConnect()
    tip.textContent = r && r.ok
      ? '✓ ' + t('im.connOk') + (r.status && r.status.selfId ? ` ${r.status.nickname || ''} (QQ:${r.status.selfId})` : '')
      : '✕ ' + ((r && r.error) || t('im.connFail'))
    imRender()
  } catch (e) { tip.textContent = '✕ ' + (e && e.message) }
})
$('imTestBtn').addEventListener('click', async () => {
  const tip = $('imTip')
  // 拉好友/群列表让用户点选（手输 group:123 格式太容易错，真机踩过）
  tip.textContent = '…'
  let lists = null
  try { lists = await window.companion.imListChats() } catch { }
  if (!lists || !lists.ok || (!lists.groups.length && !lists.friends.length)) {
    tip.textContent = '✕ ' + t('im.pickNone') + ((lists && lists.error) ? ' ' + lists.error : '')
    return
  }
  const r = await uiPickChat(lists)
  if (!r) return
  const chatId = (r.kind === 'group' ? 'group:' : 'private:') + r.id
  try {
    const res = await window.companion.imSendTest({ chatId, text: r.text })
    tip.textContent = res && res.ok ? '✓ ' + t('im.sent') : '✕ ' + ((res && res.error) || '')
  } catch (e) { tip.textContent = '✕ ' + (e && e.message) }
})

/** 测试消息目标选择器：类型（群/好友）+ 会话下拉 + 消息输入，返回 {kind,id,text} 或 null */
function uiPickChat (lists) {
  return new Promise((resolve) => {
    const ov = document.createElement('div')
    ov.style.cssText = 'position:fixed;inset:0;z-index:400;background:rgba(13, 13, 13,.62);display:flex;align-items:center;justify-content:center'
    const card = document.createElement('div')
    card.style.cssText = 'width:min(380px,86vw);background:#232227;border:1px solid rgba(186, 185, 185,.35);border-radius:14px;padding:16px 18px 12px'
    const title = document.createElement('div')
    title.textContent = t('im.pickTarget')
    title.style.cssText = 'font-size:13px;color:#f4f4f5;margin-bottom:10px'
    const rowStyle = 'display:flex;gap:8px;margin-bottom:8px'
    const selStyle = 'flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:7px 9px;color:#f2f3f4;font-size:12.5px'
    const row1 = document.createElement('div'); row1.style.cssText = rowStyle
    const kindSel = document.createElement('select'); kindSel.style.cssText = selStyle
    const og = document.createElement('option'); og.value = 'group'; og.textContent = t('im.pickGroup') + `（${lists.groups.length}）`
    const of = document.createElement('option'); of.value = 'friend'; of.textContent = t('im.pickFriend') + `（${lists.friends.length}）`
    kindSel.append(og, of)
    row1.appendChild(kindSel)
    const row2 = document.createElement('div'); row2.style.cssText = rowStyle
    const chatSel = document.createElement('select'); chatSel.style.cssText = selStyle
    row2.appendChild(chatSel)
    const row3 = document.createElement('div'); row3.style.cssText = rowStyle
    const msg = document.createElement('input')
    msg.placeholder = t('im.pickMsg')
    msg.value = 'ping ~'
    msg.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:7px 9px;color:#f2f3f4;font-size:12.5px'
    row3.appendChild(msg)
    const fill = () => {
      chatSel.innerHTML = ''
      const arr = kindSel.value === 'group' ? lists.groups : lists.friends
      for (const c of arr) {
        const o = document.createElement('option')
        o.value = c.id
        o.textContent = `${c.name}（${c.id}）`
        chatSel.appendChild(o)
      }
    }
    kindSel.onchange = fill
    fill()
    const nav = document.createElement('div')
    nav.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px'
    const done = (v) => { ov.remove(); resolve(v) }
    const mk = (txt, primary) => {
      const b = document.createElement('button')
      b.textContent = txt
      b.style.cssText = 'border:0;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:12.5px;' + (primary
        ? 'background:#bab9c1;color:#fff' : 'background:rgba(255,255,255,.1);color:#e2e3e6')
      return b
    }
    const cancel = mk(t('ui.cancel')); cancel.onclick = () => done(null)
    const ok = mk(t('ui.ok'), true)
    ok.onclick = () => done({ kind: kindSel.value === 'group' ? 'group' : 'private', id: chatSel.value, text: msg.value.trim() })
    nav.append(cancel, ok)
    card.append(title, row1, row2, row3, nav)
    ov.appendChild(card)
    document.body.appendChild(ov)
  })
}
$('imClearHistBtn').addEventListener('click', async () => {
  try { await window.companion.imClearHistory(); $('imTip').textContent = '✓ ' + t('im.cleared') } catch (e) { $('imTip').textContent = '✕ ' + (e && e.message) }
})

/* ---------------- 7.6 新手引导（8 步：语言→称呼→人设→走动→回应→模型→语音→按钮） ---------------- */
const GUIDE_STEPS = ['lang', 'name', 'persona', 'walk', 'reply', 'model', 'voice', 'buttons']
let guideIdx = 0
let guidePatch = {}

function guideEsc (s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function guideStepBody (step) {
  const s = (S && S.settings) || {}
  switch (step) {
    case 'lang': return `<label>${t('guide.langBody')}
        <select id="gdLang">
          <option value="auto">${t('ui.langAuto')}</option>
          <option value="zh">简体中文</option>
          <option value="zh-Hant">繁體中文</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
        </select></label>`
    case 'name': return `<label>${t('guide.nameBody')}
        <input id="gdName" maxlength="30" data-i18n-ph="guide.namePh" placeholder="怎么称呼你都行" value="${guideEsc(s.petUser)}"></label>`
    case 'persona': return `<div class="hint">${t('guide.personaBody').replace('{name}', char ? char.name : 'Ryza')}</div>`
    case 'walk': return `<label>${t('guide.walkBody')}
        <select id="gdWalk">
          <option value="off">${t('pet.walkOff')}</option>
          <option value="calm">${t('pet.walkCalm')}</option>
          <option value="lively">${t('pet.walkLively')}</option>
        </select></label>`
    case 'reply': return `<label class="cd-check"><input type="checkbox" id="gdRead" ${s.readReply !== false ? 'checked' : ''}> <span>${t('lang.readReply')}</span></label>`
    case 'model': return `<label>${t('guide.modelBase')}<input id="gdBase" placeholder="https://api.deepseek.com/v1" value="${guideEsc(s.apiBaseUrl)}"></label>
        <label>${t('guide.modelKey')}<input id="gdKey" type="password" value="${guideEsc(s.apiKey)}"></label>
        <label>${t('guide.modelName')}<input id="gdModel" placeholder="deepseek-chat" value="${guideEsc(s.apiModel)}"></label>
        <div class="hint">${t('guide.modelHint')}</div>`
    case 'voice': return `<label>${t('guide.voiceBody')}
        <select id="gdTts">
          <option value="browser">${t('tts.browser')}</option>
          <option value="api">${t('tts.api')}</option>
          <option value="off">${t('tts.off')}</option>
        </select></label>`
    case 'buttons': return `<div class="hint">${t('guide.buttonsBody')}</div>`
  }
  return ''
}

function guideRender () {
  const step = GUIDE_STEPS[guideIdx]
  const s = (S && S.settings) || {}
  $('guideSteps').textContent = (guideIdx + 1) + ' / ' + GUIDE_STEPS.length
  $('guideTitle').textContent = t('guide.title' + step.charAt(0).toUpperCase() + step.slice(1))
  $('guideBody').innerHTML = guideStepBody(step)
  const set = (id, v) => { const el = $(id); if (el && v != null && v !== '') el.value = v }
  if (step === 'lang') set('gdLang', localStorage.getItem(UI_LANG_KEY) || (s.uiLang || 'auto'))
  if (step === 'walk') set('gdWalk', s.petWalk || 'off')
  if (step === 'voice') set('gdTts', s.ttsMode || 'browser')
  $('guidePrev').disabled = guideIdx === 0
  $('guideNext').textContent = guideIdx === GUIDE_STEPS.length - 1 ? t('guide.done') : t('guide.next')
}

function guideCollect () {
  const step = GUIDE_STEPS[guideIdx]
  const v = (id) => { const el = $(id); return el ? el.value : null }
  if (step === 'lang') {
    const lang = v('gdLang') || 'auto'
    try { localStorage.setItem(UI_LANG_KEY, lang) } catch {}
    gdPatchUiLang = lang
  } else if (step === 'name') {
    guidePatch.petUser = (v('gdName') || '').trim()
  } else if (step === 'walk') {
    guidePatch.petWalk = v('gdWalk') || 'calm'
  } else if (step === 'reply') {
    guidePatch.readReply = !!($('gdRead') && $('gdRead').checked)
  } else if (step === 'model') {
    guidePatch.apiBaseUrl = (v('gdBase') || '').trim()
    guidePatch.apiKey = (v('gdKey') || '').trim()
    guidePatch.apiModel = (v('gdModel') || '').trim()
  } else if (step === 'voice') {
    guidePatch.ttsMode = v('gdTts') || 'browser'
  }
}
let gdPatchUiLang = null

function guideOpen () {
  guideIdx = 0
  guidePatch = {}
  gdPatchUiLang = null
  $('guide').hidden = false
  guideRender()
}

function guideClose () {
  $('guide').hidden = true
}

async function guideFinish () {
  const patch = Object.assign({}, guidePatch, { guideDone: true })
  if (gdPatchUiLang) patch.uiLang = gdPatchUiLang
  try { await window.companion.patchSettings(patch) } catch {}
  // 模型接入同步助手核心（与 cpSave 同一份，聊天真正调用的 provider）
  if (A && (patch.apiBaseUrl || patch.apiModel)) {
    try { await A.providerSet({ baseUrl: patch.apiBaseUrl, model: patch.apiModel, apiKey: patch.apiKey }) } catch {}
  }
  guidePatch = {}
  guideClose()
  // 界面语言改了 → 整窗重载让文案全部生效（与设置页切语言同款）
  if (gdPatchUiLang) location.reload()
}

$('guideNext').addEventListener('click', () => {
  guideCollect()
  guideIdx++
  if (guideIdx < GUIDE_STEPS.length) { guideRender(); return }
  guideFinish()
})
$('guidePrev').addEventListener('click', () => {
  if (guideIdx === 0) return
  guideIdx--
  guideRender()
})
$('guideSkip').addEventListener('click', async () => {
  try { await window.companion.patchSettings({ guideDone: true }) } catch {}
  guideClose()
})
$('cpGuideBtn').addEventListener('click', guideOpen)

/* ---------------- 启动 ---------------- */
;(async () => {
  S = await window.companion.init()
  char = S.characters[0]
  $('charName').textContent = char.name
  showVisual()
  // 聊天历史来自助手核心；角色人格以「角色管理里的当前角色」为准同步过去
  await syncRole(char)
  await loadAssistantHistory()
  // 配置里的 uiLang（另一台窗改的 / 备份导入的）比 localStorage 新时采纳，下次开窗生效
  try {
    const saved = S.settings && S.settings.uiLang
    if (saved && saved !== (localStorage.getItem(UI_LANG_KEY) || 'auto')) localStorage.setItem(UI_LANG_KEY, saved)
  } catch {}
  if (!S.settings || !S.settings.apiBaseUrl) {
    addMsg('', t('chat.noConfig'), 'syserr')
  }
  // 7.6 新手引导：第一次用才弹（完成/跳过后不再自动出，通用设置里可重看）
  if (!S.settings || S.settings.guideDone !== true) setTimeout(guideOpen, 600)
})().catch((e) => addMsg('', t('chat.initFail') + e.message, 'syserr'))
