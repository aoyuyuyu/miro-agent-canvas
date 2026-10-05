const { Tray, Menu, nativeImage, app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

class TrayManager {
  constructor({ mainWindow, state, onSettingsChange = () => {} }) {
    this.mainWindow = mainWindow
    this.state = state
    this.onSettingsChange = onSettingsChange
    this.angle = 0
    this.agentIndex = 0
    this.animTimer = null
    this.activeAgents = []
    this.hasUnread = false

    // 默认配置：提示音默认关闭，发光轮廓默认很弱
    if (!this.state.settings) {
      this.state.settings = {
        sound: false,
        glowIntensity: 'weak' // 'weak' | 'medium' | 'strong' | 'none'
      }
    }
  }

  get settings() {
    return this.state.settings
  }

  init() {
    try {
      const pngPath = path.join(__dirname, '../src/assets/avatars/miro.png')
      this.defaultIcon = fs.existsSync(pngPath)
        ? nativeImage.createFromPath(pngPath).resize({ width: 16, height: 16 })
        : nativeImage.createEmpty()

      let initialIcon = this.createIcon()
      if (initialIcon.isEmpty() && !this.defaultIcon.isEmpty()) {
        initialIcon = this.defaultIcon
      }

      this.tray = new Tray(initialIcon)
      this.tray.setToolTip('Miro 助手中心')
      this.tray.on('click', () => {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return
        if (this.mainWindow.isVisible()) {
          if (this.mainWindow.isMinimized()) this.mainWindow.restore()
          this.mainWindow.focus()
        } else {
          this.mainWindow.show()
          this.mainWindow.focus()
        }
      })
      this.updateMenu()
    } catch (err) {
      console.error('Tray init error:', err)
    }
  }

  updateMenu() {
    const s = this.settings
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示 Miro',
        click: () => {
          if (!this.mainWindow || this.mainWindow.isDestroyed()) return
          this.mainWindow.show()
          this.mainWindow.focus()
        }
      },
      { type: 'separator' },
      {
        label: '提示音',
        type: 'checkbox',
        checked: !!s.sound,
        click: (item) => {
          s.sound = item.checked
          this.onSettingsChange(s)
          this.updateMenu()
        }
      },
      {
        label: '轮廓发光强弱',
        submenu: [
          {
            label: '弱（默认）',
            type: 'radio',
            checked: s.glowIntensity === 'weak',
            click: () => { s.glowIntensity = 'weak'; this.onSettingsChange(s); this.updateMenu(); this.refreshIcon() }
          },
          {
            label: '中',
            type: 'radio',
            checked: s.glowIntensity === 'medium',
            click: () => { s.glowIntensity = 'medium'; this.onSettingsChange(s); this.updateMenu(); this.refreshIcon() }
          },
          {
            label: '强',
            type: 'radio',
            checked: s.glowIntensity === 'strong',
            click: () => { s.glowIntensity = 'strong'; this.onSettingsChange(s); this.updateMenu(); this.refreshIcon() }
          },
          {
            label: '无',
            type: 'radio',
            checked: s.glowIntensity === 'none',
            click: () => { s.glowIntensity = 'none'; this.onSettingsChange(s); this.updateMenu(); this.refreshIcon() }
          }
        ]
      },
      { type: 'separator' },
      {
        label: '退出 Miro',
        click: () => {
          this.isQuitting = true
          app.quit()
        }
      }
    ])
    this.tray.setContextMenu(contextMenu)
  }

  createIconSvg() {
    const s = this.settings
    const working = this.activeAgents.length > 0
    const currentAgent = working ? this.activeAgents[this.agentIndex % this.activeAgents.length] : null

    // 颜色和不透明度根据 glowIntensity
    let opacity = 0.5
    let strokeWidth = 2
    if (s.glowIntensity === 'none') {
      strokeWidth = 0
    } else if (s.glowIntensity === 'weak') {
      opacity = 0.65
      strokeWidth = 2.2
    } else if (s.glowIntensity === 'medium') {
      opacity = 0.85
      strokeWidth = 2.8
    } else if (s.glowIntensity === 'strong') {
      opacity = 1.0
      strokeWidth = 3.4
    }

    const ringStroke = '#f97316' // 橙色轮廓

    let content = ''
    if (working && currentAgent) {
      // 正在回复的 Agent 头像底色
      const label = (currentAgent.label || currentAgent.software || 'A').slice(0, 1).toUpperCase()
      content = `
        <rect x="5" y="5" width="22" height="22" rx="6" fill="#27272a"/>
        <text x="16" y="20" font-family="sans-serif" font-weight="bold" font-size="12" fill="#fafafa" text-anchor="middle">${label}</text>
      `
    } else {
      // 默认 Miro 图标（新 logo：白底黑色流线 M 徽标）
      content = `
        <rect x="4" y="4" width="24" height="24" rx="6" fill="#ffffff" stroke="#e4e4e7" stroke-width="1"/>
        <path d="M7 25 C8 17 10 11 12 11 C13.5 11 14.5 18 16 18 C17.5 18 18.5 11 20 11 C22 11 24 22 26 18" fill="none" stroke="#18181b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      `
    }

    // 轮廓转圈
    let ring = ''
    if (working && strokeWidth > 0) {
      ring = `
        <circle cx="16" cy="16" r="14" fill="none" stroke="${ringStroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="24 16" opacity="${opacity}" transform="rotate(${this.angle} 16 16)"/>
      `
    }

    // 绿点（未读状态）
    let unreadDot = ''
    if (this.hasUnread) {
      unreadDot = `<circle cx="27" cy="5" r="3.5" fill="#22c55e" stroke="#ffffff" stroke-width="1"/>`
    }

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        ${ring}
        ${content}
        ${unreadDot}
      </svg>
    `.trim()

    try {
      const img = nativeImage.createFromDataURL('data:image/svg+xml;utf8,' + encodeURIComponent(svg))
      if (!img.isEmpty()) return img
    } catch {}
    return this.defaultIcon || nativeImage.createEmpty()
  }

  createIcon() {
    try {
      const icon = this.createIconSvg()
      if (icon && !icon.isEmpty()) return icon
    } catch {}
    return this.defaultIcon || nativeImage.createEmpty()
  }

  refreshIcon() {
    if (!this.tray || this.tray.isDestroyed()) return
    try {
      const icon = this.createIcon()
      if (!icon.isEmpty()) this.tray.setImage(icon)
    } catch (e) {
      console.error('Tray refreshIcon error:', e)
    }
  }

  updateActivity({ activeAgents = [], hasUnread = false }) {
    this.activeAgents = activeAgents
    this.hasUnread = hasUnread

    if (this.activeAgents.length > 0) {
      if (!this.animTimer) {
        let frameCount = 0
        this.animTimer = setInterval(() => {
          this.angle = (this.angle + 20) % 360
          frameCount++
          // 多 Agent 在回复时，每隔约 1.5 秒切换头像
          if (frameCount % 6 === 0) {
            this.agentIndex = (this.agentIndex + 1) % this.activeAgents.length
          }
          this.refreshIcon()
        }, 250)
      }
    } else {
      if (this.animTimer) {
        clearInterval(this.animTimer)
        this.animTimer = null
        this.angle = 0
        this.agentIndex = 0
      }
      this.refreshIcon()
    }
  }

  destroy() {
    if (this.animTimer) clearInterval(this.animTimer)
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy()
  }
}

module.exports = { TrayManager }
