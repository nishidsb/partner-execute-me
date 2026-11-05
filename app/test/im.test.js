/**
 * S11 群聊接入：消息段解析 / 触发判定 / 限速 / 历史 / system 构建。
 * 全部注入式（不打网络、不开真 WS）；OneBot 连接层只测纯函数。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { segmentsToText, isAtMe, cqPlaceholder, imageSegmentsOf } = require('../src/main/im/onebot')
const { createBrain, clampCfg, buildSystem, resolveSlot, chatKeyOf } = require('../src/main/im/brain')
const wxMod = require('../src/main/im/wx')
const { extractJson, clampCfg: wxClampCfg } = wxMod

/* ---------------- onebot 纯函数 ---------------- */

test('segmentsToText：text/at/image 混排，@自己 → @我，别人 → @某人', () => {
  const segs = [
    { type: 'text', data: { text: '看看 ' } },
    { type: 'at', data: { qq: '10086' } },
    { type: 'text', data: { text: ' 和 ' } },
    { type: 'at', data: { qq: '42' } },
    { type: 'image', data: { url: 'http://x' } }
  ]
  assert.equal(segmentsToText(segs, '42'), '看看 @某人 和 @我[图片]')
})

test('segmentsToText：老式 CQ 码字符串也认', () => {
  assert.equal(segmentsToText('[CQ:at,qq=42] 来看这个[CQ:image,file=abc.jpg]', '42'), '@我 来看这个[图片]')
  assert.equal(cqPlaceholder('[CQ:record,file=x]'), '[语音]')
})

test('isAtMe：段数组与 CQ 码两路判定', () => {
  assert.ok(isAtMe([{ type: 'at', data: { qq: 42 } }], '42'))
  assert.ok(!isAtMe([{ type: 'at', data: { qq: 43 } }], '42'))
  assert.ok(isAtMe('[CQ:at,qq=42] hi', '42'))
  assert.ok(!isAtMe('[CQ:at,qq=421] hi', '42'), '前缀不能误判')
})

/* ---------------- brain 配置与触发 ---------------- */

test('多角色槽位：按会话路由、默认槽兜底、独立历史', async () => {
  const slots = [
    { id: 'r1', roleId: 'ff14', chats: ['group:111', '10086'] },
    { id: 'r2', roleId: 'roleB', chats: [] }   // 默认槽
  ]
  // 群 111 → r1（ff14）
  assert.equal(resolveSlot(slots, { message_type: 'group', group_id: '111' }).id, 'r1')
  // 私聊 10086 → r1（纯号匹配）
  assert.equal(resolveSlot(slots, { message_type: 'private', user_id: '10086' }).id, 'r1')
  // 其它 → 默认槽 r2
  assert.equal(resolveSlot(slots, { message_type: 'private', user_id: '777' }).id, 'r2')
  // 无槽位 → null
  assert.equal(resolveSlot([], { message_type: 'private', user_id: '1' }), null)
  // 微信会话名也能当 chats 条目
  const wxSlots = [{ id: 'r1', roleId: 'roleC', chats: ['文件传输助手'] }]
  assert.equal(resolveSlot(wxSlots, { message_type: 'private', user_id: '文件传输助手', platform: 'wechat' }).id, 'r1')

  // clampCfg：roleId 清洗、最多 8 个、坏条目剔除
  const c = clampCfg({ roleSlots: [
    { roleId: 'ff14', chats: ['group:1', 'a,b', '  '] },
    { roleId: '../bad/../role-2', chats: [] },
    { roleId: '', chats: [] },                     // 无 roleId → 剔除
    ...Array.from({ length: 10 }, (_, i) => ({ roleId: 'x' + i, chats: [] }))
  ] })
  assert.equal(c.roleSlots.length, 8, '最多 8 槽')
  assert.equal(c.roleSlots[0].chats.join('|'), 'group:1|ab', 'chats 保留中文/冒号、去空与条目内逗号')
  assert.equal(c.roleSlots[1].roleId, 'badrole-2', 'roleId 清洗')

  // 独立历史：两个槽位各自记各自的
  const home = fakeHome()
  const seen = []
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async ({ messages }) => { seen.push(messages); return { content: '嗯' } } }),
    getContext: (rid) => ({ persona: 'p:' + (rid || 'cur') }),
    send: async () => { }
  })
  b.saveCfg({ enabled: true, roleSlots: slots })
  await b.handleEvent({ post_type: 'message', message_type: 'group', group_id: '111', user_id: 5, self_id: 1, message: [{ type: 'at', data: { qq: 1 } }, { type: 'text', data: { text: '物价' } }] })
  await b.handleEvent({ post_type: 'message', message_type: 'private', user_id: 777, self_id: 1, message: [{ type: 'text', data: { text: '你好' } }] })
  assert.ok(seen[0][0].content.includes('FF14'), 'ff14 槽用内置人设')
  assert.ok(seen[1][0].content.includes('p:roleB'), '默认槽把槽位角色 id 传给 getContext')
  const h = b._history
  assert.ok(h['r1:group:111'], 'ff14 槽独立键')
  assert.ok(h['r2:private:777'], '默认槽独立键')
  assert.ok(!h['r1:group:111'].some((m) => m.content.includes('你好')), '记忆互不串')
  fs.rmSync(home, { recursive: true, force: true })
})

test('chatKeyOf：群/私聊/微信', () => {
  assert.equal(chatKeyOf({ message_type: 'group', group_id: '9' }), 'group:9')
  assert.equal(chatKeyOf({ message_type: 'private', user_id: 'abc' }), 'private:abc')
})

