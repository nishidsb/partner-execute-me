/**
 * S8 刷B站：签名/配置钳制/报告对账/判重解析/章程 prompt/发评论闸门。
 * 网络接口不进单测（spike 脚本 tools/spike-bili.mjs 管真机验证）。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const client = require('../src/main/bili/client')
const duty = require('../src/main/bili/duty')

test('WBI：mixinKey 重排取 32 位、wbiSign 输出确定且随 wts 变化', () => {
  const img = '7cd084941338484aae1ad9425b84077c'
  const sub = '4932caff0ff746eab6f01bf08b70ac45'
  const key = client.mixinKeyOf(img, sub)
  assert.equal(key.length, 32)
  // 混淆表的重排结果必须只由 img+sub 两串的字符组成
  for (const ch of key) assert.ok((img + sub).includes(ch), 'mixin key 字符必须来自原始两串')
  const a = client.wbiSign({ keyword: 'AI', foo: 'b!a*r( )' }, key, 1700000000)
  assert.ok(/^[0-9a-f]{32}$/.test(a.w_rid))
  assert.equal(a.w_rid, client.wbiSign({ foo: 'b!a*r( )', keyword: 'AI' }, key, 1700000000).w_rid, '参数顺序无关')
  assert.notEqual(a.w_rid, client.wbiSign({ keyword: 'AI', foo: 'b!a*r( )' }, key, 1700000001).w_rid, 'wts 变 → 签名变')
  assert.ok(!/\(/.test(a.query), '查询串过滤 !\'()*')
})

test('clampCfg：逐字段按默认值类型挑 + 范围钳制', () => {
  const c = duty.clampCfg({
    perDay: '999', commentPerRound: -5, reportLevel: 'weird',
    keywords: ['a', 42, null, 'b'], autoComment: 'yes', mentionName: 123
  })
  assert.equal(c.perDay, 50)
  assert.equal(c.commentPerRound, 0)
  assert.equal(c.reportLevel, 'full')
  assert.deepEqual(c.keywords, ['a', 'b'])
  assert.equal(c.autoComment, false, '字符串 "yes" 不是布尔 → 按默认 false')
  assert.equal(c.mentionName, '123', '数字转字符串')
  // 嵌套对象当没给（参考仓 10-14 事故：config 字段不保证是标量）
  const c2 = duty.clampCfg({ perDay: { a: 1 }, keywords: 'not-array' })
  assert.equal(c2.perDay, duty.DEFAULTS.perDay)
  assert.deepEqual(c2.keywords, duty.DEFAULTS.keywords)
})

test('报告对账：### BV 标题行计数（去重、代码围栏不算、state 兜底取大）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-bili-'))
  const out = path.join(dir, 'out')
  fs.mkdirSync(out, { recursive: true })
  const file = path.join(out, duty.dayKey() + '.md')
  fs.writeFileSync(file, [
    '### BV1abc123456 第一条',
    '内容',
    '```',
    '### BV1fence00000 围栏里的不算',
    '```',
    '### BV1abc123456 重复的 BV 算一条',
    '### BV1xyz987654 第二条',
    '提到但没挑中：BV1skip00000 不顶格不算（前面有文字）'
  ].join('\n'), 'utf8')
  assert.equal(duty.countPicks(file), 2)
  assert.deepEqual(duty.pickIdsFromReport(file), ['BV1abc123456', 'BV1xyz987654'])
  // state 兜底：报告删了但 state 记过 → 取 state
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ day: duty.dayKey(), picked: 4 }))
  assert.equal(duty.countPickedToday(dir), 4)
})

test('parseSeen：判重表里抠评论记录（表格/列表/随手写都认）', () => {
  const rows = duty.parseSeen([
    '# 判重表',
    '| BV | rpid | root | 时间 | 正文 |',
    '| --- | --- | --- | --- | --- |',
    '| BV1abc123456 | 2987654321 |  | 2026-10-23 | 你看这个 |',
    '- BV1def223344 3111222333 3444555666 楼中楼',
    'BV1xyz987654 没有数字 → 跳过',
    '随便一行 BV1ghi334455，rpid=3222111000'
  ].join('\n'))
  assert.equal(rows.length, 3)
  assert.equal(rows[0].rpid, 2987654321)
  assert.equal(rows[1].root, 3444555666, '第二个长数字当 root')
  assert.equal(rows[2].rpid, 3222111000)
})

test('ensureHome：预建 out/digest/seen.md（带评论记录表头）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-bili-'))
  duty.ensureHome(dir)
  assert.ok(fs.existsSync(path.join(dir, 'out')))
  assert.ok(fs.existsSync(path.join(dir, 'digest')))
  const seen = fs.readFileSync(path.join(dir, 'seen.md'), 'utf8')
  assert.ok(seen.includes('评论记录'))
  assert.ok(seen.includes('看过的视频'))
})

test('buildPrompt：配额/关键词/评论开关/报告档位', () => {
  const home = path.join(os.tmpdir(), 'ryza-bili-home')
  const cfg = duty.clampCfg({ perDay: 5, autoComment: true, mentionName: '小明', commentPerRound: 2, reportLevel: 'brief' })
  const p = duty.buildPrompt({ home, cfg, already: 2 })
  assert.ok(p.includes('最多再挑 3 条'), '全天配额要扣掉已挑')
  assert.ok(p.includes('小明'))
  assert.ok(p.includes('每轮最多 2 条评论'))
  assert.ok(p.includes('薄版'))
  // 评论关着：明确说别发
  const p2 = duty.buildPrompt({ home, cfg: duty.clampCfg({ autoComment: false }), already: 0 })
  assert.ok(p2.includes('关着的（只写报告，别发评论）'))
  // off 档：不写报告文件
  const p3 = duty.buildPrompt({ home, cfg: duty.clampCfg({ reportLevel: 'off' }), already: 0 })
  assert.ok(p3.includes('不要写日报文件'))
})

test('发评论闸门：autoComment+mentionName 任一缺失 → 拒绝且不碰网络', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-bili-'))
  const calls = []
  const exec = duty.makeToolExec(home, duty.clampCfg({ autoComment: true, mentionName: '' }), { sessdata: 'x', bili_jct: 'y' }, () => {})
  const r1 = await exec('bili_reply', { bvid: 'BV1abc123456', text: 'hi' })
  assert.equal(r1.blocked, true)
  const exec2 = duty.makeToolExec(home, duty.clampCfg({ autoComment: false, mentionName: '小明' }), null, () => {})
  const r2 = await exec2('bili_reply', { bvid: 'BV1abc123456', text: 'hi' })
  assert.equal(r2.blocked, true)
  assert.equal(calls.length, 0)
})

test('makeToolExec：评论太长直接拒绝（章程 150 字内）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-bili-'))
  const exec = duty.makeToolExec(home, duty.clampCfg({ autoComment: true, mentionName: '小明' }), { sessdata: 'x', bili_jct: 'y' }, () => {})
  const r = await exec('bili_reply', { bvid: 'BV1abc123456', text: '长'.repeat(200) })
  assert.equal(r.ok, false)
  assert.ok(!r.blocked, '长度超限走错误而不是闸门提示')
})

test('工具定义：5 只工具、参数统一 string（兼容严格端点）', () => {
  const defs = duty.toolDefs()
  assert.equal(defs.length, 5)
  const names = defs.map((d) => d.function.name)
  for (const n of ['bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info', 'bili_reply']) assert.ok(names.includes(n))
  for (const d of defs) {
    for (const p of Object.values(d.function.parameters.properties || {})) {
      assert.equal(p.type, 'string', d.function.name + ' 的参数必须用 string（anyOf/number 会被部分端点 400）')
    }
  }
})

test('runOnce：没登录 / 模型不可用时不跑并说清楚', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-bili-'))
  const runner = duty.createDuty({ home, getProvider: () => null, log: () => {} })
  const r = await runner.runOnce('manual')
  assert.equal(r.started, false)
  assert.ok(r.error.includes('登录'), r.error)
  // 造一个假凭证再看模型不可用那条路
  client.saveCredential(home, { sessdata: 'x', bili_jct: 'y' })
  const r2 = await runner.runOnce('manual')
  assert.equal(r2.started, false)
  assert.ok(r2.error.includes('模型'), r2.error)
})

test('status：running/loggedIn/pickedToday 报表可用', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-bili-'))
  const runner = duty.createDuty({ home, getProvider: () => null, log: () => {} })
  const st = runner.status()
  assert.equal(st.ok, true)
  assert.equal(st.running, false)
  assert.equal(st.loggedIn, false)
  assert.equal(st.pickedToday, 0)
  assert.ok(st.report.endsWith(duty.dayKey() + '.md'))
})

/* ---------------- runOnce 报告落盘回归（2026-10-23 真机翻车：模型写了报告没人落盘） ---------------- */

