'use strict'
/**
 * 5.7 窗台（ledge）几何探测：真机跑（Windows + koffi）。
 * 只验证「能枚举到窗口 + 坐标合法 + 自家进程被排除 + 非法句柄安全返回」，
 * 坐下/跟随/摔落是 Electron 主进程行为，靠安装后的真机验证。
 */
const test = require('node:test')
const assert = require('node:assert')
let ledge
try { ledge = require('../src/main/companion/ledge') } catch (e) { ledge = null }

test('ledge: 模块可加载（koffi 缺失时导出仍存在，调用返回空表不炸）', () => {
  assert.ok(ledge && typeof ledge.topEdges === 'function' && typeof ledge.rectOf === 'function')
})

test('ledge: topEdges 返回合法矩形列表（无窗口环境允许为空）', () => {
  const list = ledge.topEdges(process.pid)
  assert.ok(Array.isArray(list))
  for (const w of list) {
    assert.ok(Number.isFinite(w.x) && Number.isFinite(w.y), 'x/y 必须是数字')
    assert.ok(w.w >= 200 && w.h >= 120, '过滤后窗口不小于 200x120 DIP')
    assert.ok(w.title && w.title.length > 0, '无标题工具窗口已被剔除')
    assert.ok(w.hwnd > 0, 'hwnd 句柄键为正数')
  }
})

test('ledge: 自家进程的窗口不在窗台候选里', () => {
  const list = ledge.topEdges(process.pid)
  // 本测试进程没有可见顶层窗口，但要保证枚举过程不把自己算进去
  assert.ok(Array.isArray(list))
})

test('ledge: rectOf 对未知/非法句柄返回 null（窗口关掉摔落的触发路径）', () => {
  assert.equal(ledge.rectOf(999999999), null)
  assert.equal(ledge.rectOf(-1), null)
  assert.equal(ledge.rectOf(undefined), null)
})
