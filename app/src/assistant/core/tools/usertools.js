/**
 * 第 3 期 · 她的工具自迭代（核心只声明 schema，执行在宿主 src/main/assistant/userTools.js）
 *
 * 边界写死在 description 里：脚本只能落在 tools-user 工作区，不碰应用本体。
 * 写入 ≠ 生效——新工具/改动一律回到停用，部署（出现在她的工具表）必须主人在面板里批准。
 * 这三个工具本身由 registry gate 控制（宿主按 userToolsOn 设置放行）；
 * 她写好并部署的工具以 utool_<名字> 注册进 registry（只在 enabled 时存在，无需再过 gate）。
 */
import { register, get, unregister, list } from './registry.js'

let bridge = null

/** 宿主注入：fn(name, args) → Promise<result> */
export function setUserToolsBridge (fn) { bridge = typeof fn === 'function' ? fn : null }

async function call (name, args) {
  if (!bridge) throw new Error('她的工具工作区暂时不可用（宿主未接线）')
  return await bridge(name, args)
}

/** 聊天里能用的三个「元工具」名单（宿主 gate 按 userToolsOn 设置放行） */
export const USER_TOOL_CHAT = ['user_tool_list', 'user_tool_write', 'user_tool_run']

register({
  name: 'user_tool_list',
  description: '看看自己的工具工作区里现在有哪些自建工具（名字、说明、是否已部署启用）。',
  parameters: { type: 'object', properties: {}, required: [] },
  risk: 'low',
  exec: async () => call('list', {})
})

register({
  name: 'user_tool_write',
  description: '写一个或更新一个你自己的小工具脚本（比如「整理某个文件夹」「每天汇报天气」「批量重命名」）。' +
    '脚本只保存在你的 tools-user 工作区，不能碰应用本体和系统文件。' +
    '代码要求：CommonJS，最后一行 module.exports = async (args) => { ... return 结果 }；' +
    'args 是对象（主人或你自己调用时传的参数）；返回值/throw 的错误会原样给到你。' +
    '写完自动做语法校验，没过的不会保存。注意：新写的或改过的工具默认停用，' +
    '想让它常驻可用要请主人在「她的工具」面板里批准部署——写完记得口头提醒一句。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '工具名：3-32 位小写字母/数字/下划线，字母开头，如 zip_pics' },
      description: { type: 'string', description: '这个工具做什么（会显示给主人看）' },
      parameters: { type: 'string', description: '工具参数的 JSON Schema 字符串，如 {"type":"object","properties":{"src":{"type":"string"}},"required":["src"]}；没有参数就传 {}' },
      code: { type: 'string', description: '完整脚本源码（CommonJS，module.exports 导出 async 函数）' }
    },
    required: ['name', 'code']
  },
  risk: 'medium',
  exec: async ({ name, description, parameters, code }) => call('write', { name, description, parameters, code })
})

register({
  name: 'user_tool_run',
  description: '试运行你写的一个自建工具（哪怕还没部署也可以试跑）。args 用 JSON 字符串传；' +
    '运行 15 秒会超时强杀。报错了就读 error 里的堆栈，改完再用 user_tool_write 保存——这就是你的自修复循环。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '工具名（你 user_tool_write 时起的名字）' },
      args: { type: 'string', description: '传给工具的参数，JSON 字符串，如 {"src":"D:/pic"}；没有参数传空字符串' }
    },
    required: ['name']
  },
  risk: 'medium',
  exec: async ({ name, args }) => call('run', { name, argsJson: args || '' })
})

/**
 * 把 manifest 里 enabled 的工具注册成 utool_<名字>（宿主在写/部署/停用后调用）。
 * 停用/删除的自动注销——注册表里不存在 = 模型既看不见也调不了。
 */
export function syncUserTools (manifestObj) {
  const m = manifestObj && typeof manifestObj === 'object' ? manifestObj : {}
  const want = new Set()
  for (const name of Object.keys(m)) {
    const e = m[name] || {}
    if (e.enabled !== true) continue
    let params = { type: 'object', properties: {} }
    try {
      const p = JSON.parse(e.parameters || '{}')
      if (p && p.type === 'object' && p.properties && !Array.isArray(p)) params = p
    } catch { }
    const regName = 'utool_' + name
    want.add(regName)
    if (!get(regName)) {
      register({
        name: regName,
        description: '（你自己写的工具）' + (e.description || name),
        parameters: params,
        risk: 'low',
        exec: async (args) => {
          if (!bridge) throw new Error('工具执行环境未就绪')
          return bridge('run', { name, argsJson: JSON.stringify(args || {}) })
        }
      })
    }
  }
  for (const t of list()) {
    if (t.name.startsWith('utool_') && !want.has(t.name)) unregister(t.name)
  }
}
