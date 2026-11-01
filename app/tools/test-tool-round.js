#!/usr/bin/env node
/* 0.45.66 工具轮冒烟测试：验证「模型调工具 → 回填 → 第二轮接着说」整条链路真的通。
 *
 * 为什么要有：真机实测发现 thinking 模式下 assistant 消息必须原样回传
 * reasoning_content，否则第二轮直接 400「The reasoning_content in the thinking mode
 * must be passed back to the API」。llm.js 原先不读这个字段。修完必须有个能复现的
 * 测试，不然下次又只能靠用户「她好像不会用工具」这种模糊反馈去猜。
 *
 * 用法：node tools/test-tool-round.js
 * 退出码：0 = 两轮都通；非 0 = 失败（打印服务端原文）
 */
const path = require('path')
const Module = require('module')
const fs = require('fs')
const os = require('os')

// 打桩：llm.js 只依赖 ../logger，脱离 electron 也能跑
const origLoad = Module._load
const logs = []
Module._load = function (req, parent, isMain) {
  if (/(^|\/)logger$/.test(String(req))) {
    return { log: (...a) => { logs.push(a.join(' ')) } }
  }
  return origLoad.apply(this, arguments)
}

const llm = require(path.join(__dirname, '..', 'src', 'main', 'companion', 'llm.js'))

function loadCfg () {
  const p = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'ryza-assistant-app', 'config.json')
  const g = (JSON.parse(fs.readFileSync(p, 'utf8')).global || {}).companion || {}
  return { baseUrl: g.apiBaseUrl || 'https://api.deepseek.com/v1', apiKey: g.apiKey || '', model: g.apiModel || 'deepseek-flash' }
}

async function main () {
  const c = loadCfg()
  console.log('目标: ' + c.model + ' @ ' + c.baseUrl)
  const tools = [{
    type: 'function',
    function: {
      name: 'get_time',
      description: '获取当前的准确时间',
      parameters: { type: 'object', properties: {} }
    }
  }]
  let executed = 0
  const t0 = Date.now()
  const res = await llm.chatStream({
    baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model,
    messages: [
      { role: 'system', content: '你是助手。回答任何与时间有关的问题前，必须先调用 get_time 工具，不要凭记忆猜。' },
      { role: 'user', content: '现在几点了？请先查一下再回答我。' }
    ],
    tools,
    temperature: 0.3,
    toolExec: async (name, args) => {
      executed++
      console.log('  → 工具被调用: ' + name + ' ' + JSON.stringify(args))
      return '现在是 ' + new Date().toLocaleString('zh-CN', { hour12: false })
    },
    onDelta: () => {}
  })
  console.log('耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')
  console.log('工具执行次数: ' + executed)
  console.log('toolResults: ' + JSON.stringify(res.toolResults))
  console.log('最终回答: ' + String(res.content || '').slice(0, 200))

  const roundErr = logs.filter((l) => /400|reasoning|error/i.test(l))
  if (roundErr.length) console.log('日志里的可疑行:\n' + roundErr.join('\n'))
  if (executed === 0) {
    console.log('\n→ 模型这轮没调工具（不算链路失败，但没测到多轮）。重跑试试。')
    process.exit(4)
  }
  if (!String(res.content || '').trim()) {
    console.log('\n→ 第二轮没吐出内容：多轮回填有问题')
    process.exit(1)
  }
  console.log('\n→ 工具轮通过：调用 + 回填 + 续答都正常（reasoning_content 已回传）')
}

main().catch((e) => {
  console.error('失败: ' + (e && e.message))
  process.exit(1)
})
