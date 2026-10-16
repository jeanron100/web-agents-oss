// 图片加载代价提示（2026-09-11 事故后加）。纯函数。
//
// ★ 为什么要把「代价」画在按钮上，而不是替用户决定：
//   跨境隧道实测只有 **~11 KB/s**。一张 451 KB 的截图要独占链路 ~41 秒，
//   期间 `/api/state`(54KB) 排在后面等不到 ⇒ 前端 20s 超时 ⇒ 连续失败 ⇒「与服务器失联」。
//   实证是隧道 SSH 连接的 **Send-Q 从 192,632 涨到 655,548 字节**——图片全堵在发送队列里。
//   ⇒ 图片改成**点击才加载**；而按钮上必须写清「451 KB · 约 41 秒」，
//   **让用户在点之前就知道要等多久**，比替他决定加载或不加载更尊重人。

/** 跨境链路实测吞吐（server/sse-gzip.js 与 CLAUDE.md 都记着这个数）。 */
export const CROSS_BORDER_BYTES_PER_SEC = 11 * 1024

/** 预计耗时 ≤ 此值就不显示耗时，免得给小图加没必要的噪音。 */
const QUIET_SECS = 3

const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * 显示规则：**≥100 取整、<100 留一位小数**。
 * 「451 KB」比「450.9 KB」好读，而「1.0 KB」比「1 KB」更能看出量级。
 * ⚠️ 我第一版加了个 `.replace(/\.0 KB$/,'')` 的"优化"，正好和这条规则冲突——
 *    先写的测试当场把它抓了出来。
 */
const unit = (v: number, u: string) => (v >= 100 ? `${Math.round(v)} ${u}` : `${v.toFixed(1)} ${u}`)

export function fmtBytes(n?: number | null): string {
  if (!ok(n)) return ''                       // ⚠️ 拿不到就返回空串，别编一个 "0 B" 出来
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return unit(n / 1024, 'KB')
  return unit(n / 1024 / 1024, 'MB')
}

/**
 * 按实测跨境吞吐估算加载耗时（秒）。
 * ⚠️ 大小未知一律返回 `null`，**绝不返回 0** —— 0 会被渲染成「约 0 秒」，
 *    等于骗用户说"很快"。本仓库记过这条：把「读不到」变成「读到了 0」，而 0 往往正好是最坏值。
 */
export function crossBorderSecs(bytes?: number | null): number | null {
  if (!ok(bytes) || bytes === 0) return null
  return Math.round(bytes / CROSS_BORDER_BYTES_PER_SEC)
}

/** 占位按钮上的那行字：`名称 · 体积 · 约 N 秒`（缺什么就省什么，不编） */
export function imageHint(img: { name?: string; bytes?: number | null }): string {
  const parts: string[] = []
  const name = String(img?.name ?? '').trim()
  if (name) parts.push(name)
  const size = fmtBytes(img?.bytes)
  if (size) parts.push(size)
  const secs = crossBorderSecs(img?.bytes)
  if (secs !== null && secs > QUIET_SECS) parts.push(`约 ${secs} 秒`)
  return parts.join(' · ')
}
