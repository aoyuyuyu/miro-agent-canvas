const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { HistoryStore, parseJsonl } = require('../electron/history.cjs')
const { DesktopAdapter } = require('../electron/adapters/desktopAdapter.cjs')
function fixture(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miro-history-')), closers = []; t.after(() => { closers.forEach(close => close()); assert.equal(path.dirname(home), os.tmpdir()); fs.rmSync(home, { recursive: true, force: true }) }); return { home, local: path.join(home, 'Local'), directory: path.join(home, 'miro'), closers } }
function write(file, lines) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n') + '\n') }
test('Codex 原生正文超过旧三十条限制，显示事件不与底层响应重复', async t => {
  const options = fixture(t), file = path.join(options.home, 'rollout.jsonl')
  const lines = []
  for (let i = 0; i < 65; i++) {
    // 一部分助手只有 response_item，与当前桌面版的真实文件一致。
    if (i % 2 === 0 || i % 3 === 0) lines.push({ type: 'event_msg', payload: { type: i % 2 ? 'agent_message' : 'user_message', message: '中文原始消息 ' + i } })
    lines.push({ type: 'response_item', payload: { type: 'message', role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: '中文原始消息 ' + i }] } })
  }
  lines.push({ type: 'response_item', payload: { type: 'function_call_output', output: '工具结果不显示' } }, '{未写完')
  write(file, lines)
  const result = await parseJsonl(file, 'codex')
  assert.equal(result.messages.length, 65); assert.equal(result.messages[0].text, '中文原始消息 0'); assert.equal(result.messages[64].text, '中文原始消息 64'); assert.match(result.warning, /1 行/)
})
test('WorkBuddy 和 CodeBuddy 保留真正文字，排除工具、重复编号及子 Agent', async t => {
  const options = fixture(t), file = path.join(options.home, '.workbuddy/projects/project/session.jsonl')
  write(file, [
    { id: 'a', type: 'message', role: 'user', content: [{ type: 'input_text', text: '原窗口问题' }] },
    { uuid: 'b', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '原窗口回复' }, { type: 'tool_use', name: '不显示' }] } },
    { uuid: 'b', type: 'assistant', message: { role: 'assistant', content: '重复回复' } },
    { id: 'tool', role: 'tool', content: '工具内容' },
    { id: 'side', isSidechain: true, role: 'assistant', content: '子 Agent 内容' }
  ])
  const original = fs.readFileSync(file)
  const h = new HistoryStore(options), catalog = h.list(), session = catalog.sessions.find(s => s.provider === 'workbuddy')
  assert.ok(session); assert.equal('file' in session, false)
  const record = await h.read(session.key)
  assert.deepEqual(record.messages.map(x => x.text), ['原窗口问题', '原窗口回复'])
  h.bind('test-agent', session.key)
  const resumed = new HistoryStore(options)
  assert.equal((await resumed.bound())['test-agent'].messages[1].text, '原窗口回复')
  await assert.rejects(h.read('../../auth.json'), /不在本机历史目录/)
  assert.throws(() => h.bind('test-agent', 'unknown:id'), /正文/)
  assert.deepEqual(fs.readFileSync(file), original)
})
test('Hermes 原生数据库只读，WAL 新回复刷新；Antigravity 不冒称正文已接入', async t => {
  const options = fixture(t), file = path.join(options.local, 'hermes/state.db')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  options.closers.push(() => db.close())
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT,title TEXT,display_name TEXT,cwd TEXT,last_activity_at INTEGER,started_at INTEGER,archived INTEGER,hidden INTEGER); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp INTEGER,display_order INTEGER); INSERT INTO sessions VALUES('s','真正的历史','','',1,1,0,0); INSERT INTO messages VALUES(1,'s','user','原窗口问题',1,1)")
  const agFile = path.join(options.home, '.gemini/antigravity/conversation_summaries.db'); fs.mkdirSync(path.dirname(agFile), { recursive: true })
  const ag = new DatabaseSync(agFile); ag.exec("CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,last_modified_time INTEGER); INSERT INTO conversation_summaries VALUES('ag','Antigravity 历史',1)"); ag.close()
  const h = new HistoryStore(options); const items = h.list().sessions
  assert.equal((await h.read('hermes:s')).total, 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  db.exec("INSERT INTO messages VALUES(2,'s','assistant','新增原窗口回复',2,2)")
  assert.deepEqual((await h.read('hermes:s')).messages.map(x => x.text), ['原窗口问题', '新增原窗口回复'])
  assert.equal(items.find(x => x.provider === 'antigravity').readable, false)
  await assert.rejects(h.read('antigravity:ag'), /正文/)
})
test('本聊天优先原生文字全记录，仍保留桌面状态与发送中的补充', async t => {
  const options = fixture(t), native = Array.from({ length: 65 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '原生 ' + i }))
  const adapter = new DesktopAdapter({ connection: { threadId: 'thread' }, emit: () => {}, outgoingPath: path.join(options.home, 'outgoing.json'), readNative: async () => native })
  adapter.call = async () => ({ thread: { id: 'thread', title: '本聊天', status: { type: 'active' } }, turns: [{ status: 'inProgress', items: [] }] })
  await adapter.refresh()
  assert.equal(adapter.messages.length, 65); assert.equal(adapter.historySource, 'native'); assert.equal(adapter.status, 'working')
  adapter.outgoing = [{ text: '发送中的补充', anchor: '原生 64' }]
  await adapter.refresh(); assert.equal(adapter.messages.length, 66); assert.equal(adapter.messages.at(-1).text, '发送中的补充')
  assert.equal(native.length, 65)
})
