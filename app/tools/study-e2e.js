#!/usr/bin/env node
/* 学习监督语气端到端（0.45.68）
 *
 * 验证一件事：她生气的时候，说的是不是**真的越来越凶**。
 * 状态机算出「该说什么」很容易，难的是说出来的话有没有分层——
 * 如果四档情绪全是同一句「你怎么不学习呀」，这个功能就是个复读机。
 *
 * 这里走真实模型 + 真实 persona + 真实 fillHint，打印出来的就是她会说的话。
 * 跑法：env -u ELECTRON_RUN_AS_NODE npx electron tools/study-e2e.js
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')

const origLoad = Module._load
Module._load = function (req) {
  if (/(^|\/)logger$/.test(String(req))) return { log: () => { } }
  return origLoad.apply(this, arguments)
}

const { app } = require('electron')
const SW = require('../src/main/companion/studyWatch')

function appData () {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
}

function loadCfg () {
  try {
    const g = (JSON.parse(fs.readFileSync(path.join(appData(), 'ryza-assistant-app', 'config.json'), 'utf8')).global || {}).companion || {}
    return { baseUrl: (g.apiBaseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, ''), apiKey: g.apiKey || '', model: g.apiModel || 'deepseek-flash' }
  } catch { return { baseUrl: '', apiKey: '', model: '' } }
}

/** 当前角色的人设（跟应用里用的是同一份） */
function persona () {
  try {
    const dir = path.join(appData(), 'ryza-assistant-app', 'companion')
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'characters.json'), 'utf8'))
    const arr = Array.isArray(list) ? list : (list.items || list.list || [])
    let cur = ''
    try {
      const a = JSON.parse(fs.readFileSync(path.join(appData(), 'ryza-assistant-app', 'assistant', 'config.json'), 'utf8'))
      cur = a.currentRole || ''
    } catch { }
    const c = arr.find((x) => x && x.id === cur) || arr[0] || {}
    return String(c.persona || '').slice(0, 900)
  } catch { return '' }
}

function makeSt (over) {
  const st = SW.start(Date.now(), { goal: '行测和申论', targetMin: 120 })
  return Object.assign(st, over, { startedAt: Date.now() - 62 * 60000 })
}

const CASES = [
  {
    kind: 'mild_fun',
    st: makeSt({ heat: 28, strikes: 1, lastV: 'fun', lastWhat: 'B站视频《异世界番 第4话》，播到 12:34' }),
    want: '小生气：说出看到了什么，委屈+提醒，不骂人'
  },
  {
    kind: 'angry',
    st: makeSt({ heat: 62, strikes: 2, lastV: 'fun', lastWhat: 'Steam 里在打游戏，成就弹窗刚跳出来' }),
    want: '真生气：短句、直白、不哄人，指出反复'
  },
  {
    kind: 'furious',
    st: makeSt({ heat: 92, strikes: 3, lastV: 'fun', lastWhat: '抖音刷短视频，同一个博主连着几个' }),
    want: '彻底生气：很重、冷淡、表示不陪了'
  },
  {
    kind: 'recover',
    st: makeSt({ heat: 22, strikes: 1, lastV: 'study', lastWhat: '粉笔题库做资料分析，第 8/20 题' }),
    want: '台阶：装淡定地说「这才对」'
  },
  {
    kind: 'streak',
    st: makeSt({ heat: 0, strikes: 0, streak: 3, lastV: 'study', lastWhat: 'Word 里写申论大作文' }),
    want: '夸：连着三次都在学'
  },
  {
    kind: 'sulk_back',
    st: makeSt({ heat: 42, strikes: 3, lastV: 'fun' }),
    want: '台阶但还带气：问学不学，不道歉不软太快'
  }
]

/**
 * 与 index.js 的 makeWatchLine 保持**同一份 prompt 结构**（0.45.69）。
 * 分开写两份 prompt 是老毛病：测出来的话不是线上会说的话，等于没测。
 */
