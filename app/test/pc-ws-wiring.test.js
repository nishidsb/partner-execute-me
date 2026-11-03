'use strict'
/**
 * 0.46.10 电脑画像工作区接线防回归
 *
 * 事故（2026-11-02 19:34 真机）：systemBridge.js / healthBridge.js 的 currentWs()
 * 里 require('./config')——src/main 下根本没有这个文件，MODULE_NOT_FOUND 被
 * catch { return '' } 吞掉后恒返回空 → pc_profile 永远「还没采到」、pc_refresh
 * 必败「还没拿到角色工作区」、健康摘要从没写进过工作区。而采集端（companion
 * 定时采集）一直正常，数据就躺在工作区 pc/search.md 里（134 条搜索词）。
 *
 * 这类断链 wirecheck 查不到（模块加载期就抛，但都被 try/catch 吞了），
 * 只能静态扫描锁死。 companion systemPrompt 的 petact 段同理：0.46.9 把
 * [action:] 语法写进了 session.js 和 context.js 的 FIXED_INDEX，但桌面聊天
 * systemPrompt 从没注入过 → 模型不知道语法、手势从不动。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const MAIN = path.join(ROOT, 'src', 'main')

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

test('src/main 下不存在也不允许 require ./config（0.46.10 断链事故）', () => {
  assert.equal(fs.existsSync(path.join(MAIN, 'config.js')), false,
    '如果真的加了 src/main/config.js，请把本测试的语义改成正向验证')
  const offenders = walk(MAIN).filter((f) => {
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    // 只看代码行（注释里提到 require('./config') 的事故说明不算数）
    return lines.some((l) => {
      const t = l.trim()
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false
      return /require\((['"])(\.\.?\/)?config\1\)/.test(l)
    })
  })
  assert.deepEqual(offenders, [],
    '这些文件 require 了不存在的 ./config（错误会被 try/catch 吞掉，功能静默全废）：' + offenders.join(', '))
})

test('systemBridge / healthBridge 的 currentWs 走 companion 当前角色（与采集端同源）', () => {
  for (const f of ['systemBridge.js', 'healthBridge.js']) {
    const s = fs.readFileSync(path.join(MAIN, f), 'utf8')
    assert.match(s, /require\('\.\/companion\/character'\)\.get\(\)/,
      f + ' 的 currentWs 应从 companion/character 取当前角色')
  }
})

test('桌面聊天 systemPrompt 必须注入 [action:] 自动调用说明（否则手势从不动）', () => {
  const s = fs.readFileSync(path.join(MAIN, 'companion', 'index.js'), 'utf8')
  assert.match(s, /key: 'petact'/, 'companion systemPrompt 缺 petact 段')
  assert.match(s, /【动作的自动调用】/)
  assert.match(s, /\[action:标签\]/)
  // 提示词里列全 11 个语义标签（与 spine-actions.js 的 SPINE_ACTION_TAGS 对齐）
  for (const tag of ['acknowledge', 'disagree', 'think', 'explain', 'excited',
    'wave', 'shy', 'surprised', 'comfort', 'playful', 'invite']) {
    assert.ok(s.includes(tag), 'petact 段缺语义标签: ' + tag)
  }
})
