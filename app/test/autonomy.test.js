/**
 * 0.43.0 她自己用电脑（autonomy）
 *
 * 这个模块真的会按 Ctrl+W。所以测试的重点不是「流程对不对」，
 * 而是**在每一种没确认清楚的情况下，它一个键都不能按**——
 * 关错一个标签页的代价，比「她出去看了却什么都没看」大得多。
 */
const test = require('node:test')
const assert = require('node:assert')

const a = require('../src/main/companion/autonomy')

function cuaStub (calls, opts = {}) {
  return {
    invoke: async (name, args) => {
      calls.push({ name, args })
      if (opts.deferred) return { deferred: true, reason: '用户在用电脑' }
      if (opts.throwOn === name) throw new Error('引擎不可用')
      return { ok: true }
    }
  }
}

function fgSeq (list) {
  let i = 0
  return async () => list[Math.min(i++, list.length - 1)]
}

const base = {
  topic: '显卡驱动',
  site: a.SITES[1],   // 0.46.32 起 SITES[0]=bili 的挡1场是「看视频」（runVideoWatch）；浏览器流程用例统一用 zhihu
  openUrl: async () => { },
  sleep: async () => { },
  log: () => { }
}

test('autonomy: 话题优先「她自己在想的」，其次才是画像主题', () => {
  assert.equal(a.pickTopic({ thoughts: ['那个 bug'], themes: ['显卡'] }, () => 0), '那个 bug')
  assert.equal(a.pickTopic({ thoughts: [], themes: ['显卡', '考研'] }, () => 0), '显卡')
  assert.equal(a.pickTopic({}, () => 0), '', '什么都没有就不出门，不许硬编一个')
  assert.equal(a.pickTopic({ themes: ['x'] }, () => 0), '', '一个字的词不要')
})

test('autonomy: 冷却落在 45~120 分钟，且偏向短段（不是均匀排班）', () => {
  const lo = a.COOLDOWN_MIN * 60 * 1000
  const hi = a.COOLDOWN_MAX * 60 * 1000
  let short = 0
  for (let i = 0; i < 400; i++) {
    const ms = a.nextCooldownMs()
    assert.ok(ms >= lo && ms <= hi, '越界：' + ms)
    if (ms <= lo * 2) short++
  }
  assert.ok(short / 400 > 0.7, '短段应占多数（否则会长得像定时任务）')
})

test('autonomy: 拿不到前台窗口 → 不开、不按键', async () => {
  const calls = []
  const r = await a.runBrowse({ ...base, cua: cuaStub(calls), foreground: async () => null })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'no-foreground')
  assert.equal(calls.length, 0, '不知道现在前台是什么，就什么都不能做')
})

test('autonomy: 打开了但前台没变（等于没打开）→ 一个键都不按', async () => {
  const calls = []
  const r = await a.runBrowse({
    ...base,
    cua: cuaStub(calls),
    foreground: async () => ({ pn: 'Code', title: 'main.js', hwnd: 1 })
  })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'not-opened')
  assert.equal(calls.length, 0)
})

test('autonomy: 确认到浏览器 → 翻两下再关掉（不是打开就停在那儿）', async () => {
  const calls = []
  const r = await a.runBrowse({
    ...base,
    cua: cuaStub(calls),
    foreground: fgSeq([
      { pn: 'Code', title: 'main.js', hwnd: 1 },
      { pn: 'msedge', title: '显卡驱动 - 哔哩哔哩', hwnd: 2 },
      { pn: 'msedge', title: '显卡驱动 - 哔哩哔哩', hwnd: 2 },
      { pn: 'msedge', title: '某个教程 - 哔哩哔哩', hwnd: 2 },
      { pn: 'msedge', title: '某个教程 - 哔哩哔哩', hwnd: 2 }
    ])
  })
  assert.equal(r.ok, true)
  assert.equal(r.closed, true)
  assert.equal(calls.filter((c) => c.name === 'scroll').length, 2, '要真的往下翻')
  assert.ok(calls.some((c) => c.name === 'key' && c.args.keys === 'ctrl+w'), '收尾必须关掉')
  assert.ok(r.seen.length >= 2, '翻动之后标题变了，要记下来')
  // 绝不允许打字 / 点击
  assert.equal(calls.filter((c) => c.name === 'type').length, 0)
  assert.equal(calls.filter((c) => c.name === 'click').length, 0)
})

test('autonomy: 收尾前主人回来了（前台不再是浏览器）→ 绝不按 Ctrl+W', async () => {
  const calls = []
  const r = await a.runBrowse({
    ...base,
    cua: cuaStub(calls),
    foreground: fgSeq([
      { pn: 'Code', title: 'main.js', hwnd: 1 },
      { pn: 'msedge', title: '显卡驱动 - 哔哩哔哩', hwnd: 2 },
      { pn: 'msedge', title: 'x', hwnd: 2 },
      { pn: 'msedge', title: 'y', hwnd: 2 },
      { pn: 'winword', title: '方案.docx', hwnd: 9 }
    ])
  })
  assert.equal(r.ok, true)
  assert.equal(r.closed, false)
  assert.equal(r.why, 'done-open')
  assert.equal(calls.filter((c) => c.name === 'key').length, 0, '前台是 Word 时按 Ctrl+W 会关掉他的文档')
})

test('autonomy: 滚动被守卫挡下（主人正在用）→ 收尾，不再折腾', async () => {
  const calls = []
  const r = await a.runBrowse({
    ...base,
    cua: cuaStub(calls, { deferred: true }),
    foreground: fgSeq([
      { pn: 'Code', title: 'main.js', hwnd: 1 },
      { pn: 'msedge', title: '显卡驱动 - 哔哩哔哩', hwnd: 2 },
      { pn: 'msedge', title: '显卡驱动 - 哔哩哔哩', hwnd: 2 }
    ])
  })
  assert.equal(r.ok, true)
  assert.equal(r.closed, false, 'deferred 表示没真的按下去')
  assert.ok(r.seen.length >= 1)
})

test('autonomy: 「她看了什么」是一句人话，不是 URL', () => {
  const line = a.lineOf({ ok: true, seen: ['显卡驱动怎么装 - 哔哩哔哩', '某个教程 - 哔哩哔哩'] })
  assert.match(line, /自己跑去看了会儿/)
  assert.doesNotMatch(line, /http/)
  assert.equal(a.lineOf({ ok: false }), '')
  assert.equal(a.lineOf({ ok: true, seen: [] }), '')
})

