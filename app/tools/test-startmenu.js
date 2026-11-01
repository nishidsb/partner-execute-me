'use strict'
/**
 * 开始菜单扫描自检（手动跑：node tools/test-startmenu.js）
 * 只验证「能扫到东西 + 条目结构正确 + 卸装/说明类被过滤」。
 */
const lib = require('../src/main/gameLib')

const list = lib.scanStartMenu(400) || []
if (!list.length) {
  console.log('[startmenu] 跳过：两个开始菜单目录里都没有 .lnk/.url')
  process.exit(0)
}
const bad = list.find((g) => !g.name || !(g.target || g.lnk))
if (bad) {
  console.error('[startmenu] 条目结构不对：', bad)
  process.exit(1)
}
const junk = list.filter((g) => /uninstall|卸载|readme|帮助/i.test(g.name))
if (junk.length) {
  console.error('[startmenu] 过滤没生效，混进了：', junk.slice(0, 5).map((g) => g.name))
  process.exit(1)
}
for (const g of list.slice(0, 8)) console.log(`[startmenu] ${g.name}  → ${g.target || g.lnk}`)
console.log(`[startmenu] OK：共 ${list.length} 项`)
