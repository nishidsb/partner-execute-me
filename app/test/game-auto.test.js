'use strict'
const test = require('node:test')
const assert = require('node:assert')
const ga = require('../src/main/gameAuto')

const M = 60000

test('gameAuto: 全屏游戏要持续 4 分钟才自动进，短全屏不触发', () => {
  const now = 1000000000000
  let st = ga.freshState(now)
  // 全屏出现（进程 xoneshot 的虚构游戏）
  let r = ga.tick(st, { now, full: true, pname: 'sekiro', enabled: true })
  st = r.st
  assert.equal(r.action, 'none', '刚全屏不进')
  // 3 分钟：还不进
  r = ga.tick(st, { now: now + 3 * M, full: true, pname: 'sekiro', enabled: true })
  st = r.st
  assert.equal(r.action, 'none')
  // 4 分钟：进
  r = ga.tick(st, { now: now + 4 * M, full: true, pname: 'sekiro', enabled: true })
  st = r.st
  assert.equal(r.action, 'enter')
  assert.equal(r.reason, 'auto:sekiro')
})

test('gameAuto: 浏览器/播放器全屏绝不触发', () => {
  const now = 1000000000000
  let st = ga.freshState(now)
  for (const name of ['chrome', 'msedge', 'potplayer', 'vlc', 'powerpnt', 'code', 'qq']) {
    const r = ga.tick(st, { now: now + 10 * M, full: true, pname: name, enabled: true })
    st = r.st
    assert.equal(r.action, 'none', name + ' 全屏不算游戏')
  }
})

test('gameAuto: 全屏中途打断要重新计时', () => {
  const now = 1000000000000
  let st = ga.freshState(now)
  st = ga.tick(st, { now, full: true, pname: 'sekiro', enabled: true }).st
  st = ga.tick(st, { now: now + 3 * M, full: true, pname: 'sekiro', enabled: true }).st
  // 切出去（全屏结束）→ 候选清空
  st = ga.tick(st, { now: now + 3.5 * M, full: false, pname: 'chrome', enabled: true }).st
  // 再回来重新计满
  st = ga.tick(st, { now: now + 5 * M, full: true, pname: 'sekiro', enabled: true }).st
  const r = ga.tick(st, { now: now + 8 * M, full: true, pname: 'sekiro', enabled: true })
  assert.equal(r.action, 'none', '第二次只过了 3 分钟，不进')
})

test('gameAuto: 切出去不满宽限期不算离开；超了才退；手动进的不插手', () => {
  const now = 1000000000000
  let st = ga.freshState(now)
  st = ga.tick(st, { now, full: true, pname: 'sekiro', enabled: true }).st
  const e = ga.tick(st, { now: now + 4 * M, full: true, pname: 'sekiro', enabled: true })
  st = e.st
  assert.equal(e.action, 'enter')
  const ago = (t) => ({ now: t, full: false, pname: 'chrome', gameActive: true, gameEnteredBy: 'auto:sekiro', enabled: true })
  // 0.45.73：切去刷视频 / 聊天，2 分钟内不算离开（原来这会立刻退出，回来又重头计）
  const a1 = ga.tick(st, ago(now + 40 * M))
  st = a1.st
  assert.equal(a1.action, 'none', '刚切出去不退')
  const a2 = ga.tick(st, ago(now + 42 * M))
  st = a2.st
  assert.equal(a2.action, 'none', '2 分钟还没到宽限')
  // 回到游戏：宽限倒计时清零
  const b = ga.tick(st, { now: now + 42.5 * M, full: true, pname: 'sekiro', gameActive: true, gameEnteredBy: 'auto:sekiro', enabled: true })
  st = b.st
  assert.equal(b.action, 'none', '回来不退')
  assert.equal(st.awaySince, 0, '回来把离开计时清零')
  // 真走开超过宽限 → 退
  st = ga.tick(st, ago(now + 50 * M)).st
  const x = ga.tick(st, ago(now + 54 * M))
  st = x.st
  assert.equal(x.action, 'exit', '离开超过 3 分钟才退')
  // 手动进的会话：全屏结束也不动
  const m3 = ga.tick(ga.freshState(now), { now: now + 60 * M, full: false, pname: 'chrome', gameActive: true, gameEnteredBy: 'manual', enabled: true })
  assert.equal(m3.action, 'none', '手动进的不自动退')
})

