/**
 * S6 CUA（电脑操作）回归测试
 *
 * 覆盖三块「改坏了用户会直接踩坑」的地方：
 *   1. 坐标几何：截图坐标 → 屏幕坐标（缩放、负坐标、越界报错）
 *   2. 工具门禁：没开启时十一个工具既不出现在工具表也不可调用
 *   3. 权限档位 / 图片剥离：确认频率四档；截图 dataURL 不能进 tool 消息
 *
 * 不启 Electron、不动鼠标键盘，可以在任何机器上跑：
 *   npm run test:cua
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const IMP = (p) => 'file:///' + path.join(__dirname, '..', 'src', 'assistant', 'core', p).replace(/\\/g, '/')
const G = require('../src/main/cua/geometry')

/* ---------------- 1. 坐标几何 ---------------- */
test('geometry：缩放比按最长边收敛，永不放大', () => {
  // 单屏 2560x1440 → 1280x720（0.5）
  assert.equal(G.fitScale(2560, 1440, 1280, 800), 0.5)
  // 双屏 5120x1440 → 1280x360（0.25）
  assert.equal(G.fitScale(5120, 1440, 1280, 800), 0.25)
  // 小区域不放大（scale 上限 1）
  assert.equal(G.fitScale(400, 300, 1280, 800), 1)
  // 竖屏：高度先顶到 800
  assert.equal(G.fitScale(1080, 1920, 1280, 800), 800 / 1920)
})

test('geometry：截图坐标按缩放比换回屏幕坐标（含负坐标多屏）', () => {
  // 副屏在左侧：屏幕区域 x 从 -2560 开始
  const view = G.makeView({ srcX: -2560, srcY: 0, srcW: 2560, srcH: 1440, outW: 1280, outH: 720 })
  assert.equal(view.scale, 0.5)
  // 截图左上角 = 副屏左上角
  assert.deepEqual(G.viewToScreen(view, 0, 0), { x: -2560, y: 0 })
  // 截图正中 = 副屏正中
  assert.deepEqual(G.viewToScreen(view, 640, 360), { x: -1280, y: 720 })
  // 右下角（1280x720 图的最后一个像素）
  assert.deepEqual(G.viewToScreen(view, 1279, 719), { x: -2560 + Math.round(1279 / 0.5), y: Math.round(719 / 0.5) })
})

test('geometry：越界坐标报错而不是夹边（点错地方比不点更可怕）', () => {
  const view = G.makeView({ srcX: 0, srcY: 0, srcW: 1280, srcH: 720, outW: 1280, outH: 720 })
  assert.throws(() => G.viewToScreen(view, 5000, 10), /超出/)
  assert.throws(() => G.viewToScreen(view, 10, -400), /超出/)
  assert.throws(() => G.viewToScreen(view, 'a', 10), /数字/)
  // 轻微越界（模型算差几像素）夹回边界，不报错
  const edge = G.viewToScreen(view, 1284, 723)
  assert.deepEqual(edge, { x: 1279, y: 719 })
  // 没有截图就调用 → 明确要求先截图
  assert.throws(() => G.viewToScreen(null, 1, 1), /还没截过图/)
})

test('geometry：让位阈值 2 秒 idle，最多等 15 秒', () => {
  assert.equal(G.canAct(0), false)
  assert.equal(G.canAct(1999), false)
  assert.equal(G.canAct(2000), true)
  assert.equal(G.yieldExpired(14999), false)
  assert.equal(G.yieldExpired(15001), true)
  assert.equal(G.IDLE_NEED_MS, 2000)
  assert.equal(G.YIELD_MAX_MS, 15000)
})

/* ---------------- 2. 工具声明与门禁 ---------------- */
test('CUA：十二个工具全部注册且 risk 分级正确', async () => {
  const tools = await import(IMP('tools/index.js'))
  const names = tools.CUA_TOOLS
  assert.equal(names.length, 12, '11 个通用工具 + wechat_send')
  const all = tools.list().map((t) => t.name)
  for (const n of names) assert.ok(all.includes(n), '缺少工具 ' + n)
  // 只读（不碰键鼠）/ 自带带图确认的 wechat_send 算 low，其余动作类都是 medium
  const readOnly = ['screenshot', 'zoom', 'windows', 'wait', 'wechat_send']
  for (const n of names) {
    const def = tools.get(n)
    const want = readOnly.includes(n) ? 'low' : 'medium'
    assert.equal(def.risk, want, `${n} 的 risk 应为 ${want}`)
    assert.ok(def.description && def.description.length > 8, n + ' 缺少描述')
    assert.equal(def.parameters.type, 'object', n + ' 的参数必须是 object schema')
  }
  // wechat_send 的核心承诺：不需要模型看图也能发对
  const ws = tools.get('wechat_send')
  assert.deepEqual(Object.keys(ws.parameters.properties).sort(), ['contact', 'text'])
  assert.deepEqual(ws.parameters.required.sort(), ['contact', 'text'])
})

