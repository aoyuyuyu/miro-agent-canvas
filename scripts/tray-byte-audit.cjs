// 终审：完全绕开 PNG。只看 nativeImage.toBitmap() 的原始字节（无编解码、无我的解码器）
const { nativeImage, app } = require('electron')
const path = require('node:path')
const raster = require('../electron/trayRaster.cjs')
const { GLOW, PLATE, RING, AVATAR, DOT, PLATE_COLORS } = require('../electron/trayGeometry.cjs')

// 目标色 -> 判定函数（在 toBitmap 的 RGBA 语义下比较）
const ORANGE = [249, 115, 22]
const GREEN = [34, 197, 94]

const dist = (r, g, b, t) => Math.hypot(r - t[0], g - t[1], b - t[2])
const unpre = (v, a) => (a <= 0 ? 0 : Math.min(255, (v / a) * 255))

app.whenReady().then(() => {
  const k = raster.SS, S = raster.SIZE * k, L = (v) => v * k
  const render = ({ glow, agent, hasUnread, angle }) => {
    const canvas = raster.createCanvas()
    raster.fillRoundedRect(canvas, {
      x: L(PLATE.inset), y: L(PLATE.inset), w: S - L(PLATE.inset * 2), h: S - L(PLATE.inset * 2),
      r: L(PLATE.radius), fill: agent ? PLATE_COLORS.agent : PLATE_COLORS.idle,
      stroke: agent ? null : PLATE_COLORS.idleStroke, strokeWidth: 0.9,
    })
    if (agent) {
      const bmp = raster.readPngBitmap(path.join(__dirname, '../src/assets/avatars', `${agent}.png`), 22)
      if (bmp) raster.drawBaseBitmap(canvas, bmp, { x: L(AVATAR.inset), y: L(AVATAR.inset), size: S - L(AVATAR.inset * 2), cornerRadius: L(AVATAR.radius) })
    } else {
      raster.drawMiroGlyph(canvas, { x: L(PLATE.inset), y: L(PLATE.inset), size: S - L(PLATE.inset * 2) })
    }
    if (glow.width > 0) raster.strokeArc(canvas, { cx: S / 2, cy: S / 2, radius: L(RING.radius), width: L(glow.width), color: RING.color, startDeg: -angle, sweepDeg: RING.sweepDeg, alpha: glow.alpha })
    if (hasUnread) raster.fillCircle(canvas, { cx: L(DOT.cx), cy: L(DOT.cy), radius: L(DOT.radius), color: DOT.color })
    return nativeImage.createFromBitmap(raster.resolve(canvas), { width: raster.SIZE, height: raster.SIZE }).toBitmap()
  }

  const measure = (bmp) => {
    let orange = 0, blue = 0, green = 0, white = 0, dark = 0
    for (let i = 0; i < raster.SIZE * raster.SIZE; i++) {
      const a = bmp[i * 4 + 3]
      if (a < 30) continue
      const r = unpre(bmp[i * 4], a), g = unpre(bmp[i * 4 + 1], a), b = unpre(bmp[i * 4 + 2], a)
      if (dist(r, g, b, ORANGE) < 70) orange++
      // 蓝色 = 目标橙色的红蓝互换色
      if (dist(r, g, b, [ORANGE[2], ORANGE[1], ORANGE[0]]) < 70) blue++
      if (dist(r, g, b, GREEN) < 70) green++
      if (r > 200 && g > 200 && b > 200) white++
      if (r < 95 && g < 95 && b < 95) dark++
    }
    return { orange, blue, green, white, dark }
  }

  const cases = [
    ['idle-weak', { glow: GLOW.weak, agent: null, hasUnread: false, angle: 0 }],
    ['idle-strong-unread', { glow: GLOW.strong, agent: null, hasUnread: true, angle: 0 }],
    ['idle-none', { glow: GLOW.none, agent: null, hasUnread: false, angle: 0 }],
    ['codex-a0', { glow: GLOW.weak, agent: 'codex', hasUnread: true, angle: 0 }],
    ['hermes-a180', { glow: GLOW.medium, agent: 'hermes', hasUnread: false, angle: 180 }],
    ['workbuddy-a270', { glow: GLOW.strong, agent: 'workbuddy', hasUnread: false, angle: 270 }],
    ['antigravity-a45', { glow: GLOW.weak, agent: 'antigravity', hasUnread: true, angle: 45 }],
    ['orca-a135', { glow: GLOW.medium, agent: 'orca', hasUnread: false, angle: 135 }],
  ]

  let bad = 0
  console.log('case'.padEnd(20), 'orange  blue  green  white   dark')
  for (const [name, cfg] of cases) {
    const m = measure(render(cfg))
    //蓝色必须为 0；橙色在有光时必须 >0
    const wantOrange = cfg.glow.width > 0
    const ok = m.blue === 0 && (!wantOrange || m.orange > 0)
    if (!ok) bad++
    console.log(name.padEnd(20), String(m.orange).padStart(5), String(m.blue).padStart(5), String(m.green).padStart(6), String(m.white).padStart(6), String(m.dark).padStart(5), ok ? '' : '  <-- FAIL')
  }
  console.log(bad ? `\nRESULT: ${bad} FAILED（存在蓝色互换残留）` : '\nRESULT: 无红蓝互换，橙色正确（直接读 toBitmap 原始字节）')
  app.exit(bad ? 1 : 0)
})