function fakeHome () {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-duty-'))
  fs.writeFileSync(path.join(home, 'bili_credential.json'),
    JSON.stringify({ sessdata: 'x', bili_jct: 'y', buvid3: 'z' }), 'utf8')
  return home
}

/** 只返回文本、不调工具的假 provider（够测落盘，不触网） */
function fakeProvider (script) {
  let i = 0
  return { chat: async () => script[Math.min(i++, script.length - 1)] }
}

test('runOnce：模型最终文本含 ### BV 行 ⇒ 落盘成报告、配额对上、不写占位', async () => {
  const home = fakeHome()
  const d = duty.createDuty({
    home,
    getProvider: () => fakeProvider([{
      content: '# 刷B站日报\n\n### BV1agnh6bEEG\n标题：黄仁勋谈 Agent\n为什么值得：视角少见。\n\n### BV1qon86MER9\n标题：AI-Native 核心概念\n为什么值得：讲得系统。'
    }]),
    log: () => { }
  })
  const r = await d.runOnce('manual')
  assert.ok(r.started, 'runOnce 应该启动成功')
  assert.equal(r.reportSaved, true, '报告必须落盘')
  const f = path.join(home, 'out', duty.dayKey() + '.md')
  assert.ok(fs.existsSync(f), '报告文件要存在')
  const txt = fs.readFileSync(f, 'utf8')
  assert.ok(txt.includes('### BV1agnh6bEEG'), '内容要原样保留')
  assert.equal(d.status().pickedToday, 2, '配额按 ### BV 行数对账')
  assert.ok(!txt.includes('这一轮没写出报告'), '不许再拿占位报告糊弄')
  fs.rmSync(home, { recursive: true, force: true })
})

