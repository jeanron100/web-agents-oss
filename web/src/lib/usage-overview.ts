import { USAGE_ENGINES, type EngineDay } from './engine-trend'

const DAY = 86400_000
const keyAt = (ts: number) => new Date(ts).toISOString().slice(0, 10)
const dayTime = (key: string) => {
  const ts = Date.parse(`${key}T00:00:00Z`)
  return Number.isFinite(ts) && keyAt(ts) === key ? ts : null
}
export function recordedTokens(row: EngineDay): number | null {
  if (!row.byEngine) return null
  const values = USAGE_ENGINES.map(e => row.byEngine![e] ?? 0)
  return values.every(n => Number.isFinite(n) && n >= 0) ? values.reduce((n, v) => n + v, 0) : null
}

/** Calendar windows, not array length. Missing records are not zero days. */
export function usageOverview(days: EngineDay[], today: string) {
  const end = dayTime(today)
  const values = new Map<string, number>()
  for (const d of days) {
    const n = recordedTokens(d)
    if (dayTime(d.date) != null && n != null) values.set(d.date, n)
  }
  const window = (count: number, offset = 0) => {
    const points: Array<{ date: string; tokens: number }> = []
    if (end != null) for (let i = count - 1; i >= 0; i--) {
      const date = keyAt(end - (offset + i) * DAY)
      if (values.has(date)) points.push({ date, tokens: values.get(date)! })
    }
    const total = points.reduce((n, p) => n + p.tokens, 0)
    return { points, total, recorded: points.length, average: points.length ? total / points.length : null }
  }
  const week = window(7), month = window(30)
  const recent = window(7, 1), previous = window(7, 8)
  const comparable = recent.recorded === 7 && previous.recorded === 7
  const change = comparable && previous.total > 0 ? (recent.total / previous.total - 1) * 100 : null
  const peak = month.points.reduce<{ date: string; tokens: number } | null>((max, p) => !max || p.tokens > max.tokens ? p : max, null)
  return { today: values.get(today) ?? null, week, month, recent, previous, comparable, change, peak }
}
