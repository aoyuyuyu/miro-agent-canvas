const net = require('node:net')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')

class DesktopAdapter {
  constructor({ connection, emit, outgoingPath, readNative }) {
    this.connection = connection
    this.emit = emit
    this.desktop = true
    this.currentProcess = null
    this.messages = []
    this.status = 'idle'
    this.connected = false
    this.lastHistory = ''
    this.polling = false
    this.outgoingPath = outgoingPath
    this.readNative = readNative
    try { const saved = JSON.parse(fs.readFileSync(outgoingPath, 'utf8')); this.outgoing = saved.threadId === connection.threadId ? saved.messages : [] } catch { this.outgoing = [] }
  }
  async call(tool, args) {
    const { pipePath, threadId } = this.connection
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      namespace: 'codex_app', tool, arguments: args, callerSource: 'codex', threadId:this.connection.callerThreadId || threadId,
      turnId: 'mcp-turn-miro-' + randomUUID(), callId: 'mcp-call-miro-' + randomUUID()
    } }
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath)
      let buffer = Buffer.alloc(0)
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('桌面连接超时')) }, 20000)
      const finish = (err, value) => { clearTimeout(timer); socket.destroy(); err ? reject(err) : resolve(value) }
      socket.on('error', error => finish(error))
      socket.on('connect', () => {
        const data = Buffer.from(JSON.stringify(request), 'utf8')
        const frame = Buffer.alloc(4 + data.length)
        frame.writeUInt32LE(data.length); data.copy(frame, 4); socket.write(frame)
      })
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length < 4) return
        const length = buffer.readUInt32LE()
        if (length > 8 * 1024 * 1024) { finish(new Error('桌面响应过大')); return }
        if (buffer.length < length + 4) return
        try {
          const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'))
          finish(message.error ? new Error(message.error.message) : null, message.result)
        } catch (error) { finish(error) }
      })
    })
    if (!response?.success) throw new Error('桌面未接受此操作')
    const text = response.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n') || ''
    try { return JSON.parse(text) } catch { return { text } }
  }
  async refresh() {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.readCurrent().finally(() => { this.refreshPromise = null })
    return this.refreshPromise
  }
  async readCurrent() {
    try {
      const data = await this.call('read_thread', { threadId: this.connection.threadId, hostId: 'local', turnLimit: 3, maxOutputCharsPerItem: 5000 })
      if (data.thread?.id !== this.connection.threadId) throw new Error('聊天编号不匹配')
      this.title = data.thread.title
      this.workspace = data.thread.cwd
      this.connected = true
      const nativeMessages = await this.readNative?.(this.connection.threadId)
      this.historySource = nativeMessages ? 'native' : 'desktop-preview'
      this.messages = nativeMessages ? nativeMessages.map(message => ({ ...message })) : [...(data.turns || [])].reverse().flatMap(turn => (turn.items || []).flatMap(item => {
        if (item.type === 'userMessage') {
          let text = (item.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')
          const start = text.indexOf('## My request:')
          if (start >= 0) text = text.slice(start + 14).trim()
          return text ? [{ role: 'user', text }] : []
        }
        return item.type === 'agentMessage' && item.text ? [{ role: 'assistant', text: item.text }] : []
      })).slice(-30)
      for (const outgoing of this.outgoing) {
        if (this.messages.some(message => message.role === 'user' && message.text === outgoing.text)) continue
        const anchor = this.messages.findLastIndex(message => message.text === outgoing.anchor)
        this.messages.splice(anchor >= 0 ? anchor + 1 : this.messages.length, 0, { role: 'user', text: outgoing.text })
      }
      const serialized = JSON.stringify(this.messages)
      if (serialized !== this.lastHistory) { this.lastHistory = serialized; this.emit({ type: 'history', messages: this.messages }) }
      const active = data.thread.status?.type === 'active' || data.turns?.[0]?.status === 'inProgress'
      this.status = active ? 'working' : 'idle'
      this.emit({ type: 'connection', connected: true, title: this.title })
      this.emit({ type: 'status', status: this.status })
    } catch {
      this.connected = false; this.status = 'error'
      this.emit({ type: 'connection', connected: false })
      this.emit({ type: 'status', status: 'error' })
      this.emit({ type: 'error', message: '当前聊天连接中断，请确认 Codex 桌面仍在运行。' })
    }
  }
  async detect() {
    await this.refresh()
    return { connected: this.connected, version: '桌面当前聊天', desktop: true, title: this.title }
  }
  start() { this.timer = setInterval(() => this.refresh(), 3000); this.timer.unref() }
  stop() { clearInterval(this.timer) }
  async send({ text }) {
    if (!text?.trim()) throw new Error('消息不能为空')
    if (!this.connected) throw new Error('当前聊天未连接')
    if (this.currentProcess) throw new Error('上一条消息正在发送')
    this.currentProcess = { sending: true }
    this.status = 'working'; this.emit({ type: 'status', status: 'working' })
    try {
      const result = await this.call('send_message_to_thread', { threadId: this.connection.threadId, hostId: 'local', prompt: text })
      this.outgoing.push({ text, anchor: this.messages.at(-1)?.text || '' })
      this.outgoing = this.outgoing.slice(-50)
      fs.writeFileSync(this.outgoingPath, JSON.stringify({ threadId: this.connection.threadId, messages: this.outgoing }), 'utf8')
      await this.refresh()
      return result
    } catch (error) {
      this.status = 'error'; this.emit({ type: 'status', status: 'error' }); throw error
    } finally { this.currentProcess = null }
  }
  resetSession() { throw new Error('当前连接保持在本聊天，请在 Codex 中新建聊天') }
}
module.exports = { DesktopAdapter }
