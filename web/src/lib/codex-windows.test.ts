import { describe, it, expect } from 'vitest'
import { codexCells } from './codex-windows'

// Codex 额度窗口在看板上的归位（2026-09-08 用户实拍「数据反了」）。
//
// ★★ 根因不是「写反了」，是**把上游结构当常量写死了**。
//   `UsageRow.tsx` 原先写的是：secondary → 5h 格、primary → 本周格。
//   那在 2026-07-15 的观察下是对的（当时 OpenAI 取消了 5h 窗，primary 变成周窗、
//   secondary=null，CLAUDE.md 里也是这么记的）。但现在实测上游又改回去了：
//       primary   : pct=0, windowMin=300    ← 5 小时
//       secondary : pct=3, windowMin=10080  ← 7 天
//   于是周用量 3% 被画进「5h」格、「本周」显示 0%，正好颠倒。
//
// ★ 所以修法不是把映射对调 —— 那只是把赌注押到另一边，上游再变一次还会错。
//   数据里本来就带着 `windowMin` 这个**自描述字段**，按它归位，位置怎么换都不会错。
//   （`CodexUsageSummary` 早就在用 `winLabel(win.windowMin)` 这么做了，只有看板没跟上。）

const W = (pct: number, windowMin: number | null) => ({ pct, windowMin, resetsAt: null })

describe('codexCells', () => {
  it('★ 线上真实数据：primary=5h(0%) / secondary=周(3%) —— 必须各归各位', () => {
    const cells = codexCells({ primary: W(0, 300), secondary: W(3, 10080) })
    expect(cells.map((c) => [c.label, c.win?.pct])).toEqual([['5h', 0], ['本周', 3]])
  })

  it('★★ 上游把两个窗对调也必须正确 —— 判据是 windowMin，不是字段位置', () => {
    // 这正是 2026-07-15 之后那一版的形态。同一份代码要能同时应付两种排布。
    const cells = codexCells({ primary: W(3, 10080), secondary: W(0, 300) })
    expect(cells.map((c) => [c.label, c.win?.pct])).toEqual([['5h', 0], ['本周', 3]])
  })

  it('只有周窗时不画空的 5h 格（画「5h —」会让人以为坏了）', () => {
    const cells = codexCells({ primary: W(42, 10080), secondary: null })
    expect(cells.map((c) => c.label)).toEqual(['本周'])
    expect(cells[0].win?.pct).toBe(42)
  })

  it('只有 5h 窗时同理', () => {
    const cells = codexCells({ primary: W(7, 300), secondary: null })
    expect(cells.map((c) => c.label)).toEqual(['5h'])
  })

  it('★ 出现没见过的窗口长度也要如实标注，不能硬塞进 5h/本周', () => {
    const cells = codexCells({ primary: W(11, 1440), secondary: null })
    expect(cells[0].label).toBe('1天')       // 24h 窗：既不是 5h 也不是一周
    expect(cells[0].win?.pct).toBe(11)
  })

  it('windowMin 缺失时不猜，按到达顺序给中性标签', () => {
    const cells = codexCells({ primary: { pct: 5, windowMin: null, resetsAt: null }, secondary: null })
    expect(cells).toHaveLength(1)
    expect(cells[0].label).toBe('窗口')
  })

  it('两个窗都没有 → 一格都不画', () => {
    expect(codexCells({ primary: null, secondary: null })).toEqual([])
    expect(codexCells(null)).toEqual([])
  })

  it('★ 排序稳定：短窗永远在前，与上游给的顺序无关', () => {
    const a = codexCells({ primary: W(1, 10080), secondary: W(2, 300) })
    const b = codexCells({ primary: W(2, 300), secondary: W(1, 10080) })
    expect(a.map((c) => c.label)).toEqual(b.map((c) => c.label))
  })
})
