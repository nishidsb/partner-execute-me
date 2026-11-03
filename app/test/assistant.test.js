/**
 * 助手核心桥接测试：模拟 Electron 主进程环境（CJS require + 动态 import ESM 核心）。
 * 覆盖：ESM 桥接、角色 CRUD/切换隔离、记忆注入、mock 会话 + 工具调用、配置持久化。
 * 运行：npm run test:assistant
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const IMP = (p) => 'file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', p).replace(/\\/g, '/')

test('ESM 桥接：CJS 动态 import 核心模块（Electron 主进程同路径）', async () => {
  const cfgMod = await import(IMP('config.js'))
  assert.ok(cfgMod.DEFAULT_CONFIG, 'config 应可导入')
  const toolMod = await import(IMP('tools/index.js'))
  assert.ok(toolMod.default.listDefs().length > 0, '内置工具应已注册')
})

test('角色 CRUD 与切换隔离：两个角色人设/记忆互不混淆', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-app-test-'))
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const { roles } = await import(IMP('roles/roleManager.js'))
  const { memory } = await import(IMP('memory/memoryStore.js'))
  roles.seedBuiltin()
  roles.save({ id: 't1', name: '测试一', persona: '我是一号' })
  roles.save({ id: 't2', name: '测试二', persona: '我是二号' })
  memory.add('t1', '一号用户喜欢咖啡')
  memory.add('t2', '二号用户喜欢茶')
  const memT1 = memory.list('t1')
  assert.equal(memT1.length, 1)
  assert.match(memT1[0].text, /咖啡/)
  assert.ok(!memory.list('t2').some((f) => /咖啡/.test(f.text)), '记忆不应跨角色泄漏')
  const hits = memory.search('t1', '咖啡', 3)
  assert.ok(hits.length === 1, '检索应命中')
})

test('mock 会话：人格组装 + 工具调用 + 历史持久化', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-app-test2-'))
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const cfg = cfgMod.loadConfig()
  cfg.provider = { type: 'mock', baseUrl: '', apiKey: '', model: 'mock', temperature: 0.8 }
  cfgMod.saveConfig()
  const { roles } = await import(IMP('roles/roleManager.js'))
  const { Session } = await import(IMP('core/session.js'))
  const { memory } = await import(IMP('memory/memoryStore.js'))
  roles.seedBuiltin()
  roles.save({ id: 'm1', name: 'Mock 角色A', persona: 'A 人格' })
  roles.save({ id: 'm2', name: 'Mock 角色B', persona: 'B 人格' })
  memory.add('m1', '用户叫小明')
  const s1 = new Session(roles.get('m1'))
  const s2 = new Session(roles.get('m2'))

  let streamed = ''
  const r = await s1.send('tooltest:1+1', { onDelta: (t) => { streamed += t } })
  // mock 约定：tooltest: 前缀触发 calc 工具 → 第二轮汇总工具结果
  assert.match(r.content, /工具结果/, '工具结果应反映在回复中: ' + r.content)
  assert.match(r.content, /"2"/, 'calc 结果应为 2: ' + r.content)
  const h1 = JSON.parse(fs.readFileSync(path.join(tmp, 'history', 'm1.json'), 'utf8'))
  assert.ok(h1.some((m) => m.role === 'tool'), '工具结果应入历史')
  assert.ok(!fs.existsSync(path.join(tmp, 'history', 'm2.json')), 'B 未对话不应有历史')
  assert.ok(s1.history !== s2.history, '会话应按角色独立')
})

test('配置持久化：provider 修改后落盘并可重载', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-app-test3-'))
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const cfg = cfgMod.loadConfig()
  cfg.provider.model = 'test-model-x'
  cfgMod.saveConfig()
  // 模拟重载：直接读盘验证
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
  assert.equal(raw.provider.model, 'test-model-x')
})

test('v0.3.1 回归：ESM 桥路径常量必须模块级且能解析到真实文件', () => {
  // 复现服务壳的路径拼接（src/main/assistant/index.js 的 IMP + CORE_ROOT）
  const shellDir = path.join(__dirname, '..', 'src', 'main', 'assistant')
  const m = fs.readFileSync(path.join(shellDir, 'index.js'), 'utf8')
  // 0.25.0 教训：它当时是 init() 内的局部 const，而所有 ipcMain.handle 注册在
  // registerIpc() 里，取不到 → 「用量读取失败：coreRoot is not defined」，静态检查全查不出
  const cm = m.match(/^const CORE_ROOT = '([^']+)'/m)
  assert.ok(cm, 'CORE_ROOT 必须在模块顶层声明（缩进在 init() 里的话 registerIpc() 取不到）')
  assert.ok(!/^\s+const coreRoot/m.test(m), '不应残留 init() 里的局部 coreRoot 声明')
  const resolved = path.join(shellDir, cm[1], 'logger.js')
  assert.ok(fs.existsSync(resolved), `CORE_ROOT('${cm[1]}') 必须能定位到核心 logger.js：${resolved}`)
  // 用量 IPC 是在 registerIpc() 里按需 import 的，必须用模块级常量
  assert.match(m, /assistant:usage[\s\S]{0,300}CORE_ROOT \+ 'core\/usage\.js'/, '用量 IPC 应使用 CORE_ROOT 拼路径')
})

test('v0.3.1 回归：回复语言覆盖必须进入 system prompt（否则设置日语却说中文）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-app-test4-'))
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const { Session } = await import(IMP('core/session.js'))
  // 角色卡本身没有语言设置 → 不注入语言要求（这正是修复前的状态）
  const s = new Session({ id: 'lang1', name: 'L', persona: '人格设定', worldInfo: [] })
  assert.ok(!/语言要求/.test(s.buildSystem('你好')), '角色卡无 replyLang 时不应注入语言约束')
  // 设置页语言覆盖（main 侧每次 send 传入）→ 必须生效
  s._lang = 'ja'
  assert.match(s.buildSystem('你好'), /【语言要求·最高优先级】[\s\S]*日文/)
  // 台词语言 = 朗读语言：会话侧也认 auto
  s._lang = 'auto'
  assert.match(s.buildSystem('你好'), /与用户发言相同的语言/)
  // 服务壳必须真的把设置传下去（源码级回归）
  const shell = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assistant', 'index.js'), 'utf8')
  assert.match(shell, /replyLang: lang\.reply/, 'handleSend 必须把设置页 replyLang 传给 session.send')
})

/* ------------------------------ S3：桌宠六工具 ------------------------------ */