test('gameAuto: 退掉之后 40 分钟内回到同一款游戏 → 立刻续场（不用等 HOLD）', () => {
  const now = 1000000000000
  let st = ga.freshState(now)
  st = ga.tick(st, { now, full: true, pname: 'sekiro', enabled: true }).st
  st = ga.tick(st, { now: now + 4 * M, full: true, pname: 'sekiro', enabled: true }).st
  // 长时间离开被退
  st = ga.tick(st, { now: now + 10 * M, full: false, pname: 'chrome', gameActive: true, gameEnteredBy: 'auto:sekiro', enabled: true }).st
  st = ga.tick(st, { now: now + 14 * M, full: false, pname: 'chrome', gameActive: true, gameEnteredBy: 'auto:sekiro', enabled: true }).st
  assert.equal(!!st.last, true, '退出时记住上一场')
  // 20 分钟后又全屏 → 立刻进，并且标记 resume
  const r = ga.tick(st, { now: now + 30 * M, full: true, pname: 'sekiro', enabled: true })
  assert.equal(r.action, 'enter', '续场不用再等 4 分钟')
  assert.equal(r.resume, true, '标记为续场（接着上一场计时）')
  // 换一款游戏不算续场
  const st2 = ga.freshState(now)
  st2.last = { name: 'sekiro', at: now }
  const r2 = ga.tick(st2, { now: now + 5 * M, full: true, pname: 'eldenring', enabled: true })
  assert.equal(r2.action, 'none', '换游戏要重新计满')
  assert.notEqual(r2.resume, true)
})

test('gameAuto: 同一款游戏当天第二次全屏 → 20 秒信任期', () => {
  const now = 1000000000000
  let st = ga.freshState(now)
  st = ga.tick(st, { now, full: true, pname: 'sekiro', enabled: true }).st
  st = ga.tick(st, { now: now + 4 * M, full: true, pname: 'sekiro', enabled: true }).st
  // 信任窗口内（6 小时）手动收场后再全屏
  st.trust = { name: 'sekiro', at: now + 4 * M }
  st = ga.tick(st, { now: now + 3 * 60 * M, full: true, pname: 'sekiro', enabled: true }).st
  const r = ga.tick(st, { now: now + 3 * 60 * M + 21 * 1000, full: true, pname: 'sekiro', enabled: true })
  assert.equal(r.action, 'enter', '信任期 20 秒就进')
  assert.equal(r.name, 'sekiro', '续场/信任期进的也要带游戏名')
})

test('gameAuto: 已知游戏进程（窗口化）也要防抖，但不用全屏', () => {
  const now = 1000000000000
  let st = ga.freshState(now)
  const o = { now, full: false, pname: 'ffxiv_dx11', enabled: true, knownGames: ['ffxiv_dx11'] }
  st = ga.tick(st, o).st
  const r = ga.tick(st, Object.assign({}, o, { now: now + 4 * M }))
  assert.equal(r.action, 'enter', '窗口化的已知游戏也自动进')
  // 0.45.76 enter 必须带游戏名：gameMode 拿它写进记忆（《ffxiv_dx11》陪了一场），
  // 没有名字她退出后只能编「陪你玩了个游戏」
  assert.equal(r.name, 'ffxiv_dx11', 'enter 要带游戏名给记忆同步')
})

test('gameAuto: 总闸关了永不进；自动进的会被退掉', () => {
  const now = 1000000000000
  let st = ga.freshState(now)
  const r = ga.tick(st, { now, full: true, pname: 'sekiro', enabled: false })
  assert.equal(r.action, 'none')
  // 已自动进的场，开关一关就退
  let st2 = ga.freshState(now)
  st2 = ga.tick(st2, { now, full: true, pname: 'sekiro', enabled: true }).st
  st2 = ga.tick(st2, { now: now + 4 * M, full: true, pname: 'sekiro', enabled: true }).st
  const r2 = ga.tick(st2, { now: now + 5 * M, full: true, pname: 'sekiro', gameActive: true, gameEnteredBy: 'auto:sekiro', enabled: false })
  assert.equal(r2.action, 'exit', '开关关掉时自动收场')
})
