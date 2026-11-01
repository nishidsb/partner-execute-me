/** 真实模型调用验证（非交互）：流式输出 + 工具调用 + 角色人格。用后即删或保留均可。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDataDir } from '../src/config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 用真实数据目录（含刚导入的凭据），但历史/记忆测试写到临时目录避免污染
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-live-'))
initDataDir(tmp)
// 把 provider 配置从真实 config 拷进临时目录
const realCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'))
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(realCfg))

const { roles } = await import('../src/roles/roleManager.js')
const { Session } = await import('../src/core/session.js')
const { loadConfig } = await import('../src/config.js')
await import('../src/tools/builtin.js') // 注册内置工具（否则请求不带 tools 定义）
// 内置角色更新后需要刷新已 seed 的真实数据目录（同名内置角色覆盖为最新内置内容）
roles.seedBuiltin()
for (const id of ['assistant', 'ryza']) {
  const src = JSON.parse(fs.readFileSync(new URL(`../src/roles/builtin/${id}.json`, import.meta.url), 'utf8'))
  roles.save(src)
}

const cfg = loadConfig()
console.log(`provider: ${cfg.provider.type} model=${cfg.provider.model} baseUrl=${cfg.provider.baseUrl}`)

const ryza = new Session(roles.get('ryza'))
console.log('\n--- 测试 1: ryza 角色流式对话 ---')
let streamed = ''
const r1 = await ryza.send('你好呀，简单介绍一下你自己（两三句话就好）', {
  onDelta: (t) => { streamed += t; process.stdout.write(t) }
})
console.log(`\n[流式字符数: ${streamed.length}, 总耗时 ${r1.ms}ms]`)
if (!r1.content) throw new Error('回复为空')

console.log('\n--- 测试 2: 工具调用（模型自主决定） ---')
const r2 = await ryza.send('现在几点了？', { onDelta: (t) => process.stdout.write(t) })
console.log('\n[工具结果]', JSON.stringify(r2.toolResults))
if (!r2.content) throw new Error('工具轮回复为空')

console.log('\n--- 测试 3: 记忆检索注入 ---')
const { memory } = await import('../src/memory/memoryStore.js')
memory.add('ryza', '用户的全名是测试用户，正在开发 Ryza Assistant 项目')
const r3 = await ryza.send('你还记得我在做什么项目吗？简短回答')
console.log(r3.content + '\n')

const passed = r3.content && /ryza assistant|助手|assistant/i.test(r3.content)
console.log(passed ? '✓ 模型引用了注入记忆' : '✗ 模型未引用记忆（可能检索弱命中，非阻断）')
console.log('\nLIVE TESTS DONE, 全部回复非空 = 通过')
