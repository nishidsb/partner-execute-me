/**
 * 渲染层「悬空常量」检查（0.18.0 回归守卫）
 *
 * 背景：0.18.0 加帧率档位时，spine 渲染循环里残留了一行 `let spineMs = SPINE_BUSY_MS`，
 * 而 SPINE_BUSY_MS 从未定义 → 渲染循环一启动就 ReferenceError → 角色整只画不出来。
 * node --check 只查语法，查不出这种「名字不存在」的问题；smoke 又因为 jsdom 没有 WebGL
 * 把 pet.js 排除了，所以这个错误在测试里是隐形的。
 *
 * 做法：剥掉注释与字符串后，收集「全大写 + 含下划线」的标识符，看它是否有定义处。
 * 只查带下划线的名字，避免 JSON / DOM 这类单词常量误报；带 `x.` 前缀的成员访问
 *（gl.SCISSOR_TEST / THREE.X）不算，天然排除 WebGL 常量。
 */
const fs = require('node:fs')
const path = require('node:path')

const roots = [
  path.resolve(__dirname, '../src/renderer'),
  path.resolve(__dirname, '../src/preload')
]

// 允许外部注入的名字（由 HTML 里别的脚本或运行时挂到 window 上）
const ALLOW = new Set([
  'TRACE_MODE', // 举例占位：以后再有外部注入的常量加这里
  'PET_STATE_PUSH'
])

function strip (src) {
  // 保留换行，方便报行号
  const keepNl = (m) => m.replace(/[^\n]/g, ' ')
  let out = src
    .replace(/\/\*[\s\S]*?\*\//g, keepNl)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
    .replace(/'(?:\\.|[^'\\\n])*'/g, keepNl)
    .replace(/"(?:\\.|[^"\\\n])*"/g, keepNl)
  // 正则字面量：紧跟在 = , : [ ( ! & | ? ; 或运算符后面（含空格）的 /…/flags，
  // 或 return/typeof 等关键字后面。避免把 a / b 除法当正则。
  // 前缀类不能含 {} —— `${fqdn}/…/` 里插值后的 / 会被误当正则起点，把插值的 } 吃掉。
  // 含 `${` 的匹配也跳过（那是模板插值被误判）。
  out = out
    .replace(/(?:[=,:[!&|?;(+*%~^-]\s*|\b(?:return|typeof|case|in|of|instanceof|delete|void|new|do|else)\s*)\/(?:\\.|[^/\\\n])+\/[gimsuy]{0,2}/g, (m) => (m.includes('${') ? m : keepNl(m)))
  // 模板字符串：嵌套感知的扫描器（处理 `a${b`c` }d` 这类插值里再套模板的情况）
  let res = ''
  const frames = [] // 'tpl' 或 { t:'code', d: 深度 }
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]
    const top = frames[frames.length - 1]
    if (!top) {
      if (ch === '`') { frames.push('tpl'); res += ' ' } else res += ch
      continue
    }
    if (top === 'tpl') {
      if (ch === '\\' && i + 1 < out.length) { res += src[i + 1] === '\n' ? '\n' : ' '; i++ } else if (ch === '`') { frames.pop(); res += ' ' } else if (ch === '$' && out[i + 1] === '{') { frames.push({ t: 'code', d: 0 }); res += '  '; i++ } else res += ch === '\n' ? '\n' : ' '
      continue
    }
    // 插值里的代码
    if (ch === '{') { top.d++; res += ch } else if (ch === '}') {
      if (top.d === 0) { frames.pop(); res += ' ' } else { top.d--; res += ch }
    } else if (ch === '`') { frames.push('tpl'); res += ' ' } else if (ch === '\\' && i + 1 < out.length) { res += src[i + 1] === '\n' ? '\n' : ' '; i++ } else res += ch
  }
  return res
}

