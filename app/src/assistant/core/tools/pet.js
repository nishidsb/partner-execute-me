/**
 * 桌宠六工具（S3）：让模型能主动控制桌面角色说话 / 提问 / 走过来 / 做动作 / 改外观习惯 / 闭嘴。
 *
 * 核心保持零依赖：真正的执行由宿主（Electron 主进程）通过 setPetBridge 注入。
 * 未注入（例如单测、纯 CLI 跑核心）时调用工具会抛「桌宠未连接」，而不是静默成功。
 */
import { register } from './registry.js'

let bridge = null

/** 宿主注入：fn(name, args) => Promise<any> */
export function setPetBridge (fn) {
  bridge = typeof fn === 'function' ? fn : null
}

function call (name, args) {
  if (!bridge) throw new Error('桌宠未连接（没有可用的桌面角色窗口）')
  return bridge(name, args)
}

const SLEEP_MIN_SECONDS = 0
const QUIET_MAX_MINUTES = 1440

register({
  name: 'pet_say',
  description: '在角色头顶的气泡里说一句话。表情/动作可以写进台词：' +
    '【动作】会先播完动作再出新气泡，<表情> 会在气泡出现后接着播。' +
    '一次一到两句，不要说空话。气泡停留时长由语音长度决定。',
  parameters: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: '要说的话，可含【动作, 表情】与 <表情> 标记；例如「【wave】你来啦~」'
      },
      speech: {
        type: 'boolean',
        description: '是否朗读这句话，默认 true（沿用「朗读 AI 回复」设置）'
      }
    },
    required: ['script']
  },
  risk: 'low',
  exec: async (args) => call('pet_say', args)
})

register({
  name: 'pet_ask',
  description: '在角色头顶问一个问题，并给出最多 3 个选项（默认还有一个自己回答的输入框）。' +
    '会等到对方回答或超时（约 60 秒）才返回；对方点了哪个选项、或自己写了什么，都在结果里。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '一句话的提问' },
      options: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 3,
        description: '1~3 个短选项，每个不超过 40 字，太长的会被截断'
      },
      allowOwnAnswer: { type: 'boolean', description: '是否给一个自己回答的输入框，默认 true' }
    },
    required: ['question', 'options']
  },
  risk: 'low',
  exec: async (args) => call('pet_ask', args)
})

register({
  name: 'pet_move_to',
  description: '让角色在它所在的那块屏幕上走到某个位置（沿屏幕底部走，可改成跑）。' +
    '到位、被拖拽打断或超过 30 秒时返回结果。',
  parameters: {
    type: 'object',
    properties: {
      to: {
        // 用字符串而不是 anyOf(number|string)：部分 OpenAI 兼容端点对 anyOf 支持不稳，
        // 一个参数就 400 掉整个请求，不值得为省几个引号冒这个风险
        type: 'string',
        description: '目标：left / center / right / cursor（鼠标指针的水平位置），' +
          '或 0~1 的小数字符串表示占屏幕宽度的比例（"0" 最左、"1" 最右，例如 "0.25"）'
      },
      run: { type: 'boolean', description: 'true 用跑，默认走' }
    },
    required: ['to']
  },
  risk: 'low',
  exec: async (args) => call('pet_move_to', args)
})

register({
  name: 'pet_act',
  description: '只做动作或表情、不说话：按顺序播放 1~6 个动作词。立即返回，不等播完。' +
    '动作词直接用中文，常用的有：' +
    '挥手/打招呼、万岁/欢呼/加油、坐下/瘫坐（摆出坐姿几秒）、躺下/睡觉/躺平（真的躺倒）、' +
    '蹲下/抱膝、跳/蹦、转圈/转身、点头、害羞、生气、难过、惊讶。' +
    '适合休息、犯困、庆祝、打招呼这类场合；pet_say 的台词里也能用【坐下】这类标记。' +
    '节制（重要）：大多数回复不需要动作——连环动作会显得像复读机；' +
    '同一个动作别连续几条回复都用，这次用过的下次换别的或不做。',
  parameters: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 6,
        description: '按顺序播放的动作/表情词'
      }
    },
    required: ['actions']
  },
  risk: 'low',
  exec: async (args) => call('pet_act', args)
})

register({
  name: 'pet_set',
  description: '改自己的外观与习惯，只传要改的项。改动立即生效并写进设置。' +
    '目前支持：roam（走动档位）、scale（大小）、bubbleSize / fontSize（气泡与字号）、' +
    'theme（气泡明暗）、sound（音效）、user（你对对方的称呼）、sleepSeconds（暂存）。' +
    'figure / scheme / hoverButtons 要等形象包与悬停按钮阶段才支持，传了会原样回报为不支持。',
  parameters: {
    type: 'object',
    properties: {
      figure: { type: 'string', description: '形象包 id（本阶段不支持，回报为 unsupported）' },
      scheme: { type: 'string', description: '装扮方案（本阶段不支持）' },
      roam: { type: 'string', enum: ['free', 'calm', 'off'], description: 'free 常走动、calm 少动、off 不自己走' },
      scale: { type: 'number', minimum: 0.6, maximum: 2, description: '屏幕上的大小，1 是默认' },
      bubbleSize: { type: 'number', minimum: 0.7, maximum: 1.6, description: '气泡宽高与圆角，1 是默认' },
      fontSize: { type: 'number', minimum: 0.7, maximum: 1.6, description: '气泡字号，1 是默认' },
      theme: { type: 'string', enum: ['dark', 'light'], description: '气泡深色 / 浅色' },
      sound: { type: 'boolean', description: '音效开关' },
      user: { type: 'string', description: '你对对方的称呼（最多 16 字）' },
      snoreSeconds: { type: 'integer', minimum: SLEEP_MIN_SECONDS, maximum: 3600, description: '每次睡着的时长（暂存）' },
      hoverButtons: { type: 'array', items: { type: 'string' }, maxItems: 6, description: '悬停按钮（本阶段不支持）' }
    }
  },
  risk: 'low',
  exec: async (args) => call('pet_set', args)
})

register({
  name: 'pet_quiet',
  description: '安静一段时间：默认不出声、不走动，时间到了自动恢复（不改用户设置）。' +
    'minutes 传 0 立刻结束安静。',
  parameters: {
    type: 'object',
    properties: {
      minutes: { type: 'number', minimum: 0, maximum: QUIET_MAX_MINUTES, description: '安静多少分钟' },
      sound: { type: 'boolean', description: '安静期间是否允许出声，默认 false' },
      roam: { type: 'string', enum: ['off', 'calm'], description: '安静期间的走动档位，默认 off' }
    },
    required: ['minutes']
  },
  risk: 'low',
  exec: async (args) => call('pet_quiet', args)
})
