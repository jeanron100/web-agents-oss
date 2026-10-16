import { describe, it, expect } from 'vitest'
import { mergeEarlier, PAGE_SIZE } from './ExecTrace'

// 「执行历史」翻页合并。2026-08-03：ExecTrace 只取会话最近 800 条事件，更早的永远看不到，
// 且头部把截断后的数字当全集显示（实测 ps-ms1k8aom-3092 共 1811 条，显示「92 个回合」）。
// 后端加了复合游标翻页，这里验前端的合并是幂等的。

const ev = (eventKey: string) => ({ eventKey })

describe('mergeEarlier（更早的一页并到已有事件前面）', () => {
  it('更早的一页接在前面，保持时间正序', () => {
    const out = mergeEarlier([ev('c'), ev('d')], [ev('a'), ev('b')])
    expect(out.map((e) => e.eventKey)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('★ 按 eventKey 去重：重复投递/边界重叠都不该产生重复行', () => {
    // 后端复合游标已保证不重，这是第二道保险——同毫秒事件是整条链路最易出错的地方
    const out = mergeEarlier([ev('b'), ev('c')], [ev('a'), ev('b')])
    expect(out.map((e) => e.eventKey)).toEqual(['a', 'b', 'c'])
  })

  it('幂等：同一页并两次结果不变', () => {
    const first = mergeEarlier([ev('c')], [ev('a'), ev('b')])
    const second = mergeEarlier(first, [ev('a'), ev('b')])
    expect(second.map((e) => e.eventKey)).toEqual(['a', 'b', 'c'])
  })

  it('空输入不炸', () => {
    expect(mergeEarlier([], [])).toEqual([])
    expect(mergeEarlier([ev('a')], []).map((e) => e.eventKey)).toEqual(['a'])
    expect(mergeEarlier([], [ev('a')]).map((e) => e.eventKey)).toEqual(['a'])
  })

  it('页大小是 300——首屏 800 条 ≈ 240KB，手机上多数人白等', () => {
    expect(PAGE_SIZE).toBe(300)
  })
})
