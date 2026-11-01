'use strict'
/* 形象与装扮窗口：左预览右装扮（对齐规格 6.5：大图预览 + 调色盘编辑器 + 方案） */

const $ = (id) => document.getElementById(id)
const api = window.figureAPI

let st = { packs: [], figure: null, resolved: null, hasMode: false }
let sel = null // 选中的形象包 id
let dress = { axes: {}, palette: null, vars: {}, preset: null }
let resolved = null
let loops = { main: null, sample: null }
let statusTimer = null

/* -------------------------------- 启动 -------------------------------- */

async function boot () {
  st = await api.state()
  const usable = st.packs.filter((p) => !p.broken)
  const current = st.figure && usable.some((p) => p.id === st.figure.pack) ? st.figure.pack : null
  sel = current || (usable[0] && usable[0].id) || null
  if (sel) {
    if (current) {
      dress = {
        axes: Object.assign({}, st.figure.axes || {}),
        palette: st.figure.palette || null,
        vars: Object.assign({}, st.figure.vars || {}),
        preset: st.figure.preset || null
      }
    } else {
      const d = await api.defaultDress(sel)
      dress = d ? { axes: Object.assign({}, d.axes), palette: d.palette, vars: {}, preset: null } : { axes: {}, palette: null, vars: {}, preset: null }
    }
  }
  renderPacks()
  await refreshPreview()
  renderAxes()
  renderPalette()
  renderPresets()
  api.onChanged((next) => {
    st.packs = next.packs
    st.figure = next.figure
    renderPacks()
  })
}

function setStatus (text, kind) {
  const el = $('status')
  el.textContent = text || ''
  el.className = 'status' + (kind ? ' ' + kind : '')
  clearTimeout(statusTimer)
  if (text) statusTimer = setTimeout(() => { el.textContent = ''; el.className = 'status' }, 4200)
}

/* ------------------------------- 形象包列表 ------------------------------- */

function renderPacks () {
  const list = $('packList')
  list.innerHTML = ''
  $('packCount').textContent = st.packs.length ? st.packs.length + ' 个' : ''
  const inUse = st.figure && st.figure.pack
  for (const p of st.packs) {
    const row = document.createElement('div')
    row.className = 'pack' + (p.id === sel ? ' on' : '') + (p.broken ? ' broken' : '')
    const thumb = document.createElement('div')
    thumb.className = 'thumb'
    if (p.thumb) {
      const img = document.createElement('img')
      img.src = p.thumb
      img.alt = ''
      thumb.appendChild(img)
    } else thumb.textContent = p.broken ? '⚠' : '🧩'
    const mid = document.createElement('div')
    const nm = document.createElement('div')
    nm.className = 'nm'
    nm.textContent = p.name || p.id
    const sub = document.createElement('div')
    sub.className = 'sub'
    sub.textContent = p.broken
      ? p.broken
      : [(p.author ? 'by ' + p.author : ''), (p.axes && p.axes.length ? p.axes.length + ' 个装扮位' : ''), (p.version ? 'v' + p.version : ''), fmtSize(p.sizeBytes)].filter(Boolean).join(' · ')
    mid.appendChild(nm)
    mid.appendChild(sub)
    const tag = document.createElement('div')
    tag.className = 'tag'
    tag.textContent = p.id === inUse ? '使用中' : ''
    row.appendChild(thumb)
    row.appendChild(mid)
    row.appendChild(tag)
    row.addEventListener('click', () => selectPack(p.id))
    list.appendChild(row)
  }
  $('btnDelPack').disabled = !sel
}

async function selectPack (id) {
  if (id === sel) return
  const p = st.packs.find((x) => x.id === id)
  if (!p || p.broken) { setStatus('这个形象包不可用：' + (p ? p.broken : '已删除'), 'err'); return }
  sel = id
  const d = await api.defaultDress(id)
  dress = d ? { axes: Object.assign({}, d.axes), palette: d.palette, vars: {}, preset: null } : { axes: {}, palette: null, vars: {}, preset: null }
  renderPacks()
  await refreshPreview()
  renderAxes()
  renderPalette()
  renderPresets()
  setStatus('已切换到「' + (p.name || p.id) + '」，点「应用到伙伴」生效')
}

