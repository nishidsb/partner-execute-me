/**
 * 0.46.2 config.json BOM 容错：外部工具（PowerShell 5.1 Set-Content -Encoding UTF8）
 * 改写 config.json 会带 UTF-8 BOM，JSON.parse 整体失败后曾静默回落 defaults()，
 * 随后任何一次保存都把默认值写回盘上——真机 0.46.1 事故：用户全部 companion
 * 设置（画像/自主活动/权限模式/远程令牌/TTS）被清空。
 * store.js require electron，走源码静态断言（ledger-note.test.js 同款）。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')

test('store.load 剥 BOM 后再 JSON.parse（外部工具写盘不再炸配置）', () => {
  const src = read('src/main/store.js')
  assert.ok(/charCodeAt\(0\) === 0xfeff/.test(src), '有 BOM 检测')
  assert.ok(/text\.slice\(1\)/.test(src), 'BOM 命中时剥掉首字符再解析')
  // 解析失败静默回落 defaults 的旧行为必须保持「只在 catch 里」，不能吞掉剥 BOM 步骤
  assert.ok(/readFileSync\(file\(\), 'utf8'\)/.test(src), '仍然从 config.json 读取')
})