test('autonomy: 调度器关着的时候什么都不做', async () => {
  let ticked = 0
  const inst = a.create({
    cfgGet: () => ({ autonomyOn: false }),
    idleSec: () => 9999,
    pool: () => ({ themes: ['显卡'] }),
    cua: { invoke: async () => { ticked++; return {} } },
    openUrl: async () => { ticked++ },
    now: () => Date.now(),
    rand: () => 0
  })
  await inst.tick()
  assert.equal(ticked, 0)
  assert.equal(inst.status().on, false)
})

test('autonomy: 主人在的时候不做（5 分钟是硬门槛）', async () => {
  let opened = 0
  const inst = a.create({
    cfgGet: () => ({ autonomyOn: true }),
    idleSec: () => 4 * 60,               // 4 分钟：还不够
    pool: () => ({ themes: ['显卡'] }),
    cua: { invoke: async () => ({}) },
    openUrl: async () => { opened++ },
    now: () => Date.now(),
    rand: () => 0
  })
  await inst.tick()
  assert.equal(opened, 0)
})

test('0.46.42 autonomy: 主人全屏游戏/看视频（游戏模式开）时不起场——自主活动会开窗/alt+tab，会把全屏顶掉（11-04 14:56 omofun 实锤）', async () => {
  const dir = tmpSpace()
  let opened = 0
  const llmPath = require.resolve('../src/main/companion/llm')
  const orig = require.cache[llmPath]
  require.cache[llmPath] = {
    id: llmPath, filename: llmPath, loaded: true,
    exports: { chatStream: async () => ({ content: '我整理了笔记' }), chatOnce: async () => '', listModels: async () => [] }
  }
  try {
    const inst = a.create({
      cfgGet: () => ({ autonomyOn: true, autonomyLevel: 2, autonomyDir: dir }),
      idleSec: () => 9999,               // 键鼠空闲足够长（看视频本来就不动键鼠）
      gameOn: () => true,                // 游戏模式开着
      pool: () => ({}),
      llmCfg: () => ({ model: 'x' }),
      cua: { invoke: async () => ({}) },
      openUrl: async () => { opened++ },
      now: () => Date.now(),
      rand: () => 0
    })
    await inst.tick()
    assert.equal(inst.status().todayCount, 0, '游戏模式中不起场')
    // 闸门关闭后恢复起场
    const inst2 = a.create({
      cfgGet: () => ({ autonomyOn: true, autonomyLevel: 2, autonomyDir: dir }),
      idleSec: () => 9999,
      gameOn: () => false,
      pool: () => ({}),
      llmCfg: () => ({ model: 'x' }),
      cua: { invoke: async () => ({}) },
      openUrl: async () => { opened++ },
      now: () => Date.now(),
      rand: () => 0
    })
    await inst2.tick()
    assert.equal(inst2.status().todayCount, 1, '游戏模式关了照常起场')
  } finally {
    if (orig) require.cache[llmPath] = orig; else delete require.cache[llmPath]
  }
})

test('0.46.42 autonomy: gameOn 未注入时默认读 gameMode.state()，模块不可用如实返回 false', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/companion/autonomy.js'), 'utf8')
  assert.match(src, /const gameOn = d\.gameOn \|\| \(\(\) => \{ try \{ return require\('\.\.\/gameMode'\)\.state\(\)\.on \} catch \{ return false \} \}\)/, '默认依赖 gameMode.state().on（可注入）')
  assert.match(src, /if \(gameOn\(\)\) return\s+\/\/ 0\.46\.42/, 'tick 闸门里有游戏模式判断')
})

/* ==================== 0.45.0 三挡位 ==================== */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function tmpSpace () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'her-space-'))
}

test('autonomy: 挡位选择——3 缺 LLM 会降到挡 1，绝不硬跑', () => {
  assert.deepEqual(a.pickRunner({}, true), { level: 1, kind: 'browse' })
  assert.deepEqual(a.pickRunner({ autonomyLevel: 2 }, true), { level: 2, kind: 'space' })
  assert.deepEqual(a.pickRunner({ autonomyLevel: 3 }, true), { level: 3, kind: 'free' })
  assert.deepEqual(a.pickRunner({ autonomyLevel: 3 }, false), { level: 1, kind: 'browse' })
  assert.deepEqual(a.pickRunner({ autonomyLevel: 9 }, true), { level: 3, kind: 'free' })
  assert.deepEqual(a.pickRunner({ autonomyLevel: -2 }, true), { level: 1, kind: 'browse' })
})

test('autonomy: 地盘路径守卫——..、绝对路径、空路径全部拦下', () => {
  const dir = 'C:/tmp/her-space'
  assert.ok(a.spaceGuard(dir, 'notes/a.md'), '内部路径放行')
  assert.equal(a.spaceGuard(dir, '../outside.txt'), null, '.. 逃逸')
  assert.equal(a.spaceGuard(dir, 'a/../../x'), null, '多层 .. 逃逸')
  assert.equal(a.spaceGuard(dir, 'C:/Windows/system32/x'), null, '绝对路径越界')
  assert.equal(a.spaceGuard(dir, ''), null, '空路径')
  assert.equal(a.spaceGuard('', 'a.txt'), null, '没地盘就什么都不许')
})

test('autonomy: 地盘工具——写读追加列删移全链路 + 全程留日志', async () => {
  const dir = tmpSpace()
  const journal = []
  const sp = a.spaceToolsOf(dir, { journal: (e) => journal.push(e) })
  assert.equal(await sp.exec('space_write', { path: '笔记.md', content: '# 我的地盘\n' }), '已写入')
  assert.ok((await sp.exec('space_read', { path: '笔记.md' })).includes('我的地盘'))
  assert.equal(await sp.exec('space_append', { path: '笔记.md', content: '今天看了看驱动' }), '已追加')
  assert.ok((await sp.exec('space_list', {})).includes('笔记.md'))
  assert.equal(await sp.exec('space_move', { from: '笔记.md', to: '子/日记.md' }), '已移动')
  assert.equal(await sp.exec('space_read', { path: '子/日记.md' }).then(s => s.includes('驱动')), true)
  assert.equal(await sp.exec('space_delete', { path: '子/日记.md' }), '已删除')
  // 日志：7 个动作全留痕
  const kinds = journal.map((e) => e.kind)
  for (const k of ['write', 'read', 'append', 'list', 'move', 'delete']) {
    assert.ok(kinds.includes(k), '日志缺 ' + k)
  }
})

