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
