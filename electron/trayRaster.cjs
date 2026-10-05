// 托盘图标光栅化：用纯 JS 生成 BGRA 位图，交给 nativeImage.createFromBitmap。
// 原因：Electron 的 nativeImage 不支持 SVG dataURL（createFromDataURL 返回空图），
// 而托盘图标需要按 250ms 逐帧旋转重绘，无法用静态 PNG 资源覆盖。
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 32            // 逻辑边长
const SS = 4               // 超采样倍数，用于抗锯齿
const W = SIZE * SS

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  const n = m ? parseInt(m[1], 16) : 0x000000
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

// 圆角矩形有向距离场：<=0 在内部
const roundedRectSdf = (px, py, x, y, w, h, r) => {
  const cx = x + w / 2, cy = y + h / 2
  const hx = w / 2 - r, hy = h / 2 - r
  const dx = Math.abs(px - cx) - hx
  const dy = Math.abs(py - cy) - hy
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0)
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r
}

// 画布：Float 累积 + 最后一次性降采样成 BGRA
const createCanvas = () => ({ size: W, data: new Float64Array(W * W * 4) })

const blendPixel = (canvas, x, y, r, g, b, alpha) => {
  if (alpha <= 0) return
  if (x < 0 || y < 0 || x >= W || y >= W) return
  const i = (y * W + x) * 4
  const d = canvas.data
  const a = Math.min(1, alpha)
  // 预乘输出：dst = src + dst * (1 - srcA)
  d[i] = r * a + d[i] * (1 - a)
  d[i + 1] = g * a + d[i + 1] * (1 - a)
  d[i + 2] = b * a + d[i + 2] * (1 - a)
  d[i + 3] = a + d[i + 3] * (1 - a)
}

// 用有向距离场填充圆角矩形（羽化边缘天然产生抗锯齿）
const fillRoundedRect = (canvas, { x, y, w, h, r, fill, stroke, strokeWidth = 0 }) => {
  const fg = fill ? hexToRgb(fill) : null
  const st = stroke ? hexToRgb(stroke) : null
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const d = roundedRectSdf(px + 0.5, py + 0.5, x, y, w, h, r)
      const edge = 0.8 // 亚像素羽化宽度
      if (fg && d <= edge) {
        blendPixel(canvas, px, py, fg.r, fg.g, fg.b, Math.min(1, Math.max(0, (edge - d) / edge)))
      }
      if (st) {
        const sw = strokeWidth * SS
        const half = sw / 2
        // 只在描边环带内上色
        const ring = Math.abs(d + half) - half
        if (ring <= edge) {
          blendPixel(canvas, px, py, st.r, st.g, st.b, Math.min(1, Math.max(0, (edge - ring) / edge)))
        }
      }
    }
  }
}

// 圆环（可指定起始角/弧长，用于旋转轮廓）
const strokeArc = (canvas, { cx, cy, radius, width, color, startDeg = 0, sweepDeg = 360, alpha = 1 }) => {
  const c = hexToRgb(color)
  const outer = radius + width / 2
  const inner = radius - width / 2
  const start = (startDeg * Math.PI) / 180
  const sweep = (sweepDeg * Math.PI) / 180
  const feather = 0.8
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const dx = px + 0.5 - cx
      const dy = py + 0.5 - cy
      const dist = Math.hypot(dx, dy)
      const ring = Math.max(dist - outer, inner - dist)
      if (ring > feather) continue
      let ang = Math.atan2(dy, dx) - start
      ang = ((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      if (ang > sweep) continue
      blendPixel(canvas, px, py, c.r, c.g, c.b, Math.min(1, Math.max(0, (feather - ring) / feather)) * alpha)
    }
  }
}

const fillCircle = (canvas, { cx, cy, radius, color, alpha = 1 }) => {
  const c = hexToRgb(color)
  const feather = 0.8
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) - radius
      if (d > feather) continue
      blendPixel(canvas, px, py, c.r, c.g, c.b, Math.min(1, Math.max(0, (feather - d) / feather)) * alpha)
    }
  }
}

