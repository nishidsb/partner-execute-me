/**
 * 从 AuraDesk 导入模型配置到 Ryza Assistant（本机一键迁移凭据）。
 * 用法: npm run import-from-auradesk [-- --dry]
 * 只读取 %APPDATA%/AuraDesk/config.json 的 companion 段，不打印任何 Key。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDataDir, loadConfig, saveConfig, DEFAULT_CONFIG } from '../src/config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
initDataDir(process.env.RYZA_DATA_DIR || path.join(ROOT, 'data'))

const dry = process.argv.includes('--dry')
const src = path.join(os.homedir(), 'AppData', 'Roaming', 'AuraDesk', 'config.json')

if (!fs.existsSync(src)) {
  console.error('未找到 AuraDesk 配置:', src)
  process.exit(1)
}
const comp = (JSON.parse(fs.readFileSync(src, 'utf8')).global || {}).companion || {}
if (!comp.apiKey) {
  console.error('AuraDesk companion 配置中没有 apiKey，无法导入')
  process.exit(1)
}

console.log('将导入（key 已脱敏）:')
console.log('  baseUrl:', comp.apiBaseUrl)
console.log('  model:  ', comp.apiModel)
console.log('  apiKey: ***' + String(comp.apiKey).slice(-4))

if (dry) { console.log('\n(dry run，未写入)'); process.exit(0) }

const cfg = loadConfig()
cfg.provider = {
  ...structuredClone(DEFAULT_CONFIG.provider),
  type: 'openai',
  baseUrl: comp.apiBaseUrl || cfg.provider.baseUrl,
  apiKey: comp.apiKey,
  model: comp.apiModel || cfg.provider.model
}
saveConfig()
console.log('\n已写入 data/config.json（该目录在 .gitignore 中，不会进 git）。运行 npm start 即可对话。')