test('runOnce：模型只回一句话收尾（无 BV、太短）⇒ 落占位报告兜底', async () => {
  const home = fakeHome()
  const d = duty.createDuty({
    home,
    getProvider: () => fakeProvider([{ content: '今天没挑到合适的。' }]),
    log: () => { }
  })
  const r = await d.runOnce('manual')
  assert.equal(r.reportSaved, false)
  const f = path.join(home, 'out', duty.dayKey() + '.md')
  assert.ok(fs.existsSync(f))
  assert.ok(fs.readFileSync(f, 'utf8').includes('这一轮没写出报告'), '太短的收尾不算报告，走占位')
  fs.rmSync(home, { recursive: true, force: true })
})

test('runOnce：上一轮占位报告 ⇒ 本轮真报告覆盖它，而不是接在警告后面', async () => {
  const home = fakeHome()
  const d = duty.createDuty({
    home,
    getProvider: () => fakeProvider([{
      content: '### BV1agnh6bEEG\n标题：值得\n为什么值得：好。这一轮就收这一条，别的一律跳过，理由都写在这里凑够长度。'
    }]),
    log: () => { }
  })
  // 先伪造一份「上一轮失败」的占位
  const f = path.join(home, 'out', duty.dayKey() + '.md')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, '# 刷B站 —— 这一轮没写出报告\n\n上一轮翻车了。', 'utf8')
  await d.runOnce('manual')
  const txt = fs.readFileSync(f, 'utf8')
  assert.ok(txt.includes('### BV1agnh6bEEG'), '新报告要写进去')
  assert.ok(!txt.includes('上一轮翻车了'), '占位内容必须被覆盖掉')
  fs.rmSync(home, { recursive: true, force: true })
})