/* -------------------------------- 预览 -------------------------------- */

async function refreshPreview () {
  if (!sel) {
    resolved = null
    $('stageEmpty').hidden = false
    $('packName').textContent = '—'
    $('pvMeta').textContent = '—'
    $('pvDress').textContent = '—'
    if (loops.main) { loops.main.stop(); loops.main = null }
    if (loops.sample) { loops.sample.stop(); loops.sample = null }
    const c = $('preview').getContext('2d')
    c.clearRect(0, 0, $('preview').width, $('preview').height)
    return
  }
  resolved = await api.resolve(sel, Object.assign({ pack: sel }, dress))
  if (!resolved) {
    setStatus('形象包解析失败（figure.json 可能已被改动）', 'err')
    return
  }
  $('stageEmpty').hidden = true
  $('packName').textContent = resolved.name
  const meta = [resolved.name, (resolved.size || []).join('×')].filter(Boolean).join(' · ')
  $('pvMeta').textContent = meta
  $('pvDress').textContent = dressSummary()

  if (!loops.main) loops.main = window.AuraFigure.startLoop($('preview'), resolved, { interval: 50 })
  else await loops.main.update(resolved)
  if (!loops.sample) loops.sample = window.AuraFigure.startLoop($('sample'), resolved, { interval: 80 })
  else await loops.sample.update(resolved)
  applyConsoleTheme()
}

/** 规格 6.7：形象包的 presets[].console 可以自带主题色，装扮窗跟它走 */
function applyConsoleTheme () {
  const root = document.documentElement
  const p = resolved && resolved.presets.find((x) => x.id === dress.preset)
  const con = p && p.console && (p.console.dark || p.console.light)
  if (con && con.accent) root.style.setProperty('--accent', con.accent)
  else root.style.removeProperty('--accent')
  if (con && con['accent-2']) root.style.setProperty('--accent-2', con['accent-2'])
  else root.style.removeProperty('--accent-2')
}

function dressSummary () {
  if (!resolved) return ''
  const parts = []
  for (const a of resolved.axes) {
    const optId = dress.axes[a.id]
    const opt = a.options.find((o) => o.id === optId)
    if (opt && opt.id !== 'none' && opt.label !== '无') parts.push(a.label + '：' + opt.label)
  }
  const pal = resolved.palettes.find((p) => p.id === dress.palette)
  if (pal) parts.push('配色：' + pal.label)
  return parts.length ? parts.join(' · ') : '默认搭配'
}

/* -------------------------------- 装扮 -------------------------------- */

function renderAxes () {
  const box = $('axes')
  box.innerHTML = ''
  $('axisCount').textContent = resolved && resolved.axes.length ? resolved.axes.length + ' 个' : ''
  if (!resolved || !resolved.axes.length) {
    const tip = document.createElement('div')
    tip.className = 'empty-tip'
    tip.textContent = resolved ? '这个形象包没有可换的部件（只能换配色）' : '选一个形象包'
    box.appendChild(tip)
    return
  }
  for (const a of resolved.axes) {
    const wrap = document.createElement('div')
    const lab = document.createElement('div')
    lab.className = 'axis-label'
    lab.textContent = a.label
    const chips = document.createElement('div')
    chips.className = 'chips'
    for (const o of a.options) {
      const b = document.createElement('button')
      b.className = 'chip' + ((dress.axes[a.id] || (a.options[0] && a.options[0].id)) === o.id ? ' on' : '')
      b.textContent = o.label
      b.addEventListener('click', async () => {
        dress.axes[a.id] = o.id
        dress.preset = null // 手动改过就不再挂在某个方案上
        await refreshPreview()
        renderAxes()
        renderPresets()
      })
      chips.appendChild(b)
    }
    wrap.appendChild(lab)
    wrap.appendChild(chips)
    box.appendChild(wrap)
  }
}

