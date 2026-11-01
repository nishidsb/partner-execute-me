/**
 * 接线审计（0.39.0）
 *
 * 背景：0.37.0 之前发现过几次同一类事故——
 *   · inner.noteSelf() 注释写着「她自己做了一件事」，0.20.0 就写好了，全项目零调用者，
 *     于是「她自己待着」这个能力从没存在过，直到被用户点出来；
 *   · watchSharedBlock() 漏了 screenText.render()，她说「说说你看到的东西」时其实什么都没看到；
 *   · judgeStatus() / feedbackHistory() 算得挺全，没有任何 UI 调用，用户无法确认功能是否生效；
 *   · test/inner.test.js 断言 opts.kind === 'watch'，代码重构后已解构为 kind，
 *     正则早就匹配不到——护栏一直在红着，没人发现。
 *
 * 这些问题的共同点：**代码本身没错，错在没接上**。node --check 查不出，单测也查不出
 *（单测只测被调到的那条路）。用户明确要求：以后每次做功能或修 bug，都要遍历一遍。
 * 所以把它固化成脚本，而不是每次临时敲。
 *
 * 六类检查（0.40.0 起第七类）：
 *   ① deadExport   导出但全项目（含 test）零引用 —— 一定是死代码
 *   ② testOnly     只被 test/ 引用，产品代码零引用 —— 要么是测试专用钩子，要么是没接线
 *   ③ deadFunc     文件内定义的函数，全文件只出现一次（定义处）—— 写了没调
 *   ④ unwiredIpc   主进程注册了 ipcMain 通道，preload/renderer 从不调用
 *   ⑤ unusedCfg    store 默认配置项，全项目无人读取（AuraDesk 时代的残骸）
 *   ⑥ staleGuard   测试里 assert.match(源码, /正则/) 的正则在源码里匹配不到 —— 护栏失效
 *   ⑦ unwiredApi   渲染层调了 window.xxxAPI.foo()，preload 没暴露 foo —— 点下去 TypeError
 *                  （④ 查的是「主进程 → 前端」这一侧，⑦ 查「前端 → preload」那一侧，
 *                   两侧都通才算真接上。实现见 tools/wirecheck.js，可单独跑）
 *
 * 用法：
 *   node tools/audit.js            人类可读报告；有基线外新增项则退出码 1
 *   node tools/audit.js --json     机器可读（CI / 对比用）
 *   node tools/audit.js --verbose  连基线内的已知项也列出来
 *   node tools/audit.js --prune    把当前全部发现写进基线（只在确认「这些都能接受」时用）
 *
 * 基线：tools/audit-baseline.json，每项必须带 reason。**不允许无理由进基线**——
 * 那正是「护栏名存实亡」的起点。基线里若有已经消失的项，会提示清理（--prune 会顺手删）。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BASELINE_PATH = path.join(__dirname, 'audit-baseline.json')

// 打包进来的第三方/生成物：libs.js 是 esbuild 产物，vendor 是整包依赖
const EXCLUDE = [
  /\/node_modules\//,
  /\/libs\.js$/,
  /\/vendor\//,
  /\/dist\//,
  /\/\.venv/,
  /\/resources\/(?:screen|bili|asr)\//
]

const SRC_EXTS = ['.js', '.html']

// 全大写 = 常量表（词表、阈值、默认路径…）。这类导出没人用只是「多导出了一个名字」，
// 不是「功能没接上」，所以单独归类、不判定失败——否则 50 多个常量会淹掉真问题。
const isConst = (name) => /^[A-Z][A-Z0-9_]*$/.test(name)

function walk (dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const rel = toRel(p)
    if (EXCLUDE.some((re) => re.test('/' + rel))) continue
    let st
    try { st = fs.statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (SRC_EXTS.includes(path.extname(name))) out.push(p)
  }
  return out
}

function toRel (p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

/** 剥掉注释（保留换行与字符串）。注释里的词会让死代码看起来「有引用」，必须去掉。 */
function stripComments (src) {
  const keepNl = (m) => m.replace(/[^\n]/g, ' ')
  return src
    .replace(/\/\*[\s\S]*?\*\//g, keepNl)
    // 行注释：前一个字符不能是 : 或 \，避免把 https:// 砍掉
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
}

// ---------------- 文件索引 ----------------

const files = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'test')),
  ...walk(path.join(ROOT, 'tools')) // 不少主进程能力由命令行工具调用，算活引用
]
const cache = new Map()
function read (abs) {
  if (!cache.has(abs)) {
    try { cache.set(abs, fs.readFileSync(abs, 'utf8')) } catch { cache.set(abs, '') }
  }
  return cache.get(abs)
}

