'use strict'
/**
 * launcher（桌面状态与系统动作）+ companion/tools.js 四个桌面工具的回归测试。
 *
 * 这一组测的不是「能不能开 QQ」，而是**有没有把话说实**：
 * 旧实现 launcher 一直是 null，四个工具要么回「助手未就绪」，要么（最坏的）
 * launch_program 什么都不做却回答「正在启动「X」」—— 假装成功。
 * 所以断言都盯着「失败必须说失败」这一条。
 *
 * 不启动 PowerShell worker（真机行为靠安装后验证），用 _setWindows 注入窗口表。
 */
const test = require('node:test')
const assert = require('node:assert')

const LIB = [
  { id: 'g_qq', name: 'QQ', kind: 'exe', target: 'C:\\Program Files\\Tencent\\QQ\\QQ.exe' },
  { id: 'g_note', name: '记事本', kind: 'exe', target: 'C:\\Windows\\System32\\notepad.exe' },
  { id: 'g_genshin', name: '原神', kind: 'url', target: 'steam://rungameid/123' }
]

/** 桩掉主进程的 store / logger（tools.js 与 launcher.js 都会 require 它们） */
function stub (rel, exports) {
  const p = require.resolve(rel)
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] }
}
stub('../src/main/store', { get: () => ({ global: { library: LIB } }) })
stub('../src/main/logger', { log: () => {}, logfile: () => '' })

const launcher = require('../src/main/launcher')
const match = require('../src/main/match')
const tools = require('../src/main/companion/tools')

const QQ_EXE = 'C:\\Program Files\\Tencent\\QQ\\QQ.exe'
const NOTE_EXE = 'C:\\Windows\\System32\\notepad.exe'

function win (h, t, pn, pp, extra) {
  return { h, t, pn, pp, fg: false, min: false, r: [0, 0, 800, 600], ...(extra || {}) }
}

/* ---------------------------------------------------------------- 匹配纯函数 */

test('match: exe 全路径命中卡片', () => {
  const list = [{ id: 'g_qq', name: 'QQ', cands: [QQ_EXE.toLowerCase()] }]
  const { map } = match.matchApps(list, [win(11, 'QQ', 'qq', QQ_EXE, { fg: true })], ['qq'])
  assert.equal(map.g_qq.h, 11)
  assert.equal(map.g_qq.fg, true)
})

test('match: 浏览器里搜过名字不算「在跑」', () => {
  const list = [{ id: 'g_genshin', name: '原神', cands: [] }]
  const wins = [win(12, '原神 攻略 - Microsoft Edge', 'msedge', 'C:\\Edge\\msedge.exe')]
  const { map } = match.matchApps(list, wins, ['msedge'])
  assert.equal(map.g_genshin, undefined, '浏览器标题带游戏名不能认领成游戏在运行')
})

test('match: 有进程没窗口 = 托盘驻留（hg 为 null 但算运行中）', () => {
  const list = [{ id: 'g_qq', name: 'QQ', cands: [QQ_EXE.toLowerCase()] }]
  const { map } = match.matchApps(list, [], ['qq'])
  assert.equal(map.g_qq.h, null)
  assert.equal(map.g_qq.tray, true)
})

/* ---------------------------------------------------------------- launcher */

test('launcher: 注入窗口表后能按 exe 找到窗口并映射卡片', () => {
  const snap = launcher._setWindows([
    win(21, 'QQ', 'qq', QQ_EXE),
    win(22, '无标题 - 记事本', 'notepad', NOTE_EXE, { fg: true })
  ], ['qq', 'notepad'])
  assert.equal(snap.windows.length, 2)
  assert.equal(launcher.findWindowForExe(QQ_EXE).h, 21, 'QQ 应按 exe 全路径命中')
  assert.equal(launcher.findWindowForExe(QQ_EXE.toUpperCase()).h, 21, '大小写不影响')
  const apps = launcher.latestApps
  assert.equal(apps.g_qq.h, 21)
  assert.equal(apps.g_note.h, 22)
})

test('launcher: 通用 exe 名（launcher.exe）不认窗口', () => {
  launcher._setWindows([win(31, 'Launcher', 'launcher', 'C:\\Games\\X\\launcher.exe')], ['launcher'])
  assert.equal(launcher.findWindowForExe('C:\\Games\\X\\launcher.exe'), null, '通用名认了就会切错窗口')
})

test('launcher: 非 exe 路径不参与窗口匹配', () => {
  launcher._setWindows([win(41, '某窗口', 'x', 'C:\\X\\x.exe')], ['x'])
  assert.equal(launcher.findWindowForExe('C:\\Users\\me\\Desktop\\QQ.lnk'), null)
  assert.equal(launcher.findWindowForExe(''), null)
})