test('S3：pet_* 六工具注册齐全，schema 合法，未连接时明确报错', async () => {
  const toolMod = await import(IMP('tools/index.js'))
  const t = toolMod.default
  const names = t.list().map((x) => x.name)
  const WANT = ['pet_say', 'pet_ask', 'pet_move_to', 'pet_act', 'pet_set', 'pet_quiet']
  for (const n of WANT) assert.ok(names.includes(n), '应注册工具 ' + n)

  const defs = t.listDefs().filter((d) => d.function.name.startsWith('pet_'))
  assert.equal(defs.length, 6, 'pet_* 应正好 6 个')
  for (const d of defs) {
    assert.equal(d.function.parameters.type, 'object', d.function.name + ' 参数必须是 object schema')
    assert.ok(String(d.function.description || '').length > 10, d.function.name + ' 描述不能为空')
  }
  // pet_ask 的三选项上限、pet_move_to 的 to 必填、pet_quiet 的 minutes 必填
  const byName = Object.fromEntries(defs.map((d) => [d.function.name, d.function.parameters]))
  assert.equal(byName.pet_ask.properties.options.maxItems, 3)
  assert.deepEqual(byName.pet_move_to.required, ['to'])
  assert.deepEqual(byName.pet_quiet.required, ['minutes'])
  assert.deepEqual(byName.pet_set.properties.roam.enum, ['free', 'calm', 'off'])

  // 没接宿主（纯核心跑）时必须报「桌宠未连接」，不能假装成功
  await assert.rejects(() => t.exec('pet_say', { script: 'hi' }), /桌宠未连接/)
})

test('S3：注入桥后工具调用原样转发给宿主，并把宿主结果带回模型', async () => {
  const toolMod = await import(IMP('tools/index.js'))
  const t = toolMod.default
  const calls = []
  t.setPetBridge(async (name, args) => {
    calls.push({ name, args })
    return { echoed: name, argKeys: Object.keys(args || {}) }
  })
  try {
    const r = await t.exec('pet_act', { actions: ['wave', 'happy'] })
    assert.equal(r.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'pet_act')
    assert.deepEqual(calls[0].args, { actions: ['wave', 'happy'] })
    assert.equal(r.result.echoed, 'pet_act')
    // 未知工具名仍应报错（不能因为桥存在就把错名吞掉）
    await assert.rejects(() => t.exec('pet_nonexistent', {}), /未注册的工具/)
  } finally {
    t.setPetBridge(null)
  }
})

test('S3：system prompt 会说明桌宠表现工具的使用边界', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-app-test5-'))
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const { Session } = await import(IMP('core/session.js'))
  const sys = new Session({ id: 's3', name: 'S3', persona: '人格', worldInfo: [] }).buildSystem('你好')
  assert.match(sys, /pet_say/)
  assert.match(sys, /pet_move_to/)
  assert.match(sys, /普通闲聊不必每个回合都调用|不必每个回合/)
})

