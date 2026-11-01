/**
 * 0.45.26 全出口入账（主人的要求：所有功能中涉及到的行为聊天都必须进记忆）：
 * - assistant 侧 ledgerNote：统一入账出口（via 来源标记），qqNote 是它的 qq 别名
 * - companion 侧三个原漏账出口全部接线：桌宠气泡对话 / 碎碎念旁白 / 自主活动收尾汇报
 * 主进程文件 require electron，走源码静态断言（cua.test.js / inner.test.js 同款）。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')

test('assistant 导出 ledgerNote，qqNote 委托并带 via:qq', () => {
  const src = read('src/main/assistant/index.js')
  assert.ok(/function ledgerNote \(/.test(src), '有统一入账出口 ledgerNote')
  assert.ok(/function qqNote \(o\) \{ return ledgerNote\(Object\.assign\(\{ via: 'qq' \}, o\)\) \}/.test(src), 'qqNote 是 ledgerNote 的 qq 别名')
  assert.ok(/pushExternalReply, qqNote, ledgerNote, historyTail/.test(src), 'ledgerNote 已导出')
  // 入账条目带 via + external 标记
  assert.ok(/external: true, via: v/.test(src), '条目带 via 来源标记')
  // 主动台词通道也统一带 via:proactive
  assert.ok(/via: 'proactive'/.test(src), 'pushExternalReply 条目带 via:proactive')
})

test('companion 三原漏账出口全部接线 ledgerNote', () => {
  const src = read('src/main/companion/index.js')
  // 1) 桌宠气泡对话（handleMessage 成功收尾处）
  assert.ok(/via: 'pet', user: userText, assistant: full/.test(src), '桌宠气泡往来入账')
  // 2) 碎碎念旁白（sayNarration，chatter/curiosity 共用出口）
  assert.ok(/via: 'chatter', assistant: t/.test(src), '碎碎念旁白入账')
  // 3) 自主活动收尾汇报（autonomy onDone）
  assert.ok(/via: 'autonomy', assistant: line\.slice\(0, 300\)/.test(src), '自主活动汇报入账')
})

test('入账出口不广播 assistant:done（防双朗读/双气泡）', () => {
  // pushExternalReply 才广播（external:true 让 overlay 跳过气泡）；ledgerNote 只落账本
  const src = read('src/main/assistant/index.js')
  const ledger = src.slice(src.indexOf('function ledgerNote'), src.indexOf('function historyTail'))
  assert.ok(!ledger.includes('bcastAll'), 'ledgerNote 不广播')
})

test('QQ 主动找（reach）的 qqNote 调用点保持兼容', () => {
  const src = read('src/main/companion/index.js')
  assert.ok(/qqNote\(\{ self: '（我用 QQ 发消息找他）'/.test(src), 'reach 自述入账照旧')
  const im = read('src/main/im/index.js')
  assert.ok(/qqNote\(\{ user: String\(userText \|\| ''\), assistant: String\(reply \|\| ''\)/.test(im), 'QQ 私聊回写照旧')
})
