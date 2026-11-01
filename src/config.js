/**
 * 配置管理：data/config.json（个人配置，.gitignore 已排除，绝不入库）。
 * 环境变量 RYZA_API_KEY 可覆盖 apiKey（适合不想把 key 落盘的场景）。
 */
import fs from 'node:fs'
import path from 'node:path'

let dataDir = path.join(process.cwd(), 'data')
let cfg = null

export const DEFAULT_CONFIG = {
  provider: {
    type: 'openai', // 'openai' = OpenAI 兼容在线服务；'mock' = 本地模拟（测试用）
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.8
  },
  currentRole: 'assistant', // 当前激活角色 id
  memoryTopK: 5, // 每轮注入 prompt 的相关记忆条数
  languageGuard: true // 回复语言守卫（错语时自动纠正重试一次）
}

export function initDataDir (dir) {
  dataDir = dir
  fs.mkdirSync(dataDir, { recursive: true })
}

export function dataPath (...p) {
  return path.join(dataDir, ...p)
}

export function loadConfig () {
  if (cfg) return cfg
  const file = dataPath('config.json')
  try {
    cfg = { ...structuredClone(DEFAULT_CONFIG), ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    cfg = structuredClone(DEFAULT_CONFIG)
  }
  // 环境变量优先级最高
  if (process.env.RYZA_API_KEY) cfg.provider.apiKey = process.env.RYZA_API_KEY
  return cfg
}

export function saveConfig () {
  fs.writeFileSync(dataPath('config.json'), JSON.stringify(cfg, null, 2))
}

export function getConfig () {
  return cfg || loadConfig()
}

/** 脱敏展示 provider 配置（key 只显示尾 4 位） */
export function describeProvider (p = getConfig().provider) {
  const k = p.apiKey || ''
  return {
    type: p.type,
    baseUrl: p.baseUrl,
    model: p.model,
    temperature: p.temperature,
    apiKey: k ? '***' + k.slice(-4) : '(未设置)'
  }
}