test('S3：主进程桥注册到工具系统（源码级：懒加载，避免 boot 顺序耦合）', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assistant', 'index.js'), 'utf8')
  assert.match(shell, /setPetBridge\(\(name, args\) => require\('\.\.\/petBridge'\)\.invoke\(name, args\)\)/,
    'assistant 服务壳必须把工具调用接到 petBridge')
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'petBridge.js'), 'utf8')
  for (const name of ['pet_say', 'pet_ask', 'pet_move_to', 'pet_act', 'pet_set', 'pet_quiet']) {
    assert.match(bridge, new RegExp("case '" + name + "'"), 'petBridge 必须实现 ' + name)
  }
  // 提问必须能超时，否则工具循环会永久卡住
  assert.match(bridge, /ASK_TIMEOUT_MS/)
})

/* -------------------- 跨屏拖拽回归（用户报「拖不到另一个屏幕」） -------------------- */

test('跨屏拖拽：拖拽期间两块屏都渲染、不切 hidden（否则捕获被打断）', () => {
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'pet.js'), 'utf8')
  assert.match(pet, /const needHide = dragging \? false : !inside/,
    '拖拽中必须保持 stage 可见，不能按宿主判定隐藏')
  assert.match(pet, /window\.__petDragging \|\| window\.__petDragActive/,
    '拖拽状态要同时认本地发起窗口与全局广播')
  // hidden → 显示后必须重测尺寸再落位，否则接管屏用错误宽高把角色摆偏
  assert.match(pet, /requestAnimationFrame\(\(\) => \{\s*measureStage\(\)\s*applyGlobalPos\(\)/)
})

test('跨屏拖拽：pointercancel 不当作松手（只留兜底定时器）', () => {
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'pet.js'), 'utf8')
  assert.match(pet, /kind === 'pointercancel'/)
  assert.match(pet, /cancelGuard/)
  assert.match(pet, /petDragEnd\('up'\)/)
})

test('跨屏拖拽：拖拽中不动窗口层级（SetWhy），松手来源进日志', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  assert.match(main, /if \(!force && isPetDragging\(\)\) return/, '拖拽中 raiseOverlays 必须让路')
  assert.match(main, /isPetDragging = \(\) =>/, '必须把桌宠拖拽状态接进 main')
  const petMain = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'companion', 'pet.js'), 'utf8')
  assert.match(petMain, /来源=/, 'dragEnd 日志要带来源，便于区分渲染层松手/探针兜底')
  assert.match(petMain, /拖拽跨屏 → 显示器/, '跨屏要有诊断日志')
  assert.match(petMain, /isDragging: \(\) => !!drag/)
})

/* ---------- 跨屏「拖过去画面全透明」回归：gl.viewport 必须随画布重建 ---------- */

test('跨屏显示：canvas 尺寸变化后必须显式重设 gl.viewport（否则绘制被钉在 1x1）', () => {
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'pet.js'), 'utf8')
  const fn = pet.slice(pet.indexOf('function sizeGL ()'), pet.indexOf('function sizeGL ()') + 1400)
  assert.match(fn, /gl\.viewport\(0, 0, w, h\)/,
    '改 canvas.width 不会自动同步 gl.viewport，必须在尺寸变化时显式设置')
  assert.match(fn, /gl\.scissor\(0, 0, w, h\)/, 'scissor 也要一起对齐，防旧 1x1 裁剪')
  assert.match(fn, /sizeTag !== lastGLSize/, '只在尺寸变化时同步，避免每帧多余 GL 调用')
})

test('跨屏显示：取消隐藏的那一帧就调用 resize，别等下一帧 step', () => {
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'pet.js'), 'utf8')
  assert.match(pet, /resize: sizeGL,/, 'spineRuntime 必须暴露 resize')
  assert.match(pet, /if \(spineRuntime && spineRuntime\.resize\) spineRuntime\.resize\(\)/,
    'applyGlobalPos 放开 hidden 后要立刻对齐尺寸')
})

/* ------------------------------ S4：PARTNER.md 记忆 ------------------------------ */

function tmpData (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-' + tag + '-'))
}

test('S4：PARTNER.md 建区 / 写入指定分区 / 检索 / 遗忘 / 整份注入', async () => {
  const tmp = tmpData('mem')
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const p = await import(IMP('memory/partner.js'))
  p.resetCache()
  p.ensureWorkspace({ legacyFacts: [{ text: '旧的：喜欢咖啡' }] })

  const doc0 = p.readDoc()
  for (const s of p.SECTIONS) assert.match(doc0, new RegExp('## ' + s.title), '模板必须包含分区 ' + s.title)
  assert.match(doc0, /旧的：喜欢咖啡/, '旧 JSON 记忆要一次性迁移进 PARTNER.md')

  p.remember('对方叫小蓝，写代码的', { section: 'about' })
  const doc1 = p.readDoc()
  const aboutPart = doc1.slice(doc1.indexOf('## 关于你')).split('\n## ')[0]
  assert.match(aboutPart, /小蓝/, 'remember 必须写进指定分区')
  assert.ok(!doc1.slice(doc1.indexOf('## 长期事实')).includes('小蓝'), '不该串到别的分区')

  assert.ok(p.recall('小蓝').length >= 1, 'recall 要能搜到')
  const forgot = p.forget('小蓝')
  assert.equal(forgot.ok, true)
  assert.ok(!p.readDoc().includes('小蓝'), 'forget 要真的删掉')

  const prompt = p.buildPrompt()
  assert.match(prompt, /PARTNER\.md/)
  assert.match(prompt, /关于这个人的记忆/)
  assert.match(prompt, /每次请求时都会被整份读入/)
})

