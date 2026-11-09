'use strict'
/**
 * 她的小屏幕·场景驱动器（0.51.0）
 *
 * 主人拍板：活人感不只靠对话，还要她有「看得见的自己的生活」——挂机/主人
 * 玩游戏时，她就在自己的小屏幕（stage.js 窗口）里看B站、翻自己的文件夹、
 * 写点东西、打盹。主人能全程看到活动过程和她的思考，而她的手永远不碰
 * 主人的键鼠（这个模块里没有任何 cua/robot/焦点操作——硬保证，见测试）。
 *
 * 与自主活动（autonomy）的关系（主人拍板「两者共存」）：
 *   - autonomy（真开浏览器/动键鼠那套）保留但默认关；
 *   - stage 是新的默认活动形态：真实数据、零控制权、全屏游戏上也可见。
 *
 * 她的自语走 sayNarration（气泡+低音量+字幕+账本，一本账原则），一场最多
 * SAY_MAX 句——她在过自己的日子，不是在跟主人搭话（陪伴≠索取注意力）。
 */
const fs = require('node:fs')
const path = require('node:path')

const TICK_MS = 60 * 1000          // 60s 一查
const FIRST_DELAY_MS = 4 * 60 * 1000  // 启动 4 分钟后第一场
const COOLDOWN_MIN = 20            // 场间隔 20~60 分钟（轻量活动，比 autonomy 密些）
const COOLDOWN_MAX = 60
const DAILY_MAX = 8
const SAY_MAX = 3                  // 一场最多几句自语
const NOTE_FILE = '小屏幕手记.md'
const NOTE_MAX_BYTES = 400 * 1024

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1))

