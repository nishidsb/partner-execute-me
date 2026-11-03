// 生成 src/renderer/shared/spine-words.js（莱莎 spine 动作中文目录 + 词→动画组映射）
// 数据源：userData companion assets 下各皮肤的 *_gesture.json（MotionGroups），
// 中文词典 1:1 对照抄自 AgentAtelierR 权威源（勿改语义）：
//   C:/Users/username/Documents/agentatelierR/AgentAtelierR-1.0.4.1/scripts/export_ryza_motion_catalog.cjs
//   （其生成的报告 docs/RYZA_MOTION_GROUP_CATALOG.md 为坐姿 95 组 / 站姿 53 组完整解析，
//     核对日期 2026-09-13；资源或词典变更后重跑该脚本重新核对）
// 0.46.8 修复：SIT_HAND 键位错位（三位键 vs 两位捕获）、sitEhMap hack 丢组、b_01/02/03 抄错，
//   目录从 sit 30 组补全到 95 组、标注「资源注明不使用」组（fg_017/122/123/124/222/223/224）。
// 重跑：node tools/gen-spine-words.js
const fs = require('fs')
const path = require('path')

const ASSET_DIR = 'C:/Users/username/AppData/Roaming/ryza-assistant-app/companion/assets/workspaceid'
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'spine-words.js')

