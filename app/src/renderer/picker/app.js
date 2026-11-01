'use strict'
/**
 * 框字幕选区层（0.34.0）
 *
 * 每块屏一个全屏透明窗，窗口原点就是该屏左上角，所以本地坐标 + display 原点 = DIP 全局坐标。
 * 松手把矩形交回主进程；太小的当误触。
 */
const $ = (id) => document.getElementById(id)
const MIN_W = 40
const MIN_H = 12

let display = { x: 0, y: 0, w: 0, h: 0 }
let start = null
let cur = null

function paint () {
  const box = $('box')
  const size = $('size')
  if (!start || !cur) {
    box.style.display = 'none'
    size.style.display = 'none'
    return
  }
  const x = Math.min(start.x, cur.x)
  const y = Math.min(start.y, cur.y)
  const w = Math.abs(cur.x - start.x)
  const h = Math.abs(cur.y - start.y)
  box.style.display = 'block'
  box.style.left = x + 'px'
  box.style.top = y + 'px'
  box.style.width = w + 'px'
  box.style.height = h + 'px'
  size.style.display = 'block'
  size.textContent = w + ' × ' + h
  size.style.left = Math.min(Math.max(6, x), Math.max(6, window.innerWidth - 90)) + 'px'
  size.style.top = Math.max(6, y - 26) + 'px'
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  start = { x: e.clientX, y: e.clientY }
  cur = { x: e.clientX, y: e.clientY }
  paint()
})

document.addEventListener('mousemove', (e) => {
  if (!start) return
  cur = { x: e.clientX, y: e.clientY }
  paint()
})

document.addEventListener('mouseup', (e) => {
  if (!start) return
  const x = Math.min(start.x, e.clientX)
  const y = Math.min(start.y, e.clientY)
  const w = Math.abs(e.clientX - start.x)
  const h = Math.abs(e.clientY - start.y)
  start = null
  cur = null
  paint()
  if (w < MIN_W || h < MIN_H) {
    // 误触：留在选区层上重来
    const tip = $('tip')
    tip.innerHTML = '框太小了，再拖一次（至少 ' + MIN_W + '×' + MIN_H + '，Esc 取消）'
    return
  }
  window.pickerAPI.done({ x: display.x + x, y: display.y + y, w, h })
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.pickerAPI.cancel()
})

window.pickerAPI.onInit((d) => {
  if (d && d.display) display = d.display
  document.body.focus()
})
