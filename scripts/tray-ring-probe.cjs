// 单独检查：antigravity 态下旋转环是否被头像遮挡（真实缺陷 or仅分类问题）
const { nativeImage, app } = require('electron')
const path = require('node:path')
const raster = require('../electron/trayRaster.cjs')
const { GLOW, PLATE, RING, AVATAR, DOT, PLATE_COLORS } = require('../electron/trayGeometry.cjs')

app.whenReady().then(() => {
  const render = ({ glow, agent, angle, order = 'ring-first' }) => {
    const canvas = raster.createCanvas()
    const k = raster.SS, S = raster.SIZE * k, L = (v) => v * k
    const ring = () => {
      if (glow.width > 0) raster.strokeArc(canvas, { cx: S / 2, cy: S / 2, radius: L(RING.radius), width: L(glow.width), color: RING.color, startDeg: -angle, sweepDeg: RING.sweepDeg, alpha: glow.alpha })
    }
    const plate = () => raster.fillRoundedRect(canvas, {
      x: L(PLATE.inset), y: L(PLATE.inset), w: S - L(PLATE.inset * 2), h: S - L(PLATE.inset * 2),
      r: L(PLATE.radius), fill: PLATE_COLORS.agent, stroke: null, strokeWidth: 0.9,
    })
    if (order === 'ring-first') { ring(); plate() } else { plate(); ring() }
    if (agent) {
      const bmp = raster.readPngBitmap(path.join(__dirname, '../src/assets/avatars', `${agent}.png`), 22)
      if (bmp) raster.drawBaseBitmap(canvas, bmp, { x: L(AVATAR.inset), y: L(AVATAR.inset), size: S - L(AVATAR.inset * 2), cornerRadius: L(AVATAR.radius) })
    }
    return nativeImage.createFromBitmap(raster.resolve(canvas), { width: raster.SIZE, height: raster.SIZE })
  }

  // 环的预期位置（角度 45 度，弧长 140度，起始 -45）
  const angle = 45
  const startRad = (-angle * Math.PI) / 180
  const pts = []
  for (let t = 0; t <= RING.sweepDeg; t += 5) {
    const a = startRad + (t * Math.PI) / 180
    pts.push([+(16 + RING.radius * Math.cos(a)).toFixed(1), +(16 + RING.radius * Math.sin(a)).toFixed(1)])
  }
  console.log('ring expected arc sample points:', JSON.stringify(pts))

  for (const agent of ['antigravity', 'codex', 'orca', null]) {
    for (const order of ['ring-first', 'plate-first']) {
      const img = render({ glow: GLOW.weak, agent, angle, order })
      const bmp = img.toBitmap()
      // 在预期环弧上采样，看是否呈橙色
      const hits = pts.filter(([fx, fy]) => {
        const x = Math.round(fx), y = Math.round(fy)
        if (x < 0 || y < 0 || x >= 32 || y >= 32) return false
        const i = (y * 32 + x) * 4
        const a = bmp[i + 3]
        if (a < 24) return false
        const r = bmp[i] * 255 / a, g = bmp[i + 1] * 255 / a, b = bmp[i + 2] * 255 / a
        return r > 170 && g > 55 && g < 180 && b < 110
      })
      console.log(`${String(agent).padEnd(12)} ${order.padEnd(11)} ringHits=${hits.length}/${pts.length}`)
    }
  }
  app.exit(0)
})