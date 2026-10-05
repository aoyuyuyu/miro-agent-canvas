// 数值验证托盘光栅：直接检查位图像素，不依赖肉眼。
// 复用 trayGeometry.cjs，保证校验与 trayManager 渲染同源。
const { nativeImage, app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const raster = require('../electron/trayRaster.cjs')
const { GLOW, PLATE, RING, AVATAR, DOT, PLATE_COLORS } = require('../electron/trayGeometry.cjs')

// 位图是预乘 alpha 的 RGBA（Electron createFromBitmap 实测）；比对颜色前先还原成直通色
const unpremultiply = (v, a) => (a <= 0 ? 0 : Math.min(255, Math.round((v / a) * 255)))

const analyze = (bmp, size) => {
  let transparent = 0, white = 0, dark = 0, orange = 0, green = 0, other = 0
  const orangePts = [], greenPts = [], darkPts = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const a = bmp[i + 3]
      if (a < 24) { transparent++; continue }
      const r = unpremultiply(bmp[i], a)
      const g = unpremultiply(bmp[i + 1], a)
      const b = unpremultiply(bmp[i + 2], a)
      if (r > 205 && g > 205 && b > 205) { white++; continue }
      if (r > 185 && g > 70 && g < 175 && b < 95) { orange++; orangePts.push([x, y]); continue }
      // 绿点要排除白底上的抗锯齿青色边缘：要求 g 显著高于 r 与 b
      if (g > 145 && r < 110 && b < g * 0.75) { green++; greenPts.push([x, y]); continue }
      if (r < 95 && g < 95 && b < 95) { dark++; darkPts.push([x, y]); continue }
      other++
    }
  }
  return { transparent, white, dark, orange, green, other, orangePts, greenPts, darkPts }
}

const centroid = (pts) => (pts.length
  ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length].map(v => +v.toFixed(2))
  : null)
const extent = (pts) => (pts.length
  ? [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]
  : null)

