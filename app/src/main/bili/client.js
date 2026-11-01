/**
 * B 站 API 客户端（S8，纯 Node 零依赖）。
 * 移植自参考仓 dsh-bili-scroll（MIT）：lib/login.mjs + vendor/bilibili-mcp 的接口口径，
 * Python sidecar（bilibili_api）改成 JS 直连 —— spike（tools/spike-bili.mjs）已验证可行：
 *   WBI 签名 + wbi/search/type 可搜；AI 字幕需要登录态（player/wbi/v2 带 Cookie）。
 *
 * 凭证：<data>/bili-duty/bili_credential.json { sessdata, bili_jct, buvid3, dedeuserid }
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const API = 'https://api.bilibili.com'
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const pollUrl = (key) => 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'

/** WBI 混淆表（bilibili-API-collect 公开常量） */
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 凭证 ---------------- */

function credentialFile (home) { return path.join(home, 'bili_credential.json') }

function loadCredential (home) {
  try {
    const c = JSON.parse(fs.readFileSync(credentialFile(home), 'utf8'))
    return c && c.sessdata ? c : null
  } catch { return null }
}

function saveCredential (home, cred) {
  fs.mkdirSync(home, { recursive: true })
  const file = credentialFile(home)
  fs.writeFileSync(file, JSON.stringify({
    sessdata: cred.sessdata || '',
    bili_jct: cred.bili_jct || '',
    buvid3: cred.buvid3 || '',
    dedeuserid: cred.dedeuserid || ''
  }, null, 2), 'utf8')
  return file
}

function hasCredential (home) { return !!loadCredential(home) }

/* ---------------- HTTP 底座 ---------------- */

function headersFor (cred) {
  const h = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  if (cred) {
    const parts = [`SESSDATA=${cred.sessdata}`, `buvid3=${cred.buvid3 || ''}`]
    if (cred.bili_jct) parts.push(`bili_jct=${cred.bili_jct}`)
    if (cred.dedeuserid) parts.push(`DedeUserID=${cred.dedeuserid}`)
    h.Cookie = parts.filter((p) => !p.endsWith('=')).join('; ')
  }
  return h
}

async function jget (url, headers, { timeout = 15000 } = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
    const t = await r.text()
    try { return JSON.parse(t) } catch { return { code: -999, message: 'not json: ' + t.slice(0, 120) } }
  } catch (e) { return { code: -998, message: String(e && e.message ? e.message : e) } }
}

async function jpost (url, body, headers, { timeout = 15000 } = {}) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(timeout)
    })
    const t = await r.text()
    try { return JSON.parse(t) } catch { return { code: -999, message: 'not json: ' + t.slice(0, 120) } }
  } catch (e) { return { code: -998, message: String(e && e.message ? e.message : e) } }
}

/* ---------------- WBI 签名 ---------------- */

let wbiCache = { at: 0, key: '' }

/** nav 里的 img_key+sub_key 按混淆表重排取前 32 位 */
function mixinKeyOf (imgKey, subKey) {
  return MIXIN.map((i) => (imgKey + subKey)[i]).join('').slice(0, 32)
}

/** 拿 WBI key（缓存 12 小时）；未登录 nav 也照样返回 wbi_img（code -101 无碍） */
async function wbiKey () {
  const now = Date.now()
  if (wbiCache.key && now - wbiCache.at < 12 * 3600e3) return wbiCache.key
  const j = await jget(`${API}/x/web-interface/nav`, { 'User-Agent': UA })
  const img = String(j?.data?.wbi_img?.img_url || '').split('/').pop().replace(/\.\w+$/, '')
  const sub = String(j?.data?.wbi_img?.sub_url || '').split('/').pop().replace(/\.\w+$/, '')
  if (!img || !sub) throw new Error('拿不到 WBI key（nav 接口不通）')
  wbiCache = { at: now, key: mixinKeyOf(img, sub) }
  return wbiCache.key
}

/**
 * WBI 参数签名：params + wts → 排序 → 过滤 !'()* → md5(query + mixinKey)
 */
