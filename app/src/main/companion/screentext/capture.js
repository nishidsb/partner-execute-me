'use strict'
/**
 * 抓一小块屏幕（陪看字幕条专用）
 *
 * 为什么不用 cua 引擎的 BitBlt：
 *   1. 那边是另一个进程 + 物理像素坐标系，字幕条要精确对位，多一层 DPI 换算就多一个坑
 *      （鱼搭子 1.4.7 就是「两个 DPI 来源打架」导致球不停缩放）；
 *   2. desktopCapturer 走的是系统合成器，**配合 setContentProtection 能把她自己从截图里摘掉** ——
 *      不然她溜达到字幕条上，OCR 会把她的气泡当台词读。
 *
 * 坐标口径：入参是 Electron 的 DIP（screen.getDisplayNearestPoint 那套），
 * 内部按目标显示器的实际缩放比换成物理像素再裁。
 */
const { desktopCapturer, screen } = require('electron')

/**
 * @param {{x:number,y:number,w:number,h:number}} rect DIP 坐标
 * @returns {Promise<{ok:true,bgra:Buffer,w:number,h:number,scale:number}|{ok:false,error:string}>}
 */
async function grabRegion (rect) {
  const r = rect || {}
  const w0 = Math.round(Number(r.w) || 0)
  const h0 = Math.round(Number(r.h) || 0)
  if (w0 < 8 || h0 < 8) return { ok: false, error: '字幕框太小了（至少 8×8）' }
  const cx = Number(r.x) + w0 / 2
  const cy = Number(r.y) + h0 / 2
  const display = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) })
  const scale = display.scaleFactor || 1
  // 上限 2560 宽：4K 全屏缩略图一帧 33MB，每 1.2 秒来一次太浪费；字幕字大，2560 宽足够读准
  const MAX_W = 2560
  const wantW = Math.min(Math.round(display.size.width * scale), MAX_W)
  const wantH = Math.round(wantW * (display.size.height / display.size.width))
  let sources = []
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: wantW, height: wantH },
      fetchWindowIcons: false
    })
  } catch (err) {
    return { ok: false, error: '抓屏失败：' + (err && err.message) }
  }
  if (!sources.length) return { ok: false, error: '抓屏失败：系统没给出屏幕源' }
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
  const img = src.thumbnail
  const size = img.getSize()
  if (!size.width || !size.height) return { ok: false, error: '抓屏失败：缩略图是空的' }
  // 实际给的图可能不是我们要的尺寸（系统会夹到显示器原生分辨率），按实际比例换算
  const sx = size.width / display.size.width
  const sy = size.height / display.size.height
  const left = Math.round((Number(r.x) - display.bounds.x) * sx)
  const top = Math.round((Number(r.y) - display.bounds.y) * sy)
  const cw = Math.min(Math.round(w0 * sx), size.width - Math.max(0, left))
  const ch = Math.min(Math.round(h0 * sy), size.height - Math.max(0, top))
  if (cw < 8 || ch < 8 || left < 0 || top < 0) {
    return { ok: false, error: '字幕框跑到屏幕外面了（换一块屏或重新框一次）' }
  }
  const crop = img.crop({ x: left, y: top, width: cw, height: ch })
  const bgra = crop.toBitmap()
  if (!bgra || bgra.length !== cw * ch * 4) return { ok: false, error: '抓屏失败：像素数据不完整' }
  return { ok: true, bgra, w: cw, h: ch, scale: sx }
}

/**
 * 抓帧期间把她自己从截图里摘掉（WDA_EXCLUDEFROMCAPTURE）。
 * 只动 overlay（角色层）窗口 —— 面板/设置窗不受影响。
 * 代价：开着陪看的时候录屏录不到她，所以这是个可关的开关。
 */
function excludeSelf (on) {
  const { BrowserWindow } = require('electron')
  let n = 0
  for (const win of BrowserWindow.getAllWindows()) {
    let url = ''
    try { url = win.webContents.getURL() } catch { continue }
    if (!/overlay/.test(url)) continue
    try { win.setContentProtection(!!on); n++ } catch { }
  }
  return n
}

module.exports = { grabRegion, excludeSelf }
