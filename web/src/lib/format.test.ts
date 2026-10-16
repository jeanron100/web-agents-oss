// duration() 的防御性测试。
//
// 2026-07-21 线上实拍：一个崩溃的 Codex 会话（app-server 进程退出）startedAt=null，
// 顶栏时长渲染成「NaNd」。实测四种非法输入全吐垃圾：
//   duration(undefined) = "NaNd"    duration(null) = "20654d"
//   duration(NaN)       = "NaNd"    duration(0)    = "20654d"
// 一个展示函数收到坏输入就该显式降级成占位符，绝不能把 NaN/1970-至今的天数印给用户。
import { describe, it, expect } from 'vitest'
import { duration } from './format'

describe('duration', () => {
  it('正常 startedAt → 人类可读时长', () => {
    expect(duration(Date.now() - 5 * 60_000)).toMatch(/^\d+m$/)
    expect(duration(Date.now() - 3 * 3600_000)).toMatch(/h$/)
  })

  it('★ startedAt 缺失/非法 → 占位符，绝不出现 NaN 或荒谬天数', () => {
    for (const bad of [undefined, null, NaN, 0, -1, 'x' as unknown as number]) {
      const out = duration(bad as number)
      expect(out).not.toMatch(/NaN/)
      expect(out).not.toMatch(/20\d{3}d/)   // 从 1970 算起的荒谬天数
      expect(out).toBe('—')
    }
  })
})
