/**
 * S6.5 系统操作工具：开程序 / 开游戏 / 游戏模式。
 *
 * 与其他工具一样，核心只声明 schema，执行交给宿主注入的 bridge
 * （Electron 主进程 src/main/systemBridge.js）——核心保持纯 ESM、零依赖。
 *
 * risk = 'medium'：默认按设置里的「电脑操作权限」处理，
 * 用户把权限设成「从不询问」或把具体程序加进允许名单后就不再弹确认。
 */
import { register } from './registry.js'

let bridge = null

/** 宿主注入：fn(name, args) → Promise<result> */
export function setSystemBridge (fn) { bridge = typeof fn === 'function' ? fn : null }

async function call (name, args) {
  if (!bridge) throw new Error('系统操作暂时不可用（宿主未接线）')
  return await bridge(name, args)
}

register({
  name: 'open_app',
  description: '在本机启动一个程序（开始菜单/已安装的应用都能按名字找到），例如「QQ」「微信」「Chrome」「记事本」；已在跑同名的也可以直接打开。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '程序名，口语即可：「QQ」「微信」「钉钉」「Edge」' }
    },
    required: ['name']
  },
  risk: 'medium',
  exec: async ({ name }) => call('open_app', { name })
})

register({
  name: 'launch_game',
  description: '从本机游戏库（Steam / Epic / 开始菜单）启动一个游戏，启动后角色会自动进入游戏模式躲到角落。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '游戏名，尽量用库里的名字，例如「原神」「艾尔登法环」' }
    },
    required: ['name']
  },
  risk: 'medium',
  exec: async ({ name }) => call('launch_game', { name })
})

register({
  name: 'game_mode',
  description: '进入或退出游戏模式：进入后角色缩小到屏幕角落、不说话不走路、不挡游戏画面；退出恢复原来的位置和大小。',
  parameters: {
    type: 'object',
    properties: {
      on: { type: 'string', description: '"true" 进入，"false" 退出，不填则切换' }
    },
    required: []
  },
  risk: 'low',
  exec: async ({ on }) => call('game_mode', { on })
})

/**
 * 「电脑操作」开关只能由用户在界面里勾三条风险后打开（故意不做成工具，安全设计）。
 * 但只靠嘴说「去右上角点电脑」，对方经常找不到入口 —— 这里给模型一个无害的引导手段：
 * 把聊天窗带到前台并自动展开「电脑」面板，用户剩下的只有勾选和点开关。
 */
register({
  name: 'open_computer_panel',
  description: '把「电脑操作」设置面板弹到对方面前（聊天窗会自动跳出来并停在电脑面板）。当对方想让你操作电脑/回微信，但这个能力还没开启时调用它，然后口头提醒：勾完三条风险、打开开关就能用了。',
  parameters: { type: 'object', properties: {}, required: [] },
  risk: 'low',
  exec: async () => call('open_computer_panel', {})
})

/* ---------- 0.24.0：桌面状态三件套（旧实现只存在于已废弃的旧聊天通道里，新通道一直没有） ---------- */

register({
  name: 'list_running',
  description: '看看对方电脑上现在开着哪些程序/窗口（带是否前台、是否最小化）。当对方问「我开了什么 / 现在在运行什么 / 帮我看看有没有开着 XX」时调用。',
  parameters: { type: 'object', properties: {}, required: [] },
  risk: 'low',
  exec: async () => call('list_running', {})
})

register({
  name: 'set_volume',
  description: '调整系统音量（0-100）或切换静音。对方说「声音小一点 / 太吵了 / 调大点 / 静音 / 取消静音」时调用。',
  parameters: {
    type: 'object',
    properties: {
      volume: { type: 'string', description: '0-100 的音量值，例如 "30"；不填则切换静音开关' }
    },
    required: []
  },
  risk: 'low',
  exec: async ({ volume }) => call('set_volume', { volume })
})

register({
  name: 'show_desktop',
  description: '显示桌面（等同于 Win+D，把所有窗口收起来）。对方说「回桌面 / 把窗口都收起来」时调用。',
  parameters: { type: 'object', properties: {}, required: [] },
  risk: 'low',
  exec: async () => call('show_desktop', {})
})