// ---- 权威词典（1:1 抄自 export_ryza_motion_catalog.cjs，勿随意改动语义） ----
// 站姿双手组合（grp_fg_000~004）
const STAND_FG = `
000|双臂自然默认姿势|恢复站姿手位
001|双手叉腰|自信、不服气、展示成果
002|双手抱臂|思考、质疑
003|双手轻摆／挥动|问候、轻快回应
004|双手在背后交握|拘谨、害羞、轻松等待`
// 站姿单手：f=左手（002~005）/ g=右手（002~009），编号含义两侧不同，不能共用（0.46.8 拆开）
const STAND_HAND_F = `
002|叉腰|自信、强调
003|放到右臂|抱臂的左侧构成
004|轻摆|单手问候
005|放到身后|含蓄、放松`
const STAND_HAND_G = `
002|叉腰|自信、强调
003|放到左臂|抱臂的右侧构成
004|轻摆|单手问候
005|放到身后|含蓄、放松
006|呈猫爪状轻轻抬起|俏皮、轻微打趣
007|向前伸出|邀请、递手、说明
008|耳语姿势|悄悄话
009|触碰脸颊|触脸、思索`
// 坐姿肩部／双臂整体 B（7 组）
const SIT_B = `
01|转动肩膀|放松肩部、久坐伸展
02|双手叠放|安静倾听、拘谨等待
03|双手叉腰|自信展示、佯装不满
05|抱臂|思考、质疑、有主见地回应
07|双手放在胸前|真诚回应、惊喜、珍惜
12|左右伸展／伸懒腰|疲惫后舒展、放松
13|双手放在大腿内侧|收敛、拘谨坐姿`
// 坐姿腿部整体 C（5 组）
const SIT_C = `
01|双脚晃荡|轻松等待、活泼闲聊
02|改变腿部角度／放松腿姿|长时间坐着时调整姿势
03|膝盖开合|坐姿细节，避免频繁触发
04|调整大腿高度|身体重心与坐姿调整
05|盘腿姿态|切换至适配的盘腿表现`
// 坐姿躯干倾斜与晃动 EH（7 组）
const SIT_EH = `
10|身体轻晃待机|低强度闲聊、等待
20|身体倾斜待机|倾听、自然换重心
30|身体上下弹动|轻快回应；需控制频率
40|向后倾斜|拉开距离、后仰反应
50|向左倾斜|侧身倾听
60|向右倾斜|侧身倾听
70|向前倾斜|靠近倾听、表示兴趣`
// 坐姿左腿 I / 右腿 J（各 2 组）
const SIT_I = `
01|左脚晃荡|轻松待机
02|活动左侧盘腿|盘腿姿态的小调整`
const SIT_J = `
01|右脚晃荡|轻松待机
02|活动右侧盘腿|盘腿姿态的小调整`
// 坐姿双手组合（grp_fg_016~033；017 资源注明不使用，保留条目但不出词）
const SIT_FG = `
016|双手比耶|明确比耶请求、拍照、庆祝
017|双手托腮版本（原注明不使用）|资源注明不使用，不推荐选择
018|耳语姿势|悄悄话、ASMR 场景
019|张开手掌触碰|伸掌互动；并非一定触到目标
020|「嘘」手势|示意安静、保密
021|双手指向手势|指示、介绍或说明
022|双手叠放在大腿上|安静、礼貌地坐着
023|双手抱臂组合|思考、质疑
024|双手拍手|鼓励、祝贺、明确拍手请求
025|双手放在沙发上|放松支撑、待机
026|双手放在大腿上|自然倾听、安静回应
027|盘腿专用双手|仅配合允许的盘腿姿势
028|展示双掌、挥手告别|告别、双手挥动
029|展示双掌、慌张摆动|惊慌、不知所措
030|双手握拳打气|庆祝、鼓劲
031|双手向前伸出／拥抱姿势|邀请拥抱、迎接；不代表完成接触
032|双掌示意「等一下」|制止、请求暂停
033|双手挥手问候|问候、告别`
// 坐姿单手编号 → 中文（grp_fg_1XX=左手 / 2XX=右手；键为两位数，与正则捕获一致——0.46.8 修复）
// 22/23/24 资源注明不使用，保留条目但不出词
const SIT_HAND = `
01|通常位置|放松、自然待机
02|放在腰间|单手叉腰、自信回应
06|放在下巴附近|思考、倾听；不是挠头
07|放在嘴边|犹豫、轻声回应
08|放在眼睛附近|眼部动作；不能只凭标签认定擦泪
09|放在太阳穴附近|思索、困扰
10|放在头部|触头动作；不能保证是挠头
11|遮住嘴部|害羞、轻笑
15|抱枕相关动作|仅在抱枕、姿态适配时使用
16|比耶|单手比耶、拍照
17|托腮|放松倾听、俏皮互动
18|耳语配套姿势|悄悄话
19|张开手掌触碰|伸掌互动
20|「嘘」手势|安静、保密
21|指向手势|介绍、指示
22|大腿叠手的单手片段（原注明不使用）|资源注明不使用，不推荐单独选择
23|抱臂的单手片段（原注明不使用）|资源注明不使用，不推荐单独选择
24|拍手的单手片段（原注明不使用）|资源注明不使用，不推荐单独选择
25|放在沙发上|放松支撑
26|放在大腿上|自然倾听
27|盘腿专用手位|仅配合盘腿姿态
28|展示手掌、挥手告别|单手告别
29|展示手掌、慌张摆动|慌张、惊讶
30|握拳打气|鼓励、兴奋
31|向用户方向伸出|邀请、迎接
32|掌心示意「等一下」|制止、暂停
33|抬至胸口高度问候|轻幅问候`
// 权威词典的两处单手特例覆盖（export 脚本 L103-104）
const SIT_HAND_OVERRIDE = {
  118: ['左手放在胸前（耳语的配套手位）', '悄悄话、配合另一只手的耳语姿势'],
  217: ['右手放在沙发上（托腮的配套支撑手）', '配合左手托腮；右手本身不是托腮']
}

