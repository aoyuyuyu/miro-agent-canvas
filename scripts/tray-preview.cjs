// 导出托盘图标预览图，放大 8 倍便于肉眼验收
const { nativeImage, app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const raster = require('../electron/trayRaster.cjs')

app.whenReady().then(() => {
  const outDir = path.join(__dirname, '../outputs/tray-preview')
  fs.mkdirSync(outDir, { recursive: true })

  const GLOW = { none: { width: 0, alpha: 0 }, weak: { width: 2.2, alpha: 0.65 }, medium: { width: 2.8, alpha: 0.85 }, strong: { width: 3.4, alpha: 1 } }
  const avatarDir = path.join(__dirname, '../src/assets/avatars')

  const render = ({ glow, agent, hasUnread, angle }) => {
    const canvas = raster.createCanvas()
    const S = raster.SIZE * raster.SS
    const c = S / 2
    if (glow.width > 0) {
      raster.strokeArc(canvas, { cx: c, cy: c, radius: S / 2 - raster.SS * 1.1, width: glow.width * raster.SS, color: '#f97316', startDeg: -angle, sweepDeg: 140, alpha: glow.alpha })
    }
    raster.fillRoundedRect(canvas, { x: raster.SS * 4, y: raster.SS * 4, w: S - raster.SS * 8, h: S - raster.SS * 8, r: raster.SS * 6, fill: agent ? '#27272a' : '#ffffff', stroke: agent ? null : '#e4e4e7', strokeWidth: 0.9 })
    const bmp = agent ? raster.readPngBitmap(path.join(avatarDir, `${agent}.png`), 22) : null
    if (bmp) raster.drawBaseBitmap(canvas, bmp, { x: raster.SS * 5, y: raster.SS * 5, size: S - raster.SS * 10, cornerRadius: raster.SS * 5 })
    else raster.drawMiroGlyph(canvas, { x: raster.SS * 4, y: raster.SS * 4, size: S - raster.SS * 8 })
    if (hasUnread) raster.fillCircle(canvas, { cx: S - raster.SS * 5.5, cy: raster.SS * 5.5, radius: raster.SS * 3.2, color: '#22c55e' })
    return nativeImage.createFromBitmap(raster.resolve(canvas), { width: raster.SIZE, height: raster.SIZE })
  }

  const cases = [
    { name: '1-idle-weak', glow: GLOW.weak, agent: null, hasUnread: false, angle: 0 },
    { name: '2-idle-strong-unread', glow: GLOW.strong, agent: null, hasUnread: true, angle: 0 },
    { name: '3-idle-none', glow: GLOW.none, agent: null, hasUnread: false, angle: 0 },
    { name: '4-codex-weak-a0', glow: GLOW.weak, agent: 'codex', hasUnread: true, angle: 0 },
    { name: '5-codex-weak-a90', glow: GLOW.weak, agent: 'codex', hasUnread: true, angle: 90 },
    { name: '6-hermes-medium-a180', glow: GLOW.medium, agent: 'hermes', hasUnread: false, angle: 180 },
    { name: '7-workbuddy-strong-a270', glow: GLOW.strong, agent: 'workbuddy', hasUnread: false, angle: 270 },
    { name: '8-antigravity-weak-a45', glow: GLOW.weak, agent: 'antigravity', hasUnread: true, angle: 45 },
  ]

  const tiles = []
  for (const cs of cases) {
    const img = render(cs)
    console.log(cs.name, '| isEmpty:', img.isEmpty(), '| size:', JSON.stringify(img.getSize()))
    const big = img.resize({ width: 256, height: 256, quality: 'best' })
    const file = path.join(outDir, `${cs.name}.png`)
    fs.writeFileSync(file, big.toPNG())
    tiles.push(big)
  }

  // 拼成 4x2 联络表（每格 256，带间隙）
  const cols = 4, rows = 2, gap = 16
  const sheet = nativeImage.createEmpty()
  void sheet
  const W = cols * 256 + (cols + 1) * gap
  const H = rows * 256 + (rows + 1) * gap
  const buf = Buffer.alloc(W * H * 4)
  // 背景填充深灰，方便看白色底板
  for (let i = 0; i < W * H; i++) { buf[i * 4] = 40; buf[i * 4 + 1] = 40; buf[i * 4 + 2] = 46; buf[i * 4 + 3] = 255 }
  tiles.forEach((t, idx) => {
    const col = idx % cols, row = Math.floor(idx / cols)
    const ox = gap + col * (256 + gap)
    const oy = gap + row * (256 + gap)
    const src = t.toBitmap()
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const si = (y * 256 + x) * 4
        const a = src[si + 3] / 255
        if (a <= 0) continue
        const di = ((oy + y) * W + (ox + x)) * 4
        buf[di] = Math.round(src[si + 2] * a + buf[di] * (1 - a))
        buf[di + 1] = Math.round(src[si + 1] * a + buf[di + 1] * (1 - a))
        buf[di + 2] = Math.round(src[si] * a + buf[di + 2] * (1 - a))
      }
    }
  })
  const sheetFile = path.join(outDir, 'contact-sheet.png')
  fs.writeFileSync(sheetFile, nativeImage.createFromBitmap(buf, { width: W, height: H }).toPNG())
  console.log('SHEET:' + sheetFile)
  app.exit(0)
})