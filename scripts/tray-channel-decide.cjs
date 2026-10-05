// 裁决：把同一份 resolve 缓冲分别走 toPNG() 与自写 RGBA->PNG 编码器，看哪个显示橙色
const { nativeImage, app } = require('electron')
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')
const raster = require('../electron/trayRaster.cjs')
const { GLOW, RING } = require('../electron/trayGeometry.cjs')

// 自写最小 PNG 编码器：明确按 RGBA 写入
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
let tbl = null
function crc32(buf) {
  if (!tbl) { tbl = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tbl[n] = c >>> 0 } }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = tbl[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function decodeFirstPixels(file) {
  const b = fs.readFileSync(file); let p = 8, w, h, ct, idat = []
  while (p < b.length) {
    const len = b.readUInt32BE(p), t = b.toString('ascii', p + 4, p + 8), d = b.slice(p + 8, p + 8 + len)
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9] }
    if (t === 'IDAT') idat.push(d)
    p += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const ch = ct === 6 ? 4 : 3, stride = w * ch
  const out = Buffer.alloc(w * h * ch); let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] + out[y * stride + i - ch] : 0, bb = prev[i], c = i >= ch ? prev[i - ch] : 0
      let v = line[i]
      if (f === 1) v += a; else if (f === 2) v += bb; else if (f === 3) v += (a + bb) >> 1
      else if (f === 4) { const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c) }
      out[y * stride + i] = v & 255
    }
    prev = out.slice(y * stride, (y + 1) * stride)
  }
  // 找最接近橙色的像素
  let hit = null
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * w * ch + x * ch
    const r = out[o], g = out[o + 1], b = out[o + 2]
    if (r > 150 && Math.abs(r - b) > 60) { hit = { x, y, r, g, b }; break }
  }
  return { w, h, ct, hit }
}

app.whenReady().then(() => {
  const outDir = path.join(__dirname, '../outputs/tray-preview')
  const canvas = raster.createCanvas()
  const k = raster.SS, S = raster.SIZE * k, L = (v) => v * k
  raster.strokeArc(canvas, { cx: S / 2, cy: S / 2, radius: L(RING.radius), width: L(GLOW.strong.width), color: RING.color, startDeg: 0, sweepDeg: RING.sweepDeg, alpha: 1 })
  const buf = raster.resolve(canvas)

  // 路径 A：Electron toPNG
  const img = nativeImage.createFromBitmap(buf, { width: raster.SIZE, height: raster.SIZE })
  const aFile = path.join(outDir, 'channel-A-electronTopng.png')
  fs.writeFileSync(aFile, img.toPNG())

  // 路径 B：自写 RGBA 编码器
  const bFile = path.join(outDir, 'channel-B-ownEncoder.png')
  fs.writeFileSync(bFile, encodePng(raster.SIZE, raster.SIZE, buf))

  const a = decodeFirstPixels(aFile), b = decodeFirstPixels(bFile)
  console.log('A electron.toPNG :', JSON.stringify(a.hit), 'ct=' + a.ct)
  console.log('B own encoder RGBA:', JSON.stringify(b.hit), 'ct=' + b.ct)
  console.log('')
  console.log('目标橙 #f97316 => r≈249 g≈115 b≈22（b 明显小于 r）')
  app.exit(0)
})