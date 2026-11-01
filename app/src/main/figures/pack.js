'use strict'
/**
 * 形象包（figure pack）· API 2
 *
 * 位置：userData/figures/<packId>/figure.json + 贴图
 * 格式（figure.json）：
 *   {
 *     "api": 2,                       // 必填，只接受 2（1 是旧版单图层格式，直接 skipped 给原因）
 *     "manifest": { "name": "...", "author": "...", "url": "...", "version": "1.0.0" },
 *     "size": [360, 560],             // 舞台逻辑尺寸（渲染层按此建立坐标系）
 *     "thumbnail": "thumb.png",       // 可选，≤1MB
 *     "layers": [                     // 基础层，z 小的先画
 *       { "z": 0, "type": "shape", "shape": "ellipse", "x": 0, "y": 0, "w": 100, "h": 100,
 *         "fill": "$skin" },          // "$变量名" / "#hex" / "c:main" / "c:acc"
 *       { "z": 10, "type": "image", "src": "img/body.png", "x": 0, "y": 0, "w": 360, "h": 560 }
 *     ],
 *     "axes": [                       // 装扮维度由包声明，不硬编码（帽子/耳饰/眼镜/颈饰/配色…）
 *       { "id": "hat", "label": "帽子", "slot": "hat",
 *         "options": [ { "id": "none", "label": "无" },
 *                      { "id": "beret", "label": "贝雷帽",
 *                        "layer": { "z": 30, "type": "shape", "shape": "ellipse", "...": "..." },
 *                        "vars": { "c-hat-main": "#6d4aff", "c-hat-acc": "#ffcf5c" } } ] }
 *     ],
 *     "palettes": [ { "id": "default", "label": "默认", "vars": { "skin": "#f6d7c4" } } ],
 *     "presets":  [ { "id": "casual", "label": "日常", "axes": { "hat": "beret" },
 *                    "palette": "default", "vars": {}, "console": { "light": {}, "dark": {} } } ]
 *   }
 *
 * 导入流程（对齐规格 6.2）：stage → 校验 → 原子 install
 *   - zip 单文件，或直接给文件夹
 *   - 深度 ≤3、解压总量 ≤128MB、缩略图 ≤1MB、条目 ≤512
 *   - 全部校验通过才 rename 进最终目录，失败不留下半个包
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { readZip, safeName } = require('./zip')

let appRef = null
try { appRef = require('electron').app } catch {}
let baseOverride = null

/** 测试用：把形象包根目录指到临时目录 */
function setBaseDir (dir) { baseOverride = dir || null }
function base () {
  if (baseOverride) {
    fs.mkdirSync(baseOverride, { recursive: true })
    return baseOverride
  }
  const dir = path.join(appRef.getPath('userData'), 'figures')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
function packDir (id) { return path.join(base(), id) }

const LIMIT = {
  zipBytes: 128 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  thumbBytes: 1024 * 1024,
  entries: 512,
  layers: 96,
  axes: 16,
  options: 48,
  vars: 80,
  nameLen: 60
}

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|transparent|none|rgba?\([\d\s.,%]+\))$/
const SHAPES = new Set(['ellipse', 'rect', 'path'])
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i

function num (v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

function slug (s, fallback) {
  const out = String(s || '').toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  if (/^[a-z0-9]/.test(out)) return out
  // 中文名 / 空名：用哈希，保证稳定且合法
  return (fallback || 'pack') + '-' + crypto.createHash('md5').update(String(s || '')).digest('hex').slice(0, 8)
}

/** 颜色变量引用：
 *   $name        调色盘变量
 *   c:main/c:acc 配件双色通道（槽位由图层所在维度决定 → c-<slot>-main / -acc，对齐规格 6.6）
 *   c:hat-acc    直接写完整通道名（一个部件用别的槽位颜色时方便）
 *   #hex / rgba() 固定色
 */
function colorRef (raw, ctx) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return null
  let key = null
  let fallback = null
  if (s.startsWith('$')) key = s.slice(1)
  else if (s.startsWith('c:')) {
    const rest = s.slice(2)
    const ch = rest === 'main' || rest === 'acc' ? rest : null
    const slot = (ctx && ctx.slot) || 'acc'
    key = ch ? 'c-' + slot + '-' + ch : 'c-' + rest
    fallback = ch
  }
  if (key) {
    const vars = (ctx && ctx.vars) || {}
    const v = vars[key]
    if (v && COLOR_RE.test(String(v))) return { kind: 'var', key, value: String(v) }
    // 通道没配就退回调色盘的通用 main/acc，避免配件变透明
    if (fallback) {
      const f = vars[fallback] || vars.slot
      if (f && COLOR_RE.test(String(f))) return { kind: 'var', key, value: String(f) }
      return { kind: 'lit', value: ch === 'main' ? '#8b93a7' : '#c9d2e3' }
    }
    return null // 变量缺失：这一层不画（好过画成黑色块）
  }
  if (!COLOR_RE.test(s)) return null
  return { kind: 'lit', value: s }
}

