import { describe, expect, it } from 'vitest'
import { codexUsageView } from './codexUsage'

describe('codexUsageView', () => {
  it('shows used percent while the snapshot window is current', () => {
    expect(codexUsageView(77.04, 2_000, 1_000_000)).toEqual({
      expired: false, used: 77, remain: 23, display: '77%',
    })
  })

  it('marks usage unknown after the snapshot reset instead of assuming zero', () => {
    expect(codexUsageView(77, 900, 1_000_000).display).toBe('—')
    expect(codexUsageView(77, 900, 1_000_000).expired).toBe(true)
  })

  it('clamps malformed percentages to the display domain', () => {
    expect(codexUsageView(120, null, 0).used).toBe(100)
    expect(codexUsageView(-5, null, 0).used).toBe(0)
  })
})
