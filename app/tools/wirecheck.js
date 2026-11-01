'use strict'
/**
 * 渲染层 × preload 接线检查
 *
 * 只查一件事：渲染层调用了 `window.xxxAPI.savePalette(...)`，但对应 preload 根本没暴露
 * 这个 key —— 点下去就是 TypeError，UI 上表现为「按钮没反应」。
 *
 * 这类断链 audit.js 查不到（它只看主进程），而它恰恰最伤人：
 * 0.39.0 的「B站设置只存不读」「学习模式没开始按钮」都是这个形状。
 *
 * 用法：node tools/wirecheck.js [--verbose]
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

/** 每个渲染层目录 ↔ 它加载的 preload 全局名（preload 文件里可能 expose 多个全局） */
const TARGETS = [
  { dir: 'src/renderer/dress', globals: [['src/preload/dress.js', 'figureAPI']] },
  { dir: 'src/renderer/companion', globals: [['src/preload/companion.js', 'companion'], ['src/preload/companion.js', 'assistantAPI']] },
  { dir: 'src/renderer/assistant', globals: [['src/preload/assistant.js', 'assistantAPI']] },
  { dir: 'src/renderer/overlay', globals: [['src/preload/overlay.js', 'aura']] },
  { dir: 'src/renderer/danmaku', globals: [['src/preload/danmaku.js', 'dk']] },
  { dir: 'src/renderer/picker', globals: [['src/preload/picker.js', 'pickerAPI']] },
  { dir: 'src/renderer/confirm', globals: [['src/preload/confirm.js', 'confirmAPI']] }
]

/** 这些不是 API 方法，是 Promise/内置属性，扫到就当噪音丢掉 */
const NOISE = new Set(['then', 'catch', 'finally', 'length', 'toString', 'name', 'constructor'])