test('autonomy: 地盘工具越界一律拒绝且不落盘', async () => {
  const dir = tmpSpace()
  const outside = path.join(path.dirname(dir), 'outside-secret.txt')
  fs.writeFileSync(outside, '机密')
  const sp = a.spaceToolsOf(dir, { journal: () => { } })
  assert.ok((await sp.exec('space_read', { path: outside })).includes('越界') || (await sp.exec('space_read', { path: outside })).includes('越'), '读外面被拦')
  assert.equal(await sp.exec('space_write', { path: '../evil.txt', content: 'x' }), '路径越界')
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')))
  assert.equal(fs.readFileSync(outside, 'utf8'), '机密', '外面文件原封不动')
  // 目录不许删
  fs.mkdirSync(path.join(dir, 'sub'))
  assert.ok((await sp.exec('space_delete', { path: 'sub' })).includes('目录'), '目录删除被拒')
  // open_url 白名单
  assert.ok((await sp.exec('open_url', { url: 'https://evil.example.com/x' })).includes('允许'))
})

test('autonomy: 主人回来，地盘工具立刻闭嘴', async () => {
  const dir = tmpSpace()
  let stopped = 0
  const sp = a.spaceToolsOf(dir, {
    journal: () => { },
    userBack: () => true,   // 主人回来了
    onUserBack: () => { stopped++ }
  })
  const r = await sp.exec('space_write', { path: 'x.md', content: 'y' })
  assert.ok(r.includes('停止'), '拒绝动作')
  assert.equal(stopped, 1)
  assert.ok(!fs.existsSync(path.join(dir, 'x.md')), '什么都没写')
  // 之后所有调用都直接返回停止语
  assert.ok((await sp.exec('space_list', {})).includes('停止'))
})

test('autonomy: 挡 2 一场——假 LLM 用工具写笔记，产出第一人称小结', async () => {
  const dir = tmpSpace()
  const journal = []
  const fakeLlm = {
    chatStream: async ({ messages, tools, toolExec }) => {
      assert.ok(tools.length >= 6, '工具表齐')
      // 注意不能用 JSON.stringify(messages)：它会把 Windows 路径的反斜杠转义掉
      assert.ok(messages.map((m) => m.content || '').join('\n').includes(dir), '提示词带地盘路径')
      await toolExec('space_write', { path: '想看.md', content: '- 显卡驱动\n' })
      await toolExec('open_url', { url: 'https://search.bilibili.com/all?keyword=显卡' })
      return { content: '我把想看的片子记进了想看.md，还去B站搜了搜显卡。' }
    }
  }
  const r = await a.runSpace({
    dir, topic: '显卡', llm: fakeLlm, llmCfg: { model: 'x' },
    journal: (e) => journal.push(e), userBack: () => false
  })
  assert.equal(r.ok, true)
  assert.ok(r.content.includes('想看'))
  assert.ok(fs.existsSync(path.join(dir, '想看.md')))
  assert.ok(journal.some((e) => e.kind === 'session-start'))
  assert.ok(journal.some((e) => e.kind === 'write'))
})

test('autonomy: 挡 2 主人中途回来——循环中止，日志记 stop', async () => {
  const dir = tmpSpace()
  const journal = []
  let back = false
  const fakeLlm = {
    chatStream: async ({ toolExec }) => {
      await toolExec('space_write', { path: 'a.md', content: '1' })
      back = true                      // 写到一半主人回来了
      await toolExec('space_write', { path: 'b.md', content: '2' })
      return { content: '被中断' }
    }
  }
  const r = await a.runSpace({
    dir, llm: fakeLlm, llmCfg: { model: 'x' },
    journal: (e) => journal.push(e),
    userBack: () => back
  })
  assert.equal(r.why, 'user-back')
  assert.ok(fs.existsSync(path.join(dir, 'a.md')), '回来前写成的还在')
  assert.ok(!fs.existsSync(path.join(dir, 'b.md')), '回来后一个字节都不写')
  assert.ok(journal.some((e) => e.kind === 'stop'))
})

test('autonomy: 挡 3 工具表——cua 全套 + open_url + watch_video + look_screen，绝不含 wechat_send', () => {
  const ft = a.freeToolsOf({ cua: { invoke: async () => ({}) } })
  const names = ft.defs.map((d) => d.function.name)
  assert.equal(names.length, a.CUA_FREE_TOOLS.length + 4, '0.46.32 加了 watch_video、0.46.37 加了 look_screen、0.46.54 加了 listen')   // cua + open_url + watch_video + look_screen + listen
  assert.ok(!names.includes('wechat_send'), '她永远不该替主人发消息')
  assert.ok(names.includes('screenshot') && names.includes('open_url') && names.includes('watch_video'))
  assert.ok(names.includes('look_screen'), '0.46.37 本地视觉看屏工具在场')
  assert.ok(names.includes('listen'), '0.46.54 听一下工具在场')
})

test('0.46.35 挡 3 并入地盘工具：space_* 在场、无重复 open_url、exec 真写文件且留日志', async () => {
  const dir = tmpSpace()
  const journal = []
  const ft = a.freeToolsOf({
    cua: { invoke: async () => ({}) },
    journal: (e) => journal.push(e),
    spaceDir: dir
  })
  const names = ft.defs.map((d) => d.function.name)
  assert.ok(names.includes('space_write') && names.includes('space_list') && names.includes('space_read'), '地盘工具在场')
  assert.equal(names.filter((n) => n === 'open_url').length, 1, 'open_url 只留挡 3 的任意 https 版（挡 2 白名单版被过滤）')
  assert.equal(names.filter((n) => n === 'watch_video').length, 1, '0.46.36 watch_video 也只留一份——重名会让 LLM 400 拒掉整场（0.46.35 真机挡3全灭）')
  // exec 路由：space_write 真落盘、留日志；越界照样被守卫拦
  const w = await ft.exec('space_write', { path: 'notes/2026-11-04.md', content: '查到了…' })
  assert.ok(String(w).includes('已写入'))
  assert.ok(fs.existsSync(path.join(dir, 'notes', '2026-11-04.md')))
  assert.ok(journal.some((e) => e.kind === 'write'))
  const bad = await ft.exec('space_write', { path: '../outside.md', content: 'x' })
  assert.ok(String(bad).includes('越界'), '地盘外的路径照样拦')
})

test('autonomy: 挡 3——cua 动作全部留日志；deferred 立即收手', async () => {
  const journal = []
  const ft = a.freeToolsOf({
    cua: { invoke: async (n, args) => ({ note: n + ' ok' }) },
    journal: (e) => journal.push(e),
    openUrl: async () => { }
  })
  const r1 = await ft.exec('scroll', { dy: 500 })
  assert.ok(String(r1 && r1.text || r1).includes('scroll ok'))
  assert.ok(journal.some((e) => e.kind === 'scroll'))
  // deferred：主人在用电脑，cua 让位 → 工具返回收手指令并置停
  const ft2 = a.freeToolsOf({
    cua: { invoke: async () => ({ deferred: true }) },
    journal: (e) => journal.push(e)
  })
  const r2 = await ft2.exec('click', { x: 3, y: 4 })
  assert.ok(String(r2).includes('主人回来'))
  assert.ok(ft2.stopped())
  assert.ok(journal.some((e) => e.kind === 'stop'))
})

test('autonomy: 操作日志落在工作区里、超限滚动', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'))
  for (let i = 0; i < 2000; i++) {
    a.appendJournal(ws, { level: 1, kind: 'x', detail: 'y'.repeat(300) })
  }
  const file = path.join(ws, 'pc', 'autonomy', 'journal.jsonl')
  assert.ok(fs.existsSync(file))
  assert.ok(fs.statSync(file).size <= 600 * 1024, '日志超限后滚动')
  assert.ok(fs.existsSync(path.join(ws, 'pc', 'autonomy', 'journal.old.jsonl')), '旧的那份还在')
})

test('autonomy: 调度器按挡位分派（挡 2 不需要话题也能出门）', async () => {
  const dir = tmpSpace()
  let ran = ''
  const origSpace = a.runSpace
  // 直接在模块对象上替换（runSpace 是模块内引用的常量，这里换一种方式：
  // 挡 2 没话题时 pool 空也应该跑起来——用真实 runSpace + 假 LLM 验证）
  const inst = a.create({
    cfgGet: () => ({ autonomyOn: true, autonomyLevel: 2, autonomyDir: dir }),
    idleSec: () => 9999,
    pool: () => ({}),                  // 什么都不感兴趣
    llmCfg: () => ({ model: 'x' }),
    cua: { invoke: async () => ({}) },
    openUrl: async () => { ran += 'o' },
    now: () => Date.now(),
    rand: () => 0
  })
  // 假 llm：直接换 require 缓存
  const llmPath = require.resolve('../src/main/companion/llm')
  const orig = require.cache[llmPath]
  require.cache[llmPath] = {
    id: llmPath, filename: llmPath, loaded: true,
    exports: { chatStream: async () => ({ content: '我整理了笔记' }), chatOnce: async () => '', listModels: async () => [] }
  }
  try {
    await inst.tick()
    assert.ok(fs.existsSync(path.join(dir, '..')), '跑过一轮没炸')
    assert.equal(inst.status().todayCount, 1, '挡 2 空话题也算出门一次')
  } finally {
    if (orig) require.cache[llmPath] = orig; else delete require.cache[llmPath]
    void ran; void origSpace
  }
})

/* ---------------- 0.45.0 真机回归 ---------------- */

test('autonomy: 配置重载反复 start() 不把首次触发往后推', () => {
  let t = 1_000_000_000_000
  const inst = a.create({
    cfgGet: () => ({ autonomyOn: true }),
    log: () => {},
    idleSec: () => 600,
    busy: () => false,
    pool: () => ({ themes: ['x'] }),
    cua: cuaStub([]),
    openUrl: async () => {},
    now: () => t,
    rand: () => 0.5,
    sleep: async () => {}
  })
  inst.start()
  const first = inst.status().nextInMs          // FIRST_DELAY_MS（10 分钟）
  t += 60 * 1000
  inst.start()                                   // 模拟配置重载 → 再次 start
  const after = inst.status().nextInMs
  assert.equal(after, first - 60 * 1000, '重载只该让时钟正常走，不该把计时拨回 10 分钟（0.45.0 改设置就永远到不了点的回归）')
  inst.stop()
})

test('autonomy: 空闲阈值可调（autonomyIdleMin，1~120 分钟）', () => {
  assert.equal(a.idleMsOf({}), 5 * 60 * 1000, '默认 5 分钟')
  assert.equal(a.idleMsOf({ autonomyIdleMin: 2 }), 2 * 60 * 1000)
  assert.equal(a.idleMsOf({ autonomyIdleMin: 0.4 }), 60 * 1000, '下限 1 分钟')
  assert.equal(a.idleMsOf({ autonomyIdleMin: 999 }), 120 * 60 * 1000, '上限 120 分钟')
  assert.equal(a.idleMsOf({ autonomyIdleMin: '7' }), 7 * 60 * 1000, '字符串数字也认')
})

test('autonomy: status 带 idleMin；tick({force}) 绕过空闲/冷却直接跑一场', async () => {
  let t = 2_000_000_000_000
  const calls = []
  let fg = 0
  const inst = a.create({
    cfgGet: () => ({ autonomyOn: false, autonomyLevel: 1 }),  // 开关是关的：force 也要能跑
    log: () => {},
    idleSec: () => 0,                                          // 主人就在电脑前
    busy: () => false,
    pool: () => ({ themes: ['测试'] }),
    cua: cuaStub(calls),
    openUrl: async () => {},
    // 必须注入假前台：不传会走真实 launcher.scan（spawn PowerShell，慢且环境敏感）
    foreground: async () => (fg++ === 0
      ? { pn: 'Code', title: 'main.js', hwnd: 1 }
      : { pn: 'msedge', title: '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili 测试', hwnd: 9 }),
    now: () => t,
    rand: () => 0,
    sleep: async () => {},
    // 0.46.32：rand=0 恒选 SITES[0]=bili → 挡1 B站场现在是「看视频」。注入 fake 让它确定性地跑通。
    biliWatchFn: async () => ({
      ok: true, title: '测试视频', owner: 'up', duration: '3:00', durationSec: 180,
      desc: 'd', url: 'https://www.bilibili.com/video/BV1test00000',
      watched: true, transcript: '字幕…', note: ''
    })
  })
  const st = inst.status()
  assert.equal(st.idleMin, 5, 'status 暴露当前阈值')
  // 普通 tick：开关关着 → 什么都不做
  await inst.tick()
  assert.equal(calls.length, 0, '关着不跑')
  // force tick：绕过开关/空闲，直接出门。
  // 0.45.4 回归：idle=0（人就在电脑前动鼠标）force 也不许让位自杀——
  // 用户亲手点的观察场，他必须待在电脑前才看得到，3 秒阈值也不行（0.45.3 真机实证）
  const r = await inst.tick({ force: true })
  assert.equal(r && r.ok, true, '人在电脑前 force 也该跑完：' + JSON.stringify(r))
  assert.equal(r.watched, true, '挡1 B站场=看视频（0.46.32），看完即收')
  inst.stop()
})

test('autonomy: llm-error 收场只等 5 分钟就补跑（0.45.11，deepseek 高峰 503 整场报废回归）', async () => {
  let t = 3_000_000_000_000
  const llmPath = require.resolve('../src/main/companion/llm')
  const orig = require.cache[llmPath]
  require.cache[llmPath] = {
    id: llmPath, filename: llmPath, loaded: true,
    exports: {
      chatStream: async () => { throw new Error('LLM 503: Service is too busy') },
      chatOnce: async () => '', listModels: async () => []
    }
  }
  const inst = a.create({
    cfgGet: () => ({ autonomyOn: true, autonomyLevel: 3 }),
    log: () => {}, idleSec: () => 9999, busy: () => false,
    pool: () => ({}),
    llmCfg: () => ({ model: 'x' }),
    cua: { invoke: async () => ({}) },
    openUrl: async () => {},
    now: () => t, rand: () => 0
  })
  try {
    const r = await inst.tick()
    assert.equal(r, undefined, '非 force 不带回执')
    const st = inst.status()
    assert.ok(st.nextInMs <= 5 * 60 * 1000 && st.nextInMs > 4 * 60 * 1000,
      'llm-error 只等 ~5 分钟补跑，而不是 45~120 分钟禁闭：' + st.nextInMs)
  } finally {
    if (orig) require.cache[llmPath] = orig; else delete require.cache[llmPath]
  }
})

test('autonomy: 只宣布计划不动手时 runFree 推她继续；挡3轮数给足', async () => {
  const calls = []
  let n = 0
  const llm = {
    chatStream: async ({ messages, maxRounds, toolExec }) => {
      n++
      calls.push({ msgsLen: messages.length, maxRounds, lastUser: messages[messages.length - 1].content })
      if (n === 1) return { content: '我会先截屏查看当前屏幕的内容。', toolResults: [] }
      // 被推之后真的动手了（留下动作流水），再用过去式收尾
      try { await toolExec('screenshot', {}) } catch { }
      return { content: '我看了屏幕，打开了哔哩哔哩首页翻了翻，收藏了一个视频。', toolResults: [] }
    }
  }
  const r = await a.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => 'ok' },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {}
  })
  assert.equal(r && r.ok, true, '要跑完：' + JSON.stringify(r))
  assert.equal(calls[0].maxRounds, 16, '挡3给 16 轮（目标驱动，行为做完为止）')
  assert.ok(String(calls[1].lastUser).includes('别只说计划'), '意图式回复先被推「去做」')
  // 0.45.16：收尾不看时钟——动手了就对照她的开场计划推「都做完了吗」，两次后放行
  assert.ok(String(calls[2].lastUser).includes('都做完了吗'), '收尾前对照开场计划（第 1 次）')
  assert.ok(String(calls[3].lastUser).includes('都做完了吗'), '收尾前对照开场计划（第 2 次）')
  assert.ok(String(r.content).includes('我看了'), '最终汇报是过去式')
})

test('0.46.35 挡 3 sys：行为面拓宽不再锚定浏览、隐私红线在场、地盘提示随 spaceDir 注入', async () => {
  let sys = ''
  const llm = {
    chatStream: async ({ messages, toolExec }) => {
      sys = String(messages[0].content)
      await toolExec('screenshot', {})
      return { content: '我看了会儿屏幕，随手记了点东西。', toolResults: [] }
    }
  }
  const dir = tmpSpace()
  await a.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' }, spaceDir: dir,
    cua: { invoke: async () => 'ok' },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {}
  })
  assert.ok(!sys.includes('HN'), '删掉「去看看 HN」的浏览锚定（真机 74 场全在浏览的根因之一）')
  assert.ok(sys.includes('私密内容不要翻'), '隐私红线在场（设置页一直承诺「不会翻你隐私」）')
  assert.ok(sys.includes(dir), '带 spaceDir 时地盘进提示词')
  assert.ok(/space_write/.test(sys), '记笔记的能力进提示词')
  assert.ok(sys.includes('不用每次都一样'), '行为多样性引导在场')
  // 开场消息：不再让她先侦查好几步
  assert.ok(!/先看看现在屏幕/.test(sys), '旧开场侦查引导已删')
  // 不带 spaceDir：地盘段缺席但 sys 不炸
  await a.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => 'ok' },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {}
  })
})

test('0.46.35 主人回来后循环立即收：不再对着已停的工具连推 nudge', async () => {
  let n = 0
  const nudges = []
  let back = false   // 第一轮工具执行时主人回来了
  const llm = {
    chatStream: async ({ messages, toolExec }) => {
      n++
      const last = String(messages[messages.length - 1].content)
      if (last.includes('都做完了吗') || last.includes('别只说')) nudges.push(last.slice(0, 12))
      if (n === 1) {
        back = true
        await toolExec('screenshot', {})   // gate 发现主人回来 → 置停
        return { content: '我看了下屏幕。', toolResults: [] }
      }
      return { content: '我看了下屏幕，收工。', toolResults: [] }
    }
  }
  const r = await a.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => 'ok' },
    userBack: () => back,
    journal: () => {}, openUrl: async () => {}, log: () => {}
  })
  assert.equal(r && r.ok, false, '主人回来=不完整活动')
  assert.equal(n, 1, 'stopped 后循环立即收，不再进入第二轮: ' + n)
  assert.equal(nudges.length, 0, 'stop 后一次 nudge 都不该推: ' + JSON.stringify(nudges))
})

