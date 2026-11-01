'use strict'
/* 与 AuraDesk 的卡片联动（0.29.0）
 *
 * 两边各写自己的文件，互不覆盖：
 *   %TEMP%\auradesk-cards.json  ← AuraDesk 写（每张卡的屏幕矩形）
 *   %TEMP%\ryza-pet.json        ← 本程序写（桌宠坐在哪张卡、在做什么）
 *
 * 卡片在 AuraDesk 里是渲染层 DOM，不是独立窗口，EnumWindows 看不到，
 * 所以只能由它自己上报（main.js 的 petlink:cards + renderer 的 publishCards）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CARDS_FILE = path.join(os.tmpdir(), 'auradesk-cards.json')
const PET_FILE = path.join(os.tmpdir(), 'ryza-pet.json')

/** 读卡片矩形；超过 maxAge 视为过期（AuraDesk 关了/卡更新没跟上） */
function readCards (maxAge = 8000) {
  try {
    const j = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'))
    if (!j || !Array.isArray(j.cards)) return []
    if (Date.now() - (Number(j.ts) || 0) > maxAge) return []
    return j.cards.filter((c) => c && Number(c.w) > 40 && Number(c.h) > 40)
  } catch { return [] }
}

/** 告诉 AuraDesk 宠物坐在哪张卡上（null = 没坐）。它只用来放大卡片，不启动程序 */
function writePet (pet) {
  try {
    fs.writeFileSync(PET_FILE, JSON.stringify({ ts: Date.now(), pet: pet || null }))
  } catch {}
}

/** 从候选卡片里挑一张：优先离角色近的，且在同一块屏内 */
function pickCard (cards, x, y, display) {
  const b = display && display.bounds
  let best = null
  let bestD = Infinity
  for (const c of cards) {
    if (b && (c.x + c.w < b.x || c.x > b.x + b.width || c.y + c.h < b.y || c.y > b.y + b.height)) continue
    const d = Math.abs(c.x + c.w / 2 - x) + Math.abs(c.y + c.h / 2 - y) * 0.6
    if (d < bestD) { bestD = d; best = c }
  }
  return best
}

module.exports = { readCards, writePet, pickCard, CARDS_FILE, PET_FILE }