function read (rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 从 preload 里抠出 exposeInMainWorld 对象字面量的顶层 key（块内最小缩进） */
function exposedKeys (rel, globalName) {
  const src = read(rel)
  const re = /exposeInMainWorld\(\s*['"]([A-Za-z]+)['"]\s*,\s*\{/g
  let m, hit = null
  while ((m = re.exec(src))) {
    if (m[1] === globalName) { hit = m; break }
  }
  if (!hit) return null
  const start = hit.index + hit[0].length - 1
  let depth = 0, end = -1
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return null
  const body = src.slice(start + 1, end)
  const cand = []
  for (const line of body.split(/\r?\n/)) {
    const mm = line.match(/^(\s*)([A-Za-z_$][\w$]*)\s*[:(]/)
    if (mm) cand.push({ ind: mm[1].length, key: mm[2] })
  }
  if (!cand.length) return new Set()
  const min = Math.min(...cand.map((c) => c.ind))
  return new Set(cand.filter((c) => c.ind === min).map((c) => c.key))
}

function walk (dir, out = []) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out
  for (const n of fs.readdirSync(abs)) {
    const rel = path.join(dir, n)
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.js$/.test(n)) out.push(rel)
  }
  return out
}

function check (t) {
  const keys = new Set()
  for (const [file, name] of t.globals) {
    const s = exposedKeys(file, name)
    if (!s) return { dir: t.dir, error: '找不到 ' + name + ' ← ' + file, miss: [] }
    for (const k of s) keys.add(k)
  }
  const miss = new Map()
  for (const f of walk(t.dir)) {
    const src = read(f)
    const aliases = new Set()
    for (const [, name] of t.globals) {
      const re = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*window\\.' + name + '\\b', 'g')
      let m
      while ((m = re.exec(src))) aliases.add(m[1])
      const re2 = new RegExp('window\\.' + name + '\\s*\\?*\\.\\s*([A-Za-z_$][\\w$]*)', 'g')
      while ((m = re2.exec(src))) {
        if (!keys.has(m[1]) && !NOISE.has(m[1]) && !miss.has(m[1])) miss.set(m[1], f)
      }
    }
    for (const a of aliases) {
      const re = new RegExp('\\b' + a.replace(/\$/g, '\\$') + '\\s*\\?*\\.\\s*([A-Za-z_$][\\w$]*)', 'g')
      let m
      while ((m = re.exec(src))) {
        const k = m[1]
        if (!keys.has(k) && !NOISE.has(k) && !miss.has(k)) miss.set(k, f)
      }
    }
  }
  return { dir: t.dir, exposed: keys.size, miss: [...miss] }
}

/**
 * 第二件事：preload 里 invoke/send 的通道，主进程到底有没有注册 handler。
 * 这条反过来查：④（audit）看「主进程有通道、前端不调」，这里看「前端调通道、主进程没有」。
 * 通道名拼错一个字母，invoke 就永远 reject「No handler registered」，UI 上还是「点了没反应」。
 */
function checkChannels () {
  const handled = new Set()
  for (const rel of walk('src/main')) {
    const src = read(rel)
    for (const m of src.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)) handled.add(m[1])
  }
  const miss = new Map()
  for (const rel of walk('src/preload')) {
    const src = read(rel)
    for (const m of src.matchAll(/ipcRenderer\.(?:invoke|send|postMessage)\(\s*['"]([^'"]+)['"]/g)) {
      if (!handled.has(m[1]) && !miss.has(m[1])) miss.set(m[1], rel)
    }
  }
  return [...miss]
}

/**
 * 第三件事：渲染层用了 `window.companion`，但这个窗口的 preload 只 expose 了 `aura`。
 * 这种写法通常带着 `if (window.companion && ...)` 的空判断，看起来岁月静好，实际永远不执行——
 * 0.40.0 的 pet.js 里就藏着一段：overlay 想订阅聊天窗的角色刷新事件，而 overlay 根本没有那个对象。
 * 正确的刷新路径是主进程 pet.refresh() → 广播 pet:state，渲染层 onPetState 里已经在处理。
 */
function allGlobals () {
  const set = new Set()
  for (const rel of walk('src/preload')) {
    const src = read(rel)
    for (const m of src.matchAll(/exposeInMainWorld\(\s*['"]([A-Za-z]+)['"]/g)) set.add(m[1])
  }
  return set
}

function checkGlobals (t, known) {
  const allowed = new Set(t.globals.map(([, name]) => name))
  const miss = new Map()
  for (const rel of walk(t.dir)) {
    const src = read(rel)
    for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)/g)) {
      const name = m[1]
      if (!known.has(name) || allowed.has(name) || miss.has(name)) continue
      miss.set(name, rel)
    }
  }
  return [...miss]
}

function main () {
  const verbose = process.argv.includes('--verbose')
  const known = allGlobals()
  let bad = 0
  for (const t of TARGETS) {
    const r = check(t)
    if (r.error) { console.log('⚠ ' + r.error); bad++; continue }
    const cross = checkGlobals(t, known)
    if (!r.miss.length && !cross.length) {
      if (verbose) console.log('✓ ' + t.dir + '（' + r.exposed + ' 个接口全在）')
      continue
    }
    bad += r.miss.length + cross.length
    if (r.miss.length) {
      console.log('✗ ' + t.dir + '：' + r.miss.length + ' 个调用在 preload 里没有')
      for (const [k, f] of r.miss) console.log('    ' + k + '  ← ' + f)
    }
    if (cross.length) {
      console.log('✗ ' + t.dir + '：' + cross.length + ' 个全局不是这个窗口的')
      for (const [n, f] of cross) console.log('    window.' + n + '  ← ' + f)
    }
  }
  const orphan = checkChannels()
  if (orphan.length) {
    bad += orphan.length
    console.log('✗ 通道没人收：' + orphan.length + ' 个 preload 通道主进程没注册 handler')
    for (const [ch, f] of orphan) console.log('    ' + ch + '  ← ' + f)
  } else if (verbose) {
    console.log('✓ preload 的每个 invoke/send 通道主进程都有 handler')
  }
  if (!bad) console.log('接线检查通过：渲染层调用的接口 preload 都有，preload 调的通道主进程都收。')
  else console.log('\n共 ' + bad + ' 处。要么补上缺的那一头，要么把多余的那一头删掉。')
  process.exit(bad ? 1 : 0)
}

module.exports = { TARGETS, exposedKeys, check, checkChannels, allGlobals, checkGlobals }
if (require.main === module) main()