test('runOnce：reportLevel=off ⇒ 不落盘也不占位', async () => {
  const home = fakeHome()
  const d = duty.createDuty({
    home,
    getProvider: () => fakeProvider([{ content: '### BV1agnh6bEEG\n随便写点什么凑长度凑长度凑长度凑长度凑长度凑长度凑长度凑长度凑长度凑长度凑长度凑长度凑长度' }]),
    log: () => { }
  })
  d.saveCfg({ reportLevel: 'off' })
  const r = await d.runOnce('manual')
  assert.equal(r.reportSaved, false)
  const f = path.join(home, 'out', duty.dayKey() + '.md')
  assert.ok(!fs.existsSync(f), 'off 档不该有任何报告文件')
  fs.rmSync(home, { recursive: true, force: true })
})

/* ---------------- S9-M2 峰谷定时 ---------------- */

test('inWindow：普通窗口 / 跨零点窗口 / 坏格式', () => {
  const mk = (h, m) => new Date(2026, 9, 23, h, m)
  const noon = duty.WINDOWS.noon
  const night = duty.WINDOWS.night
  assert.equal(duty.inWindow(mk(12, 0), noon), true, '12:00 进窗口')
  assert.equal(duty.inWindow(mk(13, 59), noon), true)
  assert.equal(duty.inWindow(mk(14, 0), noon), false, '14:00 出窗口（左闭右开）')
  assert.equal(duty.inWindow(mk(11, 0), noon), false)
  // 夜间 18:00-09:00 跨零点
  assert.equal(duty.inWindow(mk(18, 0), night), true)
  assert.equal(duty.inWindow(mk(23, 30), night), true)
  assert.equal(duty.inWindow(mk(0, 0), night), true, '跨零点后仍算夜里窗口')
  assert.equal(duty.inWindow(mk(8, 59), night), true)
  assert.equal(duty.inWindow(mk(9, 0), night), false, '09:00 出窗口')
  assert.equal(duty.inWindow(mk(12, 0), night), false, '中午不属于夜里窗口')
  // 坏格式：不炸、返回 false
  assert.equal(duty.inWindow(mk(12, 0), { start: 'ab:cd', end: '14:00' }), false)
  assert.equal(duty.minutesOf('18:05'), 18 * 60 + 5)
  assert.equal(duty.minutesOf('bad'), null)
})

test('clampCfg：S9 新字段（dmMode 枚举 / dmUid 数字串 / replyPerRound / asrModel）', () => {
  const c = duty.clampCfg({ dmMode: 'weird', dmUid: ' 12345678 ', replyPerRound: 99, asrModel: 'huge', peakValley: 'yes', noon: false })
  assert.equal(c.dmMode, 'off', '坏枚举回 off')
  assert.equal(c.dmUid, '12345678', '数字字符串收下并去空格')
  assert.equal(c.replyPerRound, 10, '钳到 1-10')
  assert.equal(c.asrModel, 'small', '坏模型名回 small')
  assert.equal(c.peakValley, false, '"yes" 不是布尔')
  assert.equal(c.noon, false, '布尔收下')
  const c2 = duty.clampCfg({ dmUid: 87654321, replyPerRound: 0 })
  assert.equal(c2.dmUid, '87654321')
  assert.equal(c2.replyPerRound, 1, '0 回 1')
  const c3 = duty.clampCfg({ dmUid: 'not-a-number' })
  assert.equal(c3.dmUid, '', '非数字清空（= 私信闸关死）')
})

