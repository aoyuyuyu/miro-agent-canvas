const MAX_TEXT = 20000
function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请输入消息')
  if (text.length > MAX_TEXT) throw new Error('内容超过两万字，请选择较短的对话再接力')
}
async function dispatchMany({ agentIds, text }, { list, send }) {
  validateText(text)
  if (!Array.isArray(agentIds) || !agentIds.length || agentIds.length > 16 || agentIds.some(id => typeof id !== 'string')) throw new Error('请选择一到十六个接收对象')
  const agents = await list()
  const results = await Promise.all([...new Set(agentIds)].map(async agentId => {
    const agent = agents.find(a => a.id === agentId)
    if (!agent) return { agentId, ok: false, error: '未找到此 Agent' }
    if (!agent.connected) return { agentId, ok: false, error: '此 Agent 已离线' }
    try { const response=await send(agentId, text); return { agentId, ok: true, ...(response?.messageId ? {messageId:response.messageId} : {}) } }
    catch (error) { return { agentId, ok: false, error: error.message || '发送失败' } }
  }))
  return { ok: results.every(r => r.ok), results }
}
module.exports = { dispatchMany, validateText }