/* -------------------------------- 配色 -------------------------------- */

function paletteOf () {
  if (!resolved) return null
  return resolved.palettes.find((p) => p.id === dress.palette) || resolved.palettes[0] || null
}

function renderPalette () {
  const selEl = $('paletteSel')
  selEl.innerHTML = ''
  const sw = $('swatches')
  sw.innerHTML = ''
  if (!resolved || !resolved.palettes.length) {
    $('palBadge').hidden = true
    return
  }
  for (const p of resolved.palettes) {
    const o = document.createElement('option')
    o.value = p.id
    o.textContent = p.label + (p.id.startsWith('custom-') ? '（我的）' : '')
    selEl.appendChild(o)
  }
  const cur = paletteOf()
  selEl.value = cur ? cur.id : ''
  $('palBadge').hidden = !(cur && cur.id.startsWith('custom-'))

  // 色板：调色盘的变量 + 配件双色通道（c-<slot>-main / -acc）
  const keys = new Set()
  for (const p of resolved.palettes) for (const k of Object.keys(p.vars || {})) keys.add(k)
  for (const k of Object.keys(resolved.vars || {})) if (k.startsWith('c-')) keys.add(k)
  const list = [...keys].slice(0, 12)
  if (!list.length) {
    const tip = document.createElement('div')
    tip.className = 'empty-tip'
    tip.textContent = '这个形象包没有配色变量（图案是固定色）'
    sw.appendChild(tip)
    return
  }
  for (const k of list) {
    const val = (resolved.vars && resolved.vars[k]) || '#888888'
    const cell = document.createElement('label')
    cell.className = 'sw'
    const inp = document.createElement('input')
    inp.type = 'color'
    inp.value = /^#[0-9a-f]{6}$/i.test(val) ? val : '#888888'
    const name = document.createElement('span')
    name.className = 'k'
    name.textContent = k
    inp.addEventListener('change', () => editVar(k, inp.value))
    cell.appendChild(inp)
    cell.appendChild(name)
    sw.appendChild(cell)
  }
}

/**
 * 改色：内置配色不直接改（升级包会覆盖），自动先复制成「我的配色」再改
 * 这样用户永远有一份可回退的官方配色
 */
async function editVar (key, value) {
  const cur = paletteOf()
  if (!cur) return
  if (cur.id.startsWith('custom-')) {
    const vars = Object.assign({}, cur.vars, { [key]: value })
    await api.savePalette(sel, { id: cur.id, label: cur.label, vars })
  } else {
    const vars = Object.assign({}, resolved.vars, { [key]: value })
    const id = 'custom-' + Date.now().toString(36)
    await api.savePalette(sel, { id, label: '我的配色', vars })
    dress.palette = id
    dress.vars = {}
  }
  await refreshPreview()
  renderPalette()
  setStatus('配色已更新')
}

async function copyPalette () {
  const cur = paletteOf()
  if (!cur) return
  const vars = Object.assign({}, cur.vars)
  const id = 'custom-' + Date.now().toString(36)
  await api.savePalette(sel, { id, label: '我的配色', vars })
  dress.palette = id
  dress.vars = {}
  await refreshPreview()
  renderPalette()
  setStatus('已复制成「我的配色」，现在可以直接改色')
}

/* -------------------------------- 方案 -------------------------------- */

