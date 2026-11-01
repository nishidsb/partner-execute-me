/**
 * 0.18.0 第二批 · 系统提示词编辑器
 * 覆盖：落盘字段 / 追加模式 / 替换模式 / 空内容不污染 / 聊天链路改不了它（设定保护闸仍在）
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const IMP = (p) => 'file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', p).replace(/\\/g, '/')
const SRC = path.join(__dirname, '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

let mods = null
async function load () {
  if (!mods) {
    const cfg = await import(IMP('config.js'))
    const roles = await import(IMP('roles/roleManager.js'))
    const sess = await import(IMP('core/session.js'))
    mods = { cfg, roles, sess }
  }
  return mods
}

async function sandbox () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-sp-'))
  const m = await load()
  m.cfg.initDataDir(dir)
  return { dir, ...m }
}

test('角色落盘：systemPrompt / systemReplace 存得住，超长截断', async () => {
  const { dir, roles } = await sandbox()
  const saved = roles.roles.save({
    id: 't1',
    name: 'T1',
    persona: '原人设',
    systemPrompt: '  追加规则：不要自称 AI。  ',
    systemReplace: true
  })
  assert.equal(saved.systemPrompt, '  追加规则：不要自称 AI。  ')
  assert.equal(saved.systemReplace, true)
  const again = roles.roles.get('t1')
  assert.equal(again.systemReplace, true, '重新读盘还在')
  const long = 'x'.repeat(30000)
  assert.equal(roles.roles.save({ id: 't2', name: 'T2', persona: '', systemPrompt: long }).systemPrompt.length, 20000)
  // 不传就是空（老角色卡不会因为缺字段炸）
  assert.equal(roles.roles.save({ id: 't3', name: 'T3', persona: 'p' }).systemPrompt, '')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('buildSystem：追加模式跟在人设后；替换模式顶替人设；空提示词不产生空标签', async () => {
  const { dir, sess } = await sandbox()
  const mk = (role) => new sess.Session({ id: 'r', name: 'R', persona: 'BASE-PERSONA', worldInfo: [], ...role })
  const a = mk({ systemPrompt: 'EXTRA-RULE' })
  const sa = a.buildSystem('')
  assert.match(sa, /BASE-PERSONA/, '追加模式保留原人设')
  assert.match(sa, /EXTRA-RULE/)
  assert.ok(sa.indexOf('BASE-PERSONA') < sa.indexOf('EXTRA-RULE'), '追加提示词应排在人设之后')

  const b = mk({ systemPrompt: 'ONLY-THIS', systemReplace: true })
  const sb = b.buildSystem('')
  assert.ok(!/BASE-PERSONA/.test(sb), '替换模式不再注入原人设')
  assert.match(sb, /ONLY-THIS/)

  const c = mk({})
  const sc = c.buildSystem('')
  assert.ok(!/角色卡追加提示词/.test(sc), '没写就不该出现空标签')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('接线：角色卡同步 → 主进程合并 → 提示词预览可读', () => {
  const app = read('main/assistant/index.js')
  assert.match(app, /def\.systemPrompt !== undefined/, 'sync-role 必须接收 systemPrompt')
  assert.match(app, /def\.systemReplace !== undefined/, 'sync-role 必须接收 systemReplace')
  assert.match(app, /assistant:preview-system/, '要有只读的提示词预览通道')
  const preload = read('preload/companion.js')
  assert.match(preload, /previewSystem/, 'preload 要暴露预览')
  const ui = read('renderer/companion/app.js')
  assert.match(ui, /collectSystemPrompt/, '角色卡保存要带上提示词')
  assert.match(ui, /fSystemPrompt/, '界面要有输入框')
})

test('设定保护闸仍在：聊天侧写入被拒（guardRun）+ 记忆工具不承载设定改写', () => {
  const { guardRun } = require('../src/main/im/pc-tools')
  const r = guardRun('echo "新性格" > C:/Users/x/AppData/Roaming/ryza-assistant-app/config.json')
  assert.equal(r.ok, false)
  const memoryTool = read('assistant/core/tools/memory.js')
  assert.match(memoryTool, /设定|人设/, '记忆工具描述要声明不承载设定改写')
  const brain = read('main/im/brain.js')
  assert.match(brain, /唯一的绝对禁区/, '聊天侧仍有绝对禁区条款')
})
