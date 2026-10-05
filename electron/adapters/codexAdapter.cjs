const { spawnProcess } = require('../vendor/orca.cjs')
const fs = require('node:fs')
const path = require('node:path')
function findCodex() {
  const roots = (process.env.PATH || '').split(path.delimiter)
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm'))
  if (process.env.HOME) roots.push(path.join(process.env.HOME, '.npm-global', 'bin'))
  if (process.env.HOME) roots.push(path.join(process.env.HOME, '.local', 'bin'))
  const isWin = process.platform === 'win32'
  for (const root of roots) {
    // npm 全局安装时真正可执行文件在 vendor 的 bin/ 下（codex doctor 确认的路径），
    // 直接用它可避免 .cmd shim 带来的 cmd.exe 转义与额外进程开销。
    const vendorBin = path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    if (isWin && fs.existsSync(vendorBin)) return vendorBin
    // PATH 上的 shim：npm 只会生成 codex / codex.cmd / codex.ps1，没有 codex.exe
    const candidates = isWin ? ['codex.cmd', 'codex', 'codex.exe', 'codex.ps1'] : ['codex']
    for (const name of candidates) {
      const direct = path.join(root, name)
      if (fs.existsSync(direct)) return direct
    }
    const vendor = path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe')
    if (fs.existsSync(vendor)) return vendor
  }
  throw new Error('未找到 Codex，请先安装并登录命令行版')
}
class CodexAdapter {
  constructor({ emit, getThreadId, setThreadId, getWorkspace }) {
    Object.assign(this, { emit, getThreadId, setThreadId, getWorkspace })
    this.currentProcess = null
    // 需求8：每个会话可选的模型与思考强度
    this.model = null
    this.reasoningEffort = null
  }

  // 需求8：设置该会话使用的模型与思考强度
  setModel({ model, reasoningEffort } = {}) {
    if (model !== undefined) this.model = model ? String(model) : null
    if (reasoningEffort !== undefined) this.reasoningEffort = reasoningEffort ? String(reasoningEffort) : null
    return { model: this.model, reasoningEffort: this.reasoningEffort }
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
    // 需求8：按会话选择的模型与思考强度注入 Codex CLI
    const model = this.model
    const effort = this.reasoningEffort
    // 空值表示「跟随 Codex 自身配置」，此时不注入 --model，
    // 避免把账号不支持的模型名写死进命令。
    const modelArgs = []
    if (model) modelArgs.push('--model', model)
    if (effort) modelArgs.push('-c', `model_reasoning_effort=${effort}`)
    const base = threadId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check']
    const args = threadId
      ? [...base, ...modelArgs, threadId, '-']
      : [...base, ...modelArgs, '-']
    return new Promise((resolve, reject) => {
      let child
      // Orca 的 resolveSpawn 已自动对 .cmd/.bat 走 cmd.exe shim，无需手动 shell。
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
