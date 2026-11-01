/** CLI REPL：交互入口。/help 查看命令。 */
import readline from 'node:readline'
import { getConfig, saveConfig, describeProvider } from '../config.js'
import { roles } from '../roles/roleManager.js'
import { memory } from '../memory/memoryStore.js'
import { Session } from '../core/session.js'
import * as tools from '../tools/registry.js'
import { logger } from '../logger.js'

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`
}

export async function startRepl () {
  const cfg = getConfig()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: C.cyan('ryza> ') })

  const ask = (q) => new Promise((resolve) => rl.question(q, resolve))

  // 高风险工具确认（CLI 内逐次 y/n）
  const confirmFn = async (name, args) => {
    const ans = (await ask(C.yellow(`\n⚠ 高风险操作 [${name}] ${JSON.stringify(args).slice(0, 200)}\n确认执行? (y/N) `))).trim().toLowerCase()
    return ans === 'y' || ans === 'yes'
  }

  let session = null
  const useRole = (id) => {
    const role = roles.get(id)
    if (!role) { console.log(C.red(`角色不存在: ${id}`)); return false }
    if (session) session.saveHistory()
    session = new Session(role)
    cfg.currentRole = id
    saveConfig()
    console.log(C.green(`已切换角色: ${role.name} (${role.id})`))
    return true
  }

  roles.seedBuiltin()
  if (!useRole(cfg.currentRole)) useRole('assistant')

  console.log(C.cyan(`\n=== Ryza Assistant v0.1.0 ===`))
  console.log(C.dim(`模型: ${JSON.stringify(describeProvider())}`))
  console.log(C.dim(`角色: ${session.role.name} (${session.role.id})  |  输入 /help 查看命令\n`))

  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    try {
      if (!input) { rl.prompt(); return }

      if (input.startsWith('/')) {
        await handleCommand(input, { rl, ask, useRole, getSession: () => session, confirmFn })
        rl.prompt()
        return
      }

      if (cfg.provider.type !== 'mock' && !cfg.provider.apiKey) {
        console.log(C.red('未配置 API Key。请运行: npm run import-from-auradesk 导入，或设置环境变量 RYZA_API_KEY，或在 data/config.json 填写 provider.apiKey'))
        rl.prompt()
        return
      }

      let first = true
      const onDelta = (t) => {
        if (first) { process.stdout.write('\n'); first = false }
        process.stdout.write(t)
      }
      const r = await session.send(input, { onDelta, confirmFn })
      if (!first) process.stdout.write('\n')
      if (r.toolResults.length) {
        for (const t of r.toolResults) {
          console.log(C.dim(`  [工具 ${t.name}] ${t.ok ? JSON.stringify(t.result).slice(0, 200) : '失败: ' + t.error}`))
        }
      }
      if (first) console.log(C.dim(`(模型未返回内容, ${r.ms}ms)`))
      rl.prompt()
    } catch (err) {
      console.log(C.red(`\n出错了: ${err.message}`))
      logger.error('REPL 错误:', err.stack || err.message)
      rl.prompt()
    }
  })

  const shutdown = () => {
    try { session && session.saveHistory() } catch {}
    console.log(C.dim('\n已保存，再见。'))
    rl.close()
    process.exit(0)
  }
  rl.on('SIGINT', shutdown)
  rl.on('close', () => process.exit(0))
}

async function handleCommand (input, ctx) {
  const { ask, useRole, getSession, confirmFn } = ctx
  const [cmd, ...rest] = input.split(/\s+/)
  const arg = rest.join(' ')
  const s = getSession()

  switch (cmd) {
    case '/help':
      console.log(`命令:
  /help                     本帮助
  /roles                    列出全部角色
  /use <id>                 切换角色
  /new-role <id>            创建角色（交互式填写）
  /role-info                当前角色详情
  /tools                    已注册工具与风险级别
  /memory <add|list|search|del|clear> [..]  长期记忆管理（按角色独立）
  /history clear            清空当前角色对话历史
  /model                    查看/切换模型配置概要
  /lang <zh|en|ja|>         设置回复语言守卫（空=关闭）
  /exit                     保存并退出`)
      break
    case '/roles': {
      const list = roles.list()
      console.log(list.map((r) => `${r.id === s.role.id ? C.green('→') : ' '} ${r.id}  ${r.name}${r.builtin ? C.dim(' [内置]') : ''}`).join('\n'))
      break
    }
    case '/use':
      useRole(arg)
      break
    case '/new-role': {
      if (!arg) { console.log('用法: /new-role <id>'); break }
      const name = (await ask('角色名称: ')).trim() || arg
      const persona = (await ask('人格/说话风格设定（可多行，回车结束）: ')).trim()
      const lang = (await ask('回复语言守卫 zh/en/ja（回车跳过）: ')).trim()
      const def = roles.save({ id: arg, name, persona, replyLang: lang })
      console.log(`已创建角色 ${def.id}，可用 /use ${def.id} 切换`)
      break
    }
    case '/role-info': {
      const r = s.role
      console.log(JSON.stringify({ id: r.id, name: r.name, replyLang: r.replyLang || '(未启用守卫)', worldInfo: (r.worldInfo || []).length + ' 条', params: r.params }, null, 2))
      break
    }
    case '/tools':
      console.log(tools.list().map((t) => `${t.name.padEnd(14)} [${t.risk}] ${t.description}`).join('\n'))
      break
    case '/memory': {
      const [sub, ...a] = arg.split(/\s+/)
      if (sub === 'add') {
        const f = memory.add(s.role.id, a.join(' '))
        console.log(`已记忆 (${f.id}): ${f.text}`)
      } else if (sub === 'list') {
        const fs = memory.list(s.role.id)
        console.log(fs.length ? fs.map((f) => `${f.id}  ${f.text}`).join('\n') : '(空)')
      } else if (sub === 'search') {
        const hits = memory.search(s.role.id, a.join(' '), 10)
        console.log(hits.length ? hits.map((f) => `${f.id}  ${f.text}`).join('\n') : '(无命中)')
      } else if (sub === 'del') {
        console.log(memory.remove(s.role.id, a[0]) ? '已删除' : '未找到该 id')
      } else if (sub === 'clear') {
        if ((await ask('确认清空当前角色全部记忆? (y/N) ')).toLowerCase() !== 'y') { console.log('已取消'); break }
        memory.clear(s.role.id)
        console.log('已清空')
      } else console.log('用法: /memory add|list|search|del|clear ...')
      break
    }
    case '/history':
      if (rest[0] === 'clear') { s.clearHistory(); console.log('对话历史已清空') } else console.log(`当前角色历史 ${s.history.length} 条。用法: /history clear`)
      break
    case '/model':
      console.log(JSON.stringify(describeProvider(), null, 2))
      break
    case '/lang': {
      const v = rest[0] || ''
      if (v && !['zh', 'en', 'ja'].includes(v)) { console.log('支持: zh / en / ja（或留空关闭）'); break }
      s.role.replyLang = v
      roles.save(s.role)
      console.log(v ? `回复语言守卫: ${v}` : '回复语言守卫: 关闭')
      break
    }
    case '/exit':
      s.saveHistory()
      console.log('再见。')
      process.exit(0)
      break // eslint-disable-line
    default:
      console.log(`未知命令 ${cmd}，/help 查看帮助`)
  }
  void confirmFn
}