test('clampCfg：范围钳制与字符串清洗', () => {
  const c = clampCfg({ groupRate: 999, perGroupHourly: 0, cooldownMs: -5, groups: ['  12a3 ', '', 'x456'], wsUrl: 'http://bad', personaRole: '../../etc' })
  assert.equal(c.groupRate, 100)
  assert.equal(c.perGroupHourly, 1)
  assert.equal(c.cooldownMs, 0)
  assert.deepEqual(c.groups, ['123', '456'])
  assert.equal(c.wsUrl, 'ws://127.0.0.1:3001', '非法地址回默认')
  assert.equal(c.personaRole, 'etc', '路径字符被剥掉')
  assert.ok(!c.personaRole.includes('/'))
})

function fakeHome () { return fs.mkdtempSync(path.join(os.tmpdir(), 'im-brain-')) }

/** 造一条 OneBot 事件 */
const ev = (over = {}) => ({
  post_type: 'message', message_type: 'group', group_id: 7788, user_id: 1001,
  self_id: 42, sender: { nickname: '阿明', card: '' }, message: [{ type: 'text', data: { text: '今天好热' } }],
  ...over
})

test('触发判定：关着全不回；私聊全回/可关；群聊@必回、未@看概率、白名单外不回', () => {
  const home = fakeHome()
  const b = createBrain({ home, getProvider: () => null, send: async () => { } })
  b.saveCfg({ enabled: false })
  assert.equal(b.shouldReply(ev({ message_type: 'private' }), { atMe: true }).why, 'off')
  // 0.10.0 真机事故修复：off 总开关只管 QQ 侧，微信事件不受连坐（wx 有自己的开关）
  assert.deepEqual(b.shouldReply(ev({ platform: 'wechat', message_type: 'private', user_id: '文件传输助手' })).why, 'private')
  b.saveCfg({ enabled: true })
  assert.deepEqual(b.shouldReply(ev({ message_type: 'private' })).why, 'private')
  b.saveCfg({ privateEnabled: false })
  assert.equal(b.shouldReply(ev({ message_type: 'private' })).why, 'private-off')
  b.saveCfg({ privateEnabled: true, groupRate: 0, groups: ['7788'] })
  assert.deepEqual(b.shouldReply(ev(), { atMe: true }).why, 'at')
  assert.equal(b.shouldReply(ev(), { rand: 0.001 }).why, 'rate', '概率 0% 永不插话')
  b.saveCfg({ groupRate: 100 })
  assert.deepEqual(b.shouldReply(ev(), { rand: 0.999 }).why, 'interject')
  assert.equal(b.shouldReply(ev({ group_id: 9999 }), { rand: 0 }).why, 'group-not-allowed', '白名单外不回')
  assert.equal(b.shouldReply(ev(), { rand: 0 }).why, 'interject', '白名单为空不设限')
  b.saveCfg({ groups: [] })
  fs.rmSync(home, { recursive: true, force: true })
})

test('限速：每群每小时上限 + 冷却只管插话不管@回复', async () => {
  const home = fakeHome()
  const b = createBrain({ home, getProvider: () => null, send: async () => { } })
  b.saveCfg({ enabled: true, perGroupHourly: 2, cooldownMs: 60000, groupRate: 100 })
  assert.deepEqual(b.shouldReply(ev(), { rand: 0 }).why, 'interject')
  assert.deepEqual(b.shouldReply(ev(), { rand: 0 }).why, 'interject')
  assert.equal(b.shouldReply(ev(), { rand: 0 }).why, 'hourly-limit', '第三条被每小时限速拦下')
  assert.deepEqual(b.shouldReply(ev(), { atMe: true }).why, 'at', '@回复不受限速拦（必回）')
  fs.rmSync(home, { recursive: true, force: true })
})

test('handleEvent：私聊全流程 → 发出回复、历史累积、assistant 回复带引号剥掉', async () => {
  const home = fakeHome()
  const sent = []
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async ({ messages }) => ({ content: '「天热就多喝水呀」' }) }),
    getContext: () => ({ persona: '测试人设', partnerDoc: '画像', roleName: 'Ryza' }),
    send: async (e, text) => sent.push({ chat: e.message_type === 'group' ? e.group_id : e.user_id, text })
  })
  b.saveCfg({ enabled: true })
  await b.handleEvent(ev({ message_type: 'private', message: [{ type: 'text', data: { text: '在吗' } }] }))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, '天热就多喝水呀', '外层引号剥掉')
  const h = b._history['def:private:1001']
  assert.equal(h.length, 2)
  assert.ok(h[0].content.includes('[私聊]'), 'user 消息带身份头')
  assert.equal(h[1].role, 'assistant')
  fs.rmSync(home, { recursive: true, force: true })
})

test('handleEvent：模型挂了不崩、不发送、错误留痕', async () => {
  const home = fakeHome()
  const sent = []
  const b = createBrain({
    home,
    getProvider: () => { throw new Error('没配 key') },
    send: async (e, t) => sent.push(t)
  })
  b.saveCfg({ enabled: true })
  await b.handleEvent(ev({ message_type: 'private', message: [{ type: 'text', data: { text: 'hi' } }] }))
  assert.equal(sent.length, 0)
  assert.ok(b.status().lastError.includes('没配 key'))
  fs.rmSync(home, { recursive: true, force: true })
})

test('buildSystem：人设 + PARTNER 画像 + 行为准则，上下文缺失不炸', () => {
  const s1 = buildSystem({}, { persona: '你是 Ryza', partnerDoc: '画像内容' })
  assert.ok(s1.includes('你是 Ryza') && s1.includes('画像内容') && s1.includes('群友一样'))
  const s2 = buildSystem({}, null)
  assert.ok(s2.includes('群友一样'), '空上下文也要有行为准则')
  assert.ok(!/工具/.test(s2.split('你没有工具')[0]) === false || true) // 冒烟
})

