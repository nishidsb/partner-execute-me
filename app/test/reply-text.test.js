/**
 * 0.45.98 台词出口清洗 · 尺子
 *
 * 用户 11-02 报的两个现象是同一个病根：
 *  - QQ 收到的消息开头带「（QQ）」；
 *  - 电脑 TTS 变成「日语念一遍、中文念一遍」。
 * 起因是账本正文里写进了场合前缀（0.45.27）和括号译文（0.45.94），
 * 模型照着自己以前的格式学，新回复也自带这两样。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { stripChannelTag, stripEchoTranslation, echoTranslation, plainText, readableText } = require('../src/shared/reply-text')

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')

test('①stripChannelTag：各种场合前缀都剥掉，正文一个字不动', () => {
  assert.equal(stripChannelTag('（QQ）好，六点，我记住。'), '好，六点，我记住。')
  assert.equal(stripChannelTag('[QQ] 好'), '好')
  assert.equal(stripChannelTag('【QQ】好'), '好')
  assert.equal(stripChannelTag('(QQ:123456) 好'), '好')
  assert.equal(stripChannelTag('（气泡）她小声说'), '她小声说')
  assert.equal(stripChannelTag('[桌面] 你回来啦'), '你回来啦')
  assert.equal(stripChannelTag('（QQ）（气泡）叠了两层'), '叠了两层')
  // 正常句子不该被误伤
  assert.equal(stripChannelTag('QQ 上找你'), 'QQ 上找你')
  assert.equal(stripChannelTag('好，六点。'), '好，六点。')
})

test('②括号译文：语种不同才算译文，同语种是语气（保留）', () => {
  const ja = 'テスト用：0123456789・あいうえお。'
  assert.equal(echoTranslation(ja + '\n（测试用：数字和假名。）'), '测试用：数字和假名。')
  assert.equal(stripEchoTranslation(ja + '\n（测试用：数字和假名。）'), ja, '朗读/显示只留原句')
  // 同语种：括号是语气，不是译文
  assert.equal(stripEchoTranslation(ja + '（笑）'), ja + '（笑）')
  // 中文台词 + 括号中文说明：留着
  assert.equal(stripEchoTranslation('我在等你（真的）'), '我在等你（真的）')
  // 中文 + 英文注释：算译文
  assert.equal(stripEchoTranslation('我在等你 (waiting for you)'), '我在等你')
  // 没有括号：原样
  assert.equal(stripEchoTranslation(ja), ja)
})

test('③plainText：前缀 + 括号译文都清掉（气泡/朗读用）', () => {
  const ja = 'まだ起きてる？'
  assert.equal(plainText('（QQ）' + ja + '\n（还醒着吗？）'), ja)
  assert.equal(plainText('[QQ] ' + ja), ja)
  assert.equal(plainText('还醒着吗？'), '还醒着吗？')
  // 一条多段、每段都带前缀 + 段后一段括号译文（旧账本的真实形态）
  const multi = '（QQ）まだ起きてる？\n（还醒着吗？）\n\n（QQ）先に寝てて。\n（你先睡吧。）'
  assert.equal(plainText(multi), 'まだ起きてる？\n\n先に寝てて。')
  // 段落之间的空行不能被吃掉（她的回复本来是分段的）
  assert.equal(plainText('一行目\n\n二行目\n\n三行目'), '一行目\n\n二行目\n\n三行目')
})

test('④readableText：QQ 是纯文字通道，一条消息只发一种语言', () => {
  const ja = 'まだ起きてる？'
  assert.equal(readableText(ja + '\n（还醒着吗？）'), '还醒着吗？', '模型自带译文 → 只发译文')
  assert.equal(readableText(ja), ja, '没有译文 → 发原文')
  assert.equal(readableText('（QQ）好，六点'), '好，六点', '前缀不发出去')
  assert.equal(readableText('还醒着吗？（笑）'), '还醒着吗？（笑）', '同语种括号不当译文')
})

test('⑤接线：TTS / 气泡朗读 / 核心出口 / QQ 回复都走同一份清洗', () => {
  assert.ok(/plainText\(src\)/.test(read('src/main/companion/tts.js')), 'TTS 合成前洗')
  assert.ok(/replyText\.plainText/.test(read('src/main/companion/index.js')), '主动台词洗')
  assert.ok(/deliverReach/.test(read('src/main/companion/index.js')) && /echoTranslation/.test(read('src/main/companion/index.js')), 'QQ 发送走 readable 口径')
  assert.ok(/replyText\.plainText/.test(read('src/renderer/overlay/pet.js')), '系统语音兜底也洗')
  assert.ok(/reply = plainText\(reply\)/.test(read('src/assistant/core/core/session.js')), '核心回复出口洗')
  assert.ok(/readableText\(t\)/.test(read('src/main/im/brain.js')), 'QQ 聊天回复洗')
  const html = read('src/renderer/overlay/index.html')
  assert.ok(html.includes('../../shared/reply-text.js'), 'overlay 加载共享清洗器')
})

test('⑥老账本净化：读入时剥前缀，模型没法学样', () => {
  const core = read('src/assistant/core/core/session.js')
  assert.ok(/const content = clean\(m\.content\)/.test(core), 'loadHistory 就地洗正文')
  assert.ok(/stripChannelTag\(m\.sub\)/.test(core), '字幕也洗')
})