function definedNames (src) {
  const out = new Set()
  const add = (re) => {
    for (const m of src.matchAll(re)) out.add(m[1])
  }
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)
  add(/\bfunction\s+([A-Za-z_$][\w$]*)/g)
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g)
  // const { A, B: C } = ...
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=').pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }
  // import { A as B } / import A from
  for (const m of src.matchAll(/\bimport\s+([\s\S]*?)\s+from\b/g)) {
    const spec = m[1]
    for (const part of spec.replace(/[{}]/g, '').split(',')) {
      const name = part.split(/\bas\b/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }
  // window.X = / globalThis.X =
  add(/(?:window|globalThis|self)\.([A-Za-z_$][\w$]*)\s*=/g)
  // 函数参数里的全大写（少见但合法）
  for (const m of src.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split('=')[0].trim()
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) out.add(name)
    }
  }
  return out
}

function walk (dir, files = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return files }
  for (const e of ents) {
    const fp = path.join(dir, e.name)
    if (e.isDirectory()) { walk(fp, files); continue }
    if (!e.isFile() || !e.name.endsWith('.js')) continue
    // 打包进来的三方库（three/spine/vrm）里有大量着色器宏，不是我们的代码
    if (/^libs(\.|$)/.test(e.name) || /\.min\.js$/.test(e.name) || /[\\/]vendor[\\/]/.test(fp)) continue
    files.push(fp)
  }
  return files
}

const problems = []
for (const root of roots) {
  for (const file of walk(root)) {
    const raw = fs.readFileSync(file, 'utf8')
    const src = strip(raw)
    const defs = definedNames(src)
    const lines = raw.split(/\r?\n/)
    const seen = new Map() // name -> first line
    for (const m of src.matchAll(/(?<![.\w$])([A-Z][A-Z0-9_]*_[A-Z0-9_]+)\b/g)) {
      const name = m[1]
      if (defs.has(name) || ALLOW.has(name)) continue
      if (!seen.has(name)) {
        const line = src.slice(0, m.index).split('\n').length
        seen.set(name, line)
      }
    }
    for (const [name, line] of seen) {
      problems.push({ kind: '悬空常量', file: path.relative(path.resolve(__dirname, '..'), file), line, name, text: (lines[line - 1] || '').trim().slice(0, 100) })
    }
  }
}

/* ---- 第二道：渲染层顶层声明与 contextBridge 命名空间同名（历史白屏坑） ----
 * preload 把 aura / companion / assistantAPI 这类挂到 window 上，渲染层顶层再用
 * const aura = ... 声明一次就是 SyntaxError（整个脚本不执行、页面白屏）。 */