// 画一段折线（圆头），用于放粗 logo 笔画
const strokePolyline = (canvas, { points, width, color, alpha = 1 }) => {
  const c = hexToRgb(color)
  const half = (width * SS) / 2
  const feather = 0.8
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      let best = Infinity
      for (let i = 0; i + 1 < points.length; i++) {
        const [x1, y1] = points[i]
        const [x2, y2] = points[i + 1]
        const vx = x2 - x1, vy = y2 - y1
        const len2 = vx * vx + vy * vy || 1
        let t = ((px + 0.5 - x1) * vx + (py + 0.5 - y1) * vy) / len2
        t = Math.min(1, Math.max(0, t))
        const qx = x1 + t * vx, qy = y1 + t * vy
        const d = Math.hypot(px + 0.5 - qx, py + 0.5 - qy) - half
        if (d < best) best = d
      }
      if (best > feather) continue
      blendPixel(canvas, px, py, c.r, c.g, c.b, Math.min(1, Math.max(0, (feather - best) / feather)) * alpha)
    }
  }
}

// 降采样为预乘 BGRA（Electron createFromBitmap 期望的字节序）。
// 颜色与 alpha 都必须除以采样数：canvas 里存的是预乘值，不除会累加到远超 255 再被 clamp，
// 结果环/圆点/笔画全被压成近白色。
const resolve = (canvas) => {
  const out = Buffer.alloc(SIZE * SIZE * 4)
  const d = canvas.data
  const n = SS * SS
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4
          r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]
        }
      }
      const o = (y * SIZE + x) * 4
      // Electron 的 createFromBitmap 实际按 RGBA 读取（用 PNG 解码实测确认：
      // 按 BGRA 写入时橙 #f97316 会渲染成蓝色，红蓝互换），alpha 预乘。
      out[o] = Math.round(Math.min(255, (r / n)))
      out[o + 1] = Math.round(Math.min(255, (g / n)))
      out[o + 2] = Math.round(Math.min(255, (b / n)))
      out[o + 3] = Math.round(Math.min(255, (a / n) * 255))
    }
  }
  return out
}

// 载入现有 PNG 光栅为 {size, data(BGRA)}，用作底图；失败返回 null
const readPngBitmap = (pngPath, targetSize) => {
  const { nativeImage } = require('electron')
  try {
    if (!fs.existsSync(pngPath)) return null
    const img = nativeImage.createFromPath(pngPath)
    if (img.isEmpty()) return null
    const size = img.resize({ width: targetSize, height: targetSize, quality: 'best' }).toBitmap()
    return { size: targetSize, data: size }
  } catch {
    return null
  }
}

// 把已解码的底图按方形区域混入超采样画布（保持原始比例，居中裁切）
const drawBaseBitmap = (canvas, bmp, { x, y, size, cornerRadius = 0, opacity = 1 }) => {
  if (!bmp) return
  const s = bmp.size
  const dst = size * SS
  const scale = dst / s
  const offX = (dst - s * scale) / 2
  const offY = (dst - s * scale) / 2
  const feather = 0.8
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const lx = px + 0.5 - x
      const ly = py + 0.5 - y
      // 圆角遮罩（需要时才做，开销小）
      if (cornerRadius > 0) {
        const d = roundedRectSdf(lx, ly, 0, 0, dst, dst, cornerRadius)
        if (d > 0) continue
      }
      const bx = Math.round((lx - offX) / scale)
      const by = Math.round((ly - offY) / scale)
      if (bx < 0 || by < 0 || bx >= s || by >= s) continue
      const i = (by * s + bx) * 4
      const a = (bmp.data[i + 3] / 255) * opacity
      if (a <= 0) continue
      // toBitmap 与 resolve 同为 RGBA（实测确认），此处不要再做通道互换
      blendPixel(canvas, px, py, bmp.data[i], bmp.data[i + 1], bmp.data[i + 2], a)
    }
  }
  void feather
}

// Miro 的流线 m 徽标（白底黑字），16 像素下需要比原始 SVG 更粗更简化
const drawMiroGlyph = (canvas, { x, y, size, color = '#18181b', width = 2.0 }) => {
  const u = size / 32
  const p = (nx, ny) => [x + nx * u, y + ny * u]
  strokePolyline(canvas, { points: [p(8, 24), p(12.5, 12)], width, color })
  strokePolyline(canvas, { points: [p(12.5, 12), p(16, 19)], width, color })
  strokePolyline(canvas, { points: [p(16, 19), p(19.5, 12)], width, color })
  strokePolyline(canvas, { points: [p(19.5, 12), p(24, 23)], width, color })
}

module.exports = {
  SIZE, SS, W,
  createCanvas, fillRoundedRect, strokeArc, fillCircle, strokePolyline,
  drawMiroGlyph, drawBaseBitmap, readPngBitmap, resolve,
  hexToRgb, blendPixel, path,
}