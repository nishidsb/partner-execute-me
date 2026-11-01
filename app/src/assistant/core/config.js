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
    // 1.4：temperature 默认不发——推理模型普遍拒绝；想固定采样参数就在这里显式给一个数字
    temperature: null,
    // 1.5：reasoningEffort 四档 none/low/high/max；仅厂商表声明 effort 支持时 UI 才露出
    reasoningEffort: 'none'
  },
  // 0.18.0 第二批：联网搜索（web_search / web_fetch）
  // provider: duckduckgo（默认，免 Key，国内常连通不了会自动回退 bing）/ bing / searxng / tavily
  web: { provider: 'duckduckgo', searxngUrl: '', tavilyKey: '', maxResults: 5 },
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
  // 迁移：旧默认 temperature=0.8 是硬编码默认值（界面从来没给过调节），视为「未设置」→ 不发。
  // 用户真想要固定采样就自己把数字写回 config.json
  if (cfg.provider && cfg.provider.temperature === 0.8) cfg.provider.temperature = null
  if (!cfg.provider) cfg.provider = structuredClone(DEFAULT_CONFIG.provider)
  // web 段是 0.18.0 新加的：老 config.json 没有这一块，补默认值（浅合并不会自动补）
  if (!cfg.web || typeof cfg.web !== 'object') cfg.web = structuredClone(DEFAULT_CONFIG.web)
  else cfg.web = { ...DEFAULT_CONFIG.web, ...cfg.web }
  if (cfg.provider.reasoningEffort === undefined) cfg.provider.reasoningEffort = 'none'
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
    reasoningEffort: p.reasoningEffort || 'none',
    apiKey: k ? '***' + k.slice(-4) : '(未设置)'
  }
}