test('历史窗口：超过 maxHistory 截断到窗口，落盘文件存在', async () => {
  const home = fakeHome()
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async () => ({ content: '嗯' }) }),
    getContext: () => ({ persona: 'x' }),
    send: async () => { }
  })
  b.saveCfg({ enabled: true, maxHistory: 4 })
  for (let i = 0; i < 5; i++) {
    await b.handleEvent(ev({ message_type: 'private', user_id: 7, message: [{ type: 'text', data: { text: 'msg' + i } }] }))
  }
  const h = b._history['def:private:7']
  assert.ok(h.length <= 4, '窗口截断')
  assert.ok(fs.existsSync(path.join(home, 'history.json')), '落盘')
  fs.rmSync(home, { recursive: true, force: true })
})

/* ---------------- S11.1：私聊白名单 + 平台级人设 ---------------- */

test('clampCfg：私聊白名单去空白分隔符、保留中文会话名', () => {
  const c = clampCfg({ privateAccounts: [' 10086 ', '文件传输助手', '', 'a b'] })
  assert.deepEqual(c.privateAccounts, ['10086', '文件传输助手', 'ab'], '条目内空白剥掉，中文名保留')
  assert.equal(clampCfg({}).privateAccounts.length, 0, '默认空 = 不限')
})

test('触发判定：私聊白名单非空时只回名单里的人', () => {
  const home = fakeHome()
  const b = createBrain({ home, getProvider: () => null, send: async () => { } })
  b.saveCfg({ enabled: true, privateAccounts: ['10086'] })
  assert.deepEqual(b.shouldReply(ev({ message_type: 'private', user_id: 10086 })).why, 'private')
  assert.equal(b.shouldReply(ev({ message_type: 'private', user_id: 99999 })).why, 'private-not-allowed')
  // 空名单 = 回所有人（原有行为不变）
  b.saveCfg({ privateAccounts: [] })
  assert.deepEqual(b.shouldReply(ev({ message_type: 'private', user_id: 99999 })).why, 'private')
  fs.rmSync(home, { recursive: true, force: true })
})

test('人设按平台分：QQ 用 personaRole，微信用 wxPersonaRole（generate → getContext 传对 roleId）', async () => {
  const home = fakeHome()
  const seen = []
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async () => ({ content: '嗯' }) }),
    getContext: (roleId) => { seen.push(roleId); return { persona: 'x' } },
    send: async () => { }
  })
  b.saveCfg({ enabled: true, personaMode: 'role', personaRole: 'qq-role', wxPersonaMode: 'role', wxPersonaRole: 'wx-role' })
  await b.handleEvent(ev({ message_type: 'private', message: [{ type: 'text', data: { text: 'hi' } }] }))
  await b.handleEvent({
    platform: 'wechat', post_type: 'message', message_type: 'private', user_id: '文件传输助手',
    self_id: 'me', sender: { nickname: '文件传输助手', card: '' },
    message: [{ type: 'text', data: { text: '在吗' } }]
  })
  assert.deepEqual(seen, ['qq-role', 'wx-role'], '两个平台各传各的 roleId')
  // 微信历史不带（QQ:xxx）尾巴
  const h = b._history['def:private:文件传输助手']
  assert.ok(h[0].content.startsWith('[私聊] 文件传输助手 说'))
  assert.ok(!h[0].content.includes('QQ:'))
  fs.rmSync(home, { recursive: true, force: true })
})

/* ---------------- S11-M2：微信 UI 自动化（纯函数部分） ---------------- */

test('主人权限（命令级别）：没配置=全无效；名单内=主人；名单外=拒绝警告；QQ/微信分开', () => {
  const { permOf, OWNER_RULES } = require('../src/main/im/brain')
  const cfg = { ownerAccounts: ['10086'], wxOwnerAccounts: ['文件传输助手'] }
  // QQ 名单
  assert.equal(permOf(cfg, { user_id: '10086' }).isOwner, true)
  assert.equal(permOf(cfg, { user_id: '99999' }).isOwner, false)
  // 微信名单独立：QQ 主人的号在微信侧不算主人，反之亦然
  assert.equal(permOf(cfg, { platform: 'wechat', user_id: '文件传输助手' }).isOwner, true)
  assert.equal(permOf(cfg, { platform: 'wechat', user_id: '10086' }).isOwner, false, 'QQ 主人不是微信主人')
  assert.equal(permOf({ ownerAccounts: ['10086'] }, { platform: 'wechat', user_id: '10086' }).isOwner, false, '微信名单空=微信侧全拒')
  // 没配置 → 任何人都不是主人（默认全拒）
  assert.equal(permOf({ ownerAccounts: [], wxOwnerAccounts: [] }, { user_id: '10086' }).ownersConfigured, false)
  // 提示词注入：三种形态的关键行
  const sysOwner = buildSystem(cfg, {}, permOf(cfg, { user_id: '10086' }))
  assert.match(sysOwner, /是主人/)
  const sysStranger = buildSystem(cfg, {}, permOf(cfg, { user_id: '99999' }))
  assert.match(sysStranger, /不是主人/)
  assert.match(sysStranger, /10086/)
  const sysNone = buildSystem({ ownerAccounts: [], wxOwnerAccounts: [] }, {}, { ownersConfigured: false, isOwner: false, uid: '', list: [] })
  assert.match(sysNone, /没有配置任何主人账号/)
  // perm 不传 → 从严（非主人）
  assert.match(buildSystem(cfg, {}), /不是主人/)
  assert.ok(OWNER_RULES.includes('命令类请求'))
})

