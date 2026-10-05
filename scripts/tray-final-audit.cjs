// 独立复核：只读 outputs 里已生成的 PNG，用自带解码器统计颜色，不碰渲染代码
const fs = require('node:fs')
const zlib = require('node:zlib')
const path = require('node:path')

function decode(file) {
  const b = fs.readFileSync(file)
  let p = 8, w, h, ct, idat = []
  while (p < b.length) {
    const len = b.readUInt32BE(p), t = b.toString('ascii', p + 4, p + 8), d = b.slice(p + 8, p + 8 + len)
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9] }
    if (t === 'IDAT') idat.push(d)
    p += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : 1, stride = w * ch
  const out = Buffer.alloc(w * h * ch)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] + out[y * stride + i - ch] : 0
      const bb = prev[i], c = i >= ch ? prev[i - ch] : 0
      let v = line[i]
      if (f === 1) v += a
      else if (f === 2) v += bb
      else if (f === 3) v += (a + bb) >> 1
      else if (f === 4) {
        const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c)
      }
      out[y * stride + i] = v & 255
    }
    prev = out.slice(y * stride, (y + 1) * stride)
  }
  return { w, h, ch, data: out }
}

const dir = path.join(__dirname, '../outputs/tray-preview')
const files = fs.readdirSync(dir).filter(f => f.startsWith('raw-')).sort()
console.log('file'.padEnd(30), 'orange  blue  green  white')
let bad = 0
for (const f of files) {
  const im = decode(path.join(dir, f))
  let orange = 0, blue = 0, green = 0, white = 0
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    const o = y * im.w * im.ch + x * im.ch
    const r = im.data[o], g = im.data[o + 1], b = im.data[o + 2]
    if (r > 180 && g > 60 && g < 180 && b < 110) orange++
    if (b > 150 && b > r + 40 && b > g + 20) blue++
    if (g > 145 && r < 110 && b < g * 0.75) green++
    if (r > 200 && g > 200 && b > 200) white++
  }
  const unreadExpected = /unread|a0|a45/.test(f)
  const ok = blue === 0 && (unreadExpected ? green > 0 : true)
  if (!ok) bad++
  console.log(f.padEnd(30), String(orange).padStart(5), String(blue).padStart(5), String(green).padStart(6), String(white).padStart(6), ok ? '' : '  <-- 有蓝色残留')
}
console.log(bad ? `\nRESULT: ${bad} 个文件仍有蓝色残留` : '\nRESULT: 全部无蓝色残留（RGBA 通道一致）')