test('S4：Git 历史（写入产生提交 / 查看旧版本 / 回滚是新增提交）', async (t) => {
  const tmp = tmpData('git')
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const p = await import(IMP('memory/partner.js'))
  p.resetCache()
  p.ensureWorkspace()
  if (!p.gitAvailable()) { t.skip('本机没有 git，跳过历史测试'); return }

  const first = p.remember('第一条：喜欢黑咖啡')
  assert.ok(first.hash, '写入应产生提交')
  p.remember('第二条：养了一只猫')
  const hist = p.history(10)
  assert.ok(hist.length >= 2, '历史至少两条')
  assert.ok(hist.every((x) => x.hash && x.at > 0))
  assert.ok(hist.some((x) => x.author === 'ryza'), '模型写入的提交作者应为 ryza')

  const old = p.showAt(first.hash)
  assert.match(old, /黑咖啡/)
  assert.ok(!old.includes('养了一只猫'), '旧版本不该包含后来的内容')

  const back = p.revertTo(first.hash)
  assert.match(back.content, /黑咖啡/)
  assert.ok(!back.content.includes('养了一只猫'), '回滚后内容应回到指定版本')
  const hist2 = p.history(5)
  assert.match(hist2[0].message, /回滚/, '回滚本身也要留一笔历史')
})

test('S4：启动快照 tag 只打一次（同版本重启不重复打 tag）', async (t) => {
  const tmp = tmpData('snap')
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const p = await import(IMP('memory/partner.js'))
  p.resetCache()
  p.ensureWorkspace()
  if (!p.gitAvailable()) { t.skip('本机没有 git'); return }
  const a = p.snapshot('9.9.9')
  assert.ok(a && a.tag === 'start-9.9.9')
  p.remember('快照之后再写一条')
  const b = p.snapshot('9.9.9')
  assert.equal(b.existed, true, '同版本第二次启动只补提交，不重复打 tag')
})

test('S4：升级不覆盖用户改过的人设（SHA-256 判断）', async () => {
  const tmp = tmpData('roles')
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const { roles } = await import(IMP('roles/roleManager.js'))
  roles.seedBuiltin()
  const file = path.join(tmp, 'roles', 'assistant.json')
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(before.builtinSha && before.personaSha, 'seed 必须记录人设指纹')

  // 模拟用户改人设
  fs.writeFileSync(file, JSON.stringify({ ...before, persona: before.persona + '\n【我改的】' }, null, 2))
  roles.seedBuiltin()
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.match(after.persona, /我改的/, '用户改过的人设不能被升级覆盖')
  assert.equal(after.builtinOverride, true)
  assert.equal(after.personaSha, before.personaSha ? require('node:crypto').createHash('sha256').update(after.persona, 'utf8').digest('hex') : undefined)

  // 未改过 → 跟随内置（personaSha == builtinSha）
  fs.writeFileSync(file, JSON.stringify(before, null, 2))
  roles.seedBuiltin()
  const again = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(again.personaSha, again.builtinSha)
  assert.ok(!again.builtinOverride)
})

test('S4：system prompt 整份注入 PARTNER.md（不再依赖 RAG 命中）', async () => {
  const tmp = tmpData('sys')
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const p = await import(IMP('memory/partner.js'))
  p.resetCache()
  p.ensureWorkspace()
  // 记忆跟角色卡走：记忆写到该角色（id=s4）自己的工作区，Session 才注入得进去
  p.remember('对方最喜欢的颜色是深蓝', { scope: 's4' })
  const { Session } = await import(IMP('core/session.js'))
  const sys = new Session({ id: 's4', name: 'S4', persona: '人格设定' }).buildSystem('今天天气怎么样')
  assert.match(sys, /人格设定/)
  assert.match(sys, /关于这个人的记忆/)
  assert.match(sys, /深蓝/, '与当前问题无关的记忆也要整份注入')
})