function renderPresets () {
  const box = $('presets')
  box.innerHTML = ''
  if (!resolved || !resolved.presets.length) {
    const tip = document.createElement('div')
    tip.className = 'empty-tip'
    tip.textContent = '这个包没有内置方案（可以自己存一个）'
    box.appendChild(tip)
    return
  }
  for (const p of resolved.presets) {
    const b = document.createElement('button')
    b.className = 'chip' + (dress.preset === p.id ? ' on' : '')
    b.textContent = p.label
    if (p.custom) {
      const x = document.createElement('span')
      x.className = 'x'
      x.textContent = '✕'
      x.title = '删除这个方案'
      x.addEventListener('click', async (e) => {
        e.stopPropagation()
        await api.delCustom(sel, 'preset', p.id)
        if (dress.preset === p.id) dress.preset = null
        await refreshPreview()
        renderPresets()
        setStatus('方案已删除')
      })
      b.appendChild(x)
    }
    b.addEventListener('click', async () => {
      if (dress.preset === p.id) {
        dress.preset = null // 再点一次取消挂载，回到纯手动
      } else {
        dress.preset = p.id
        dress.axes = Object.assign({}, p.axes || {})
        dress.palette = p.palette || null
        dress.vars = {}
      }
      await refreshPreview()
      renderAxes()
      renderPalette()
      renderPresets()
    })
    box.appendChild(b)
  }
}

async function savePreset () {
  if (!resolved) return
  const raw = ($('presetName').value || '').trim()
  const label = (raw || '我的方案').slice(0, 12)
  const id = 'custom-' + Date.now().toString(36)
  const out = await api.savePreset(sel, {
    id,
    label,
    axes: dress.axes,
    palette: dress.palette,
    vars: dress.vars
  })
  if (!out) { setStatus('保存方案失败', 'err'); return }
  dress.preset = id
  $('presetName').value = ''
  await refreshPreview()
  renderPresets()
  setStatus('已保存方案「' + label + '」')
}

/* -------------------------------- 动作 -------------------------------- */

async function apply () {
  if (!sel) return
  const out = await api.apply(Object.assign({ pack: sel }, dress))
  if (!out || !out.ok) { setStatus('应用失败：' + ((out && out.reason) || '未知原因'), 'err'); return }
  st.figure = out.char && out.char.visual ? out.char.visual.figure : st.figure
  renderPacks()
  setStatus('已应用到伙伴', 'ok')
}

async function randomDress () {
  if (!resolved) return
  const axes = {}
  for (const a of resolved.axes) {
    const pool = a.options.length > 2 ? a.options.slice(1) : a.options // 尽量不随机到「无」
    axes[a.id] = pool[Math.floor(Math.random() * pool.length)].id
  }
  const pal = resolved.palettes[Math.floor(Math.random() * resolved.palettes.length)]
  dress = { axes, palette: pal ? pal.id : null, vars: {}, preset: null }
  await refreshPreview()
  renderAxes()
  renderPalette()
  renderPresets()
  setStatus('随机了一套搭配')
}

async function resetDress () {
  if (!sel) return
  const d = await api.defaultDress(sel)
  dress = d ? { axes: Object.assign({}, d.axes), palette: d.palette, vars: {}, preset: null } : { axes: {}, palette: null, vars: {}, preset: null }
  await refreshPreview()
  renderAxes()
  renderPalette()
  renderPresets()
  setStatus('已还原成默认搭配')
}

async function importPack (kind) {
  const out = await api.importPack(kind)
  if (!out || out.canceled) return
  if (!out.ok) { setStatus('导入失败：' + (out.reason || '未知原因'), 'err'); return }
  st = await api.state()
  renderPacks()
  await selectPack(out.id)
  setStatus('导入成功：' + (out.name || out.id), 'ok')
}

async function importPath (p) {
  const out = await api.importPath(p)
  if (!out || !out.ok) {
    setStatus('导入失败：' + ((out && out.reason) || '未知原因'), 'err')
    return
  }
  st = await api.state()
  renderPacks()
  await selectPack(out.id)
  setStatus('导入成功：' + (out.name || out.id), 'ok')
}

