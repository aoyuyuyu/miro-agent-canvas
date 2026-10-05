const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

app.whenReady().then(() => {
  const src = path.join(__dirname, '../src/assets/avatars/miro.png')
  const base = nativeImage.createFromPath(src)
  const p16 = base.resize({ width: 16, height: 16 }).toPNG()
  const p32 = base.resize({ width: 32, height: 32 }).toPNG()
  const p256 = base.resize({ width: 256, height: 256 }).toPNG()

  fs.writeFileSync(path.join(__dirname, '../src/assets/avatars/miro_16.png'), p16)
  fs.writeFileSync(path.join(__dirname, '../src/assets/avatars/miro_32.png'), p32)
  fs.writeFileSync(path.join(__dirname, '../src/assets/avatars/miro_256.png'), p256)

  // 构造标准 32x32 Windows ICO
  const icoHead = Buffer.alloc(22)
  icoHead.writeUInt16LE(0, 0)
  icoHead.writeUInt16LE(1, 2)
  icoHead.writeUInt16LE(1, 4)
  icoHead.writeUInt8(32, 6)
  icoHead.writeUInt8(32, 7)
  icoHead.writeUInt8(0, 8)
  icoHead.writeUInt8(0, 9)
  icoHead.writeUInt16LE(1, 10)
  icoHead.writeUInt16LE(32, 12)
  icoHead.writeUInt32LE(p32.length, 14)
  icoHead.writeUInt32LE(22, 18)
  const ico = Buffer.concat([icoHead, p32])

  fs.writeFileSync(path.join(__dirname, '../src/assets/avatars/miro.ico'), ico)
  fs.writeFileSync(path.join(__dirname, '../../Miro/Miro.ico'), ico)
  fs.writeFileSync(path.join(__dirname, '../../Miro.ico'), ico)

  console.log('RESIZE_AND_ICO_DONE')
  app.quit()
})