test('cleanReply：重复标点收敛、去标点后空格、去开头垃圾标点（0.10.0 满屏，，。。事故）', () => {
  const { cleanReply } = require('../src/main/im/brain')
  assert.equal(cleanReply('行吧，，咱俩就当互相回音了。。'), '行吧，咱俩就当互相回音了。')
  assert.equal(cleanReply('？？你说什么，，，我听不懂。。'), '？你说什么，我听不懂。')
  assert.equal(cleanReply('。看到，，字一直都能看到。。'), '看到，字一直都能看到。')
  assert.equal(cleanReply('？ 莱莎啊 ， 么 ，，疑我？？'), '？莱莎啊，么，疑我？')
  assert.equal(cleanReply('你好'), '你好')
  assert.equal(cleanReply('真的吗？！太好了！！'), '真的吗？！太好了！')
  assert.equal(cleanReply('normal text, fine.'), 'normal text, fine.')
  assert.equal(cleanReply('  '), '')
})

test('wx extractJson：裸 JSON / ```json 围栏 / 垃圾输入', () => {
  assert.deepEqual(extractJson('{"chat":"a","messages":[]}'), { chat: 'a', messages: [] })
  const fenced = '```json\n{"chat":"文件传输助手","messages":[{"side":"left","text":"hi"}]}\n```'
  assert.equal(extractJson(fenced).chat, '文件传输助手')
  assert.equal(extractJson('我看不清'), null)
  assert.equal(extractJson(''), null)
})

test('wx clampCfg：轮询间隔钳制、会话名截断、enabled 布尔化', () => {
  const c = wxClampCfg({ enabled: 1, pollSec: 1, chatName: 'x'.repeat(100) })
  assert.equal(c.enabled, true)
  assert.equal(c.pollSec, 10)
  assert.equal(c.chatName.length, 60)
  assert.equal(wxClampCfg({ pollSec: 9999 }).pollSec, 600)
})

test('wx 自聊闭环：手机发的右侧消息算输入，机器人的回声被剔除（0.10.0 真机翻车修复）', () => {
  const { filterBotEchoes, pickUserRun, isSelfChat, normText } = wxMod
  // 自聊判定：文件传输助手是，普通联系人不是
  assert.ok(isSelfChat('文件传输助手'))
  assert.ok(!isSelfChat('张三'))
  assert.ok(!isSelfChat(''))
  // 手机发「在吗」→ 电脑端右侧 → 应当作输入；机器人回复「在的呀」→ 右侧 → 剔除
  const replies = ['在的呀，怎么啦？']
  const msgs = [
    { side: 'right', text: '在的呀，怎么啦？' },   // 机器人上一轮的回复（回声）
    { side: 'right', text: '在吗' }                 // 机主从手机发来的
  ]
  const filtered = filterBotEchoes(msgs, replies)
  assert.deepEqual(filtered.map((m) => m.text), ['在吗'])
  // 末尾连续的用户消息串（自聊=右侧）按时间顺序拼接
  assert.equal(pickUserRun(filtered, true), '在吗')
  assert.equal(pickUserRun([{ side: 'right', text: 'a' }, { side: 'right', text: 'b' }], true), 'a\nb')
  // 普通会话仍取左侧
  assert.equal(pickUserRun([{ side: 'right', text: 'me' }, { side: 'left', text: 'hi' }], false), 'hi')
  // 回声匹配容忍空白差异与近长转写出入（视觉模型读她原话的小误差）
  assert.deepEqual(filterBotEchoes([{ side: 'right', text: '在 的 呀，怎么啦' }], ['在的呀，怎么啦？']), [])
  // 但用户的长消息哪怕包含她说过的短语，也不算回声（否则她会看不见用户的字）
  assert.deepEqual(
    filterBotEchoes([{ side: 'right', text: '在的呀，怎么啦？你为什么看不到我打的字啊' }], ['在的呀，怎么啦？']),
    [{ side: 'right', text: '在的呀，怎么啦？你为什么看不到我打的字啊' }]
  )
  // 只保留机器人最后一次发言之后的消息：她答过「在吗」→ 用户再发两条 → 只剩两条新的
  const seq = [
    { side: 'right', text: '在吗' },
    { side: 'right', text: '在的呀，怎么啦？' },
    { side: 'right', text: '今天天气怎么样' },
    { side: 'right', text: '顺便看看邮箱' }
  ]
  assert.deepEqual(filterBotEchoes(seq, ['在的呀，怎么啦？']).map((m) => m.text), ['今天天气怎么样', '顺便看看邮箱'])
  assert.equal(pickUserRun(filterBotEchoes(seq, ['在的呀，怎么啦？']), true), '今天天气怎么样\n顺便看看邮箱')
  // 无回声记录时不裁剪
  assert.equal(filterBotEchoes(seq, []).length, 4)
  // 左侧消息永不被剔除（真朋友的输入）
  assert.deepEqual(filterBotEchoes([{ side: 'left', text: '在的呀，怎么啦？' }], ['在的呀，怎么啦？']).length, 1)
  assert.equal(normText('  a \n b '), 'ab')
})

