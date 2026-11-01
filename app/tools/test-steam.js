'use strict'
/**
 * Steam 库扫描自检（手动跑：node tools/test-steam.js）
 * 不依赖 Electron：gameLib 在纯 Node 下也能 require（只是不能启动游戏）。
 * 这台机器没装 Steam 时只打印「跳过」，不算失败。
 */
const lib = require('../src/main/gameLib')

const list = lib.scanSteam() || []
if (!list.length) {
  console.log('[steam] 跳过：没有扫描到 Steam 库（未安装 Steam / 库目录为空）')
  process.exit(0)
}
for (const g of list.slice(0, 10)) {
  console.log(`[steam] ${g.name}  id=${g.id}  target=${g.target}`)
  if (!g.name || !g.id || !String(g.target || '').startsWith('steam://')) {
    console.error('[steam] 条目结构不对：', g)
    process.exit(1)
  }
}
console.log(`[steam] OK：共 ${list.length} 项`)
