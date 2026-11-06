/**
 * 0.46.59 时间判断错误修复的回归测试
 *
 * 实锤：2026-11-06 18:25，自主活动收场时她说「もうすぐ0時20分だね」——
 * 实际 18:25，差了 12 小时+。根因两层：
 *   ① 主动开口链路（自主活动/黏人阶梯/欢迎回来）没有精确时间注入，
 *      只有 phaseBlockOf 的模糊时段（「现在是晚上」）；
 *   ② 记忆条目不带日期锚点（addEvent 从不写 date，0.45.39 的日期标签
 *      因条件恒假从未生效），做梦回顾入账的旧约定「学到 0:20」被当成现行约定。
 * 这里锁死三件事：nowBlock 单源块、autonomy sys 注入、memory 日期锚定。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/* ── dayflow.nowBlockOf：所有会开口的链路共用一块（单一真源） ── */
const dayflow = require('../src/main/companion/dayflow')

test('nowBlockOf: 精确到分+周几，带不报时红线与过期约定判定', () => {
  const now = new Date(2026, 10, 6, 18, 25).getTime() // 2026-11-06 18:25 周五
  const b = dayflow.nowBlockOf(now)
  assert.ok(b.includes('【当前时间】'), '块头在场')
  assert.ok(b.includes('18:25'), '精确到分（模糊时段是 18:25 被说成 0:20 的根因之一）')
  assert.ok(b.includes('周五'), '星期在场')
  assert.ok(b.includes('2026/11/6'), '完整日期在场')
  assert.ok(b.includes('不要报日期'), '不报时红线——时间给她判断用，不是让她报时（不能修出机器人味）')
  assert.ok(b.includes('过期'), '旧约定过期判定在场（11-04 的「学到 0:20」不是现行约定）')
})

test('nowBlockOf: 不传 now 默认取当前时刻，也照常出块', () => {
  assert.ok(dayflow.nowBlockOf().includes('【当前时间】'))
  assert.ok(dayflow.nowBlockOf(Date.now()).includes('不要报日期'))
})

/* ── autonomy runFree：自主活动 sys 注入精确时间 ── */
const autonomy = require('../src/main/companion/autonomy')

test('autonomy: runFree 的 sys 带【当前时间】与过期规则（0.46.59）', async () => {
  let sys = ''
  const llm = {
    chatStream: async ({ messages, toolExec }) => {
      sys = String(messages[0].content)
      await toolExec('screenshot', {})
      return { content: '我看了会儿屏幕，随手记了点东西。', toolResults: [] }
    }
  }
  const r = await autonomy.runFree({
    llm, llmCfg: { baseUrl: 'x', model: 'm' },
    cua: { invoke: async () => 'ok' },
    userBack: () => false, journal: () => {}, openUrl: async () => {}, log: () => {}
  })
  assert.ok(r && r.ok, '要跑完：' + JSON.stringify(r))
  assert.ok(sys.includes('【当前时间】'), '精确时间进自主活动 sys（18:25 说成 0:20 的实锤回归）')
  assert.ok(sys.includes('过期'), '过期约定规则在场')
})

/* ── memory.js：入账锚定日期 + 旧条目从 at 兜底渲染 ── */
test('memory: addEvent 写 date；summaryText/recall 对无 date 旧条目从 at 兜底出日期', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-timeblock-'))
  const charPath = require.resolve('../src/main/companion/character')
  const memPath = require.resolve('../src/main/companion/memory')
  const savedChar = require.cache[charPath]
  const savedMem = require.cache[memPath]
  // character.base() 指到临时目录（memory.js 经它定位账本文件）
  require.cache[charPath] = {
    id: charPath, filename: charPath, loaded: true,
    exports: { base: () => path.join(dir, 'companion'), get: () => ({ id: 't1' }) }
  }
  delete require.cache[memPath]
  const mem = require('../src/main/companion/memory')
  try {
    const ev = mem.addEvent('t1', { cat: 'fact', text: '说好那天 11:20 开始学到 0:20', importance: 3 })
    assert.ok(ev && ev.date, '入账即写 date 字段：' + JSON.stringify(ev))
    assert.ok(/^\d{2}-\d{2}$/.test(ev.date), 'date 是本地 MM-DD（不能用 toISOString，UTC 会差一天）')

    // 伪造一条历史旧条目（0.46.59 之前的条目全都没有 date 字段）
    const memFile = path.join(dir, 'companion', 't1', 'memory.json')
    const doc = JSON.parse(fs.readFileSync(memFile, 'utf8'))
    doc.events[0].date = undefined
    doc.events.push({
      seq: 2, cat: 'fact', text: '旧约定条目随账本',
      keywords: ['旧约定'], importance: 2,
      at: new Date(2026, 10, 4, 12, 0).getTime()   // 11-04
    })
    doc.seq = 2
    fs.writeFileSync(memFile, JSON.stringify(doc))

    const s1 = mem.summaryText('t1', '11:20')
    assert.ok(/\[\d{2}-\d{2}\]/.test(s1), '注入块每条带日期标签：' + s1)
    const s2 = mem.summaryText('t1', '旧约定')
    assert.ok(s2.includes('[11-04]'), '无 date 的旧条目从 at 兜底出日期（历史条目一并修好）：' + s2)
  } finally {
    if (savedChar) require.cache[charPath] = savedChar; else delete require.cache[charPath]
    if (savedMem) require.cache[memPath] = savedMem; else delete require.cache[memPath]
  }
})
