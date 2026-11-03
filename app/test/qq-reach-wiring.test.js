/**
 * 0.45.91 回归：QQ 主动找人的「连上没连上」判据
 *
 * 线上 bug：main.js 注入的桥接用 `client.status().phase === 'ready'` 判活，
 * 而 onebot 的 notify() 只把 phase 塞进 onStatus 回调参数、没写回 state，
 * 于是 status().phase 永远 undefined → reach 永远 'disconnected'
 * → 「她一条 QQ 主动消息都发不出去」，日志里连 OneBot 明明已连接也是 disconnected。
 *
 * 这里用假 transport 把整条链路跑一遍：open → get_login_info → status()。
 */
const test = require('node:test')
const assert = require('node:assert')

const { createClient } = require('../src/main/im/onebot')
const reach = require('../src/main/companion/reach')

/** 最小可用的 OneBot 假协议端：连上即答 get_login_info */
class FakeWS {
  constructor (url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    setTimeout(() => {
      this.readyState = 1
      if (this.onopen) this.onopen()
    }, 0)
  }

  send (raw) {
    const msg = JSON.parse(raw)
    this.sent.push(msg)
    if (msg.action === 'get_login_info') {
      setTimeout(() => {
        if (this.onmessage) {
          this.onmessage({
            data: JSON.stringify({
              action: msg.action, echo: msg.echo, retcode: 0, status: 'ok',
              data: { user_id: 2738649075, nickname: 'reisa' }
            })
          })
        }
      }, 0)
    }
  }

  close () {
    this.readyState = 3
    if (this.onclose) this.onclose()
  }
}

const NOW = 1000000000000 // 白天（8:00~23:00），避开凌晨静默

test('连上后 status().phase 必须是 ready（曾经永远是 undefined）', async () => {
  const c = createClient({ url: 'ws://127.0.0.1:3001', transport: FakeWS })
  const ok = await c.connect()
  assert.equal(ok, true, '握手应成功')
  const st = c.status()
  assert.equal(st.connected, true, 'state.connected 应为 true')
  assert.equal(st.phase, 'ready', 'phase 必须落进 state，否则判活全废')
  assert.equal(st.selfId, 2738649075)
  assert.equal(st.nickname, 'reisa')
  c.disconnect()
})

test('搭上 reach 判定：连上后主动找人真的能放行', async () => {
  const c = createClient({ url: 'ws://127.0.0.1:3001', transport: FakeWS })
  await c.connect()
  const st = c.status()
  // 复刻 main.js 的桥接判活（0.45.91：只看 connected，phase 兼容）
  const connected = !!(st && (st.connected === true || st.phase === 'ready'))
  assert.equal(connected, true, '桥接必须认为已连接')

  const gate = reach.shouldReach(
    { lastAt: 0, day: '', count: 0 },
    { reachOn: true, ownerAccounts: ['359524452'] },
    { now: NOW, connected }
  )
  assert.equal(gate.ok, true, '连上了就该放行（此前的 bug 在这里被判成 disconnected）')
  assert.equal(gate.uid, '359524452', '默认发给主人名单第一个')
  c.disconnect()
})

test('断线后 status 立刻回到未连接（别反过来误发）', async () => {
  const c = createClient({ url: 'ws://127.0.0.1:3001', transport: FakeWS })
  await c.connect()
  c.disconnect()
  const st = c.status()
  assert.equal(st.connected, false)
  assert.equal(st.phase, 'closed')
})
