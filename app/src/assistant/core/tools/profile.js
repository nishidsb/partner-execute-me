/**
 * 电脑画像工具（0.24.0 · 只读）
 *
 * her 想了解「主人在电脑上是什么样的人」时自己翻档案，而不是让宿主把几万字历史塞进上下文。
 * 核心只声明 schema，真正的读取由宿主注入（src/main/systemBridge.js → profile 模块）。
 *
 * 全线只读：没有任何写文件 / 改设置 / 执行命令的能力。
 */
import { register } from './registry.js'

let bridge = null

/** 宿主注入：fn(name, args) → Promise<result> */
export function setProfileBridge (fn) { bridge = typeof fn === 'function' ? fn : null }

async function call (name, args) {
  if (!bridge) throw new Error('电脑画像还没接上（宿主未就绪）')
  return await bridge(name, args)
}

register({
  name: 'pc_profile',
  description: '翻主人的电脑画像档案（只读）。可查：他最近上网在看什么、**搜索过什么**（最能看出他在想什么）、' +
    '浏览器书签（长期兴趣）、B站收藏和观看、硬盘里装了什么游戏、常用哪些程序各花多久、常用文件夹里有什么文件、' +
    '以及「你观察到的」判断（insight）和你自己写下的印象（impression）。' +
    '想聊他的爱好、作息、最近在折腾什么时先用它查，别凭空猜。',
  parameters: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        description: '要看的段落：profile（总览，默认）/ search（搜索记录）/ bookmarks（书签）/ browsing（浏览记录）/ ' +
          'bili（B站）/ games（游戏与应用库）/ habits（使用时长）/ files（文件概况）/ insight（你从痕迹里推出的判断）/ ' +
          'impression（你自己记下的印象）'
      },
      keyword: {
        type: 'string',
        description: '可选，只看含这个关键词的行（例如「原神」「bilibili」「睡眠」）'
      }
    },
    required: []
  },
  risk: 'low',
  exec: async (args) => call('pc_profile', args || {})
})

register({
  name: 'pc_refresh',
  description: '重新采集一次主人的电脑画像（读浏览器历史、搜索词、书签、B站、游戏库、文件夹名），并重算你的判断。' +
    '采集要几秒钟；只在对方刚说「我最近在看 XX」「我刚装了个游戏」这类你还不知道的事时调，不要每句话都刷。',
  parameters: { type: 'object', properties: {}, required: [] },
  risk: 'low',
  exec: async () => call('pc_refresh', {})
})

register({
  name: 'pc_impression',
  description: '记下一条你对主人的新认识（写进你自己的印象档案，以后每次对话都会看到）。' +
    '**只在真的了解到关于他的新东西时用**：习惯、喜好、忌讳、身体状况、在意的事、上次说过的话。' +
    '他纠正你的时候，用 remove 抹掉旧的、同时 note 写新的。' +
    '不要拿它记流水账（「今天聊了游戏」这种没用的别记），也不要每次对话都记。',
  parameters: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        description: '要记下的一句话，尽量具体、可复用。例如「他说过不喜欢被问工作的事」「腰疼，久坐会难受」「收藏都是原神和崩坏，长期在玩」。不超过 200 字。'
      },
      remove: {
        type: 'string',
        description: '可选：要删掉的旧印象里的关键词（他说「不对/不是这样」时用）。带上 note 就是「用新的替换旧的」。'
      }
    },
    required: []
  },
  risk: 'low',
  exec: async (args) => call('pc_impression', args || {})
})