test('0.46.12：【动作的自动调用】每轮注入，不再随 petTools 说明书节流', async () => {
  const tmp = tmpData('petact')
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const { Session } = await import(IMP('core/session.js'))
  const s = new Session({ id: 'pa1', name: 'PA', persona: '人格' })
  // 造到第 13 轮（user 数 12）：petTools 说明书在 12 轮整已复述过、本轮 turn=13 不复述，
  // 用户话里也没有动作相关词 → 旧实现只剩一行索引，模型看不到标签表（真机 0 标记的根因）
  for (let i = 0; i < 24; i++) {
    s.history.push({ role: i % 2 ? 'assistant' : 'user', content: '普通聊天内容 ' + i, at: Date.now() })
  }
  const sys = s.buildSystem('今天天气怎么样')
  assert.match(sys, /【动作的自动调用】/, '动作自动调用段必须每轮在场（0.46.9 写进节流说明书=等于没写）')
  assert.match(sys, /acknowledge认同[\s\S]*invite邀请/, '11 个语义标签表必须完整在场')
  assert.match(sys, /\[action:grp_fg_106\]/, '组号直嵌语法要在场')
  assert.match(sys, /绝不要写 <pet_act>/, '硬规则要在场')
  // 工具说明书本身仍按预算节流：本轮只有一行索引，不再重复全文
  assert.ok(!/【桌面角色的表现工具】/.test(sys), 'petTools 工具说明书本轮应节流成索引行')
})

test('S4：记忆三工具已注册并能真正写入', async () => {
  const tmp = tmpData('tools')
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const p = await import(IMP('memory/partner.js'))
  p.resetCache()
  p.ensureWorkspace()
  const toolMod = await import(IMP('tools/index.js'))
  const names = toolMod.default.list().map((x) => x.name)
  for (const n of ['remember', 'forget', 'recall_memory']) assert.ok(names.includes(n), '应注册 ' + n)
  assert.ok(names.includes('pet_say'), '原有桌宠工具不能被挤掉')

  const r = await toolMod.default.exec('remember', { text: '对方喜欢雨天散步' })
  assert.equal(r.ok, true)
  assert.match(p.readDoc(), /雨天散步/)
  const q = await toolMod.default.exec('recall_memory', { query: '雨天' })
  assert.equal(q.ok, true)
  assert.ok(q.result.count >= 1)
  const f = await toolMod.default.exec('forget', { fragment: '雨天散步' })
  assert.equal(f.ok, true)
  assert.ok(!p.readDoc().includes('雨天散步'))
  // 太短的片段必须拒绝（防止误删整份文件）
  await assert.rejects(() => toolMod.default.exec('forget', { fragment: '雨' }), /至少 2 个字符/)
})

test('S4：触摸事件合并（2.5s 窗口 + pushNotice）+ 部位上报接线', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assistant', 'index.js'), 'utf8')
  assert.match(idx, /setTimeout\(flushTouch, 2500\)/, '触摸必须按 2.5 秒窗口合并')
  assert.match(idx, /session\.pushNotice/, '合并结果要注入下一次 buildSystem')
  assert.match(idx, /noteTouch/)
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  assert.match(main, /pet:tap-report/)
  assert.match(main, /noteTouch/)
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'pet.js'), 'utf8')
  assert.match(pet, /window\.aura\.petTap/, '部位触摸要上报给主进程')
})

test('S4：长会话归档到 handoffs/ 且归档消息不显示在聊天记录', async () => {
  const tmp = tmpData('handoff')
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const p = await import(IMP('memory/partner.js'))
  p.resetCache()
  p.ensureWorkspace()
  const { Session } = await import(IMP('core/session.js'))
  const s = new Session({ id: 'h1', name: 'H', persona: '' })
  // 造一段超阈值的历史
  for (let i = 0; i < 80; i++) {
    s.history.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) + '#' + i, at: Date.now() })
  }
  const r = s.maybeHandoff()
  assert.ok(r && r.rel && r.rel.startsWith('handoffs/'), '超阈值应写 handoffs/')
  assert.ok(s.history.length <= 26, '上下文要瘦身到最近 24 条附近')
  assert.ok(s.history[0].internal, '归档提示要标 internal（界面不显示）')
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assistant', 'index.js'), 'utf8')
  assert.match(idx, /!m\.internal/, 'history 接口要过滤 internal 消息')
})

/* ==================== S6.5：电脑操作权限 + 游戏 ==================== */

test('S6.5：open_app / launch_game / game_mode 注册齐全，未接线时报错清晰', async () => {
  const toolMod = await import(IMP('tools/index.js'))
  const names = toolMod.default.listDefs().map((d) => d.function.name)
  for (const n of ['open_app', 'launch_game', 'game_mode']) {
    assert.ok(names.includes(n), '缺少工具 ' + n)
  }
  assert.equal(toolMod.default.get('open_app').risk, 'medium', '开程序应走 medium（可被设置放行）')
  assert.equal(toolMod.default.get('game_mode').risk, 'low', '游戏模式只是表现层，不需要确认')
  await assert.rejects(() => toolMod.default.get('open_app').exec({ name: 'QQ' }), /未接线/)
})

