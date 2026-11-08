'use strict'
/**
 * 0.46.75 静态接线测试（同 pc-ws-wiring.test.js 模式）：
 * 回复→回复复读修复。真机事故：11-08 13:24/13:25 他连发两条消息
 * （「刚吃完饭哦」「先躺半小时吧」——泛化转述），13:25 的回复把 13:24 回复的
 * 开头（刚吃完嘛/没办法）和内容（游戏声音/定几分钟）几乎原样又讲了一遍。
 * 根因 ×2（链路×2 老坑再现）：
 *  ① noteReply 只在 companion 链（index.js runStream），assistant 链回复从不记账
 *     → reply 事件全天 0 条，镜子永远照不到她自己的回复
 *  ② inner.recentVoices 只收 say/narration，就算记了账 reply 也进不了镜子
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const readApp = (p) => fs.readFileSync(path.join(ROOT, p.replace(/^app\//, '')), 'utf8')

test('0.46.75 assistant 链回复也记账（noteReply 进 assistant/index.js）', () => {
  const src = readApp('app/src/main/assistant/index.js')
  assert.ok(/require\('\.\.\/companion\/inner'\)\.noteReply\(r\.content\)/.test(src),
    'assistant 链回复完成后必须调 inner.noteReply(r.content)——companion 链一条链记账不算修完')
})

test('0.46.75 recentVoices 收入 reply 事件（镜子照得到她自己的回复）', () => {
  const inner = readApp('app/src/main/companion/inner.js')
  const m = inner.match(/function recentVoices[\s\S]*?\n\}/)
  assert.ok(m, 'recentVoices 存在')
  assert.ok(/e\.kind === 'reply'/.test(m[0]), '过滤条件必须含 reply')
  assert.ok(/VOICE_SLICE/.test(m[0]), 'reply 用更长截断（160），不能 60 字把正文切没')
})

test('0.46.75 回复链镜子文案点名「上一条回复」', () => {
  const host = readApp('app/src/main/companion/index.js')
  const hits = host.match(/【你最近几分钟内说过的话[^】]*】/g) || []
  assert.ok(hits.length >= 2, '两条链（lifeBlocks + buildSections）都要有镜子，实际 ' + hits.length)
  for (const h of hits) {
    assert.ok(h.includes('上一条回复'), '文案必须点名她的回复：' + h.slice(0, 40))
  }
  assert.ok(/尤其不许把你上一条回复已经说过的话再讲一遍/.test(host), '硬规则覆盖回复→回复复读')
})

test('0.46.75 companion 链自己的记账仍在（不许修链路时弄丢）', () => {
  const host = readApp('app/src/main/companion/index.js')
  assert.ok(host.includes('inner.noteReply(full)'), 'companion 链 noteReply 原地保留')
})