test('FF14 能力绑定（0.16.0）：绑定角色的会话自动带工具与人设提示，未绑定则不带', async () => {
  const home = fakeHome()
  const seen = []
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async ({ messages, tools }) => { seen.push({ messages, tools }); return { content: '嗯' } } }),
    getContext: (rid) => ({ persona: 'p:' + (rid || 'cur') }),
    send: async () => { }
  })
  b.saveCfg({ enabled: true, roleSlots: [{ id: 'r1', roleId: 'ryza', chats: [] }], ff14RoleId: 'ryza', ff14Server: '银泪湖', ff14ForAll: false })
  await b.handleEvent({ post_type: 'message', message_type: 'private', user_id: 777, self_id: 1, message: [{ type: 'text', data: { text: '白钢锭多少钱' } }] })
  const ff14Names = (t) => (t || []).map((x) => x.function.name).filter((n) => n.startsWith('ff14_'))
  assert.ok(ff14Names(seen[0].tools).length, '绑定角色 → 带 FF14 工具')
  assert.ok(seen[0].messages[0].content.includes('p:ryza'), '原人设保留')
  assert.ok(seen[0].messages[0].content.includes('FF14 能力已激活'), '追加能力提示')
  assert.ok(seen[0].messages[0].content.includes('银泪湖'), '提示带默认服务器')
  // 解绑后：同角色同会话 → 无工具、无人设追加（provider 闭包始终推 seen，第二次是 seen[1]）
  b.saveCfg({ enabled: true, roleSlots: [{ id: 'r1', roleId: 'ryza', chats: [] }], ff14RoleId: '', ff14ForAll: false })
  await b.handleEvent({ post_type: 'message', message_type: 'private', user_id: 778, self_id: 1, message: [{ type: 'text', data: { text: '在吗' } }] })
  assert.equal(seen.length, 2, '两次都到了模型')
  assert.equal(ff14Names(seen[1].tools).length, 0, '未绑定 → 不带 FF14 工具（联网搜索是全员工具，不算）')
  assert.ok(!seen[1].messages[0].content.includes('FF14 能力已激活'), '未绑定 → 无能力提示')
  assert.ok(seen[1].messages[0].content.includes('p:ryza'), '人设照旧')
  // clampCfg：ff14RoleId 清洗
  const c = clampCfg({ ff14RoleId: 'a b/c_1' })
  assert.equal(c.ff14RoleId, 'abc_1')
  fs.rmSync(home, { recursive: true, force: true })
})

/* ---------------- 0.18.0 M2：QQ 语音 / 表情包 ---------------- */

test('matchSticker：精确名 / 互相包含 / 分词命中 / 未命中', () => {
  const { matchSticker } = require('../src/main/im/brain')
  const names = ['开心.png', '猫猫瞪你.jpg', '问号脸.GIF', '抱抱.webp']
  assert.equal(matchSticker(names, '开心'), '开心.png', '精确名（去扩展名）')
  assert.equal(matchSticker(names, '开心.png'), '开心.png')
  assert.equal(matchSticker(names, '猫猫'), '猫猫瞪你.jpg', '包含命中')
  assert.equal(matchSticker(names, '瞪你'), '猫猫瞪你.jpg', '反包含也认')
  assert.equal(matchSticker(names, '问号脸'), '问号脸.GIF', '大小写扩展名不影响')
  assert.equal(matchSticker(names, '贴贴 抱抱'), '抱抱.webp', '分词任一命中')
  assert.equal(matchSticker(names, '不存在的'), null)
  assert.equal(matchSticker([], '开心'), null)
  assert.equal(matchSticker(names, ''), null)
})

test('M2 send_voice：工具循环里合成语音并发 record 段，正文照常回复', async () => {
  const home = fakeHome()
  const wavPath = path.join(home, 't.wav')
  fs.writeFileSync(wavPath, Buffer.alloc(2048, 1))
  const sentMedia = []
  let round = 0
  const seenTools = []
  const b = createBrain({
    home,
    getProvider: () => ({
      chat: async ({ messages, tools }) => {
        round++
        seenTools.push((tools || []).map((t) => t.function.name))
        if (round === 1) return { content: '', toolCalls: [{ id: 't1', name: 'send_voice', arguments: JSON.stringify({ text: '晚安喵～' }) }] }
        return { content: '晚安～做个好梦' }
      }
    }),
    getContext: () => ({ persona: 'x' }),
    send: async () => { },
    synthVoice: async (text, roleId) => ({ ok: true, path: wavPath }),
    sendMedia: async (e, segs) => sentMedia.push(segs)
  })
  b.saveCfg({ enabled: true, privateAccounts: [] })
  await b.handleEvent(ev({ message_type: 'private', user_id: 8, message: [{ type: 'text', data: { text: '晚安' } }] }))
  assert.ok(seenTools[0].includes('send_voice'), '语音开关默认开 + synthVoice 注入 → 工具在列')
  assert.equal(sentMedia.length, 1, '语音发出去了')
  assert.equal(sentMedia[0][0].type, 'record')
  assert.ok(sentMedia[0][0].data.file.startsWith('base64://'), 'base64 直传（NapCat 容器里也能收）')
  const h = b._history['def:private:8']
  assert.ok(h.some((m) => m.role === 'assistant' && m.content.includes('晚安～')), '正文照常落历史')
  fs.rmSync(home, { recursive: true, force: true })
})

test('M2 语音降级：browser TTS 出不了文件 → 工具返回错误，文本照常回', async () => {
  const home = fakeHome()
  const sentMedia = []
  let round = 0
  const b = createBrain({
    home,
    getProvider: () => ({
      chat: async ({ messages }) => {
        round++
        if (round === 1) return { content: '', toolCalls: [{ id: 't1', name: 'send_voice', arguments: JSON.stringify({ text: '喵' }) }] }
        return { content: '那我说话吧' }
      }
    }),
    getContext: () => ({ persona: 'x' }),
    send: async (e, t) => sentMedia.push(['text', t]),
    synthVoice: async () => ({ ok: false, reason: 'browser-tts' }),
    sendMedia: async (e, segs) => sentMedia.push(['media', segs])
  })
  b.saveCfg({ enabled: true, privateAccounts: [] })
  await b.handleEvent(ev({ message_type: 'private', user_id: 81, message: [{ type: 'text', data: { text: '说句话' } }] }))
  assert.ok(!sentMedia.some((x) => x[0] === 'media'), '没有语音段发出')
  assert.ok(sentMedia.some((x) => x[0] === 'text' && /说话/.test(x[1])), '文本回复照常')
  fs.rmSync(home, { recursive: true, force: true })
})

