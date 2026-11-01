/**
 * spike：私信接口真机验证（S9-M4）。
 * 只发给自己（receiver_id = 自己的 mid），不发给别人 —— 无害。
 * 用法：node tools/spike-bili-dm.mjs <credJson路径>
 */
import fs from 'node:fs'

const credFile = process.argv[2]
if (!credFile) { console.error('用法: node tools/spike-bili-dm.mjs <credential.json>'); process.exit(1) }
const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'))

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const headers = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Cookie: `SESSDATA=${cred.sessdata}; buvid3=${cred.buvid3}; bili_jct=${cred.bili_jct}; DedeUserID=${cred.dedeuserid}`
}
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t) } catch { return { code: -999, raw: t.slice(0, 300) } } }

// 1. whoami
const nav = await j(await fetch('https://api.bilibili.com/x/web-interface/nav', { headers }))
console.log('whoami:', nav.code === 0 ? `${nav.data.uname} mid=${nav.data.mid}` : `code=${nav.code} ${nav.message}`)
if (nav.code !== 0) process.exit(2)
const myMid = nav.data.mid

// 2. 发私信给自己（新端点 web_im/send_msg，msg[...] 括号参数，dev_id=UUIDv4）
// ⚠️ 21026 不能给自己发 ⇒ 真正的连通性测试发给自己会报 21026，报它就说明整条链路通了
const text = '【Ryza spike】私信接口连通性测试'
const body = new URLSearchParams({
  'msg[sender_uid]': String(myMid),
  'msg[receiver_id]': String(myMid),
  'msg[receiver_type]': '1',
  'msg[msg_type]': '1',
  'msg[msg_status]': '0',
  'msg[dev_id]': crypto.randomUUID(),
  'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
  'msg[content]': JSON.stringify({ content: text }),
  csrf_token: cred.bili_jct,
  csrf: cred.bili_jct,
  build: '0',
  mobi_app: 'web'
}).toString()
const r = await j(await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
  body
}))
console.log('send_msg:', JSON.stringify(r).slice(0, 500))
console.log(r.code === 0 ? '✓ 发送成功（不该发生，收件人是自己）'
  : r.code === 21026 ? '✓ 链路通（21026=不能给自己发，接口已正常受理）'
  : r.code === 21047 ? '✓ 链路通（21047=陌生人限 1 条）'
  : '✗ code=' + r.code + ' ' + (r.message || r.raw || ''))

// 3. 会话列表里确认（只读）
const s = await j(await fetch('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web', { headers }))
const hit = (s.data?.session_list || []).find((x) => x.talker_id === myMid)
console.log('session check:', hit ? `找到会话 talker_id=${hit.talker_id} last=${JSON.stringify(hit.last_msg?.content || '').slice(0, 120)}` : '会话列表里没找到自己（可能要等几秒）')
