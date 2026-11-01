/**
 * 把 AuraDesk 的用户数据（AI 配置/角色/记忆/历史/素材）迁移到 Ryza Assistant。
 * 只读 AuraDesk 目录，绝不修改原数据。用法: node scripts/migrate-from-auradesk.js [--dry]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dry = process.argv.includes('--dry')
const srcRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'AuraDesk')
const dstRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'ryza-assistant-app')

if (!fs.existsSync(srcRoot)) { console.error('未找到 AuraDesk 数据目录:', srcRoot); process.exit(1) }

// 迁移清单：配置 + AI 数据 + 角色素材（跳过 Electron 缓存类目录）
const ITEMS = ['config.json', 'companion']

console.log('将迁移（AuraDesk 原数据只读不动）:')
for (const item of ITEMS) {
  const s = path.join(srcRoot, item)
  if (!fs.existsSync(s)) { console.log('  (跳过，不存在)', item); continue }
  const stat = fs.statSync(s)
  console.log(`  ${item} → ${path.join(dstRoot, item)} (${stat.isDirectory() ? '目录' : Math.round(stat.size / 1024) + 'KB'})`)
}
if (dry) { console.log('\n(dry run，未写入)'); process.exit(0) }

fs.mkdirSync(dstRoot, { recursive: true })
for (const item of ITEMS) {
  const s = path.join(srcRoot, item)
  const d = path.join(dstRoot, item)
  if (!fs.existsSync(s)) continue
  fs.cpSync(s, d, { recursive: true, force: false, errorOnExist: false })
  console.log('已迁移:', item)
}
console.log('\n完成。启动 Ryza Assistant 后即可用原有 AI 配置与角色数据。')
