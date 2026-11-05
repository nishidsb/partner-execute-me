/**
 * 0.46.0 自言自语系统测试。
 *
 * 需求（用户 11-02）：
 *  - 零散嘀咕 + 连续独白，保持安静是正常且常见的选择；
 *  - 不采用固定间隔播报（tick 到点 ≠ 必说）；
 *  - 依附自主活动（复用既有 LLM 调用，不因点击/滚动加调用）；
 *  - 记忆与本体同源（出口统一 sayNarration → ledgerNote via:'chatter'）；
 *  - 朗读复用 Fish Audio，默认开、低频，有开关与每日上限。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createSoliloquy, MAX_LINES } = require('../src/main/companion/soliloquy')
const chatter = require('../src/main/companion/chatter')
const autonomy = require('../src/main/companion/autonomy')

function tmpFile () {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solilo-')), 'state.json')
}

test('独白状态机：开 → 记 → 满 4 句自动收尾', () => {
  const f = tmpFile()
  const s = createSoliloquy({ file: f })
  assert.equal(s.current(), null, '一开始没有独白')
  s.open('炼金术和编程的相似之处')
  assert.equal(s.current().topic, '炼金术和编程的相似之处')
  for (let i = 1; i <= MAX_LINES; i++) s.addLine('第' + i + '句')
  assert.equal(s.current(), null, '说满 4 句自动结束')
  assert.ok(!fs.existsSync(f) === false, '状态落过盘')
})

test('独白状态机：30 分钟没接上自然过期；close 立即结束', () => {
  let t = 1_000_000
  const f = tmpFile()
  const s = createSoliloquy({ file: f, now: () => t })
  s.open('某个话题')
  s.addLine('一句')
  t += 31 * 60 * 1000
  assert.equal(s.current(), null, '过期清掉')
  // close 路径
  s.open('另一个话题')
  assert.ok(s.current())
  const done = s.close('user-back')
  assert.equal(done.closed, true)
  assert.equal(s.current(), null)
})

test('独白跨进程恢复：重启后从盘上读回来（第二天继续昨天没想完的事）', () => {
  const f = tmpFile()
  const a = createSoliloquy({ file: f })
  a.open('昨天的线索')
  a.addLine('先记到这里')
  const b = createSoliloquy({ file: f })
  const cur = b.current()
  assert.ok(cur, '新实例能读到旧独白')
  assert.equal(cur.topic, '昨天的线索')
  assert.equal(cur.lines.length, 1)
})

test('决策解析：[沉默]/[独白完]/单句/多句/序号引号清洗', () => {
  assert.deepEqual(chatter.parseDecision('[沉默]'), { silent: true, lines: [] })
  assert.deepEqual(chatter.parseDecision(''), { silent: true, lines: [] })
  const closed = []
  const fakeSoliloquy = { close: (r) => closed.push(r) }
  assert.deepEqual(chatter.parseDecision('[独白完]', fakeSoliloquy), { silent: true, lines: [] })
  assert.deepEqual(closed, ['done'], '独白收尾标记会关闭独白')
  assert.deepEqual(chatter.parseDecision('嗯，这个图标有点丑。'), { silent: false, lines: ['嗯，这个图标有点丑。'] })
  const multi = chatter.parseDecision('诶？这个原理有点意思。\n1. 等等，是不是和炼金术很像？\n「不过材料完全不同呀……」')
  assert.equal(multi.silent, false)
  assert.equal(multi.lines.length, 3, '多行 = 独白候选')
  assert.deepEqual(multi.lines, ['诶？这个原理有点意思。', '等等，是不是和炼金术很像？', '不过材料完全不同呀……'], '序号和引号剥掉')
  assert.equal(chatter.parseDecision('超过四句\n1\n2\n3\n4\n5').lines.length, 4, '最多 4 句')
})

test('朗读配置：0.46.11 起默认必出声（概率 1）/12 句上限；显式关就是关；概率夹 0~1', () => {
  assert.deepEqual(chatter.voiceCfgOf({}), { on: true, chance: 1, dailyMax: 12 })
  assert.equal(chatter.voiceCfgOf({ chatterVoiceOn: false }).on, false)
  assert.equal(chatter.voiceCfgOf({ chatterVoiceChance: 0.3 }).chance, 0.3, '想要老的低频行为可显式配')
  assert.equal(chatter.voiceCfgOf({ chatterVoiceChance: 5 }).chance, 1)
  assert.equal(chatter.voiceCfgOf({ chatterVoiceChance: -2 }).chance, 0)
  // 嘀咕音量：main 侧 sayNarration 按 chatterVoiceVol（默认 0.35）压低音量，链路三段都要在
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  assert.match(main, /chatterVoiceVol/, '嘀咕音量配置键必须在场')
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src/main/petBridge.js'), 'utf8')
  assert.match(bridge, /kind: 'say'.*vol/, 'pet_say 广播必须带 vol')
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/overlay/pet.js'), 'utf8')
  assert.match(pet, /a\.volume = Math\.min\(1, Math\.max\(0\.05, v\)\)/, 'Audio 播放必须应用音量')
  assert.match(pet, /cmd\.vol != null/, 'say 命令必须把 vol 传进朗读链')
})

test('chatter 决策化：tick 到点可以沉默且沉默不占每日预算', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/chatter.js'), 'utf8')
  assert.ok(/\[沉默\]/.test(src), '保持安静是模型的一个选项')
  // 沉默分支不 count++（预算只在真的开口后记）
  const tick = src.slice(src.indexOf('async function tick'))
  assert.ok(/她想了想，决定不说/.test(tick), '沉默分支存在且有日志')
  const silentPart = tick.slice(tick.indexOf('r.silent'), tick.indexOf('} else {'))
  assert.ok(!/count\+\+/.test(silentPart), '沉默不计预算')
  // 多句走独白、单句不硬开独白
  assert.ok(/keep\.length > 1/.test(tick), '多句才开/续独白')
  assert.ok(/soliloquy\.addLine/.test(tick), '说过的话进独白状态')
  // 决策提示词：明确「多数时候可以沉默」
  assert.ok(/多数时候可以沉默/.test(src), '提示词不许逼她说话')
  // 素材：此刻的处境（不许凭空编正在看的东西）
  assert.ok(/和你的嘀咕对不上就别硬扯/.test(src), '活动素材注入且有对不上就别扯的约束')
})

test('自主活动自语：解析 + 限频 + 提示词 + 宿主出口', async () => {
  // 解析
  assert.deepEqual(autonomy.extractSoliloquy('正文\n（自语）诶？这个有点意思。\n（自语）不过材料不同呀。'),
    ['诶？这个有点意思。', '不过材料不同呀。'])
  assert.deepEqual(autonomy.extractSoliloquy('(自语) 唔，再想想。'), ['唔，再想想。'])
  assert.deepEqual(autonomy.extractSoliloquy('普通行'), [])
  // 限频：每场 ≤ max，间隔 ≥ 90s
  let t = 0
  const sent = []
  const now0 = Date.now
  Date.now = () => t
  try {
    // soliMax=2：一次回复里的多行一起出，但总量拦在 2
    const emit = autonomy.soliEmitter({ onSoliloquy: async (l) => sent.push(l), soliMax: 2 }, {})
    await emit('（自语）第一句\n（自语）第二句\n（自语）第三句')
    assert.deepEqual(sent, ['第一句', '第二句'], 'soliMax=2 拦下第三句')
    t += 91 * 1000
    await emit('（自语）隔了一分半的新一句')
    assert.equal(sent.length, 2, '每场上限用完了，隔多久也不再放')
    // 间隔闸：两次回复之间至少 90s
    const sent2 = []
    const emit2 = autonomy.soliEmitter({ onSoliloquy: async (l) => sent2.push(l), soliMax: 10 }, {})
    await emit2('（自语）开场一句')
    await emit2('（自语）紧接着的一句')
    assert.equal(sent2.length, 1, '90s 内的第二次回复不放行')
    t += 91 * 1000
    await emit2('（自语）隔了一分半的一句')
    assert.equal(sent2.length, 2, '间隔够 90s 后放行')
    // soliMax=0 = 全关
    const off = autonomy.soliEmitter({ onSoliloquy: async () => { throw new Error('不该被调') }, soliMax: 0 }, {})
    await off('（自语）不该出口')
  } finally {
    Date.now = now0
  }
  // 提示词进了挡 2/3
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/autonomy.js'), 'utf8')
  assert.ok(/SOLI_PROMPT/.test(src), 'SOLI_PROMPT 定义')
  const sysFree = src.slice(src.indexOf("const sys = [", src.indexOf('挡 3')))
  assert.ok(/SOLI_PROMPT/.test(sysFree), '完全开放挡的 system 带自语节')
  // 宿主出口：自语走 sayNarration（气泡 + 低频朗读），与本体记忆同源，不转 QQ
  const host = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  assert.ok(/onSoliloquy: async \(line\)[\s\S]{0,200}sayNarration\(t, \{ speech: narrationVoiceOn\(\) \}\)/.test(host), '自语出口接 sayNarration')
  assert.ok(/function narrationVoiceOn/.test(host), '朗读判定函数存在')
  // chatter 拿到独白状态与活动素材
  assert.ok(/soliloquy: getSoliloquy\(\)/.test(host), 'chatter 注入独白状态机')
  assert.ok(/activity: \(\) => \{/.test(host), 'chatter 注入活动素材')
})

test('0.46.18 自言自语的语言跟 replyLang 走（三条路径全部接线）', () => {
  const { monologueLangBlock, browseMurmurs } = require('../src/shared/lang-req')
  // 单元：固定语言出块，auto / 空 = 旧行为（跟人设走）
  const blk = monologueLangBlock('ja')
  assert.match(blk, /语言要求·最高优先级/)
  assert.match(blk, /日文/)
  assert.match(blk, /合成语音/)
  assert.equal(monologueLangBlock('auto'), '')
  assert.equal(monologueLangBlock(''), '')
  assert.equal(monologueLangBlock('zh').indexOf('中文') > 0, true)
  // 硬编码嘀咕本地化（runBrowse 出门/发现两句）
  assert.equal(browseMurmurs('ja').going('X'), '「X」ちょっと見てくるね〜')
  assert.match(browseMurmurs('ja').found('HN 机制'), /気になる/)
  assert.match(browseMurmurs('zh').found('X'), /有点意思/)
  // 续接开场白时间词本地化（zh 保持旧文案）
  const a2 = autonomy.carryLineOf({ topic: 'SQL 表结构', t: Date.now() - 20 * 3600000 }, Date.now, 'ja')
  assert.match(a2, /^昨日の/, 'ja 昨天档')
  assert.match(a2, /続きからね/, 'ja 续接句')
  assert.match(autonomy.carryLineOf({ topic: 'X', t: Date.now() - 20 * 3600000 }, Date.now), /^昨天那个/, 'zh 默认不变')
  // 接线（静态）：两份独立提示词代码都必须自己带语言要求——只测一处等于没测
  const chatterSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/chatter.js'), 'utf8')
  assert.ok(/monologueLangBlock\(c\.replyLang\)/.test(chatterSrc), 'chatter 用 cfg.replyLang 算语言块')
  assert.ok(/\.\.\.\(langBlock \? \[\{ role: 'system', content: langBlock \}\] : \[\]\)/.test(chatterSrc), 'chatter 注入语言块 system 消息')
  const autoSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/autonomy.js'), 'utf8')
  assert.ok((autoSrc.match(/monologueLangBlock\(cfg\.replyLang\)/g) || []).length >= 2, 'autonomy 两场 sys 都算语言块')
  assert.ok(/\.\.\.\(langReq \? \[langReq\] : \[\]\)/.test(autoSrc), 'autonomy sys 注入语言块')
  assert.ok(/browseMurmurs\(opt\.cfg && opt\.cfg\.replyLang\)/.test(autoSrc), '出门嘀咕模板带语言')
  assert.ok(/carryLineOf\(carry, now, c\.replyLang\)/.test(autoSrc), '续接开场白带语言')
  const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  assert.ok((hostSrc.match(/replyLang: (?:c|cfg\(\))\.replyLang/g) || []).length >= 2, 'llmCfg 两处都带 replyLang')
})

test('0.46.19 记账接线（第一笔牵挂可写 / user-back 也记站点 / 三处留痕）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/autonomy.js'), 'utf8')
  const m = src.match(/\/\/ 0\.46\.17 品味记账 \+ 牵挂记账[\s\S]*?\} catch \{ \}/)
  assert.ok(m, '收尾记账块存在')
  const blk = m[0]
  assert.ok(!/\n\s*if \(carry\) \{[\s\S]*writeCarry/.test(blk), '第一笔牵挂不许被 if (carry) 包住（先有鸡问题）')
  assert.match(blk, /r\.ok \|\| r\.why === 'user-back'\)\) bumpSite/, '被 user-back 打断的 browse 也记站点（真机今天全是这种）')
  assert.match(blk, /if \(unfinished\) writeCarry/, 'unfinished 直接写牵挂（不依赖旧牵挂存在）')
  assert.match(blk, /else if \(carry && r && r\.ok\) clearCarry/, '销账仍要求确实有旧牵挂')
  assert.match(src, /\[autonomy\] 选题「/, '选题留痕（品味可见）')
  assert.match(src, /\[autonomy\] 去处：/, '去处留痕（站点加权可见）')
  const sessSrc = fs.readFileSync(path.join(__dirname, '..', 'src/assistant/core/core/session.js'), 'utf8')
  assert.match(sessSrc, /logger\.info\('\[recall\]/, '回忆火花命中留痕（此前静默无法验证）')
})

test('0.46.20/0.46.22 嘀咕字幕：等译文再上弹幕（原文先飞走、事后追换看不见——用户实测）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  const a = src.indexOf('async function sayNarration')
  const b = src.indexOf('/** 0.46.0 朗读判定')
  assert.ok(a > 0 && b > a, 'sayNarration 存在')
  const body = src.slice(a, b)
  assert.match(body, /dmHold: !!subtitleTarget\(t, cfg\(\)\.subLang \|\| 'off'\)/, '要翻译时 pet_say 扣住弹幕原文')
  assert.match(body, /subtitleFor\(t\),/, 'sayNarration 内要调 subtitleFor 异步补')
  assert.match(body, /new Promise\(\(r\) => setTimeout\(\(\) => r\(''\), 6000\)\)/, '译文 6 秒封顶，失败兜底')
  assert.match(body, /rr && rr\.dmHeld/, '扣住过才由译文补上弹幕')
  assert.match(body, /dk\.isOn\(\)\) dk\.say\(display \|\| t\)/, '弹幕推译文（译文空推原文兜底）')
  assert.match(body, /petBridge'\)\.subtitle\(\{ text: display \}\)/, '译文经 petBridge.subtitle 换气泡+弹幕')
  assert.match(body, /\[chatter\] 嘀咕字幕/, '命中时留痕')
  // 主动台词同一套（看屏/闹钟/时间观念的出口）
  const sp = src.slice(src.indexOf('async function sayProactive'), src.indexOf('/**\n * 废话通道出口'))
  assert.match(sp, /dmHold: !!subtitleTarget\(t, cfg\(\)\.subLang \|\| 'off'\)/, 'sayProactive 同样扣住')
  assert.match(sp, /r && r\.dmHeld/, 'sayProactive 扣住后推译文')
  // 弹幕侧的替换通道仍在（正常模式气泡出现后的快速替换）
  const pbSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/petBridge.js'), 'utf8')
  assert.match(pbSrc, /danmaku'\)\.replaceLast\(t\)/, 'petBridge.subtitle 要同步换弹幕最后一条')
  assert.match(pbSrc, /async function say \(\{ script, speech, vol, dmHold \} = \{\}\)/, 'pet_say 收 dmHold')
  assert.match(pbSrc, /dmHeld: holdDm/, '返回 dmHeld 让调用方知道要自己补弹幕')
  assert.match(pbSrc, /if \(dm && text && !holdDm\)/, '扣住时不推原文')
})

test('0.46.41 嘀咕入账带译文：等译文回来一起入账（原文先入账=聊天记录全是日语——用户实测「自言自语又不翻译了」）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  const a = src.indexOf('async function sayNarration')
  const b = src.indexOf('/** 0.46.0 朗读判定')
  assert.ok(a > 0 && b > a, 'sayNarration 存在')
  const body = src.slice(a, b)
  assert.match(body, /noteLedger\(display\)/, '译文回来才入账（≤6s race 内）')
  assert.match(body, /sub: display/, '入账带 sub 译文（渲染层原文下挂译文）')
  assert.match(body, /display && display !== t \? \{ sub: display \} : \{\}/, '译文空/与原文相同不带 sub')
  assert.match(body, /catch\(\(\) => noteLedger\(''\)\)/, '翻译挂了也要入账（只入原文，不丢账）')
  assert.ok(!/ledgerNote\(\{ via: 'chatter', assistant: t \}\) \} catch \{ \}\n\s*\/\/ 0\.46\.20/.test(body), '不再有原文先入账的旧写法')
  // 时间线渲染：原文下面挂译文
  const tl = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/companion/app.js'), 'utf8')
  assert.match(tl, /m\.sub && m\.sub !== m\.content \? '<br>' \+ esc\(stripTags\(m\.sub\)\)/, '对话时间线显示译文行')
})

test('0.46.22 闹钟台词现生成：LLM 生成 + 模板兜底，不再固定语句', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  assert.match(src, /async function alarmLine \(label, a, rl\)/, 'alarmLine 生成函数存在')
  assert.match(src, /temperature: 0\.9, maxTokens: 120, timeoutMs: 20000/, '生成参数（有温度才不千篇一律）')
  assert.match(src, /不要引号、不要【】<>动作标记/, '提示词禁动作标记')
  const fa = src.indexOf('async function alarmLine')
  const fb = src.indexOf('function getAlarms ()')
  const head = src.slice(fa, fb)
  assert.match(head, /return String\(txt \|\| ''\)/, '空回统一清洗')
  const body = src.slice(src.indexOf('onFire: (a) => {'), src.indexOf('alarmAdd'))
  assert.match(body, /alarmLine\(label, a, rl\)/, 'onFire 走生成')
  assert.match(body, /\.catch\(\(e\) => \{ log\('\[alarms\] 台词生成失败，用模板/, '生成失败留痕')
  assert.match(body, /line \|\| fallback/, '空/失败回退模板（功能不能哑）')
  assert.match(body, /kind: 'alarm'/, '仍走 sayProactive（负反馈不拦闹钟）')
})

test('0.46.24 闹钟称呼：人设进生成 + 禁称主人 + 模板无ご主人様', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  const fa = src.indexOf('async function alarmLine')
  const fb = src.indexOf('function getAlarms ()')
  const head = src.slice(fa, fb)
  assert.match(head, /character\.get\(\) \|\| \{\}\)\.persona/, '生成要带她自己的人设（不再是泛泛的桌面伙伴）')
  assert.match(head, /不要用「ご主人様／主人」这类称呼/, '称呼禁令进提示词（他明确说过）')
  assert.ok(!/ご主人様に一言だけ/.test(head), 'ask 里不许再印 ご主人様')
  assert.match(head, /\^\(\?:ご主人様\|御主人様\|主人\|マスター\)/, '生成结果后处理剥开头称呼（双保险）')
  const body = src.slice(src.indexOf('onFire: (a) => {'), src.indexOf('alarmAdd'))
  assert.ok(!/ご主人様、\$\{label\}/.test(body), '兜底模板不许再有 ご主人様')
  assert.ok(!/主人，\$\{label\}/.test(body), '兜底模板不许再有 主人')
})

test('0.46.42 复读闸/提示词镜子走 90 分钟时间窗（无界「最近 8 句」横跨几小时：旧台词拦新句+误导模型打转——11-04 14:49~15:02 十几句全被咽回去实锤）', () => {
  const vs = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/voicesim.js'), 'utf8')
  assert.match(vs, /const REPEAT_WINDOW_MS = 90 \* 60 \* 1000/, 'voicesim 有时间窗常量')
  assert.match(vs, /REPEAT_WINDOW_MS \}/, '已导出')
  const inner = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/inner.js'), 'utf8')
  assert.match(inner, /function recentVoices \(n, sinceMs\)/, 'recentVoices 支持时间窗参数')
  assert.match(inner, /!since \|\| \(Number\(e\.t\) \|\| 0\) >= since/, '事件按 t 过滤')
  const chatter = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/chatter.js'), 'utf8')
  const hit1 = (chatter.match(/recentVoices\(8, voicesim\.REPEAT_WINDOW_MS\)/g) || []).length
  assert.ok(hit1 >= 2, 'chatter 的镜子与硬闸都走时间窗（现 ' + hit1 + ' 处）')
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  assert.match(idx, /recentVoices: \(n, sinceMs\) => \{ try \{ return inner\.recentVoices\(n, sinceMs\)/, 'dep 透传时间窗')
  assert.match(idx, /inner\.recentVoices\(6, voicesim\.REPEAT_WINDOW_MS\)/, '黏人阶梯撞车历史走时间窗')
  assert.ok((idx.match(/inner\.recentVoices\(6, voicesim\.REPEAT_WINDOW_MS\)/g) || []).length >= 2, 'nudge 镜子 + proactiveGate extraHistory 都走时间窗')
  const aut = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/autonomy.js'), 'utf8')
  assert.match(aut, /const gameOn = d\.gameOn \|\|/, 'autonomy 游戏模式闸可注入')
  assert.match(aut, /if \(gameOn\(\)\) return/, '游戏模式中不起场')
})

test('0.46.46 复读闸泄压阀（0.46.50 放宽：真机 210 句/天被吞，用户「负反馈还是有些保守了」）：连续咽回去 ≥3 句放行一轮，score≥0.65 的近似原句照拦', () => {
  const chatter = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/chatter.js'), 'utf8')
  assert.match(chatter, /let swallowStreak = 0/, '泄压计数声明')
  assert.match(chatter, /const SWALLOW_ESCAPE = 3/, '泄压阈值放宽=3 句（原 5）')
  assert.match(chatter, /const SWALLOW_ESC_SCORE = 0\.65/, '泄压分数线放宽=0.65（原 0.5，「话题相近内容不同」更容易活）')
  assert.match(chatter, /const escape = swallowStreak >= SWALLOW_ESCAPE/, '达到阈值才泄压')
  assert.match(chatter, /!\(escape && rep\.score < SWALLOW_ESC_SCORE\)/, '泄压只放 score<0.65 的话题句，最像的变体照吞')
  assert.match(chatter, /swallowStreak\+\+/, '每吞一句计数+1')
  assert.match(chatter, /if \(keep\.length\) swallowStreak = 0/, '放行即归零')
  assert.match(chatter, /连续咽回去 ' \+ swallowStreak \+ ' 句，泄压放行一轮/, '泄压留痕')
})

test('0.46.50 被吞句变资产：咽回去的话落 suppress 事件（日记「想说说没说」+ 念头池低频漏出），不再无痕消失', () => {
  const chatter = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/chatter.js'), 'utf8')
  assert.match(chatter, /const noteSwallowed = deps\.noteSwallowed \|\| null/, '宿主注入吞句入账回调')
  assert.match(chatter, /const swallowedRecent = deps\.swallowedRecent \|\| \(\(\) => \[\]\)/, '宿主注入念头池读取')
  assert.match(chatter, /if \(noteSwallowed\) noteSwallowed\(line\)/, '复读闸吞掉的每一句都入账（原来只进日志）')
  assert.match(chatter, /【你刚才想过又咽回去的话/, 'decide 注入念头池素材块')
  assert.match(chatter, /别原样照搬（原样会再被收回去一次）/, '注入块明确要求变形（防漏出即撞车死循环）')
  const inner = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/inner.js'), 'utf8')
  assert.match(inner, /function suppressRecent \(n, sinceMs\)/, 'inner 提供念头池读取（suppress 事件）')
  assert.match(inner, /e\.kind === 'suppress'/, '只取 suppress 类型——绝不进 recentVoices 镜子')
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  assert.match(idx, /noteSwallowed: \(text\) => \{ try \{ inner\.noteSuppress\(text\) \} catch \{ \} \}/, '宿主接线：吞句 → noteSuppress')
  assert.match(idx, /inner\.suppressRecent\(n, 2 \* 60 \* 60 \* 1000\)/, '宿主接线：念头池取近 2 小时')
  // goals 驱动自主选题
  assert.match(idx, /0\.46\.50 她自己立的目标进选题池/, 'autonomyPool 读 active goals')
  assert.match(idx, /if \(gt\.length\) out\.thoughts = gt/, 'goals 进 thoughts（pickTopic 最高优先来源）')
})

test('0.46.48 朗读中断即作废：新朗读顶掉旧合成（Fish signal 取消 + 本地队列 cancelPending + 渲染层代次丢弃）——聊天到后面了别再念前面的（用户 22:47 实锤）', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/index.js'), 'utf8')
  assert.match(idx, /let speakRunSeq = 0/, '主进程朗读代次声明')
  assert.match(idx, /if \(speakAbortCtl\) speakAbortCtl\.abort\(\)/, '新请求 abort 旧的云端合成')
  assert.match(idx, /signal: ac\.signal/, 'Fish/云端请求接取消信号')
  assert.match(idx, /require\('\.\/ttsLocal'\)\.cancelPending\('朗读已被新的打断'\)/, '入口作废本地兜底排队与正在跑的任务')
  assert.ok((idx.match(/if \(my !== speakRunSeq\) return \{ ok: false, stale: true/g) || []).length >= 3, '合成成功/本地兜底成功返回前都查代次（≥3 处）')
  assert.match(idx, /if \(my !== speakRunSeq \|\| ac\.signal\.aborted\) return \{ ok: false, stale: true/, '被顶掉的请求不再走本地回退链')
  const tts = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/tts.js'), 'utf8')
  assert.match(tts, /AbortSignal\.any\(\[opts\.signal, timeout\]\)/, '取消信号与 30s 超时并存（不因接取消丢超时）')
  assert.match(tts, /tagDensity = 0, signal/, 'speakFish 解构并透传 signal')
  const local = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/ttsLocal.js'), 'utf8')
  assert.match(local, /function cancelPending \(reason\)/, '本地合成取消函数')
  assert.match(local, /state\.queue = \[\]\s*\n\s*if \(state\.current\) state\.current\.cancelled = true/, '排队未开始直接作废+正在跑的打标记')
  assert.match(local, /if \(job\.cancelled\) throw new Error\('朗读已被新的打断（分片/, 'IndexTTS 分片循环每片之间检查取消')
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/overlay/pet.js'), 'utf8')
  assert.match(pet, /let readSeq = 0/, '渲染层朗读代次声明')
  assert.match(pet, /const my = \+\+readSeq\s*\n\s*try \{ stopVoice\(\) \} catch \{ \}/, '新朗读意图立即打断正在播的旧语音')
  assert.match(pet, /if \(my !== readSeq\) return false \/\/ 合成期间来了新朗读 → 这份作废/, '过期合成结果丢弃不播')
})