test('launcher: toggleByHandle 拒绝不在最近扫描里的句柄', () => {
  launcher._setWindows([], [])
  assert.equal(launcher.toggleByHandle(999999), false, '没扫到过的句柄绝不能去 toggle（HWND 会复用）')
  assert.equal(launcher.toggleByHandle(0), false)
  assert.equal(launcher.toggleByHandle('abc'), false)
})

test('launcher: helperCmdPublic 白名单（非法指令/越界音量一律拒）', () => {
  assert.equal(launcher.helperCmdPublic('rm -rf /'), false)
  assert.equal(launcher.helperCmdPublic('toggle 123'), false, 'toggle 只走 toggleByHandle')
  assert.equal(launcher.helperCmdPublic('vol 101'), false, '音量上限 100')
  assert.equal(launcher.helperCmdPublic('vol abc'), false)
  // 合法指令在 worker 不在时也返回 false —— 但那是「没执行」，不是「被拒」，两者都必须是 false
  assert.equal(launcher.helperCmdPublic('vol 30'), false)
  assert.equal(launcher.helperCmdPublic('desk'), false)
})

test('launcher: 刚扫过就复用结果（不重复发命令、不阻塞）', async () => {
  // 模型连问两次「开了什么」不该扫两遍：1.2 秒内直接吃缓存
  launcher._setWindows([win(51, 'A', 'a', 'C:\\a\\a.exe')], ['a'])
  const snap = await Promise.race([
    launcher.scan(),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000))
  ])
  assert.notEqual(snap, 'timeout', 'scan() 有缓存时必须立刻返回')
  assert.ok(snap.windows.some((w) => w.h === 51))
})

/* ---------------------------------------------------------------- 四个工具的说话方式 */

let winApps = {}
const fake = {
  isAlive: true,
  scan: async () => ({ windows: [win(21, '微信', 'wechat', 'C:\\WeChat\\WeChat.exe', { fg: true })], apps: winApps }),
  cards: () => LIB,
  findCard: (q) => LIB.find((c) => c.name.toLowerCase().includes(String(q).toLowerCase())) || null,
  launchCard: () => ({ ok: false, msg: '文件不存在：' + QQ_EXE }),
  toggleByHandle: (h) => h === 21,
  helperCmdPublic: () => true,
  waitVol: async () => ({ v: 30, m: false })
}
tools.init(fake, () => {}, null, null)

test('tools/list_running: 真的把窗口列出来', async () => {
  const r = await tools.exec('list_running', {})
  assert.ok(r.includes('微信'), '应该列出窗口标题，实际：' + r)
})

test('tools/launch_program: 已运行且在前台 → 说明在前台，不重复开', async () => {
  winApps = { g_qq: { h: 21, fg: true } }
  const r = await tools.exec('launch_program', { name: 'QQ' })
  assert.ok(r.includes('已经在前台'), r)
})

test('tools/launch_program: 已运行但不在前台 → 切过去', async () => {
  winApps = { g_qq: { h: 21, fg: false } }
  const r = await tools.exec('launch_program', { name: 'QQ' })
  assert.ok(r.includes('切到前台'), r)
})

test('tools/launch_program: 启动失败必须说失败（不能假装成功）', async () => {
  winApps = {}
  const r = await tools.exec('launch_program', { name: 'QQ' })
  assert.ok(r.includes('没能启动'), '启动失败却回「正在启动」= 假装成功，这条是本次修的核心：' + r)
  assert.ok(r.includes('文件不存在'), '要带上失败原因')
})

test('tools/launch_program: 卡片里没有这个名字 → 报可用名单', async () => {
  winApps = {}
  const r = await tools.exec('launch_program', { name: '钉钉' })
  assert.ok(r.includes('没有「钉钉」'), r)
  assert.ok(r.includes('QQ'), '应该把可用的卡片名念出来：' + r)
})

test('tools/set_volume: 数字音量回报实际值', async () => {
  const r = await tools.exec('set_volume', { volume: 30 })
  assert.ok(r.includes('30'), r)
})

test('tools/set_volume: 不传值 = 切换静音，回报静音态', async () => {
  const r = await tools.exec('set_volume', {})
  assert.ok(r.includes('取消静音') || r.includes('已静音'), r)
})

test('tools/show_desktop: 成功时才说已显示桌面', async () => {
  const r = await tools.exec('show_desktop', {})
  assert.ok(r.includes('已显示桌面'), r)
})

test('tools: 模块没接线时给可操作的说明（不再是「助手未就绪」）', async () => {
  tools.init(null, () => {}, null, null)
  const r = await tools.exec('set_volume', { volume: 10 })
  assert.ok(!r.includes('助手未就绪'), '「助手未就绪」对用户毫无信息量：' + r)
  assert.ok(r.includes('launcher'), '要指向具体模块 + 日志关键字：' + r)
  tools.init(fake, () => {}, null, null)
})
