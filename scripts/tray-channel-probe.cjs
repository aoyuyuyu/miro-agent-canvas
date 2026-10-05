// 终极定位：绕过 PNG，直接检查 resolve() 输出缓冲的通道顺序
const { nativeImage, app } = require('electron')
const path = require('node:path')
const raster = require('../electron/trayRaster.cjs')
const { GLOW, PLATE, RING, AVATAR, DOT, PLATE_COLORS } = require('../electron/trayGeometry.cjs')

app.whenReady().then(() => {
  const canvas = raster.createCanvas()
  const k = raster.SS, S = raster.SIZE * k, L = (v) => v * k
  // 只画环，不画底板/头像，排除干扰
  raster.strokeArc(canvas, { cx: S / 2, cy: S / 2, radius: L(RING.radius), width: L(GLOW.strong.width), color: RING.color, startDeg: 0, sweepDeg: RING.sweepDeg, alpha: 1 })

  const buf = raster.resolve(canvas)
  console.log('resolve() 缓冲中 alpha 最高的像素:')
  let rows = []
  for (let i = 0; i < raster.SIZE * raster.SIZE; i++) {
    if (buf[i * 4 + 3] > 200) rows.push({ x: i % raster.SIZE, y: Math.floor(i / raster.SIZE), b0: buf[i * 4], g: buf[i * 4 + 1], r2: buf[i * 4 + 2], a: buf[i * 4 + 3] })
  }
  rows.sort((a, b) => b.a - a.a)
  rows.slice(0, 8).forEach(p => console.log(`  x=${p.x} y=${p.y}  slot0=${p.b0} slot1=${p.g} slot2=${p.r2} a=${p.a}`))
  console.log('')
  console.log('目标橙色 #f97316 = R249 G115 B22')
  console.log('若 slot0≈249 且 slot2≈22  -> resolve 写的是 RGBA (正确)')
  console.log('若 slot0≈22  且 slot2≈249 -> resolve 写的是 BGRA (红蓝互换)')

  // 关键：再走nativeImage.createFromBitmap -> toPNG -> 解码，看最终显示色
  const img = nativeImage.createFromBitmap(buf, { width: raster.SIZE, height: raster.SIZE })
  const back = img.toBitmap()
  console.log('')
  console.log('createFromBitmap 后 toBitmap 回读（roundtrip）:')
  for (const i of rows.slice(0, 3)) {
    const idx = i.y * raster.SIZE + i.x
    console.log(`  x=${i.x} y=${i.y} -> slot0=${back[idx*4]} slot1=${back[idx*4+1]} slot2=${back[idx*4+2]}`)
  }
  app.exit(0)
})