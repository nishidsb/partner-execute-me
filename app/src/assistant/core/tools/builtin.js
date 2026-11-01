/**
 * 内置示例工具（第一阶段全部为低风险 + 一个高风险演示）：
 *  get_time    当前时间
 *  system_info OS/内存等只读信息
 *  calc        数学表达式求值（白名单校验）
 *  open_url    用默认浏览器打开网址（低风险自动化示例）
 *  exec_command【高风险演示】执行命令行命令——默认被 confirmFn 拦截，需用户确认
 */
import os from 'node:os'
import { exec as cpExec } from 'node:child_process'
import { promisify } from 'node:util'
import { register } from './registry.js'

const run = promisify(cpExec)

register({
  name: 'get_time',
  description: '获取当前本地日期与时间',
  parameters: { type: 'object', properties: {}, required: [] },
  risk: 'low',
  exec: async () => new Date().toLocaleString('zh-CN', { hour12: false })
})

register({
  name: 'system_info',
  description: '查询本机只读系统信息：主机名/平台/CPU 核数/内存占用/运行时长',
  parameters: { type: 'object', properties: {}, required: [] },
  risk: 'low',
  exec: async () => ({
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    cpuModel: os.cpus()[0] && os.cpus()[0].model,
    cores: os.cpus().length,
    memoryTotalGB: +(os.totalmem() / 1073741824).toFixed(1),
    memoryFreeGB: +(os.freemem() / 1073741824).toFixed(1),
    uptimeHours: +(os.uptime() / 3600).toFixed(1)
  })
})

register({
  name: 'calc',
  description: '计算数学表达式（仅支持数字与 + - * / % ( ) 运算）',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: '如 (3+4)*2' } },
    required: ['expression']
  },
  risk: 'low',
  exec: async ({ expression }) => {
    const s = String(expression || '').replace(/\s/g, '')
    if (!s) throw new Error('表达式为空')
    if (!/^[0-9+\-*/%().]+$/.test(s)) throw new Error('表达式含不允许的字符（仅数字与 + - * / % ( )）')
    if (/[*/%]{2,}|\+{3,}|-{3,}/.test(s)) throw new Error('运算符连续过多')
    // 白名单校验后求值；结果必须是有限数
    const val = Function(`"use strict"; return (${s})`)()
    if (typeof val !== 'number' || !Number.isFinite(val)) throw new Error('结果不是有限数字')
    return String(val)
  }
})

register({
  name: 'open_url',
  description: '用系统默认浏览器打开一个 http(s) 网址。搜索 URL 的查询词像活人那样用几个自然关键词（不要带 # 号/引号/文档标题）。',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'http:// 或 https:// 开头的网址' } },
    required: ['url']
  },
  risk: 'low',
  exec: async ({ url }) => {
    const u = String(url || '')
    if (!/^https?:\/\/[\w.-]+/i.test(u)) throw new Error('只允许 http(s) 网址')
    // 0.45.33 搜索词活人化（真机事故：她把画像档案的「# 搜索记录」标题原样塞进 Bing）。
    // 本文件是 ESM，清洗器住在 CJS 区（companion/searchq.js），用 createRequire 单一实现共用。
    const { createRequire } = await import('node:module')
    const { sanitizeSearchUrl } = createRequire(import.meta.url)('../../../main/companion/searchq.js')
    const s = sanitizeSearchUrl(u)
    if (!s.pass) throw new Error(s.why)
    const opened = s.changed ? s.url : u
    const cmd = process.platform === 'win32' ? `start "" "${opened}"` : `xdg-open "${opened}"`
    await run(cmd, { shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash', timeout: 8000, windowsHide: true })
    return '已在默认浏览器打开' + (s.changed ? '（搜索词已按活人习惯清洗：' + s.q + '）' : '')
  }
})

// exec_command 已迁到 shell.js（S10.5：bash 优先路由 + script_path + 超时晋升后台作业）
