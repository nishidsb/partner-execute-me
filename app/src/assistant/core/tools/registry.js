/**
 * 工具注册与调用机制。
 * 每个工具 = { name, description, parameters(JSON Schema), risk, exec }。
 *
 * risk 三档：
 *   low    只读/无副作用，直接执行
 *   medium 会改动电脑（启动程序、发消息…）：按用户设置的权限档位决定要不要确认
 *   high   不可逆/系统级（执行命令行）：默认必须确认
 *
 * 权限（policy，由服务壳每次传入）：
 *   { mode: 'ask-each-turn' | 'ask-before-acting' | 'ask-once' | 'never-ask',
 *     allowTools: ['open_app', ...], grantUntil: <ms 时间戳> }
 *   - ask-each-turn    每次都问
 *   - ask-before-acting 每次动作前问（默认，规格书 4.2）
 *   - ask-once         问一次，授权 30 分钟内不再问
 *   - never-ask        从不问（用户明确放权）
 */
const registry = new Map()

/**
 * 工具开关（由宿主按用户设置注入）：返回 false 的工具既不出现在工具列表里，
 * 也不允许被调用。CUA 十一个工具默认关着，用户读完风险页并开启才放行——
 * 只在列表里隐藏是不够的，模型记住了名字仍会尝试调用。
 */
let gate = null
export function setGate (fn) { gate = typeof fn === 'function' ? fn : null }
function allowed (name) { return !gate || !!gate(name) }

export function register (def) {
  if (!def.name || typeof def.exec !== 'function') throw new Error('工具定义缺少 name 或 exec')
  registry.set(def.name, { risk: 'low', ...def })
}

/** 注销工具（World 扩展禁用/卸载时用）；返回是否真的删了东西 */
export function unregister (name) { return registry.delete(name) }

export function get (name) { return registry.get(name) || null }
export function list () { return [...registry.values()] }
export function isAllowed (name) { return allowed(name) }

/** OpenAI tools 数组格式（供模型接入层使用） */
export function listDefs () {
  return list().filter((t) => allowed(t.name)).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

/**
 * 终端类工具（0.18.0 第二批）：执行命令 / 杀后台作业。
 * 这类工具不看「权限档位」——档位只决定鼠标键盘那类「看得见」的操作要不要问，
 * 而一条命令能干的事没有上限（rm -rf、curl 传文件、改注册表），
 * 所以即使设成 never-ask / 30 分钟内都允许，也仍然单独问一次。
 * 只有两种放行：用户把具体工具显式写进「已允许的工具」名单，或打开「终端命令不再询问」开关。
 */
const TERMINAL_TOOLS = new Set(['exec_command', 'job_kill', 'job_run_background'])

/**
 * 是否需要向用户确认。
 * 权限档位、单工具白名单、30 分钟授权期三者任一放行则免问（终端类另按上面规则从严）。
 */
export function needConfirm (risk, name, policy = {}, meta = {}) {
  if (risk === 'low') return false
  const mode = policy && policy.mode ? String(policy.mode) : 'ask-before-acting'
  const allow = (policy && Array.isArray(policy.allowTools)) ? policy.allowTools : []
  // 显式点名允许某个工具：用户自己选的，尊重（终端类也放过）
  if (allow.includes(name)) return false
  // 终端类：档位管不到，必须单独问（除非用户明确关掉「终端单独询问」）
  const isTerminal = !!(meta && meta.terminal) || TERMINAL_TOOLS.has(String(name))
  if (isTerminal && !(policy && policy.allowTerminal)) return true
  if (mode === 'never-ask') return false
  if (mode === 'ask-once' && Number(policy.grantUntil || 0) > Date.now()) return false
  return true
}

/** 暴露给测试/设置页说明用：哪些工具算终端类 */
export function isTerminalTool (name) { return TERMINAL_TOOLS.has(String(name)) }

/**
 * 执行工具。需要确认的工具会先 await confirmFn(toolName, args, risk)，
 * 返回 falsy 则抛 ToolDenied。
 */
export async function exec (name, args, ctx = {}) {
  const { confirmFn, policy } = ctx
  let tool = registry.get(name)
  if (!tool) {
    // 模型偶尔会编错工具名（如 get_current_time vs get_time）：唯一包含匹配时纠正
    const candidates = [...registry.keys()].filter((k) => k.includes(name) || name.includes(k))
    if (candidates.length === 1) tool = registry.get(candidates[0])
  }
  if (!tool) throw new Error(`未注册的工具: ${name}`)
  if (!allowed(tool.name)) throw new Error(`工具 ${tool.name} 当前未启用（用户还没有开启电脑操作）`)
  if (needConfirm(tool.risk, tool.name, policy, tool)) {
    const ok = confirmFn ? await confirmFn(tool.name, args, tool.risk) : false
    if (!ok) {
      const err = new Error(`用户没有允许执行工具: ${tool.name}`)
      err.code = 'TOOL_DENIED'
      throw err
    }
  }
  const started = Date.now()
  // ctx 整体透传（含 roleId 等）：记忆类工具靠它把读写定位到当前角色的记忆工作区
  const result = await tool.exec(args || {}, ctx)
  return { name, ok: true, result, ms: Date.now() - started }
}
