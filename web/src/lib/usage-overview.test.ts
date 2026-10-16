import { describe, it, expect } from 'vitest'
import { recordedTokens, usageOverview } from './usage-overview'
const end = Date.parse('2026-10-07T00:00:00Z')
const row = (ago: number, codex: number, kimi = 0, claude = 0) => ({ date: new Date(end - ago * 86400_000).toISOString().slice(0, 10), byEngine: { codex, kimi, claude } })
describe('overall recorded engine usage', () => {
  it('aggregates recorded engines including historical Claude and counts real zeros', () => {
    const u = usageOverview(Array.from({ length: 30 }, (_, i) => row(i, 10, 5, 5)), '2026-10-07')
    expect(u.today).toBe(20)
    expect(u.week.total).toBe(140)
    expect(u.month.total).toBe(600)
    expect(u.month.average).toBe(20)
    expect(u.change).toBe(0)
    expect(recordedTokens(row(0, 0))).toBe(0)
  })
  it('compares complete weeks, excluding today even if today is unusually high', () => {
    const data = [row(0, 100000), ...Array.from({ length: 14 }, (_, i) => row(i + 1, i < 7 ? 20 : 10))]
    const u = usageOverview(data, '2026-10-07')
    expect(u.recent.total).toBe(140)
    expect(u.previous.total).toBe(70)
    expect(u.change).toBe(100)
    expect(u.peak).toEqual({ date: '2026-10-07', tokens: 100000 })
  })
  it('missing calendar days are not filled with zero or replaced by older rows', () => {
    const u = usageOverview([row(0, 10), row(6, 30), row(8, 500), { date: row(2, 0).date }], '2026-10-07')
    expect(u.week.total).toBe(40)
    expect(u.week.recorded).toBe(2)
    expect(u.week.average).toBe(20)
    expect(u.change).toBeNull()
    expect(u.comparable).toBe(false)
  })
  it('empty and invalid records show unknown; a zero previous week is not infinite growth', () => {
    expect(usageOverview([], '2026-10-07').today).toBeNull()
    expect(usageOverview([row(0, NaN)], '2026-10-07').month.recorded).toBe(0)
    const u = usageOverview(Array.from({ length: 15 }, (_, i) => row(i, i < 8 ? 20 : 0)), '2026-10-07')
    expect(u.comparable).toBe(true)
    expect(u.change).toBeNull()
    expect(u.previous.total).toBe(0)
  })
})