/* 0.26.0：程序化动作的部位声明。
 * 包可以显式标 part，让「走路/挥手/点头」知道该转哪一层；
 * 不标也能动（渲染层按几何推断腿/臂/头/身），标了更准。 */
const PARTS = new Set(['head', 'body', 'armL', 'armR', 'legL', 'legR', 'mouth'])   // mouth: 口型层（0.41.0）

/** needs：包对宿主的要求（0.41.0）。都是可选的，老包不给就是默认值 */
function normNeeds (raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const stage = Array.isArray(o.stage) && o.stage.length === 2 && o.stage.every((v) => Number(v) > 0)
    ? [Math.min(4096, Math.max(80, num(o.stage[0], 360))), Math.min(4096, Math.max(80, num(o.stage[1], 560)))]
    : null
  return {
    facing: o.facing === 'left' ? 'left' : 'right',
    views: Array.isArray(o.views) ? o.views.filter((v) => v === 'front' || v === 'side').slice(0, 2) : ['front'],
    stage,
    anchor: o.anchor === 'center' ? 'center' : 'bottom'
  }
}

function normLayer (raw, idx) {
  if (!raw || typeof raw !== 'object') return null
  const type = raw.type === 'image' ? 'image' : 'shape'
  const ly = {
    id: typeof raw.id === 'string' && /^[a-z0-9_-]{1,32}$/i.test(raw.id) ? raw.id : null,
    z: num(raw.z, idx),
    type,
    // blink: 'closed' 只在眨眼瞬间画（闭眼层），'open' 眨眼时藏起来（睁眼层）
    blink: raw.blink === 'closed' || raw.blink === 'open' ? raw.blink : null,
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    w: num(raw.w, 0),
    h: num(raw.h, 0),
    opacity: Math.min(1, Math.max(0, num(raw.opacity, 1))),
    rotate: num(raw.rotate, 0),
    fill: typeof raw.fill === 'string' ? raw.fill : null,
    // 描边：眼镜、头发高光、衣服压线都要它（只填不描的形状做不出细线）
    stroke: typeof raw.stroke === 'string' ? raw.stroke : null,
    strokeWidth: Math.max(0, num(raw.strokeWidth, 0)),
    slot: ID_RE.test(String(raw.slot || '')) ? raw.slot : null,
    // 程序化动作：部位（腿/臂/头/身）+ 可选枢轴（0~1 归一化，默认按部位取）
    part: PARTS.has(String(raw.part || '')) ? raw.part : null,
    pivot: Array.isArray(raw.pivot) && raw.pivot.length === 2
      ? [Math.min(1, Math.max(0, num(raw.pivot[0], 0.5))), Math.min(1, Math.max(0, num(raw.pivot[1], 0.5)))]
      : null,
    // 图片图层用 tint 做整体着色（multiply 合成），shapes 直接用 fill
    tint: typeof raw.tint === 'string' ? raw.tint : null,
    tintAlpha: Math.min(1, Math.max(0, num(raw.tintAlpha, 1))),
    // 口型：part:'mouth' 的层用 open(0~1) 标开口度，渲染层按当前开口度挑最近的一张
    open: raw.part === 'mouth' ? Math.min(1, Math.max(0, num(raw.open, 0))) : null
  }
  if (type === 'image') {
    const src = safeName(raw.src)
    if (!src) return null
    ly.src = src
  } else {
    ly.shape = SHAPES.has(raw.shape) ? raw.shape : 'ellipse'
    ly.rx = Math.max(0, num(raw.rx, 0))
    if (ly.shape === 'path') {
      const d = String(raw.d || '').trim()
      // 只允许数字、命令字母与分隔符，防止注入奇怪的 path 语法
      if (!d || !/^[MmLlHhVvCcSsQqTtAaZz0-9\s.,+-]+$/.test(d) || d.length > 4000) return null
      ly.d = d
    }
    if (!ly.fill && !(ly.stroke && ly.strokeWidth > 0)) return null
  }
  return ly
}

