const { app, BrowserWindow, ipcMain, Menu, dialog, clipboard } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { CodexAdapter } = require('./adapters/codexAdapter.cjs')
const { DesktopAdapter } = require('./adapters/desktopAdapter.cjs')
const { AgentBridge } = require('./agentBridge.cjs')
const { dispatchMany, validateText } = require('./relay.cjs')
const { HistoryStore } = require('./history.cjs')
const { SharedHistory } = require('./sharedHistory.cjs')
const { OrcaRuntime } = require('./orcaRuntime.cjs')
const { NowledgeHistory } = require('./nowledgeHistory.cjs')
const { NativeSessions } = require('./nativeSessions.cjs')
const { TrayManager } = require('./trayManager.cjs')
app.setName('Miro')
if (process.env.MIRO_MOCK === '1') app.setPath('userData', process.env.MIRO_PREVIEW_DATA || path.join(app.getPath('appData'), 'Miro-preview'))
if (!app.requestSingleInstanceLock()) { app.quit(); return }
let mainWindow, codex, bridge, history, sharedHistory, fullBounds,orca,nowledge,nativeSessions,externalTimer,trayManager
function revealWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.moveTop()
}
app.on('second-instance', revealWindow)
const defaults = () => ({ sessions: { codex: null }, messages: [], alwaysOnTop: true, workspace: path.join(app.getPath('documents'), 'Miro'), settings: { sound: false, glowIntensity: 'weak' }, modelChoices: [] })
let state
function statePath() { return path.join(app.getPath('userData'), 'relay-session-state.json') }
function loadState() {
  state = defaults()
  try {
    const saved = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    state = { ...state, ...saved, sessions: { codex: saved.sessions?.codex || null }, messages: Array.isArray(saved.messages) ? saved.messages : [], settings: saved.settings || { sound: false, glowIntensity: 'weak' }, modelChoices: Array.isArray(saved.modelChoices) ? saved.modelChoices : [] }
  } catch {}
  fs.mkdirSync(state.workspace, { recursive: true })
}
function saveState() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(statePath() + '.tmp', JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(statePath() + '.tmp', statePath())
}
function emitAgentEvent(event) {
  if (event.type === 'user_message' || event.type === 'assistant_message') {
    state.messages.push({ role: event.type === 'user_message' ? 'user' : 'assistant', text: event.text })
    saveState()
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:event', { agentId: 'codex', ...event })
}
function menu() {
  Menu.setApplicationMenu(null)
}
async function createWindow() {
  const appIcon = path.join(__dirname, '../src/assets/avatars/miro.png')
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 800, minHeight: 560, title: 'Miro', frame:false, backgroundColor: '#f5f5f5', alwaysOnTop: state.alwaysOnTop, icon: appIcon,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('preload-error', (_event, _file, error) => console.error('预加载失败：', error))
  mainWindow.on('close', (event) => {
    if (!trayManager?.isQuitting) {
      if (!codex?.desktop && codex?.currentProcess) {
        event.preventDefault()
        mainWindow.webContents.send('agent:event', { type: 'close_blocked' })
        return
      }
      event.preventDefault()
      mainWindow.hide()
      return
    }
  })
  try {
    const devUrl = process.env.MIRO_DEV_URL
    if (devUrl) {
      const url = new URL(devUrl)
      if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('开发页面必须使用本机地址')
      await mainWindow.loadURL(devUrl)
    } else await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
    mainWindow.center()
    revealWindow()
  } catch (error) {
    dialog.showErrorBox('Miro 启动失败', '无法加载界面。请使用一键启动重新构建。\n' + error.message)
    app.quit()
  }
}
app.whenReady().then(async () => {
  loadState()
  history = new HistoryStore({ directory: path.join(app.getPath('userData'), 'history'), home: process.env.MIRO_HISTORY_HOME || process.env.USERPROFILE, local: process.env.MIRO_HISTORY_LOCAL || process.env.LOCALAPPDATA, mock: process.env.MIRO_MOCK === '1' && !process.env.MIRO_HISTORY_HOME })
  codex = new CodexAdapter({ emit: emitAgentEvent, getThreadId: () => state.sessions.codex, getWorkspace: () => state.workspace,
    setThreadId: (id) => { state.sessions.codex = id || null; saveState() } })
  try {
    const connection = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'desktop-connection.json'), 'utf8'))
    if (connection.pipePath && connection.threadId && process.env.MIRO_MOCK !== '1') {
      codex = new DesktopAdapter({ connection, emit: emitAgentEvent, outgoingPath: path.join(app.getPath('userData'), 'desktop-outgoing.json'), readNative: id => history.codexMessages(id) })
      codex.start()
    }
  } catch {}
  bridge = new AgentBridge({ directory: path.join(app.getPath('userData'), 'connections'), emit: event => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:event', event)
  } })
  orca=new OrcaRuntime()
  nowledge=new NowledgeHistory({directory:path.join(app.getPath('userData'),'history')})
  nativeSessions=new NativeSessions({directory:app.getPath('userData'),codex,orca,bridge,history,memory:nowledge,workspace:()=>state.workspace,mock:process.env.MIRO_MOCK==='1',emit:event=>mainWindow?.webContents.send('agent:event',event)})
  const external=process.env.MIRO_MOCK==='1'?[]:[orca,nowledge]
  sharedHistory = new SharedHistory({directory:path.join(app.getPath('userData'),'history'), native:history, external, live:() => [
    {key:codex.desktop?'codex:'+codex.connection.threadId:'miro:codex',agentId:'codex',provider:'codex',label:'Codex',id:codex.desktop?codex.connection.threadId:'codex',title:codex.title || (codex.desktop?codex.messages:state.messages).find(m=>m.role==='user')?.text.slice(0,150) || '',updatedAt:new Date().toISOString(),messages:codex.desktop ? codex.messages : state.messages},
    ...bridge.agents.filter(a=>!a.revoked).map(a=>({key:'miro:'+a.id,agentId:a.id,avatar:a.avatar,provider:a.software || a.label.toLowerCase(),label:a.label,id:a.id,title:a.messages.find(m=>m.role==='user')?.text.slice(0,150) || '',updatedAt:new Date(a.lastSeen || 0).toISOString(),messages:a.messages})),...nativeSessions.records()
  ]})
  bridge.sharedHistory = sharedHistory
  bridge.memory=nowledge
  await bridge.start()
  menu()
  await createWindow()
  trayManager = new TrayManager({ mainWindow, state, onSettingsChange: (s) => { saveState(); mainWindow?.webContents.send('settings:change', s) } })
  trayManager.init()
  if(external.length){Promise.all([orca.refresh(),nowledge.refresh()]).then(()=>{nowledge.start();mainWindow?.webContents.send('agent:event',{type:'history_ready'})});externalTimer=setInterval(()=>Promise.all([orca.refresh(),nowledge.refresh()]),30000);externalTimer.unref()}
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
}).catch(error => { dialog.showErrorBox('Miro 启动失败', error.message); app.quit() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { trayManager?.destroy(); clearInterval(externalTimer);nowledge?.stop();codex?.stop?.(); bridge?.stop?.() })
async function listAgents(){
  const agents=[{id:'codex',label:'Codex',software:'codex',currentTitle:codex.title,...(await codex.detect()),threadId:codex.desktop?codex.connection.threadId:state.sessions.codex},...bridge.list()]
  const discovered=[...new Set(sharedHistory.list().sessions.map(s=>s.provider))]
  for(const provider of discovered)if(provider!=='miro'&&!agents.some(a=>String(a.software||a.label).toLowerCase()===provider))agents.push({id:'native:'+provider,label:provider,software:provider,external:true,native:true,connected:nativeSessions.canLaunch(provider),status:'idle'})
  return agents
}
ipcMain.handle('agents:list', listAgents)
// 需求8：可用模型与思考强度。
// 不硬编码模型清单：ChatGPT 账号授权的模型随时间变化，写死会立刻失效。
// 默认不传--model，沿用 Codex 自身配置；用户显式选择时才注入。
const EFFORT_CHOICES = [
  { id: '', label: '默认' },
  { id: 'minimal', label: '最低' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
]
ipcMain.handle('models:list', () => ({
  models: [{ id: '', label: '默认（跟随 Codex 配置）' }, ...(state.modelChoices || [])],
  efforts: EFFORT_CHOICES
}))
ipcMain.handle('models:register', (_event, list) => {
  state.modelChoices = Array.isArray(list)
    ? list.filter(m => m && m.id).map(m => ({ id: String(m.id), label: String(m.label || m.id) }))
    : []
  saveState()
  return state.modelChoices
})
ipcMain.handle('models:set', (_event, payload = {}) => {
  const result = codex?.setModel?.(payload) || { model: null, reasoningEffort: null }
  saveState()
  return result
})

ipcMain.handle('settings:get', () => state.settings || { sound: false, glowIntensity: 'weak' })
ipcMain.handle('settings:set', (_event, value) => {
  state.settings = { ...(state.settings || { sound: false, glowIntensity: 'weak' }), ...(value || {}) }
  saveState()
  trayManager.updateMenu()
  trayManager.refreshIcon()
  mainWindow?.webContents.send('settings:change', state.settings)
  return { ok: true, settings: state.settings }
})
ipcMain.handle('tray:update-activity', (_event, payload) => {
  trayManager.updateActivity(payload || {})
  return { ok: true }
})
ipcMain.handle('app:state', async () => {
  if (codex.desktop) await codex.refresh()
  nativeSessions.refresh()
  return { messages: codex.desktop ? codex.messages : state.messages, historySource: codex.historySource || 'miro', mini: !!state.mini, alwaysOnTop: state.alwaysOnTop, workspace: codex.desktop ? codex.workspace : state.workspace, status: codex.desktop ? codex.status : codex.currentProcess ? 'working' : 'idle', agentStates: {...bridge.states(),...nativeSessions.states()} }
})
ipcMain.handle('conversation:send', async (_event,payload)=>{const agent=(await listAgents()).find(a=>a.id===payload?.agentId);if(!agent)throw Error('找不到接收助手');validateText(payload.text);return nativeSessions.send({...payload,provider:agent.software||agent.label})})
ipcMain.handle('history:list', (_event, force) => sharedHistory.list(!!force))
ipcMain.handle('history:read', (_event, key) => sharedHistory.read(key))
ipcMain.handle('history:archive', (_event, data) => {
  if(!['codex','me'].includes(data.agentId) && !data.agentId?.startsWith('native:') && !bridge.list().some(a=>a.id===data.agentId))throw new Error('无效助手')
  return sharedHistory.archive(data.agentId,data,bridge.list().find(a=>a.id===data.agentId))
})
ipcMain.handle('window:action', (_event, action) => { if(action === 'minimize') mainWindow.minimize(); if(action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); if(action === 'fullscreen') mainWindow.setFullScreen(!mainWindow.isFullScreen()); if(action === 'close') mainWindow.close() })
ipcMain.handle('history:bound', () => history.bound())
ipcMain.handle('history:bind', (_event, { agentId, key }) => {
  if (agentId === 'codex' && codex.desktop) throw new Error('本聊天已自动绑定当前 Codex 原生记录')
  if (agentId !== 'codex' && !bridge.list().some(a => a.id === agentId)) throw new Error('此 Agent 不在当前连接列表中')
  return history.bind(agentId, key)
})
const canvasFile = () => path.join(app.getPath('userData'), 'canvas.json')
ipcMain.handle('canvas:load', () => { try { return JSON.parse(fs.readFileSync(canvasFile(), 'utf8')) } catch { return null } })
ipcMain.handle('canvas:save', (_event, value) => {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 1000 || value.edges.length > 2000) throw new Error('画布内容无效或过大')
  const nodes = value.nodes.map(n => {
    if (typeof n.id !== 'string' || !['agent', 'prompt', 'draft', 'history'].includes(n.type) || !Number.isFinite(n.position?.x) || !Number.isFinite(n.position?.y)) throw new Error('画布节点无效')
    const strings=value=>Array.isArray(value)?value.filter(v=>typeof v==='string'&&v.length<200).slice(0,1000):[]
    const messages=Array.isArray(n.messages)?n.messages.map(m=>{if(!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>20000)throw new Error('画布消息无效');return {role:m.role,text:m.text}}).slice(-50000):[]
    const deliveries=Object.fromEntries(Object.entries(n.deliveries||{}).filter(([key,count])=>key.length<200&&Number.isSafeInteger(count)&&count>=0))
    return { id: n.id, type: n.type, position: n.position, sessionKey:typeof n.sessionKey==='string'?n.sessionKey.slice(0,200):undefined, groupKey:typeof n.groupKey==='string'?n.groupKey:undefined, title:typeof n.title==='string'?n.title.slice(0,500):undefined, recipients:strings(n.recipients), requestIds:strings(n.requestIds), requestTexts:Array.isArray(n.requestTexts)?n.requestTexts.filter(t=>typeof t==='string'&&t.length<=20000).slice(-1000):[], deliveries, messages, parentPromptId:typeof n.parentPromptId==='string'?n.parentPromptId:undefined, agentId:typeof n.agentId === 'string' ? n.agentId : undefined, messageOffset:Number.isSafeInteger(n.messageOffset) && n.messageOffset >= 0 ? n.messageOffset : 0, historyKey: typeof n.historyKey === 'string' ? n.historyKey : undefined, width: Number.isFinite(n.width) && n.width >= 200 && n.width <= 2000 ? n.width : undefined, height: Number.isFinite(n.height) && n.height >= 150 && n.height <= 3000 ? n.height : undefined }
  })
  const edges = value.edges.map(e => {
    if ([e.id, e.source, e.target, e.sourceHandle, e.targetHandle].some(v => typeof v !== 'string')) throw new Error('画布连线无效')
    return { id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle }
  })
  const viewport = value.viewport
  if (viewport && (![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom < 0.1 || viewport.zoom > 4)) throw new Error('画布缩放无效')
  const encoded=JSON.stringify({version:8,nodes, edges, viewport})
  if(Buffer.byteLength(encoded)>20*1024*1024)throw new Error('画布内容超过二十兆字节')
  fs.writeFileSync(canvasFile() + '.tmp', encoded, 'utf8'); fs.renameSync(canvasFile() + '.tmp', canvasFile())
  return { ok: true }
})
ipcMain.handle('window:set-mini', (_event, value) => {
  state.mini = !!value
  if (state.mini) { fullBounds = mainWindow.getBounds(); mainWindow.setMinimumSize(260,120); mainWindow.setSize(400,180) }
  else { mainWindow.setMinimumSize(800,560); if (fullBounds) mainWindow.setBounds(fullBounds); else mainWindow.setSize(1220,800) }
  saveState(); return { ok: true }
})
ipcMain.handle('workspace:choose', async () => {
  if (codex.desktop) throw new Error('工作目录由当前聊天决定')
  if (codex.currentProcess) throw new Error('请等待当前回复完成')
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择助手工作目录', buttonLabel: '选择此文件夹', properties: ['openDirectory', 'createDirectory'], defaultPath: state.workspace })
  if (!result.canceled) { state.workspace = result.filePaths[0]; state.messages = []; codex.resetSession(); saveState(); emitAgentEvent({ type: 'history', messages: [] }) }
  return state.workspace
})
ipcMain.handle('agent:send', (_event, payload) => {
  if (!payload?.agentId || typeof payload.text !== 'string') throw new Error('无效的助手消息')
  validateText(payload.text)
  return listAgents().then(agents=>{const agent=agents.find(a=>a.id===payload.agentId);if(!agent)throw Error('找不到接收助手');return nativeSessions.send({agentId:agent.id,provider:agent.software||agent.label,conversationId:'legacy:'+require('node:crypto').randomUUID(),text:payload.text})})
})
ipcMain.handle('agents:send-many', (_event, payload) => dispatchMany(payload || {}, {
  list: listAgents,
  send: async (id, text) => {const agent=(await listAgents()).find(a=>a.id===id);return nativeSessions.send({agentId:id,provider:agent.software||agent.label,conversationId:'legacy:'+require('node:crypto').randomUUID(),text})}
}))
ipcMain.handle('agent:rename', (_event, payload) => bridge.rename(payload?.agentId, payload?.name))
ipcMain.handle('agent:disconnect', (_event, id) => bridge.disconnect(id))
ipcMain.handle('agents:copy-invitation', async () => {
  const invite = bridge.invitation()
  const helper = path.join(__dirname, 'miro-agent.ps1')
  const session = '注册返回的 sessionFile 绝对路径'
  const quote = value => '"' + value + '"'
  const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quote(helper)}`
  const prompt = `请把你当前这个 Agent 接入我电脑上运行的 Miro，并进入持续接收模式。你需要有本机终端/执行权限；没有该权限请直接说明，不要声称已连接。\n\n1. 使用当前软件的名称（如 WorkBuddy 或 Antigravity），不要使用模型名称。替换下面的“你的Agent名称”，运行一次注册。提示词有效期为一小时：\n${command} -Action register -InviteFile ${quote(invite.file)} -Name "你的Agent名称"\n\n2. 注册结果会返回 sessionFile。把后续命令中的占位路径换成它，然后立即接收消息：\n${command} -Action receive -SessionFile ${quote(session)} -WaitSeconds 30\n\n3. 返回 JSON 的 message 为 null 表示暂时无消息，继续接收；不要因此结束接入会话。message 非空时，按 text 处理用户请求；把你的真实回复写入工作目录中的 UTF-8 文本文件，再回传。把下面占位符换成收到的 message.id 和回复文件绝对路径：\n${command} -Action reply -SessionFile ${quote(session)} -MessageId "收到的消息编号" -ReplyFile "回复文件绝对路径"\n\n4. 每次回传后继续接收。任务较长时，每四十五秒运行一次心跳；心跳也会延长当前消息的处理时间：\n${command} -Action heartbeat -SessionFile ${quote(session)} -MessageId "当前消息编号"\n\n5. 用户让你停止时断开：\n${command} -Action disconnect -SessionFile ${quote(session)}\n\n每次注册都会生成你独立的连接文件，请保存注册返回的路径，后续无需重复注册。终端工具等待上限至少设为四十秒。临时停止工具执行超过七十五秒，Miro 会显示离线；恢复 receive 即可恢复在线。不要把令牌、会话文件或提示词上传到外部服务，用户已授权已接入的 Agent 读取 Miro 中其他 Agent 的可见历史。接入后先调用 history-list，再使用 history-read -HistoryKey 读取需要的正文；不要把历史或连接令牌上传到其他服务。这里是本机消息传递通道，不是新模型：请由你自己处理并回传回复。先注册并进入接收模式，不需要让我手工安装依赖。\n\n本机共同记忆（Nowledge Mem）：\n${command} -Action memory-read -SessionFile ${quote(session)}\n请在接入后和新任务开始前读取共同记忆。历史正文与共同记忆均只在本机同步；原软件已有记忆的导入由 nmem 执行，不能把消息通道冒称记忆系统。\n\n共享历史命令：\n${command} -Action history-list -SessionFile ${quote(session)}\n${command} -Action history-read -SessionFile ${quote(session)} -HistoryKey "目录返回的 key" -Offset 0\n目录每页 200 项，正文每页 100 条，用 nextOffset 翻页。\n\n将你自己的原生历史导出为 UTF-8 JSON：{sessionId,title,offset:0,messages:[{role:"user",text:"可见正文"},{role:"assistant",text:"可见回复"}]}，每批最多 200 条。随后发布：\n${command} -Action history-publish -SessionFile ${quote(session)} -HistoryFile "历史 JSON 绝对路径"\n后续批次 offset 接上已发布条数；只发布可见聊天正文，排除思考过程、凭据与工具输出。每个原生会话使用稳定 sessionId，有新回复时同步。已支持的本机记录由 Miro 自动读取，其他软件由你导出完整可见历史；无法导出要明确说明，不能把 Miro 收发记录称为完整原生记录。\n如果有自己的头像 PNG，可在注册时加 -AvatarFile "头像绝对路径"。`
  await clipboard.writeText(prompt)
  return { ok: true, expiresAt: invite.expires }
})
ipcMain.handle('agent:new-session', (_event, agentId) => {
  if (agentId !== 'codex') throw new Error('未知助手')
  if (codex.currentProcess) throw new Error('请等待当前回复完成')
  state.messages = []; codex.resetSession(); saveState(); emitAgentEvent({ type: 'history', messages: [] }); return { ok: true }
})
ipcMain.handle('window:set-always-on-top', (_event, value) => {
  state.alwaysOnTop = Boolean(value); mainWindow?.setAlwaysOnTop(state.alwaysOnTop); saveState(); return { ok: true }
})