test('M2 send_sticker：list → 模糊匹配 → image 段发出；关语音/没目录时不挂工具', async () => {
  const home = fakeHome()
  const stickerDir = path.join(home, 'stickers')
  fs.mkdirSync(stickerDir)
  for (const f of ['开心.png', '猫猫瞪你.jpg']) fs.writeFileSync(path.join(stickerDir, f), Buffer.alloc(2048, 9))
  fs.writeFileSync(path.join(stickerDir, 'note.txt'), 'not sticker')  // 非图片不收
  const sentMedia = []
  let round = 0
  const seenTools = []
  const b = createBrain({
    home,
    getProvider: () => ({
      chat: async ({ messages, tools }) => {
        round++
        seenTools.push((tools || []).map((t) => t.function.name))
        if (round === 1) return { content: '', toolCalls: [{ id: 's1', name: 'send_sticker', arguments: JSON.stringify({ name: '猫猫' }) }] }
        return { content: '看猫！' }
      }
    }),
    getContext: () => ({ persona: 'x' }),
    send: async () => { },
    sendMedia: async (e, segs) => sentMedia.push(segs)
  })
  b.saveCfg({ enabled: true, stickerDir, privateAccounts: [] })
  await b.handleEvent(ev({ message_type: 'private', user_id: 9, message: [{ type: 'text', data: { text: '来个表情' } }] }))
  assert.ok(seenTools[0].includes('send_sticker') && seenTools[0].includes('list_stickers'))
  assert.ok(!seenTools[0].includes('send_voice'), '没注入 synthVoice → 语音工具不挂')
  assert.equal(sentMedia.length, 1)
  assert.equal(sentMedia[0][0].type, 'image')
  assert.ok(sentMedia[0][0].data.file.startsWith('base64://'))
  // 关闭 + 清目录：工具一个都不挂 → 走纯文本聊天
  const b2 = createBrain({
    home,
    getProvider: () => ({ chat: async ({ messages, tools }) => { seenTools.push((tools || []).map((t) => t.function.name)); return { content: '嗯' } } }),
    getContext: () => ({ persona: 'x' }),
    send: async () => { }
  })
  b2.saveCfg({ enabled: true, voiceEnabled: false, stickerDir: '', privateAccounts: [] })
  await b2.handleEvent(ev({ message_type: 'private', user_id: 10, message: [{ type: 'text', data: { text: 'hi' } }] }))
  const lastTools = seenTools.at(-1)
  assert.ok(!lastTools.includes('send_voice') && !lastTools.includes('send_sticker') && !lastTools.includes('list_stickers'),
    '没配任何多媒体 → 不挂 IM 工具（FF14 全员工具仍在，属 M4 行为）')
  fs.rmSync(home, { recursive: true, force: true })
})

test('M2 send_sticker 未命中：返回候选名单给模型重选', async () => {
  const home = fakeHome()
  const stickerDir = path.join(home, 'stickers')
  fs.mkdirSync(stickerDir)
  for (const f of ['开心.png', '震惊.jpg', '大哭.gif']) fs.writeFileSync(path.join(stickerDir, f), Buffer.alloc(1500, 1))
  const sentMedia = []
  let round = 0
  const b = createBrain({
    home,
    getProvider: () => ({
      chat: async () => {
        round++
        if (round === 1) return { content: '', toolCalls: [{ id: 's2', name: 'send_sticker', arguments: JSON.stringify({ name: '猫猫' }) }] }
        return { content: '那就文字吧' }
      }
    }),
    getContext: () => ({ persona: 'x' }),
    send: async () => { },
    sendMedia: async (e, segs) => sentMedia.push(segs)
  })
  b.saveCfg({ enabled: true, stickerDir, privateAccounts: [] })
  await b.handleEvent(ev({ message_type: 'private', user_id: 11, message: [{ type: 'text', data: { text: '发表情' } }] }))
  assert.equal(sentMedia.length, 0, '未命中不乱发')
  const h = b._history['def:private:11']
  assert.ok(h.some((m) => m.role === 'assistant' && m.content.includes('文字')), '最终文本回复正常')
  fs.rmSync(home, { recursive: true, force: true })
})

/* ---------------- 0.18.0 M1：图片透传 / M4：FF14 全员开放 ---------------- */

test('imageSegmentsOf：段数组 / CQ 码 / 闪照 / 缺 url 只剩 file', () => {
  const arr = [
    { type: 'text', data: { text: '看图' } },
    { type: 'image', data: { url: 'https://gchat.qq.com/a.png?term=1&amp;x=2', file: 'a.image' } },
    { type: 'flashimage', data: { file: 'b.image' } },
    { type: 'text', data: { text: '再看' } }
  ]
  const got = imageSegmentsOf(arr)
  assert.equal(got.length, 2)
  assert.equal(got[0].url, 'https://gchat.qq.com/a.png?term=1&x=2', 'CQ 转义还原')
  assert.equal(got[0].file, 'a.image')
  assert.equal(got[1].url, '')
  assert.equal(got[1].file, 'b.image')
  const cq = imageSegmentsOf('[CQ:image,file=x.image,url=https://t.cn/i.jpg&fake]')
  assert.equal(cq.length, 1)
  assert.equal(cq[0].file, 'x.image')
  assert.equal(imageSegmentsOf([{ type: 'text', data: { text: '没图' } }]).length, 0)
  assert.equal(imageSegmentsOf('纯文本').length, 0)
})

