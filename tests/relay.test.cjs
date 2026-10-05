const test = require('node:test')
const assert = require('node:assert/strict')
const { dispatchMany } = require('../electron/relay.cjs')
test('群发去重，逐个报告失败，重试不重发成功对象', async () => {
  const sent = []
  let fail = true
  const dependencies = { list: async () => [{ id: 'a', connected: true }, { id: 'b', connected: true }, { id: 'c', connected: false }], send: async (id, text) => { if (id === 'b' && fail) throw new Error('临时失败'); sent.push({ id, text }) } }
  const first = await dispatchMany({ agentIds: ['a', 'a', 'b', 'c', 'missing'], text: '同一句中文\n两行' }, dependencies)
  assert.equal(first.ok, false)
  assert.equal(first.results.length, 4)
  assert.deepEqual(sent.map(x => x.id), ['a'])
  assert.equal(first.results.find(x => x.agentId === 'c').error, '此 Agent 已离线')
  fail = false
  const retry = await dispatchMany({ agentIds: first.results.filter(x => x.agentId === 'b').map(x => x.agentId), text: '同一句中文\n两行' }, dependencies)
  assert.equal(retry.ok, true)
  assert.deepEqual(sent.map(x => x.id), ['a', 'b'])
  assert.equal(sent[0].text, sent[1].text)
})
test('无效或过长内容不能触发任何发送', async () => {
  let called = false
  const dependencies = { list: async () => { called = true; return [] }, send: async () => {} }
  for (const payload of [{ agentIds: [], text: '你好' }, { agentIds: ['a'], text: '' }, { agentIds: ['a'], text: 'x'.repeat(20001) }, { agentIds: [123], text: '你好' }]) await assert.rejects(dispatchMany(payload, dependencies))
  assert.equal(called, false)
})