test('S6.5：注入系统 bridge 后 open_app 原样转发给宿主并把结果带回', async () => {
  const toolMod = await import(IMP('tools/index.js'))
  let got = null
  toolMod.default.setSystemBridge(async (name, args) => {
    got = { name, args }
    return { opened: 'QQ', source: 'startmenu' }
  })
  const r = await toolMod.default.exec('open_app', { name: 'QQ' }, { policy: { mode: 'never-ask' } })
  assert.deepEqual(got, { name: 'open_app', args: { name: 'QQ' } })
  assert.equal(r.result.opened, 'QQ')
})

test('S6.5：电脑操作权限四档 + 单工具白名单 + 30 分钟授权期', async () => {
  const { needConfirm } = await import(IMP('tools/registry.js'))
  // low 永远不问
  assert.equal(needConfirm('low', 'get_time', {}), false)
  // 四档
  assert.equal(needConfirm('medium', 'open_app', { mode: 'never-ask' }), false, '从不询问应免确认')
  assert.equal(needConfirm('medium', 'open_app', { mode: 'ask-before-acting' }), true, '默认档要确认')
  assert.equal(needConfirm('medium', 'open_app', { mode: 'ask-each-turn' }), true)
  // ask-once：30 分钟内免问，过期恢复询问（exec_command 属于终端类，见下一条）
  assert.equal(needConfirm('medium', 'click', { mode: 'ask-once', grantUntil: Date.now() + 60000 }), false)
  assert.equal(needConfirm('medium', 'click', { mode: 'ask-once', grantUntil: Date.now() - 1000 }), true)
  // 白名单：open_app 放行、其它不受影响
  const p = { mode: 'ask-before-acting', allowTools: ['open_app'] }
  assert.equal(needConfirm('medium', 'open_app', p), false)
  assert.equal(needConfirm('high', 'exec_command', p), true)
})

test('0.18.0：终端单独询问——档位/授权期都管不到 exec_command', async () => {
  const { needConfirm } = await import(IMP('tools/registry.js'))
  // 从不管档：终端仍然问
  assert.equal(needConfirm('high', 'exec_command', { mode: 'never-ask' }), true, 'never-ask 不能放过终端')
  // 30 分钟授权期也放不过
  assert.equal(needConfirm('high', 'exec_command', { mode: 'ask-once', grantUntil: Date.now() + 60000 }), true, '授权期不覆盖终端')
  assert.equal(needConfirm('high', 'job_kill', { mode: 'never-ask' }), true)
  // 用户显式关掉「终端单独询问」→ 才按普通档位走
  assert.equal(needConfirm('high', 'exec_command', { mode: 'never-ask', allowTerminal: true }), false)
  // 显式点名允许某个终端工具 = 用户自己的选择，尊重
  assert.equal(needConfirm('high', 'exec_command', { mode: 'never-ask', allowTools: ['exec_command'] }), false)
  // 非终端的高风险工具不受影响
  assert.equal(needConfirm('high', 'file_replace', { mode: 'never-ask' }), false)
  // 设置页读的是 permTerminalAsk（默认开）
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assistant', 'index.js'), 'utf8')
  assert.match(src, /allowTerminal = c\.permTerminalAsk === false/, 'permSettings 应把开关映射成 allowTerminal')
  assert.match(src, /执行这一次/, '终端确认窗应只给「执行这一次 / 拒绝」')
})

test('S6.5：确认函数按设置走（源码级接线：policy 透传 + 允许名单 + 30 分钟授权）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'assistant', 'index.js'), 'utf8')
  assert.match(src, /function permSettings \(\)/, '应有权限设置读取')
  assert.match(src, /permMode/, '应读设置里的权限档位')
  assert.match(src, /permAllowApps/, '应读允许启动的应用名单')
  assert.match(src, /policy:\s*\{ mode: perm\.mode/, 'policy 必须透传给 session')
  assert.match(src, /30 分钟内都允许/, '对话框应支持一次性授权 30 分钟')
  assert.match(src, /setSystemBridge/, '系统工具 bridge 必须接线')
})

test('S6.5：程序名匹配（大小写/空格/.lnk 后缀/中文名都能命中）', () => {
  const g = require('../src/main/gameLib')
  assert.equal(g.norm('QQ.lnk'), 'qq')
  assert.equal(g.norm('WeChat  - 快捷方式'), 'wechat')
  const lib = [
    { id: '1', name: 'QQ', kind: 'exe', target: 'C://x//QQ.exe', source: 'other' },
    { id: '2', name: 'QQ游戏大厅', kind: 'exe', target: 'C://y//qqgame.exe', source: 'other' },
    { id: '3', name: '微信', kind: 'exe', target: 'C://z//WeChat.exe', source: 'other' }
  ]
  assert.equal(g.findByQuery('QQ', lib).name, 'QQ', '短的精确名应优先')
  assert.equal(g.findByQuery('qq', lib).name, 'QQ', '大小写不敏感')
  assert.equal(g.findByQuery('微信', lib).name, '微信')
  assert.equal(g.findByQuery('不存在的程序abc', lib), null)
})

