/**
 * 0.18.0 第一批 · 闹钟三工具（对齐 Coopanion alarm_set / alarm_list / alarm_cancel）
 *
 * 核心零依赖：真正的落盘与定时在主进程（companion/alarms.js），
 * 通过宿主的 petBridge 转发（与 pet_* 同一条桥，不额外开通道）。
 */
import { register } from './registry.js'

let bridge = null

/** 宿主注入：fn(name, args) => Promise<any>（与 pet 工具共用 setPetBridge 的那一个） */
export function setAlarmBridge (fn) {
  bridge = typeof fn === 'function' ? fn : null
}

function call (name, args) {
  if (!bridge) throw new Error('闹钟未连接（宿主没有注入定时器）')
  return bridge(name, args)
}

register({
  name: 'alarm_set',
  description: '给自己设一个闹钟：到时间会主动开口提醒（气泡+朗读+系统通知）。' +
    'time 用 24 小时制 HH:MM。三种用法：① 每天重复：daily=true（默认）；② 今天稍后的一次性：daily=false、不填 date；' +
    '③ 某一天的一次性（明天/后天/几号）：daily=false 且 date 填 YYYY-MM-DD——用户说「明天七点提醒我 X」时 date 必填，' +
    '只给 time 会被当成今天，今天到了就会响。最多同时 20 个。',
  parameters: {
    type: 'object',
    properties: {
      time: { type: 'string', description: '时间，24 小时制 HH:MM，例如 07:30' },
      date: { type: 'string', description: '提醒哪一天，YYYY-MM-DD（例如 2026-11-04）。明天/后天/某月某日的事必填；不填=今天或每天' },
      label: { type: 'string', description: '提醒什么，一句话，例如「喝水」「开会」' },
      daily: { type: 'boolean', description: '是否每天重复，默认 true；给了 date 时忽略（就是那一次）' }
    },
    required: ['time']
  },
  risk: 'low',
  exec: async (args) => call('alarm_set', args || {})
})

register({
  name: 'alarm_list',
  description: '查看现在设了哪些闹钟（时间、内容、是否每天、下一次响的时间）。用户问「你设了几个闹钟」时用。',
  parameters: { type: 'object', properties: {} },
  risk: 'low',
  exec: async () => call('alarm_list', {})
})

register({
  name: 'alarm_cancel',
  description: '取消一个闹钟。可以用 id（先 alarm_list 拿到），也可以只给 time（如 07:30）取消那个时间的闹钟。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '闹钟 id（alarm_list 返回的）' },
      time: { type: 'string', description: '或按时间取消，HH:MM' }
    },
    required: []
  },
  risk: 'low',
  exec: async (args) => call('alarm_cancel', args || {})
})
