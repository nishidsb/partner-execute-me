'use strict'
/**
 * 多屏截图实测（0.45.69）
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE npx electron tools/screens-probe.js [输出目录]
 *
 * 干三件事：
 *   1. 打印系统里所有显示器的 id / 分辨率 / 位置（确认副屏真的被识别到）
 *   2. 调 companion/screens.js 的 captureAll（跟线上 see_screen 走同一条代码）
 *   3. 把拼好的图存盘，打印尺寸与屏幕顺序说明
 *
 * 验收标准：输出图里应该能同时看到主屏和副屏的画面，从左到右按 x 坐标排列。
 */
const { app, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const outDir = process.argv[2] || path.join(__dirname, '..', 'captures', 'screens-probe')

app.whenReady().then(async () => {
  try {
    const displays = screen.getAllDisplays()
    console.log('=== 系统显示器 ===')
    for (const d of displays) {
      console.log('  id=' + d.id + ' size=' + d.size.width + 'x' + d.size.height +
        ' bounds=(' + d.bounds.x + ',' + d.bounds.y + ')' +
        (d.id === screen.getPrimaryDisplay().id ? '  ← 主屏' : ''))
    }

    const screens = require('../src/main/companion/screens')
    const t0 = Date.now()
    const cap = await screens.captureAll({ quality: 82 })
    const dt = Date.now() - t0

    console.log('\n=== 截图结果 ===')
    console.log('  拼图尺寸: ' + cap.width + 'x' + cap.height)
    console.log('  jpeg 大小: ' + Math.round(cap.jpeg.length / 1024) + ' KB（base64 后约 ' +
      Math.round(cap.jpeg.length * 1.37 / 1024) + ' KB）')
    console.log('  耗时: ' + dt + 'ms')
    console.log('  说明: ' + screens.describe(cap))
    console.log('  屏数: ' + cap.screens.length + (cap.screens.length > 1 ? '（拼接成功）' : '（单屏，未拼接）'))

    fs.mkdirSync(outDir, { recursive: true })
    const out = path.join(outDir, 'all-screens.jpg')
    fs.writeFileSync(out, cap.jpeg)
    console.log('  已保存: ' + out)

    // 像素健全性：拼图不应该整张同色（全黑=截屏本身失败）
    const img = require('electron').nativeImage.createFromBuffer(cap.jpeg)
    const bmp = img.toBitmap()
    let min = 255
    let max = 0
    for (let i = 0; i < bmp.length; i += 4 * 997) { // 抽样
      const v = bmp[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    console.log('  像素抽样亮度范围: ' + min + '~' + max + (max - min < 8 ? '  ← 可疑：整张几乎同色' : '（正常）'))
  } catch (err) {
    console.error('失败：' + (err && err.stack ? err.stack : err))
    app.exit(1)
    return
  }
  app.exit(0)
})
