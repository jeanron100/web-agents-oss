export type QuotaSeries = { id: string; engine: 'codex' | 'kimi' | 'claude'; windowLabel: string; sourceLabel?: string; points: Array<{ ts: number; pct: number }> }
export const QUOTA_BUCKET_MS = 3 * 3600_000

/** Align observations on real time, keep missing buckets null, never sum accounts. */
export function quotaTrend(series: QuotaSeries[], days: number, now = Date.now()) {
  const end = Math.floor(now / QUOTA_BUCKET_MS) * QUOTA_BUCKET_MS
  const start = end - days * 86400_000 + QUOTA_BUCKET_MS
  const times = Array.from({ length: days * 8 }, (_, i) => start + i * QUOTA_BUCKET_MS)
  const lines = series.map(s => {
    const samples = new Map<number, { ts: number; pct: number }>()
    for (const p of s.points) {
      if (!Number.isFinite(p.ts) || !Number.isFinite(p.pct) || p.pct < 0 || p.pct > 100 || p.ts > now) continue
      const bucket = Math.floor(p.ts / QUOTA_BUCKET_MS) * QUOTA_BUCKET_MS
      if (bucket < start || bucket > end) continue
      if (!samples.has(bucket) || samples.get(bucket)!.ts < p.ts) samples.set(bucket, p)
    }
    return { ...s, samples, values: times.map(t => samples.get(t)?.pct ?? null) }
  }).filter(s => s.samples.size > 0).sort((a, b) => ['codex', 'kimi', 'claude'].indexOf(a.engine) - ['codex', 'kimi', 'claude'].indexOf(b.engine) || a.id.localeCompare(b.id))
  return { times, lines }
}
