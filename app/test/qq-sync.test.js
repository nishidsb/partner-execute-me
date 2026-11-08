/**
 * 0.45.23 QQ 与本体同一本账：
 * - 主人私聊：上下文来自本体聊天史（getOwnerHistory），答完回写（onOwnerExchange），不进 brain 小账本
 * - 非主人/群聊：行为不变（brain 自己的历史键）
 * 全部注入式，不打网络。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createBrain } = require('../src/main/im/brain')

function tmpHome () {
  const home = path.join(os.tmpdir(), 'qq-sync-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(home, { recursive: true })
  return home
}

const OWNER_EV = () => ({
  post_type: 'message',
  message_type: 'private',
  user_id: 10001,
  self_id: 1,
  message: [{ type: 'text', data: { text: '在吗' } }]
})

test('主人私聊：上下文用本体聊天史，回复回写本体，不进 brain 历史', async () => {
  const home = tmpHome()
  const seen = []
  const exchanged = []
  const desktop = [
    { role: 'user', content: '我今天在改那个 bug' },
    { role: 'assistant', content: '加油，改完记得休息' }
  ]
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async ({ messages }) => { seen.push(messages); return { content: '在的～' } } }),
    getContext: () => ({ persona: 'P' }),
    send: async () => { },
    getOwnerHistory: () => desktop,
    onOwnerExchange: (u, r) => exchanged.push([u, r])
  })
  b.saveCfg({ enabled: true, ownerAccounts: ['10001'] })
  await b.handleEvent(OWNER_EV())
  assert.equal(seen.length, 1)
  // 上下文里有本体聊天史的内容
  const flat = JSON.stringify(seen[0])
  assert.ok(flat.includes('我今天在改那个 bug'), '本体历史进上下文')
  assert.ok(flat.includes('主人在 QQ 上说'), '当前这条带 QQ 场合标注')
  // 系统提示词交代了场合
  assert.ok(seen[0][0].content.includes('QQ 手机私聊'), 'sys 有场合说明')
  // 回写本体
  assert.deepEqual(exchanged, [['在吗', '在的～']], '往来回写本体')
  // 不进 brain 小账本
  const h = b._history
  const k = Object.keys(h)[0]
  assert.ok(!k || h[k].length === 0, 'brain 历史不留主人私聊条目')
  fs.rmSync(home, { recursive: true, force: true })
})

test('非主人私聊：仍走 brain 自己的历史键（行为不变）', async () => {
  const home = tmpHome()
  const seen = []
  let exchangeCalled = 0
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async ({ messages }) => { seen.push(messages); return { content: '嗯嗯' } } }),
    getContext: () => ({ persona: 'P' }),
    send: async () => { },
    getOwnerHistory: () => [{ role: 'user', content: '本体的话' }],
    onOwnerExchange: () => { exchangeCalled++ }
  })
  b.saveCfg({ enabled: true, ownerAccounts: ['10001'] })
  await b.handleEvent({ post_type: 'message', message_type: 'private', user_id: 777, self_id: 1, message: [{ type: 'text', data: { text: '你好' } }] })
  assert.equal(exchangeCalled, 0, '非主人不回写本体')
  const flat = JSON.stringify(seen[0])
  assert.ok(!flat.includes('本体的话'), '非主人不吃本体聊天史')
  const h = b._history
  assert.ok(h['def:private:777'] && h['def:private:777'].length === 2, 'brain 历史照旧记两条')
  fs.rmSync(home, { recursive: true, force: true })
})

test('没注入 getOwnerHistory 时主人私聊退回旧行为（向后兼容）', async () => {
  const home = tmpHome()
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async () => ({ content: '好' }) }),
    getContext: () => ({ persona: 'P' }),
    send: async () => { }
  })
  b.saveCfg({ enabled: true, ownerAccounts: ['10001'] })
  await b.handleEvent(OWNER_EV())
  const h = b._history
  const k = Object.keys(h)[0]
  assert.ok(h[k] && h[k].length === 2, '旧路径照旧记两条')
  fs.rmSync(home, { recursive: true, force: true })
})

/* ---- 0.45.27 场合可见：qqWorldBlock + ledgerNote 场合前缀 ---- */
const { qqWorldBlock } = require('../src/main/im/brain')
const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')

test('qqWorldBlock：关着/没配主人号不出声', () => {
  assert.deepEqual(qqWorldBlock({ enabled: false, napcatArgs: '10002', ownerAccounts: ['10001'] }), [])
  assert.deepEqual(qqWorldBlock({ enabled: true, napcatArgs: '10002', ownerAccounts: [] }), [])
  assert.deepEqual(qqWorldBlock(null), [])
})

test('qqWorldBlock：配置齐全时告诉她在 QQ 上有号、[QQ] 标注 = QQ 上的往来（且叫她别自己写）', () => {
  const r = qqWorldBlock({ enabled: true, napcatArgs: '10002', ownerAccounts: ['10001'] })
  assert.equal(r.length, 1)
  const t = r[0].text
  assert.ok(t.includes('10002'), '带她的号')
  assert.ok(t.includes('10001'), '带主人号')
  assert.ok(t.includes('[QQ]'), '交代 [QQ] 标注含义')
  assert.ok(t.includes('自己不要写它'), '0.45.98：标注只是给她看的，不许写进回复')
  assert.ok(t.includes('别说自己看不到'), '硬规则：别说看不到')
})

test('qqWorldBlock：napcatArgs 非纯数字时不出号码但段落照给', () => {
  const r = qqWorldBlock({ enabled: true, napcatArgs: '-q 1234 quick', ownerAccounts: ['10001'] })
  assert.equal(r.length, 1)
  assert.ok(!r[0].text.includes('1234'), '不乱提号')
  assert.ok(r[0].text.includes('你在 QQ 上有自己的账号'), '段落照给')
})

/* 0.45.98：场合标注从「写进正文」改成「组装上下文时才加」——
 * 写进正文会被模型照抄进回复，QQ 对面直接看到「（QQ）」两个字母（用户 11-02 的截图）。 */
test('ledgerNote 不再往正文里写场合前缀；上下文组装时才补 [QQ]/[桌面]', () => {
  const src = read('src/main/assistant/index.js')
  assert.ok(!/CHANNEL_TAGS/.test(src), '正文不再带通道前缀表')
  assert.ok(!/content: tag \+ String/.test(src), '正文不拼 tag（模型会照抄）')
  const selfLine = (src.match(/if \(self\) session\.history\.push\(\{ role: 'assistant', content: ([^,]+),/) || [])[1] || ''
  assert.ok(selfLine === 'String(self)', 'self 原样入账: ' + selfLine)
  const core = read('src/assistant/core/core/session.js')
  assert.ok(/const CHANNEL_MARK = \{ qq: '\[QQ\] ', pet: '\[桌面\] ' \}/.test(core), '标注只在请求里加')
  assert.ok(/content: tag \+ m\.content/.test(core), 'user 侧补标注')
  assert.ok(/export function addWorldPrompts/.test(core), 'core 支持追加式世界段')
  const im = read('src/main/im/index.js')
  assert.ok(/addWorldPrompts\(\(\) => require\('\.\/brain'\)\.qqWorldBlock/.test(im), 'im 注册 QQ 场合段')
})
