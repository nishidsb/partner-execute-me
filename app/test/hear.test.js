'use strict'
/**
 * 听觉通道（0.46.54）——守的不是「听得准」（阈值要靠真机迭代），而是几条约定：
 *   · 诚实：没启用/没数据/过期 → ok:false 带原因，绝不编「听到了什么」
 *   · 安静且无事 → block() 空串（不浪费预算，也不装模作样「感叹环境声」）
 *   · 音乐型/键盘型/突变事件的可分性（同阈值下别把「放歌」说成「安静」）
 *   · hearOn 关了 → ingest 丢弃、describe 如实说没启用
 */
const test = require('node:test')
const assert = require('node:assert')
const hear = require('../src/main/companion/hear')

/** 可控时钟 */
let now = 1000000
hear._setNow(() => now)

function reset (on = true) {
  hear.resetForTest()
  hear._setNow(() => now)
  hear.configure({ on })
}

/** 送一条特征样本 */
function feed (over) {
  const f = Object.assign({ t: now, rms: 0.02, low: 0.1, mid: 0.1, high: 0.1, onsets: 0 }, over)
  return hear.ingest(f)
}

function feedRun (n, over, stepMs = 1000) {
  for (let i = 0; i < n; i++) {
    feed(Object.assign({ t: now }, over))
    now += stepMs
  }
}

test('hearOn 关着：样本直接丢弃、describe 如实说没启用', () => {
  reset(false)
  assert.equal(feed({ rms: 0.3 }), false)
  const d = hear.describe()
  assert.equal(d.ok, false)
  assert.ok(/没启用/.test(d.reason))
  assert.equal(hear.block(), '')
})

test('没数据：describe 诚实说耳朵里还没有东西', () => {
  reset()
  const d = hear.describe()
  assert.equal(d.ok, false)
  assert.ok(/没.*数据|没开/.test(d.reason))
})

test('数据过期（麦关了）：超过 15 秒没样本 → 如实 ok:false', () => {
  reset()
  feedRun(5, { rms: 0.1 })
  now += 60 * 1000 // 静置一分钟
  const d = hear.describe()
  assert.equal(d.ok, false)
  assert.ok(/没.*进来|没数据|麦克风/.test(d.reason))
})

test('安静稳态：ok 但 block() 是空串（不装模作样）', () => {
  reset()
  feedRun(20, { rms: 0.008, low: 0.05, mid: 0.05, high: 0.05 })
  const d = hear.describe()
  assert.equal(d.ok, true)
  assert.equal(d.level, 'quiet')
  assert.equal(hear.block(), '')
})

test('低频重 + 有起伏 → 识别成音乐型；block() 有内容', () => {
  reset()
  feedRun(20, { rms: 0.15, low: 0.5, mid: 0.25, high: 0.15, onsets: 2 })
  const d = hear.describe()
  assert.equal(d.ok, true)
  assert.ok(d.tags.some((t) => /音乐|视频/.test(t)))
  const b = hear.block()
  assert.ok(b.length > 0 && b.length < 300)
  assert.ok(/响度/.test(b))
})

test('低频持续 + 无起伏 → 机器嗡鸣型，不是音乐', () => {
  reset()
  feedRun(20, { rms: 0.08, low: 0.55, mid: 0.2, high: 0.1, onsets: 0 })
  const d = hear.describe()
  assert.equal(d.ok, true)
  assert.ok(d.tags.some((t) => /空调|风扇|机器/.test(t)))
  assert.ok(!d.tags.some((t) => /音乐/.test(t)))
})

test('高频碎响 → 键盘/小物件型', () => {
  reset()
  feedRun(20, { rms: 0.06, low: 0.15, mid: 0.25, high: 0.5, onsets: 3 })
  const d = hear.describe()
  assert.ok(d.tags.some((t) => /键盘|鼠标|小物件/.test(t)))
})

test('突变事件：先吵后静 → 「突然安静下来了」；先静后吵 → 「突然吵起来了」', () => {
  reset()
  feedRun(25, { rms: 0.2, low: 0.3, mid: 0.3, high: 0.3 }) // 前 25 秒吵
  feedRun(15, { rms: 0.01, low: 0.05, mid: 0.05, high: 0.05 }) // 后 15 秒静
  const d = hear.describe()
  assert.ok(d.events.some((e) => /安静/.test(e)), '应识别突然安静：' + JSON.stringify(d.events))
})

test('突变事件有保质期：3 分钟前的「突然安静」不再挂嘴边', () => {
  reset()
  feedRun(25, { rms: 0.2 })
  feedRun(15, { rms: 0.01 })
  now += 5 * 60 * 1000
  feedRun(20, { rms: 0.02, low: 0.08, mid: 0.08, high: 0.08 })
  const d = hear.describe()
  assert.equal(d.ok, true)
  assert.ok(!(d.events || []).some((e) => /突然/.test(e)))
})