test('CUA：未开启时工具既不出现在工具表也不能被调用', async () => {
  const tools = await import(IMP('tools/index.js'))
  tools.setGate((name) => !tools.CUA_TOOLS.includes(name))
  const hidden = tools.listDefs().map((d) => d.function.name)
  for (const n of tools.CUA_TOOLS) {
    assert.ok(!hidden.includes(n), '未开启时不应暴露 ' + n)
  }
  // 非 CUA 工具不受影响；带路工具必须一直可用（不然模型没法把面板带给用户）
  assert.ok(hidden.includes('get_time'), '其它工具不应被一起关掉')
  assert.ok(hidden.includes('open_computer_panel'), 'open_computer_panel 不受门禁影响')
  await assert.rejects(
    () => tools.exec('screenshot', {}, { confirmFn: async () => true, policy: { mode: 'never-ask' } }),
    /未启用/
  )
  // 开启后回到工具表
  tools.setGate(() => true)
  const opened = tools.listDefs().map((d) => d.function.name)
  for (const n of tools.CUA_TOOLS) assert.ok(opened.includes(n), '开启后应暴露 ' + n)
  tools.setGate(null)
})

test('权限四档：ask-once 有授权期免问，never-ask 从不问，ask-each-turn 每次都问', async () => {
  const reg = await import(IMP('tools/registry.js'))
  assert.equal(reg.needConfirm('medium', 'click', { mode: 'ask-each-turn' }), true)
  assert.equal(reg.needConfirm('medium', 'click', { mode: 'ask-before-acting' }), true)
  assert.equal(reg.needConfirm('medium', 'click', { mode: 'never-ask' }), false)
  assert.equal(reg.needConfirm('medium', 'click', { mode: 'ask-once', grantUntil: Date.now() + 60000 }), false)
  assert.equal(reg.needConfirm('medium', 'click', { mode: 'ask-once', grantUntil: Date.now() - 1000 }), true)
  assert.equal(reg.needConfirm('medium', 'click', { mode: 'ask-once', allowTools: ['click'] }), false)
  // 只读工具任何档位都不问
  assert.equal(reg.needConfirm('low', 'screenshot', { mode: 'ask-each-turn' }), false)
})

/* ---------------- 3. 截图不能进 tool 消息 ---------------- */
test('stripImages：dataURL 从工具结果里剥出，只留文字标记', async () => {
  const { stripImages } = await import(IMP('core/session.js'))
  const big = 'data:image/png;base64,' + 'A'.repeat(5000)
  const { value, images } = stripImages({
    image: big,
    width: 1280,
    height: 720,
    after: { image: big, file: 'x.png', width: 1280 }
  })
  assert.equal(images.length, 2, '两层图片都应被收集')
  assert.equal(value.imageOmitted, true)
  assert.equal(value.width, 1280)
  assert.equal(value.after.imageOmitted, true)
  const json = JSON.stringify(value)
  assert.ok(!json.includes('data:image'), '序列化后不能出现 dataURL：' + json.slice(0, 80))
  assert.ok(json.length < 500, '剥离后应该很小，实际 ' + json.length)
})

/* ---------------- 4. 接线与打包（静态检查，防「改了代码没接上」） ---------------- */
const fs = require('node:fs')
const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('接线：主进程把 CUA 桥、门禁、确认窗都接上了', () => {
  const a = read('src/main/assistant/index.js')
  assert.match(a, /setCuaBridge/, '缺少 setCuaBridge 接线')
  assert.match(a, /setGate/, '缺少工具门禁接线')
  assert.match(a, /cuaConfirm\.ask/, '确认必须走自绘确认窗（可超时），不能用同步 dialog')
  assert.match(a, /assistant:cua-state/, '缺少 cua-state IPC')
  assert.match(a, /assistant:cua-set/, '缺少 cua-set IPC')
  const m = read('src/main/main.js')
  assert.match(m, /setIgnoreMouseEvents/, '动作期间要让桌宠让位（穿透）')
  assert.match(m, /require\('\.\/cua'\)\.stop\(\)/, '退出时必须收掉引擎子进程')
  assert.match(m, /setOverlayGuard/, '缺少桌宠穿透让位注入')
})

test('接线：确认窗 60 秒超时 + 三条风险文案存在', () => {
  const c = read('src/main/cua/confirm.js')
  assert.match(c, /TIMEOUT_MS = 60000/, '确认窗超时应为 60 秒')
  assert.match(c, /finish\(-1, false\)/, '超时要按拒绝处理')
  const a = read('src/main/assistant/index.js')
  const items = (a.match(/'[^']*截图[^']*'/g) || []).length
  assert.ok(items >= 1, '风险文案里必须明确提到截图隐私')
  assert.match(a, /CUA_RISK_ITEMS\.every/, '必须三条全勾才能开启')
})

