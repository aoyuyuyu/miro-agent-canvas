// 逐层探针：单独测每个光栅函数，定位为什么环/圆点/笔画不出像素
const { nativeImage, app } = require('electron')
const raster = require('../electron/trayRaster.cjs')

const dump = (name, canvas) => {
  const buf = raster.resolve(canvas)
  let opaque = 0, partial = 0
  for (let i = 0; i < raster.SIZE * raster.SIZE; i++) {
    const a = buf[i * 4 + 3]
    if (a > 200) opaque++; else if (a > 0) partial++
  }
  console.log(`${name.padEnd(18)} opaque=${String(opaque).padStart(4)} partial=${String(partial).padStart(4)}`)
  return { opaque, partial }
}

app.whenReady().then(() => {
  const S = raster.SIZE * raster.SS
  console.log('SIZE', raster.SIZE, 'SS', raster.SS, 'W', raster.W, 'canvasDataLen', raster.createCanvas().data.length)

  // 1) 只有环
  const c1 = raster.createCanvas()
  raster.strokeArc(c1, { cx: S / 2, cy: S / 2, radius: 14.6 * raster.SS, width: 1.3 * raster.SS, color: '#f97316', startDeg: 0, sweepDeg: 140, alpha: 0.7 })
  dump('ring-only', c1)

  // 2) 只有圆点
  const c2 = raster.createCanvas()
  raster.fillCircle(c2, { cx: 27.5 * raster.SS, cy: 4.5 * raster.SS, radius: 3.2 * raster.SS, color: '#22c55e' })
  dump('dot-only', c2)

  // 3) 只有圆角矩形（已知可用，作为对照）
  const c3 = raster.createCanvas()
  raster.fillRoundedRect(c3, { x: 4 * raster.SS, y: 4 * raster.SS, w: 24 * raster.SS, h: 24 * raster.SS, r: 6 * raster.SS, fill: '#ffffff' })
  dump('plate-only', c3)

  // 4) 只有 m 笔画
  const c4 = raster.createCanvas()
  raster.drawMiroGlyph(c4, { x: 4 * raster.SS, y: 4 * raster.SS, size: 24 * raster.SS })
  dump('glyph-only', c4)

  // 5) 手工验证 blendPixel 本身
  const c5 = raster.createCanvas()
  raster.blendPixel(c5, 10, 10, 249, 115, 22, 1)
  dump('manual-blend', c5)
  console.log('manual px alpha =', raster.resolve(c5)[(10 * raster.SIZE + 10) * 4 + 3])

  // 6) 环的坐标范围自检
  const radius = 14.6 * raster.SS, outer = radius + (1.3 * raster.SS) / 2
  console.log('ring radius', radius, 'outer', outer, 'canvas half', S / 2, 'fits:', outer < S / 2)

  app.exit(0)
})