/**
 * 校验 figure.json（纯函数，不碰文件）
 * @returns {{ok:boolean, reason?:string, fig?:object}}
 */
function validateFigure (json, files) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'figure.json 不是对象' }
  const api = Number(json.api)
  if (!Number.isFinite(api)) return { ok: false, reason: '缺少 api 字段（只接受 API 2 形象包）' }
  if (api !== 2) return { ok: false, reason: '这是 API ' + api + ' 形象包，当前只支持 API 2（请在形象包里把 api 改为 2）' }
  if (json.oldest != null && Number(json.oldest) > 2) {
    return { ok: false, reason: '形象包要求最低 API ' + json.oldest + '，当前支持 2' }
  }

  const manifest = json.manifest && typeof json.manifest === 'object' ? json.manifest : {}
  const name = String(manifest.name || json.name || '').trim().slice(0, LIMIT.nameLen)
  if (!name) return { ok: false, reason: '缺少 manifest.name（形象包名字）' }

  const sizeRaw = Array.isArray(json.size) ? json.size : []
  const size = [Math.min(4096, Math.max(80, num(sizeRaw[0], 360))), Math.min(4096, Math.max(80, num(sizeRaw[1], 560)))]

  const have = files || null
  const missing = (src) => have && !have.has(src)

  const rawLayers = Array.isArray(json.layers) ? json.layers : []
  if (rawLayers.length > LIMIT.layers) return { ok: false, reason: '基础图层过多（上限 ' + LIMIT.layers + '）' }
  const layers = []
  for (let i = 0; i < rawLayers.length; i++) {
    const ly = normLayer(rawLayers[i], i)
    if (!ly) return { ok: false, reason: '第 ' + (i + 1) + ' 个图层格式不对' }
    if (ly.type === 'image' && missing(ly.src)) return { ok: false, reason: '图层引用的图片不存在：' + ly.src }
    layers.push(ly)
  }
  if (!layers.length) return { ok: false, reason: '没有可绘制的基础图层（layers 为空）' }

  // 0.41.0：needs（包对宿主的要求）+ views.side（侧身走用的另一套图）
  const needs = normNeeds(json.needs)
  const views = {}
  if (json.views && typeof json.views === 'object' && json.views.side) {
    const rawSide = Array.isArray(json.views.side.layers) ? json.views.side.layers : []
    if (rawSide.length > LIMIT.layers) return { ok: false, reason: '侧身图层过多（上限 ' + LIMIT.layers + '）' }
    const side = []
    for (let i = 0; i < rawSide.length; i++) {
      const ly = normLayer(rawSide[i], i)
      if (!ly) return { ok: false, reason: '侧身第 ' + (i + 1) + ' 个图层格式不对' }
      if (ly.type === 'image' && missing(ly.src)) return { ok: false, reason: '侧身图层引用的图片不存在：' + ly.src }
      side.push(ly)
    }
    if (side.length) {
      views.side = { layers: side }
      if (needs.views.indexOf('side') < 0) needs.views.push('side')
    }
  }

  const rawAxes = Array.isArray(json.axes) ? json.axes : []
  if (rawAxes.length > LIMIT.axes) return { ok: false, reason: '装扮维度过多（上限 ' + LIMIT.axes + '）' }
  const axes = []
  const axisIds = new Set()
  for (const a of rawAxes) {
    if (!a || !ID_RE.test(String(a.id || ''))) return { ok: false, reason: '装扮维度 id 不合法：' + String(a && a.id) }
    if (axisIds.has(a.id)) return { ok: false, reason: '装扮维度 id 重复：' + a.id }
    axisIds.add(a.id)
    const rawOpts = Array.isArray(a.options) ? a.options : []
    if (!rawOpts.length) return { ok: false, reason: '维度 ' + a.id + ' 没有选项' }
    if (rawOpts.length > LIMIT.options) return { ok: false, reason: '维度 ' + a.id + ' 选项过多' }
    const options = []
    const optIds = new Set()
    for (const o of rawOpts) {
      if (!o || !ID_RE.test(String(o.id || ''))) return { ok: false, reason: '维度 ' + a.id + ' 的选项 id 不合法' }
      if (optIds.has(o.id)) return { ok: false, reason: '维度 ' + a.id + ' 的选项 id 重复：' + o.id }
      optIds.add(o.id)
      const opt = { id: o.id, label: String(o.label || o.id).slice(0, 24) }
      // 一个部件通常由多层组成（眼镜 = 两片镜片 + 鼻梁），所以支持 layer 与 layers 两种写法
      const rawLayers2 = Array.isArray(o.layers) ? o.layers : (o.layer ? [o.layer] : [])
      if (rawLayers2.length > 8) return { ok: false, reason: '维度 ' + a.id + ' 的选项 ' + o.id + ' 图层过多（上限 8）' }
      const optLayers = []
      for (const rawLy of rawLayers2) {
        const ly = normLayer(rawLy, 100 + optLayers.length)
        if (!ly) return { ok: false, reason: '维度 ' + a.id + ' 的选项 ' + o.id + ' 图层格式不对' }
        if (ly.type === 'image' && missing(ly.src)) return { ok: false, reason: '配件图片不存在：' + ly.src }
        optLayers.push(ly)
      }
      if (optLayers.length) opt.layers = optLayers
      if (o.vars && typeof o.vars === 'object') {
        const vars = {}
        for (const [k, v] of Object.entries(o.vars)) {
          if (!/^[a-z0-9-]{1,40}$/i.test(k)) continue
          if (!COLOR_RE.test(String(v))) continue
          vars[k] = String(v)
        }
        if (Object.keys(vars).length) opt.vars = vars
      }
      options.push(opt)
    }
    axes.push({
      id: a.id,
      label: String(a.label || a.id).slice(0, 16),
      slot: ID_RE.test(String(a.slot || '')) ? a.slot : a.id,
      options
    })
  }

  const rawPal = Array.isArray(json.palettes) ? json.palettes : []
  const palettes = []
  for (const p of rawPal) {
    if (!p || !ID_RE.test(String(p.id || ''))) return { ok: false, reason: '调色盘 id 不合法' }
    const vars = {}
    for (const [k, v] of Object.entries(p.vars && typeof p.vars === 'object' ? p.vars : {})) {
      if (!/^[a-z0-9-]{1,40}$/i.test(k)) continue
      if (!COLOR_RE.test(String(v))) continue
      vars[k] = String(v)
    }
    if (Object.keys(vars).length > LIMIT.vars) return { ok: false, reason: '调色盘变量过多：' + p.id }
    palettes.push({ id: p.id, label: String(p.label || p.id).slice(0, 16), vars })
  }

  const rawPresets = Array.isArray(json.presets) ? json.presets : []
  const presets = []
  for (const s of rawPresets) {
    if (!s || !ID_RE.test(String(s.id || ''))) continue
    const ax = {}
    for (const [k, v] of Object.entries(s.axes && typeof s.axes === 'object' ? s.axes : {})) {
      if (axisIds.has(k) && ID_RE.test(String(v))) ax[k] = String(v)
    }
    const vars = {}
    for (const [k, v] of Object.entries(s.vars && typeof s.vars === 'object' ? s.vars : {})) {
      if (/^[a-z0-9-]{1,40}$/i.test(k) && COLOR_RE.test(String(v))) vars[k] = String(v)
    }
    const console_ = s.console && typeof s.console === 'object'
      ? {
          light: plainColors(s.console.light),
          dark: plainColors(s.console.dark)
        }
      : null
    presets.push({
      id: s.id,
      label: String(s.label || s.id).slice(0, 16),
      axes: ax,
      palette: ID_RE.test(String(s.palette || '')) ? s.palette : (palettes[0] ? palettes[0].id : null),
      vars,
      console: console_
    })
  }

  let thumb = null
  if (json.thumbnail) {
    const t = safeName(json.thumbnail)
    if (!t) return { ok: false, reason: '缩略图路径不合法' }
    if (missing(t)) return { ok: false, reason: '缩略图不存在：' + t }
    thumb = t
  }

  return {
    ok: true,
    fig: {
      api: 2,
      name,
      author: String(manifest.author || '').slice(0, 32),
      url: String(manifest.url || '').slice(0, 200),
      version: String(manifest.version || '').slice(0, 16),
      size,
      thumb,
      needs,
      views,
      layers,
      axes,
      palettes,
      presets
    }
  }
}