function exposedNamespaces () {
  const out = new Set()
  let files = []
  try {
    files = fs.readdirSync(path.resolve(__dirname, '../src/preload'))
  } catch { return out }
  for (const f of files) {
    if (!f.endsWith('.js')) continue
    const src = fs.readFileSync(path.resolve(__dirname, '../src/preload', f), 'utf8')
    for (const m of src.matchAll(/exposeInMainWorld\(\s*['"]([^'"]+)['"]/g)) out.add(m[1])
  }
  return out
}

const ns = exposedNamespaces()
if (ns.size) {
  for (const root of [path.resolve(__dirname, '../src/renderer')]) {
    for (const file of walk(root)) {
      const raw = fs.readFileSync(file, 'utf8')
      const src = strip(raw)
      const lines = raw.split(/\r?\n/)
      // 只认顶层（行首无缩进）声明
      for (const m of src.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        const name = m[1]
        if (!ns.has(name)) continue
        const line = src.slice(0, m.index).split('\n').length
        problems.push({
          kind: '命名空间冲突',
          file: path.relative(path.resolve(__dirname, '..'), file),
          line,
          name,
          text: (lines[line - 1] || '').trim().slice(0, 100) + '  ← 与 preload 暴露的 window.' + name + ' 同名，会 SyntaxError 白屏'
        })
      }
    }
  }
}

/* ---- 第三道：跨作用域函数引用（点一下就炸的那种） ----
 * 背景（0.20.0）：bubbleShow 定义在 setupChat() 内部，setupMenu() 里直接调它
 * → 点右键菜单的「音效」就 ReferenceError，气泡出不来。node --check 查不出
 *（语法没问题，是作用域问题），jsdom 又跑不到渲染循环。
 * 做法：按顶层 function 分段，收集每段内部的嵌套函数名，看别的段有没有直接调用它。
 * 只查名字 ≥6 字符且顶���没有同名声明，避免 show/hide 这类通用短名误报。 */
function scopeLeaks (raw, rel) {
  const lines = raw.split(/\r?\n/)
  const tops = []
  for (let i = 0; i < lines.length; i++) {
    if (/^(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(lines[i])) tops.push(i)
  }
  if (!tops.length) return
  const topNames = new Set()
  for (const l of lines) {
    const m = l.match(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/)
    if (m) topNames.add(m[1])
  }
  for (let k = 0; k < tops.length; k++) {
    const start = tops[k]
    const end = k + 1 < tops.length ? tops[k + 1] : lines.length
    const inner = new Map()
    for (let i = start + 1; i < end; i++) {
      const m = lines[i].match(/^\s{2,}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
      if (m && m[1].length >= 6 && !topNames.has(m[1])) inner.set(m[1], i)
    }
    if (!inner.size) continue
    for (let j = 0; j < tops.length; j++) {
      if (j === k) continue
      const s2 = tops[j]
      const e2 = j + 1 < tops.length ? tops[j + 1] : lines.length
      for (let i = s2; i < e2; i++) {
        for (const [name, defLine] of inner) {
          const re = new RegExp('(?<![.\\w$])' + name + '\\s*\\(')
          if (!re.test(lines[i])) continue
          problems.push({
            kind: '跨作用域引用',
            file: rel,
            line: i + 1,
            name,
            text: lines[i].trim().slice(0, 100) + '  ← ' + name + '() 定义在第 ' + (defLine + 1) + ' 行的另一个函数内部，这里会 ReferenceError'
          })
        }
      }
    }
  }
}

for (const root of [path.resolve(__dirname, '../src/renderer')]) {
  for (const file of walk(root)) {
    scopeLeaks(fs.readFileSync(file, 'utf8'), path.relative(path.resolve(__dirname, '..'), file))
  }
}

/* ---- 第四道：主进程/核心「未定义的裸调用」（0.24.0 回归守卫） ----
 * 背景：0.24.0 加随身服务时，settingsView 里写了 remoteStatus()，而这个名字只作为
 * module.exports 的键存在，模块内部从未定义 → companion:init 一调就 ReferenceError，
 * 整个面板初始化失败、所有输入框空白。node --check 查不出，测试又没覆盖 settingsView。
 * 做法：剥掉注释与字符串后，收集文件内所有「绑定过」的名字（声明/解构/参数/require/
 * import/globalThis 挂载），再看裸调用 name( 与 new Name( 里的名字是否有绑定。
 * 只报整个文件里都没有绑定的名字——宁漏勿误，保证 smoke 永远可信。 */
const MAIN_GLOBALS = new Set([
  'require', 'module', 'exports', 'process', 'console', 'Buffer', 'global',
  '__dirname', '__filename', 'setTimeout', 'setInterval', 'clearTimeout',
  'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
  'AbortSignal', 'fetch', 'performance', 'Intl', 'Date', 'Math', 'JSON',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'WeakRef', 'Symbol', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'AggregateError', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Reflect',
  'Proxy', 'BigInt', 'Function', 'Event', 'EventTarget',
  'CustomEvent', 'Blob', 'atob', 'btoa', 'crypto', 'navigator',
  'FormData', 'Headers', 'Request', 'Response', 'File', 'Blob',
  // 语法关键字（会被裸调用正则误扫到）
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with',
  'do', 'else', 'try', 'finally', 'of', 'in', 'new', 'await', 'async',
  'yield', 'typeof', 'delete', 'instanceof', 'void', 'throw', 'case',
  'let', 'const', 'var', 'class', 'import', 'export', 'extends', 'super',
  'this', 'arguments', 'debugger', 'default', 'get', 'set', 'static'
])

function boundNames (src) {
  const out = new Set()
  const add = (re) => { for (const m of src.matchAll(re)) out.add(m[1]) }
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)
  add(/\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)/g)
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g)
  // 解构（对象/数组）：const { A, B: C, D = 1 } = … / const [a, b] = …
  // 也覆盖 for (const [name, fn] of …) 这种后面不跟 = 的形式
  for (const m of src.matchAll(/\b(?:const|let|var)\s*(\{[^{}]*\}|\[[^\[\]]*\])/g)) {
    for (const part of m[1].replace(/[{}\[\]]/g, '').split(',')) {
      // 换名 log: outerLog → 取冒号后；默认值 x = 1 → 取等号前
      let name = part.trim()
      const ci = name.lastIndexOf(':')
      if (ci >= 0) name = name.slice(ci + 1)
      name = name.split('=')[0].replace(/\.\.\./g, '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }
  // import 绑定（ESM 核心）
  for (const m of src.matchAll(/\bimport\s+([\s\S]*?)\s+from\b/g)) {
    for (const part of m[1].replace(/[{}]/g, '').split(',')) {
      const name = part.split(/\bas\b/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }
  add(/\b(?:globalThis|global|window|self)\.([A-Za-z_$][\w$]*)\s*=/g)
  add(/\bmodule\.exports\.([A-Za-z_$][\w$]*)\s*=/g)
  // 方法/类方法简写：start () { / constructor (role) { / get status () { / async send (a, { b }) {
  // 顺带把参数列表里的名字也收进来（函数声明、箭头、回调都走同一条路）
  for (const m of src.matchAll(/(?:^|\n)[ \t]*(?:(?:async|get|set|static|\*)\s+)*([A-Za-z_$][\w$]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:=[^;{}\n]*)?\s*(?:=>|\{)/g)) {
    out.add(m[1])
    collectParams(m[2], out)
  }
  // 独立函数声明的参数（function f (a, b) {）与箭头 ((a, b) =>)
  for (const m of src.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:=>|\{)/g)) collectParams(m[1], out)
  add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)
  return out
}

/** 从参数文本里收集参数名：处理 { a, b: c, d = 1 }, [e], ...rest, x = () => {} */
function collectParams (text, out) {
  for (const part of text.split(',')) {
    let name = part.replace(/\([^()]*\)/g, '') // 默认值里的函数调用
      .replace(/[{}[\]]/g, '')
      .replace(/\.\.\./g, '')
      .trim()
    const ci = name.lastIndexOf(':')
    if (ci >= 0) name = name.slice(ci + 1)
    name = name.split('=')[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
  }
}

for (const root of [
  path.resolve(__dirname, '../src/main'),
  path.resolve(__dirname, '../src/assistant'),
  path.resolve(__dirname, '../src/preload')
]) {
  for (const file of walk(root)) {
    const raw = fs.readFileSync(file, 'utf8')
    const src = strip(raw)
    const defs = boundNames(src)
    const lines = raw.split(/\r?\n/)
    const seen = new Map()
    // 裸调用 name( 与构造 new Name(：名字前不能是 . / ' / " 等成员或属性位置
    for (const m of src.matchAll(/(?<![.\w$'"])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1]
      if (defs.has(name) || MAIN_GLOBALS.has(name)) continue
      if (!seen.has(name)) {
        const line = src.slice(0, m.index).split('\n').length
        seen.set(name, line)
      }
    }
    for (const m of src.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/g)) {
      const name = m[1]
      if (defs.has(name) || MAIN_GLOBALS.has(name)) continue
      if (!seen.has(name)) {
        const line = src.slice(0, m.index).split('\n').length
        seen.set(name, line)
      }
    }
    for (const [name, line] of seen) {
      problems.push({
        kind: '未定义调用',
        file: path.relative(path.resolve(__dirname, '..'), file),
        line,
        name,
        text: (lines[line - 1] || '').trim().slice(0, 100) + '  ← 全文件找不到 ' + name + ' 的定义/导入，调用即 ReferenceError'
      })
    }
  }
}

if (problems.length) {
  console.log('渲染层静态检查未通过（会直接打断脚本，导致角色/界面不显示）：')
  for (const p of problems) console.log(`  [${p.kind}] ${p.file}:${p.line}  ${p.name}\n      ${p.text}`)
  console.log(`\n共 ${problems.length} 处。要么定义它，要么从 ALLOW 里显式声明来源。`)
  process.exit(1)
}
console.log('静态检查通过（渲染层无悬空常量/命名空间冲突/跨作用域引用，主进程与核心无未定义调用）')
