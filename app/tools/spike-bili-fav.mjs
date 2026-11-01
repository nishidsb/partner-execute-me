/**
 * 收藏链路 spike（净零验证）：
 * 1. favFolders 只读列出我创建的收藏夹；
 * 2. 取第一个收藏夹，把一个固定视频「收藏 → 取消」；
 * 3. 拉收藏夹内容，确认该视频不在里面（净零，不留痕）。
 * 用法：node tools/spike-bili-fav.mjs <bili_credential.json>
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire(import.meta.url)
const client = require('../src/main/bili/client')

const file = process.argv[2]
if (!file) { console.error('usage: node tools/spike-bili-fav.mjs <credential>'); process.exit(1) }
const cred = JSON.parse(fs.readFileSync(file, 'utf8'))
const BVID = 'BV1GJ411x7h7' // 固定探针视频

const folders = await client.favFolders(cred)
if (!folders.ok) { console.log('favFolders FAIL:', folders.error); process.exit(1) }
console.log('favFolders OK:', folders.list.map((f) => `${f.id}(${f.title},${f.count})`).join(' ; ') || '(空)')
const fid = folders.list[0] && folders.list[0].id
if (!fid) { console.log('没有可用的收藏夹，跳过写测试'); process.exit(0) }

const add = await client.favDeal({ bvid: BVID, fid, add: true }, cred)
console.log('favDeal add:', JSON.stringify(add).slice(0, 200))
if (!add.ok) process.exit(1)

const rm = await client.favDeal({ bvid: BVID, fid, add: false }, cred)
console.log('favDeal del:', JSON.stringify(rm).slice(0, 200))

// 净零对账：确认探针视频不在收藏夹里
const j = await (await fetch(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${fid}&pn=1&ps=20&keyword=${BVID}`, {
  headers: client.headersFor(cred)
})).json()
const medias = (j.data && j.data.medias) || []
console.log('folder contains probe?', medias.length ? 'YES ⚠️' : 'no ✓（净零）')
console.log('SPIKE DONE')