test('样本量限幅：长期运行 buf 不会无限涨（240 上限 + 时间窗清理）', () => {
  reset()
  for (let i = 0; i < 2000; i++) { feed({ t: now, rms: 0.05 }); now += 1000 }
  const stt = hear.status()
  assert.ok(stt.samples <= 240, 'samples=' + stt.samples)
})

test('非法样本：负响度/非数字 → 拒收', () => {
  reset()
  assert.equal(hear.ingest({ t: now, rms: -1 }), false)
  assert.equal(hear.ingest({ t: now, rms: 'abc' }), false)
  assert.equal(hear.ingest(null), false)
  assert.equal(hear.ingest({ rms: 0.1 }), false) // 无 t
})

test('block() 输出克制：quiet 有事件时才出声，且不超预算', () => {
  reset()
  feedRun(25, { rms: 0.15 })
  feedRun(15, { rms: 0.008, low: 0.05, mid: 0.05, high: 0.05 })
  const b = hear.block()
  assert.ok(/突然安静|刚才/.test(b), 'quiet+事件应出声：' + b)
  assert.ok(b.length < 300)
})

test('0.46.55 系统声兜底：src=sys 时听感明说「电脑自己发出的声音」', () => {
  reset()
  feedRun(10, { rms: 0.15, low: 0.5, mid: 0.25, high: 0.15, onsets: 2, src: 'sys' })
  const d = hear.describe()
  assert.equal(d.ok, true)
  assert.ok(/电脑自己发出/.test(d.text), '应带来源标注：' + d.text)
  assert.ok(d.tags.some((t) => /音乐|视频/.test(t)))
  // 混合来源：最后一条是 mic → 不再标注 sys
  feed({ t: now, rms: 0.15, low: 0.5, mid: 0.25, high: 0.15, onsets: 2, src: 'mic' })
  const d2 = hear.describe()
  assert.ok(!/电脑自己发出/.test(d2.text))
})

test('0.48.9 聋流自愈：看门狗在、micOff 先放流再让位（真机 17:33 实锤哑流）', () => {
  const fs2 = require('node:fs')
  const path = require('node:path')
  const src = fs2.readFileSync(path.join(__dirname, '../src/renderer/overlay/pet.js'), 'utf8')
  // 聋流看门狗：连续全零计数 + 重开上限
  assert.ok(src.includes('hearZeroRun'), '看门狗计数器存在')
  assert.ok(src.includes('数字静音（聋流）'), '聋流重开有留痕')
  assert.ok(/hearReopens < 3/.test(src), '重开有次数上限（防设备真坏时循环）')
  // AudioContext 挂起自愈
  assert.ok(src.includes("hearCtx.state === 'suspended'"), '开流时检查并 resume 挂起的 AudioContext')
  // micOff 顺序：先放 vp 流，再 hearMicEnsure（设备交接竞态）
  const offIdx = src.indexOf('function micOff ()')
  const stopIdx = src.indexOf('t.stop()', offIdx)
  const ensureIdx = src.indexOf('hearMicEnsure()', offIdx)
  assert.ok(stopIdx > 0 && ensureIdx > stopIdx, 'micOff 内 t.stop() 必须先于 hearMicEnsure()')
  // 点击留痕
  assert.ok(src.includes('vp-mic-click'), '麦克风按钮点击有留痕')
})

test('0.49.1 峰值口径：断续说话（中位数安静+峰值有人声）不再报「很安静」', () => {
  reset()
  // 真机 20:45 实锤的形状：说两秒停八秒——12 秒窗里大多 rms≈0.005，偶有人声 0.08
  for (let i = 0; i < 11; i++) { feed({ rms: 0.005 }); now += 1000 }
  feed({ rms: 0.08, mid: 0.6, low: 0.2, high: 0.2, onsets: 2 })
  const d = hear.describe()
  assert.equal(d.ok, true)
  assert.notEqual(d.level, 'quiet', '峰值有人声就不该判 quiet')
  assert.ok(d.tags.some((t) => /人声|说话/.test(t)), '要说出「有人在旁边说话」，实际 tags：' + d.tags.join('/'))
  assert.ok(hear.block().length > 0, 'block() 不再因为 quiet 吞掉这段感知')
  // 对照：真安静（峰值也低）维持原判
  reset()
  for (let i = 0; i < 12; i++) { feed({ rms: 0.005 }); now += 1000 }
  const d2 = hear.describe()
  assert.equal(d2.level, 'quiet', '峰值也没动静才是真安静')
  assert.equal(hear.block(), '', '真安静仍然不浪费注入预算')
})