async function gen (cfg, per, hint, opt) {
  const o = opt || {}
  const url = /\/chat\/completions$/.test(cfg.baseUrl) ? cfg.baseUrl : cfg.baseUrl + '/chat/completions'
  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'system',
        content: per + '\n\n（场景：你们说好今天要学习，你会自己偷偷看他屏幕。你说话就是你本人当下要说的话，' +
          '不是助手、不是提示音、不是复读机。）'
      },
      {
        role: 'user',
        content: '【当前情境】\n' + hint +
          (o.moodLine ? '\n\n' + o.moodLine : '') +
          (o.recent ? '\n\n' + o.recent : '') +
          '\n\n现在是你主动开口，不是回复对方。要求：' +
          '\n1. 只输出你要说的话本身，不要解释、不要加引号、不要写旁白（不要写「（皱眉）」这类），不要换行；' +
          '\n2. 必须提到你这次**具体**看到了什么（说得出细节才像真的看了一眼）；' +
          '\n3. 不要套用客套话、不要说教、不要每次都一个句式，也别复述上面「你最近说过」的内容；' +
          '\n4. 长度按情境来：小生气一两句，真生气更短更硬。' +
          '\n语言：只使用中文。'
      }
    ],
    temperature: Math.min(1.25, 0.95 + (Number(o.attempt) || 0) * 0.12),
    stream: false
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160))
  const j = await res.json()
  const t = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim()
  return t.replace(/^["'「『]|["'」』]$/g, '').replace(/\s*\n+\s*/g, ' ').slice(0, 140)
}

/** 字符 trigram 的 Jaccard 相似度：判断「是不是同一句话换了个说法」 */
function sim (a, b) {
  const grams = (x) => {
    const t = String(x).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    const out = new Set()
    for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3))
    return out
  }
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return hit / (A.size + B.size - hit)
}

async function main () {
  const cfg = loadCfg()
  if (!cfg.apiKey) { console.error('没有 apiKey'); app.exit(1); return }
  const per = persona()
  console.log('角色人设：' + (per ? per.slice(0, 60).replace(/\n/g, ' ') + '…' : '(没读到，用空人设)'))
  console.log('模型：' + cfg.model + '\n')

  // 线上每条都会带上「她此刻的情绪数值」（makeWatchLine 里从 self.getState 读）
  const moodLine = '你此刻的自我状态：心情 0.38（0=很差 1=很好），冷淡度 0.42（越高越不想热络）。'

  const rows = []
  for (const c of CASES) {
    const hint = SW.fillHint(c.kind, c.st)
    let line = ''
    try { line = await gen(cfg, per, hint, { moodLine: moodLine }) } catch (e) { line = 'ERROR ' + e.message }
    rows.push({ kind: c.kind, line: line, len: line.length })
    console.log('【' + c.kind + '】' + c.want)
    console.log('  「' + line + '」  （' + line.length + ' 字）\n')
  }

  /* 0.45.69 关键验证：用户明确要求「不要固定语句」。
     同一个情境连说三次（把她刚说的话塞进 recentSay），三次必须互不相似——
     否则说明模型在背模板，那和写死台词没本质区别。 */
  console.log('=== 同一情境连说三次（检验「不是背台词」）===')
  const st0 = makeSt({ heat: 30, strikes: 1, lastV: 'fun', lastWhat: 'B站视频《异世界番 第4话》，播到 12:34' })
  const got = []
  for (let i = 0; i < 3; i++) {
    const hint = SW.fillHint('mild_fun', st0)
    let line = ''
    try { line = await gen(cfg, per, hint, { moodLine: moodLine, attempt: i }) } catch (e) { line = 'ERROR ' + e.message }
    got.push(line)
    console.log('  第' + (i + 1) + '次：「' + line + '」')
    SW.noteSaid(st0, line)          // 下一次生成会看到这句，被要求不许重复
  }
  let maxSim = 0
  for (let i = 0; i < got.length; i++) {
    for (let j = i + 1; j < got.length; j++) maxSim = Math.max(maxSim, sim(got[i], got[j]))
  }
  console.log('  两两最高相似度：' + maxSim.toFixed(2) +
    (maxSim < 0.5 ? '（够不一样，不是背台词）' : '（⚠ 太像了，说明在套同一个模板）'))

  const intro = rows.find((r) => r.kind === 'mild_fun')
  const fury = rows.find((r) => r.kind === 'furious')
  if (intro && fury) {
    console.log('\n长度对比：小生气 ' + intro.len + ' 字 → 彻底生气 ' + fury.len + ' 字' +
      (fury.len <= intro.len + 4 ? '（变短了，符合「越气话越少」）' : '（⚠ 彻底生气反而更长，可能太话痨）'))
  }
  console.log('\n以上是她真会说的话，请人工看语气有没有分层、有没有复读。')
  app.exit(0)
}

app.whenReady().then(main).catch((e) => { console.error(String(e && e.message)); app.exit(1) })