const sourceFiles = files.filter((f) => toRel(f).startsWith('src/'))
const testFiles = files.filter((f) => toRel(f).startsWith('test/'))
const plain = new Map() // rel -> 去注释文本
for (const f of files) plain.set(toRel(f), stripComments(read(f)))

const MAIN_FILES = sourceFiles.filter((f) => /^src\/main\//.test(toRel(f)))
const CLIENT_FILES = files.filter((f) => /^src\/(preload|renderer)\//.test(toRel(f)))

// ---------------- ① / ② 导出是否有外部引用 ----------------

/** 解析 `module.exports = { ... }` 块里的键名（含简写、键值、方法简写） */
function parseExports (src) {
  const keys = []
  const at = src.indexOf('module.exports')
  if (at < 0) return keys
  const braceAt = src.indexOf('{', at)
  const eqAt = src.indexOf('=', at)
  // module.exports = require('./x') 这类再导出：不算
  if (braceAt < 0 || (eqAt >= 0 && eqAt < braceAt && src.slice(eqAt, braceAt).includes('require'))) return keys
  let depth = 0
  let end = -1
  for (let i = braceAt; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return keys
  const block = src.slice(braceAt + 1, end)
  // 只认「最外层的键」：块里嵌套对象的字段（overview 返回的 { feedback, lastSnapshots… }）
  // 缩进更深，按缩进取最小值过滤。早期版本没过滤，把返回对象的字段也当成导出了，
  // 报出一堆假死项——lastSnapshots 就是这么被误报的，差点去删一段正在用的代码。
  const rows = []
  for (const line of block.split('\n')) {
    const m = line.match(/^(\s+)(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(?=[,:(\n]|$)/)
    if (!m) continue
    const name = m[2] || m[3] || m[4]
    if (name) rows.push({ indent: m[1].length, name })
  }
  const minIndent = rows.reduce((a, r) => Math.min(a, r.indent), Infinity)
  for (const r of rows) {
    if (r.indent !== minIndent) continue
    if (!keys.includes(r.name)) keys.push(r.name)
  }
  // exports.foo = ...
  for (const m of src.matchAll(/^exports\.([A-Za-z_$][\w$]*)\s*=/gm)) keys.push(m[1])
  return keys
}

function checkExports () {
  const dead = []
  const testOnly = []
  for (const f of sourceFiles) {
    const rel = toRel(f)
    const text = plain.get(rel)
    for (const name of parseExports(text)) {
      const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b')
      let inSrc = false
      let inTest = false
      for (const g of sourceFiles) {
        if (toRel(g) === rel) continue
        if (re.test(plain.get(toRel(g)))) { inSrc = true; break }
      }
      if (!inSrc) {
        for (const g of testFiles) {
          if (re.test(plain.get(toRel(g)))) { inTest = true; break }
        }
      }
      if (inSrc) continue
      // 本文件内有没有用过它？>=3 次说明「定义 + 导出 + 至少一次调用」，即内部在用、只是导出后没人引用。
      // 这种只是多导出了一个名字，删掉导出即可，不是「功能没接上」——
      // 早期版本没分这一层，53 个真项里有 20 多个是这种，真问题被淹掉了。
      const selfCount = (text.match(new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g')) || []).length
      const usedInside = selfCount >= 3
      let kind
      if (usedInside) kind = 'overExport'
      else if (isConst(name)) kind = inTest ? 'testOnlyConst' : 'deadConst'
      else kind = inTest ? 'testOnly' : 'deadExport'
      const item = {
        id: kind + ':' + rel + ':' + name,
        kind,
        file: rel,
        name,
        warn: usedInside || isConst(name)
      }
      if (kind === 'testOnly' || kind === 'deadExport') dead.push(item)
      else testOnly.push(item)
    }
  }
  return { dead, testOnly }
}

// ---------------- ③ 文件内死函数 ----------------

function checkDeadFunc () {
  const out = []
  for (const f of sourceFiles) {
    const rel = toRel(f)
    const text = plain.get(rel)
    if (/^src\/renderer\/.*\.js$/.test(rel)) continue // 渲染层大量函数由事件绑定/HTML 调用，启发式不可靠
    const exported = new Set(parseExports(text))
    const defs = [...text.matchAll(/^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1])
    for (const name of new Set(defs)) {
      if (exported.has(name)) continue
      const n = (text.match(new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g')) || []).length
      if (n <= 1) out.push({ id: 'deadFunc:' + rel + ':' + name, kind: 'deadFunc', file: rel, name, warn: true })
    }
  }
  return out
}

// ---------------- ④ IPC 注册了没人调 ----------------

function checkIpc () {
  const out = []
  const clientText = CLIENT_FILES.map((f) => plain.get(toRel(f))).join('\n')
  for (const f of MAIN_FILES) {
    const rel = toRel(f)
    const text = read(f) // 通道名在字符串里，不能剥字符串，但注释无所谓
    for (const m of text.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)) {
      const ch = m[1]
      if (clientText.includes("'" + ch + "'") || clientText.includes('"' + ch + '"')) continue
      out.push({ id: 'unwiredIpc:' + ch, kind: 'unwiredIpc', file: rel, name: ch })
    }
  }
  return out
}

// ---------------- ⑤ 配置项没人读 ----------------

function checkCfg () {
  const storeAbs = path.join(ROOT, 'src/main/store.js')
  const storeText = plain.get('src/main/store.js') || read(storeAbs)
  const at = storeText.indexOf('function defaults')
  if (at < 0) return []
  // 取 defaults() 函数体（花括号配平）
  const braceAt = storeText.indexOf('{', storeText.indexOf('return', at))
  let depth = 0
  let end = -1
  for (let i = braceAt; i < storeText.length; i++) {
    if (storeText[i] === '{') depth++
    else if (storeText[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return []
  const body = storeText.slice(braceAt + 1, end)
  const keys = new Set()
  for (const m of body.matchAll(/^\s{4,8}([A-Za-z_$][\w$]*)\s*:/gm)) keys.add(m[1])
  const out = []
  const others = sourceFiles.filter((f) => toRel(f) !== 'src/main/store.js')
  for (const k of keys) {
    if (['version'].includes(k)) continue
    let used = false
    for (const f of others) {
      const t = plain.get(toRel(f))
      if (new RegExp("['\"`]" + k + "['\"`]").test(t) || new RegExp('\\.' + k + '\\b').test(t)) { used = true; break }
    }
    if (!used) out.push({ id: 'unusedCfg:' + k, kind: 'unusedCfg', file: 'src/main/store.js', name: k })
  }
  return out
}

// ---------------- ⑥ 护栏失效：断言的正则在源码里匹配不到 ----------------

/** 从 `assert.match(SRC, /.../flags, '消息')` 里取正则字面量（字符类内的 / 不算结束） */
function extractRegexLiteral (text, from) {
  if (text[from] !== '/') return null
  let i = from + 1
  let inClass = false
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      const flags = (text.slice(i + 1).match(/^[gimsuy]*/) || [''])[0]
      return { body: text.slice(from + 1, i), flags }
    }
    i++
  }
  return null
}

function checkStaleGuards () {
  const out = []
  for (const f of testFiles) {
    if (!/\.test\.js$/.test(f.name)) continue
    const rel = toRel(f)
    const text = read(f)
    // 变量 → 源码文件
    const vars = new Map()
    for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*fs\.readFileSync\(\s*([^;]+?)\s*,\s*['"]utf8['"]\s*\)/g)) {
      const argText = m[2]
      if (!argText.includes('__dirname')) continue
      const parts = [...argText.matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] !== undefined ? x[1] : x[2])
      const relParts = parts.filter((p) => p !== '__dirname' && p !== 'utf8')
      if (!relParts.some((p) => p.startsWith('..') || p.includes('/'))) continue
      const target = path.resolve(path.dirname(f), ...relParts.filter((p) => p !== 'path'))
      if (!fs.existsSync(target)) continue
      vars.set(m[1], { abs: target, text: read(target) })
    }
    if (!vars.size) continue
    // assert.match(VAR, /re/, 'msg')：只查 match，不查 doesNotMatch（后者本来就该不匹配）
    for (const m of text.matchAll(/(?<!doesNot)assert\.match\(\s*([A-Za-z_$][\w$]*)\s*,\s*/g)) {
      const target = vars.get(m[1])
      if (!target) continue
      const lit = extractRegexLiteral(text, m.index + m[0].length)
      if (!lit) continue
      let re
      try { re = new RegExp(lit.body, lit.flags) } catch { continue }
      if (re.test(target.text)) continue
      const line = text.slice(0, m.index).split('\n').length
      out.push({
        id: 'staleGuard:' + rel + ':' + line,
        kind: 'staleGuard',
        file: rel,
        name: toRel(target.abs) + ' 第 ' + line + ' 行',
        regex: '/' + lit.body + '/' + lit.flags
      })
    }
  }
  return out
}

// ---------------- 基线 ----------------

// ---------------- ⑦ 渲染层调了、preload 没暴露 ----------------

/**
 * 这一侧最容易漏：主进程 handler、preload 通道、渲染层按钮，三处任缺一处都表现为
 * 「按钮点了没反应」，而且控制台只在用户真点的时候才报 TypeError。
 * 0.39.0 的 B 站设置（只存不读）、0.40.0 的形象装扮窗（保存配色报错）都是这个形状。
 */
function checkWire () {
  const { TARGETS, check, checkChannels, allGlobals, checkGlobals } = require('./wirecheck.js')
  const out = []
  const known = allGlobals()
  for (const t of TARGETS) {
    const r = check(t)
    if (r.error) {
      out.push({ id: 'unwiredApi:' + t.dir + ':<preload 缺失>', kind: 'unwiredApi', file: t.dir, name: '<preload 缺失>' })
      continue
    }
    for (const [key, file] of r.miss) {
      out.push({
        id: 'unwiredApi:' + t.dir + ':' + key,
        kind: 'unwiredApi',
        file: String(file).replace(/\\/g, '/'),
        name: key
      })
    }
    // 用了别的窗口才有的全局（window.companion 之类）——带着空判断，永远不执行
    for (const [name, file] of checkGlobals(t, known)) {
      out.push({
        id: 'unwiredApi:' + t.dir + ':window.' + name,
        kind: 'unwiredApi',
        file: String(file).replace(/\\/g, '/'),
        name: 'window.' + name
      })
    }
  }
  // 反方向：preload 调的通道主进程没注册 handler（通道名拼错，invoke 永远 reject）
  for (const [ch, file] of checkChannels()) {
    out.push({
      id: 'unwiredApi:channel:' + ch,
      kind: 'unwiredApi',
      file: String(file).replace(/\\/g, '/'),
      name: ch
    })
  }
  return out
}

function loadBaseline () {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    return raw && typeof raw.allow === 'object' ? raw : { allow: {} }
  } catch { return { allow: {} } }
}

function saveBaseline (allow) {
  const body = {
    _note: '接线审计基线：这里每一项都是「确认过可以接受」的。新增项必须先在代码里修，修不掉再用 --prune 并写清 reason。',
    allow
  }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(body, null, 2) + '\n')
}

// ---------------- 主流程 ----------------

function run () {
  const { dead, testOnly } = checkExports()
  const findings = [
    ...dead,
    ...testOnly,
    ...checkDeadFunc(),
    ...checkIpc(),
    ...checkCfg(),
    ...checkStaleGuards(),
    ...checkWire()
  ]
  return findings
}

const LABEL = {
  deadExport: '① 导出后全项目零引用',
  testOnly: '② 只被测试引用（产品代码没用）',
  overExport: '· 文件内在用、只是导出没人引用（删导出即可）',
  deadConst: '· 常量导出没人用（无害，可清）',
  testOnlyConst: '· 常量只给测试用（无害，可清）',
  deadFunc: '③ 文件内定义后从未调用',
  unwiredIpc: '④ IPC 注册了但前端从不调用',
  unusedCfg: '⑤ 配置项存在但无人读取',
  staleGuard: '⑥ 测试护栏的正则已匹配不到源码',
  unwiredApi: '⑦ 渲染层调了、preload 没暴露的接口'
}

function main () {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const verbose = argv.includes('--verbose')
  const prune = argv.includes('--prune')

  const findings = run()
  const baseline = loadBaseline()

  if (prune) {
    const allow = { ...baseline.allow }
    for (const f of findings) {
      if (f.warn) continue
      if (!allow[f.id]) allow[f.id] = { reason: 'TODO：还没填理由。没理由的基线项等于没审。' }
    }
    // 顺手删掉已经消失的项
    const ids = new Set(findings.map((f) => f.id))
    for (const id of Object.keys(allow)) if (!ids.has(id)) delete allow[id]
    saveBaseline(allow)
    console.log('已写入基线：' + Object.keys(allow).length + ' 项 → tools/audit-baseline.json')
    console.log('请逐条补 reason，空着就等于没审。')
    return 0
  }

  // 「新增」只算会判定失败的项：warn 类（冗余导出、没人用的常量）本来就不拦，
  // 也从不进基线，否则它们会一直挂在「新增」里，把真问题淹没。
  const hard = findings.filter((f) => !f.warn)
  const fresh = hard.filter((f) => !baseline.allow[f.id])
  const freshHard = fresh
  const known = findings.filter((f) => baseline.allow[f.id])
  const stale = Object.keys(baseline.allow).filter((id) => !hard.some((f) => f.id === id))

  if (asJson) {
    console.log(JSON.stringify({ fresh, known, staleBaseline: stale, total: findings.length }, null, 2))
    return fresh.length ? 1 : 0
  }

  const byKind = new Map()
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, [])
    byKind.get(f.kind).push(f)
  }

  const soft = findings.length - hard.length
  console.log('接线审计 · 要处理的 ' + hard.length + ' 项（基线外新增 ' + fresh.length + ' 项）' +
    (soft ? '；另有 ' + soft + ' 项冗余导出（--verbose 看）' : '') + '\n')
  const QUIET = ['overExport', 'deadConst', 'testOnlyConst']
  for (const [kind, label] of Object.entries(LABEL)) {
    const list = byKind.get(kind) || []
    if (QUIET.includes(kind) && !verbose) {
      if (list.length) console.log('  · ' + label + '：' + list.length + ' 项（要看加 --verbose）')
      continue
    }
    const nf = list.filter((f) => !baseline.allow[f.id]).length
    if (!list.length) { console.log('  ✓ ' + label); continue }
    console.log((nf ? '  ✖ ' : '  · ') + label + '：共 ' + list.length + (nf ? '，新增 ' + nf : ''))
    for (const f of list) {
      const isNew = !baseline.allow[f.id]
      if (!isNew && !verbose) continue
      const extra = f.regex ? '  正则 ' + f.regex : ''
      console.log('      ' + (isNew ? '+ ' : '  ') + f.file + ' → ' + f.name + extra)
      if (!isNew) console.log('        基线理由：' + baseline.allow[f.id].reason)
    }
  }

  if (stale.length) {
    console.log('\n提示：基线里有 ' + stale.length + ' 项已经不存在了（代码修好或删了），建议 --prune 清掉：')
    for (const id of stale.slice(0, 8)) console.log('    - ' + id)
    if (stale.length > 8) console.log('    …')
  }

  if (fresh.length) {
    console.log('\n以上 ' + fresh.length + ' 项不在基线内。' +
      (freshHard.length ? '其中 ' + freshHard.length + ' 项是「写了没接上」，判定为失败：' : '全部是可清可留的常量导出，不判定失败。'))
    if (freshHard.length) {
      console.log('修掉，或确认可接受后写进基线并说明理由。')
      return 1
    }
    return 0
  }
  console.log('\n没有基线外的新增项。')
  return 0
}

if (require.main === module) process.exit(main())

module.exports = { run, LABEL }
