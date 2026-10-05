const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('miro', {
  windowAction: action => ipcRenderer.invoke('window:action',action),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  listHistory: force => ipcRenderer.invoke('history:list', force),
  readHistory: key => ipcRenderer.invoke('history:read', key),
  archiveHistory: value => ipcRenderer.invoke('history:archive',value),
  boundHistory: () => ipcRenderer.invoke('history:bound'),
  bindHistory: (agentId, key) => ipcRenderer.invoke('history:bind', { agentId, key }),
  loadCanvas: () => ipcRenderer.invoke('canvas:load'),
  saveCanvas: value => ipcRenderer.invoke('canvas:save', value),
  setMini: value => ipcRenderer.invoke('window:set-mini', value),
  getState: () => ipcRenderer.invoke('app:state'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  copyInvitation: () => ipcRenderer.invoke('agents:copy-invitation'),
  disconnectAgent: id => ipcRenderer.invoke('agent:disconnect', id),
  renameAgent: (agentId, name) => ipcRenderer.invoke('agent:rename', { agentId, name }),
  sendMany: (agentIds, text) => ipcRenderer.invoke('agents:send-many', { agentIds, text }),
  sendConversation: value => ipcRenderer.invoke('conversation:send',value),
  sendToAgent: (agentId, text) => ipcRenderer.invoke('agent:send', { agentId, text }),
  newSession: (agentId) => ipcRenderer.invoke('agent:new-session', agentId),
  setAlwaysOnTop: value => ipcRenderer.invoke('window:set-always-on-top', value),
  updateTrayActivity: payload => ipcRenderer.invoke('tray:update-activity', payload),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: value => ipcRenderer.invoke('settings:set', value),
  onSettingsChange: callback => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('settings:change', handler)
    return () => ipcRenderer.removeListener('settings:change', handler)
  },
  onAgentEvent: callback => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  },
  // 需求8：模型与思考强度
  listModels: () => ipcRenderer.invoke('models:list'),
  setModel: payload => ipcRenderer.invoke('models:set', payload),
  registerModels: list => ipcRenderer.invoke('models:register', list)
})