let delArm = 0
function fmtSize (b) {
  const n = Number(b) || 0
  if (!n) return ''
  return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'
}
async function delPack () {
  if (!sel) return
  // 0.18.0 第二批：删除是不可逆的（自定义配色/方案一起走），点两下才真删
  if (Date.now() - delArm > 3000) {
    delArm = Date.now()
    const p0 = st.packs.find((x) => x.id === sel)
    setStatus('再点一次「确认删除」就会永久删除「' + ((p0 && p0.name) || sel) + '」' + (p0 && p0.sizeBytes ? '（' + fmtSize(p0.sizeBytes) + '）' : '') + '，连同自定义配色一起', 'warn')
    const btn = document.getElementById('btnDelPack')
    if (btn) {
      btn.textContent = '确认删除？'
      setTimeout(() => { if (btn) btn.textContent = '删除选中的形象包'; delArm = 0 }, 3000)
    }
    return
  }
  delArm = 0
  const btn2 = document.getElementById('btnDelPack')
  if (btn2) btn2.textContent = '删除选中的形象包'
  const p = st.packs.find((x) => x.id === sel)
  const out = await api.remove(sel)
  if (!out) { setStatus('删除失败', 'err'); return }
  st = await api.state()
  const next = st.packs.filter((x) => !x.broken)[0]
  sel = next ? next.id : null
  if (sel) {
    const d = await api.defaultDress(sel)
    dress = d ? { axes: Object.assign({}, d.axes), palette: d.palette, vars: {}, preset: null } : { axes: {}, palette: null, vars: {}, preset: null }
  } else {
    dress = { axes: {}, palette: null, vars: {}, preset: null }
  }
  renderPacks()
  await refreshPreview()
  renderAxes()
  renderPalette()
  renderPresets()
  setStatus('已删除「' + ((p && p.name) || '形象包') + '」')
}

/* -------------------------------- 事件绑定 -------------------------------- */

function bind () {
  $('btnMin').addEventListener('click', () => api.min())
  $('btnClose').addEventListener('click', () => api.close())
  $('btnImportZip').addEventListener('click', () => importPack('zip'))
  $('btnImportDir').addEventListener('click', () => importPack('dir'))
  $('btnDelPack').addEventListener('click', delPack)
  $('btnApply').addEventListener('click', apply)
  $('btnRandom').addEventListener('click', randomDress)
  $('btnReset').addEventListener('click', resetDress)
  $('btnClear').addEventListener('click', async () => {
    await api.clear()
    setStatus('已退出形象包，伙伴回到立绘')
  })
  $('btnCopyPal').addEventListener('click', copyPalette)
  $('btnPalReset').addEventListener('click', resetDress)
  $('btnSavePreset').addEventListener('click', savePreset)
  $('paletteSel').addEventListener('change', async (e) => {
    dress.palette = e.target.value
    dress.vars = {}
    await refreshPreview()
    renderPalette()
  })

  // 拖入 zip：整窗都能接，别让 Chromium 把文件当导航打开
  const zone = $('dropZone')
  const stop = (e) => { e.preventDefault(); e.stopPropagation() }
  for (const ev of ['dragenter', 'dragover']) {
    document.addEventListener(ev, (e) => { stop(e); zone.classList.add('drag'); $('dropHint').hidden = false })
  }
  document.addEventListener('dragleave', (e) => {
    stop(e)
    if (e.relatedTarget) return
    zone.classList.remove('drag')
    $('dropHint').hidden = true
  })
  document.addEventListener('drop', (e) => {
    stop(e)
    zone.classList.remove('drag')
    $('dropHint').hidden = true
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
    if (!f) return
    const p = api.pathOf(f)
    if (!p) { setStatus('拿不到文件路径，请用「导入 .zip」按钮', 'err'); return }
    importPath(p)
  })
}

bind()
boot().catch((err) => {
  setStatus('初始化失败：' + (err && err.message), 'err')
  console.error('[dress]', err)
})