function plainColors (o) {
  const out = {}
  if (!o || typeof o !== 'object') return out
  for (const [k, v] of Object.entries(o)) {
    if (/^[a-z0-9-]{1,40}$/i.test(k) && COLOR_RE.test(String(v))) out[k] = String(v)
  }
  return out
}

/* ------------------------------------------------------------------ 安装 */

function uniqueId (want) {
  const root = base()
  let id = want
  let i = 2
  while (fs.existsSync(path.join(root, id))) id = want + '-' + i++
  return id
}

function writeEntries (dir, entries) {
  for (const e of entries) {
    const dest = path.join(dir, e.name)
    const parent = path.dirname(dest)
    // 二次确认落点没跑出暂存目录（zip 层已经拦过，这里防手滑）
    if (!path.resolve(parent).startsWith(path.resolve(dir))) throw new Error('非法路径：' + e.name)
    fs.mkdirSync(parent, { recursive: true })
    fs.writeFileSync(dest, e.data)
  }
}

/** stage → 校验 → 原子 install；任何一步失败都清掉暂存目录 */
function installEntries (entries, sourceLabel) {
  const root = base()
  const staging = path.join(root, '.staging-' + crypto.randomBytes(4).toString('hex'))
  fs.mkdirSync(staging, { recursive: true })
  try {
    writeEntries(staging, entries)
    const fileMap = new Map(entries.map((e) => [e.name, e]))
    const figRaw = fileMap.get('figure.json')
    if (!figRaw) throw new Error('形象包里没有 figure.json')
    let json
    try { json = JSON.parse(figRaw.data.toString('utf8')) } catch { throw new Error('figure.json 不是合法 JSON') }

    const v = validateFigure(json, new Set(fileMap.keys()))
    if (!v.ok) {
      const err = new Error(v.reason)
      err.skipped = true
      throw err
    }
    const id = uniqueId(slug(v.fig.name, 'pack'))
    // 缩略图单独卡 1MB
    if (v.fig.thumb && fileMap.get(v.fig.thumb).size > LIMIT.thumbBytes) {
      throw new Error('缩略图超过 1MB：' + v.fig.thumb)
    }
    const dest = path.join(root, id)
    fs.renameSync(staging, dest)
    fs.writeFileSync(path.join(dest, '.source.json'), JSON.stringify({
      id, source: sourceLabel || '', installedAt: Date.now(), name: v.fig.name
    }, null, 1))
    return { ok: true, id, name: v.fig.name, repl: '' }
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }) } catch {}
    return { ok: false, skipped: !!(e && e.skipped), reason: (e && e.message) || '安装失败' }
  }
}

