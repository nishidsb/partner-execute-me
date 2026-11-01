/**
 * S6 CUA 电脑操作十一工具（规格 4.1）
 *
 * 核心只声明 schema + risk，执行交给宿主注入的 bridge
 * （Electron 主进程 src/main/cua/index.js → engine.js 子进程）。
 * 核心保持纯 ESM、零依赖，也不认识 Win32。
 *
 * 坐标约定（很重要，写进每个工具的描述里）：
 *   模型看到的是**缩放后截图**的像素坐标，不是屏幕坐标。
 *   桥内部用最近一次截图的映射换算，模型不需要知道缩放比。
 *
 * risk 分级：
 *   low    screenshot / zoom / windows / wait —— 只读，不碰键鼠
 *   medium 其余 —— 会真的操作电脑，按「电脑操作权限」档位决定要不要确认
 */
import { register } from './registry.js'

let bridge = null

/** 宿主注入：fn(name, args) → Promise<result> */
export function setCuaBridge (fn) { bridge = typeof fn === 'function' ? fn : null }
export function hasCua () { return !!bridge }

async function call (name, args) {
  if (!bridge) throw new Error('电脑操作暂时不可用（宿主未接线）')
  return await bridge(name, args)
}

const XY = {
  x: { type: 'number', description: '横坐标：最近一张截图里的像素 x（左上角为 0）' },
  y: { type: 'number', description: '纵坐标：最近一张截图里的像素 y（左上角为 0）' }
}

register({
  name: 'screenshot',
  description: '截取当前屏幕（默认只截你正在用的那块屏，多显示器时更清楚），返回一张可以看的图。操作电脑前先截这张图确认状态；每次动作后系统也会自动补一张。',
  parameters: {
    type: 'object',
    properties: {
      all: { type: 'string', description: '填 "true" 时把所有屏幕合成一张（跨屏拖拽时才需要）；默认只截当前屏' }
    },
    required: []
  },
  risk: 'low',
  exec: async ({ all }) => call('screenshot', { all })
})

register({
  name: 'zoom',
  description: '把截图的某个区域放大看清楚（字太小、图标密集时用）。放大后坐标切换为这张放大图的坐标。',
  parameters: {
    type: 'object',
    properties: {
      ...XY,
      w: { type: 'number', description: '放大区域宽度（屏幕像素），默认 400' },
      h: { type: 'number', description: '放大区域高度（屏幕像素），默认 300' }
    },
    required: ['x', 'y']
  },
  risk: 'low',
  exec: async ({ x, y, w, h }) => call('zoom', { x, y, w, h })
})

register({
  name: 'click',
  description: '在截图的某个位置点一下鼠标。按钮默认左键；双击把 count 设为 2。点之前请确认坐标是截图里看到的那个位置。',
  parameters: {
    type: 'object',
    properties: {
      ...XY,
      button: { type: 'string', description: 'left / right / middle，默认 left' },
      count: { type: 'number', description: '点击次数 1 或 2，默认 1' },
      label: { type: 'string', description: '你要点的东西是什么，例如「确定按钮」，方便记录' }
    },
    required: ['x', 'y']
  },
  risk: 'medium',
  exec: async ({ x, y, button, count, label }) => call('click', { x, y, button, count, label })
})

register({
  name: 'move',
  description: '把鼠标移动到截图里的某个位置（不点击），常用于悬停出菜单。',
  parameters: { type: 'object', properties: { ...XY }, required: ['x', 'y'] },
  risk: 'medium',
  exec: async ({ x, y }) => call('move', { x, y })
})

register({
  name: 'drag',
  description: '按住鼠标从一点拖到另一点（拖文件、拖滚动条、拖动窗口）。',
  parameters: {
    type: 'object',
    properties: {
      ...XY,
      toX: { type: 'number', description: '拖到的终点 x（截图坐标）' },
      toY: { type: 'number', description: '拖到的终点 y（截图坐标）' },
      durationMs: { type: 'number', description: '拖动时长毫秒，默认 500；太短有些程序不认' }
    },
    required: ['x', 'y', 'toX', 'toY']
  },
  risk: 'medium',
  exec: async ({ x, y, toX, toY, durationMs }) => call('drag', { x, y, toX, toY, durationMs })
})

register({
  name: 'scroll',
  description: '滚动鼠标滚轮。dy 正数向下滚、负数向上滚（一格约 120）。可以指定滚动的位置。',
  parameters: {
    type: 'object',
    properties: {
      dy: { type: 'number', description: '纵向滚动量，正=向下，负=向上，一格约 120' },
      dx: { type: 'number', description: '横向滚动量，正=向右，负=向左' },
      x: { type: 'number', description: '可选：在哪个位置滚（截图坐标 x）' },
      y: { type: 'number', description: '可选：在哪个位置滚（截图坐标 y）' }
    },
    required: ['dy']
  },
  risk: 'medium',
  exec: async ({ dy, dx, x, y }) => call('scroll', { dy, dx, x, y })
})

register({
  name: 'type',
  description: '在当前光标位置输入文本（中文、英文、emoji 都行）。输入前请先点一下目标输入框。',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要输入的文本' } },
    required: ['text']
  },
  risk: 'medium',
  exec: async ({ text }) => call('type', { text })
})

register({
  name: 'key',
  description: '按组合键，例如 ctrl+s、alt+tab、enter、esc、ctrl+shift+t、win+d、f5。多个键用 + 连接。',
  parameters: {
    type: 'object',
    properties: { keys: { type: 'string', description: '组合键，例如 ctrl+s' } },
    required: ['keys']
  },
  risk: 'medium',
  exec: async ({ keys }) => call('key', { keys })
})

