'use strict'
/**
 * 多屏截图（0.45.69）
 *
 * 用户原话：「主屏副屏都要看到吧」。
 *
 * 0.45.6x 之前 see_screen 只截 `screen.getPrimaryDisplay()` 那一块——她永远看不见副屏。
 * 用户的实际布局是「副屏在左（x<0）跑 AuraDesk 卡片，主屏在右干活」，把视频/游戏挪到副屏
 * 就等于在她眼皮底下隐身，学习监督直接失效。
 *
 * 这里把**所有显示器**都截下来，等比缩放到同一高度后横向拼成一张图：
 *   1. 单图 → llm.js 的多模态组装不用改（它只认一个 image 字段）；
 *   2. 一次请求看全所有屏 → 模型能对比「左边在放番、右边在写申论」，比分开问两轮准；
 *   3. 拼接顺序按显示器 x 坐标从左到右，并在文字描述里标出哪块是主屏，模型不会看反。
 *
 * 为什么不返回多张图：多图输入各家网关兼容性不一（部分中转只取第一张），
 * 拼图是唯一「所有网关都吃」的形态，而且省一次请求。
 */

const { desktopCapturer, screen, nativeImage } = require('electron')

/** 拼接间隔（像素），深色分隔条，让模型能分清两张屏的边界 */
const GAP = 10
/** 背景色（深灰蓝，和拼接条一致） */
const BG = [22, 22, 30, 255]

/**
 * 把多张 nativeImage 横向拼成一张。
 * 只做行拷贝，不解析像素通道（toBitmap 与 createFromBitmap 同为 Skia 原生格式，
 * 直接按字节搬即可，避免假设 BGRA/RGBA 时把红蓝搞反）。
 */
function concatH (images, gap) {
  const sized = images.map((img) => {
    const s = img.getSize()
    return { img, w: Math.max(1, s.width), h: Math.max(1, s.height) }
  })
  const H = Math.max.apply(null, sized.map((s) => s.h))
  // 统一高度（保持各自比例），避免不同分辨率的屏拼出来一个高一个矮
  const scaled = sized.map((s) => {
    if (s.h === H) return s
    const n = s.img.resize({ height: H })
    const ns = n.getSize()
    return { img: n, w: Math.max(1, ns.width), h: Math.max(1, ns.height) }
  })
  const totalW = scaled.reduce((a, s) => a + s.w, 0) + gap * (scaled.length - 1)
  const stride = totalW * 4
  const dst = Buffer.alloc(stride * H)
  for (let i = 0; i < dst.length; i += 4) {
    dst[i] = BG[0]; dst[i + 1] = BG[1]; dst[i + 2] = BG[2]; dst[i + 3] = BG[3]
  }
  let x = 0
  for (const s of scaled) {
    const bmp = s.img.toBitmap()
    const srcStride = Math.floor(bmp.length / s.h)
    const rowBytes = Math.min(s.w * 4, srcStride)
    for (let y = 0; y < s.h; y++) {
      bmp.copy(dst, y * stride + x * 4, y * srcStride, y * srcStride + rowBytes)
    }
    x += s.w + gap
  }
  return nativeImage.createFromBitmap(dst, { width: totalW, height: H })
}

/**
 * 截全部屏幕并拼成一张。
 * @param {{maxWidth?:number, quality?:number}} [opts]
 *        maxWidth 拼好后的大致总宽上限（单屏默认 1600，多屏按屏数均分）
 * @returns {Promise<{jpeg:Buffer, width:number, height:number, screens:Array<{primary:boolean,label:string,w:number,h:number}>}>}
 */
async function captureAll (opts) {
  const o = opts || {}
  const quality = Math.max(40, Math.min(95, Number(o.quality) || 82))
  const displays = screen.getAllDisplays()
  // 源顺序不保证与 x 坐标一致，按显示器的实际位置从左到右排（副屏常在 x<0）
  const order = displays.slice().sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y))
  const primaryId = screen.getPrimaryDisplay().id
  const primary = displays.find((d) => d.id === primaryId) || order[0]

  // 每屏的目标宽度：总预算按屏数均分，单屏最多 1600，多屏每块不低于 760
  const budget = Number(o.maxWidth) || (order.length > 1 ? 2400 : 1600)
  const perW = Math.max(760, Math.round(budget / Math.max(1, order.length)))

  const srcs = await desktopCapturer.getSources({
    types: ['screen'],
    // 给足像素再自己缩：thumbnailSize 是所有源共用的，喂主屏比例即可（同一台机器比例通常一致）
    thumbnailSize: {
      width: Math.round(perW * 1.15),
      height: Math.round(perW * 1.15 * (primary.size.height / Math.max(1, primary.size.width)))
    }
  })
  if (!srcs || !srcs.length) throw new Error('没有可用的屏幕源')

  const picked = []
  for (const d of order) {
    const s = srcs.find((x) => String(x.display_id) === String(d.id)) ||
      // 少数环境 display_id 为空：按 index 兜底
      srcs[order.indexOf(d)]
    if (!s) continue
    let img = s.thumbnail
    if (!img || img.isEmpty()) continue
    const sz = img.getSize()
    if (sz.width > perW) img = img.resize({ width: perW })
    picked.push({ img, display: d })
  }
  if (!picked.length) throw new Error('截屏失败：画面为空')

  const images = picked.map((p) => p.img)
  const composed = images.length === 1 ? images[0] : concatH(images, GAP)
  const jpeg = composed.toJPEG(quality)
  if (!jpeg || jpeg.length < 1024) throw new Error('截屏失败：画面为空')

  const cs = composed.getSize()
  const screensDesc = picked.map((p) => {
    const isPrimary = String(p.display.id) === String(primaryId)
    return {
      primary: isPrimary,
      label: isPrimary ? '主屏' : '副屏',
      w: p.display.size.width,
      h: p.display.size.height
    }
  })
  return { jpeg, width: cs.width, height: cs.height, screens: screensDesc }
}

/**
 * 给模型看的「这块图是什么」说明。拼图里没有屏幕编号，只能用文字告诉它顺序，
 * 否则它会把副屏上的视频当成主屏上的内容。
 */
function describe (cap) {
  if (!cap || !cap.screens || !cap.screens.length) return '屏幕（无描述）'
  if (cap.screens.length === 1) return '唯一一块屏幕（' + cap.screens[0].w + '×' + cap.screens[0].h + '）'
  const parts = cap.screens.map((s, i) => '第' + (i + 1) + '块（' + s.label + ' ' + s.w + '×' + s.h + '）')
  return '共 ' + cap.screens.length + ' 块屏幕拼成一张图，从左到右依次是：' + parts.join('、')
}

module.exports = { captureAll, describe, concatH }
