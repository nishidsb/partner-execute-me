/**
 * 冒烟测试：不依赖外部 API，用 mock 模型跑通全链路：
 * 角色隔离 → mock 对话 → 工具调用循环 → 记忆增查 → 历史持久化 → 重载验证。
 * 运行: npm run smoke
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDataDir, loadConfig, saveConfig } from '../src/config.js'
import { initLogger } from '../src/logger.js'
import { roles } from '../src/roles/roleManager.js'
import { memory } from '../src/memory/memoryStore.js'
import { Session } from '../src/core/session.js'
import { register } from '../src/tools/registry.js'
import * as builtin from '../src/tools/builtin.js'
import { langMismatch } from '../src/core/session.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ryza-smoke-'))
initDataDir(path.join(tmp, 'data'))
initLogger(path.join(tmp, 'logs'))
// 冒烟测试强制用 mock 模型，不依赖外部 API
loadConfig().provider.type = 'mock'
saveConfig()
void builtin // 注册内置工具
let pass = 0, fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  PASS', label) } else { fail++; console.log('  FAIL', label) }
}

console.log('== 1. 角色 seed 与隔离 ==')
roles.seedBuiltin()
const list = roles.list()
ok(list.some((r) => r.id === 'assistant'), '内置角色 assistant 已 seed')
ok(list.some((r) => r.id === 'ryza'), '内置角色 ryza 已 seed')

roles.save({ id: 'tester', name: '测试角色', persona: '测试人格', replyLang: 'en' })
const s1 = new Session(roles.get('assistant'))
const s2 = new Session(roles.get('ryza'))
memory.add('assistant', '用户喜欢喝美式咖啡')
memory.add('ryza', '用户在玩炼金工房系列')
ok(s1 !== s2, '两个角色会话可同时构造')
ok(memory.list('assistant').length === 1 && memory.list('ryza').length === 1, '记忆按角色隔离存储')

console.log('== 2. 世界书命中 ==')
const sysHit = s2.buildSystem('我想聊聊炼金术')
ok(sysHit.includes('炼金釜'), 'ryza 世界书按关键词注入')
const sysMiss = s2.buildSystem('今天天气不错')
ok(!sysMiss.includes('炼金釜'), '不相关输入不注入世界书')

console.log('== 3. mock 对话与工具调用循环 ==')
const r1 = await s1.send('你好')
ok(r1.content === '[mock] 你好', 'mock 回显对话正常: ' + JSON.stringify(r1.content))

const r2 = await s1.send('tooltest:(12+8)*2', {
  confirmFn: async () => true
})
const toolHit = r2.toolResults.find((t) => t.name === 'calc')
ok(toolHit && toolHit.ok && toolHit.result === '40', 'calc 工具调用循环执行成功 (12+8)*2=40: ' + JSON.stringify(toolHit && toolHit.result))
ok(s1.history.some((m) => m.role === 'tool'), 'tool 消息已回填历史')

console.log('== 4. 记忆检索 ==')
memory.add('assistant', '用户的项目 deadline 是周五')
const hits = memory.search('assistant', 'deadline 周五之前要交什么')
ok(hits.length >= 1 && hits[0].text.includes('周五'), '关键词检索命中: ' + JSON.stringify(hits[0] && hits[0].text))
ok(!memory.search('ryza', 'deadline').length, '检索不跨角色泄漏')

console.log('== 5. 历史持久化与重载 ==')
s1.saveHistory()
const s1b = new Session(roles.get('assistant'))
ok(s1b.history.length === s1.history.length, '重新构造会话历史条数一致: ' + s1b.history.length)
ok(s1b.history.some((m) => m.role === 'user' && m.content === '你好'), '历史含用户消息')

console.log('== 6. 语言守卫粗判 ==')
ok(langMismatch('これは日本語です', 'zh') === '日语', '中文角色收到日语 → 判定不符')
ok(langMismatch('你好，今天天气不错', 'zh') === null, '纯中文 → 符合')
ok(langMismatch('これは日本語です', 'ja') === null, '日语角色收日语 → 符合')

console.log('== 7. 工具错误与边界 ==')
const calcTool = (await import('../src/tools/registry.js')).get('calc')
try { await calcTool.exec({ expression: 'process.exit(1)' }); ok(false, 'calc 拒绝非数学输入') } catch { ok(true, 'calc 拒绝非数学输入') }
try { await calcTool.exec({ expression: '(1+2' }); ok(false, 'calc 拒绝括号不配') } catch { ok(true, 'calc 拒绝语法错误表达式') }

console.log(`\n结果: ${pass} PASS / ${fail} FAIL  (临时目录 ${tmp})`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