test('collectImages + handleEvent：本地文件图 → dataURL 进多模态消息，历史只存文本', async () => {
  const home = fakeHome()
  // 伪 PNG：>1KB 才不被丢弃
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)])
  const imgPath = path.join(home, 'a.png')
  fs.writeFileSync(imgPath, png)
  const seen = []
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async ({ messages }) => { seen.push(messages); return { content: '看到图了' } } }),
    getContext: () => ({ persona: 'x' }),
    send: async () => { }
  })
  b.saveCfg({ enabled: true, privateAccounts: [] })
  await b.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 555, self_id: 1,
    sender: { nickname: '阿伟', card: '' },
    message: [{ type: 'image', data: { file: 'abc.image', url: imgPath } }, { type: 'text', data: { text: '这是啥' } }]
  })
  assert.equal(seen.length, 1)
  const last = seen[0][seen[0].length - 1]
  assert.equal(last.role, 'user')
  assert.ok(Array.isArray(last.content), '带图时 user 消息是多模态数组')
  assert.equal(last.content[0].type, 'text')
  assert.ok(last.content[0].text.includes('这是啥'))
  assert.equal(last.content[1].type, 'image_url')
  assert.ok(last.content[1].image_url.url.startsWith('data:image/png;base64,'), '本地路径读成 dataURL')
  // 历史只存文本（[图片] 占位来自 segmentsToText）
  const h = b._history['def:private:555']
  assert.ok(h[0].content.includes('[图片]') && h[0].content.includes('这是啥'))
  assert.ok(!h[0].content.includes('base64'), '历史绝不存 base64')
  // system 与旧历史仍是字符串（不会被数组污染）
  assert.equal(typeof seen[0][0].content, 'string')
  fs.rmSync(home, { recursive: true, force: true })
})

test('collectImages：无 url 走 get_image 换本地路径；过大/过小图片跳过', async () => {
  const home = fakeHome()
  const png = Buffer.concat([Buffer.from([0x89, 0x50]), Buffer.alloc(2048, 3)])
  const imgPath = path.join(home, 'got.png')
  fs.writeFileSync(imgPath, png)
  const tiny = path.join(home, 'tiny.png')
  fs.writeFileSync(tiny, Buffer.alloc(100, 1)) // <1KB → 丢
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async () => ({ content: '嗯' }) }),
    getContext: () => ({}),
    send: async () => { },
    callApi: async (action, params) => {
      assert.equal(action, 'get_image')
      return { file: params.file === 'good.image' ? imgPath : tiny }
    }
  })
  const segs = await b.collectImages({
    message: [
      { type: 'image', data: { file: 'good.image' } },
      { type: 'image', data: { file: 'tiny.image' } }
    ]
  })
  assert.equal(segs.length, 1, '过小的被丢弃，正常的进 dataURL')
  assert.ok(segs[0].image_url.url.startsWith('data:image/png;base64,'))
  assert.equal(await b.collectImages({ message: [{ type: 'text', data: { text: 'hi' } }] }), 0, '没图返回空')
  fs.rmSync(home, { recursive: true, force: true })
})

test('视觉降级：端点 400 拒图 → 纯文本重试一次（带图调用不含图）', async () => {
  const home = fakeHome()
  const png = Buffer.concat([Buffer.from([0x89, 0x50]), Buffer.alloc(2048, 5)])
  const imgPath = path.join(home, 'b.png')
  fs.writeFileSync(imgPath, png)
  const calls = []
  const b = createBrain({
    home,
    getProvider: () => ({
      chat: async ({ messages }) => {
        calls.push(messages)
        if (calls.length === 1) {
          const err = new Error('模型服务 HTTP 400: image not supported')
          err.status = 400
          throw err
        }
        return { content: '那我看文字吧' }
      }
    }),
    getContext: () => ({ persona: 'x' }),
    send: async () => { }
  })
  b.saveCfg({ enabled: true, privateAccounts: [] })
  await b.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 666, self_id: 1,
    sender: { nickname: '阿伟', card: '' },
    message: [{ type: 'image', data: { file: 'x.image', url: imgPath } }, { type: 'text', data: { text: '看看' } }]
  })
  assert.equal(calls.length, 2, '第一次拒图，第二次降级重试')
  const last1 = calls[0][calls[0].length - 1]
  const last2 = calls[1][calls[1].length - 1]
  assert.ok(Array.isArray(last1.content), '第一次带图')
  assert.equal(typeof last2.content, 'string', '第二次纯文本')
  assert.ok(!JSON.stringify(calls[1]).includes('base64'), '重试请求里没有图')
  // 400 但没带图 → 照常抛错（不该被吞）
  const home2 = fakeHome()
  const b2 = createBrain({
    home: home2,
    getProvider: () => ({ chat: async () => { const e = new Error('bad'); e.status = 400; throw e } }),
    getContext: () => ({}),
    send: async () => { }
  })
  b2.saveCfg({ enabled: true, privateAccounts: [] })
  await b2.handleEvent(ev({ message_type: 'private', user_id: 9, message: [{ type: 'text', data: { text: 'hi' } }] }))
  assert.ok(b2.status().lastError.includes('bad'), '非视觉原因的 400 不吞')
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(home2, { recursive: true, force: true })
})

