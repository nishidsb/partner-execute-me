/**
 * 工具注册与调用机制。
 * 每个工具 = { name, description, parameters(JSON Schema), risk, exec }。
 * risk: 'low' 直接执行；'high'（不可逆/系统级）必须经 confirmFn 确认后执行。
 */
const registry = new Map()

export function register (def) {
  if (!def.name || typeof def.exec !== 'function') throw new Error('工具定义缺少 name 或 exec')
  registry.set(def.name, { risk: 'low', ...def })
}

export function get (name) { return registry.get(name) || null }
export function list () { return [...registry.values()] }

/** OpenAI tools 数组格式（供模型接入层使用） */
export function listDefs () {
  return list().map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

/**
 * 执行工具。high 风险工具会先 await confirmFn(toolName, args)，
 * 返回 falsy 则抛 ToolDenied。
 */
export async function exec (name, args, { confirmFn } = {}) {
  let tool = registry.get(name)
  if (!tool) {
    // 模型偶尔会编错工具名（如 get_current_time vs get_time）：唯一包含匹配时纠正
    const candidates = [...registry.keys()].filter((k) => k.includes(name) || name.includes(k))
    if (candidates.length === 1) tool = registry.get(candidates[0])
  }
  if (!tool) throw new Error(`未注册的工具: ${name}`)
  if (tool.risk === 'high' && confirmFn) {
    const ok = await confirmFn(name, args)
    if (!ok) {
      const err = new Error(`用户拒绝执行高风险工具: ${name}`)
      err.code = 'TOOL_DENIED'
      throw err
    }
  }
  const started = Date.now()
  const result = await tool.exec(args || {})
  return { name, ok: true, result, ms: Date.now() - started }
}
