const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const {createCodebuddySessionParseState,consumeCodebuddySessionLine,finalizeCodebuddySessionParseState,isKnownHarnessInjectedUserTurnText}=require('./vendor/orca.cjs')

const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => ['text', 'input_text', 'output_text'].includes(x.type)).map(x => x.text || '').join('\n') : ''
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) }
const iso = value => { const date = new Date(typeof value === 'number' && value < 100000000000 ? value * 1000 : value); return Number.isNaN(date.getTime()) ? '' : date.toISOString() }
function files(root, depth = 2) {
  if (!fs.existsSync(root)) return []
  const out = []
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue
    const file = path.join(root, item.name)
    if (item.isFile() && item.name.endsWith('.jsonl')) out.push(file)
    else if (item.isDirectory() && depth > 0 && !['tool-results', 'subagents'].includes(item.name)) out.push(...files(file, depth - 1))
  }
  return out
}
function withDb(file, run) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true, timeout: 3000 })
  try { db.exec('PRAGMA query_only=ON'); return run(db) } finally { db.close() }
}
async function parseJsonl(file, provider) {
  const ordinary = [], events = [], seen = new Set()
  const input = fs.createReadStream(file, { encoding: 'utf8' })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let invalid = 0, canonicalUsers = false
  const codebuddyMessages=[]
  const codebuddyState=provider==='codebuddy'?createCodebuddySessionParseState({path:file,modifiedAt:fs.statSync(file).mtime.toISOString()},{active:true,push:m=>{if(['user','assistant'].includes(m.role)&&!isKnownHarnessInjectedUserTurnText(m.text))codebuddyMessages.push({...m})}}):null
  let nativeCodebuddy=false
  const appendVisible = message => { const previous = events.at(-1); if (!(previous?.role === message.role && previous.text === message.text)) events.push(message) }
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line.replace(/^\uFEFF/, '')) } catch { invalid++; continue }
      if(codebuddyState&&row.type==='message'&&['user','assistant'].includes(row.role)){nativeCodebuddy=true;consumeCodebuddySessionLine(codebuddyState,line);continue}
      if(codebuddyState&&['summary','ai-title'].includes(row.type)){consumeCodebuddySessionLine(codebuddyState,line);continue}
      let role, text, id
      if (provider === 'codex') {
        // Codex Desktop's native create/send APIs persist incoming prompts in this envelope.
        // Read only its input; all other tool results stay outside visible conversations.
        if(row.type==='response_item'&&row.payload?.type==='function_call_output'&&['create_thread','send_message_to_thread'].includes(row.payload.name)&&row.payload.namespace==='codex_app'&&typeof row.payload.output==='string'&&row.payload.output.trim().startsWith('<codex_delegation>')){
          const match=/<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/.exec(row.payload.output)
          if(match){canonicalUsers=true;appendVisible({role:'user',text:match[1],timestamp:row.timestamp})}continue
        }
        if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(row.payload?.type)) {
          if (row.payload.type === 'user_message') canonicalUsers = true
          appendVisible({ role: row.payload.type === 'user_message' ? 'user' : 'assistant', text: row.payload.message || '', timestamp: row.timestamp }); continue
        }
        if (row.type !== 'response_item' || row.payload?.type !== 'message') continue
        role = row.payload.role; text = textOf(row.payload.content)
        if (row.payload.channel === 'analysis') continue
        if(role==='user'&&text.startsWith('# AGENTS.md instructions')&&text.includes('<environment_context>'))continue
      } else {
        const message = row.message || row
        role = message.role || (['user', 'assistant'].includes(row.type) ? row.type : null)
        text = textOf(message.content); id = row.uuid || row.id
        if (row.isSidechain || row.type === 'progress') continue
      }
      if (!['user', 'assistant'].includes(role) || !text) continue
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      ordinary.push({ role, text, timestamp: row.timestamp })
      // 桌面版常只写 user_message 事件，助手正文保存在 response_item。
      // 两种流合并；不能因已有用户事件而丢弃全部助手回复。
      if (provider === 'codex' && role === 'assistant') appendVisible({ role, text, timestamp: row.timestamp })
    }
  } finally { lines.close(); input.destroy() }
  return { messages: nativeCodebuddy?codebuddyMessages:canonicalUsers ? events.filter(x => x.text) : ordinary, ...(nativeCodebuddy?{title:finalizeCodebuddySessionParseState(codebuddyState,process.platform)?.title}:{}), warning: invalid ? `${invalid} 行未完成或损坏的记录未读取；稍后刷新会重试。` : '' }
}

