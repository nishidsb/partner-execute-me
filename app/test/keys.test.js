'use strict'
/**
 * 0.44.0 键盘与输入内容：差分、敏感遮挡、本地落盘。
 *
 * 这个文件里最重要的不是「能不能记」，而是**什么时候必须不记**：
 * 密码框、密码管理器、无痕窗口。宁可漏，不可错。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const keys = require('../src/main/profile/keys')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-keys-'))

function reset () {
  keys._reset()
  keys._init(tmp, () => { })
  for (const f of fs.readdirSync(path.join(tmp, 'keys'))) {
    try { fs.unlinkSync(path.join(tmp, 'keys', f)) } catch { }
  }
}

function focus (o) {
  keys._onFocus(JSON.stringify(o))
}
function key (ch, exe, title, vk) {
  keys._onKey(['E', String(Date.now()), String(vk || 65), '30', ch || '', exe || 'Code', title || 'main.js'])
}

test('差分：追加只取新增部分', () => {
  assert.deepStrictEqual(keys.diffText('你好', '你好世界'), { add: '世界', del: 0 })
})

test('差分：退格算出删了几个字', () => {
  assert.deepStrictEqual(keys.diffText('你好世界', '你好'), { add: '', del: 2 })
})

test('差分：中间替换（VS Code 光标不在末尾）只取替换段', () => {
  const d = keys.diffText('今天天气不错', '今天天气很好')
  assert.strictEqual(d.add, '很好')
  assert.strictEqual(d.del, 2)
})

test('差分：整篇换掉当重置，不能把整篇文章当「刚打的字」', () => {
  const d = keys.diffText('a'.repeat(500), 'b'.repeat(500))
  assert.strictEqual(d.add, '')
  assert.ok(d.reset, '跳变超过上限必须标记 reset')
})

test('差分：首次读取（无基线）返回空新增', () => {
  assert.deepStrictEqual(keys.diffText(null, 'abc'), { add: 'abc', del: 0 })
})

test('只记值得记的内容：空白、单个标点不进档案', () => {
  assert.strictEqual(keys.worthRecording(''), false)
  assert.strictEqual(keys.worthRecording('   '), false)
  assert.strictEqual(keys.worthRecording('\n\n'), false)
  assert.strictEqual(keys.worthRecording('。'), false)
  assert.strictEqual(keys.worthRecording('好'), true)
  assert.strictEqual(keys.worthRecording('hello'), true)
})

test('敏感进程一律不记：密码管理器、无痕窗口、拿不到进程名', () => {
  assert.strictEqual(keys.denied('1password', 'anything'), true)
  assert.strictEqual(keys.denied('keepass', 'x'), true)
  assert.strictEqual(keys.denied('msedge', '某个页面 - InPrivate'), true)
  assert.strictEqual(keys.denied('chrome', '无痕浏览'), true)
  assert.strictEqual(keys.denied('', 'some title'), true, '拿不到进程名时宁可不记')
  assert.strictEqual(keys.denied('code', 'main.js - ryza-assistant'), false)
  assert.strictEqual(keys.denied('ryza-assistant-app', '她自己'), true)
})

test('密码框：遮挡期内一个键都不记，且清掉文本基线', () => {
  reset()
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: 'secret-prefix' })
  focus({ t: Date.now(), pw: 1, a: 'msedge', w: '登录', ct: 'Edit' })
  const before = keys._state().keysTotal
  key('p', 'msedge', '登录')
  key('w', 'msedge', '登录')
  assert.strictEqual(keys._state().keysTotal, before, '遮挡期内按键不能计数')
  assert.strictEqual(keys._state().prevText.size, 0, '文本基线必须清空，否则离开密码框后会把旧值当新增')
})

test('密码框：UIA 说不再是密码框，遮挡立刻解除（否则会白吞 90 秒的输入）', () => {
  reset()
  focus({ t: Date.now(), pw: 1, a: 'msedge', w: '登录', ct: 'Edit' })
  assert.ok(keys._state().pwUntil > 0)
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: '' })
  assert.strictEqual(keys._state().pwUntil, 0)
  const before = keys._state().keysTotal
  key('a', 'Code', 'main.js')
  assert.strictEqual(keys._state().keysTotal, before + 1)
})

test('文本内容：第一次只建基线，第二次才产出新增', () => {
  reset()
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: 'function foo' })
  assert.strictEqual(keys._state().snippets.length, 0, '第一次只建立基线，不能把已有的整段文字当「刚打的」')
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: 'function foo() {' })
  const sn = keys._state().snippets
  assert.strictEqual(sn.length, 1)
  assert.strictEqual(sn[0].x, '() {')
})

test('文本内容：快速连打会在节流窗口内合并，而不是只剩最后一段', () => {
  reset()
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: 'abc' })
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: 'abcd' })
  const first = keys._state().snippets.length
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: 'abcde' })
  const sn = keys._state().snippets
  assert.strictEqual(sn.length, first, '节流窗口内不该新增一条')
  assert.ok(sn[sn.length - 1].x.endsWith('e'), '新打的字要并到上一条里')
})

test('本地落盘：写 JSONL，内容在里面，且带权限 0600', () => {
  reset()
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: '' })
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: '我今天在改驱动' })
  key('a', 'Code', 'main.js')
  keys._flush()

  const f = path.join(tmp, 'keys', keys.dateKey() + '.jsonl')
  assert.ok(fs.existsSync(f), '当天文件必须存在')
  const raw = fs.readFileSync(f, 'utf8')
  assert.ok(raw.includes('我今天在改驱动'), '输入内容要落本地')

  const mode = fs.statSync(f).mode & 0o777
  if (process.platform !== 'win32') assert.strictEqual(mode, 0o600)
})

test('本地落盘：密码框里的内容一个字都不能进文件', () => {
  reset()
  focus({ t: Date.now(), pw: 0, a: 'msedge', w: '登录', ct: 'Edit', x: '' })
  focus({ t: Date.now(), pw: 1, a: 'msedge', w: '登录', ct: 'Edit' })
  focus({ t: Date.now(), pw: 1, a: 'msedge', w: '登录', ct: 'Edit' })
  keys._flush()
  const f = path.join(tmp, 'keys', keys.dateKey() + '.jsonl')
  const raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  assert.ok(!raw.includes('msedge'), '密码框窗口连按键计数都不该留')
})

test('recent：读回最近记录，按程序排得出谁敲得多', () => {
  reset()
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: '' })
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: 'const x = 1' })
  for (let i = 0; i < 6; i++) key('a', 'Code', 'main.js')
  keys._flush()
  const r = keys.recent({ minutes: 30 })
  assert.ok(r.ok)
  assert.ok(r.keys >= 6)
  assert.strictEqual(r.apps[0].app, 'code')
  assert.ok(r.snippets.some((s) => s.text.includes('const x = 1')))
})

test('clearAll：一键清空，文件不再存在', () => {
  reset()
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: '' })
  focus({ t: Date.now(), pw: 0, a: 'Code', w: 'main.js', ct: 'Edit', x: '要删掉的' })
  const f = path.join(tmp, 'keys', keys.dateKey() + '.jsonl')
  assert.ok(fs.existsSync(f))
  keys.clearAll()
  assert.ok(!fs.existsSync(f))
})

test('todayTotals：能给出今天敲了多少', () => {
  reset()
  for (let i = 0; i < 40; i++) key('a', 'Code', 'main.js')
  const t = keys.todayTotals()
  assert.strictEqual(t.ok, true)
  assert.ok(t.keys >= 40)
  assert.strictEqual(t.apps[0].app, 'code')
})

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { } })
