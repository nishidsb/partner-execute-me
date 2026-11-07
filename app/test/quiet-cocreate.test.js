const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const autonomy = require('../src/main/companion/autonomy')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-'))

/* ── quietGate（纯函数矩阵） ── */

const OK = { busy: false, gameOn: false, sleepQuiet: false, now: 1000000, nextQuietAt: 0, quietToday: 0, pressure: 80, projectStale: false }

test('quiet：默认关，quietOn!==true 一律不动（主人 11-06 拍板）', () => {
  assert.equal(autonomy.quietGate({}, OK).ok, false)
  assert.equal(autonomy.quietGate({ quietOn: false }, OK).ok, false)
  assert.equal(autonomy.quietGate({ quietOn: true }, OK).ok, true, '显式开启才放行')
})

test('quiet：busy/游戏/晚安静默一票否决', () => {
  for (const k of ['busy', 'gameOn', 'sleepQuiet']) {
    const r = autonomy.quietGate({ quietOn: true }, { ...OK, [k]: true })
    assert.equal(r.ok, false, k + ' 时不动')
    assert.equal(r.why, k === 'busy' ? 'busy' : k === 'gameOn' ? 'game' : 'sleep-quiet')
  }
})

test('quiet：独立冷却与独立每日上限', () => {
  assert.equal(autonomy.quietGate({ quietOn: true }, { ...OK, nextQuietAt: 1000001 }).why, 'quiet-cooldown')
  assert.equal(autonomy.quietGate({ quietOn: true }, { ...OK, quietToday: 2 }).why, 'quiet-daily-max')
  assert.equal(autonomy.quietGate({ quietOn: true, quietDailyMax: 3 }, { ...OK, quietToday: 2 }).ok, true, '上限可配置')
})

test('quiet：驱动=压力≥60 或项目搁浅超一天；没劲头就不动', () => {
  assert.equal(autonomy.quietGate({ quietOn: true }, { ...OK, pressure: 59, projectStale: false }).why, 'quiet-no-urge')
  assert.equal(autonomy.quietGate({ quietOn: true }, { ...OK, pressure: 60 }).ok, true, '压力到阈值放行')
  assert.equal(autonomy.quietGate({ quietOn: true }, { ...OK, pressure: 10, projectStale: true }).ok, true, '项目搁浅也是合法驱动')
  assert.equal(autonomy.quietGate({ quietOn: true }, { ...OK, pressure: 10, projectStale: false }).why, 'quiet-no-urge')
})

test('quiet：冷却量在 1~3 小时内', () => {
  for (let i = 0; i < 20; i++) {
    const ms = autonomy.quietCooldownMs(() => 0.5)
    assert.ok(ms >= 60 * 60 * 1000 && ms <= 180 * 60 * 1000)
  }
})

/* ── runSpace quiet 模式 ── */

test('runSpace quiet：只给 space_* 工具、sys 带安静措辞、硬点别的工具名被拒', async () => {
  let sysTxt = ''
  let toolNames = []
  let toolReply = ''
  const llm = {
    chatStream: async ({ messages, tools, toolExec }) => {
      if (!sysTxt) {
        sysTxt = String(messages[0].content)
        toolNames = tools.map((t) => t.function.name)
        toolReply = String(await toolExec('open_url', { url: 'https://www.bilibili.com' }))
      }
      return { content: '整理了一页笔记。', toolResults: [] }
    }
  }
  const dir = tmp()
  const r = await autonomy.runSpace({
    quiet: true, topic: '某话题', dir, log: () => {}, now: new Date(2026, 10, 6, 15, 0, 0).getTime(),
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    journal: () => {}, openUrl: async () => {}, userBack: () => false
  })
  assert.equal(r && r.ok, true)
  assert.ok(sysTxt.includes('不要打扰他'), 'sys 带安静措辞')
  assert.ok(!sysTxt.includes('watch_video 可以'), 'quiet 不宣传看视频')
  assert.ok(toolNames.length > 0 && toolNames.every((n) => /^space_/.test(n)), '工具表只剩 space_*：' + toolNames.join(','))
  assert.ok(toolReply.includes('不可用'), '硬点 open_url 被拒')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runSpace 非 quiet：工具表含 watch_video/open_url（行为不变）', async () => {
  let toolNames = []
  const llm = {
    chatStream: async ({ messages, tools }) => {
      toolNames = tools.map((t) => t.function.name)
      return { content: '看了看。', toolResults: [] }
    }
  }
  const dir = tmp()
  await autonomy.runSpace({
    topic: '', dir, log: () => {}, now: new Date(2026, 10, 6, 15, 0, 0).getTime(),
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    journal: () => {}, openUrl: async () => {}, userBack: () => false
  })
  assert.ok(toolNames.includes('watch_video') && toolNames.includes('open_url'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runSpace quiet：他开始聊天（userBack=busy）→ 静默收场', async () => {
  const llm = {
    chatStream: async ({ toolExec }) => {
      const stop = await toolExec('space_list', {})
      return { content: String(stop), toolResults: [] }
    }
  }
  const dir = tmp()
  const r = await autonomy.runSpace({
    quiet: true, topic: '', dir, log: () => {}, now: Date.now(),
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    journal: () => {}, openUrl: async () => {}, userBack: () => true   // busy()=true
  })
  assert.equal(r && r.why, 'user-back', '聊天一开始就停：' + JSON.stringify(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ── read_project_note（共同创作） ── */

function spaceOf (dir, cocreate) {
  const space = autonomy.spaceToolsOf(dir, { journal: () => {}, userBack: () => false, cocreateCfg: () => cocreate })
  return async (name, args) => String(await space.exec(name, args))
}

test('cocreate：默认关/没配置 → 明确拒绝（不许猜）', async () => {
  const dir = tmp()
  const run = spaceOf(dir, {})
  assert.ok((await run('read_project_note', {})).includes('没在设置里开放'), '没开放如实说')
  const run2 = spaceOf(dir, { on: true })
  assert.ok((await run2('read_project_note', {})).includes('读不了'), '开了但没给文件路径→同样拒绝')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('cocreate：开了+文件在 → 读到内容；8KB 注入上限+offset 翻页', async () => {
  const dir = tmp()
  const note = path.join(dir, 'shared-note.md')
  const body = 'A'.repeat(autonomy.COCREATE_INJECT_MAX) + 'B'.repeat(100)
  fs.writeFileSync(note, body, 'utf8')
  const run = spaceOf(dir, { on: true, file: note })
  const first = await run('read_project_note', {})
  assert.ok(first.startsWith('AAAA'), '读到开头')
  assert.ok(first.includes('nextOffset=' + autonomy.COCREATE_INJECT_MAX), '给翻页游标')
  assert.ok(first.length < 9.5 * 1024, '单次注入 ≤8KB+标注')
  const m = /nextOffset=(\d+)/.exec(first)
  const second = await run('read_project_note', { offset: Number(m[1]) })
  assert.ok(second.startsWith('BBBB'), 'offset 接着读')
  assert.ok(second.includes('已到结尾'), '读到底有标注')
  // 文件消失 → 如实说，不装看过
  fs.unlinkSync(note)
  assert.ok((await run('read_project_note', {})).includes('读不到'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('cocreate：配置指向哪读哪（文件不存在→如实说读不了）', async () => {
  const dir = tmp()
  const run = spaceOf(dir, { on: true, file: path.join(dir, 'nonexistent.md') })
  assert.ok((await run('read_project_note', {})).includes('读不到'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('挡3 路由修复：freeToolsOf 里 read_project_note 走 space 执行器，不再掉进 CUA（0.46.66）', async () => {
  const dir = tmp()
  const note = path.join(dir, 'shared-note.md')
  fs.writeFileSync(note, '进度：路由修复验证', 'utf8')
  const free = autonomy.freeToolsOf({
    spaceDir: dir,
    journal: () => {},
    userBack: () => false,
    cocreateCfg: () => ({ on: true, file: note }),
    cua: { invoke: async () => { throw new Error('CUA 不该被调到 read_project_note') } }
  })
  const names = free.defs.map((d) => d.function.name)
  assert.ok(names.includes('read_project_note'), '挡3 工具表里有 read_project_note')
  const out = String(await free.exec('read_project_note', {}))
  assert.ok(out.includes('进度：路由修复验证'), '真正读到内容（走 space 执行器）：' + out.slice(0, 60))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('0.46.70 接线锁死：runFree 必须把 cocreateCfg 传进 freeToolsOf（19:41 真机实锤）', () => {
  // 0.46.66 的测试直接调 freeToolsOf 传参所以绿了——洞在 runFree→freeToolsOf 的传递层：
  // 0.46.65 起 runFree 构造工具表时漏传 cocreateCfg，挡 3 场 read_project_note 永远「没开放」，
  // 她 07:31/08:46/09:52/19:41 四次想读全失败。静态扫描锁死这根线（pc-ws-wiring 模式）。
  const src = fs.readFileSync(path.join(__dirname, '../src/main/companion/autonomy.js'), 'utf8')
  const line = src.split('\n').find((l) => l.includes('const free = freeToolsOf('))
  assert.ok(line, '找到 runFree 的 freeToolsOf 构造行')
  assert.ok(/cocreateCfg:\s*opt\.cocreateCfg/.test(line), 'runFree→freeToolsOf 必须透传 cocreateCfg')
})

/* ── 0.46.71 共同创作「写向」：progressNote ── */

const progressNote = require('../src/main/companion/progressNote')

test('progressNote.render：active 项目 + done 记录都进文本', () => {
  const md = progressNote.render({
    active: {
      title: '弄清楚搜索引擎的事', type: 'research', status: 'active',
      why: '他最近常搜东西', updatedAt: 1794000000000,
      notes: ['查到了一点眉目', '感觉方向不对，换个查法']
    },
    done: [
      { title: '收集陶艺入门视频', type: 'collection', summary: '存了三个', outcome: 'finished', finishedAt: 1793000000000 },
      { title: '写点什么', type: 'writing', summary: '没写出来', outcome: 'abandoned', finishedAt: 1792000000000 }
    ]
  })
  assert.ok(md.includes('弄清楚搜索引擎的事'), 'active 标题在')
  assert.ok(md.includes('暂时搁下') === false, 'active 状态没写搁置')
  assert.ok(md.includes('换个查法'), '最近的记录在')
  assert.ok(md.includes('收集陶艺入门视频'), 'done 标题在')
  assert.ok(md.includes('放着了'), 'abandoned 有标记')
  assert.ok(md.includes('做完了'), 'finished 有标记')
  assert.ok(md.length < progressNote.CAP, '渲染结果在上限内')
})

test('progressNote.render：paused 项目带搁置理由；无项目显示空态', () => {
  const md1 = progressNote.render({ active: { title: 'A', type: 'research', status: 'paused', pauseReason: '先把手头的事弄完', notes: [] }, done: [] })
  assert.ok(md1.includes('暂时搁下') && md1.includes('先把手头的事弄完'), '搁置理由在')
  const md2 = progressNote.render({ active: null, done: [] })
  assert.ok(md2.includes('暂时没有开着的项目'), '空态如实说')
})

test('progressNote.write：cocreate 开着才写，落共享笔记同目录，off/无 file 不动笔', () => {
  const dir = tmp()
  const shared = path.join(dir, '给莱莎看的项目进展.md')
  fs.writeFileSync(shared, '主人写的，不许被碰')
  const state = { active: { title: '弄清楚搜索引擎的事', type: 'research', status: 'active', notes: ['第一步'] }, done: [] }
  // off / 没配 → 不写
  assert.equal(progressNote.write(state, { on: false, file: shared }, null), false)
  assert.equal(progressNote.write(state, { on: true }, null), false)
  assert.equal(progressNote.write(state, {}, null), false)
  // 开着 → 写到同目录的「莱莎这边的进展.md」
  assert.equal(progressNote.write(state, { on: true, file: shared }, null), true)
  const out = path.join(dir, '莱莎这边的进展.md')
  assert.ok(fs.existsSync(out), '写向文件落盘')
  const body = fs.readFileSync(out, 'utf8')
  assert.ok(body.includes('弄清楚搜索引擎的事'), '内容来自 projects 状态')
  // 主人的原笔记一个字不许动
  assert.equal(fs.readFileSync(shared, 'utf8'), '主人写的，不许被碰')
  // outFile 覆盖路径
  const custom = path.join(dir, 'sub', 'my.md')
  assert.equal(progressNote.write(state, { on: true, file: shared, outFile: custom }, null), true)
  assert.ok(fs.existsSync(custom), 'outFile 生效')
  // 坏路径 → false 不 throw
  assert.equal(progressNote.write(state, { on: true, file: shared, outFile: 'Z://no//such//dir//x.md' }, null), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('progressNote 接线：projects.create 的 onSync 钩子真的被调（开题+record）', () => {
  const dir = tmp()
  const ws = path.join(dir, 'ws')
  fs.mkdirSync(ws, { recursive: true })
  const projects = require('../src/main/companion/projects')
  const seen = []
  const inst = projects.create({
    wsDir: () => ws, now: () => 1794000000000,
    onSync: (st) => seen.push(st && st.active ? st.active.title : null)
  })
  inst.block(['做点研究'])
  assert.ok(seen.length >= 1 && seen[0], '立新项目触发 onSync：' + JSON.stringify(seen))
  inst.record('【状态】搁置【心情】有点累')
  assert.ok(seen.length >= 2, '收尾也触发 onSync')
  inst.sync()
  assert.ok(seen.length >= 3, '手动 sync 也可用')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('progressNote 接线：宿主 index.js 真的注入 onSync + 启动回填（静态扫描）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/companion/index.js'), 'utf8')
  assert.ok(src.includes("require('./progressNote').write"), 'getProjects 里注入 onSync → progressNote.write')
  assert.ok(/startAutonomy\s*\(\)\s*\{[\s\S]{0,200}getProjects\(\)\.sync\(\)/.test(src), 'startAutonomy 启动回填 getProjects().sync()')
  const psrc = fs.readFileSync(path.join(__dirname, '../src/main/companion/projects.js'), 'utf8')
  assert.ok(psrc.includes('function emitSync'), 'projects.js 有 emitSync')
})
