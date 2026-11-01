'use strict'
/**
 * 界面多语言（S7 / shared/i18n.js + strings.*.js）单测
 *
 * 覆盖点都对应规格书 7.4 / 7.5 / 7.7：
 *  - BCP 47 locale 归一（zh-TW→zh-Hant、es→es-419、pt→pt-BR、认不出→null）
 *  - 部分翻译回退：zh-Hant 缺的读 zh，其余语言缺的读 en；组内逐 key 合并
 *  - 四份语言文件键结构完全对齐（顶层组 + 叶子 key 一致），防止漏翻静默回退
 *  - applyDOM 把 data-i18n / data-i18n-ph / data-i18n-title 真正落到 DOM
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const ROOT = path.join(__dirname, '..')

/** 与浏览器一致的加载方式：先 i18n 核心，再按顺序挂语言文件（都挂到同一个 window） */
function loadAll () {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' })
  const { window } = dom
  const files = [
    'src/renderer/shared/i18n.js',
    'src/renderer/shared/i18n/strings.zh.js',
    'src/renderer/shared/i18n/strings.zh-Hant.js',
    'src/renderer/shared/i18n/strings.en.js',
    'src/renderer/shared/i18n/strings.ja.js'
  ]
  for (const f of files) window.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'))
  return window
}

/** 抽出叶子 key 集合（组名/叶子两层的完整路径），用于四语言对齐断言 */
function leafPaths (obj, prefix, out) {
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k]
    const p = prefix ? prefix + '.' + k : k
    if (v && typeof v === 'object' && !Array.isArray(v)) leafPaths(v, p, out)
    else out.push(p)
  }
  return out
}

test('locale 归一：BCP 47 标签映射到 11 个语言码', () => {
  const w = loadAll()
  const n = w.AuraI18n.normalizeLocale
  assert.equal(n('zh'), 'zh')
  assert.equal(n('zh-CN'), 'zh')
  assert.equal(n('zh-TW'), 'zh-Hant')
  assert.equal(n('zh_HK'), 'zh-Hant')
  assert.equal(n('zh-MO'), 'zh-Hant')
  assert.equal(n('en-US'), 'en')
  assert.equal(n('ja-JP'), 'ja')
  assert.equal(n('ko'), 'ko')
  assert.equal(n('fr-FR'), 'fr')
  assert.equal(n('de-DE'), 'de')
  assert.equal(n('es'), 'es-419')
  assert.equal(n('es-MX'), 'es-419')
  assert.equal(n('pt-BR'), 'pt-BR')
  assert.equal(n('pt'), 'pt-BR')
  assert.equal(n('it-IT'), 'it')
  assert.equal(n('ru-RU'), 'ru')
  assert.equal(n('klingon'), null)
  assert.equal(n(''), null)
  assert.equal(n(null), null)
})

test('语言解析：auto 跟系统语言，乱值同样跟系统，无系统语言才兜底 zh', () => {
  const w = loadAll()
  const I = w.AuraI18n
  // jsdom 默认 navigator.language = 'en-US' → auto 应解析为 en
  const sysLang = I.normalizeLocale(w.navigator.language) || 'zh'
  assert.equal(I.setLang('auto'), sysLang)
  assert.equal(I.setLang('garbage-lang'), sysLang)
  assert.equal(I.setLang('ja'), 'ja')
  assert.equal(I.lang, 'ja')
})

test('部分翻译回退：ja 缺的读 en，zh-Hant 缺的读 zh', () => {
  const w = loadAll()
  const I = w.AuraI18n
  // 临时把 ja 的 pv 组拿走，验证整组回退到 en
  const backup = I.STRINGS.ja.pv
  delete I.STRINGS.ja.pv
  I.setLang('ja')
  assert.equal(I.t('pv.doing'), 'Synthesizing…', 'ja 缺组应回退 en')
  I.STRINGS.ja.pv = backup
  // 组内逐 key 合并：只留一个 key 也应从 en 补齐其余
  const full = I.STRINGS.ja.pv
  I.STRINGS.ja.pv = { doing: '合成中（覆盖）' }
  I.setLang('ja')
  assert.equal(I.t('pv.doing'), '合成中（覆盖）')
  assert.equal(I.t('pv.fail'), 'Failed: ', '组内缺 key 应从 en 补齐')
  I.STRINGS.ja.pv = full
  // zh-Hant 回 zh
  const bk = I.STRINGS['zh-Hant'].pv
  delete I.STRINGS['zh-Hant'].pv
  I.setLang('zh-Hant')
  assert.equal(I.t('pv.doing'), '合成中…', 'zh-Hant 缺组应回退 zh')
  I.STRINGS['zh-Hant'].pv = bk
})

test('四份语言文件键结构完全对齐（防漏翻静默回退）', () => {
  const w = loadAll()
  const S = w.AuraI18n.STRINGS
  const zh = leafPaths(S.zh, '', []).sort()
  for (const code of ['en', 'zh-Hant', 'ja']) {
    const other = leafPaths(S[code], '', []).sort()
    assert.deepEqual(other, zh, code + ' 的键与 zh 不一致')
  }
  // 每个叶子都能取出非空文案（函数也行）
  for (const p of zh) {
    const v = p.split('.').reduce((o, k) => o[k], S.zh)
    assert.ok(v !== undefined && v !== '', 'zh 缺文案: ' + p)
  }
})

