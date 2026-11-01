/**
 * 0.43.0 电脑画像「今天」
 * 用户语义：她要知道我今天在电脑上干了什么（打了多少、跟谁聊、看什么），
 * 而不是背一份 14 天的档案。这里钉住「把窗口痕迹翻译成人话」的几个坑。
 */
const test = require('node:test')
const assert = require('node:assert')

const t = require('../src/main/profile/today')

test('today: 联系人标题洗得干净（未读计数 / 客户端后缀 / 主界面）', () => {
  assert.equal(t.contactOf('(3) 小王 - 微信'), '小王')
  assert.equal(t.contactOf('项目群 - 微信'), '项目群')
  assert.equal(t.contactOf('Alice - Discord'), 'Alice')
  assert.equal(t.contactOf('微信'), '', '主界面没有联系人，不能当成一个人')
  assert.equal(t.contactOf('QQ'), '')
  assert.equal(t.contactOf(''), '')
  // 太长的多半是一句话而不是人名（群公告、消息预览），丢掉
  assert.equal(t.contactOf('x'.repeat(40) + ' - 微信'), '')
})

test('today: 网页标题去掉浏览器尾巴', () => {
  assert.equal(t.pageOf('某个教程 - Microsoft Edge'), '某个教程')
  assert.equal(t.pageOf('(2) 知乎 - 某问题 - Google Chrome'), '知乎 - 某问题')
  assert.equal(t.pageOf('B站 - Mozilla Firefox'), 'B站')
})

test('today: 时长说法（不足一分钟不报 0）', () => {
  assert.equal(t.dur(0), '不到 1 分钟')
  assert.equal(t.dur(30), '不到 1 分钟')
  assert.equal(t.dur(60), '1 分钟')
  assert.equal(t.dur(3600), '1 小时')
  assert.equal(t.dur(3720), '1 小时 2 分')
})

test('today: 没数据时返回空串（调用方不许硬塞）', () => {
  assert.equal(t.build(null), '')
  assert.equal(t.build({ ok: false }), '')
  assert.equal(t.build({ ok: true, apps: [] }), '')
})

test('today: 完整一天→能说出「干了多久、主要用什么、跟谁聊、看什么」', () => {
  const now = Date.now()
  const txt = t.build({
    ok: true,
    first: now - 8 * 3600 * 1000,
    last: now - 60 * 1000,
    totalSec: 6 * 3600,
    activeSec: 3 * 3600,
    idleSec: 30,
    apps: [
      { app: 'Code', minutes: 190, activeMinutes: 180, titles: ['main.js - Visual Studio Code'] },
      { app: 'msedge', minutes: 105, activeMinutes: 40, titles: ['某个教程 - Microsoft Edge'] },
      { app: 'wechat', minutes: 52, activeMinutes: 20, titles: ['小王 - 微信'] }
    ]
  }, now)
  assert.match(txt, /开始用电脑/)
  assert.match(txt, /真的操作/)
  assert.match(txt, /主要在用：Code/)
  assert.match(txt, /小王/)
  assert.match(txt, /某个教程/)
  assert.match(txt, /刚刚还在动键鼠/, 'idle 30 秒要能判断出人在')
  assert.doesNotMatch(txt, /没有键鼠动静/)
})

test('today: 人走了要说「多久没动静」，而不是假装人在', () => {
  const txt = t.build({
    ok: true,
    first: Date.now() - 4 * 3600 * 1000,
    last: Date.now() - 40 * 60 * 1000,
    totalSec: 3 * 3600,
    activeSec: 60 * 60,
    idleSec: 40 * 60,
    apps: [{ app: 'msedge', minutes: 60, activeMinutes: 30, titles: ['B站 - Microsoft Edge'] }]
  })
  assert.match(txt, /最近 40 分钟没有键鼠动静/)
  assert.doesNotMatch(txt, /刚刚还在动键鼠/)
})

test('today: 只有聊天软件且拿不到联系人 → 说清「不知道跟谁」，不编', () => {
  const txt = t.build({
    ok: true,
    first: Date.now() - 3600 * 1000,
    last: Date.now() - 60000,
    totalSec: 3600,
    activeSec: 1800,
    idleSec: 20,
    apps: [{ app: 'wechat', minutes: 40, activeMinutes: 20, titles: ['微信'] }]
  })
  assert.match(txt, /没看到具体是谁/)
  assert.doesNotMatch(txt, /聊天窗口出现过/)
})
