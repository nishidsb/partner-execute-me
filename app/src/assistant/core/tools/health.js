/**
 * 健康记录工具（0.24.0）：睡眠 / 血压 / 心态 / 体重
 *
 * 她说「昨晚两点半才睡」时自己记下来，而不是只聊过去就忘了。
 * 参数一律 string（部分 OpenAI 兼容端点不认 anyOf / type 数组）。
 * 执行走宿主注入的 bridge（src/main/healthBridge.js）。
 */
import { register } from './registry.js'

let bridge = null

export function setHealthBridge (fn) { bridge = typeof fn === 'function' ? fn : null }

async function call (name, args) {
  if (!bridge) throw new Error('健康记录还没接上（宿主未就绪）')
  return await bridge(name, args)
}

register({
  name: 'health_log',
  description: '记一条主人的身体数据：昨晚几点睡几点起、血压心率、今天心态如何、体重。' +
    '聊天里他随口提到就顺手记下（例如「昨天三点才睡」「血压 130 85」「今天心情一般」），不用刻意问。' +
    '同一个日期可以分多次记，字段会合并。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: '哪一天，默认今天。可写 2026-10-27 / 昨天 / 前天' },
      sleep_bed: { type: 'string', description: '入睡时间，例如 01:30 / 凌晨两点半 → 02:30' },
      sleep_wake: { type: 'string', description: '起床时间，例如 09:10' },
      sleep_hours: { type: 'string', description: '直接说睡了几个小时时填，例如 6.5（有入睡和起床时间就不用填）' },
      bp_sys: { type: 'string', description: '收缩压（高压），例如 128' },
      bp_dia: { type: 'string', description: '舒张压（低压），例如 82' },
      pulse: { type: 'string', description: '心率，例如 72' },
      mood: { type: 'string', description: '心态：1-10 分或口语（很好 / 还行 / 一般 / 累 / 很差）' },
      mood_note: { type: 'string', description: '心态的一句话补充，例如「被组长说了两句」' },
      weight: { type: 'string', description: '体重（kg），例如 68.5' }
    },
    required: []
  },
  risk: 'low',
  exec: async (args) => call('health_log', args || {})
})

register({
  name: 'health_read',
  description: '查主人最近的身体记录（睡眠时长与入睡时间、血压、心态趋势）。' +
    '想关心他「最近是不是睡太晚」「血压有没有好点」时先查，别凭印象说。',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'string', description: '看最近多少天，默认 14' }
    },
    required: []
  },
  risk: 'low',
  exec: async (args) => call('health_read', args || {})
})
