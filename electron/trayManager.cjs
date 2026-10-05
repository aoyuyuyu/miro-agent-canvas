const { Tray, Menu, nativeImage, app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const raster = require('./trayRaster.cjs')

const { GLOW, PLATE, RING, AVATAR, DOT, PLATE_COLORS } = require('./trayGeometry.cjs')

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
    this.frameCache = new Map()
    this.agentBitmaps = new Map()

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
        ? nativeImage.createFromPath(pngPath).resize({ width: 32, height: 32, quality: 'best' })
        : nativeImage.createEmpty()

      const initialIcon = this.createIcon()
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

  // Agent 头像底图（按 software/id 归一化后缓存，避免每帧重复解码 PNG）
  agentBitmap(agent) {
    if (!agent) return null
    const raw = String(agent.software || agent.label || agent.id || '').trim().toLowerCase()
    const key = raw || 'unknown'
    if (this.agentBitmaps.has(key)) return this.agentBitmaps.get(key)
    const names = [key, key.replace(/[^a-z0-9]/g, '')]
    const aliases = { workbuddy: ['codebuddy', 'orca'], doubao: ['doubao'], hermes: ['hermes'], codex: ['codex'], antigravity: ['antigravity'] }
    names.push(...(aliases[key] || []))
    let bmp = null
    for (const name of names) {
      if (!name) continue
      bmp = raster.readPngBitmap(path.join(__dirname, '../src/assets/avatars', `${name}.png`), 22)
      if (bmp) break
    }
    this.agentBitmaps.set(key, bmp)
    return bmp
  }

  // 光栅化一帧托盘图标：旋转橙环 + 中心头像（或 Miro m 徽标）+ 未读绿点
  renderFrame({ angle, glow, agent, hasUnread }) {
    const canvas = raster.createCanvas()
    const k = raster.SS                     // 每逻辑像素的超采样数
    const S = raster.SIZE * k
    const L = (v) => v * k                  // 逻辑像素 -> 超采样坐标

    // 中心底板
    raster.fillRoundedRect(canvas, {
      x: L(PLATE.inset), y: L(PLATE.inset),
      w: S - L(PLATE.inset * 2), h: S - L(PLATE.inset * 2),
      r: L(PLATE.radius),
      fill: agent ? PLATE_COLORS.agent : PLATE_COLORS.idle,
      stroke: agent ? null : PLATE_COLORS.idleStroke,
      strokeWidth: 0.9,
    })

    const bmp = agent ? this.agentBitmap(agent) : null
    if (bmp) {
      raster.drawBaseBitmap(canvas, bmp, {
        x: L(AVATAR.inset), y: L(AVATAR.inset),
        size: S - L(AVATAR.inset * 2), cornerRadius: L(AVATAR.radius),
      })
    } else {
      raster.drawMiroGlyph(canvas, { x: L(PLATE.inset), y: L(PLATE.inset), size: S - L(PLATE.inset * 2) })
    }

    // 旋转轮廓必须最后绘制：画在底板与头像之上，否则会被头像整块盖住
    // （orca 等深色头像会把弧线遮成 0 像素，轮廓就等于消失了）。
    if (glow.width > 0) {
      raster.strokeArc(canvas, {
        cx: S / 2, cy: S / 2,
        radius: L(RING.radius), width: L(glow.width),
        color: RING.color, startDeg: -angle, sweepDeg: RING.sweepDeg, alpha: glow.alpha,
      })
    }

    // 未读绿点（最上层）
    if (hasUnread) {
      raster.fillCircle(canvas, { cx: L(DOT.cx), cy: L(DOT.cy), radius: L(DOT.radius), color: DOT.color })
    }

    return nativeImage.createFromBitmap(raster.resolve(canvas), { width: raster.SIZE, height: raster.SIZE })
  }

  createIcon() {
    const glow = GLOW[this.settings?.glowIntensity] || GLOW.weak
    const working = this.activeAgents.length > 0
    const agent = working ? this.activeAgents[this.agentIndex % this.activeAgents.length] : null
    // 静止帧缓存；动画帧按 20 度步进，共 18 帧循环
    const step = Math.round(this.angle / 20) % 18
    const key = `${glow.width}|${agent ? (agent.software || agent.label || agent.id) : '-'}|${this.hasUnread ? 1 : 0}|${working ? step : 'idle'}`
    if (this.frameCache.has(key)) return this.frameCache.get(key)
    let image
    try {
      image = this.renderFrame({ angle: step * 20, glow, agent, hasUnread: this.hasUnread })
    } catch (err) {
      console.error('Tray raster error:', err)
      image = nativeImage.createEmpty()
    }
    if (image.isEmpty() && this.defaultIcon) image = this.defaultIcon
    this.frameCache.set(key, image)
    return image
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
