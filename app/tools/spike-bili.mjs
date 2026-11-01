/**
 * S8 spike：验证纯 JS 的 B 站 WBI 签名 + 搜索/字幕/评论链路可通。
 * 用法：node tools/spike-bili.mjs [keyword]
 */
import crypto from 'node:crypto'
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// WBI 混淆表（bilibili-API-collect 公开常量）
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
const mixinKey = (imgKey, subKey) => MIXIN.map((i) => (imgKey + subKey)[i]).join('').slice(0, 32)

const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': UA } })
const navJ = await nav.json()
const img = String(navJ?.data?.wbi_img?.img_url || '').split('/').pop().replace('.png', '')
const sub = String(navJ?.data?.wbi_img?.sub_url || '').split('/').pop().replace('.png', '')
console.log('nav code =', navJ.code, '| img_key =', img, '| sub_key =', sub)

// 取一张 buvid3（防 412 风控）
const spi = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': UA } })
const buvid3 = (await spi.json())?.data?.b_3 || ''
console.log('buvid3 =', buvid3.slice(0, 12) + '…')

const wbiSign = (params, key) => {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) }
  const q = Object.keys(p).sort()
    .map((k) => `${k}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  return { query: q, w_rid: md5(q + key) }
}

const kw = process.argv[2] || 'AI Agent'
const signed = wbiSign({ search_type: 'video', keyword: kw, page: '1', order: 'totalrank' }, mixinKey(img, sub))
const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${signed.query}&w_rid=${signed.w_rid}`
const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: `buvid3=${buvid3}` } })
const j = await res.json()
console.log('search code =', j.code, '| message =', j.message || '')
const vids = (j.data?.result || []).slice(0, 3).map((v) => ({
  bvid: v.bvid, title: String(v.title || '').replace(/<[^>]+>/g, ''), play: v.play, author: v.author
}))
console.log(JSON.stringify(vids, null, 1))

// 字幕链路：view → player/wbi/v2
if (vids[0]?.bvid) {
  const v = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${vids[0].bvid}`, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } })
  const vj = await v.json()
  const cid = vj?.data?.cid
  console.log('view code =', vj.code, '| cid =', cid, '| aid =', vj?.data?.aid)
  const pl = await fetch(`https://api.bilibili.com/x/player/wbi/v2?bvid=${vids[0].bvid}&cid=${cid}`, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } })
  const pj = await pl.json()
  const subs = pj?.data?.subtitle?.subtitles || []
  console.log('player code =', pj.code, '| subtitles =', subs.length, subs.map((s) => s.lan).join(','))
  if (subs.length) {
    const u = subs[0].subtitle_url.startsWith('//') ? 'https:' + subs[0].subtitle_url : subs[0].subtitle_url
    const sj = await (await fetch(u, { headers: { 'User-Agent': UA } })).json()
    console.log('字幕段数 =', (sj.body || []).length, '| 首段 =', (sj.body?.[0]?.content || '').slice(0, 40))
  }
}
console.log('SPIKE OK')