test('接线：聊天窗有「电脑」入口与风险勾选面板', () => {
  const html = read('src/renderer/assistant/index.html')
  assert.match(html, /id="btnCua"/)
  assert.match(html, /id="cuaPanel"/)
  assert.match(html, /id="cuaRisks"/)
  assert.match(html, /id="cuaEnable"/)
  const js = read('src/renderer/assistant/app.js')
  assert.match(js, /syncCuaEnable/, '需要「三条没读完不能开」的逻辑')
  const preload = read('src/preload/assistant.js')
  assert.match(preload, /cuaState/)
  assert.match(preload, /cuaSet/)
})

test('打包：koffi 原生模块必须 unpack（asar 里加载不了 .node）', () => {
  const pkg = JSON.parse(read('package.json'))
  const unpack = (pkg.build && pkg.build.asarUnpack) || []
  // koffi 3.x 把 .node 放在平台包里（@koromix/koffi-win32-x64），
  // 只 unpack node_modules/koffi 是不够的 —— 打包后引擎会因为加载不到 .node 直接起不来
  assert.ok(unpack.some((p) => /@koromix/.test(p)), 'asarUnpack 必须包含 @koromix（koffi 平台包里的 .node）')
  assert.ok(unpack.some((p) => /koffi/.test(p)), 'asarUnpack 必须包含 koffi')
  assert.ok(pkg.dependencies.koffi, 'koffi 必须在 dependencies 里（devDependencies 不会打进包）')
})