/** 从 zip 安装（用户拖入 / 选择文件） */
function importZip (zipPath) {
  try {
    const st = fs.statSync(zipPath)
    if (st.size > LIMIT.zipBytes) return { ok: false, reason: '压缩包超过 128MB' }
    const buf = fs.readFileSync(zipPath)
    const r = readZip(buf)
    if (!r.ok) return { ok: false, reason: r.reason }
    if (r.entries.length > LIMIT.entries) return { ok: false, reason: '压缩包文件数过多（上限 ' + LIMIT.entries + '）' }
    let total = 0
    for (const e of r.entries) total += e.size
    if (total > LIMIT.totalBytes) return { ok: false, reason: '解压后超过 128MB' }

    // 常见情况：整个文件夹被压缩 → 所有条目都在同一个顶层目录下，剥掉这层
    let entries = r.entries
    const tops = new Set(entries.map((e) => e.name.split('/')[0]))
    const nested = entries.every((e) => e.name.includes('/'))
    if (nested && tops.size === 1) {
      entries = entries.map((e) => Object.assign({}, e, { name: e.name.split('/').slice(1).join('/') }))
    } else if (!entries.some((e) => e.name === 'figure.json')) {
      // 顶层有多个目录，但某个目录里有 figure.json：也支持（比如混了 __MACOSX）
      const owner = entries.find((e) => /^[^/]+\/figure\.json$/.test(e.name))
      if (owner) {
        const top = owner.name.split('/')[0]
        entries = entries
          .filter((e) => e.name.startsWith(top + '/'))
          .map((e) => Object.assign({}, e, { name: e.name.slice(top.length + 1) }))
      }
    }
    return installEntries(entries, path.basename(zipPath))
  } catch (e) {
    return { ok: false, reason: (e && e.message) || '读取压缩包失败' }
  }
}

