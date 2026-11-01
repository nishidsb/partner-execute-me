'use strict'
/**
 * 截图指纹（0.38.0）：dHash 的语义只有两条——同一画面距离要小，不同画面距离要大。
 * 构造合成 BGRA 位图来验证，不依赖 Electron。
 */
const test = require('node:test')
const assert = require('node:assert')
const { dhashFromBitmap, hamming, sameScreen } = require('../src/main/image-hash')

/** 造一张 9×8 的 BGRA 位图，像素值由 f(x,y) 决定 */
function bitmap (f) {
  const w = 9
  const h = 8
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(f(x, y))))
      const i = (y * w + x) * 4
      buf[i] = v     // B
      buf[i + 1] = v // G
      buf[i + 2] = v // R
      buf[i + 3] = 255
    }
  }
  return buf
}

test('同一张图指纹相同', () => {
  const a = bitmap((x) => (x < 4 ? 20 : 220))
  const b = bitmap((x) => (x < 4 ? 20 : 220))
  assert.strictEqual(dhashFromBitmap(a, 9, 8, 4), dhashFromBitmap(b, 9, 8, 4))
  assert.strictEqual(hamming(dhashFromBitmap(a, 9, 8, 4), dhashFromBitmap(b, 9, 8, 4)), 0)
})

test('亮度整体偏移（面板调暗/变亮）不算新画面', () => {
  const base = bitmap((x, y) => (x < 4 ? 30 : 200) + y * 2)
  const darker = bitmap((x, y) => ((x < 4 ? 30 : 200) + y * 2) * 0.7)
  const h = hamming(dhashFromBitmap(base, 9, 8, 4), dhashFromBitmap(darker, 9, 8, 4))
  assert.ok(h <= 2, '整体调暗后应该仍判定为同一画面，实际差 ' + h + ' 位')
})

test('左右翻转是不同画面', () => {
  const a = bitmap((x) => (x < 4 ? 20 : 220))
  const b = bitmap((x) => (x < 4 ? 220 : 20))
  const d = hamming(dhashFromBitmap(a, 9, 8, 4), dhashFromBitmap(b, 9, 8, 4))
  assert.ok(d > 2, '翻转后不该被当成同一画面，实际差 ' + d + ' 位')
})

test('指纹是 16 位十六进制（64 bit）', () => {
  const h = dhashFromBitmap(bitmap((x) => x * 28), 9, 8, 4)
  assert.match(h, /^[0-9a-f]{16}$/)
})

test('非法输入不炸：返回空串 / 距离 64', () => {
  assert.strictEqual(dhashFromBitmap(null, 9, 8, 4), '')
  assert.strictEqual(dhashFromBitmap(Buffer.alloc(0), 0, 0, 4), '')
  assert.strictEqual(hamming('', 'abcd'), 64)
  assert.strictEqual(hamming('zz', 'ab'), 64)
  assert.strictEqual(sameScreen('', ''), false)
})

test('sameScreen 容差可调', () => {
  const a = '0000000000000000'
  const b = '0000000000000003' // 差 2 位
  assert.strictEqual(sameScreen(a, b), true)
  assert.strictEqual(sameScreen(a, b, 1), false)
})