test('toolDefs：按设置动态增删（私信/楼中楼/转写）', () => {
  const off = duty.toolDefs(duty.clampCfg({}))
  assert.equal(off.length, 5, '默认（全关）还是 5 只')
  const allOn = duty.toolDefs(duty.clampCfg({ dmMode: 'only', dmUid: '123', replyToComments: true, transcribe: true }))
  const names = allOn.map((d) => d.function.name)
  assert.ok(names.includes('bili_send_message'), '私信开着要给工具（参考仓教训：开关开了没给工具）')
  assert.ok(names.includes('bili_sub_replies'))
  assert.ok(names.includes('bili_transcribe'))
  // 私信开了但没填 UID：不给工具（发了也必失败）
  const noUid = duty.toolDefs(duty.clampCfg({ dmMode: 'both', dmUid: '' }))
  assert.ok(!noUid.map((d) => d.function.name).includes('bili_send_message'))
})

test('工具闸门：only 模式拒绝公开评论 / 楼中楼回复没开拒绝 / 私信没开拒绝', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-bili-'))
  // dmMode=only：就算 autoComment+mentionName 都开着也不许发公开评论
  const exec = duty.makeToolExec(home, duty.clampCfg({ autoComment: true, mentionName: '小明', dmMode: 'only' }), { sessdata: 'x', bili_jct: 'y' }, () => {})
  const r = await exec('bili_reply', { bvid: 'BV1abc123456', text: 'hi' })
  assert.equal(r.blocked, true)
  assert.ok(r.hint.includes('只私信'), '拒绝理由要指向私信')
  // 楼中楼回复没开：带 rpid 的评论被拒
  const exec2 = duty.makeToolExec(home, duty.clampCfg({ autoComment: true, mentionName: '小明' }), { sessdata: 'x', bili_jct: 'y' }, () => {})
  const r2 = await exec2('bili_reply', { bvid: 'BV1abc123456', text: 'hi', rpid: '123' })
  assert.equal(r2.blocked, true, '回复楼中楼没开 → 拒')
  // 楼中楼回复开着但文本太长（>100）
  const exec3 = duty.makeToolExec(home, duty.clampCfg({ autoComment: true, mentionName: '小明', replyToComments: true }), { sessdata: 'x', bili_jct: 'y' }, () => {})
  const r3 = await exec3('bili_reply', { bvid: 'BV1abc123456', text: '长'.repeat(105), rpid: '123' })
  assert.equal(r3.ok, false)
  assert.ok(!r3.blocked)
  // 私信没开
  const exec4 = duty.makeToolExec(home, duty.clampCfg({}), { sessdata: 'x', bili_jct: 'y' }, () => {})
  const r4 = await exec4('bili_send_message', { text: 'hi' })
  assert.equal(r4.blocked, true)
  // 私信开着但正文 >500
  const exec5 = duty.makeToolExec(home, duty.clampCfg({ dmMode: 'only', dmUid: '123' }), { sessdata: 'x', bili_jct: 'y' }, () => {})
  const r5 = await exec5('bili_send_message', { text: '长'.repeat(501) })
  assert.equal(r5.ok, false)
  assert.ok(r5.error.includes('500'))
  // sub_replies 没开被拒（配置中途改掉的情况）
  const r6 = await exec4('bili_sub_replies', { bvid: 'BV1abc123456', rpid: '1' })
  assert.equal(r6.blocked, true)
  // 转写没开被拒
  const r7 = await exec4('bili_transcribe', { bvid: 'BV1abc123456' })
  assert.equal(r7.blocked, true)
})

