'use strict'
/**
 * 0.47.2 弹幕复读假象（11-08 22:01 实锤）：
 *
 * 日志里「手元はもう別の画面…」只生成了一次，但弹幕盒里出现了两行
 * 「手边已经切到另一个画面了。」——根因在显示层：
 *   1. dk.say(整句译文) 按句号切成两条弹幕（danmaku-split 的「一条=一句」）；
 *   2. 紧接着 subtitle() → danmaku.replaceLast(整句) 把最后一条覆盖成全句；
 *   3. 前半句就在盒子里出现两遍，看起来像她把同一句话说了两遍。
 *
 * 修复：dmHold 路径里译文已经由 dk.say 上过弹幕，subtitle 带 skipDm 跳过
 * replaceLast。本文件锁两件事：skipDm 真的跳过、两个出口真的传了 skipDm。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

test('subtitle({skipDm:true}) 不再调 danmaku.replaceLast（复读假象的根）', () => {
  const pb = require('../src/main/petBridge')
  const dk = require('../src/main/danmaku')
  const calls = []
  const orig = dk.replaceLast
  dk.replaceLast = (t) => { calls.push(String(t)) }
  try {
    pb.subtitle({ text: '甲句。乙句。' })
    assert.strictEqual(calls.length, 1, '不带 skipDm：保持原行为（换弹幕文字）')
    pb.subtitle({ text: '丙句。丁句。', skipDm: true })
    assert.strictEqual(calls.length, 1, '带 skipDm：必须跳过 replaceLast——译文已经由 dk.say 推过弹幕')
    pb.subtitle({ text: '' })
    assert.strictEqual(calls.length, 1, '空文本：不动弹幕')
  } finally {
    dk.replaceLast = orig
  }
})

test('两个主动出口（sayNarration / sayProactive）的 dmHold 路径都传了 skipDm', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/companion/index.js'), 'utf8')
  // sayNarration：译文回来 dk.say 之后，subtitle 必须带 skipDm 且与 dmHeld 挂钩
  assert.match(src, /subtitle\(\{\s*text:\s*display,\s*skipDm:\s*!!\(rr && rr\.dmHeld\)\s*\}\)/,
    'sayNarration 的 subtitle 要带 skipDm（dmHeld 时跳过 replaceLast）')
  // sayProactive：同款
  assert.match(src, /pb\.subtitle\(\{\s*text:\s*display,\s*skipDm:\s*!!\(r && r\.dmHeld\)\s*\}\)/,
    'sayProactive 的 subtitle 要带 skipDm（dmHeld 时跳过 replaceLast）')
})

test('复读假象的机制断言：dk.say 的切句会让 replaceLast(整句) 产生重复内容', () => {
  // 把事故现场固化成断言：切句 → 「手边已经切到另一个画面了。」是独立一条；
  // replaceLast(全句) 若再跑，最后一条被覆盖成全句 → 前半句出现两遍。
  const { splitLines } = require('../src/main/danmaku-split')
  const display = '手边已经切到另一个画面了。切换的速度，让人有点羡慕。'
  const rows = splitLines(display)
  assert.ok(rows.length >= 2, '这句在弹幕层至少切两条（一条=一句）')
  const box = rows.slice()
  box[box.length - 1] = display // 旧 bug：replaceLast(整句) 覆盖最后一条
  const dup = box.filter((s) => s.includes(rows[0])).length
  assert.ok(dup >= 2, '旧行为下前半句出现 ' + dup + ' 遍——这正是截图里的复读假象')
  assert.strictEqual(rows[0] + rows[1], display.replace(/([。])$/, '$1') || display,
    '两条拼回应还原整句（切句没丢字）')
})
