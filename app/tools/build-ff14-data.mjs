#!/usr/bin/env node
/**
 * 构建 FF14 离线数据包 → resources/ff14/
 *  1. items-zh.json  物品 id → 中文名（boilmaster xivcdn Item 表全量，Name@lang(chs)）
 *  2. fishing.json   钓鱼数据（icykoneko/ff14-fish-tracker-app 的 DATA 精简版：
 *                    窗口/天气/鱼皇前提/钓场/天气表），运行时零网络依赖
 * 用法：node tools/build-ff14-data.mjs [--fish-src <data.js路径> <fish_info_data.js路径>]
 * 数据来源：xiveapi-v2.xivcdn.com（FFCafe 国服镜像）、fastly.jsdelivr.net
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'resources', 'ff14')
fs.mkdirSync(OUT, { recursive: true })

const CDN = 'https://xivapi-v2.xivcdn.com'
const FISH_APP = 'https://fastly.jsdelivr.net/gh/icykoneko/ff14-fish-tracker-app@master/js/app'

async function getJson (url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    } catch (e) {
      if (i === tries - 1) throw e
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
}

async function getText (url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.text()
    } catch (e) {
      if (i === tries - 1) throw e
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

/* ---------------- 1. 物品中文表 ---------------- */

async function buildItems () {
  console.log('[items] 拉取 Item 表 Name@lang(chs) …')
  const map = {}
  let after = 0
  const LIMIT = 1000
  for (let page = 0; page < 200; page++) {
    const url = `${CDN}/api/sheet/Item?fields=Name%40lang(chs)&limit=${LIMIT}&after=${after}`
    const d = await getJson(url)
    const rows = d.rows || []
    if (!rows.length) break
    for (const r of rows) {
      const n = r.fields && r.fields['Name@lang(chs)']
      if (n) map[r.row_id] = n
    }
    const last = rows[rows.length - 1].row_id
    if (last === after) break
    after = last
    if (rows.length < LIMIT && page > 2) { /* 仍继续拉直到空页 */ }
    if (page % 10 === 0) console.log(`[items] 已拉 ${Object.keys(map).length} 条 (cursor=${after})`)
  }
  const file = path.join(OUT, 'items-zh.json')
  fs.writeFileSync(file, JSON.stringify(map))
  console.log(`[items] 完成：${Object.keys(map).length} 条 → ${file} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`)
}

/* ---------------- 2. 钓鱼数据 ---------------- */

function evalData (js) {
  // data.js: `const DATA = {...}`（取对象字面量按表达式求值，避开 eval 作用域问题）
  const m = js.match(/const DATA = /)
  if (!m) throw new Error('data.js 格式不符')
  let expr = js.slice(m.index + m[0].length).trim()
  expr = expr.replace(/;\s*$/, '')
  return (0, eval)('(' + expr + ')')
}

async function buildFishing (dataJs, fishInfoJs) {
  console.log('[fish] 解析 DATA …')
  const DATA = evalData(dataJs)
  const spots = {}
  for (const k of Object.keys(DATA.FISHING_SPOTS)) {
    const s = DATA.FISHING_SPOTS[k]
    spots[s._id] = { n: s.name_en || s.name_ja, nj: s.name_ja || s.name_en, t: s.territory_id, xy: s.map_coords }
  }
  const wr = {}
  for (const k of Object.keys(DATA.WEATHER_RATES)) {
    wr[k] = DATA.WEATHER_RATES[k].weather_rates
  }
  const wt = {}
  for (const k of Object.keys(DATA.WEATHER_TYPES)) {
    wt[k] = DATA.WEATHER_TYPES[k].name_ja || DATA.WEATHER_TYPES[k].name_en
  }
  const fish = {}
  for (const k of Object.keys(DATA.FISH)) {
    const f = DATA.FISH[k]
    fish[f._id] = {
      h: f.startHour != null && f.endHour != null ? [f.startHour, f.endHour] : null,   // ET 窗口
      w: f.weatherSet || [],
      pw: f.previousWeatherSet || [],
      spot: f.location || null,
      pred: (f.predators || []).map((p) => (typeof p === 'object' ? (p.fish ?? p.id ?? p) : p)),
      intu: f.intuitionLength || null,
      patch: f.patch || null,
      eyes: !!f.fishEyes,
      snag: !!f.snagging,
      hook: f.hookset || null,
      tug: f.tug || null,
      gig: f.gig || null,
      big: !!f.bigFish,
      lore: f.folklore || null
    }
  }
  const bundle = { fish, spots, wr, wt, folklore: DATA.FOLKLORE ? Object.keys(DATA.FOLKLORE).length : 0 }
  const file = path.join(OUT, 'fishing.json')
  fs.writeFileSync(file, JSON.stringify(bundle))
  console.log(`[fish] 完成：鱼 ${Object.keys(fish).length} / 钓场 ${Object.keys(spots).length} / 天气表 ${Object.keys(wr).length} → ${file} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`)
}

/* ---------------- main ---------------- */

// 注：青魔法书名单（blu.json）与陆行鸟色表（chocobo.json）是手工维护的数据包，
// 不在此脚本构建范围内（Action 表缺中文描述且名单不全，灰机wiki 名单更权威）。

const args = process.argv.slice(2)
let fishDataPath = null
let fishInfoPath = null
if (args[0] === '--fish-src') { fishDataPath = args[1]; fishInfoPath = args[2] }

let dataJs = fishDataPath ? fs.readFileSync(fishDataPath, 'utf8') : null
let infoJs = fishInfoPath ? fs.readFileSync(fishInfoPath, 'utf8') : null
if (!dataJs) {
  console.log('[fish] 下载 data.js …')
  dataJs = await getText(`${FISH_APP}/data.js`)
}
// fish_info_data.js 目前只用来校验来源（本构建不打包它的多语言描述，太大）
if (!infoJs) {
  try { infoJs = await getText(`${FISH_APP}/fish_info_data.js`) } catch { infoJs = '' }
}
console.log('[fish] data.js', (dataJs.length / 1048576).toFixed(2), 'MB / info', (infoJs.length / 1048576).toFixed(2), 'MB')

await buildFishing(dataJs, infoJs)
await buildItems()
console.log('[done] resources/ff14 就绪')