test('autonomy: 空汇报兜底是第一人称流水，说得出去了哪，不编「没来得及」的借口', async () => {
  const llm = {
    chatStream: async ({ toolExec }) => {
      // 她动手了：截屏 + 开网页（留下真实流水），但一句收尾汇报都没说
      await toolExec('screenshot', {})
      await toolExec('open_url', { url: 'https://www.example.com/news/a' })
      await toolExec('screenshot', {})
      return { content: '', toolResults: [] }
    }
  }
  const r = await a.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => 'ok' },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {}
  })
  assert.equal(r && r.ok, true)
  const line = String(r.content || '')
  assert.ok(line.includes('example.com'), '兜底要说得出打开了哪：' + line)
  assert.ok(line.includes('自己'), '第一人称：' + line)
  assert.ok(!line.includes('她'), '不许出现第三人称的她：' + line)
  assert.ok(!line.includes('没来得及'), '不编借口：' + line)
})

test('autonomy: 什么都没做就收尾会被推「去做」；对照过计划才放行', async () => {
  // 0.45.16：收尾不看时钟——没动手先推动手，动过手对照计划，两次计划推送后放行
  let n = 0
  const llm = {
    chatStream: async () => {
      n++
      return { content: '我看了桌面，翻了翻页面，没什么想点的。', toolResults: [] }
    }
  }
  const r = await a.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => 'ok' },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {}
  })
  assert.equal(r && r.ok, true)
  assert.equal(n, 3, '没动手推一次 + 对照计划推一次 + 第三次放行')
})

test('autonomy: 散场后她开出来的浏览器窗被兜底关掉（恢复原样）', async () => {
  const ops = []
  let winCalls = 0
  const cua = {
    invoke: async (name, args) => {
      ops.push({ name, args })
      if (name === 'windows') {
        winCalls++
        if (winCalls === 1) {
          // 开场快照：只有主人的窗口
          return { windows: [{ hwnd: 1, title: '终端', cls: 'CASCADIA_HOSTING_WINDOW_CLASS', pid: 100 }] }
        }
        // 散场清理：多了她开的浏览器窗 + 一个资源管理器（不该动）+ 自家窗（不该动）
        return { windows: [
          { hwnd: 1, title: '终端', cls: 'CASCADIA_HOSTING_WINDOW_CLASS', pid: 100 },
          { hwnd: 9, title: 'Hacker News', cls: 'Chrome_WidgetWin_1', pid: 200 },
          { hwnd: 10, title: '资料', cls: 'CabinetWClass', pid: 300 },
          { hwnd: 11, title: 'Ryza Assistant', cls: 'Chrome_WidgetWin_1', pid: process.pid }
        ] }
      }
      return 'ok'
    }
  }
  const r = await a.runFree({
    llm: { chatStream: async () => ({ content: '我看了桌面，翻了个网页。', toolResults: [] }) },
    llmCfg: { baseUrl: 'x', model: 'm' },
    cua, userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {}
  })
  assert.equal(r && r.ok, true)
  const focused = ops.filter((o) => o.name === 'focus').map((o) => o.args.hwnd)
  const keys = ops.filter((o) => o.name === 'key').map((o) => o.args.keys)
  assert.deepEqual(focused, [9], '只 focus 她开出来的浏览器窗 9')
  assert.ok(keys.every((k) => /alt\+f4/i.test(k)), '用 alt+f4 关')
})

test('autonomy: 经历沉淀——做梦式解析行 → 审查册条目', () => {
  const { parseDream } = require('../src/main/companion/dream')
  const parsed = parseDream([
    '[喜欢] Hacker News 上把 DOOM 调成 Transformer 的项目｜够怪够酷',
    '[记] 他的副屏开着一堆终端窗口，像在做开发｜4',
    '[他] 桌面壁纸是动漫图｜2',
    '无'
  ].join('\n'))
  const entries = a.memoryEntriesOf(parsed)
  assert.equal(entries.length, 3, '无 不产条目')
  assert.deepEqual(entries.map((e) => e.kind).sort(), ['fact', 'memory', 'taste'])
  assert.ok(entries[0].reason.startsWith('自主活动'))
  const memo = entries.find((e) => e.kind === 'memory')
  assert.ok(String(memo.reason).includes('4'), '重要度进 reason')
  assert.equal(a.memoryEntriesOf(null).length, 0)
})

test('autonomy: 整场空汇报时用流水兜底（旁白与记忆提炼不至于断粮）', async () => {
  const llm = {
    chatStream: async ({ toolExec }) => {
      // 她一声不吭闷头干：截屏 + 开网页，然后轮数耗尽（content 全空）
      try { await toolExec('screenshot', {}) } catch { }
      try { await toolExec('open_url', { url: 'https://example.com' }) } catch { }
      return { content: '', toolResults: [] }
    }
  }
  const r = await a.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => 'ok' },
    userBack: () => false, journal: () => {}, openUrl: async () => '已在浏览器打开', log: () => {}
  })
  assert.equal(r && r.ok, true)
  assert.ok(String(r.content).includes('自己用了一会儿电脑'), '兜底合成：' + JSON.stringify(r))
  assert.ok(String(r.content).includes('打开了 3 个网页'), '闷头干 3 轮（两次计划推送后放行），兜底汇总计数正确')
})

test('autonomy: 挡3 工具集带 read_text（读正文能力）', async () => {
  let defs = null
  const llm = { chatStream: async ({ tools }) => { defs = tools; return { content: '我看了桌面，翻了翻。', toolResults: [] } } }
  await a.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => 'ok' }, userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {}
  })
  const names = (defs || []).map((d) => d.function.name)
  assert.ok(names.includes('read_text'), 'tools 里要有 read_text：' + names.join(','))
})

/* ---- 0.46.17 性格层：品味 / 牵挂 / 活动可见 ---- */
const fs2 = require('node:fs')
const osp = require('node:os')
const pth = require('node:path')

test('0.46.17 品味：讨厌的话题被剔除，喜欢的话题加权，只剩讨厌的就不出门', () => {
  const pool = { themes: ['显卡', '做饭', '显卡评测'] }
  const tastes = [
    { what: '做饭', polarity: 'dislike' },
    { what: '显卡', polarity: 'like' }
  ]
  for (let i = 0; i < 60; i++) {
    const t = a.pickTopic(pool, Math.random, tastes)
    assert.notEqual(t, '做饭', '讨厌的话题不该被选中')
  }
  assert.equal(a.pickTopic({ themes: ['做饭'] }, () => 0, [{ what: '做饭', polarity: 'dislike' }]), '', '只剩讨厌的就宁可不出门')
  assert.equal(a.pickTopic({ themes: ['显卡'] }, () => 0, []), '显卡', '不带喜恶时行为照旧')
})

