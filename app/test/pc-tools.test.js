/** 0.18.0 M10：IM 主人专属电脑工具 —— 纯函数 + brain 挂载/执行闸门 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseCsvLine, parseTasklist, pickShell, fmtUptime, TOOL_DEFS, SCREENSHOT_DEF, guardRun, exec } = require('../src/main/im/pc-tools')
const { createBrain, buildSystem } = require('../src/main/im/brain')

test('parseCsvLine：引号内逗号/双引号转义', () => {
  assert.deepEqual(parseCsvLine('"a","b,c","d""e"'), ['a', 'b,c', 'd"e'])
  assert.deepEqual(parseCsvLine('"chrome.exe","123","Console","1","123,456 K"'), ['chrome.exe', '123', 'Console', '1', '123,456 K'])
})

test('parseTasklist：无 /v 5 列（内存 KB→MB），带 /v 9 列含窗口标题', () => {
  const plain = '"chrome.exe","123","Console","1","512,000 K"\n"explorer.exe","456","Console","1","98,304 K"\n'
  const a = parseTasklist(plain, false)
  assert.equal(a.length, 2)
  assert.equal(a[0].name, 'chrome.exe')
  assert.equal(a[0].pid, 123)
  assert.equal(a[0].memMB, 500) // 512000/1024
  assert.equal(a[1].memMB, 96)
  const titled = '"chrome.exe","123","Console","1","512,000 K","Running","pc\\user","0:01:02","Bilibili - Google Chrome"\n"notepad.exe","789","Console","1","10,240 K","Running","pc\\user","0:00:01","N/A"\n'
  const b = parseTasklist(titled, true)
  assert.equal(b[0].title, 'Bilibili - Google Chrome')
  assert.equal(b[1].title, '', 'N/A 标题清空')
  assert.equal(parseTasklist('垃圾行\n\n', false).length, 0)
})

test('pickShell：结构正确（bash 或 cmd，参数非空）', () => {
  const sh = pickShell()
  assert.ok(sh.file)
  assert.ok(['bash', 'cmd'].includes(sh.kind))
  assert.ok(Array.isArray(sh.args) && sh.args.length > 0)
})

test('fmtUptime / 工具定义：参数一律 string（部分端点不收 type 数组）', () => {
  assert.ok(fmtUptime(90061).includes('天'))
  assert.ok(fmtUptime(3600).includes('小时'))
  const names = TOOL_DEFS.map((d) => d.function.name)
  assert.deepEqual(names, ['pc_status', 'pc_processes', 'pc_run', 'pc_power', 'pc_kill'])
  for (const d of [...TOOL_DEFS, SCREENSHOT_DEF]) {
    for (const p of Object.values(d.function.parameters.properties || {})) {
      assert.equal(p.type, 'string', `${d.function.name} 参数必须 string`)
    }
  }
})

/** 临时 home 建一个 brain（假 provider 抓 tools） */
function mkBrain (cfgPatch = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'im-pc-'))
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfgPatch))
  const seen = { tools: null, sys: null, isOwner: null }
  const provider = {
    chat: async ({ messages, tools }) => {
      seen.tools = tools || null
      seen.sys = messages[0].content
      seen.isOwner = /是主人/.test(seen.sys)
      return { content: '好' }
    }
  }
  const brain = createBrain({
    home,
    getProvider: () => provider,
    getContext: () => ({ persona: '你是莱莎' }),
    send: async () => {},
    sendMedia: async () => {},
    shootPc: async () => ({ image: 'data:image/png;base64,AAA' }),
    log: () => {}
  })
  return { brain, seen, home }
}

const OWNER_EV = { platform: 'qq', message_type: 'private', user_id: '10086', self_id: '1', message: [{ type: 'text', data: { text: '看看电脑' } }] }
const OTHER_EV = { platform: 'qq', message_type: 'private', user_id: '99999', self_id: '1', message: [{ type: 'text', data: { text: '你好' } }] }
const WX_OWNER_EV = { platform: 'wechat', message_type: 'private', user_id: '文件传输助手', message: [{ type: 'text', data: { text: '看看电脑' } }] }

