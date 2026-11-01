'use strict'
/**
 * 截图指纹（0.38.0）
 *
 * 为什么要：看屏陪伴每轮都要截图 + 一次视觉模型调用。暂停着的视频、挂机界面、
 * 打游戏时的静态菜单——同一张画面对着她看十几次，钱花了、话还没新意。
 * 参考项目用 16×9 亮度 + 64 位 dHash；这里只取 dHash（亮度均值对光照不敏感，
 * 比逐像素比更抗压缩噪声），命中了就跳过这一轮。
 *
 * dHash：缩到 9×8 灰度，每行比较相邻两点（左 > 右 记 1），共 8×8=64 位。
 * 判定「同一画面」用汉明距离 ≤ 2（约 3% 像素翻转以内）。
 */
const HASH_W = 9
const HASH_H = 8

/** BGRA 原始位图 → 64 位十六进制指纹（纯函数，单测直接喂合成数据） */
function dhashFromBitmap (buf, width, height, channels) {
  const ch = channels || 4
  if (!buf || !width || !height) return ''
  const gray = []
  for (let y = 0; y < HASH_H; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / HASH_H))
    const row = []
    for (let x = 0; x < HASH_W; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / HASH_W))
      const i = (sy * width + sx) * ch
      // Electron 的 toBitmap 是 BGRA；灰度按 Rec.601
      const b = buf[i] || 0
      const g = buf[i + 1] || 0
      const r = buf[i + 2] || 0
      row.push(0.299 * r + 0.587 * g + 0.114 * b)
    }
    gray.push(row)
  }
  let bits = ''
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W - 1; x++) bits += gray[y][x] > gray[y][x + 1] ? '1' : '0'
  }
  // 64 位转 16 位十六进制
  let hex = ''
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]

/** 两个指纹差几位（非法输入返回 64 = 一定不同） */
function hamming (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return 64
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    if (Number.isNaN(x)) return 64
    d += POP[x]
  }
  return d
}

/** dataURL → 指纹（要 Electron 的 nativeImage；拿不到就返回空串，调用方当「没有指纹」处理） */
function hashOfDataURL (dataURL) {
  try {
    const { nativeImage } = require('electron')
    const img = nativeImage.createFromDataURL(String(dataURL || ''))
    if (!img || img.isEmpty()) return ''
    const small = img.resize({ width: HASH_W, height: HASH_H, quality: 'good' })
    const bmp = small.toBitmap()
    const size = small.getSize()
    return dhashFromBitmap(bmp, size.width, size.height, 4)
  } catch { return '' }
}

/** 两张是不是同一画面 */
function sameScreen (a, b, tol) {
  return hamming(a, b) <= (Number.isFinite(tol) ? tol : 2)
}

module.exports = { dhashFromBitmap, hamming, hashOfDataURL, sameScreen, HASH_W, HASH_H }
