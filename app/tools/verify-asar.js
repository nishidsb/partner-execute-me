// 临时核验：安装包 asar 内是否包含跨屏拖拽代码
const asar = require('@electron/asar')
const f = process.argv[2]
const find = (p) => {
  for (const cand of ['\\' + p, p]) {
    try { return asar.extractFile(f, cand).toString('utf8') } catch {}
  }
  return ''
}
const s1 = find('src\\main\\companion\\pet.js')
const s2 = find('src\\renderer\\overlay\\pet.js')
const s3 = find('src\\preload\\overlay.js')
console.log('主进程跨屏逻辑:', s1.includes('pet:drag-move') && s1.includes('clampPos'))
console.log('渲染层跨屏逻辑:', s2.includes('applyGlobalPos') && s2.includes('petDragEnd'))
console.log('preload 拖拽通道:', s3.includes('pet:drag-move') && s3.includes('pet:pos'))
const s4 = find('src\\renderer\\overlay\\app.js')
console.log('拖拽穿透修复:', s4.includes('__petDragActive) hot = true'))
const s5 = find('src\\main\\companion\\pet.js')
console.log('主驱拖拽:', s5.includes('dragStart') && s5.includes('getCursorScreenPoint'))