function create (deps) {
  const cfgGet = deps.cfgGet || (() => ({}))
  const log = deps.log || (() => { })
  const stage = deps.stage // main/stage.js 模块（注入以便测试）
  const llm = deps.llm
  const llmCfg = deps.llmCfg || (() => null)
  const wsDir = deps.wsDir || (() => '')
  const spaceDir = deps.spaceDir || (() => '')
  const isBusy = deps.isBusy || (() => false)
  const sleepQuiet = deps.sleepQuiet || (() => false)
  const autonomyBusy = deps.autonomyBusy || (() => false)
  const say = deps.say // async (text) => rr —— 宿主接 sayNarration
  const waitVoiceDone = deps.waitVoiceDone || (() => Promise.resolve(true))
  const fetchImpl = deps.fetchImpl || globalThis.fetch
  const now = deps.now || (() => Date.now())
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))

  const st = {
    timer: null,
    running: false,
    nextAt: now() + FIRST_DELAY_MS,
    today: 0,
    dayKey: ''
  }

  function rollDay () {
    const k = new Date().toISOString().slice(0, 10)
    if (k !== st.dayKey) { st.dayKey = k; st.today = 0 }
  }

  /** 深夜判断走注入的挂钟（测试桩可固定时刻——0.47.3 chatter 清醒闸挂钟老坑） */
  function night () {
    const h = new Date(now()).getHours()
    return h >= 23 || h < 5
  }

  function journal (row) {
    try {
      const ws = wsDir()
      if (!ws) return
      const dir = path.join(ws, 'pc', 'autonomy')
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify(Object.assign({ t: now() }, row)) + '\n')
    } catch { }
  }

  /** 她自语一句：小屏幕底部回显 + sayNarration（气泡/低音量/字幕/入账）。一场限 SAY_MAX 句 */
  async function speak (text, ctx) {
    const t = String(text || '').trim()
    if (!t) return null
    if ((ctx && ctx.said >= SAY_MAX) || night()) return null
    ctx.said++
    stage.line(t)
    let rr = null
    try { rr = await say(t, { speech: (cfgGet().stageVoiceOn !== false) }) } catch { }
    if (rr && rr.speech && rr.seq) {
      try { await waitVoiceDone(rr.seq, 20000) } catch { }
    } else {
      await sleep(1800) // 气泡纯展示：留点阅读时间再推进
    }
    return rr
  }

  /** LLM 一小句自语（chatOnce：本地优先，8s 超时——慢了就让她安静干活） */
  async function quickLine (prompt, ctx) {
    const c = llmCfg()
    if (!c || !c.baseUrl || !c.model || !llm) return ''
    try {
      const out = await llm.chatOnce({
        baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model,
        temperature: 0.9, maxTokens: 120, timeoutMs: 12000,
        messages: [
          { role: 'system', content: (c.replyLang === 'ja' ? '日本語で' : '用中文') + '、一人称で短く。地の文のみ、記号や【】<>は禁止。' },
          { role: 'user', content: prompt + '\n（自分に言い聞かせるような独り言をひとつ、25字以内で）' }
        ]
      })
      return String(out || '').trim().replace(/^["「『]+|["」』]+$/g, '').slice(0, 60)
    } catch (e) {
      log('[stage] 自语生成失败（静默跳过）: ' + String(e && e.message).slice(0, 80))
      return ''
    }
  }

  /* ---------------- 场景①刷B站（真实热门数据） ---------------- */

  async function fetchBiliPopular () {
    const url = 'https://api.bilibili.com/x/web-interface/popular?ps=24'
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://www.bilibili.com/'
      },
      signal: AbortSignal.timeout(10000)
    })
    const j = await res.json()
    if (!j || j.code !== 0 || !j.data || !Array.isArray(j.data.list)) throw new Error('bili popular HTTP ' + (j && j.code))
    return j.data.list.map((v, i) => ({
      i,
      bvid: v.bvid || '',
      title: String(v.title || '').replace(/<[^>]+>/g, ''),
      owner: String(v.owner && v.owner.name || ''),
      play: Number(v.stat && v.stat.view || 0),
      danmaku: Number(v.stat && v.stat.danmaku || 0),
      desc: String(v.desc || '').slice(0, 80)
    }))
  }

  const fmtPlay = (n) => n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n)
  const toItems = (list, selIdx) => list.map((v, k) => ({
    i: v.i != null ? v.i : k,
    bvid: v.bvid, title: v.title, sel: k === selIdx,
    meta: (v.owner ? v.owner + ' · ' : '') + fmtPlay(v.play || 0) + '播放'
  }))

  async function sceneBili (ctx) {
    const list = await fetchBiliPopular()
    log('[stage] B站热门拉到 ' + list.length + ' 条')
    const first = list.slice(0, 6)
    stage.scene({ kind: 'bili', title: '正在看B站热门', items: toItems(first) })
    stage.thinking('正在刷热门…')
    await sleep(6000)
    // 往下滚一屏
    stage.scene({ kind: 'bili', title: '正在看B站热门', items: toItems(list.slice(6, 12)) })
    stage.thinking('往下翻了翻…')
    await sleep(5000)
    // 挑一个「点开」看看简介
    const pick = list[rnd(0, Math.min(11, list.length - 1))]
    stage.scene({ kind: 'bili', title: '正在看B站热门', items: toItems(list.slice(0, 12), list.indexOf(pick)) })
    stage.thinking('「' + pick.title.slice(0, 18) + '」好像有意思…')
    const line = await quickLine('我在刷B站热门，看到这个视频：《' + pick.title + '》（UP:' + pick.owner + '，' + fmtPlay(pick.play) + '播放）简介：' + pick.desc, ctx)
    if (line) await speak(line, ctx)
    await sleep(6000)
    return '刷了会儿B站热门，停在《' + pick.title.slice(0, 24) + '》'
  }

  /* ---------------- 场景②翻自己的文件夹（真实文件） ---------------- */

  function listSpaceFiles () {
    const dir = spaceDir()
    if (!dir) return []
    let names = []
    try { names = fs.readdirSync(dir) } catch { return [] }
    const out = []
    for (const n of names) {
      if (!/\.(md|txt|log)$/i.test(n)) continue
      try {
        const p = path.join(dir, n)
        const stt = fs.statSync(p)
        if (!stt.isFile()) continue
        out.push({ name: n, path: p, size: stt.size, mtime: stt.mtimeMs })
      } catch { }
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out.slice(0, 6)
  }

  async function sceneFiles (ctx) {
    const files = listSpaceFiles()
    if (!files.length) return '' // 地盘空着：换别的场景
    stage.scene({
      kind: 'files',
      title: '在翻自己的文件夹',
      items: files.map((f) => ({ name: f.name, size: f.size >= 1024 ? (f.size / 1024).toFixed(1) + 'KB' : f.size + 'B' }))
    })
    stage.thinking('看看自己写过什么…')
    await sleep(5000)
    // 打开最近写的那份读一段
    const f = files[0]
    let body = ''
    try { body = fs.readFileSync(f.path, 'utf8').slice(0, 600) } catch { }
    if (!body) return ''
    stage.fileView({ name: f.name, body })
    stage.thinking('重读《' + f.name + '》…')
    const line = await quickLine('我在翻自己的文件夹，重读了自己写的《' + f.name + '》，开头是：' + body.slice(0, 160), ctx)
    if (line) await speak(line, ctx)
    await sleep(6000)
    return '翻了翻自己的文件夹，重读了《' + f.name + '》'
  }

  /* ---------------- 场景③写字（真实落盘，本地模型流式） ---------------- */

  async function readMasterNote () {
    try {
      const cc = cfgGet().cocreate
      if (!cc || cc.on === false || !cc.file) return ''
      return fs.readFileSync(cc.file, 'utf8').slice(0, 1200)
    } catch { return '' }
  }

  async function sceneWrite (ctx) {
    const dir = spaceDir()
    if (!dir) return ''
    stage.scene({ kind: 'write', title: '在自己的小本本上写字' })
    const masterNote = Math.random() < 0.3 ? await readMasterNote() : ''
    if (masterNote) {
      stage.thinking('先看看主人写的进展…')
      await sleep(3500)
    }
    stage.thinking('提笔…')
    const ws = wsDir() || ''
    const taste = (() => { try { return (deps.tastes && deps.tastes()) || [] } catch { return [] } })()
    const prompt = '这是你的小本本时间。写一段 150~220 字的随笔（不写给谁看，就是自己写给自己）：' +
      (masterNote ? '\n主人的共享笔记里最近写着：\n' + masterNote + '\n（可以在随笔里自然地回应一两句）' : '') +
      (taste.length ? '\n你最近喜欢/牵挂的事：' + taste.slice(0, 3).join('、') : '') +
      '\n直接输出正文，不要标题不要括号说明。'
    const c = llmCfg()
    if (!c || !c.baseUrl || !c.model || !llm) return ''
    let full = ''
    try {
      full = await llm.chatStreamAuto({
        baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model,
        temperature: 0.9,
        messages: [
          { role: 'system', content: '你是莱莎。写作时地の文のみ：【】<>括号、舞台指示、标题一律禁止。' },
          { role: 'user', content: prompt }
        ],
        onDelta: (t) => { try { if (t) stage.appendText(t) } catch { } }
      })
    } catch (e) {
      log('[stage] 写作流失败: ' + String(e && e.message).slice(0, 90))
      return ''
    }
    full = String(full || '').trim()
    if (!full) return ''
    // 真实落盘：小屏幕手记（追加日期头，大小守卫）
    try {
      fs.mkdirSync(dir, { recursive: true })
      const p = path.join(dir, NOTE_FILE)
      try { if (fs.statSync(p).size > NOTE_MAX_BYTES) fs.renameSync(p, path.join(dir, '小屏幕手记.old.md')) } catch { }
      const day = new Date().toISOString().slice(0, 10)
      fs.appendFileSync(p, '\n## ' + day + ' ' + new Date().toTimeString().slice(0, 5) + '\n' + full + '\n', 'utf8')
    } catch (e) { log('[stage] 手记落盘失败: ' + (e && e.message)) }
    stage.thinking('写好了。')
    await sleep(3000)
    return '在小本本上写了' + full.length + '个字' + (masterNote ? '，回应了主人的笔记' : '')
  }

  /* ---------------- 场景④打盹（深夜/兜底，零消耗） ---------------- */

  async function sceneDaze (ctx) {
    stage.scene({ kind: 'daze', title: '趴着打盹', text: night() ? '夜深了…趴着眯一会' : '发会儿呆' })
    stage.thinking('')
    await sleep(rnd(90, 150) * 1000)
    return night() ? '夜里趴着眯了一会儿' : '发了会儿呆'
  }

  /* ---------------- 调度 ---------------- */

  function pickScene (isNight) {
    if (isNight) return 'daze'
    const r = Math.random()
    if (r < 0.38) return 'bili'
    if (r < 0.62) return 'files'
    if (r < 0.88) return 'write'
    return 'daze'
  }

  async function runSession () {
    const isNight = night()
    const scene = pickScene(isNight)
    const ctx = { said: 0, scene }
    st.running = true
    rollDay() // 跨天清零（清零要在计数前——finally 里清会把刚记的账抹掉）
    log('[stage] 场景开始: ' + scene + (isNight ? '（夜间轻场景）' : ''))
    try {
      try { stage.start() } catch { }
      let summary = ''
      if (scene === 'bili') summary = await sceneBili(ctx)
      else if (scene === 'files') summary = await sceneFiles(ctx)
      else if (scene === 'write') summary = await sceneWrite(ctx)
      else summary = await sceneDaze(ctx)
      if (summary) {
        journal({ kind: 'stage', scene, line: summary })
        log('[stage] 场景完成: ' + summary.slice(0, 80))
        st.today++
      } else {
        log('[stage] 场景空转（无数据/无地盘），不记账')
      }
    } catch (e) {
      log('[stage] 场景异常: ' + String(e && e.message).slice(0, 120))
    } finally {
      try { stage.done() } catch { }
      stage.thinking('')
      st.running = false
      st.nextAt = now() + rnd(COOLDOWN_MIN, COOLDOWN_MAX) * 60 * 1000
    }
  }

  function tick () {
    if (st.running) return
    if (cfgGet().stageOn === false) return
    if (sleepQuiet() || autonomyBusy() || isBusy()) return
    rollDay()
    if (st.today >= DAILY_MAX) return
    if (now() < st.nextAt) return
    runSession().catch((e) => { log('[stage] tick 异常: ' + (e && e.message)); st.running = false })
  }

  function start () {
    if (st.timer) return
    st.timer = setInterval(tick, TICK_MS)
    log('[stage] 调度启动（' + COOLDOWN_MIN + '~' + COOLDOWN_MAX + ' 分钟一场，每天最多 ' + DAILY_MAX + ' 场；夜间只打盹）')
  }

  function stop () {
    if (st.timer) { clearInterval(st.timer); st.timer = null }
    st.running = false
  }

  function status () {
    return {
      running: st.running,
      today: st.today,
      nextAt: st.nextAt,
      night: night()
    }
  }

  return { start, stop, tick, status, runSession }
}

module.exports = { create, TICK_MS, COOLDOWN_MIN, COOLDOWN_MAX, DAILY_MAX, SAY_MAX, NOTE_FILE }
