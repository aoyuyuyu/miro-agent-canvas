// 在下一帧批量交付尺寸变化，避免画布测量和布局在同一帧相互触发。
// 同一帧中的不同节点均保留，不丢失初始端口测量。
const NativeObserver = window.ResizeObserver
if (NativeObserver && !NativeObserver.miroBatched) {
  class FrameObserver extends NativeObserver {
    static miroBatched = true
    constructor(callback) {
      super(entries => {
        entries.forEach(entry => this.pending.set(entry.target, entry))
        if (this.frame) return
        this.frame = requestAnimationFrame(() => {
          this.frame = 0
          const batch = [...this.pending.values()]
          this.pending.clear()
          if (batch.length) callback(batch, this)
        })
      })
      this.pending = new Map()
      this.frame = 0
    }
    unobserve(target) { this.pending.delete(target); super.unobserve(target) }
    disconnect() { cancelAnimationFrame(this.frame); this.frame = 0; this.pending.clear(); super.disconnect() }
  }
  window.ResizeObserver = FrameObserver
}
