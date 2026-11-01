/* 卡片联动（0.29.0）：读 AuraDesk 上报的卡片矩形、挑一张最近的、写回宠物状态。
 * 只测纯逻辑（文件读写用临时目录里的真实文件），不依赖 Electron。 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const link = require('../src/main/companion/petlink')

const CARDS = link.CARDS_FILE
const PET = link.PET_FILE

function writeCards (cards, tsOffset = 0) {
  fs.writeFileSync(CARDS, JSON.stringify({ ts: Date.now() - tsOffset, cards }))
}

test.beforeEach(() => {
  try { fs.unlinkSync(CARDS) } catch {}
  try { fs.unlinkSync(PET) } catch {}
})
test.after(() => {
  try { fs.unlinkSync(CARDS) } catch {}
  try { fs.unlinkSync(PET) } catch {}
})

test('文件不存在 → 返回空数组（不能抛）', () => {
  assert.deepEqual(link.readCards(), [])
})

test('读到正常卡片', () => {
  writeCards([{ id: 'a', name: '原神', x: 100, y: 200, w: 120, h: 160 }])
  const cards = link.readCards()
  assert.equal(cards.length, 1)
  assert.equal(cards[0].id, 'a')
})

test('过期卡片（AuraDesk 已退出）→ 视为没有', () => {
  writeCards([{ id: 'a', x: 0, y: 0, w: 120, h: 160 }], 60000)
  assert.deepEqual(link.readCards(), [])
})

test('尺寸太小的不算座位', () => {
  writeCards([{ id: 'tiny', x: 0, y: 0, w: 10, h: 10 }])
  assert.deepEqual(link.readCards(), [])
})

test('挑最近的卡片（同一块屏）', () => {
  const cards = [
    { id: 'far', x: 1200, y: 300, w: 120, h: 160 },
    { id: 'near', x: 300, y: 320, w: 120, h: 160 }
  ]
  const d = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
  const c = link.pickCard(cards, 380, 700, d)
  assert.equal(c.id, 'near')
})

test('别的屏上的卡片不选', () => {
  const cards = [{ id: 'other', x: 2500, y: 300, w: 120, h: 160 }]
  const d = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
  assert.equal(link.pickCard(cards, 380, 700, d), null)
})

test('写宠物状态 / 清空', () => {
  link.writePet({ cardId: 'x', mode: 'rest' })
  const j = JSON.parse(fs.readFileSync(PET, 'utf8'))
  assert.equal(j.pet.cardId, 'x')
  assert.equal(j.pet.mode, 'rest')
  link.writePet(null)
  const j2 = JSON.parse(fs.readFileSync(PET, 'utf8'))
  assert.equal(j2.pet, null)
})