function wbiSign (params, key, now = Math.floor(Date.now() / 1000)) {
  const p = { ...params, wts: now }
  const q = Object.keys(p).sort()
    .map((k) => `${k}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  return { query: q, w_rid: md5(q + key) }
}

/* ---------------- buvid3 指纹（防 412 风控） ---------------- */

let buvidCache = { at: 0, v: '' }
async function ensureBuvid3 (cred) {
  if (cred && cred.buvid3) return cred.buvid3
  const now = Date.now()
  if (buvidCache.v && now - buvidCache.at < 24 * 3600e3) return buvidCache.v
  try {
    const j = await jget(SPI, { 'User-Agent': UA })
    const v = j?.data?.b_3 || ''
    if (v) buvidCache = { at: now, v }
    return v
  } catch { return '' }
}

/* ---------------- 业务接口 ---------------- */

const stripEm = (s) => String(s || '').replace(/<em class="keyword">/g, '').replace(/<\/em>/g, '')

/** 搜索视频（order: totalrank=综合 / click=播放 / pubdate=最新 / dm=弹幕） */
async function search ({ keyword, num = 10, order = 'totalrank', page = 1 } = {}, cred) {
  const key = await wbiKey()
  const buvid3 = await ensureBuvid3(cred)
  const headers = headersFor(cred)
  if (buvid3 && !headers.Cookie) headers.Cookie = `buvid3=${buvid3}`
  else if (buvid3) headers.Cookie += `; buvid3=${buvid3}`
  const signed = wbiSign({ search_type: 'video', keyword, page: String(page || 1), order: String(order || 'totalrank') }, key)
  const j = await jget(`${API}/x/web-interface/wbi/search/type?${signed.query}&w_rid=${signed.w_rid}`, headers)
  if (j.code !== 0) return { ok: false, error: `搜索失败 code=${j.code}: ${j.message || ''}` }
  const videos = (j.data?.result || [])
    .filter((v) => v.bvid)
    .slice(0, Math.max(1, Math.min(Number(num) || 10, 50)))
    .map((v) => ({
      bvid: v.bvid, aid: v.aid,
      title: stripEm(v.title),
      author: v.author, mid: v.mid,
      play: v.play, review: v.review, danmaku: v.video_review,
      pubdate: v.pubdate, duration: v.duration,
      description: String(v.description || '').slice(0, 200)
    }))
  return { ok: true, keyword, count: videos.length, videos }
}

/** 视频信息（aid/cid/title/owner/desc/pubdate/stat） */
async function view (bvid, cred) {
  const j = await jget(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, headersFor(cred))
  if (j.code !== 0) return { ok: false, error: `取视频信息失败 code=${j.code}: ${j.message || ''}` }
  const d = j.data
  return {
    ok: true, bvid: d.bvid, aid: d.aid, cid: d.cid, title: d.title,
    owner: d.owner ? { mid: d.owner.mid, name: d.owner.name } : null,
    desc: String(d.desc || '').slice(0, 500),
    pubdate: d.pubdate, duration: d.duration,
    stat: d.stat ? { view: d.stat.view, like: d.stat.like, danmaku: d.stat.danmaku, reply: d.stat.reply, favorite: d.stat.favorite } : null,
    pages: (d.pages || []).map((p) => ({ cid: p.cid, part: p.part }))
  }
}

/**
 * 字幕全文：player/wbi/v2 → 挑 ai-zh → zh-CN → zh → 第一个 → 下载 json。
 * 没有字幕返回 { ok:true, subtitle:'', message }（「空」是一种结果，不是坏了）。
 */
async function subtitle (bvid, cred) {
  const v = await view(bvid, cred)
  if (!v.ok) return v
  let cid = v.cid
  if (!cid && v.pages && v.pages.length) cid = v.pages[0].cid
  if (!cid) return { ok: false, error: '拿不到 cid' }
  const j = await jget(`${API}/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`, headersFor(cred))
  const subs = j?.data?.subtitle?.subtitles || []
  if (!subs.length) return { ok: true, bvid, title: v.title, subtitle: '', message: '该视频没有字幕', language: '' }
  const target = subs.find((s) => ['ai-zh', 'zh-CN', 'zh'].includes(s.lan)) || subs[0]
  let url = target.subtitle_url || ''
  if (url.startsWith('//')) url = 'https:' + url
  if (!url) return { ok: true, bvid, title: v.title, subtitle: '', message: '字幕条目存在但拿不到下载地址', language: target.lan || '' }
  const sj = await jget(url, { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' })
  const text = (sj?.body || []).map((x) => x.content || '').join('\n')
  return { ok: true, bvid, title: v.title, language: target.lan_doc || target.lan || '', subtitle: text, segments: (sj?.body || []).length }
}

/** 热门评论（mode=3 热门 / mode=2 时间） */
async function comments (bvid, { num = 30, mode = 3 } = {}, cred) {
  const v = await view(bvid, cred)
  if (!v.ok) return v
  const j = await jget(`${API}/x/v2/reply/main?type=1&oid=${v.aid}&mode=${Number(mode) || 3}&next=0&ps=20`, headersFor(cred))
  if (j.code !== 0) return { ok: false, error: `取评论失败 code=${j.code}: ${j.message || ''}` }
  const list = (j.data?.replies || []).slice(0, Math.max(1, Math.min(Number(num) || 30, 49)))
    .map((r) => ({
      rpid: r.rpid, mid: r.mid, name: r.member?.name || '',
      like: r.like, count: r.rcount,
      text: String(r.content?.message || '').slice(0, 200)
    }))
  return { ok: true, bvid, aid: v.aid, title: v.title, count: list.length, comments: list }
}

/**
 * 发评论 / 回复（root/parent = 楼中楼）。
 * ⚠️ 闸门在调用方（duty.js 工具层）：autoComment+mentionName 两道都开才放行，本函数不重复闸。
 */
async function reply ({ bvid, text, rpid = 0, root = 0 }, cred) {
  if (!cred) return { ok: false, error: '还没登录（凭证缺失）' }
  if (!cred.bili_jct) return { ok: false, error: '凭证缺 bili_jct（重新扫码登录）' }
  const v = await view(bvid, cred)
  if (!v.ok) return v
  const body = {
    oid: String(v.aid), type: '1', message: String(text || '').slice(0, 1000),
    plat: '1', csrf: cred.bili_jct, csrf_token: cred.bili_jct
  }
  const rp = Number(rpid) || 0
  if (rp > 0) { body.root = String(rp); body.parent = String(Number(root) > 0 ? root : rp) }
  const j = await jpost(`${API}/x/v2/reply/add`, body, headersFor(cred))
  if (j.code !== 0) return { ok: false, error: `发评论失败 code=${j.code}: ${j.message || ''}` }
  return { ok: true, bvid, aid: v.aid, rpid: j.data?.rpid || 0, root: rp || 0, message: String(text || '').slice(0, 60) }
}

/**
 * 发私信（S9-M4）。端点 api.vc.bilibili.com/web_im/v1/web_im/send_msg（老 session_svr 端点已 404），
 * 参数是 msg[...] 括号风格、dev_id 必须 UUID v4、csrf 双字段。
 * spike（tools/spike-bili-dm.mjs）真机验证：21026=不能给自己发 ⇒ 链路通。
 * ⚠️ 500 字是「一轮合并一条」的规矩（章程），接口本身限 2000 字节；21007=消息过长。
 */
async function sendDm ({ receiverUid, text }, cred) {
  if (!cred) return { ok: false, error: '还没登录（凭证缺失）' }
  if (!cred.bili_jct) return { ok: false, error: '凭证缺 bili_jct（重新扫码登录）' }
  const uid = Number(receiverUid) || 0
  if (uid <= 0) return { ok: false, error: '收件人 UID 没填（设置里「私信发给谁」要填数字 UID）' }
  const body = new URLSearchParams({
    'msg[sender_uid]': String(cred.dedeuserid || ''),
    'msg[receiver_id]': String(uid),
    'msg[receiver_type]': '1',
    'msg[msg_type]': '1',
    'msg[msg_status]': '0',
    'msg[dev_id]': crypto.randomUUID(),
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    'msg[content]': JSON.stringify({ content: String(text || '') }),
    csrf_token: cred.bili_jct,
    csrf: cred.bili_jct,
    build: '0',
    mobi_app: 'web'
  }).toString()
  const j = await jpost('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', body, headersFor(cred))
  if (j.code !== 0) {
    const hint = j.code === 21007 ? '（消息过长：一轮合并一条要在 500 字内，超了就精简重发）'
      : j.code === 21047 ? '（对方没关注你：陌生人最多先发 1 条，建议互关）'
        : j.code === 21015 ? '（这个账号没绑手机号，发不了私信）'
          : j.code === 25003 ? '（对方隐私设置不让陌生人私信）'
            : j.code === 21020 || j.code === 21046 ? '（发得太快/太频繁，等一会儿再发）' : ''
    return { ok: false, code: j.code, error: `发私信失败 code=${j.code}: ${j.message || ''}${hint}` }
  }
  return { ok: true, receiverUid: uid, msgKey: j.data?.msg_key || 0, bytes: Buffer.byteLength(String(text || ''), 'utf8') }
}

/** 楼中楼列表（root = 被回复的那条评论 rpid）——回复楼中楼前先看谁回了自己 */
async function subComments (bvid, root, { num = 20 } = {}, cred) {
  if (!Number(root)) return { ok: false, error: '缺 root（要看的楼中楼根评论 rpid）' }
  const v = await view(bvid, cred)
  if (!v.ok) return v
  const j = await jget(`${API}/x/v2/reply/reply?type=1&oid=${v.aid}&root=${Number(root)}&ps=20&pn=1`, headersFor(cred))
  if (j.code !== 0) return { ok: false, error: `取楼中楼失败 code=${j.code}: ${j.message || ''}` }
  const list = (j.data?.replies || []).slice(0, Math.max(1, Math.min(Number(num) || 20, 49)))
    .map((r) => ({
      rpid: r.rpid, parent: Number(r.parent) || 0, root: Number(r.root) || 0,
      mid: r.mid, name: r.member?.name || '',
      like: r.like, ctime: r.ctime,
      text: String(r.content?.message || '').slice(0, 200)
    }))
  return { ok: true, bvid, aid: v.aid, root: Number(root), count: list.length, replies: list }
}

/** 登录态检查（昵称 / mid / 是否有效） */
async function whoami (cred) {
  if (!cred) return { ok: false, loggedIn: false, hint: '还没登录：先在设置里扫码' }
  const j = await jget(`${API}/x/web-interface/nav`, headersFor(cred))
  if (j.code !== 0 || !j.data?.isLogin) return { ok: true, loggedIn: false, error: '凭证已失效（重新扫码）' }
  return { ok: true, loggedIn: true, uname: j.data.uname, mid: j.data.mid, level: j.data.levelInfo?.current_level }
}

/* ---------------- 收藏夹（S9-M4 收尾：宿主侧写动作，不给模型这只手） ---------------- */

/** 我创建的收藏夹列表（只读，设置页下拉用） */
async function favFolders (cred) {
  if (!cred) return { ok: false, error: '还没登录（凭证缺失）' }
  const mid = String(cred.dedeuserid || '')
  if (!mid) return { ok: false, error: '凭证缺 DedeUserID（重新扫码）' }
  const j = await jget(`${API}/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(mid)}`, headersFor(cred))
  if (j.code !== 0) return { ok: false, error: `取收藏夹失败 code=${j.code}: ${j.message || ''}` }
  const list = (j.data?.list || []).map((f) => ({ id: f.id, title: f.title, count: f.media_count || 0 }))
  return { ok: true, list }
}

/**
 * 收藏 / 取消收藏一个视频（deal 是官方的「收藏夹条目增删」端点）。
 * add=true 加进 addMediaIds；add=false 从 delMediaIds 移除。「已在夹里」不报错。
 */
async function favDeal ({ bvid, fid, add = true }, cred) {
  if (!cred) return { ok: false, error: '还没登录（凭证缺失）' }
  if (!cred.bili_jct) return { ok: false, error: '凭证缺 bili_jct（重新扫码登录）' }
  const v = await view(bvid, cred)
  if (!v.ok) return v
  const body = {
    rid: String(v.aid), type: '2',
    add_media_ids: add ? String(Number(fid)) : '',
    del_media_ids: add ? '' : String(Number(fid)),
    csrf: cred.bili_jct, csrf_token: cred.bili_jct
  }
  const j = await jpost(`${API}/x/v3/fav/resource/deal`, body, headersFor(cred))
  if (j.code !== 0) return { ok: false, error: `收藏失败 code=${j.code}: ${j.message || ''}` }
  return { ok: true, bvid, fid: Number(fid), aid: v.aid, title: v.title || '' }
}

/* ---------------- 只读画像：收藏夹内容 + 观看历史（0.24.0 电脑画像） ---------------- */

/** 某个收藏夹里的内容（一次 20 条，只读） */
async function favList ({ fid, pn = 1, ps = 20 } = {}, cred) {
  if (!cred) return { ok: false, error: '还没登录（凭证缺失）' }
  const j = await jget(`${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(fid)}&pn=${pn}&ps=${ps}&platform=web&order=mtime&type=0`, headersFor(cred))
  if (j.code !== 0) return { ok: false, error: `取收藏内容失败 code=${j.code}: ${j.message || ''}` }
  const list = (j.data?.medias || []).map((m) => ({
    title: m.title || '', bvid: m.bvid || '', up: m.upper?.name || '',
    favTime: m.fav_time ? m.fav_time * 1000 : 0
  }))
  return { ok: true, list, hasMore: !!j.data?.has_more, total: j.data?.info?.media_count || 0 }
}

/** 观看历史（只读，一页 30 条） */
async function watchHistory ({ pn = 1, ps = 30 } = {}, cred) {
  if (!cred) return { ok: false, error: '还没登录（凭证缺失）' }
  const j = await jget(`${API}/x/v2/history?pn=${pn}&ps=${ps}`, headersFor(cred))
  if (j.code !== 0) return { ok: false, error: `取观看历史失败 code=${j.code}: ${j.message || ''}` }
  const list = (j.data?.list || []).map((v) => ({
    title: v.title || '', bvid: v.bvid || '',
    up: v.owner?.name || '', author: v.author_name || '',
    progress: v.progress || 0, duration: v.duration || 0,
    at: (v.view_at || 0) * 1000
  }))
  return { ok: true, list }
}

/* ---------------- 扫码登录（移植 lib/login.mjs） ---------------- */

async function loginStart () {
  const j = await jget(GEN, { 'User-Agent': UA })
  const d = j?.data
  if (!d?.qrcode_key || !d?.url) throw new Error('生成二维码失败：' + (j.message || '返回里没有 qrcode_key'))
  return { key: d.qrcode_key, url: d.url }
}

function pickCookies (list) {
  const jar = {}
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' }
  for (const raw of list || []) {
    const first = String(raw).split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (want[name]) jar[want[name]] = value
  }
  return jar
}

/** 轮询一次。state: waiting / scanned / ok / expired / unknown */
async function loginPoll (key) {
  let res
  try {
    res = await fetch(pollUrl(key), { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(15000) })
  } catch (e) { return { state: 'unknown', code: -1, message: String(e && e.message ? e.message : e) } }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  let body = {}
  try { body = await res.json() } catch { /* poll 有时返回空体 */ }
  const code = body?.data?.code
  if (code === 0) {
    const jar = pickCookies(setCookies)
    if (!jar.buvid3) {
      const b3 = await ensureBuvid3(null)
      if (b3) jar.buvid3 = b3
    }
    if (!jar.sessdata) return { state: 'unknown', code, message: '登录成功了，但响应里没有 SESSDATA' }
    return { state: 'ok', code, credential: jar }
  }
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }
  return { state: map[code] ?? 'unknown', code, message: body?.message || '' }
}

module.exports = {
  UA, md5, mixinKeyOf, wbiSign, wbiKey, sleep,
  credentialFile, loadCredential, saveCredential, hasCredential, headersFor,
  search, view, subtitle, comments, reply, sendDm, subComments, whoami,
  favFolders, favDeal, favList, watchHistory,
  loginStart, loginPoll
}
