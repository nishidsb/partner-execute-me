'use strict'
/**
 * 0.24.0 第 1 期出门方案 · 触摸负反馈（触摸不再是无代价的）
 *  - 动作分级：摸头=安抚（还能压烦躁）、低频戳=玩闹、高频戳=烦、乱碰（腰/胸）=明确不喜欢、扔/摔=冷+烦
 *  - 旧 bug 回归：assistant 恒传 'touch' 导致 noteAttention 的 pet/throw 分支从未生效（扔人也加好感）
 *  - annoyed 自然消退（每小时 -0.3）；摸头能压下去；清零一起清
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const self = require('../src/main/companion/self')

function tmpWs () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-touchfb-'))
  self.ensure(dir)
  return dir
}

test('动作分级：摸头=安抚压烦躁；扔出去=冷+烦躁+心情掉（旧死分支修复）', () => {
  const ws = tmpWs()
  // 先造一点烦躁（第 3 次戳开始计：+0.02×2 +0.12×4 = 0.52）
  for (let i = 0; i < 8; i++) self.noteAttention(ws, 'poke')
  const annoyedBefore = self.effAnnoyed(self.getState(ws))
  assert.ok(annoyedBefore > 0.2, '连续 5 戳要攒出烦躁（实测 ' + annoyedBefore.toFixed(2) + '）')
  // 摸头：压烦躁 + 心情升
  self.noteAttention(ws, 'pet')
  const st1 = self.getState(ws)
  assert.ok(self.effAnnoyed(st1) < annoyedBefore, '摸头要压烦躁')
  assert.ok(st1.mood > 0.5, '摸头心情要升')
  // 扔出去：old 分支此前是死代码——现在必须真的冷+烦+心情掉
  const coldBefore = st1.cold
  self.noteAttention(ws, 'throw')
  const st2 = self.getState(ws)
  assert.ok(st2.cold > coldBefore + 0.2, '扔出去要加冷（' + st2.cold.toFixed(2) + '）')
  assert.ok(st2.annoyed > 0.5, '扔出去要加烦躁（' + st2.annoyed.toFixed(2) + '）')
  assert.ok(st2.mood < st1.mood, '扔出去心情要掉')
})

test('节流：单次戳几乎无代价；乱碰（invade）一次就明显', () => {
  const ws = tmpWs()
  self.noteAttention(ws, 'poke')
  const st1 = self.getState(ws)
  assert.ok(st1.annoyed <= 0.03, '单次戳不该攒出烦躁（' + st1.annoyed.toFixed(3) + '）')
  const ws2 = tmpWs()
  self.noteAttention(ws2, 'invade')
  const st2 = self.getState(ws2)
  assert.ok(st2.annoyed >= 0.14, '乱碰一次就要明显烦躁（' + st2.annoyed.toFixed(2) + '）')
  assert.ok(st2.mood < 0.5, '乱碰心情要掉')
})

test('自然消退：2 小时前的烦躁衰减到 0', () => {
  const ws = tmpWs()
  self.noteAttention(ws, 'throw')
  const st = self.getState(ws)
  assert.ok(st.annoyed > 0.2)
  // 伪造 2 小时前的时间戳
  self.patchState(ws, { annoyedAt: Date.now() - 2 * 3600e3 })
  assert.equal(self.effAnnoyed(self.getState(ws)), 0, '每小时 -0.3，两小时归零')
})

test('stateWords：烦躁高档要出现「让他停手」的提示；mid 档有轻微提示', () => {
  const hi = self.stateWords({ quiet: 0, cold: 0, mood: 0.5, annoyed: 0.7, ignoreStreak: 0 })
  assert.ok(hi.some((l) => l.includes('停手')), '高档要有「可以让他停手」：' + JSON.stringify(hi))
  const mid = self.stateWords({ quiet: 0, cold: 0, mood: 0.5, annoyed: 0.4, ignoreStreak: 0 })
  assert.ok(mid.some((l) => l.includes('躲')), 'mid 档要有「想躲」：' + JSON.stringify(mid))
  const calm = self.stateWords({ quiet: 0, cold: 0, mood: 0.5, annoyed: 0.1, ignoreStreak: 0 })
  assert.ok(!calm.some((l) => l.includes('烦躁') || l.includes('停手')), '低档不该无中生有')
})

test('inner.annoyedLevel：按有效烦躁映射档位', () => {
  const inner = require('../src/main/companion/inner')
  const ws = tmpWs()
  inner.setContext({ wsDir: ws, log: () => { }, llmCfg: null, persona: '', feedback: 'on' })
  assert.equal(inner.annoyedLevel(), '', '初始无烦躁')
  self.noteAttention(ws, 'throw')
  self.noteAttention(ws, 'throw')
  self.noteAttention(ws, 'throw')
  assert.equal(inner.annoyedLevel(), 'high', '三次扔（0.75）要到 high 档')
  // 清零一起清 annoyed
  inner.resetFeedback()
  const st = self.getState(ws)
  assert.equal(st.annoyed, 0, 'feedback-reset 要把烦躁一起清掉')
})