test('applyDOM：data-i18n / -ph / -title 真正落到 DOM', () => {
  const w = loadAll()
  const I = w.AuraI18n
  w.document.body.innerHTML =
    '<button id="a" data-i18n="nav.chat">聊天</button>' +
    '<input id="b" data-i18n-ph="ph.input">' +
    '<button id="c" data-i18n-title="win.pin">📌</button>'
  I.setLang('zh')
  I.applyDOM(w.document)
  assert.equal(w.document.getElementById('a').textContent, '聊天')
  assert.equal(w.document.getElementById('b').getAttribute('placeholder'), '说点什么…（Enter 发送，Shift+Enter 换行）')
  assert.equal(w.document.getElementById('c').getAttribute('title'), '窗口置顶')
  I.setLang('en')
  I.applyDOM(w.document)
  assert.equal(w.document.getElementById('a').textContent, 'Chat')
  assert.equal(w.document.getElementById('c').getAttribute('title'), 'Pin window')
})

test('applyDOM 容器安全：含控件的 label 只换文字，控件必须还在', () => {
  const w = loadAll()
  const I = w.AuraI18n
  w.document.body.innerHTML =
    '<label id="wrap" data-i18n="perm.label"><select id="inner"><option>x</option></select></label>' +
    '<label id="wrap2" data-i18n="data.label"><button id="inner2">导出</button><div id="inner3"></div></label>' +
    '<label id="wrap3" data-i18n="vendor.label"></label>'
  I.setLang('zh')
  I.applyDOM(w.document)
  assert.ok(w.document.getElementById('inner'), 'select 被吞了')
  assert.ok(w.document.getElementById('inner2') && w.document.getElementById('inner3'), 'button/div 被吞了')
  // 用 t() 取期望值，避免文案一改测试就挂（本用例只关心「文字被写进去且控件还在」）
  assert.equal(w.document.getElementById('wrap').textContent.slice(0, 6), I.t('perm.label').slice(0, 6))
  // label 原本没有文本节点：翻译要插进去而不是丢掉
  assert.equal(w.document.getElementById('wrap3').textContent, I.t('vendor.label'))
})

test('11 语言码列表完整（规格 7.4）', () => {
  const w = loadAll()
  assert.deepEqual(w.AuraI18n.LANGUAGES, ['zh', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es-419', 'pt-BR', 'it', 'ru'])
})

test('companion 设置页语言下拉覆盖全部 11 个语言码', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/companion/index.html'), 'utf8')
  const m = html.match(/<select id="cpUiLang"[\s\S]*?<\/select>/)
  assert.ok(m, '设置页缺少 cpUiLang 下拉')
  const w = loadAll()
  for (const code of w.AuraI18n.LANGUAGES) {
    assert.ok(m[0].includes(`value="${code}"`), '语言下拉缺少 ' + code)
  }
})

/**
 * 「文案键存在但字典里没有」→ 界面直接把 key 原样显示给用户（api.effortUnsupported）。
 * 0.40.0 就是这么被翻出来的：写法上完全合法，四语言结构也对齐，只是谁都没写这一条。
 * 拼接前缀（t('guide.title' + X)）通过「字典里有以它开头的键」放行。
 */
test('渲染层用到的每一个文案键，字典里都有', () => {
  const w = loadAll()
  const zh = leafPaths(w.AuraI18n.STRINGS.zh, '', [])
  const set = new Set(zh)
  const isPrefix = (k) => zh.some((p) => p.startsWith(k) && p !== k)

  const files = []
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n)
      if (fs.statSync(p).isDirectory()) walk(p)
      /* libs.js 是 three.js 等三方库的打包产物（压缩后局部变量名就叫 t），
         里面的 t("EXT_color_buffer_float") 是 WebGL 扩展名，不是文案键——
         以前一直误报，修掉。我们自己的代码都不在这个文件里。 */
      else if (/\.(js|html)$/.test(n) && !/i18n/.test(n) && n !== 'libs.js') files.push(p)
    }
  }
  walk(path.join(ROOT, 'src/renderer'))

  const used = new Map()
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    // t('a.b') / t("a.b")；模板字符串带 ${} 的是动态键，跳过
    for (const m of src.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.\-]+)['"]/g)) {
      if (!used.has(m[1])) used.set(m[1], path.relative(ROOT, f))
    }
    // HTML 静态文案：data-i18n / data-i18n-ph / data-i18n-title
    for (const m of src.matchAll(/data-i18n(?:-ph|-title)?="([A-Za-z0-9_.\-]+)"/g)) {
      if (!used.has(m[1])) used.set(m[1], path.relative(ROOT, f))
    }
  }

  const bad = [...used].filter(([k]) => !set.has(k) && !isPrefix(k))
    .map(([k, f]) => k + '  ← ' + f)
  // 自守卫：正则若哪天匹配不到代码（改名/换引号），used 会空，这条测试就成了摆设
  assert.ok(used.size > 100, '只扫到 ' + used.size + ' 个键，检查器可能已失效')
  assert.deepStrictEqual(bad, [], '这些键在代码里用了，字典里没有（界面会显示 key 原文）：\n' + bad.join('\n'))
})