/** 从文件夹安装（开发时直接指目录） */
function importDir (dirPath) {
  const out = []
  let total = 0
  const walk = (dir, rel, depth) => {
    if (depth > 3) throw new Error('目录层级超过 3 层')
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue
      const abs = path.join(dir, ent.name)
      const name = rel ? rel + '/' + ent.name : ent.name
      if (ent.isDirectory()) walk(abs, name, depth + 1)
      else if (ent.isFile()) {
        const st = fs.statSync(abs)
        total += st.size
        if (total > LIMIT.totalBytes) throw new Error('形象包超过 128MB')
        if (out.length >= LIMIT.entries) throw new Error('文件数过多（上限 ' + LIMIT.entries + '）')
        out.push({ name, size: st.size, data: fs.readFileSync(abs) })
      }
    }
  }
  try {
    const st = fs.statSync(dirPath)
    if (!st.isDirectory()) return { ok: false, reason: '不是文件夹' }
    walk(dirPath, '', 0)
    return installEntries(out, path.basename(dirPath))
  } catch (e) {
    return { ok: false, reason: (e && e.message) || '读取文件夹失败' }
  }
}

/** 目录占用（0.18.0 第二批：卸载前先让人看到有多大）。带缓存，10 分钟内不重复扫。 */
const _sizeCache = new Map()
function dirSize (dir) {
  const cached = _sizeCache.get(dir)
  if (cached && Date.now() - cached.at < 600000) return cached
  let bytes = 0
  let files = 0
  const started = Date.now()
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (files > 50000 || Date.now() - started > 2000) return
      const fp = path.join(d, e.name)
      if (e.isDirectory()) { walk(fp); continue }
      files++
      try { bytes += fs.statSync(fp).size } catch {}
    }
  }
  walk(dir)
  const out = { bytes, files, at: Date.now() }
  _sizeCache.set(dir, out)
  return out
}

/** 列表（跳过半成品目录）；损坏的包给出 broken 标记而不是让整页崩掉 */
function list () {
  const root = base()
  const out = []
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue
    const dir = path.join(root, ent.name)
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'figure.json'), 'utf8'))
      const v = validateFigure(json, null)
      if (!v.ok) {
        out.push({ id: ent.name, name: ent.name, broken: v.reason, axes: [], palettes: [] })
        continue
      }
      let installedAt = 0
      let source = ''
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, '.source.json'), 'utf8'))
        installedAt = meta.installedAt || 0
        source = meta.source || ''
      } catch {}
      out.push({
        id: ent.name,
        name: v.fig.name,
        author: v.fig.author,
        version: v.fig.version,
        api: 2,
        size: v.fig.size,
        axes: v.fig.axes.map((a) => ({ id: a.id, label: a.label, slot: a.slot, options: a.options.map((o) => ({ id: o.id, label: o.label })) })),
        palettes: v.fig.palettes,
        presets: v.fig.presets.map((p) => ({ id: p.id, label: p.label })),
        thumb: v.fig.thumb ? toUrl(path.join(dir, v.fig.thumb)) : '',
        sizeBytes: dirSize(dir).bytes,
        installedAt,
        source
      })
    } catch (e) {
      out.push({ id: ent.name, name: ent.name, broken: '读取失败：' + (e && e.message) })
    }
  }
  return out.sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0) || a.name.localeCompare(b.name))
}

function remove (id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(id || ''))) return false
  try {
    fs.rmSync(packDir(id), { recursive: true, force: true })
    return true
  } catch { return false }
}

/* ------------------------------------------------- 用户自定义（配色 / 方案）
 * 存在包目录下的 custom.json：删包即一起删，不会留下悬空的配色引用。
 * 内置方案不动（升级包时依然是最新官方配色），自定义只是叠加。
 */

function customFile (id) { return path.join(packDir(id), 'custom.json') }

function readCustom (id) {
  try {
    const j = JSON.parse(fs.readFileSync(customFile(id), 'utf8'))
    return {
      palettes: Array.isArray(j.palettes) ? j.palettes : [],
      presets: Array.isArray(j.presets) ? j.presets : []
    }
  } catch { return { palettes: [], presets: [] } }
}

