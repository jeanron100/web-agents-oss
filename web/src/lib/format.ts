/** 相对时间：刚刚 / N 分钟前 / N 小时前 */
export function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 运行时长：23m / 1.2h / 5d */
export function duration(startedAt: number): string {
  // startedAt 可能缺失（崩溃/接管的 Codex 会话 startedAt=null，2026-07-21 实拍「NaNd」）。
  // 展示函数收到非法值必须显式降级——NaN 或「从 1970 算起 2 万天」都是印给用户看的垃圾。
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return '—'
  const min = Math.floor((Date.now() - startedAt) / 60_000)
  if (min < 60) return `${min}m`
  if (min < 48 * 60) return `${(min / 60).toFixed(1)}h`
  return `${Math.floor(min / 1440)}d`
}

/** 时长跨度(ms) → 紧凑可读：48m / 7.5h / 3.2d */
export function fmtDur(ms: number): string {
  const min = Math.round((ms || 0) / 60_000)
  if (min < 1) return '0m'
  if (min < 60) return `${min}m`
  if (min < 48 * 60) return `${(min / 60).toFixed(1)}h`
  return `${(min / 1440).toFixed(1)}d`
}

/** 时刻：09:58 */
export function clock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function money(v: number): string {
  return `$${v.toFixed(2)}`
}

/** token 数自适应：≥1e6→x.xM，≥1e3→xk，否则原值 */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

/** 以「亿」为单位（中文读数/目标用）：5e8→"5.0亿" */
export function fmtYi(n: number): string {
  return `${(n / 1e8).toFixed(1)}亿`
}
