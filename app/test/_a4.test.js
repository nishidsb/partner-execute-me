/**
 * 0.43.0 她自己用电脑（autonomy）
 *
 * 这个模块真的会按 Ctrl+W。所以测试的重点不是「流程对不对」，
 * 而是**在每一种没确认清楚的情况下，它一个键都不能按**——
 * 关错一个标签页的代价，比「她出去看了却什么都没看」大得多。
 */
const test = require('node:test')
const assert = require('node:assert')

const a = require('../src/main/companion/autonomy')

function cuaStub (calls, opts = {}) {
  return {
    invoke: async (name, args) => {
      calls.push({ name, args })
      if (opts.deferred) return { deferred: true, reason: '用户在用电脑' }
      if (opts.throwOn === name) throw new Error('引擎不可用')
      return { ok: true }
    }
  }
}

function fgSeq (list) {
  let i = 0
  return async () => list[Math.min(i++, list.length - 1)]
}

const base = {
  topic: '显卡驱动',
  site: a.SITES[0],
  openUrl: async () => { },
  sleep: async () => { },
  log: () => { }
}

test('autonomy: status 带 idleMin；tick({force}) 绕过空闲/冷却直接跑一场', async () => {
  let t = 2_000_000_000_000
  const calls = []
  const inst = a.create({
    cfgGet: () => ({ autonomyOn: false, autonomyLevel: 1 }),  // 开关是关的：force 也要能跑
    log: () => {},
    idleSec: () => 0,                                          // 主人就在电脑前
    busy: () => false,
    pool: () => ({ themes: ['测试'] }),
    cua: cuaStub(calls),
    openUrl: async () => {},
    now: () => t,
    rand: () => 0,
    sleep: async () => {}
  })
  const st = inst.status()
  assert.equal(st.idleMin, 5, 'status 暴露当前阈值')
  // 普通 tick：开关关着 → 什么都不做
  await inst.tick()
  assert.equal(calls.length, 0, '关着不跑')
  // force tick：绕过开关/空闲，直接出门
  const r = await inst.tick({ force: true })
  assert.equal(r && r.ok, true, '测试跑应当成一场：' + JSON.stringify(r))
  assert.ok(calls.some((c) => c.name === 'scroll'), '翻两下')
  inst.stop()
})
