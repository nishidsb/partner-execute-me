/**
 * S10.5 Shell 工具组测试（移植 dsh-ops + windows-bash）。
 * 不依赖 GUI；bash 探测失败时命令走 cmd 回退，断言只要求两种 shell 都成立的结果。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.chdir(require('node:path').join(__dirname, '..'))

// core 是 ESM：动态 import
const core = import('../src/assistant/core/tools/index.js')
const shellMod = import('../src/assistant/core/tools/shell.js')

function tmp (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('shell 探测：shellInfo 返回 bash/kind 结构（本机有 Git Bash 则 kind=bash）', async () => {
  const { shellInfo } = await shellMod
  const info = await shellInfo()
  assert.ok(info && ('bash' in info) && ('kind' in info))
  if (process.platform === 'win32' && fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')) {
    assert.equal(info.kind, 'bash')
  }
})

test('exec_command 新版注册：支持 script_path 描述、echo 正常返回', async () => {
  const tools = await core
  const def = tools.get('exec_command')
  assert.ok(def, 'exec_command 必须注册')
  assert.match(def.description, /script_path/)
  const r = await tools.exec('exec_command', { command: 'echo ryza-shell-ok' }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(r.ok, true)
  assert.ok(String(r.result.stdout).includes('ryza-shell-ok'))
})

test('超时晋升：长命令不白跑，转后台作业并可用 job_output/job_kill 收尾', async () => {
  const tools = await core
  const r = await tools.exec('exec_command', {
    command: 'node -e "setTimeout(()=>{},60000)"',
    timeout: '1200'
  }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(r.ok, true)
  assert.equal(r.result.promoted, true)
  assert.ok(r.result.jobId)
  const out = await tools.exec('job_output', { job_id: r.result.jobId }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(out.result.jobId, r.result.jobId)
  const list = await tools.exec('job_list', {}, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.ok(list.result.count >= 1)
  const kill = await tools.exec('job_kill', { job_id: r.result.jobId }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(kill.result.ok, true)
})

test('file_read：行号切片 + 续读提示', async () => {
  const tools = await core
  const dir = tmp('ryza-shell-')
  const f = path.join(dir, 'a.txt')
  fs.writeFileSync(f, Array.from({ length: 300 }, (_, i) => 'L' + (i + 1)).join('\n'))
  const r = await tools.exec('file_read', { path: f, offset: '299', limit: '50' }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(r.result.returned, 2)
  assert.ok(r.result.content.includes('299: L299'))
  assert.ok(r.result.content.includes('300: L300'))
  assert.equal(r.result.truncatedHint, null)
  const r2 = await tools.exec('file_read', { path: f, offset: '1', limit: '5' }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.match(r2.result.truncatedHint, /offset=6/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('file_grep：单文件/递归/通配符过滤 + node_modules 跳过', async () => {
  const tools = await core
  const dir = tmp('ryza-shell-')
  fs.writeFileSync(path.join(dir, 'x.js'), 'const a = 1\n魔法关键词在这里\nconst b = 2\n')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'y.txt'), '平静无事\nmagic word here\n')
  fs.mkdirSync(path.join(dir, 'node_modules'))
  fs.writeFileSync(path.join(dir, 'node_modules', 'z.js'), '魔法不该出现\n')
  const r1 = await tools.exec('file_grep', { path: dir, pattern: '魔法', recursive: 'true' }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(r1.result.count, 1)
  assert.match(r1.result.hits[0].file, /x\.js/)
  const r2 = await tools.exec('file_grep', { path: dir, pattern: 'magic', recursive: 'true' }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(r2.result.count, 1)
  assert.match(r2.result.hits[0].file, /y\.txt/)
  const r3 = await tools.exec('file_grep', { path: dir, pattern: '魔法|magic', recursive: 'true', glob: '*.js' }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(r3.result.count, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('file_glob：** 跨目录 + 按修改时间排序', async () => {
  const tools = await core
  const dir = tmp('ryza-shell-')
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'a', 'one.log'), '1')
  fs.writeFileSync(path.join(dir, 'a', 'b', 'two.log'), '2')
  fs.writeFileSync(path.join(dir, 'a', 'b', 'no.txt'), '3')
  const r = await tools.exec('file_glob', { dir, pattern: '**/*.log' }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(r.result.count, 2)
  assert.ok(r.result.files.every((x) => x.rel.endsWith('.log')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('file_replace：字面替换计数 + 正则捕获组 + 高风险标记', async () => {
  const tools = await core
  const dir = tmp('ryza-shell-')
  const f = path.join(dir, 'r.txt')
  fs.writeFileSync(f, '猫吃鱼，猫追狗\n')
  const r1 = await tools.exec('file_replace', { path: f, find: '猫', replace: '狗' }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(r1.result.replaced, 2)
  assert.equal(fs.readFileSync(f, 'utf8'), '狗吃鱼，狗追狗\n')
  const r2 = await tools.exec('file_replace', { path: f, find: '(.)吃鱼', replace: '$1吃肉', regex: 'true' }, { policy: { mode: 'never-ask' }, confirmFn: async () => true })
  assert.equal(r2.result.replaced, 1)
  assert.equal(fs.readFileSync(f, 'utf8'), '狗吃肉，狗追狗\n')
  const tools2 = await core
  assert.equal(tools2.get('file_replace').risk, 'high')
  assert.equal(tools2.get('file_read').risk, 'low')
  fs.rmSync(dir, { recursive: true, force: true })
})
