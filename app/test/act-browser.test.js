/**
 * 0.46.16 活动浏览窗口（actBrowser）
 *
 * 以前 openUrl = shell.openExternal → 页面开在主人默认浏览器里，活动结束关不掉。
 * 现在开在程序自建窗口、活动结束整窗销毁。本测试在纯 node 环境跑（无 electron）：
 * 验证 URL 门禁、无窗口时的 no-op 安全性、以及 electron 缺失时 open 优雅回落 false。
 */
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const ab = require('../src/main/companion/actBrowser.js')

test('actBrowser: 只认 http(s)，其他一律不开', () => {
  assert.equal(ab.open('javascript:alert(1)'), false)
  assert.equal(ab.open('file:///C:/Windows'), false)
  assert.equal(ab.open(''), false)
  assert.equal(ab.open(null), false)
  assert.equal(ab.open('data:text/html,hi'), false)
})

test('actBrowser: 无窗口时 close/isOpen 是无害 no-op', () => {
  assert.doesNotThrow(() => ab.close())
  assert.equal(ab.isOpen(), false)
  ab.close() // 幂等：再关一次也不炸
  assert.equal(ab.isOpen(), false)
})

test('actBrowser: electron 不可用时 open 优雅回落 false（不抛错）', () => {
  // 纯 node 环境 require('electron') 返回的是二进制路径字符串，解构不出 BrowserWindow
  assert.equal(ab.open('https://www.bilibili.com/'), false)
})

test('actBrowser: 模块导出面齐（open/close/isOpen）', () => {
  for (const k of ['open', 'close', 'isOpen']) {
    assert.equal(typeof ab[k], 'function', k + ' 必须是函数')
  }
  // 源码里必须保持「活动结束关窗」的接线（autonomy 循环收尾调用 close）
  const src = fs.readFileSync(path.join(__dirname, '../src/main/companion/autonomy.js'), 'utf8')
  assert.match(src, /require\('\.\/actBrowser'\)/, 'autonomy 收尾必须引用 actBrowser')
  assert.match(src, /ab\.close\(\)/, 'autonomy 收尾必须调用 close()')
})
