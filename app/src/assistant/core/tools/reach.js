/**
 * 0.45.93 · 主动发 QQ 消息（qq_send / qq_plan / qq_plan_list / qq_plan_cancel）
 *
 * 用户 11-02 要求：主动发 QQ 消息做成开关，可选随时可发/全时段可发
 * + 「在我这边或者角色那边主动提起什么时候会主动给我发 qq 消息的时候也会发」。
 *
 * 之前她只有「他不在这台电脑前」和「他说了晚安」两个被动入口，自己答应了却没法兑现。
 * 真正的发送/排队/时段判定都在主进程（companion），这里只是工具壳。
 */
import { register } from './registry.js'

let bridge = null

/** 宿主注入：fn(name, args) => Promise<any>（与闹钟/桌宠共用同一条宿主桥） */
export function setReachBridge (fn) {
  bridge = typeof fn === 'function' ? fn : null
}

function call (name, args) {
  if (!bridge) throw new Error('QQ 主动消息未连接（宿主没有注入通道）')
  return bridge(name, args)
}

register({
  name: 'qq_send',
  description: '立刻在 QQ 上给他发一条消息（私聊他本人）。不受「谷时/全时段」限制——' +
    '你们聊到「你什么时候会主动给我发消息」、他说「现在给我发一条」、或你自己想找他的时候，直接用它发。' +
    '失败会返回原因，别假装发过。同一件事别连发（8 秒防抖）。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要发的话本身，像手机短消息，一两句，不要旁白和引号' }
    },
    required: ['text']
  },
  risk: 'medium',
  exec: async (args) => call('qq_send', args || {})
})

register({
  name: 'qq_plan',
  description: '排一条「到点在 QQ 上发给他」的主动消息——你答应「我十点给你发 / 一会儿找你」时必须用这个兑现，' +
    '光嘴上说等于骗人。at 支持 "22:30"（今天过点就排明天）或 "in 30m"；' +
    '给了 text 就发你那句原话，只给 note 就到点你自己现想一句。',
  parameters: {
    type: 'object',
    properties: {
      at: { type: 'string', description: '发送时间："22:30" 或 "in 30m" 或 ISO 时间' },
      text: { type: 'string', description: '想好要发的话（可选）' },
      note: { type: 'string', description: '到点要说的内容要点，让你到时候自己组织语言（可选，和 text 二选一）' }
    },
    required: ['at']
  },
  risk: 'medium',
  exec: async (args) => call('qq_plan', args || {})
})

register({
  name: 'qq_plan_list',
  description: '看看已经排了哪些主动 QQ 消息（时间、内容），以及现在的时段策略（全时段 / 谷时窗口）。' +
    '他问「你什么时候会给我发消息」时先查一遍再回答。',
  parameters: { type: 'object', properties: {} },
  risk: 'low',
  exec: async () => call('qq_plan_list', {})
})

register({
  name: 'qq_plan_cancel',
  description: '取消一条排好的主动消息（id 从 qq_plan_list 拿）；不给 id 就全取消。',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: '计划 id（可选）' } },
    required: []
  },
  risk: 'low',
  exec: async (args) => call('qq_plan_cancel', args || {})
})
