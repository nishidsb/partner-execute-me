/**
 * CUA 坐标几何（纯函数，不依赖 Electron / Win32，便于单测）
 *
 * 模型只见过「缩放后的截图」，它说的坐标是截图里的像素坐标；
 * 引擎要的是真实屏幕物理坐标。两者之间的换算全部集中在这里。
 *
 * view = { srcX, srcY, srcW, srcH, outW, outH, scale }
 *   srcX/srcY  截图左上角在虚拟桌面里的位置
 *   srcW/srcH  截图覆盖的屏幕区域大小
 *   outW/outH  缩放后的图片尺寸（模型看到的）
 *   scale      outW / srcW
 */
'use strict'

/** 截图缩放比：保持比例，任何一边都不超过上限，永不放大 */
function fitScale (w, h, maxW = 1280, maxH = 800) {
  const sw = Math.max(1, Number(w) || 1)
  const sh = Math.max(1, Number(h) || 1)
  return Math.min(1, maxW / sw, maxH / sh)
}

function makeView ({ srcX, srcY, srcW, srcH, outW, outH }) {
  const w = Math.max(1, Math.round(srcW))
  const ow = Math.max(1, Math.round(outW))
  return {
    srcX: Math.round(srcX),
    srcY: Math.round(srcY),
    srcW: w,
    srcH: Math.max(1, Math.round(srcH)),
    outW: ow,
    outH: Math.max(1, Math.round(outH)),
    scale: ow / w
  }
}

/**
 * 截图坐标 → 屏幕坐标。
 * 超出图片范围直接报错而不是「夹到边缘」：夹边会让模型以为点到了，
 * 实际点在了别处（宁可不点）。
 */
function viewToScreen (view, x, y) {
  if (!view) throw new Error('还没截过图：请先调用 screenshot 看一眼屏幕，再用截图里的坐标操作')
  const nx = Number(x)
  const ny = Number(y)
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error('坐标必须是数字')
  const tol = 8 // 允许轻微超出（模型偶尔算差几像素）
  if (nx < -tol || ny < -tol || nx > view.outW + tol || ny > view.outH + tol) {
    throw new Error(`坐标 (${nx}, ${ny}) 超出最近一张截图的范围（0~${view.outW - 1}, 0~${view.outH - 1}）：请重新 screenshot 后再点`)
  }
  const cx = Math.min(Math.max(nx, 0), view.outW - 1)
  const cy = Math.min(Math.max(ny, 0), view.outH - 1)
  return {
    x: Math.round(view.srcX + cx / view.scale),
    y: Math.round(view.srcY + cy / view.scale)
  }
}

/** 屏幕坐标 → 截图坐标（给「窗口中心在哪」这类提示用） */
function screenToView (view, x, y) {
  if (!view) return null
  return {
    x: Math.round((x - view.srcX) * view.scale),
    y: Math.round((y - view.srcY) * view.scale)
  }
}

/** 用户停手够久才允许动键鼠（规格 4.4：2 秒 idle） */
const IDLE_NEED_MS = 2000
const YIELD_MAX_MS = 15000

function canAct (idleMs) {
  return Number(idleMs) >= IDLE_NEED_MS
}

/** 让位超时判断：从开始等到现在是否已经等够了 */
function yieldExpired (elapsedMs) {
  return Number(elapsedMs) > YIELD_MAX_MS
}

module.exports = {
  fitScale, makeView, viewToScreen, screenToView, canAct, yieldExpired, IDLE_NEED_MS, YIELD_MAX_MS
}
