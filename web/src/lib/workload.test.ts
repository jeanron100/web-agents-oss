import { describe, expect, it } from 'vitest'
import { quantifyWorkload, workloadSentence } from './workload'

const H = 3_600_000

describe('quantifyWorkload：活跃时长 → 可体感的"几天"', () => {
  it('用户举的例子：100 小时 ≈ 满负荷 4.2 天（÷24），或 12.5 人日（÷8）', () => {
    const w = quantifyWorkload(100 * H)
    expect(w.hours).toBe(100)
    expect(w.fullDays).toBe(4.2)      // 100/24，落在用户说的"3~5 天"
    expect(w.personDays).toBe(12.5)   // 100/8
  })

  it('并行会被如实体现：一个日历日里跨会话合计 48 小时 ⇒ 满负荷 2 天', () => {
    // 多个 agent 同时跑，总活跃时长可以超过 24h/日历日——这正是并行压缩的量化
    expect(quantifyWorkload(48 * H).fullDays).toBe(2)
  })

  it('零/负输入不炸，给 0', () => {
    expect(quantifyWorkload(0)).toEqual({ hours: 0, fullDays: 0, personDays: 0 })
    expect(quantifyWorkload(-999)).toEqual({ hours: 0, fullDays: 0, personDays: 0 })
  })

  it('小时保留一位小数（规模感就够，不追精确）', () => {
    expect(quantifyWorkload(1.5 * H).hours).toBe(1.5)
    expect(quantifyWorkload(82 * H).hours).toBe(82) // 本项目真实两周数据
  })
})

describe('workloadSentence', () => {
  it('空态给一句不尴尬的话，不显示 "0 天"', () => {
    expect(workloadSentence(0)).toBe('本时段暂无活跃记录')
    expect(workloadSentence(30_000)).toBe('本时段暂无活跃记录') // <0.1h
  })
  it('有数据时同时给满负荷天与人力工作日', () => {
    const s = workloadSentence(82 * H)
    expect(s).toContain('满负荷不间断 3.4 天')
    expect(s).toContain('10.3 个人力工作日')
  })
})