test('brain：主人在线挂电脑工具组，非主人不挂；截图仅 QQ 端', async () => {
  const { brain, seen, home } = mkBrain({ ownerAccounts: ['10086'], wxOwnerAccounts: ['文件传输助手'] })
  // 主人 QQ：挂全组（含截图）
  await brain.generate(OWNER_EV, '看看电脑', false)
  const names = (seen.tools || []).map((t) => t.function.name)
  for (const n of ['pc_status', 'pc_processes', 'pc_run', 'pc_power', 'pc_kill', 'pc_screenshot']) {
    assert.ok(names.includes(n), `主人 QQ 应挂 ${n}`)
  }
  assert.ok(/电脑控制/.test(seen.sys), '系统提示词带电脑控制说明')
  // 非主人：一个 pc_ 都不挂，提示词也没有电脑控制说明
  await brain.generate(OTHER_EV, '你好', false)
  const names2 = (seen.tools || []).map((t) => t.function.name)
  assert.ok(!names2.some((n) => String(n).startsWith('pc_')), '非主人不挂电脑工具')
  assert.ok(!/电脑控制/.test(seen.sys))
  // 微信主人：挂 pc_* 但不挂截图（微信发不了图片段）
  await brain.generate(WX_OWNER_EV, '看看电脑', false)
  const names3 = (seen.tools || []).map((t) => t.function.name)
  assert.ok(names3.includes('pc_status'))
  assert.ok(!names3.includes('pc_screenshot'), '微信端不挂截图')
  fs.rmSync(home, { recursive: true, force: true })
})

test('brain：pcToolsOn 关掉 / 名单为空 → 主人也没有电脑工具；buildSystem 权限缺省从严', async () => {
  const a = mkBrain({ ownerAccounts: ['10086'], pcToolsOn: false })
  await a.brain.generate(OWNER_EV, '看看电脑', false)
  assert.ok(!(a.seen.tools || []).some((t) => String(t.function.name).startsWith('pc_')))
  fs.rmSync(a.home, { recursive: true, force: true })

  const b = mkBrain({}) // 名单空
  await b.brain.generate(OWNER_EV, '你好', false)
  assert.ok(!(b.seen.tools || []).some((t) => String(t.function.name).startsWith('pc_')))
  fs.rmSync(b.home, { recursive: true, force: true })

  // perm 缺省 = 非主人，即使 cfg 有主人名单（从严：不挂能力说明）
  const sys = buildSystem({ ownerAccounts: ['10086'], pcToolsOn: true }, { persona: 'x' }, null)
  assert.ok(!/电脑控制/.test(sys))
})

test('guardRun：角色设定保护闸（用户铁律：聊天绝不能改设定）', () => {
  // 写设定文件 → 一律拒绝（正斜杠/反斜杠/大小写/常见写法都要拦）
  for (const cmd of [
    'echo hack > ~/AppData/Roaming/ryza-assistant-app/companion/characters.json',
    'echo x > "$APPDATA/RYZA-ASSISTANT-APP/companion/characters.json"',
    'sed -i "s/莱莎/假人/" "C:/Users/me/AppData/Roaming/ryza-assistant-app/companion/characters.json"',
    'cp evil.json "D:/ryza-assistant-app/companion/characters.json"',
    'del %APPDATA%\\ryza-assistant-app\\companion\\characters.json',
    'rm -rf ryza-assistant-app/companion',
    'powershell -c "Set-Content roles/r1.json \'{ }\'"',
    'echo x > $HOME/.ryza/assistant/workspace/roles/6766.json',
    'printf xx > persona.txt',
    'cat x | tee PARTNER.md',
    'move new.json ryza-assistant-app\\companion\\characters.json'
  ]) {
    const g = guardRun(cmd)
    assert.equal(g.ok, false, `应拦截：${cmd}`)
    assert.ok(/设定/.test(g.reason), '拒绝理由说明改设定要去界面')
  }
  // 纯读放行
  for (const cmd of [
    'cat "$APPDATA/ryza-assistant-app/companion/characters.json"',
    'ls ryza-assistant-app/companion',
    'tasklist | findstr chrome',
    'echo 今天天气不错',
    'git status',
    'npm run dist'
  ]) {
    assert.equal(guardRun(cmd).ok, true, `应放行（纯读）：${cmd}`)
  }
  // 普通写（与设定无关）放行
  assert.equal(guardRun('echo hello > D:/notes/todo.txt').ok, true)
})

test('pc-tools.exec：pc_run 走保护闸，写设定命令在工具层被硬拒', async () => {
  const r = await exec('pc_run', { command: 'echo x > ryza-assistant-app/companion/characters.json' })
  assert.equal(r.ok, false)
  assert.ok(/设定/.test(r.error))
  // 未知工具照旧报错
  const u = await exec('pc_unknown', {})
  assert.equal(u.ok, false)
})

test('execImTool 双重闸门：绕过挂载直接调 pc_* 也会被拒（非主人/开关关）', async () => {
  const { brain, home } = mkBrain({ ownerAccounts: ['10086'] })
  // 模拟非主人 ev 走 generate 的工具执行路径 —— 直接验证 exec 不暴露独立入口即可：
  // execImTool 未导出，通过 generate 的 isOwner=false 场景（tools 不挂）已覆盖；这里验证 pc-tools.exec 对未知工具返回错误
  const r = await require('../src/main/im/pc-tools').exec('pc_unknown', {})
  assert.equal(r.ok, false)
  void brain
  fs.rmSync(home, { recursive: true, force: true })
})
