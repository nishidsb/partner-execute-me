'use strict'
/**
 * Epic 库扫描自检（手动跑：node tools/test-epic.js）
 * 读 %ProgramData%\Epic\...\Manifests\*.item，没装 Epic 时跳过。
 */
const lib = require('../src/main/gameLib')

const list = lib.scanEpic() || []
if (!list.length) {
  console.log('[epic] 跳过：没有扫描到 Epic 库（未安装 Epic / 没有已安装游戏）')
  process.exit(0)
}
for (const g of list.slice(0, 10)) {
  console.log(`[epic] ${g.name}  id=${g.id}  target=${g.target}`)
  if (!g.name || !g.id || !String(g.target || '').includes('epicgames')) {
    console.error('[epic] 条目结构不对：', g)
    process.exit(1)
  }
}
console.log(`[epic] OK：共 ${list.length} 项`)
