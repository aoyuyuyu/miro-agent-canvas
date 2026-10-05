import test from 'node:test'
import assert from 'node:assert/strict'
import { relayPayload } from '../src/shared/relay.js'
test('接力带来源、顺序与范围，原记录保持不变', () => {
  const messages = [{ role: 'user', text: '第一问' }, { role: 'assistant', text: '第二答' }, { role: 'tool', text: '私有工具输出' }]
  const result = relayPayload('session', { id: 'source', label: 'WorkBuddy' }, messages)
  assert.equal(result.sourceId, 'source')
  assert.equal(result.count, 2)
  assert.ok(result.text.indexOf('用户：\n第一问') < result.text.indexOf('WorkBuddy：\n第二答'))
  assert.ok(result.text.includes('Miro 当前显示的 2 条消息'))
  assert.ok(!result.text.includes('私有工具输出'))
  assert.equal(messages.length, 3)
  assert.throws(() => relayPayload('session', { label: '甲' }, [{ role: 'user', text: 'x'.repeat(20000) }]), /超过两万字/)
  assert.throws(() => relayPayload('reply', { label: '甲' }, []), /没有/)
})