app.whenReady().then(() => {
  const avatarDir = path.join(__dirname, '../src/assets/avatars')
  const outDir = path.join(__dirname, '../outputs/tray-preview')
  fs.mkdirSync(outDir, { recursive: true })

  const render = ({ glow, agent, hasUnread, angle }) => {
    const canvas = raster.createCanvas()
    const k = raster.SS, S = raster.SIZE * k
    const L = (v) => v * k
    // 与 trayManager.renderFrame 同序：底板 -> 头像/徽标 -> 旋转环 -> 绿点
    raster.fillRoundedRect(canvas, {
      x: L(PLATE.inset), y: L(PLATE.inset), w: S - L(PLATE.inset * 2), h: S - L(PLATE.inset * 2),
      r: L(PLATE.radius), fill: agent ? PLATE_COLORS.agent : PLATE_COLORS.idle,
      stroke: agent ? null : PLATE_COLORS.idleStroke, strokeWidth: 0.9,
    })
    const bmp = agent ? raster.readPngBitmap(path.join(avatarDir, `${agent}.png`), 22) : null
    if (bmp) raster.drawBaseBitmap(canvas, bmp, { x: L(AVATAR.inset), y: L(AVATAR.inset), size: S - L(AVATAR.inset * 2), cornerRadius: L(AVATAR.radius) })
    else raster.drawMiroGlyph(canvas, { x: L(PLATE.inset), y: L(PLATE.inset), size: S - L(PLATE.inset * 2) })
    if (glow.width > 0) {
      raster.strokeArc(canvas, { cx: S / 2, cy: S / 2, radius: L(RING.radius), width: L(glow.width), color: RING.color, startDeg: -angle, sweepDeg: RING.sweepDeg, alpha: glow.alpha })
    }
    if (hasUnread) raster.fillCircle(canvas, { cx: L(DOT.cx), cy: L(DOT.cy), radius: L(DOT.radius), color: DOT.color })
    return { img: nativeImage.createFromBitmap(raster.resolve(canvas), { width: raster.SIZE, height: raster.SIZE }), avatar: bmp }
  }

  // 期望值语义：idle = 白底板 + 黑色m 徽标；agent = 深灰底板 + 真实头像像素。
  // 头像自身颜色不可预知，所以 agent 用例只断言「底板非白、环与绿点正确」。
  const cases = [
    { name: 'idle-weak', agent: null, hasUnread: false, angle: 0, glow: GLOW.weak, expectIdle: true, want: { white: 200, dark: 40, orange: 30, green: 0 } },
    { name: 'idle-strong-unread', agent: null, hasUnread: true, angle: 0, glow: GLOW.strong, expectIdle: true, want: { white: 200, dark: 40, orange: 55, green: 8 } },
    { name: 'idle-none', agent: null, hasUnread: false, angle: 0, glow: GLOW.none, expectIdle: true, want: { white: 200, dark: 40, orange: 0, green: 0 } },
    { name: 'codex-a0', agent: 'codex', hasUnread: true, angle: 0, glow: GLOW.weak, expectIdle: false, want: { orange: 20 } },
    { name: 'hermes-a180', agent: 'hermes', hasUnread: false, angle: 180, glow: GLOW.medium, expectIdle: false, want: { orange: 30 } },
    { name: 'workbuddy-a270', agent: 'workbuddy', hasUnread: false, angle: 270, glow: GLOW.strong, expectIdle: false, want: { orange: 40 } },
    { name: 'antigravity-a45', agent: 'antigravity', hasUnread: true, angle: 45, glow: GLOW.weak, expectIdle: false, want: { orange: 20 } },
    { name: 'orca-a135', agent: 'orca', hasUnread: false, angle: 135, glow: GLOW.medium, expectIdle: false, want: { orange: 30 } },
  ]

  let fail = 0
  const icons = []
  for (const cs of cases) {
    const { img, avatar } = render(cs)
    const bitmap = img.toBitmap()
    const st = analyze(bitmap, raster.SIZE)
    const issues = []
    if (img.isEmpty()) issues.push('EMPTY')
    if (cs.agent && !avatar) issues.push('AVATAR_NOT_LOADED')
    for (const [key, min] of Object.entries(cs.want)) {
      const got = st[key]
      if (min === 0 ? got > 2 : got < min) issues.push(`${key}=${got}(want ${min === 0 ? '0' : '>=' + min})`)
    }
    const oExt = extent(st.orangePts), gExt = extent(st.greenPts)
    if (oExt && (oExt[0] < 0 || oExt[1] < 0 || oExt[2] > raster.SIZE - 1 || oExt[3] > raster.SIZE - 1)) issues.push('ring-clipped')
    if (gExt && (gExt[0] < 0 || gExt[1] < 0 || gExt[2] > raster.SIZE - 1 || gExt[3] > raster.SIZE - 1)) issues.push('dot-clipped')
    // 底板语义：idle 以白底为主；agent 态中心必须是深灰底板
    if (cs.expectIdle && st.white < 200) issues.push(`idle-plate-not-white(${st.white})`)
    if (!cs.expectIdle) {
      // 取中心区4x4 像素，应落在深灰底板范围（不是白、不是透明）
      let plateDark = 0, plateSamples = 0
      for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) {
        const i = (y * raster.SIZE + x) * 4
        const a = bitmap[i + 3]
        if (a < 200) continue
        plateSamples++
        const r = unpremultiply(bitmap[i], a), g = unpremultiply(bitmap[i + 1], a), b = unpremultiply(bitmap[i + 2], a)
        if (r < 90 && g < 90 && b < 90) plateDark++
      }
      if (!plateSamples) issues.push('plate-transparent')
      if (plateSamples && plateDark < plateSamples * 0.5) issues.push(`agent-plate-not-dark(${plateDark}/${plateSamples})`)
    }
    if (st.white + st.dark + st.orange + st.green + st.other > 960) issues.push('plate-fills-canvas')

    // 绿点统一按「是否落在右上角 DOT 区域」判定，避免与头像原色混淆
    const inDot = st.greenPts.filter(([x, y]) => Math.abs(x - DOT.cx) <= DOT.radius + 2 && Math.abs(y - DOT.cy) <= DOT.radius + 2)
    if (cs.hasUnread && inDot.length < 6) issues.push(`dot-not-in-corner(${inDot.length})`)
    if (!cs.hasUnread && inDot.length > 0) issues.push(`dot-in-corner-unexpected(${inDot.length})`)
    if (issues.length) fail++
    console.log(`${cs.name.padEnd(20)} avatar=${avatar ? 'Y' : 'n'} w=${String(st.white).padStart(3)} d=${String(st.dark).padStart(3)} o=${String(st.orange).padStart(3)} g=${String(st.green).padStart(2)} other=${String(st.other).padStart(3)} ${issues.length ? 'FAIL:' + issues.join(',') : 'OK'}`)
    fs.writeFileSync(path.join(outDir, `raw-${cs.name}.png`), img.toPNG())
    icons.push(img.resize({ width: 128, height: 128, quality: 'best' }))
  }

  // 旋转验证：橙环质心随角度变化，且始终偏心（证明是弧段而非整圆）
  const cents = [0, 90, 180, 270].map((a) => {
    const { img } = render({ glow: GLOW.strong, agent: 'codex', hasUnread: false, angle: a })
    return { angle: a, c: centroid(analyze(img.toBitmap(), raster.SIZE).orangePts) }
  })
  const distinct = new Set(cents.map(v => String(v.c))).size
  const offCenter = cents.every(v => v.c && Math.hypot(v.c[0] - 15.5, v.c[1] - 15.5) > 1.5)
  console.log('ring centroids:', JSON.stringify(cents))
  if (distinct < 3) { console.log('FAIL: ring not rotating'); fail++ } else console.log(`ring rotation OK (${distinct} distinct)`)
  if (!offCenter) { console.log('FAIL: ring looks like a full circle, not an arc'); fail++ } else console.log('ring is an off-center arc OK')

  // 联络表：先开足画布再逐格合成，越界即说明读取尺寸有误
  const cols = 4, rows = 2, cell = 128, gap = 12
  const CW = cols * cell + (cols + 1) * gap
  const CH = rows * cell + (rows + 1) * gap
  const buf = Buffer.alloc(CW * CH * 4)
  for (let i = 0; i < CW * CH; i++) { buf[i * 4] = 30; buf[i * 4 + 1] = 30; buf[i * 4 + 2] = 34; buf[i * 4 + 3] = 255 }
  icons.forEach((im, idx) => {
    const size = im.getSize()
    if (size.width !== cell) { console.log('FAIL: tile size mismatch', JSON.stringify(size)); fail++ }
    const ox = gap + (idx % cols) * (cell + gap)
    const oy = gap + Math.floor(idx / cols) * (cell + gap)
    const src = im.toBitmap()
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const si = (y * cell + x) * 4
      const a = src[si + 3] / 255
      if (a <= 0) continue
      const di = ((oy + y) * CW + (ox + x)) * 4
      buf[di] = Math.round(src[si] * a + buf[di] * (1 - a))
      buf[di + 1] = Math.round(src[si + 1] * a + buf[di + 1] * (1 - a))
      buf[di + 2] = Math.round(src[si + 2] * a + buf[di + 2] * (1 - a))
      buf[di + 3] = 255
    }
  })
  const sheetFile = path.join(outDir, 'contact-sheet.png')
  fs.writeFileSync(sheetFile, nativeImage.createFromBitmap(buf, { width: CW, height: CH }).toPNG())
  console.log('SHEET:' + sheetFile, CW + 'x' + CH)

  console.log(fail ? `RESULT: ${fail} FAILED` : 'RESULT: ALL PASS')
  app.exit(fail ? 1 : 0)
})
