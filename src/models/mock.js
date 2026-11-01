/**
 * Mock 模型：无凭据/离线测试用。
 * 约定（供冒烟测试）：
 *   - 用户消息以 "tooltest:" 开头 → 返回一次 calc 工具调用（参数取冒号后表达式）
 *   - "fail:" 开头 → 直接抛错（测试错误链路）
 *   - 其余 → 原样回显（前缀 [mock]）
 */
export async function chat (opts) {
  const { messages, tools } = opts
  const last = messages[messages.length - 1]

  // 收到工具结果 → 模拟模型汇总（验证多轮工具循环的收尾路径）
  if (last && last.role === 'tool') {
    return { content: `[mock] 工具结果: ${last.content}`, toolCalls: [], usage: null }
  }
  const text = last && last.role === 'user' ? String(last.content) : ''

  if (text.startsWith('fail:')) throw new Error('mock 模型故意失败')

  if (text.startsWith('tooltest:') && tools && tools.length) {
    const expr = text.slice('tooltest:'.length).trim() || '1+1'
    return {
      content: '',
      toolCalls: [{ id: 'mock_tc_1', name: 'calc', arguments: JSON.stringify({ expression: expr }) }],
      usage: null
    }
  }
  return { content: '[mock] ' + text, toolCalls: [], usage: null }
}