const parseDict = (t) => Object.fromEntries(t.trim().split('\n').map(l => { const [id, zh, use] = l.split('|'); return [id, { zh, use: use || '' }] }))
const standFg = parseDict(STAND_FG), standHandF = parseDict(STAND_HAND_F), standHandG = parseDict(STAND_HAND_G)
const sitB = parseDict(SIT_B), sitC = parseDict(SIT_C), sitEh = parseDict(SIT_EH)
const sitI = parseDict(SIT_I), sitJ = parseDict(SIT_J), sitFg = parseDict(SIT_FG), sitHand = parseDict(SIT_HAND)
const eZh = ['左右摇晃', '前后摇晃', '向左倾斜', '向右倾斜', '前倾', '后仰']
const hZh = ['上下运动', '上下运动（两循环）', '左右运动', '左右运动（两循环）', '扭捏小动作', '摆腰']
// 站姿 EH 的 use 按权威规则：h=5 局促害羞 / e=5 感兴趣靠近 / e=6 意外后退 / 其余待机变化
const standEhUse = (e, h) => h === 5 ? '局促、害羞时的身体层表现' : e === 5 ? '感兴趣、靠近倾听的身体层表现' : e === 6 ? '意外、后退反应的身体层表现' : '待机或对话的身体层变化，需控制幅度和频率'

function buildCatalog (file, kind) {
  const j = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, file), 'utf8'))
  const groups = {}
  for (const m of j.emotionalGesture.MotionGroups) {
    const g = groups[m.GroupId] || (groups[m.GroupId] = { anims: new Set() })
    for (const k of ['AnimName_1', 'AnimName_2']) if (m[k]) g.anims.add(m[k])
    // 资源 Label 注明「使わない」（不使用）的组打 off 标记（0.46.8）
    if (String(m.Label || '').includes('使わない')) g.off = true
  }
  const out = {}
  for (const [id, g] of Object.entries(groups)) {
    let zh = '', use = '', layer = ''
    if (kind === 'stand') {
      let m
      if ((m = id.match(/^grp_fg_(\d{3})$/)) && standFg[m[1]]) { ({ zh, use } = standFg[m[1]]); layer = 'FG' } else if ((m = id.match(/^grp_fg_f_(\d{3})$/)) && standHandF[m[1]]) { zh = '左手' + standHandF[m[1]].zh; use = standHandF[m[1]].use; layer = 'FG' } else if ((m = id.match(/^grp_fg_g_(\d{3})$/)) && standHandG[m[1]]) { zh = '右手' + standHandG[m[1]].zh; use = standHandG[m[1]].use; layer = 'FG' } else if ((m = id.match(/^grp_eh_(\d)(\d)$/))) { zh = eZh[+m[1] - 1] + '＋' + hZh[+m[2] - 1]; use = standEhUse(+m[1], +m[2]); layer = 'EH' }
    } else {
      let m
      if ((m = id.match(/^grp_b_(\d+)$/)) && sitB[m[1]]) { ({ zh, use } = sitB[m[1]]); layer = 'B' } else if ((m = id.match(/^grp_c_(\d+)$/)) && sitC[m[1]]) { ({ zh, use } = sitC[m[1]]); layer = 'C' } else if ((m = id.match(/^grp_eh_(\d+)$/)) && sitEh[m[1]]) { ({ zh, use } = sitEh[m[1]]); layer = 'EH' } else if ((m = id.match(/^grp_i_(\d+)$/)) && sitI[m[1]]) { ({ zh, use } = sitI[m[1]]); layer = 'I' } else if ((m = id.match(/^grp_j_(\d+)$/)) && sitJ[m[1]]) { ({ zh, use } = sitJ[m[1]]); layer = 'J' } else if ((m = id.match(/^grp_fg_(\d{3})$/))) {
        const n = m[1]
        layer = 'FG'
        if (sitFg[n]) { ({ zh, use } = sitFg[n]) } else if (sitHand[n.slice(1)] && n[0] === '1') { zh = '左手' + sitHand[n.slice(1)].zh; use = sitHand[n.slice(1)].use } else if (sitHand[n.slice(1)] && n[0] === '2') { zh = '右手' + sitHand[n.slice(1)].zh; use = sitHand[n.slice(1)].use }
        if (SIT_HAND_OVERRIDE[n]) { [zh, use] = SIT_HAND_OVERRIDE[n] }
        if (g.off && zh) { zh += '（资源注明不使用）' }
      }
    }
    if (zh) out[id] = { zh, use, anims: [...g.anims], layer, ...(g.off ? { off: true } : {}) }
  }
  return out
}

