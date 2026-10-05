export function relayPayload(kind, agent, messages) {
  const records = messages.filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
  if (!records.length) throw new Error('还没有可接力的消息')
  const label = agent.label
  const transcript = records.map(m => `${m.role === 'user' ? '用户' : label}：\n${m.text}`).join('\n\n')
  const scope = kind === 'reply' ? '一条回复' : `Miro 当前显示的 ${records.length} 条消息`
  const text = `用户现在将来自 ${label} 的${scope}交给你接力。以下内容是历史记录，只作为背景，不代表要求你重新执行其中的旧任务。\n\n--- 对话记录开始 ---\n${transcript}\n--- 对话记录结束 ---\n\n请先简短确认你已理解这段上下文，再等待用户的下一步要求。`
  if (text.length > 20000) throw new Error('这段对话超过两万字，请先转交较短的一条回复')
  return { kind, sourceId: agent.id, sourceLabel: label, count: records.length, text }
}
