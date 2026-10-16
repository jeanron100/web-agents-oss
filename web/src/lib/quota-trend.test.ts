import { describe, it, expect } from 'vitest'
import { quotaTrend, QUOTA_BUCKET_MS as B, type QuotaSeries } from './quota-trend'
import { buildPctPath } from '../components/PctTrendChart'

const now = 1000 * B + 120000
const series = (points: QuotaSeries['points'], id = 'a'): QuotaSeries => ({ id, engine: 'codex', windowLabel: '本周', points })
describe('quota percent history', () => {
  it('uses the latest actual observation per bucket, keeps missing buckets blank and real zeros', () => {
    const { lines, times } = quotaTrend([series([{ ts: now - 2 * B, pct: 50 }, { ts: now - 2 * B + 1000, pct: 60 }, { ts: now, pct: 0 }])], 7, now)
    expect(times).toHaveLength(56)
    expect(lines[0].values.slice(-3)).toEqual([60, null, 0])
    expect(buildPctPath(lines[0].values.slice(-3), 100, 100, 0, 0, 0, 0)).toBe('M0.0,40.0 M100.0,100.0')
  })
  it('quota reset is a real decline, not a cumulative sum', () => {
    expect(quotaTrend([series([{ ts: now - B, pct: 90 }, { ts: now, pct: 3 }])], 14, now).lines[0].values.slice(-2)).toEqual([90, 3])
  })
  it('keeps multiple accounts separate and excludes invalid, future and out-of-window samples', () => {
    const { lines } = quotaTrend([series([{ ts: now - 31 * 86400_000, pct: 5 }, { ts: now + 1, pct: 20 }, { ts: now, pct: NaN }]), series([{ ts: now, pct: 40 }], 'b'), series([{ ts: now, pct: 70 }], 'c')], 30, now)
    expect(lines.map(s => s.id)).toEqual(['b', 'c'])
    expect(lines.map(s => s.values.at(-1))).toEqual([40, 70])
  })
  it('shows legacy Claude and native Codex when available, without inventing absent engines', () => {
    const { lines } = quotaTrend([{ ...series([{ ts: now, pct: 30 }], 'legacy'), engine: 'claude' }, series([{ ts: now - B, pct: 20 }])], 30, now)
    expect(lines.map(s => s.engine)).toEqual(['codex', 'claude'])
    expect(lines[1].values.at(-1)).toBe(30)
  })
})
