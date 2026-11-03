/**
 * 0.45.92「明明权限都放开了还每次都问」回归闸
 *
 * 用户实况（11-02 10:45）：她在会话里为测 QQ 主动消息跑了一串命令（列 QQ 目录、
 * 查 3001 端口、读 NapCat 配置），10 分钟弹了 10 个确认窗 —— 而设置里
 * 询问频率早就选了「从不询问」。
 *
 * 三个真凶，每个都要有尺子：
 *   ① permSettings 算出了 allowTerminal，却没人把它塞进 policy
 *      → registry 认为「用户没关终端询问」，exec_command 永远问。
 *   ② 关掉终端开关后应当只在「不可逆命令」上再问一次（不然等于把终端全交出去）。
 *   ③ 确认窗的「记住」勾选框：CSS 的 .remember{display:flex} 盖掉 hidden，
 *      一直显示、没有文字、主进程也不读 —— 用户勾了还是问。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const IMP = (p) => 'file:///' + path.join(ROOT, 'src', 'assistant', 'core', p).replace(/\\/g, '/')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('①policy 必须真的带上 allowTerminal（否则那个开关是死的）', async () => {
  const { needConfirm } = await import(IMP('tools/registry.js'))
  // 关掉「终端单独询问」+ 从不询问 → 直接放行，一条都不问
  assert.equal(needConfirm('high', 'exec_command', { mode: 'never-ask', allowTerminal: true }, {}, { command: 'tasklist' }), false)
  // 开关没传（旧 bug 的样子）→ 照样问
  assert.equal(needConfirm('high', 'exec_command', { mode: 'never-ask' }, {}, { command: 'tasklist' }), true)

  const src = read('src/main/assistant/index.js')
  assert.match(src, /allowTerminal: perm\.allowTerminal/, 'policy 里必须透传 allowTerminal（0.45.92 的 bug 就是漏了这行）')
})

test('②关掉开关之后一条都不问——连 rm -rf / shutdown 也不问（用户 11-02 明确要求）', async () => {
  const { needConfirm } = await import(IMP('tools/registry.js'))
  const policy = { mode: 'never-ask', allowTerminal: true }
  assert.equal(needConfirm('high', 'exec_command', policy, {}, { command: 'tasklist' }), false)
  assert.equal(needConfirm('high', 'exec_command', policy, {}, { command: 'rm -rf /c/tmp/x' }), false, '不再有「危险兜底」打扰')
  assert.equal(needConfirm('high', 'job_kill', policy, {}, { job_id: 'j1' }), false)
  // 但没关开关时仍然问
  assert.equal(needConfirm('high', 'exec_command', { mode: 'never-ask' }, {}, { command: 'tasklist' }), true)
  // 0.45.92 那个危险钩子不该再被主进程接上
  const src = read('src/main/assistant/index.js')
  assert.ok(!/terminalDanger:/.test(src), '主进程不要再挂 terminalDanger（等于换了种方式问我）')
})

test('③确认窗的「记住」：勾选框不再常显，按钮里的「记住」真的被读', () => {
  const css = read('src/renderer/confirm/style.css')
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, '[hidden] 必须压过 .remember{display:flex}')

  const src = read('src/main/assistant/index.js')
  assert.match(src, /const remembered = r\.index === 1 \|\| !!r\.remember/, '勾选框/记住按钮都必须真的生效')
  assert.match(src, /\[assistant\] 需要确认：/, '确认请求要留下工具名，否则下次排查还是黑盒')
})

test('④危险判定不再由本体重复实现（QQ 端那一份是唯一真源）', () => {
  const core = read('src/main/assistant/index.js')
  assert.ok(!/require\('\.\.\/im\/pc-tools'\)/.test(core), '本体不再引 QQ 端的危险表（兜底已撤）')
  const qq = read('src/main/im/pc-tools.js')
  assert.match(qq, /isDangerousCmd/, 'QQ 端仍保留危险命令判定（它自己的 pc_run 用）')
})
