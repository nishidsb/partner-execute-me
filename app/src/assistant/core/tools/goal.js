/**
 * 0.46.28 生活线三工具（goal_set / goal_list / goal_update）
 *
 * 她自己的生活线：给自己定目标、记进展、了结。与闹钟同一条宿主桥
 * （petBridge 转发到 companion/goals.js，按角色工作区落盘 goals.json）。
 * 世界观第 4 条「自主意愿、主动行为与人格成长」的程序层承载。
 */
import { register } from './registry.js'

let bridge = null

/** 宿主注入：fn(name, args) => Promise<any>（与闹钟同一条桥） */
export function setGoalBridge (fn) {
  bridge = typeof fn === 'function' ? fn : null
}

function call (name, args) {
  if (!bridge) throw new Error('生活线未连接（宿主没有注入 goals）')
  return bridge(name, args)
}

register({
  name: 'goal_set',
  description: '给自己定一个新目标/愿望（你正在过的生活的一部分）：想学的东西、想做的事、给自己定的月度小计划。' +
    '用户说「你可以试试…」「你要不要学…」你真想试时，用它记下来——说了就要真记，别只在嘴上答应。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '目标名，一句话，例如「把那部纪录片看完」「学做舒芙蕾」' },
      detail: { type: 'string', description: '补充说明（为什么想做/打算怎么做），可选' }
    },
    required: ['title']
  },
  risk: 'low',
  exec: async (args) => call('goal_set', args || {})
})

register({
  name: 'goal_list',
  description: '看自己现在有哪些目标（进行中/刚完成/卡住了）。想起「我之前说要干嘛来着」时用。',
  parameters: { type: 'object', properties: {} },
  risk: 'low',
  exec: async () => call('goal_list', {})
})

register({
  name: 'goal_update',
  description: '更新一个目标：记录进展（看了两集/练了一次）、完成（做成了！）、或放下（不想继续了）。' +
    'id 从 goal_list 拿。有进展就随手记一笔——一周没动静它会被标记为「卡住」。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '目标 id（goal_list 返回的）' },
      action: { type: 'string', description: 'progress=记进展 / done=完成 / abandon=放下', enum: ['progress', 'done', 'abandon'] },
      note: { type: 'string', description: '一句话：进展/感想，例如「看完第 3 集」「第一次没塌，成了」' }
    },
    required: ['id', 'action']
  },
  risk: 'low',
  exec: async (args) => call('goal_update', args || {})
})
