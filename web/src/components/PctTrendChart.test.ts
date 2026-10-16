import { describe, it, expect } from 'vitest'
import { buildPctPath } from './PctTrendChart'
describe('buildPctPath', () => {
  it('0–100% 映射 y(0→底,100→顶),首点 M 后续 L', () => {
    expect(buildPctPath([0, 100], 100, 100, 0, 0, 0, 0)).toBe('M0.0,100.0 L100.0,0.0')
  })
  it('跳过 null:断开后重新 M', () => {
    expect(buildPctPath([50, null, 50], 100, 100, 0, 0, 0, 0)).toBe('M0.0,50.0 M100.0,50.0')
  })
  it('空/全 null → 空串', () => {
    expect(buildPctPath([null, null], 100, 100, 0, 0, 0, 0)).toBe('')
  })
})
