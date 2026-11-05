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

  // 0）回归用：整轮只调工具、几乎不留正文（复现「（空回复）」）
  //    toolonly:      第一轮先说一句，之后每轮只发工具调用 → 必须保住那句，不能被空串冲掉
  //    toolonlyempty: 每一轮都只发工具调用 → 到轮数上限后收尾请求必须拿到一句文本
  const firstUser = messages.find((m) => m.role === 'user' && typeof m.content === 'string')
  const directive = String((firstUser && firstUser.content) || '')
  if (tools && tools.length && (directive.startsWith('toolonly:') || directive.startsWith('toolonlyempty:'))) {
    const used = messages.filter((m) => m.role === 'tool').length
    if (directive.startsWith('toolonly:') && used === 0) {
      return { content: '我先看看情况', toolCalls: [{ id: 'mock_tc_0', name: 'calc', arguments: '{"expression":"1+1"}' }], usage: null }
    }
    return { content: '', toolCalls: [{ id: 'mock_tc_' + used, name: 'calc', arguments: '{"expression":"1+1"}' }], usage: null }
  }

  // 0.46.29 回归：模型惯性「先 pet_say 一句开场 + 再写正文」两段式回复
  //  → 台词必须并入正文（聊天记录=她说的话），动作标记只演不念
  // saysplitdup: 正文开头把开场白原样再写一遍 → 合并时必须查重，不能出现两遍
  if (tools && tools.length && (directive.startsWith('saysplit:') || directive.startsWith('saysplitdup:') || directive.startsWith('saysplitshort:'))) {
    const used = messages.filter((m) => m.role === 'tool').length
    if (used === 0) {
      const script = directive.startsWith('saysplitdup:')
        ? 'うん、試さないと分からないもんね。[excited] じゃあ手始めに、焼き入れの話でも見てみようかな。'
        : directive.startsWith('saysplitshort:')
          ? 'う……当たり。[shy]'
          : '【笑】わかった、その線で。[excited]'
      return { content: '', toolCalls: [{ id: 'mock_say_0', name: 'pet_say', arguments: JSON.stringify({ script }) }], usage: null }
    }
    if (directive.startsWith('saysplitdup:')) {
      // 正文把开场白近似再写一遍（焼き入れ→焼入れ，一字之差）+ 新内容
      return { content: 'うん、試さないと分からないもんね。 じゃあ手始めに、焼入れの話でも見てみようかな。 私の目標に、ちゃんと書き留めておいたから。', toolCalls: [], usage: null }
    }
    if (directive.startsWith('saysplitshort:')) {
      // 0.46.43 短台词：归一化后不足 6 字（う当たり=5 字），旧查重直接放弃 → 开头连说两遍
      return { content: 'う……当たり。[shy]\n\nなんか、言われたときは「はい」って返せたのに、あとからじわじわ来るんだよ。', toolCalls: [], usage: null }
    }
    return { content: '正文ここから。続きだよ。', toolCalls: [], usage: null }
  }

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
