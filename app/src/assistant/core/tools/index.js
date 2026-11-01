/**
 * 工具子系统统一入口：注册内置工具 + 转发 registry。
 * confirmFn / policy 由调用方（Session.send opts / 服务壳）按次传入，不做模块级状态。
 */
import './builtin.js'
// S10.5：Shell 工具组（移植 dsh-ops + windows-bash：bash 优先路由/后台作业/文件四件套），含新版 exec_command
import './shell.js'
// S3：桌宠七工具（执行由宿主注入的 bridge 承担，核心自己不认识 Electron）
import { setPetBridge } from './pet.js'
// 0.18.0 第一批：闹钟三工具（alarm_set / alarm_list / alarm_cancel），走同一条宿主桥
import './alarm.js'
// 0.18.0 第二批：联网搜索 + 网页正文抓取（零依赖；结果一律按外部内容包裹）
import './web.js'
// 0.45.71 学习监督三工具（study_start / study_peek / study_stop）
import './study.js'
// S4：长期记忆三工具（写 PARTNER.md + Git 提交）
import './memory.js'
// S6.5：系统操作三工具（开程序 / 开游戏 / 游戏模式）
import { setSystemBridge } from './system.js'
// 0.24.0：电脑画像两工具（只读翻档案：上网/B站/游戏/使用时长/文件）
import { setProfileBridge } from './profile.js'
// 0.24.0：健康记录两工具（睡眠/血压/心态）
import { setHealthBridge } from './health.js'
// S6：CUA 电脑操作十二工具（截图/点击/输入/微信发送…），执行在主进程子进程里
import { setCuaBridge, hasCua, setCuaVision, cuaVision, cuaPrompt } from './cua.js'
// 0.23 第 3 期：她的工具自迭代（写/跑/列三个元工具 + 部署后的 utool_* 动态注册）
import { setUserToolsBridge, syncUserTools, USER_TOOL_CHAT } from './usertools.js'
import { exec, listDefs, list, get, needConfirm, setGate, isAllowed, register, unregister } from './registry.js'

/** 电脑操作工具名单：用户没开启前一律隐藏 */
export const CUA_TOOLS = [
  'screenshot', 'zoom', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'windows', 'focus', 'wait',
  'wechat_send'
]

/** CUA 是否真的可用（接线完成 + 用户已开启） */
function cuaActive () {
  if (!hasCua()) return false
  return CUA_TOOLS.some((n) => isAllowed(n))
}

export {
  exec, listDefs, list, get, needConfirm, setGate, isAllowed, register, unregister,
  setPetBridge, setSystemBridge, setCuaBridge, hasCua, cuaActive, setCuaVision, cuaVision, cuaPrompt,
  setProfileBridge, setHealthBridge, setUserToolsBridge, syncUserTools, USER_TOOL_CHAT
}
export default {
  exec, listDefs, list, get, needConfirm, setGate, isAllowed, register, unregister,
  setPetBridge, setSystemBridge, setCuaBridge, hasCua, cuaActive, setCuaVision, cuaVision, cuaPrompt,
  setProfileBridge, setHealthBridge, setUserToolsBridge, syncUserTools, USER_TOOL_CHAT
}
