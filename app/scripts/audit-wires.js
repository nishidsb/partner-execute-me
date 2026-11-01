'use strict'
/* 死资产审计：找出「有实现但没接线」的功能。只读源码，不改任何东西。
 * 三张网：
 *   A. 主进程 broadcast/webContents.send 的频道 vs 渲染层/preload 的监听者
 *   B. ipcMain.on/handle 的频道 vs preload 的暴露
 *   C. companion 各模块 exports 的函数 vs 全仓引用（0 引用 = 死代码）
 */
const fs = require('fs')
const path = require('path')
const SRC = path.resolve(__dirname, '..')

function read (p) { return fs.readFileSync(p, 'utf8') }
function walk (dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) walk(p, out)
    else if (/\.js$/.test(f.name)) out.push(p)
  }
  return out
}

const files = walk(SRC)
const readAll = {}
for (const f of files) readAll[f] = read(f)
const rel = (p) => path.relative(SRC, p).replace(/\\/g, '/')

const mainFiles = files.filter((f) => /src[\\/]main[\\/]/.test(f))
const rendererFiles = files.filter((f) => /src[\\/]renderer[\\/]/.test(f) || /src[\\/]preload[\\/]/.test(f))
const rendererSrc = rendererFiles.map(rel)

console.log('=== A. 广播频道：主进程发送 vs 渲染层接收 ===')
const sent = new Map()
for (const f of mainFiles) {
  const src = readAll[f]
  for (const m of src.matchAll(/broadcast\(\s*'([^']+)'/g)) {
    const k = m[1]
    if (!sent.has(k)) sent.set(k, [])
    sent.get(k).push(rel(f))
  }
  for (const m of src.matchAll(/webContents\.send\(\s*'([^']+)'/g)) {
    const k = m[1]
    if (!sent.has(k)) sent.set(k, [])
    sent.get(k).push(rel(f))
  }
}
const listened = {}
for (const f of rendererFiles) {
  const src = readAll[f]
  for (const m of src.matchAll(/on\(\s*'([^']+)'/g)) listened[m[1]] = rel(f)
  for (const m of src.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)) listened[m[1]] = rel(f)
}
for (const [ch, from] of [...sent.entries()].sort()) {
  const base = ch.replace(/^pet:/, '')
  const hits = Object.keys(listened).filter((k) => k === ch || k.endsWith(':' + base) || k === base)
  if (!hits.length) console.log('  [无接收者]', ch, '←', from.join(','))
}

console.log('=== B. ipcMain 频道：主进程收 vs preload 暴露 ===')
const ipcOn = new Map()
for (const f of mainFiles) {
  for (const m of readAll[f].matchAll(/ipcMain\.(?:on|handle)\(\s*'([^']+)'/g)) {
    if (!ipcOn.has(m[1])) ipcOn.set(m[1], [])
    ipcOn.get(m[1]).push(rel(f))
  }
}
const preloadSrc = files.filter((f) => /src[\\/]preload[\\/]/.test(f)).map((f) => readAll[f]).join('\n')
for (const [ch, from] of [...ipcOn.entries()].sort()) {
  if (!preloadSrc.includes(ch)) console.log('  [preload 未暴露]', ch, '←', from.join(','))
}

console.log('=== C. companion 模块导出：全仓 0 引用 = 死代码 ===')
const compDir = path.join(SRC, 'src', 'main', 'companion')
for (const f of fs.readdirSync(compDir).filter((n) => n.endsWith('.js'))) {
  if (f === 'index.js' || f === 'pet.js') continue // index 是装配层；pet.js 导出被 index 解构引用
  const src = read(path.join(compDir, f))
  const ex = src.match(/module\.exports\s*=\s*\{([^}]*)\}/s)
  if (!ex) continue
  const names = [...ex[1].matchAll(/([A-Za-z_$][\w$]*)\s*(?:,|$|})/g)].map((m) => m[1]).filter((n) => n && n !== 'get' && n !== 'set')
  const others = files.filter((p) => !p.endsWith(path.join('companion', f)))
  for (const n of new Set(names)) {
    const used = others.some((p) => new RegExp('\\b' + n + '\\b').test(readAll[p]))
    if (!used) console.log('  [死导出]', rel(path.join(compDir, f)), '→', n)
  }
}
console.log('=== 审计结束 ===')
