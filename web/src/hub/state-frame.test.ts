import { describe, it, expect } from 'vitest'
import { mergeStateFrame, isFullFrame } from './state-frame'

const mk = (id: string, extra: Record<string, unknown> = {}) => ({ id, state: 'idle', ...extra })

describe('/api/state 三态帧合并', () => {
  it('snapshot 整份替换', () => {
    const out = mergeStateFrame([mk('old')], { frame: 'snapshot', sessions: [mk('new')] })
    expect(out.map((s) => (s as { id: string }).id)).toEqual(['new'])
  })

  it('delta 只改动带来的那几条，其余保留', () => {
    const local = [mk('a'), mk('b'), mk('c')]
    const out = mergeStateFrame(local, { frame: 'delta', changed: [mk('b', { state: 'running' })], removed: [] })
    expect(out).toHaveLength(3)
    expect((out.find((s) => (s as { id: string }).id === 'b') as { state: string }).state).toBe('running')
    expect((out.find((s) => (s as { id: string }).id === 'a') as { state: string }).state).toBe('idle')
  })

  it('★ 删除只认显式 removed —— 不得靠「本次没出现」推断', () => {
    // 增量协议最经典的塌陷点：客户端无法区分「会话没了」与「本次是增量所以没带它」。
    // 若这里改成「以 changed 为全集」，稳态下 changed 为空 ⇒ 整个列表会被清空。
    const local = [mk('a'), mk('b')]
    const out = mergeStateFrame(local, { frame: 'delta', changed: [], removed: [] })
    expect(out).toHaveLength(2)
  })

  it('removed 里的会话被移除', () => {
    const out = mergeStateFrame([mk('a'), mk('b')], { frame: 'delta', changed: [], removed: ['a'] })
    expect(out.map((s) => (s as { id: string }).id)).toEqual(['b'])
  })

  it('★ 未知帧类型按 snapshot 兜底，不静默丢数据', () => {
    // 协议以后加新帧类型时老前端会走到这里，安全默认值必须是"多做"而不是"少做"。
    const out = mergeStateFrame([mk('old')], { frame: 'brand-new-kind', sessions: [mk('x')] })
    expect(out.map((s) => (s as { id: string }).id)).toEqual(['x'])
  })

  it('★ 多轮增量后与直接全量一致（等价性）', () => {
    let local = [mk('s0'), mk('s1'), mk('s2')]
    local = mergeStateFrame(local, { frame: 'delta', changed: [mk('s1', { state: 'running' })], removed: [] })
    local = mergeStateFrame(local, { frame: 'delta', changed: [mk('s3')], removed: ['s0'] })
    local = mergeStateFrame(local, { frame: 'delta', changed: [], removed: [] })
    const ids = local.map((s) => (s as { id: string }).id).sort()
    expect(ids).toEqual(['s1', 's2', 's3'])
    expect((local.find((s) => (s as { id: string }).id === 's1') as { state: string }).state).toBe('running')
  })

  it('isFullFrame：只有 delta 不是全量帧', () => {
    expect(isFullFrame({ frame: 'delta' })).toBe(false)
    expect(isFullFrame({ frame: 'snapshot' })).toBe(true)
    expect(isFullFrame({ frame: 'reset' })).toBe(true)
    expect(isFullFrame({})).toBe(true)
  })

  it('不改入参', () => {
    const local = [mk('a')]
    const copy = JSON.parse(JSON.stringify(local))
    mergeStateFrame(local, { frame: 'delta', changed: [mk('b')], removed: ['a'] })
    expect(local).toEqual(copy)
  })
})
