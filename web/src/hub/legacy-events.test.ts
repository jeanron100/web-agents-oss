import { describe, it, expect } from 'vitest'
import type { ChatEvent } from '../types'
import { repairLegacyEvents } from './legacy-events'

const event = (id: string, ts: number, text: string, seq?: number, type: 'user' | 'assistant' = 'user'): ChatEvent =>
  ({ id, sessionId: 's', ts, text, type, ...(seq == null ? {} : { seq }) })

describe('旧 agent 历史/实时交界的顺序', () => {
  const live = [event('ev-1', 100, 'test', 1), event('ev-2', 200, '答复', 2, 'assistant')]
  const disk = [event('rollout-1', 110, 'test'), event('rollout-2', 210, '答复', undefined, 'assistant')]
  it('Codex 整段历史 + 实时重复，不能把旧问题排在新答复之后', () => {
    expect(repairLegacyEvents([...disk, ...live], [], false)).toEqual(live)
  })
  it('旧 append 把历史搬到尾部时，保留已有实时段并恢复正确顺序', () => {
    const next = event('ev-3', 300, '再问', 3)
    expect(repairLegacyEvents([next, ...disk], live, true)).toEqual([...live, next])
  })
  it('接管前历史保留；两次真实发送相同文本不合并', () => {
    const old = event('rollout-old', 50, '旧问题')
    const repeat = event('ev-3', 300, 'test', 3)
    expect(repairLegacyEvents([old, ...disk, ...live, repeat], [], false)).toEqual([old, ...live, repeat])
  })
  it('Kimi 增量中的完整历史放回开头，落盘后替换旧 live ID', () => {
    const history = [event('kw-1', 100, '问题'), event('kw-2', 200, '回答', undefined, 'assistant')]
    const next = event('ev-3', 3000, '下一问', 3)
    const prev = [history[0], event('ev-2', 201, '回答', 2, 'assistant')]
    expect(repairLegacyEvents([next, ...history], prev, true)).toEqual([...history, next])
    const landed = event('kw-3', 3001, '下一问')
    expect(repairLegacyEvents([...history, landed], [...prev, next], false)).toEqual([...history, landed])
  })
  it('有序号的新协议和 Claude 原始顺序不变', () => {
    expect(repairLegacyEvents([event('rollout-0', 50, '旧', -1), ...live], [], false)).toBeNull()
    expect(repairLegacyEvents([event('claude-1', 50, '旧')], [], false)).toBeNull()
  })
})