register({
  name: 'windows',
  description: '列出当前打开着的窗口（标题、位置、大小、是否在前台）。想知道「要操作的窗口在哪 / 叫什么」时先看这个。',
  parameters: {
    type: 'object',
    properties: {
      includeMinimized: { type: 'string', description: '"true" 连最小化的窗口一起列；默认只列可见窗口' }
    },
    required: []
  },
  risk: 'low',
  exec: async ({ includeMinimized }) => call('windows', { includeMinimized: includeMinimized === 'true' || includeMinimized === true })
})

register({
  name: 'focus',
  description: '把某个窗口切到前台（可以给标题关键词，或 windows 工具返回的 hwnd）。切完补一张截图。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '窗口标题的一部分，例如「记事本」「Chrome」' },
      hwnd: { type: 'number', description: 'windows 工具返回的窗口句柄（给 hwnd 就不用 title）' }
    },
    required: []
  },
  risk: 'medium',
  exec: async ({ title, hwnd }) => call('focus', { title, hwnd })
})

register({
  name: 'wait',
  description: '等一会儿（最多 10 秒）再继续：程序启动、页面加载、动画结束时用，不要空转轮询。',
  parameters: {
    type: 'object',
    properties: { ms: { type: 'number', description: '等待毫秒，默认 800，最大 10000' } },
    required: []
  },
  risk: 'low',
  exec: async ({ ms }) => call('wait', { ms })
})

/**
 * 微信发送：**不需要模型看得见屏幕**的定点流程。
 * 为什么单独给一个工具：国内常用端点（DeepSeek 等）是纯文本模型，截图塞不进去，
 * 让它靠猜坐标点微信必然点错人。这个工具只走键盘（Ctrl+F 搜人 → 回车 → 打字 → 回车），
 * 中间会把会话截图交给**用户**确认，用户点「发送」才真的发。
 */
register({
  name: 'wechat_send',
  description: '在微信里给某个联系人发一条消息（不用看屏幕，靠键盘完成）。对方说「帮我在微信回某某」「给某某发微信说……」时用这个。会先弹一个带截图的确认窗，用户点「发送」才真发。',
  parameters: {
    type: 'object',
    properties: {
      contact: { type: 'string', description: '联系人在微信里显示的名字（备注名/昵称），要尽量准确' },
      text: { type: 'string', description: '要发送的内容，原样发出' }
    },
    required: ['contact', 'text']
  },
  // 内部自带「带截图的人工确认」，比通用确认更严格，所以这里不再叠加一次通用弹窗
  risk: 'low',
  exec: async ({ contact, text }) => call('wechat_send', { contact, text })
})

/* ---------------- 提示词 ---------------- */
/**
 * 宿主有没有「视觉」决定了这份说明怎么写：
 *   能读图 → 先截图再动手（最可靠）
 *   读不了图 → 明确告诉它别装看得见，改走 windows/focus/key/type 与 wechat_send
 */
let hostVision = true
export function setCuaVision (v) { hostVision = v !== false }
export function cuaVision () { return hostVision }

const BASE_PROMPT = '【能看懂屏幕并操作电脑】你可以截图、点击、拖拽、滚动、输入、按快捷键：\n' +
  '- screenshot：先看一眼屏幕（返回一张图，坐标就是这张图的像素坐标）\n' +
  '- zoom：字太小/图标太密时放大某个区域再看清楚\n' +
  '- click / move / drag / scroll：用截图里的坐标点、拖、滚\n' +
  '- type / key：点中输入框后打字，或按 ctrl+s 这类组合键\n' +
  '- windows / focus：列出窗口、把某个窗口切到前台\n' +
  '- wait：程序启动或页面加载时等一会儿\n' +
  '固定流程：**先 screenshot 再动手**；每次动作后系统会自动补一张新截图，看结果再决定下一步。\n' +
  '坐标永远用「最近一张截图」的像素坐标（左上角 0,0）；截图被重新截过就按新图算。\n' +
  '只点你确实看见的东西；找不到目标就重新截图或 zoom，不要凭猜测点。\n' +
  '动作被拒绝或返回「已让位」时，不要硬试，把情况告诉对方。'

const WECHAT_PROMPT = '【帮忙回微信】对方让你「在微信里回某人 / 给某人发消息」时：\n' +
  '- 用 wechat_send(contact, text)，一次就完成，**不要自己去点微信窗口**（容易点错联系人）；\n' +
  '- contact 填对方说的名字；对方没说内容、只让你「随便回」时，先问一句要回什么，或者按对方给的语气拟一句短的；\n' +
  '- 微信没开的话先用 open_app 打开「微信」，等几秒再调 wechat_send；\n' +
  '- 工具会弹确认窗让人看一眼会话再发。返回 sent:false 就是**没发出去**，把 reason 如实告诉对方，不要说她收到了。'

const BLIND_PROMPT = '【重要：这次你看不到画面】当前模型不能读取图片，所以你收到的截图你看不见。\n' +
  '因此：\n' +
  '- 不要假装「我看到了」「屏幕上显示……」；也不要靠猜坐标去 click；\n' +
  '- 需要定位控件时，优先 windows + focus + key + type 这类不依赖画面的操作；\n' +
  '- 回微信这类任务直接用 wechat_send；\n' +
  '- 如果某件事必须看见屏幕才能做，就如实说明「我这边看不到画面」，并建议对方在设置里换成支持看图的模型（例如 qwen-vl、glm-4v、GPT-4o 这类）。'

export function cuaPrompt () {
  return BASE_PROMPT + '\n' + WECHAT_PROMPT + (hostVision ? '' : '\n' + BLIND_PROMPT)
}