test('0.46.17 品味：常去的站点权重高，留 20% 探索余地', () => {
  const dir = fs2.mkdtempSync(pth.join(osp.tmpdir(), 'ryza-sites-'))
  assert.equal(a.readSiteStats(dir).bili, undefined, '没统计前没有偏好')
  assert.equal(a.pickSite(dir, () => 0.5), a.SITES[1], '无统计 = 均匀分布')
  a.bumpSite(dir, 'bili'); a.bumpSite(dir, 'bili'); a.bumpSite(dir, 'bili')
  assert.equal(a.readSiteStats(dir).bili.n, 3)
  assert.equal(a.pickSite(dir, () => 0.5), a.SITES[0], '常去的站同样的 rand 会落回去')
  assert.equal(a.pickSite(dir, () => 0.1), a.SITES[0], '20% 探索分支照样能出门')
})

test('0.46.17 牵挂：写入/读取/销账/三天过期', () => {
  const dir = fs2.mkdtempSync(pth.join(osp.tmpdir(), 'ryza-carry-'))
  assert.equal(a.readCarry(dir), null, '没有牵挂就是没有')
  a.writeCarry(dir, 'SQL 表结构', 'history.19.sql - 哔哩哔哩')
  const c = a.readCarry(dir)
  assert.equal(c.topic, 'SQL 表结构')
  assert.match(a.carryLineOf(c), /还没看完，接着看/, '续接要有开场白')
  a.clearCarry(dir)
  assert.equal(a.readCarry(dir), null, '销账后不再牵挂')
  a.writeCarry(dir, '旧线索', '')
  const p = pth.join(dir, 'pc', 'autonomy', 'carry.json')
  const o = JSON.parse(fs2.readFileSync(p, 'utf8'))
  o.t = Date.now() - 4 * 86400000
  fs2.writeFileSync(p, JSON.stringify(o))
  assert.equal(a.readCarry(dir), null, '超过三天的牵挂该放下了')
})

test('0.46.17 牵挂时间词：几小时前=刚才，隔天=昨天，更久=前几天', () => {
  const now = Date.now()
  const mk = (t) => ({ t, topic: 'X' })
  assert.match(a.carryLineOf(mk(now - 2 * 3600000)), /^刚才那个/)
  assert.match(a.carryLineOf(mk(now - 20 * 3600000)), /^昨天那个/)
  assert.match(a.carryLineOf(mk(now - 3 * 86400000)), /^前几天那个/)
})

test('0.46.17 活动可见：出门嘀咕一声（确认到浏览器才说），翻够 3 下再说一句', async () => {
  const calls = []
  const lines = []
  const r = await a.runBrowse({
    ...base,
    cua: cuaStub(calls),
    foreground: fgSeq([
      { pn: 'Code', title: 'main.js', hwnd: 1 },
      { pn: 'msedge', title: '显卡驱动 - 哔哩哔哩', hwnd: 2 },
      { pn: 'msedge', title: '显卡驱动 - 哔哩哔哩', hwnd: 2 },
      { pn: 'msedge', title: '教程A - 哔哩哔哩', hwnd: 2 },
      { pn: 'msedge', title: '教程B - 哔哩哔哩', hwnd: 2 },
      { pn: 'msedge', title: '教程B - 哔哩哔哩', hwnd: 2 }
    ]),
    onSoliloquy: async (l) => { lines.push(l) }
  })
  assert.equal(r.ok, true)
  assert.ok(lines.length >= 1 && lines.length <= 2, '嘀咕 1~2 句：' + JSON.stringify(lines))
  assert.match(lines[0], /去康康/)
})

test('0.46.17 活动可见：续接线索用传入的开场白；没翻到东西就只此一句；上限 0 = 安静', async () => {
  const lines = []
  await a.runBrowse({
    ...base,
    cua: cuaStub([]),
    foreground: fgSeq([
      { pn: 'Code', title: 'main.js', hwnd: 1 },
      { pn: 'msedge', title: 'SQL 表结构', hwnd: 2 },
      { pn: 'msedge', title: 'SQL 表结构', hwnd: 2 }
    ]),
    carryLine: '昨天那个「SQL 表结构」还没看完，接着看',
    onSoliloquy: async (l) => { lines.push(l) }
  })
  assert.equal(lines[0], '昨天那个「SQL 表结构」还没看完，接着看')
  assert.equal(lines.length, 1, '没翻够就只有开场一句')
  const lines2 = []
  await a.runBrowse({
    ...base,
    cua: cuaStub([]),
    foreground: fgSeq([
      { pn: 'Code', title: 'main.js', hwnd: 1 },
      { pn: 'msedge', title: 'x', hwnd: 2 },
      { pn: 'msedge', title: 'x', hwnd: 2 }
    ]),
    onSoliloquy: async (l) => { lines2.push(l) },
    soliMax: 0
  })
  assert.equal(lines2.length, 0, '上限 0 = 安静模式')
})

// ── 0.46.37 本地视觉 look_screen ──

test('0.46.37 look_screen：本地视觉正常时返回画面描述并留 journal', async () => {
  const journal = []
  const ft = a.freeToolsOf({
    cua: { invoke: async () => ({}) },
    journal: (e) => journal.push(e),
    captureFn: async () => ({ jpeg: Buffer.from('fakejpeg'), desc: '唯一一块屏幕' }),
    visionObj: { describe: async (img, q) => ({ ok: true, text: '屏幕上是一个红色窗口', model: 'qwen3.5:4b' }) }
  })
  const r = await ft.exec('look_screen', { question: '画面里有什么' })
  assert.match(String(r), /你看到（唯一一块屏幕）/, '要带上画面布局说明')
  assert.match(String(r), /红色窗口/, '要有视觉模型给的描述')
  assert.ok(journal.some((e) => e.kind === 'look'), 'journal 留痕 kind=look')
})

test('0.46.37 look_screen：视觉通道未启用时如实说，绝不装看见了', async () => {
  const journal = []
  const ft = a.freeToolsOf({
    cua: { invoke: async () => ({}) },
    journal: (e) => journal.push(e),
    captureFn: async () => ({ jpeg: Buffer.from('x'), desc: '屏幕' }),
    visionObj: { describe: async () => ({ ok: false, reason: 'Ollama 未运行' }) }
  })
  const r = await ft.exec('look_screen', {})
  assert.match(String(r), /看不见画面：Ollama 未运行/, '失败原因原样带出')
  assert.match(String(r), /read_text/, '要给出降级出路')
})

