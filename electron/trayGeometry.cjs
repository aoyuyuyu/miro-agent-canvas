// 托盘图标的共享几何与配色：trayManager 渲染与 scripts/tray-verify.cjs 校验共用，
// 避免两处数值漂移。单位均为 32x32 逻辑画布像素。
const GLOW = {
  none: { width: 0, alpha: 0 },
  weak: { width: 1.3, alpha: 0.7 },
  medium: { width: 1.7, alpha: 0.88 },
  strong: { width: 2.1, alpha: 1 },
}

const PLATE = { inset: 4, radius: 6 }     // 底板 24x24，留 4px 给旋转环
const RING = { radius: 14.6, sweepDeg: 140, color: '#f97316' }
const AVATAR = { inset: 5, radius: 5 }    // 头像 22x22
const DOT = { cx: 27.5, cy: 4.5, radius: 3.2, color: '#22c55e' }
const PLATE_COLORS = { idle: '#ffffff', idleStroke: '#e4e4e7', agent: '#27272a' }

module.exports = { GLOW, PLATE, RING, AVATAR, DOT, PLATE_COLORS }