const catalog = {
  stand: buildCatalog('crf_skn_002_0001_99_gesture.json', 'stand'),
  sit: buildCatalog('crf_skn_002_0001_01_gesture.json', 'sit')
}

// ---- 词 → 动画组（按词典用法人工挑选，全部有出处） ----
const WORD_MAP = {
  '挥手': { stand: 'grp_fg_003', sit: 'grp_fg_033' },
  '打招呼': { stand: 'grp_fg_003', sit: 'grp_fg_033' },
  '你好': { stand: 'grp_fg_003', sit: 'grp_fg_033' },
  '再见': { stand: 'grp_fg_003', sit: 'grp_fg_028' },
  '拜拜': { stand: 'grp_fg_003', sit: 'grp_fg_028' },
  '叉腰': { stand: 'grp_fg_001', sit: 'grp_fg_102' },
  '双手叉腰': { sit: 'grp_b_03' },
  '抱臂': { stand: 'grp_fg_002', sit: 'grp_fg_023' },
  '害羞': { stand: 'grp_fg_004', sit: 'grp_fg_111' },
  '拘谨': { stand: 'grp_fg_004', sit: 'grp_b_13' },
  '过来': { stand: 'grp_fg_g_007', sit: 'grp_fg_031' },
  '邀请': { stand: 'grp_fg_g_007', sit: 'grp_fg_031' },
  '抱抱': { sit: 'grp_fg_031' },
  '卖萌': { stand: 'grp_fg_g_006', sit: 'grp_fg_016' },
  '猫爪': { stand: 'grp_fg_g_006' },
  '嘘': { sit: 'grp_fg_020' },
  '小声点': { sit: 'grp_fg_020' },
  '拍手': { sit: 'grp_fg_024' },
  '鼓掌': { sit: 'grp_fg_024' },
  '加油': { sit: 'grp_fg_030' },
  '打气': { sit: 'grp_fg_030' },
  '比耶': { sit: 'grp_fg_016' },
  '拍照': { sit: 'grp_fg_016' },
  '耳语': { sit: 'grp_fg_018' },
  '悄悄话': { sit: 'grp_fg_018' },
  '伸懒腰': { sit: 'grp_b_12' },
  '晃脚': { sit: 'grp_c_01' },
  '慌张': { sit: 'grp_fg_029' },
  '吓一跳': { sit: 'grp_fg_029' },
  '等一下': { sit: 'grp_fg_032' },
  // 0.46.8：托腮从 grp_fg_017（资源注明不使用）改到左手托腮 grp_fg_117
  '托腮': { sit: 'grp_fg_117' }
}

// ---- 自动扩词：目录里每个动作组至少有一个词。从 zh（权威词典标签）与 use（用途说明）
// 自动派生词候选；手工词永不覆盖；同词先到先得；「资源注明不使用」的组不出词（0.46.8）。
function cleanWord (s) {
  return String(s || '')
    .replace(/（[^）]*）/g, '')   // 去括注：上下运动（两循环）→ 上下运动
    .replace(/^[·・]\s*/, '')
    .trim()
}
function wordCandidates (info) {
  const out = []
  if (info.off || /？|未标注|不使用/.test(info.zh + info.use)) return out
  const zh = cleanWord(info.zh)
  if (zh && zh.length >= 2) {
    out.push(zh)
    // 两循环变体是独立的动作（同姿势循环两次），给独立词：xxx·两循环
    if (/（两循环）/.test(info.zh)) out.push(zh + '·两循环')
    for (const seg of info.zh.split(/[／、＋]/)) {
      const c = cleanWord(seg)
      if (c && c.length >= 2 && c !== zh) out.push(c)
    }
  }
  for (const seg of String(info.use || '').split('、')) {
    const c = cleanWord(seg)
    // 剔掉不像「命令词」的：待机变体说明、纯调整性描述、含分号的整句说明
    if (c && c.length >= 2 && !/？|未标注|待机|细节|调整|切换|构成|专用|适配|相关|表现|不使用|挠头|擦泪|；/.test(c)) out.push(c)
  }
  return out
}
const AUTO_RANK = (id) =>
  /^grp_fg_\d{3}$/.test(id) ? 0 :      // 双手组合最优先
  /^grp_fg_[fg]_/.test(id) ? 1 :       // 站姿单手
  /^grp_fg_[12]\d{2}$/.test(id) ? 2 :  // 坐姿单手
  3                                     // 身体/腿/倾斜层
