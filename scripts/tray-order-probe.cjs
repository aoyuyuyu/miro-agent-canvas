// 决定 createFromBitmap 的字节序到底是 BGRA 还是 RGBA：写入已知颜色，读回 PNG 看像素
const { nativeImage, app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(() => {
  const W = 4, H = 1
  // 像素 0: R=249 G=115 B=22 （橙色 #f97316）
  // 像素 1: R=34  G=197 B=94 （绿色 #22c55e）
  // 像素 2: R=255 G=0   B=0  （纯红）
  // 像素 3: R=0   G=0   B=255（纯蓝）
  const src = [
    [249, 115, 22],
    [34, 197, 94],
    [255, 0, 0],
    [0, 0, 255],
  ]
  const mk = (order) => {
    const buf = Buffer.alloc(W * H * 4)
    src.forEach(([r, g, b], i) => {
      const o = i * 4
      if (order === 'BGRA') { buf[o] = b; buf[o + 1] = g; buf[o + 2] = r }
      else { buf[o] = r; buf[o + 1] = g; buf[o + 2] = b }
      buf[o + 3] = 255
    })
    return nativeImage.createFromBitmap(buf, { width: W, height: H })
  }
  for (const order of ['BGRA', 'RGBA']) {
    const img = mk(order)
    const file = path.join(__dirname, `../outputs/tray-preview/order-${order}.png`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, img.toPNG())
    // 用同一个 img 解码回来，读第一个像素的 toBitmap，与写入顺序对比
    const round = img.toBitmap()
    console.log(`${order}: wrote [${[round[0], round[1], round[2]].join(',')}] for first pixel, expected RGBA (249,115,22)`)
  }
  console.log('CHECK: 读回的第一个像素若为 (249,115,22) 说明 toBitmap 原样返回，无法区分；请看生成的 PNG 颜色')
  app.exit(0)
})