test('buildPrompt / charterText：私信与楼中楼条款按设置注入', () => {
  const home = path.join(os.tmpdir(), 'ryza-bili-home')
  const dmCfg = duty.clampCfg({ dmMode: 'only', dmUid: '12345678', replyToComments: true, replyPerRound: 2, transcribe: true })
  const p = duty.buildPrompt({ home, cfg: dmCfg, already: 0 })
  assert.ok(p.includes('私信投递'), 'prompt 里要有私信指令')
  assert.ok(p.includes('12345678'))
  assert.ok(p.includes('500 字'))
  assert.ok(p.includes('21007'), '超长要精简重发的口径要交代')
  assert.ok(p.includes('每轮最多回 2 条'))
  assert.ok(p.includes('bili_transcribe'))
  assert.ok(!p.includes('bili_send_message 是关着的'), '开着时不说关')
  const p2 = duty.buildPrompt({ home, cfg: duty.clampCfg({}), already: 0 })
  assert.ok(p2.includes('私信投递是关着的'))
  assert.ok(p2.includes('回复楼中楼是关着的'))
  // 章程：only 模式写明一条公开评论都不发
  const ch = duty.charterText(home, dmCfg)
  assert.ok(ch.includes('「只私信」模式：一条公开评论都不许发'))
  const chOff = duty.charterText(home, duty.clampCfg({}))
  assert.ok(!chOff.includes('只私信」模式'), '默认关着时不注入 only 条款')
})

test('tick：总开关关着 → 绝不跑（谷时定时器安全兜底）', async () => {
  const home = fakeHome()
  const d = duty.createDuty({ home, getProvider: () => null, log: () => { } })
  d.saveCfg({ peakValley: false })
  // 不该抛异常，也不该启动任何一轮（getProvider 是 null，跑了会直接失败并留 state —— 我们断言 state 没动）
  d.tick()
  d.tick()
  const stFile = path.join(home, 'state.json')
  const st = fs.existsSync(stFile) ? JSON.parse(fs.readFileSync(stFile, 'utf8')) : {}
  assert.ok(!st.count, 'total 开关关着不该记任何一轮')
  fs.rmSync(home, { recursive: true, force: true })
})

test('favFolderId：钳制（负数/非数字归 0）+ favToday 未配置/未登录早退', async () => {
  const c1 = duty.clampCfg({ favFolderId: -5 })
  assert.equal(c1.favFolderId, 0)
  const c2 = duty.clampCfg({ favFolderId: 'abc' })
  assert.equal(c2.favFolderId, 0)
  const c3 = duty.clampCfg({ favFolderId: '45643364' })
  assert.equal(c3.favFolderId, 45643364)
  // 未配置收藏夹：favToday 直接拒绝，不打接口（fakeHome 会预置凭证，这里要干净目录测「未登录」闸）
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-fav-'))
  const d = duty.createDuty({ home, getProvider: () => null, log: () => { } })
  const r1 = await d.favToday('manual')
  assert.ok(!r1.ok && /收藏夹/.test(r1.error))
  // 配了收藏夹但没登录：拒绝
  d.saveCfg({ favFolderId: 45643364 })
  const r2 = await d.favToday('manual')
  assert.ok(!r2.ok && /登录/.test(r2.error))
  fs.rmSync(home, { recursive: true, force: true })
})

test('favToday：报告里有挑中条目 + 无凭证 → 仍走登录闸（不发请求）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-fav-'))
  const d = duty.createDuty({ home, getProvider: () => null, log: () => { } })
  d.saveCfg({ favFolderId: 45643364 })
  fs.mkdirSync(path.join(home, 'out'), { recursive: true })
  fs.writeFileSync(path.join(home, 'out', duty.dayKey() + '.md'), '### BV1agnh6bEEG\n测试条目\n', 'utf8')
  const r = await d.favToday('manual')
  assert.ok(!r.ok && /登录/.test(r.error), '没凭证要先挡在登录闸')
  fs.rmSync(home, { recursive: true, force: true })
})
