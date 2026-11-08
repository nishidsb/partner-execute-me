/**
 * 0.45.99 长期记忆「只记主人」闸。
 *
 * 背景（用户 11-02）：「这个我只是自己用的，不是还有主人账号吗」——
 * 主人名单原来只管「命令权限」，不管「谁说的话算事实」。于是群友 @ 她一句
 * 「我明天考试」、白名单里别人的号私聊她，都会被本地规则提取成 imp5 的约定。
 *
 * 这一版把 isOwner 从 permOf 一路带到 onMemoryTurn：非主人照常聊，但不入长期记忆。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createBrain } = require('../src/main/im/brain')

function fakeHome () { return fs.mkdtempSync(path.join(os.tmpdir(), 'im-memgate-')) }

test('记忆闸：群友 @ 她照常回但不记账；主人私聊照记', async () => {
  const home = fakeHome()
  const calls = []
  const said = []
  const b = createBrain({
    home,
    getProvider: () => ({ chat: async () => ({ content: '嗯，知道了' }) }),
    getContext: () => ({}),
    send: async (ev, text) => { said.push(text) },
    onMemoryTurn: (roleId, u, r, meta) => { calls.push({ u, isOwner: meta && meta.isOwner, group: meta && meta.group }) }
  })
  b.saveCfg({ enabled: true, privateEnabled: true, ownerAccounts: ['10001'], groupRate: 100 })

  // ① 群里别人 @ 她：「我明天考试」——回，但 meta.isOwner=false
  await b.handleEvent({
    post_type: 'message', message_type: 'group', group_id: 7788, user_id: 1001, self_id: 42,
    sender: { nickname: '群友', card: '' },
    message: [{ type: 'at', data: { qq: 42 } }, { type: 'text', data: { text: '我明天考试' } }]
  })
  // ② 主人私聊：同一句话——meta.isOwner=true
  await b.handleEvent({
    post_type: 'message', message_type: 'private', user_id: 10001, self_id: 42,
    sender: { nickname: 'Usuchu', card: '' },
    message: [{ type: 'text', data: { text: '我明天考试' } }]
  })

  assert.equal(said.length, 2, '两轮都要回话（闸只管记忆，不拦聊天）')
  assert.equal(calls.length, 2, 'onMemoryTurn 两轮都会调，闸在宿主侧判')
  assert.equal(calls[0].isOwner, false, '群友 → 不算主人')
  assert.equal(calls[0].group, true, '群聊标记带出去')
  assert.equal(calls[1].isOwner, true, '主人私聊 → isOwner=true')
  assert.equal(calls[1].group, false, '私聊标记')

  fs.rmSync(home, { recursive: true, force: true })
})

test('记忆闸：宿主收到 isOwner=false 直接 return，不碰 memoryExtract', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/im/index.js'), 'utf8')
  const block = (src.match(/onMemoryTurn: \((?:[^)]*)\) => \{[\s\S]*?\n    \},/) || [])[0] || ''
  assert.ok(block, '找得到 onMemoryTurn 实现')
  assert.ok(/if \(meta && meta\.isOwner === false\) return/.test(block), '非主人直接跳过')
  assert.ok(/memoryExtract/.test(block), '主人仍然提取')
  // brain 侧确实把 isOwner 传出去了（不是只加了形参）
  const brain = fs.readFileSync(path.join(__dirname, '../src/main/im/brain.js'), 'utf8')
  assert.ok(/onMemoryTurn\(roleId, text, reply, \{[\s\S]*?isOwner: !!perm\.isOwner/.test(brain), 'brain 透传 isOwner')
})
