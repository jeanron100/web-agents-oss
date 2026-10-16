export type CodexUsageView = {
  expired: boolean
  used: number
  remain: number
  display: string
}

/** Convert a rate-limit snapshot into an honest display value. */
export function codexUsageView(pct: number, resetsAt: number | null, nowMs = Date.now()): CodexUsageView {
  const raw = Number.isFinite(pct) ? pct : 0
  const used = Math.max(0, Math.min(100, Math.round(raw * 10) / 10))
  const remain = Math.max(0, Math.round((100 - used) * 10) / 10)
  const expired = resetsAt != null && resetsAt * 1000 < nowMs
  // A reset invalidates the old snapshot; it does not prove that the new window still has zero usage.
  return { expired, used, remain, display: expired ? '—' : `${used}%` }
}