let autoAdded = 0
for (const sk of ['stand', 'sit']) {
  // 「配套」组（如 217 托腮支撑手）最后认领词，把自然词让给独立组（0.46.8）
  const isPair = (id) => /配套/.test(catalog[sk][id].zh) ? 1 : 0
  const ids = Object.keys(catalog[sk]).sort((a, b) => AUTO_RANK(a) - AUTO_RANK(b) || isPair(a) - isPair(b) || a.localeCompare(b))
  for (const id of ids) {
    for (const w of wordCandidates(catalog[sk][id])) {
      if (WORD_MAP[w]) { // 已有词（手工或先到）：补另一骨架的映射也收，但不改主词
        if (!WORD_MAP[w][sk]) WORD_MAP[w][sk] = id
        continue
      }
      WORD_MAP[w] = { [sk]: id }
      autoAdded++
    }
  }
}

// 覆盖兜底：先到先得可能让后面的组无词可认（如 grp_fg_217 配套支撑手抢走 225 的自然词）。
// 对仍无词的非 off 组依次尝试：去括注 zh → 完整 zh（含括注）→ 组 id，取第一个未被占用的。
const covered0 = new Set()
for (const e of Object.values(WORD_MAP)) { if (e.stand) covered0.add('stand:' + e.stand); if (e.sit) covered0.add('sit:' + e.sit) }
for (const sk of ['stand', 'sit']) {
  for (const [id, info] of Object.entries(catalog[sk])) {
    if (info.off || covered0.has(sk + ':' + id)) continue
    for (const w of [cleanWord(info.zh), info.zh, id]) {
      if (w && !WORD_MAP[w]) { WORD_MAP[w] = { [sk]: id }; autoAdded++; break }
      if (w && WORD_MAP[w] && !WORD_MAP[w][sk]) { WORD_MAP[w][sk] = id; break }
    }
  }
}

const js = '/* 由 tools/gen-spine-words.js 生成，不要手改（重跑：node tools/gen-spine-words.js） */\n' +
  '/* 词典 1:1 对照 AgentAtelierR scripts/export_ryza_motion_catalog.cjs（0.46.8 核对） */\n' +
  ';(function (root) {\n' +
  '  root.SPINE_GROUP_CATALOG = ' + JSON.stringify(catalog) + '\n' +
  '  root.SPINE_WORD_MAP = ' + JSON.stringify(WORD_MAP) + '\n' +
  "})(typeof window !== 'undefined' ? window : globalThis)\n"
fs.writeFileSync(OUT, js)
console.log('written', OUT)
console.log('stand 组数:', Object.keys(catalog.stand).length, '| sit 组数:', Object.keys(catalog.sit).length)
console.log('off（资源注明不使用）组:', Object.values(catalog).flatMap(c => Object.entries(c)).filter(([, v]) => v.off).map(([k]) => k).join(',') || '无')
console.log('词表总数:', Object.keys(WORD_MAP).length, '（手工 ' + (Object.keys(WORD_MAP).length - autoAdded) + ' + 自动 ' + autoAdded + '）')
// 覆盖率自检：每个有中文名的动作组都应至少挂在一个词上（off 组豁免）
const covered = new Set()
for (const [w, e] of Object.entries(WORD_MAP)) { if (e.stand) covered.add('stand:' + e.stand); if (e.sit) covered.add('sit:' + e.sit) }
for (const sk of ['stand', 'sit']) {
  const miss = Object.keys(catalog[sk]).filter((id) => !catalog[sk][id].off && !covered.has(sk + ':' + id))
  console.log(sk + ' 未覆盖组:', miss.length ? miss.join(',') : '无')
}