function cleanVars (o) {
  const vars = {}
  for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) {
    if (!/^[a-z0-9-]{1,40}$/i.test(k)) continue
    if (!COLOR_RE.test(String(v))) continue
    vars[k] = String(v)
  }
  return vars
}

function cleanPalette (p) {
  if (!p || !ID_RE.test(String(p.id || ''))) return null
  return { id: p.id, label: String(p.label || p.id).slice(0, 16), vars: cleanVars(p.vars) }
}

function cleanPreset (p, axes) {
  if (!p || !ID_RE.test(String(p.id || ''))) return null
  const ax = {}
  for (const [k, v] of Object.entries(p.axes && typeof p.axes === 'object' ? p.axes : {})) {
    if (axes.has(k) && ID_RE.test(String(v))) ax[k] = String(v)
  }
  const con = p.console && typeof p.console === 'object'
    ? { light: plainColors(p.console.light), dark: plainColors(p.console.dark) }
    : null
  return {
    id: p.id,
    label: String(p.label || p.id).slice(0, 16),
    axes: ax,
    palette: ID_RE.test(String(p.palette || '')) ? p.palette : null,
    vars: cleanVars(p.vars),
    console: con,
    custom: true
  }
}

/** 保存/覆盖一个自定义配色（同 id 覆盖） */
function saveCustomPalette (id, pal) {
  if (!fs.existsSync(packDir(id))) return null
  const clean = cleanPalette(pal)
  if (!clean) return null
  const cur = readCustom(id)
  cur.palettes = cur.palettes.filter((p) => p.id !== clean.id).concat(clean)
  fs.writeFileSync(customFile(id), JSON.stringify(cur, null, 1))
  return clean
}

/** 保存自定义方案（axes/palette/vars） */
function saveCustomPreset (id, preset, axisIds) {
  if (!fs.existsSync(packDir(id))) return null
  const clean = cleanPreset(preset, new Set(axisIds || []))
  if (!clean) return null
  const cur = readCustom(id)
  cur.presets = cur.presets.filter((p) => p.id !== clean.id).concat(clean)
  fs.writeFileSync(customFile(id), JSON.stringify(cur, null, 1))
  return clean
}

function delCustom (id, kind, cid) {
  const cur = readCustom(id)
  if (kind === 'palette') cur.palettes = cur.palettes.filter((p) => p.id !== cid)
  else cur.presets = cur.presets.filter((p) => p.id !== cid)
  try { fs.writeFileSync(customFile(id), JSON.stringify(cur, null, 1)) } catch { return false }
  return true
}


/**
 * 把包解析成渲染层可直接用的数据（图片转 aura:// 地址 + 调色盘合算好）
 * dress = { axes: {id: optId}, palette: 'id', vars: {k:v}, preset: 'id' }
 */