test('0.46.37 look_screen：每场限 8 次，之后引导凭已看到的做决定', async () => {
  const ft = a.freeToolsOf({
    cua: { invoke: async () => ({}) },
    journal: () => {},
    captureFn: async () => ({ jpeg: Buffer.from('x'), desc: '屏幕' }),
    visionObj: { describe: async () => ({ ok: true, text: '画面' }) }
  })
  for (let i = 0; i < 8; i++) {
    const r = await ft.exec('look_screen', {})
    assert.ok(String(r).includes('你看到'), '第 ' + (i + 1) + ' 次应该成功')
  }
  const over = await ft.exec('look_screen', {})
  assert.match(String(over), /看了 8 眼/, '第 9 次要被拦下')
})

test('0.46.37 look_screen：主人回来了立刻停，不许再看', async () => {
  const ft = a.freeToolsOf({
    cua: { invoke: async () => ({}) },
    journal: () => {},
    userBack: () => true,   // 主人已回来
    captureFn: async () => { throw new Error('不该走到截屏这一步') },
    visionObj: { describe: async () => ({ ok: true, text: '不该被调用' }) }
  })
  const r = await ft.exec('look_screen', {})
  assert.match(String(r), /已停止/, 'gate 要先拦')
})

// ── 0.46.49 记账覆盖缺口：free 挡也要进品味账和牵挂账 ──
// 11-05 巡检实锤：真机成功场全是「完全开放挡」，site-stats / carry.json 自上线零首写——
// bumpSite 只认 browse、writeCarry 对 free 挡 topic 恒空。修完三处：runFree 带账出来、
// 调度层 free 场记品味、被打断且没旧牵挂时用真看过/搜过的东西兜话题。

test('0.46.49 runFree 把她看过/搜过的带出来：watched 标题优先当话题，sites 去重', async () => {
  const llm = {
    chatStream: async ({ toolExec }) => {
      await toolExec('open_url', { url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('SQL 表结构') })
      await toolExec('watch_video', { query: 'SQL 索引' })
      return { content: '我看了个视频，收工。', toolResults: [] }
    }
  }
  const r = await a.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => ({}) },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {},
    biliWatchFn: async () => ({ ok: true, title: 'SQL 索引详解', url: 'https://www.bilibili.com/video/BV1', watched: true, transcript: 'x' })
  })
  assert.equal(r && r.ok, true, '要跑完：' + JSON.stringify(r))
  assert.deepEqual(r.sites, ['search.bilibili.com'], '开过的域名要带出来（去重，子域保留全名）：' + JSON.stringify(r.sites))
  assert.deepEqual(r.watched, ['SQL 索引详解'], '看过的视频标题要带出来')
  assert.equal(r.topic, 'SQL 索引详解', '话题兜底：看过的视频标题优先')
})

test('0.46.49 runFree 话题兜底第二优先：最近一次搜索词；没看过没搜过 = 空', async () => {
  const llm = {
    chatStream: async ({ toolExec }) => {
      await toolExec('open_url', { url: 'https://www.google.com/search?q=' + encodeURIComponent('猫为什么踩奶') })
      return { content: '我搜了一下。', toolResults: [] }
    }
  }
  const r = await a.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => ({}) },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {}
  })
  assert.equal(r.topic, '猫为什么踩奶', '搜索词兜底：' + JSON.stringify(r.topic))
  // 什么都没看/没搜：topic 空，调度层就不该写牵挂
  const llm2 = { chatStream: async ({ toolExec }) => { await toolExec('screenshot', {}); return { content: '我看了屏幕。', toolResults: [] } } }
  const r2 = await a.runFree({
    llm: llm2, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => ({}) },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {}
  })
  assert.equal(r2.topic, '', '只截屏没看东西：没有话题可兜')
  assert.equal(a.siteKeyOf('google.com'), '', '品味账只认 SITES 里的站')
  assert.equal(a.siteKeyOf('www.bilibili.com'), 'bili')
  assert.equal(a.siteKeyOf('search.bilibili.com'), 'bili')
  assert.equal(a.siteKeyOf('zh.wikipedia.org'), 'wiki')
})

test('0.46.49 调度层：free 挡被打断也要记账——品味进 site-stats，新线索写 carry', async () => {
  const fs2 = require('node:fs')
  const pth = require('node:path')
  const osp = require('node:os')
  const ws = fs2.mkdtempSync(pth.join(osp.tmpdir(), 'ryza-free-ledger-'))
  let t = 3_000_000_000_000
  let idle = 9999
  let n = 0
  const llmPath = require.resolve('../src/main/companion/llm')
  const orig = require.cache[llmPath]
  require.cache[llmPath] = {
    id: llmPath, filename: llmPath, loaded: true,
    exports: {
      chatStream: async ({ toolExec }) => {
        n++
        if (n === 2) idle = 0   // 第二轮主人回来了 → gate 置停 → user-back 收场
        await toolExec('open_url', { url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('SQL 表结构') })
        return { content: '我打开了哔哩哔哩搜了 SQL 表结构。', toolResults: [] }
      },
      chatOnce: async () => '', listModels: async () => []
    }
  }
  const inst = a.create({
    cfgGet: () => ({ autonomyOn: true, autonomyLevel: 3, autonomyDailyMax: 6 }),
    log: () => {}, idleSec: () => idle, busy: () => false,
    pool: () => ({}),
    llmCfg: () => ({ model: 'x' }),
    cua: { invoke: async () => ({}) },
    openUrl: async () => {},
    wsDir: () => ws,
    now: () => t, rand: () => 0.9
  })
  try {
    await inst.tick()
    const st = a.readSiteStats(ws)
    assert.ok(st.bili && st.bili.n >= 1, 'free 挡开的 B 站要进品味账：' + JSON.stringify(st))
    const carry = a.readCarry(ws)
    assert.ok(carry, '没有旧牵挂时第一笔要写得进（原来 topic 恒空静默 no-op）')
    assert.equal(carry.topic, 'SQL 表结构', '牵挂话题 = 她真搜过的词：' + JSON.stringify(carry))
    // 第二场正常收场 → 旧牵挂销账（时间拨过冷却，now 别再恒定）
    idle = 9999
    t += 10 * 60 * 60 * 1000
    await inst.tick()
    assert.equal(a.readCarry(ws), null, '正常收场=牵挂看完，销账')
  } finally {
    if (orig) require.cache[llmPath] = orig; else delete require.cache[llmPath]
    inst.stop()
  }
})
