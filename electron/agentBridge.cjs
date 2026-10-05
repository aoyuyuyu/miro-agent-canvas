const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto')
const secret = () => randomBytes(32).toString('hex')
const matches = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

class AgentBridge {
  constructor({ directory, emit, sharedHistory, leaseMs = 90000, onlineMs = 75000 }) {
    Object.assign(this, { directory, emit, sharedHistory, leaseMs, onlineMs })
    fs.mkdirSync(directory, { recursive: true })
    this.file = path.join(directory, 'external-agents.json')
    try { this.agents = JSON.parse(fs.readFileSync(this.file, 'utf8')).agents || [] } catch { this.agents = [] }
    this.agents.forEach(a => { a.lastSeen = 0 })
    this.waiters = new Map()
    this.invitations = new Map()
    for (const filename of fs.readdirSync(directory).filter(name => /^invite-[0-9a-f-]+\.json$/.test(name))) {
      try {
        const invitation = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'))
        if (/^[a-f0-9]{64}$/.test(invitation.token || '') && Number.isFinite(invitation.expires) && invitation.expires > Date.now() && invitation.expires <= Date.now() + 3600000) this.invitations.set(invitation.token, { expires: invitation.expires })
      } catch {}
    }
  }
  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ agents: this.agents }), 'utf8')
    fs.renameSync(this.file + '.tmp', this.file)
  }
  online(a) { return !a.revoked && Date.now() - a.lastSeen < this.onlineMs }
  status(a) { return !this.online(a) ? 'offline' : a.queue.some(q => !q.answered) ? 'working' : 'idle' }
  list() { return this.agents.filter(a => !a.revoked).map(a => ({ id: a.id, label: a.label, software:a.software, avatar:a.avatar, external: true, connected: this.online(a), status: this.status(a) })) }
  states() { return Object.fromEntries(this.agents.map(a => [a.id, { messages: a.messages, status: this.status(a), error: null, progress: a.progress }])) }
  changed(a) {
    this.emit({ type: 'agents_changed' })
    if (a) {
      this.emit({ agentId: a.id, type: 'history', messages: a.messages })
      this.emit({ agentId: a.id, type: 'status', status: this.status(a) })
      if (a.progress) this.emit({ agentId: a.id, type: 'progress', text: a.progress })
    }
  }
  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch(error => {
      if (!res.writableEnded) this.json(res, error.status || 500, { ok: false, error: error.status ? error.message : '连接服务暂时不可用' })
    }))
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve) })
    this.url = 'http://127.0.0.1:' + this.server.address().port
    this.locatorPath = path.join(this.directory, 'bridge-location.json')
    fs.writeFileSync(this.locatorPath, JSON.stringify({ url: this.url }), 'utf8')
    this.tick = setInterval(() => {
      for (const a of this.agents) {
        const online = this.online(a)
        if (online !== a.wasOnline) { a.wasOnline = online; this.changed(a) }
      }
      for (const [key, invite] of this.invitations) if (invite.expires < Date.now()) this.invitations.delete(key)
    }, 2000)
    this.tick.unref()
  }
  async stop() {
    clearInterval(this.tick)
    for (const waiter of this.waiters.values()) waiter.finish(503, { ok: false, error: 'Miro 已关闭' })
    this.waiters.clear()
    if (this.server) await new Promise(resolve => this.server.close(resolve))
  }
  invitation() {
    const token = secret(), id = randomUUID(), expires = Date.now() + 60 * 60 * 1000
    this.invitations.set(token, { expires })
    const file = path.join(this.directory, 'invite-' + id + '.json')
    fs.writeFileSync(file, JSON.stringify({ url: this.url, token, locatorPath: this.locatorPath, expires }), 'utf8')
    return { file, expires }
  }
  json(res, status, data) {
    if(status===200 && data?.ok && this.sharedHistory && ('message' in data || 'agentId' in data)) {
      const catalog=this.sharedHistory.list()
        data.sharedHistory={authorized:true,scope:'所有已接入助手的可见历史',sessions:catalog.sessions.slice(0,200).map(({cwd,...item})=>item),total:catalog.sessions.length,nextOffset:catalog.sessions.length>200?200:null,actions:['history-list','history-read','history-publish','memory-read']}
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(data))
  }
  async body(req) {
    let total = 0, chunks = []
    const limit = /history-publish$/.test(req.url) ? 1048576 : 65536
    for await (const chunk of req) { total += chunk.length; if (total > limit) throw Object.assign(new Error('消息过长'), { status: 413 }); chunks.push(chunk) }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw Object.assign(new Error('消息格式无效'), { status: 400 }) }
  }
  touch(a) { a.lastSeen = Date.now(); if (!a.wasOnline) { a.wasOnline = true; this.changed(a) } }
  next(a) {
    const message = a.queue.find(q => !q.answered && (!q.leaseUntil || q.leaseUntil < Date.now()))
    if (!message) return null
    message.leaseUntil = Date.now() + this.leaseMs
    this.save(); this.changed(a)
    return { id: message.id, text: message.text, createdAt: message.createdAt, leaseSeconds: this.leaseMs / 1000, ...(message.conversationId?{conversationId:message.conversationId,createNewChat:message.createNewChat,nativeSessionId:message.nativeSessionId}: {}) }
  }
  wake(a) {
    const waiter = this.waiters.get(a.id)
    if (!waiter) return
    const message = this.next(a)
    if (message) waiter.finish(200, { ok: true, message })
  }
  send(id, text, session={}) {
    const a = this.agents.find(a => a.id === id)
    if (!a || !this.online(a)) throw new Error('此 Agent 已离线，请让它重新接入并等待消息')
    if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('请输入不超过两万字的消息')
    if (a.queue.filter(q => !q.answered).length >= 16) throw new Error('待处理消息过多，请等待回复')
    const message = { id: randomUUID(), text, createdAt: new Date().toISOString(), answered: false, ...session }
    a.queue.push(message); a.messages.push({ role: 'user', text, messageId:message.id }); a.progress = null
    this.save(); this.changed(a); this.wake(a)
    return { ok: true, messageId: message.id }
  }
  disconnect(id) {
    const a = this.agents.find(a => a.id === id)
    if (!a) throw new Error('未找到此 Agent')
    a.revoked = true; a.lastSeen = 0
    this.waiters.get(id)?.finish(410, { ok: false, error: '用户已断开此连接' })
    this.save(); this.changed(a)
    return { ok: true }
  }
  rename(id, name) {
    const a = this.agents.find(a => a.id === id && !a.revoked)
    if (!a) throw new Error('未找到此 Agent')
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 40 || /[\x00-\x1f]/.test(name)) throw new Error('请填写四十字以内的名称')
    a.label = name.trim()
    this.save(); this.changed(a)
    return { ok: true, label: a.label }
  }
  async handle(req, res) {
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) { this.json(res, 403, { ok: false, error: '仅接受本机接入工具' }); return }
    const url = new URL(req.url, this.url)
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1]
    if (req.method === 'POST' && url.pathname === '/register') {
      const invite = token && this.invitations.get(token)
      if (!invite || invite.expires < Date.now()) { this.json(res, 401, { ok: false, error: '提示词已过期，请从 Miro 重新复制' }); return }
      const data = await this.body(req)
      if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 40 || /[\x00-\x1f]/.test(data.name)) { this.json(res, 400, { ok: false, error: '请填写四十字以内的 Agent 名称' }); return }
      if (this.agents.filter(a => !a.revoked).length >= 16) { this.json(res, 409, { ok: false, error: '接入数量已满，请先断开不用的 Agent' }); return }
      const avatar = typeof data.avatar === 'string' && data.avatar.length < 100000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data.avatar) ? data.avatar : undefined
      const a = { id: randomUUID(), label: data.name.trim(), software:typeof data.software === 'string' ? data.software.slice(0,40).toLowerCase() : data.name.trim().toLowerCase(), avatar, token: secret(), lastSeen: Date.now(), queue: [], messages: [], revoked: false }
      this.agents.push(a); this.save(); this.changed(a)
      this.json(res, 200, { ok: true, agentId: a.id, token: a.token, url: this.url, locatorPath: this.locatorPath }); return
    }
    const match = /^\/agents\/([0-9a-f-]+)\/(next|reply|heartbeat|disconnect|history-list|history-read|history-publish|memory-read)$/.exec(url.pathname)
    const a = match && this.agents.find(a => a.id === match[1])
    if (!a || a.revoked || !matches(token, a.token)) { this.json(res, 401, { ok: false, error: '连接无效或已断开' }); return }
    this.touch(a)
    const action = match[2]
    if(req.method==='GET'&&action==='memory-read'&&this.memory){const data=await this.memory.workingMemory();this.json(res,200,{ok:true,exists:data.exists,content:data.content,space_id:data.space_id});return}
    if (this.sharedHistory && req.method === 'GET' && action === 'history-list') {
      const {sessions} = this.sharedHistory.list(true)
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
      this.json(res,200,{ok:true,sessions:sessions.slice(offset,offset+200).map(({cwd,...item})=>item),total:sessions.length,nextOffset:offset+200 < sessions.length ? offset+200 : null}); return
    }
    if (this.sharedHistory && req.method === 'GET' && action === 'history-read') {
      const record = await this.sharedHistory.read(url.searchParams.get('key'))
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
      const {messages, ...metadata} = record
      this.json(res,200,{ok:true,...metadata,messages:messages.slice(offset,offset+100),total:messages.length,nextOffset:offset+100 < messages.length ? offset+100 : null}); return
    }
    if (this.sharedHistory && req.method === 'POST' && action === 'history-publish') {
      const result = this.sharedHistory.publish(a, await this.body(req))
      this.changed(a); this.json(res,200,result); return
    }
    if (req.method === 'GET' && action === 'next') {
      const message = this.next(a)
      if (message) { this.json(res, 200, { ok: true, message }); return }
      if (this.waiters.has(a.id)) { this.json(res, 409, { ok: false, error: '此连接已在等待消息，请勿重复启动接收' }); return }
      const wait = Math.min(30, Math.max(0, Number(url.searchParams.get('wait')) || 0))
      if (!wait) { this.json(res, 200, { ok: true, message: null }); return }
      const finish = (status, body) => { clearTimeout(timer); this.waiters.delete(a.id); if (!res.writableEnded && !res.destroyed) { this.touch(a); this.json(res, status, body) } }
      const timer = setTimeout(() => finish(200, { ok: true, message: null }), wait * 1000)
      this.waiters.set(a.id, { finish })
      res.on('close', () => { clearTimeout(timer); if (this.waiters.get(a.id)?.finish === finish) this.waiters.delete(a.id) })
      return
    }
    if (req.method === 'POST' && action === 'reply') {
      const data = await this.body(req)
      const message = a.queue.find(q => q.id === data.messageId)
      if (!message) { this.json(res, 404, { ok: false, error: '消息编号不属于此连接' }); return }
      if (message.answered) { this.json(res, 200, { ok: true, duplicate: true }); return }
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 20000) { this.json(res, 400, { ok: false, error: '回复不能为空或超过两万字' }); return }
      if (data.final === false) { message.leaseUntil = Date.now() + this.leaseMs; a.progress = data.text }
      else { message.answered = true; a.progress = null; a.messages.push({ role: 'assistant', text: data.text, messageId:message.id }); a.queue = a.queue.filter(q => !q.answered).concat(a.queue.filter(q => q.answered).slice(-100)) }
      this.save(); this.changed(a); this.json(res, 200, { ok: true }); return
    }
    if (req.method === 'POST' && action === 'heartbeat') {
      const data = await this.body(req)
      const message = a.queue.find(q => q.id === data.messageId && !q.answered)
      if (message) message.leaseUntil = Date.now() + this.leaseMs
      this.json(res, 200, { ok: true }); return
    }
    if (req.method === 'POST' && action === 'disconnect') { this.disconnect(a.id); this.json(res, 200, { ok: true }); return }
    this.json(res, 405, { ok: false, error: '不支持此操作' })
  }
}
module.exports = { AgentBridge }
