/**
 * 0.45.93 · 主动发 QQ 消息（qq_send）
 *
 * 0.47.1 收窄：qq_plan / qq_plan_list / qq_plan_cancel（排一条到点自动发的消息）下架——
 * 主人 11-08 拍板「所有类似的定时硬触发设计都不该有」：人是多变的，计划赶不上变化。
 * 她答应「晚点给你发」就记住这件事（记忆带绝对日期锚点），到点像人一样看情况兑现
 * （正好在聊、状态合适就发一条；没发成下次见面口头认账），不再排定时任务。
 *
 * qq_send 保留：当场想发就发（她此刻的判断，不是定时器），时段/去重/翻译都在主进程。
 */
import { register } from './registry.js'

let bridge = null

/** 宿主注入：fn(name, args) => Promise<any>（与桌宠/学习共用同一条宿主桥） */
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
