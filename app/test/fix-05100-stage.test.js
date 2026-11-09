'use strict'
/**
 * 0.51.0 她的小屏幕（stage）测试
 *
 * 主人拍板的硬保证是本文件的灵魂：不抢焦点、鼠标永真穿透、零键鼠操作、
 * 全屏游戏上也可见。任何一条被后来者改坏，这里必须当场红。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const R = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8')

/* ---------------- 静态接线 ---------------- */

test('0.51.0 stage 窗口：不抢控制权三硬保证', () => {
  const src = R('../src/main/stage.js')
  assert.ok(src.includes('focusable: false'), '硬保证①：永不抢焦点')
  assert.ok(src.includes('setIgnoreMouseEvents(true)'), '硬保证②：鼠标永真穿透')
  assert.ok(src.includes('visibleOnFullScreen: true'), '硬保证③：全屏游戏上也可见')
  // 外部副作用红线：她的「看B站/开文件」全在小屏幕里演，绝不开真窗口（按调用判定，注释说明不算）
  assert.ok(!/shell\.openExternal\(/.test(src), 'stage.js 不得 shell.openExternal')
  assert.ok(!/globalShortcut\.register\(/.test(src), 'stage.js 不得注册全局热键')
})

test('0.51.0 stageRunner：零键鼠零窗口硬保证', () => {
  const src = R('../src/main/companion/stageRunner.js')
  // 按 require/调用判定，注释里说明性的「cua」不算
  assert.ok(!/require\([^)]*cua/.test(src), 'stageRunner 不得 require cua')
  assert.ok(!/require\([^)]*robotjs/.test(src), 'stageRunner 不得 require robotjs')
  assert.ok(!/keyTap\(|mouseClick\(|sendInputEvent\(|pressKey\(/.test(src), '零键鼠调用')
  assert.ok(!/openExternal\(/.test(src), '零外部副作用')
  assert.ok(!/BrowserWindow/.test(src), 'stageRunner 自己不开窗口（窗口在 stage.js）')
  assert.ok(src.includes('SAY_MAX = 3'), '一场自语上限 3 句（陪伴≠刷屏）')
})

test('0.51.0 宿主接线：stageRunner 注入 + sayNarration 一本账', () => {
  const idx = R('../src/main/companion/index.js')
  assert.ok(idx.includes("require('../stage')"), 'main/stage 窗口模块接入')
  assert.ok(idx.includes("require('./stageRunner')"), 'stageRunner 接入')
  assert.ok(idx.includes('say: sayNarration'), '嘀咕走 sayNarration（一本账原则）')
  assert.ok(idx.includes('autonomyBusy:'), '与 autonomy 互斥避让')
  assert.ok(idx.includes('stageOn: c.stageOn !== false'), 'stageOn 默认开')
  // 主人拍板「两者共存」：autonomy 代码默认保持关（真的会动键鼠）
  assert.ok(idx.includes('autonomyOn: c.autonomyOn === true'), 'autonomyOn 默认关不变')
})

test('0.51.0 设置页接线：开关小节四语齐备', () => {
  const html = R('../src/renderer/companion/index.html')
  assert.ok(html.includes('cpStageOn'), 'html 开关')
  assert.ok(html.includes('cpStageVoice'), 'html 嘀咕声开关')
  const app = R('../src/renderer/companion/app.js')
  assert.ok(app.includes('stageOn:'), 'cpGather 采集')
  for (const lang of ['zh', 'zh-Hant', 'ja', 'en']) {
    const s = R('../src/renderer/shared/i18n/strings.' + lang + '.js')
    assert.ok(s.includes('stage:'), lang + ' 字典有 pcprofile.stage')
    assert.ok(s.includes('stageVoice:'), lang + ' 字典有 pcprofile.stageVoice')
  }
})

test('0.51.0 渲染层桥：只下发不往上收', () => {
  const pre = R('../src/preload/stage.js')
  assert.ok(!pre.includes('ipcRenderer.send('), '渲染层不得向主进程发消息（纯画布）')
  assert.ok(pre.includes('onScene') && pre.includes('onFileView'), '场景/阅读视图通道齐')
})

/* ---------------- 单测（全桩注入，挂钟可控） ---------------- */

function mkEnv (over = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-test-'))
  const ws = path.join(tmp, 'ws')
  fs.mkdirSync(path.join(ws, 'her-space'), { recursive: true })
  const calls = { scenes: [], thinks: [], appends: [], lines: [], fileViews: [], done: 0, says: [] }
  const stageStub = {
    start () { },
    stop () { },
    done () { calls.done++ },
    scene (p) { calls.scenes.push(p) },
    thinking (t) { calls.thinks.push(t) },
    appendText (t) { calls.appends.push(t) },
    fileView (p) { calls.fileViews.push(p) },
    line (t) { calls.lines.push(t) }
  }
  const env = {
    clock: new Date('2026-11-10T14:00:00+08:00').getTime(),
    stage: stageStub,
    calls,
    ws,
    space: path.join(ws, 'her-space'),
    cfg: { stageOn: true, stageVoiceOn: true },
    biliOk: true,
    llmLine: 'ふーん、これ面白そう…'
  }
  const { create } = require('../src/main/companion/stageRunner.js')
  // over 里属于 env 的数据字段先进 env（clock/cfg/biliOk/llmLine），其余当 dep 覆盖
  const { clock, cfg, biliOk, llmLine, ...depOver } = over
  if (clock !== undefined) env.clock = clock
  if (cfg !== undefined) env.cfg = cfg
  if (biliOk !== undefined) env.biliOk = biliOk
  if (llmLine !== undefined) env.llmLine = llmLine
  const deps = {
    cfgGet: () => env.cfg,
    log: () => { },
    stage: env.stage,
    llm: {
      chatOnce: async () => env.llmLine,
      chatStreamAuto: async (args) => {
        if (args.onDelta) args.onDelta('テスト。')
        return 'テスト。今日は静かだった。'
      }
    },
    llmCfg: () => ({ baseUrl: 'http://x', apiKey: 'k', model: 'm', replyLang: 'ja' }),
    wsDir: () => env.ws,
    spaceDir: () => env.space,
    isBusy: () => false,
    sleepQuiet: () => false,
    autonomyBusy: () => false,
    say: async (t) => { calls.says.push(t); return { seq: calls.says.length, speech: true } },
    waitVoiceDone: async () => true,
    fetchImpl: async () => {
      if (!env.biliOk) throw new Error('network down')
      const rows = Array.from({ length: 12 }, (_v, i) => ({
        bvid: 'BV' + i,
        title: '视频' + i,
        owner: { name: 'UP' + i },
        stat: { view: 10000 + i, danmaku: 5 },
        desc: '简介' + i
      }))
      return { json: async () => ({ code: 0, data: { list: rows } }) }
    },
    now: () => env.clock,
    sleep: async () => { }
  }
  Object.assign(deps, depOver)
  const inst = create(deps)
  return { inst, env, tmp }
}

test('0.51.0 bili 场景：真实数据上屏 + 自语限量 + 记账', async () => {
  const { inst, env, tmp } = mkEnv()
  const origRnd = Math.random
  Math.random = () => 0.1 // → bili
  try {
    await inst.runSession()
  } finally {
    Math.random = origRnd
  }
  assert.strictEqual(env.calls.scenes[0].kind, 'bili', 'bili 场景骨架')
  assert.strictEqual(env.calls.scenes[0].items.length, 6, '第一屏 6 条真实热门')
  assert.ok(env.calls.scenes.some((s) => s.items.some((v) => v.sel)), '有挑中的视频高亮')
  assert.strictEqual(env.calls.says.length, 1, 'bili 场景 1 句自语')
  assert.strictEqual(env.calls.lines[0], env.llmLine, '小屏幕底部回显她的话')
  const jf = path.join(tmp, 'ws', 'pc', 'autonomy', 'journal.jsonl')
  assert.ok(fs.existsSync(jf), 'journal 记账落盘')
  assert.ok(fs.readFileSync(jf, 'utf8').includes('"kind":"stage"'), '记账带 stage 标记')
  assert.ok(env.calls.done >= 1, '收场 done')
})

test('0.51.0 files 场景：翻真实文件夹 + 打开重读', async () => {
  const { inst, env } = mkEnv()
  fs.writeFileSync(path.join(env.space, '旧作.md'), '# 我的小项目\n\n第一段写的是构思。'.repeat(20))
  const origRnd = Math.random
  Math.random = () => 0.5 // → files
  try {
    await inst.runSession()
  } finally {
    Math.random = origRnd
  }
  assert.strictEqual(env.calls.scenes[0].kind, 'files')
  assert.strictEqual(env.calls.scenes[0].items[0].name, '旧作.md', '真实文件名上屏')
  assert.strictEqual(env.calls.fileViews.length, 1, '打开最近一份阅读视图')
  assert.ok(env.calls.fileViews[0].body.includes('第一段'), '读的是真实内容')
})

test('0.51.0 write 场景：本地模型流式写字 + 真实落盘', async () => {
  const { inst, env } = mkEnv()
  const origRnd = Math.random
  Math.random = () => 0.7 // → write
  try {
    await inst.runSession()
  } finally {
    Math.random = origRnd
  }
  assert.strictEqual(env.calls.scenes[0].kind, 'write')
  assert.ok(env.calls.appends.length >= 1, '逐字上屏至少一次')
  const note = path.join(env.space, '小屏幕手记.md')
  assert.ok(fs.existsSync(note), '小屏幕手记真实落盘')
  assert.ok(fs.readFileSync(note, 'utf8').includes('テスト'), '流式产出内容在盘上')
})

test('0.51.0 深夜：只打盹、零自语', async () => {
  const { inst, env } = mkEnv({ clock: new Date('2026-11-10T01:00:00+08:00').getTime() })
  const origRnd = Math.random
  Math.random = () => 0.1 // 就算抽到 bili，夜间也要被压成 daze
  try {
    await inst.runSession()
  } finally {
    Math.random = origRnd
  }
  assert.strictEqual(env.calls.scenes[0].kind, 'daze', '夜间强制轻场景')
  assert.strictEqual(env.calls.says.length, 0, '深夜不说话')
})

test('0.51.0 闸门：busy/晚安静默/autonomy 会场/每日上限/冷却', async () => {
  for (const gate of ['isBusy', 'sleepQuiet', 'autonomyBusy']) {
    const { inst } = mkEnv({ [gate]: () => true })
    await inst.tick()
    assert.strictEqual(inst.status().running, false, gate + ' 时不起场')
  }
  // 每日上限：DAILY_MAX=8
  const { inst, env } = mkEnv()
  const origRnd = Math.random
  Math.random = () => 0.9 // → daze（最便宜）
  try {
    for (let i = 0; i < 8; i++) { env.clock += 30 * 60 * 1000; await inst.runSession() }
    const before = inst.status().today
    assert.strictEqual(before, 8, '8 场记账')
    env.clock += 30 * 60 * 1000
    await inst.tick()
    assert.strictEqual(inst.status().running, false, '到量不再起场')
  } finally {
    Math.random = origRnd
  }
  // 冷却：runSession 后 nextAt 在未来，tick 不起场
  const { inst: inst2, env: env2 } = mkEnv()
  Math.random = () => 0.9
  try {
    await inst2.runSession()
    assert.ok(inst2.status().nextAt > env2.clock, '冷却排在未来')
    await inst2.tick()
    assert.strictEqual(inst2.status().running, false, '冷却期内不起场')
  } finally {
    Math.random = origRnd
  }
  // 关闭开关：直接不起场
  const { inst: inst3 } = mkEnv({ cfg: { stageOn: false } })
  await inst3.tick()
  assert.strictEqual(inst3.status().running, false, 'stageOn=false 不起场')
})