test('S6.5：游戏模式退出能恢复原位置/大小（源码级：保存 + 还原 + 托盘入口）', () => {
  const gm = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'gameMode.js'), 'utf8')
  assert.match(gm, /saved = \{ pos: prevPos/, '进入时保存原位置')
  // 0.45.83 起退出走 target=saved.pos（先 glideTo， glide 不了才 placeAt）
  assert.match(gm, /const target = saved\.pos/, '退出时要按进入前保存的位置还原')
  assert.match(gm, /pet\.(glideTo|placeAt)\(target/, '退出时恢复原位置')
  assert.match(gm, /call|pet\.setQuiet\(true\)/, '进入时停掉自主走动')
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'companion', 'pet.js'), 'utf8')
  assert.match(pet, /function placeAt \(p\)/, 'pet 要能被外部摆位')
  assert.match(pet, /function getPos \(\)/, 'pet 要能报当前位置')
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  assert.match(main, /label: '游戏模式（角色躲到角落）'/, '托盘要有游戏模式开关')
  assert.match(main, /ipcMain\.handle\('game:launch'/, 'UI 要能启动游戏')
})

test('S6 回归：孤儿 tool 消息必须被修剪（DeepSeek 400 事故，切片边界切散 tool_calls 配对）', async () => {
  const { sanitizeToolChain } = await import(IMP('core/session.js'))

  // 事故复现：窗口从 assistant(tool_calls) 之后开始，留下两条孤儿 tool 结果
  const dirty = [
    { role: 'tool', tool_call_id: 'a1', name: 'open_url', content: 'ok' },
    { role: 'tool', tool_call_id: 'a2', name: 'pet_act', content: 'ok' },
    { role: 'user', content: '在吗' }
  ]
  const clean = sanitizeToolChain(dirty)
  assert.ok(!clean.some((m) => m.role === 'tool'), '孤儿 tool 结果必须全部丢弃')
  assert.equal(clean.length, 1)

  // 正常配对（含并行双调用）必须原样保留
  const paired = sanitizeToolChain([
    { role: 'assistant', content: '', toolCalls: [{ id: 'a1', name: 'x', arguments: '{}' }, { id: 'a2', name: 'y', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 'a1', name: 'x', content: 'r1' },
    { role: 'tool', tool_call_id: 'a2', name: 'y', content: 'r2' },
    { role: 'assistant', content: 'done' }
  ])
  assert.equal(paired.length, 4, '合法配对不能误删')
  assert.equal(paired.filter((m) => m.role === 'tool').length, 2)

  // tool_calls 没等到结果 → 摘掉 tool_calls 只留文本（且不改原对象）
  const dangling = [{ role: 'assistant', content: 'hi', toolCalls: [{ id: 'z', name: 'w', arguments: '{}' }] }]
  const fixed = sanitizeToolChain([...dangling, { role: 'user', content: '嗯' }])
  assert.equal(fixed[0].toolCalls, undefined, '没应答的 tool_calls 要摘掉')
  assert.ok(dangling[0].toolCalls, '原始记录不能被原地改坏')

  // tool 消息 id 不匹配父 assistant → 丢弃
  const mismatch = sanitizeToolChain([
    { role: 'assistant', content: '', toolCalls: [{ id: 'a1', name: 'x', arguments: '{}' }] },
    { role: 'tool', tool_call_id: '别的id', name: 'x', content: 'r' }
  ])
  assert.equal(mismatch.length, 1, 'id 对不上的 tool 结果也要丢')
})

test('S4b：记忆跟角色卡走（scope 隔离 / 旧工作区整体迁移 / 惰性建区）', async (t) => {
  const tmp = tmpData('memscope')
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const p = await import(IMP('memory/partner.js'))
  p.resetCache()

  // 1) 两个角色各自 remember，互相不可见
  p.remember('A 角色记的：喜欢咖啡', { scope: 'roleA' })
  p.remember('B 角色记的：养猫', { scope: 'roleB' })
  const docA = p.readDoc('roleA')
  const docB = p.readDoc('roleB')
  assert.match(docA, /喜欢咖啡/, 'A 的记忆在 A 的工作区')
  assert.ok(!docA.includes('养猫'), 'B 的记忆不能串进 A')
  assert.match(docB, /养猫/, 'B 的记忆在 B 的工作区')
  assert.ok(!docB.includes('喜欢咖啡'), 'A 的记忆不能串进 B')
  // 工作区目录按角色分目录
  const wa = p.workspaceDir('roleA')
  const wb = p.workspaceDir('roleB')
  assert.ok(wa.includes('roleA') && wb.includes('roleB') && wa !== wb, 'workspace/<roleId>/ 各自独立')

  // 2) 旧全局工作区整体迁入指定角色（PARTNER.md 连同 git 历史一起搬）
  p.writeDoc('# 旧工作区内容\n- 旧记忆一条\n', { scope: '', message: '模拟旧全局记忆' })
  const moved = p.migrateLegacyDir('roleC')
  assert.equal(moved, true, '旧工作区要迁给 roleC')
  assert.match(p.readDoc('roleC'), /旧记忆一条/, 'roleC 接手旧记忆')
  assert.ok(!p.readDoc(), '旧全局目录搬空后读不到内容')
  // 第二次不再动（已迁过 / 目录已空）
  assert.equal(p.migrateLegacyDir('roleD'), false, '旧工作区只能迁一次')

  // 3) migrateDir=false 的惰性建区：不动旧目录（防误吞）
  p.resetCache()
  p.writeDoc('# 全局还在\n', { scope: '', message: '重建旧全局' })
  p.ensureWorkspace({ scope: 'roleE', migrateDir: false })
  assert.ok(!p.readDoc('roleE').includes('全局还在'), '惰性建区不能吞掉旧全局记忆')
  assert.match(p.readDoc('roleE') || '', /PARTNER|##/, 'roleE 拿到的是全新模板')

  // 4) buildPrompt 按角色出各自的记忆
  const promptA = p.buildPrompt('roleA')
  assert.match(promptA, /喜欢咖啡/, '注入 A 时带 A 的记忆')
  assert.ok(!promptA.includes('养猫'), '注入 A 时不带 B 的记忆')
})

test('0.25.0 回归：整轮只调工具时不能显示「（空回复）」', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-toolonly-'))
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmp)
  const cfg = cfgMod.loadConfig()
  cfg.provider = { type: 'mock', baseUrl: '', apiKey: '', model: 'mock' }
  cfg.provider.languageGuard = false
  cfgMod.saveConfig()
  const { roles } = await import(IMP('roles/roleManager.js'))
  const { Session } = await import(IMP('core/session.js'))
  roles.seedBuiltin()
  roles.save({ id: 'tl1', name: '工具角色一', persona: 'p' })
  roles.save({ id: 'tl2', name: '工具角色二', persona: 'p' })

  // ① 中途说过一句、之后每轮只发工具调用 → 那句话必须保住（旧代码被最后一轮空串冲掉）
  const s1 = new Session(roles.get('tl1'))
  const r1 = await s1.send('toolonly: 你自己玩玩')
  assert.match(String(r1.content), /^我先看看情况/, '中间轮说过的话不能被后续空轮覆盖：' + JSON.stringify(r1.content))
  assert.ok(r1.toolResults.length >= 5, '应真的跑满多轮工具：' + r1.toolResults.length)

  // ② 一句都没说 → 到轮数上限要补发收尾请求，拿到正文
  const s2 = new Session(roles.get('tl2'))
  const r2 = await s2.send('toolonlyempty: 你自己玩玩')
  assert.ok(String(r2.content).trim().length > 0, '收尾请求必须有正文，不能是空回复')
  assert.match(String(r2.content), /mock/, '收尾正文应来自收尾请求：' + r2.content)
})

test('0.46.17 主动想起：命中升级为「刚刚想起」，同轮缓存 + 冷却闸', async () => {
  const cfgMod = await import(IMP('config.js'))
  cfgMod.initDataDir(tmpData('spark'))
  const { Session } = await import(IMP('core/session.js'))
  const s = new Session({ id: 'spark', name: 'S', persona: '人格' })
  const arr = [{ shown: '他最喜欢的颜色是深蓝' }, { shown: '另一条旧事' }]
  const spark1 = s._takeRecallSpark(arr, 1)
  assert.match(spark1, /【刚刚想起】/)
  assert.match(spark1, /他最喜欢的颜色是深蓝/)
  assert.match(spark1, /自然带出/, '要教她用自己的话说，不是复述')
  assert.equal(arr.length, 1, '被想起的那条从普通相关记忆里摘走，不重复出现')
  assert.equal(s._takeRecallSpark(arr, 2), '', '冷却期内不再想起（活人不每句都「我想起来」）')
  s._recallCoolUntil = 0
  const arr2 = [{ shown: 'C' }, { shown: 'D' }]
  const b1 = s._takeRecallSpark(arr2, 3)
  const b2 = s._takeRecallSpark(arr2, 3)
  assert.equal(b1, b2, '同一轮多次构建 system prompt，想起的是同一件旧事')
  assert.match(b1, /【刚刚想起】/)
  assert.equal(arr2.length, 1)
})