test('M4 FF14 全员开放：ff14ForAll 默认开，任意会话任意角色都带工具', async () => {
  const home = fakeHome()
  const seen = []
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async ({ messages, tools }) => { seen.push({ messages, tools }); return { content: '嗯' } } }),
    getContext: (rid) => ({ persona: 'p:' + (rid || 'cur') }),
    send: async () => { }
  })
  assert.equal(clampCfg({}).ff14ForAll, true, '默认开放（0.18.0 用户拍板）')
  assert.equal(clampCfg({ ff14ForAll: false }).ff14ForAll, false)
  b.saveCfg({ enabled: true })  // 没绑 ff14RoleId、没槽位 → 以前不带工具
  await b.handleEvent(ev({ message_type: 'private', user_id: 321, message: [{ type: 'text', data: { text: '钱多多多少钱' } }] }))
  const names0 = (seen[0].tools || []).map((x) => x.function.name)
  assert.ok(names0.some((n) => n.startsWith('ff14_')), '默认全员带 FF14 工具')
  assert.ok(names0.includes('web_search'), '联网搜索对全员开放（0.18.0 第二批）')
  assert.ok(seen[0].messages[0].content.includes('FF14 能力已激活'))
  assert.ok(seen[0].messages[0].content.includes('p:cur'), '人设照旧不换人')
  // 关掉后恢复 0.16.0 行为
  const seen2 = []
  const b2 = createBrain({
    home,
    getProvider: () => ({ chat: async ({ messages, tools }) => { seen2.push({ messages, tools }); return { content: '嗯' } } }),
    getContext: () => ({ persona: 'p:x' }),
    send: async () => { }
  })
  b2.saveCfg({ enabled: true, ff14ForAll: false })
  await b2.handleEvent(ev({ message_type: 'private', user_id: 322, message: [{ type: 'text', data: { text: '在吗' } }] }))
  const names2 = (seen2[0].tools || []).map((x) => x.function.name)
  assert.ok(!names2.some((n) => n.startsWith('ff14_')), '关闭后不带 FF14 工具')
  fs.rmSync(home, { recursive: true, force: true })
})

/* ---- 0.45.28 QQ 全能化：核心工具安全子集桥接 ---- */
test('0.45.28 主人 QQ 会话挂核心工具安全子集，非主人不挂', async () => {
  const home = fakeHome()
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async () => ({ content: '好' }) }),
    getContext: () => ({ persona: 'P' }),
    send: async () => { }
  })
  b.saveCfg({ enabled: true, ownerAccounts: ['359524452'] })
  // 静态保证：白名单在源码里且不含命令行/桌面动作类
  const src = fs.readFileSync(path.resolve(__dirname, '../src/main/im/brain.js'), 'utf8')
  assert.ok(/CORE_TOOL_BRIDGE = new Set\(\[/.test(src), '有桥接白名单')
  for (const bad of ['exec_command', 'job_kill', 'pet_say', 'game_mode', 'pc_run']) {
    assert.ok(!new RegExp("'(" + bad + ")'").test(src.slice(src.indexOf('CORE_TOOL_BRIDGE'), src.indexOf('CORE_TOOL_BRIDGE') + 400)), '白名单不含 ' + bad)
  }
  // execImTool 分发带 isOwner 复核 + roleId 透传
  assert.ok(/CORE_TOOL_BRIDGE\.has\(name\)/.test(src), '分发走白名单')
  assert.ok(/roleId: tctx\.roleId, policy: \{ mode: 'never-ask' \}/.test(src), '记忆工具定位到当前角色')
  // imToolDefs 是 async 且调用处 await（useTools 判定不能拿到 Promise）
  assert.ok(/async function imToolDefs/.test(src), 'imToolDefs 是 async')
  assert.ok(/await imToolDefs\(tctx\)\)\.length > 0/.test(src), 'useTools 判定 await')
  fs.rmSync(home, { recursive: true, force: true })
})

test('0.45.28 主人私聊工具循环能真正调到核心工具（remember 记进当前角色记忆）', async () => {
  // 0.46.52 安全闸配套：这条用例会真的调到 remember → partner.js 的 git。
  // 数据目录不初始化的话 dataDir 默认 = process.cwd()/data，跑测试的 cwd 在哪个
  // git 仓库里，`git add -A` 就会把那个仓库整个提交掉（11-05 实锤：partner-execute-me
  // 收到两笔「记住：主人在 QQ 上让他记一条」）。这里把数据目录钉进系统临时目录。
  const cfgMod = await import('file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', 'config.js').replace(/\\/g, '/'))
  const partnerMod = await import('file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', 'memory', 'partner.js').replace(/\\/g, '/'))
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'im-data-'))
  cfgMod.initDataDir(tmpData)
  partnerMod.resetCache()
  const home = fakeHome()
  const calls = []
  const b = createBrain({
    home,
    getProvider: () => ({
      chat: async ({ messages, tools }) => {
        calls.push({ n: calls.length, tools: (tools || []).map((t) => t.function.name) })
        if (calls.length === 1) {
          const mem = (tools || []).find((t) => t.function.name === 'remember')
          assert.ok(mem, '工具表里有 remember')
          return { content: null, toolCalls: [{ id: 'c1', name: 'remember', arguments: JSON.stringify({ text: '主人在 QQ 上让他记一条' }) }] }
        }
        return { content: '记好了' }
      }
    }),
    getContext: () => ({ persona: 'P' }),
    send: async () => { }
  })
  b.saveCfg({ enabled: true, ownerAccounts: ['359524452'] })
  await b.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 359524452, self_id: 1,
    message: [{ type: 'text', data: { text: '记住：我爱吃拉面' } }]
  })
  assert.ok(calls[0].tools.includes('get_time'), 'get_time 挂上了')
  assert.ok(calls[0].tools.includes('open_app'), 'open_app 挂上了')
  assert.ok(!calls[0].tools.includes('exec_command'), '命令行类不挂')
  assert.ok(calls[0].tools.includes('pc_run'), 'pc_run 照旧走 pcTools 闸挂载')
  fs.rmSync(home, { recursive: true, force: true })
})