/* ---------------- 5. 读不了图的模型：不能装看得见 ---------------- */
test('modelCaps：DeepSeek 按模型名细分（flash 能读图，chat/reasoner 不能），视觉模型判为有视觉', () => {
  const { caps } = require('../src/main/assistant/modelCaps')
  // 2026-10 官方文档：deepseek-flash 直接收图；deepseek-chat/reasoner 仍纯文本
  const dsf = caps({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' })
  assert.equal(dsf.vision, true, 'deepseek-flash 应判为能读图（baseUrl 含 deepseek 不能误杀）')
  const dsc = caps({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' })
  assert.equal(dsc.vision, false, 'deepseek-chat 应判为不能读图')
  assert.ok(dsc.note.includes('DeepSeek'), '要给出原因：' + dsc.note)
  assert.equal(caps({ model: 'deepseek-reasoner' }).vision, false, 'deepseek-reasoner 不能读图')
  for (const m of ['gpt-4o', 'qwen-vl-max', 'glm-4v-plus', 'gemini-1.5-pro', 'claude-3-5-sonnet']) {
    assert.equal(caps({ model: m }).vision, true, m + ' 应判为能读图')
  }
  assert.equal(caps({ model: 'gpt-3.5-turbo' }).vision, false, 'gpt-3.5 不能读图')
  assert.equal(caps({ model: 'qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }).vision, false, 'qwen 文本版走 dashscope 也不能读图（$ 锚点修正）')
  // 用户自己关掉「允许截屏看桌面」时，一律按无视觉
  assert.equal(caps({ model: 'gpt-4o', visionOn: false }).vision, false)
})

test('prompt：无视觉时切成盲操作说明，不能让它「先截图再点」', async () => {
  const tools = await import(IMP('tools/index.js'))
  tools.setCuaVision(true)
  const see = tools.cuaPrompt()
  assert.ok(see.includes('先 screenshot'), '有视觉时应保留「先截图」流程')
  assert.ok(!see.includes('你看不到画面'), '有视觉时不该出现盲操作警告')
  tools.setCuaVision(false)
  const blind = tools.cuaPrompt()
  assert.ok(blind.includes('你看不到画面'), '无视觉时必须明说看不到')
  assert.ok(blind.includes('qwen-vl'), '要给出「换哪个模型」的具体建议')
  assert.ok(blind.includes('wechat_send'), '无视觉时要把回微信指向 wechat_send')
  // 无论哪种模式，都要告诉它微信走 wechat_send，而不是自己去点
  assert.ok(see.includes('wechat_send'), '有视觉时也应优先 wechat_send（点错人代价太大）')
  tools.setCuaVision(true)
})

test('prompt：电脑操作没开时要给「去哪开」，不许说「我没这功能」', async () => {
  const s = read('src/assistant/core/core/session.js')
  assert.match(s, /cuaActive\(\)/, '要按开关状态分岔')
  assert.match(s, /「电脑」/, '未开启时必须指到「电脑」面板这个入口')
  assert.match(s, /不要说你「没有这个功能」/, '禁止模型谎称功能不存在')
  // 开程序只走 open_app，别去 start 进程（那条路会被拒）
  assert.match(s, /不要用 exec_command 去 start/, '要禁止用 exec_command 开程序')
})

test('wechat_send：走键盘定点流程 + 发送前带截图人工确认', () => {
  const c = read('src/main/cua/index.js')
  assert.match(c, /async function wechatSend/, '缺少 wechatSend 实现')
  assert.match(c, /ctrl\+f/, '必须用 Ctrl+F 搜索联系人（不依赖鼠标坐标）')
  assert.match(c, /findWechat/, '要先找到微信主窗口')
  // 人工卡点：确认窗必须带图，用户看得到会话才敢点发送
  assert.match(c, /require\('\.\/confirm'\)\.ask\(/, '发送前必须弹确认窗')
  assert.match(c, /image: shot \? shot\.image : ''/, '确认窗必须带上会话截图')
  assert.match(c, /sent: false/, '取消/超时必须是 sent:false，不能假装发成功')
  // 动作类操作要参与「用户让位」，否则会在用户打字时抢键盘
  assert.match(c, /'wechat_send'\]\)/, 'wechat_send 必须在 ACT_OPS 里（用户在用电脑时让位）')
  const cf = read('src/main/cua/confirm.js')
  assert.match(cf, /hasImage/, '确认窗要按是否带图调整尺寸')
  const html = read('src/renderer/confirm/index.html')
  assert.match(html, /img-src 'self' data:/, 'CSP 必须放行 data: 图片，否则截图显示不出来')
  assert.match(html, /id="shot"/, '确认窗需要有放截图的元素')
})

test('open_computer_panel：开关只能用户手点，但入口可以由模型带路', () => {
  const sys = read('src/assistant/core/tools/system.js')
  assert.match(sys, /open_computer_panel/, '工具要注册在系统工具里（不受 CUA 门禁影响）')
  assert.match(sys, /risk: 'low'/, '只是打开一个面板，不能要求确认')
  const sb = read('src/main/systemBridge.js')
  assert.match(sb, /openComputerPanel/, '主进程要接线到面板弹出')
  // 路径回归锁：两者都在 src/main/ 下，写成 '../assistant' 会 Cannot find module（0.6.0 真实事故）
  assert.doesNotMatch(sb, /require\('\.\.\/assistant'\)/, '不能 require ../assistant（会去 src/assistant 找，必炸）')
  assert.match(sb, /require\('\.\/assistant'\)/, '必须 require ./assistant')
  const a = read('src/main/assistant/index.js')
  assert.match(a, /async function openCuaPanel/, '缺少 openCuaPanel 实现')
  assert.match(a, /openCuaPanel,/, '必须导出给 systemBridge 用')
  const pre = read('src/preload/assistant.js')
  assert.match(pre, /onOpenCuaPanel/)
  const js = read('src/renderer/assistant/app.js')
  assert.match(js, /onOpenCuaPanel/, '聊天窗要监听并自动展开面板')
  const s = read('src/assistant/core/core/session.js')
  assert.match(s, /直接调用 open_computer_panel/, '未开启时的引导要改成「我帮你把面板带出来」')
})


test('鼠标延迟修复：穿透基线不得 forward 全屏 mousemove；微信托盘窗口要能找回', () => {
  const main = read('src/main/main.js')
  // 旧基线 setIgnoreMouseEvents(true,{forward:true}) 会把整屏鼠标消息转发进渲染层（发飘根源）
  assert.match(main, /hotRectsByWin/, '主进程要接收渲染层热区上报')
  assert.match(main, /overlay:hot-rects/, '要有热区上报 IPC')
  assert.match(main, /w\.setIgnoreMouseEvents\(!hot\)/, 'poll 命中切换必须无 forward')
  // CUA 让位结束必须回「穿透基线」，不能恢复成可交互（全屏隐形窗吃点击）
  assert.match(main, /else overlayBaseline\(w\)/, 'CUA guard 恢复要走 overlayBaseline')
  const app = read('src/renderer/overlay/app.js')
  assert.match(app, /setHotRects/, '渲染层要上报热区')
  assert.doesNotMatch(app, /window\.aura\.ignoreMouse\(!hot\)/, '渲染层不得再自己切 forward（会和 poll 打架）')
  const eng = read('src/main/cua/engine.js')
  assert.match(eng, /includeHidden/, '窗口枚举要支持隐藏窗口')
  const cua = read('src/main/cua/index.js')
  assert.match(cua, /includeHidden: true/, 'findWechat 必须把托盘里的微信找出来')
  assert.match(eng, /IsIconic\(h\) \|\| !IsWindowVisible\(h\)/, '聚焦要能把隐藏窗口叫回来')
})
