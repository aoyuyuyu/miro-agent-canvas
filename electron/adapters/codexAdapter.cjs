const { spawnProcess } = require('../vendor/orca.cjs')
const fs = require('node:fs')
const path = require('node:path')
function findCodex() {
  const roots = (process.env.PATH || '').split(path.delimiter)
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm'))
  for (const root of roots) {
    const direct = path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex')
    if (fs.existsSync(direct)) return direct
    const vendor = path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe')
    if (fs.existsSync(vendor)) return vendor
  }
  throw new Error('未找到 Codex，请先安装并登录命令行版')
}
class CodexAdapter {
  constructor({ emit, getThreadId, setThreadId, getWorkspace }) {
    Object.assign(this, { emit, getThreadId, setThreadId, getWorkspace })
    this.currentProcess = null
  }
  async detect() {
    if (process.env.MIRO_MOCK === '1') return { connected: true, version: '模拟模式' }
    try {
      return await new Promise(resolve => {
        const child = spawnProcess({program:findCodex(), args:['--version']})
        let output = ''
        const timer = setTimeout(() => { child.kill(); resolve({ connected: false, version: null }) }, 10000)
        child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
        child.on('error', () => { clearTimeout(timer); resolve({ connected: false, version: null }) })
        child.on('close', code => { clearTimeout(timer); resolve({ connected: code === 0, version: output.trim() }) })
      })
    } catch { return { connected: false, version: null } }
  }
  async send({ text }) {
    if (!text?.trim()) throw new Error('消息不能为空')
    if (this.currentProcess) throw new Error('助手正在工作，请等待当前回复完成')
    const mock = process.env.MIRO_MOCK === '1'
    const command = mock ? null : findCodex()
    this.currentProcess = { pending: true }
    this.emit({ type: 'status', status: 'working' })
    this.emit({ type: 'user_message', text })
    if (mock) {
      try {
        if (!this.getThreadId()) { this.setThreadId('mock-' + Date.now()); this.emit({ type: 'session', threadId: this.getThreadId() }) }
        await new Promise(resolve => setTimeout(resolve, 600))
        const answer = `模拟回复：${text}`
        this.emit({ type: 'assistant_message', text: answer }); this.emit({ type: 'status', status: 'done' })
        return { ok: true, text: answer }
      } finally { this.currentProcess = null }
    }
    const threadId = this.getThreadId()
    const args = threadId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', threadId, '-']
      : ['exec', '--json', '--skip-git-repo-check', '-']
    return new Promise((resolve, reject) => {
      let child
      try { child = spawnProcess({program:command, args, cwd:this.getWorkspace(), env:process.env}) }
      catch { this.currentProcess = null; reject(new Error('无法启动助手，请检查安装和工作目录')); return }
      this.currentProcess = child
      let buffer = '', lastAssistantText = '', failed = false, settled = false
      const fail = () => {
        if (settled) return
        settled = true; this.currentProcess = null
        const message = '助手执行失败，请检查登录、网络与工作目录后重试。'
        this.emit({ type: 'error', message }); this.emit({ type: 'status', status: 'error' }); reject(new Error(message))
      }
      const consume = line => {
        let event
        try { event = JSON.parse(line) } catch { return }
        if (event.type === 'thread.started' && event.thread_id) { this.setThreadId(event.thread_id); this.emit({ type: 'session', threadId: event.thread_id }) }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          lastAssistantText = event.item.text; this.emit({ type: 'assistant_message', text: lastAssistantText })
        }
        if (event.type === 'turn.failed' || event.type === 'error') failed = true
      }
      child.stdout.setEncoding('utf8').on('data', chunk => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''
        lines.forEach(consume)
      })
      child.stderr.setEncoding('utf8').on('data', chunk => console.error('Codex 诊断：', chunk))
      child.on('error', fail)
      child.stdin.on('error', () => { failed = true })
      child.on('close', code => {
        if (buffer.trim()) consume(buffer)
        if (code !== 0 || failed || !lastAssistantText) { fail(); return }
        if (settled) return
        settled = true; this.currentProcess = null
        this.emit({ type: 'status', status: 'done' }); resolve({ ok: true, text: lastAssistantText, threadId: this.getThreadId() })
      })
      child.stdin.end(text, 'utf8')
    })
  }
  resetSession() {
    if (this.currentProcess) throw new Error('请等待当前回复完成')
    this.setThreadId(null); this.emit({ type: 'session', threadId: null }); this.emit({ type: 'status', status: 'idle' })
  }
}
module.exports = { CodexAdapter }
