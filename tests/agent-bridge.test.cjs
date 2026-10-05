const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { AgentBridge } = require('../electron/agentBridge.cjs')
const run = promisify(execFile)
const helper = path.join(__dirname, '../electron/miro-agent.ps1')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miro-bridge-'))
  const bridge = new AgentBridge({ directory, emit: () => {}, ...options })
  await bridge.start()
  const invite = JSON.parse(fs.readFileSync(bridge.invitation().file, 'utf8'))
  async function request(route, token, body, extra = {}) {
    const response = await fetch(bridge.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const register = async name => (await request('/register', invite.token, { name })).body
  return { bridge, directory, invite, request, register }
}
test('连接隔离、中文往返、进度与重复回复', async () => {
  const f = await fixture()
  try {
    const a = await f.register('测试甲'), b = await f.register('测试乙')
    assert.equal((await f.request('/agents/' + a.agentId + '/next', b.token)).status, 401)
    const sent = f.bridge.send(a.agentId, '中文消息\n含换行 & 引号“你好”')
    const received = await f.request('/agents/' + a.agentId + '/next', a.token)
    assert.equal(received.body.message.id, sent.messageId)
    assert.equal(received.body.message.text, '中文消息\n含换行 & 引号“你好”')
    assert.equal((await f.request('/agents/' + b.agentId + '/reply', b.token, { messageId: sent.messageId, text: '冒用回复' })).status, 404)
    await f.request('/agents/' + a.agentId + '/reply', a.token, { messageId: sent.messageId, text: '正在处理', final: false })
    assert.equal(f.bridge.states()[a.agentId].progress, '正在处理')
    const reply = { messageId: sent.messageId, text: '中文回复\n第二行' }
    await f.request('/agents/' + a.agentId + '/reply', a.token, reply)
    assert.equal((await f.request('/agents/' + a.agentId + '/reply', a.token, reply)).body.duplicate, true)
    assert.equal(f.bridge.states()[a.agentId].messages.length, 2)
    assert.equal(f.bridge.states()[b.agentId].messages.length, 0)
  } finally { await f.bridge.stop() }
})
test('改名保持凭证、排队消息与历史，并在重启后保留', async () => {
  const f = await fixture()
  let restarted
  try {
    const a = await f.register('Codex')
    const message = f.bridge.send(a.agentId, '保留的消息')
    const tokenBefore = f.bridge.agents[0].token
    assert.throws(() => f.bridge.rename(a.agentId, ' '))
    assert.throws(() => f.bridge.rename(a.agentId, '坏\n名称'))
    f.bridge.rename(a.agentId, 'WorkBuddy')
    assert.equal(f.bridge.list()[0].label, 'WorkBuddy')
    assert.equal(f.bridge.agents[0].token, tokenBefore)
    assert.equal((await f.request('/agents/' + a.agentId + '/next', a.token)).body.message.id, message.messageId)
    await f.bridge.stop()
    restarted = new AgentBridge({ directory: f.directory, emit: () => {} })
    assert.equal(restarted.agents[0].label, 'WorkBuddy')
    assert.equal(restarted.agents[0].messages[0].text, '保留的消息')
    assert.equal(restarted.agents[0].token, tokenBefore)
    await restarted.start()
  } finally { await (restarted || f.bridge).stop() }
})
test('长轮询、租约重投、离线和断开撤销', async () => {
  const f = await fixture({ leaseMs: 50, onlineMs: 100 })
  try {
    const a = await f.register('测试等待')
    const wait = f.request('/agents/' + a.agentId + '/next?wait=3', a.token)
    await sleep(20)
    const sent = f.bridge.send(a.agentId, '请处理')
    assert.equal((await wait).body.message.id, sent.messageId)
    assert.equal((await f.request('/agents/' + a.agentId + '/next', a.token)).body.message, null)
    await sleep(60)
    assert.equal((await f.request('/agents/' + a.agentId + '/next', a.token)).body.message.id, sent.messageId)
    await sleep(120)
    assert.equal(f.bridge.list()[0].connected, false)
    await f.request('/agents/' + a.agentId + '/heartbeat', a.token, {})
    assert.equal(f.bridge.list()[0].connected, true)
    f.bridge.disconnect(a.agentId)
    assert.equal((await f.request('/agents/' + a.agentId + '/next', a.token)).status, 401)
  } finally { await f.bridge.stop() }
})
test('拒绝网页跨站、过期邀请和过大内容', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request('/register', f.invite.token, { name: '网页' }, { Origin: 'https://example.com' })).status, 403)
    f.bridge.invitations.get(f.invite.token).expires = 0
    assert.equal((await f.request('/register', f.invite.token, { name: '过期' })).status, 401)
    const next = JSON.parse(fs.readFileSync(f.bridge.invitation().file, 'utf8'))
    assert.equal((await f.request('/register', next.token, { name: '超大', text: 'x'.repeat(70000) })).status, 413)
  } finally { await f.bridge.stop() }
})
test('服务重启保留原邀请有效期，不接受过期或损坏文件', async () => {
  const f = await fixture()
  let restarted
  try {
    fs.writeFileSync(path.join(f.directory, 'invite-expired.json'), JSON.stringify({ token: 'a'.repeat(64), expires: Date.now() - 1 }))
    fs.writeFileSync(path.join(f.directory, 'invite-bad.json'), 'invalid')
    await f.bridge.stop()
    restarted = new AgentBridge({ directory: f.directory, emit: () => {} })
    await restarted.start()
    assert.equal(restarted.invitations.get(f.invite.token).expires, f.invite.expires)
    assert.equal(restarted.invitations.has('a'.repeat(64)), false)
    const response = await fetch(restarted.url + '/register', { method: 'POST', headers: { Authorization: 'Bearer ' + f.invite.token }, body: JSON.stringify({ name: '重启后接入' }) })
    assert.equal(response.status, 200)
  } finally { await (restarted || f.bridge).stop() }
})
test('Windows PowerShell 接入工具：注册、收消息、回复、服务重启后继续', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture()
  const inviteFile = f.bridge.invitation().file
  const exec = async args => JSON.parse((await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, ...args], { windowsHide: true, encoding: 'utf8', timeout: 45000 })).stdout.trim())
  let restarted
  try {
    const registration = await exec(['-Action', 'register', '-InviteFile', inviteFile, '-Name', '接入工具验证'])
    assert.equal(registration.ok, true)
    const session = registration.sessionFile
    const first = f.bridge.send(registration.agentId, '工具链中文消息')
    const received = await exec(['-Action', 'receive', '-SessionFile', session, '-WaitSeconds', '0'])
    assert.equal(received.message.id, first.messageId)
    const reply = path.join(f.directory, 'response.txt')
    fs.writeFileSync(reply, '接入工具已回传真实文件内容\n第二行', 'utf8')
    await exec(['-Action', 'reply', '-SessionFile', session, '-MessageId', first.messageId, '-ReplyFile', reply])
    assert.equal(f.bridge.states()[registration.agentId].messages[1].text, '接入工具已回传真实文件内容\n第二行')
    await f.bridge.stop()
    restarted = new AgentBridge({ directory: f.directory, emit: () => {} })
    await restarted.start()
    await exec(['-Action', 'heartbeat', '-SessionFile', session])
    const second = restarted.send(registration.agentId, '重启后消息')
    assert.equal((await exec(['-Action', 'receive', '-SessionFile', session, '-WaitSeconds', '0'])).message.id, second.messageId)
    await exec(['-Action', 'disconnect', '-SessionFile', session])
    assert.equal(restarted.list().length, 0)
  } finally { if (restarted) await restarted.stop(); else await f.bridge.stop() }
})
