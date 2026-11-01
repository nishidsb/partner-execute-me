const test = require('node:test')
const assert = require('node:assert')
const guard = require('../src/main/im/napcat-guard')

test('decide：五种跳过 + 一种放行，全分支', () => {
  const base = { napcatCmd: 'C:/NapCat/NapCatWinBootMain.exe', napcatAutoStart: true, portReachable: false, state: { pid: 0 } }
  assert.equal(guard.decide({ wsUrl: 'ws://127.0.0.1:3001', ...base }), 'spawn', '全条件满足放行')
  assert.equal(guard.decide({ wsUrl: 'ws://127.0.0.1:3001', ...base, portReachable: true }), 'skip-port-open', '端口已通不碰')
  assert.equal(guard.decide({ wsUrl: 'ws://127.0.0.1:3001', ...base, napcatCmd: '' }), 'skip-no-cmd', '没配路径不拉')
  assert.equal(guard.decide({ wsUrl: 'ws://127.0.0.1:3001', ...base, napcatAutoStart: false }), 'skip-autostart-off', '开关关不拉')
  assert.equal(guard.decide({ wsUrl: 'ws://127.0.0.1:3001', ...base, state: { pid: process.pid } }), 'skip-alive', '已活着不重复拉')
  // 0.45.72：pid 活着但端口长时间不通 = 僵尸（QQ 重登换进程），必须重拉，否则她永远够不着 QQ
  assert.equal(guard.decide({ wsUrl: 'ws://127.0.0.1:3001', ...base, state: { pid: process.pid, at: Date.now() - 20 * 60 * 1000 } }), 'spawn-stale', '活着但不通超时 → 重拉')
  assert.equal(guard.decide({ wsUrl: 'ws://127.0.0.1:3001', ...base, state: { pid: process.pid, at: Date.now() - 60 * 1000 } }), 'skip-alive', '刚拉过再等等')
  assert.equal(guard.decide({ wsUrl: 'wss://remote.example.com:6700', ...base }), 'skip-not-local', '远程地址不由我们拉')
  assert.equal(guard.decide({ wsUrl: 'not-a-url', ...base }), 'skip-not-local', '坏地址不拉')
})

test('parseLocalWs：本机地址解析，远程拒绝', () => {
  assert.deepEqual(guard.parseLocalWs('ws://127.0.0.1:3001'), { host: '127.0.0.1', port: 3001 })
  assert.deepEqual(guard.parseLocalWs('ws://localhost'), { host: 'localhost', port: 80 }, '无端口走默认')
  assert.equal(guard.parseLocalWs('wss://1.2.3.4:6700'), null, 'wss 远程不守护')
  assert.equal(guard.parseLocalWs('http://127.0.0.1:3001'), null, '非 ws 协议不要')
})

test('pidAlive：活进程真、死进程假、0 假', () => {
  assert.equal(guard.pidAlive(process.pid), true)
  assert.equal(guard.pidAlive(0), false)
  assert.equal(guard.pidAlive(999999999), false)
})

test('create：status 面板字段齐', () => {
  const g = guard.create({ getCfg: () => ({ wsUrl: 'ws://127.0.0.1:3001', napcatCmd: 'X.exe', napcatAutoStart: true }), log: () => { } })
  const st = g.status()
  assert.equal(st.cmd, 'X.exe')
  assert.equal(st.autoStart, true)
  assert.equal(st.pidAlive, false)
})
