import { describe, expect, it } from 'vitest'
import { usageReset } from './usage-reset'

describe('额度重置时间', () => {
  it('Codex 秒级时间戳转成浏览器当地时间，保留机器可读时间', () => {
    const date = new Date(2026, 9, 8, 9, 30)
    expect(usageReset({ resetsAt: date.getTime() / 1000 })).toMatchObject({
      text: '10/08 09:30', dateTime: date.toISOString(),
    })
  })

  it('Kimi 倒计时锚定采集时间，跨天和跨月仍保持同一重置点', () => {
    const sampled = new Date(2026, 8, 30, 23, 30).getTime()
    const reset = usageReset({ resets: '2d 1h 5m' }, sampled)
    expect(reset?.text).toBe('10/03 00:35')
    expect(reset?.dateTime).toBe(new Date(sampled + (2 * 1440 + 65) * 60_000).toISOString())
    expect(usageReset({ resets: '0m' }, sampled)?.dateTime).toBe(new Date(sampled).toISOString())
  })

  it('没有采集时间时保留原值，不将旧倒计时绑定到当前时间', () => {
    expect(usageReset({ resets: '23d 14h 29m' })).toMatchObject({ text: '23d 14h 29m', dateTime: undefined })
  })

  it('文字时区和缺失时间如实显示，不猜测日期', () => {
    expect(usageReset({ resets: 'Oct 8 at 9am (Asia/Shanghai)' })?.text).toBe('Oct 8 at 9am (Asia/Shanghai)')
    expect(usageReset({ resetsAt: NaN })?.text).toBe('时间未知')
    expect(usageReset(null)).toBeNull()
    expect(usageReset({ resetsAt: 1e30 })?.text).toBe('时间未知')
  })
})