class HistoryStore {
  constructor({ directory, home = process.env.USERPROFILE, local = process.env.LOCALAPPDATA, mock = false }) {
    Object.assign(this, { directory, home, local, mock })
    fs.mkdirSync(directory, { recursive: true })
    this.catalog = new Map(); this.cache = new Map(); this.pending = new Map(); this.updated = 0
    this.bindingsFile = path.join(directory, 'native-bindings.json')
    try { this.bindings = JSON.parse(fs.readFileSync(this.bindingsFile, 'utf8')) } catch { this.bindings = {} }
  }
  list(force = false) {
    if (!force && Date.now() - this.updated < 10000) return this.result
    const catalog = new Map(), providers = []
    const add = item => { const key = item.provider + ':' + item.id; catalog.set(key, { ...item, key }); }
    const scan = (id, label, run) => {
      try { const count = run(); providers.push({ id, label, count, status: count ? 'ready' : 'empty' }) }
      catch { providers.push({ id, label, count: 0, status: 'unavailable', reason: '本机历史接口不可用或数据格式不兼容' }) }
    }
    if (!this.mock) {
      scan('codex', 'Codex', () => {
        const root = path.join(this.home, '.codex'), db = path.join(root, 'state_5.sqlite')
        let count = 0
        if (fs.existsSync(db)) {
          withDb(db, database => {
            for (const row of database.prepare('SELECT id,title,cwd,updated_at,rollout_path,archived FROM threads ORDER BY updated_at DESC').all()) {
              const file = row.rollout_path
              if (!file || ![path.join(root, 'sessions'), path.join(root, 'archived_sessions')].some(r => within(r, file)) || !fs.existsSync(file)) continue
              add({ provider: 'codex', label: 'Codex', id: row.id, title: row.title || '未命名会话', cwd: row.cwd, updatedAt: iso(row.updated_at), file, readable: true, archived: !!row.archived }); count++
            }
          })
        }
        // 文件存在而桌面索引缺项时，仍列出原始记录，不把缺项当作丢失。
        const indexedFiles = new Set([...catalog.values()].map(x => x.file))
        for (const file of [...files(path.join(root, 'sessions'), 3), ...files(path.join(root, 'archived_sessions'), 3)]) {
          if (indexedFiles.has(file)) continue
          const id = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/)?.[1]
          if (id) { add({ provider: 'codex', label: 'Codex', id, title: '索引外会话 · ' + id.slice(0, 8), updatedAt: fs.statSync(file).mtime.toISOString(), file, readable: true }); count++ }
        }
        return count
      })
      for (const [id, label, folder] of [['workbuddy', 'WorkBuddy', '.workbuddy'], ['codebuddy', 'CodeBuddy', '.codebuddy'], ['claude', 'Claude', '.claude']]) {
        scan(id, label, () => {
          const root = path.join(this.home, folder), titles = new Map()
          if (id === 'workbuddy' && fs.existsSync(path.join(root, 'workbuddy.db'))) withDb(path.join(root, 'workbuddy.db'), database => {
            for (const row of database.prepare('SELECT id,title,custom_title,cwd,updated_at,deleted_at FROM sessions').all()) titles.set(row.id, row)
          })
          let count = 0
          for (const file of files(path.join(root, 'projects'), 1)) {
            const sessionId = path.basename(file, '.jsonl'), metadata = titles.get(sessionId)
            if (metadata?.deleted_at) continue
            add({ provider: id, label, id: sessionId, title: metadata?.custom_title || metadata?.title || '会话 · ' + sessionId.slice(0, 8), cwd: metadata?.cwd || path.basename(path.dirname(file)), updatedAt: metadata?.updated_at ? iso(metadata.updated_at) : fs.statSync(file).mtime.toISOString(), file, readable: true }); count++
          }
          return count
        })
      }
      scan('hermes', 'Hermes', () => {
        const file = path.join(this.local, 'hermes', 'state.db')
        if (!fs.existsSync(file)) return 0
        return withDb(file, db => {
          const rows = db.prepare('SELECT id,title,display_name,cwd,last_activity_at,started_at,archived FROM sessions WHERE COALESCE(hidden,0)=0 ORDER BY started_at DESC').all()
          for (const row of rows) add({ provider: 'hermes', label: 'Hermes', id: row.id, title: row.title || row.display_name || '未命名会话', cwd: row.cwd, createdAt:iso(row.started_at), updatedAt: iso(row.last_activity_at || row.started_at), file, readable: true, archived: !!row.archived })
          return rows.length
        })
      })
      scan('antigravity', 'Antigravity', () => {
        const file = path.join(this.home, '.gemini/antigravity/conversation_summaries.db')
        if (!fs.existsSync(file)) return 0
        return withDb(file, db => {
          const rows = db.prepare('SELECT conversation_id,title,last_modified_time FROM conversation_summaries').all()
          for (const row of rows) add({ provider: 'antigravity', label: 'Antigravity', id: row.conversation_id, title: row.title || '未命名会话', updatedAt: iso(row.last_modified_time), readable: false, reason: '已读取原生会话目录；正文使用专用格式，尚未接入正文接口。' })
          return rows.length
        })
      })
    }
    this.catalog = catalog; this.updated = Date.now()
    const sessions = [...catalog.values()].map(({ file, ...publicItem }) => publicItem).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    this.result = { sessions, providers, bindings: this.bindings }
    return this.result
  }
  async read(key) {
    this.list()
    const item = this.catalog.get(key)
    if (!item) throw new Error('会话不在本机历史目录中，请刷新列表')
    if (!item.readable) throw new Error(item.reason || '此会话暂不能读取正文')
    const stamp = fs.statSync(item.file)
    let version = stamp.size + ':' + stamp.mtimeMs
    if (item.provider === 'hermes' && fs.existsSync(item.file + '-wal')) { const wal = fs.statSync(item.file + '-wal'); version += ':' + wal.size + ':' + wal.mtimeMs }
    if (this.cache.get(key)?.version === version) return this.cache.get(key).value
    if (this.pending.has(key)) return this.pending.get(key)
    const operation = (async () => {
      let result
      if (item.provider === 'hermes') result = withDb(item.file, db => ({ messages: db.prepare("SELECT role,content,timestamp FROM messages WHERE session_id=? AND role IN ('user','assistant') ORDER BY COALESCE(display_order,id),id").all(item.id).map(row => ({ role: row.role, text: textOf(row.content), timestamp: iso(row.timestamp) })).filter(row => row.text), warning: '' }))
      else {
        const real = fs.realpathSync(item.file)
        if (!within(path.join(this.home, ({ codex: '.codex', workbuddy: '.workbuddy', codebuddy: '.codebuddy', claude: '.claude' })[item.provider]), real)) throw new Error('原生记录路径已改变，请刷新列表')
        result = await parseJsonl(real, item.provider)
      }
      const { file, ...source } = item
      const value = { ...source, ...result, origin: 'native', total: result.messages.length }
      this.cache.set(key, { version, value }); return value
    })().finally(() => this.pending.delete(key))
    this.pending.set(key, operation); return operation
  }
  async codexMessages(id) { try { return (await this.read('codex:' + id)).messages } catch { return null } }
  bind(agentId, key) {
    this.list()
    if (key && !this.catalog.get(key)?.readable) throw new Error('只能绑定已接入正文的原生会话')
    if (key) this.bindings[agentId] = key
    else delete this.bindings[agentId]
    fs.writeFileSync(this.bindingsFile + '.tmp', JSON.stringify(this.bindings), 'utf8'); fs.renameSync(this.bindingsFile + '.tmp', this.bindingsFile)
    return { ok: true }
  }
  async bound() {
    const entries = await Promise.all(Object.entries(this.bindings).map(async ([id, key]) => {
      try { return [id, await this.read(key)] } catch { return [id, { key, error: '原生会话暂时读不到；没有用 Miro 收发记录冒充原生记录。', messages: [], origin: 'native' }] }
    }))
    return Object.fromEntries(entries)
  }
}
module.exports = { HistoryStore, parseJsonl, textOf }
