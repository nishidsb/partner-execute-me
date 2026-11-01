/**
 * 0.45.71 学习监督三工具（真正能被聊天的模型看到的那一份）
 *
 * 0.45.68 把 study_start / study_peek / study_stop 加进了 companion/tools.js ——
 * 那是**旧伴生通道**（自主活动那条循环用），真实聊天走的是本目录的 registry，
 * 所以主人 10-31 23:42 说「盯着我刷行测」时，模型手上压根没有这个工具，
 * 只能嘴上答应「はいはい、一点まで、ね」，监督一秒都没跑起来。
 *
 * 这里照 alarm 三工具的写法：执行仍在主进程（companion 的 studyStart / watchOnce / studyStop），
 * 通过同一个 petBridge 转发，不新开通道。
 */
import { register } from './registry.js'

let bridge = null

/** 宿主注入：fn(name, args) => Promise<any>（与 pet_* / alarm_* 共用 setPetBridge 那条） */
export function setStudyBridge (fn) {
  bridge = typeof fn === 'function' ? fn : null
}

function call (name, args) {
  if (!bridge) throw new Error('学习模式未连接（宿主没有注入学习会话）')
  return bridge(name, args || {})
}

register({
  name: 'study_start',
  description: '开启学习监督：你陪主人学习，并且会不定时自己看一眼他的屏幕（主屏副屏都看）——' +
    '在学就安静陪着，在玩游戏/看视频会先说一句小生气，一直不改会彻底生气、罢工一会儿。' +
    '主人说「陪我学习 / 监督我 / 盯着我刷题 / 我要学到几点」时调用。已经在学习中则不会重复开启。' +
    '这场学习的一切都会记账：抽查看到什么、被抓几次、补了多少时间，以后要答得出真数字。',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: '学习目标，例如「行测和申论」。对方说了就传，之后一直记得' },
      minutes: { type: 'integer', description: '打算学多久（分钟），没提就不传' }
    }
  },
  risk: 'low',
  exec: async (args) => call('study_start', args || {})
})

register({
  name: 'study_peek',
  description: '现在就看一眼主人的屏幕，确认他是在学习还是在玩。只在学习监督进行中可用；' +
    '主人说「你自己看啊 / 我在学啊 / 你不信就看看」时调用。看不清就直说看不清，别编。',
  parameters: { type: 'object', properties: {} },
  risk: 'low',
  exec: async () => call('study_peek', {})
})

register({
  name: 'study_stop',
  description: '结束学习模式（温柔收场）。主人说「不学了 / 今天到这 / 结束学习」时调用。',
  parameters: { type: 'object', properties: {} },
  risk: 'low',
  exec: async () => call('study_stop', {})
})