function resolve (id, dress) {
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(id))) return null
  const dir = packDir(id)
  let json
  try { json = JSON.parse(fs.readFileSync(path.join(dir, 'figure.json'), 'utf8')) } catch { return null }
  const v = validateFigure(json, null)
  if (!v.ok) return null
  const fig = v.fig

  // 自定义配色/方案叠在内置之上（包升级不会被覆盖，用户自己的东西也不会丢）
  const custom = readCustom(id)
  const axisIds = new Set(fig.axes.map((a) => a.id))
  const palettes = fig.palettes.concat(
    custom.palettes.map(cleanPalette).filter((p) => p && !fig.palettes.some((b) => b.id === p.id))
  )
  const presets = fig.presets.concat(
    custom.presets
      .map((p) => cleanPreset(p, axisIds))
      .filter((p) => p && !fig.presets.some((b) => b.id === p.id))
  )

  const d = dress && typeof dress === 'object' ? dress : {}
  const preset = presets.find((p) => p.id === d.preset) || null
  const palette = palettes.find((p) => p.id === (d.palette || (preset && preset.palette))) || palettes[0] || null

  // 变量优先级：调色盘 < 预设 < 用户自定义
  const vars = Object.assign({}, (palette && palette.vars) || {}, (preset && preset.vars) || {}, (d.vars && typeof d.vars === 'object') ? d.vars : {})

  const chosen = Object.assign({}, (preset && preset.axes) || {}, (d.axes && typeof d.axes === 'object') ? d.axes : {})
  const axisState = {}
  const extra = []
  for (const a of fig.axes) {
    const want = chosen[a.id]
    const opt = a.options.find((o) => o.id === want) || a.options[0]
    axisState[a.id] = opt.id
    if (opt.layers) {
      for (const ly of opt.layers) {
        // 图层自己的 slot 优先，没有就继承维度 slot —— 反了会让 c:main 退化成调色盘通用色
        extra.push(Object.assign({}, ly, { slot: ly.slot || a.slot, axis: a.id, option: opt.id }))
      }
    }
    if (opt.vars) Object.assign(vars, opt.vars)
  }

  const layers = []
  /** 把 pack 里的图层折成渲染层：图片换 url、颜色折成实际色值 */
  const mapLayer = (ly) => {
    const out = {
      id: ly.id || null,
      z: ly.z,
      type: ly.type,
      x: ly.x,
      y: ly.y,
      w: ly.w,
      h: ly.h,
      opacity: ly.opacity,
      rotate: ly.rotate,
      blink: ly.blink || null,
      shape: ly.shape,
      rx: ly.rx,
      d: ly.d,
      slot: ly.slot || null
    }
    if (ly.part) {
      out.part = ly.part
      if (ly.pivot) out.pivot = ly.pivot
    }
    const fill = ly.fill ? colorRef(ly.fill, { vars, slot: ly.slot || '' }) : null
    if (fill) out.fill = fill
    if (ly.stroke && ly.strokeWidth > 0) {
      const stroke = colorRef(ly.stroke, { vars, slot: ly.slot || '' })
      if (stroke) { out.stroke = stroke; out.strokeWidth = ly.strokeWidth }
    }
    if (ly.type === 'image') {
      out.src = toUrl(path.join(dir, ly.src))
      const tint = ly.tint ? colorRef(ly.tint, { vars, slot: ly.slot || '' }) : null
      if (tint) { out.tint = tint; out.tintAlpha = ly.tintAlpha }
    }
    if (ly.open != null) out.open = ly.open
    if (ly.type === 'shape' && !out.fill && !out.stroke) return null
    if (ly.type === 'image' && !out.src) return null
    return out
  }
  const push = (ly) => { const o = mapLayer(ly); if (o) layers.push(o) }
  for (const ly of fig.layers) push(Object.assign({ slot: '' }, ly))
  for (const ly of extra) push(ly)
  // 侧身层不走装扮（是另一套整图），只折颜色与 url
  let sideView = null
  if (fig.views && fig.views.side) {
    const sl = []
    for (const ly of fig.views.side.layers) {
      const o = mapLayer(Object.assign({ slot: '' }, ly))
      if (o) sl.push(o)
    }
    if (sl.length) sideView = { layers: sl }
  }
  layers.sort((a, b) => a.z - b.z)

  return {
    id,
    name: fig.name,
    size: fig.size,
    thumb: fig.thumb ? toUrl(path.join(dir, fig.thumb)) : '',
    needs: fig.needs,
    views: sideView ? { side: sideView } : null,
    layers,
    axes: fig.axes.map((a) => ({
      id: a.id,
      label: a.label,
      slot: a.slot,
      options: a.options.map((o) => ({ id: o.id, label: o.label }))
    })),
    palettes,
    presets,
    dress: {
      axes: axisState,
      palette: palette ? palette.id : null,
      vars: (d.vars && typeof d.vars === 'object') ? d.vars : {},
      preset: (preset && preset.id) || null
    },
    vars
  }
}

/** 默认装扮：每个维度取第一个选项 + 第一个调色盘 */
function defaultDress (id) {
  const r = resolve(id, {})
  if (!r) return null
  return { pack: id, axes: r.dress.axes, palette: r.dress.palette, vars: {}, preset: null }
}

/** 换图（本地 abs 路径）→ aura:// 地址；渲染层 fetch file:// 会被拦 */
function toUrl (abs) {
  const p = String(abs || '').replace(/\\/g, '/')
  if (!fs.existsSync(p)) return ''
  return 'aura://local/' + encodeURI(p)
}

module.exports = {
  base,
  setBaseDir,
  list,
  importZip,
  importDir,
  remove,
  resolve,
  defaultDress,
  validateFigure,
  colorRef,
  toUrl,
  readCustom,
  saveCustomPalette,
  saveCustomPreset,
  delCustom,
  LIMIT
}
