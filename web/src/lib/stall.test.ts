import { describe, it, expect } from 'vitest'
import { stallSecs, isStalled, STALL_HINT_SECS } from './stall'
import type { Session } from '../types'

const mk = (over: Partial<Session>): Session => ({
  id: 's', serverId: 'srv', project: 'p', branch: '', engine: 'claude', model: 'Opus',
  mode: 'default', state: 'running', summary: '', startedAt: 1, lastActiveAt: 0,
  cost: 0, tokens: 0, origin: 'platform',
  ...over,
} as Session)

describe('stall 看门狗 (gap #5)', () => {
  const now = 1_000_000_000

  it('平台 running 越阈值：stallSecs 真实秒数、isStalled=true', () => {
    const s = mk({ origin: 'platform', state: 'running', lastActiveAt: now - 200_000 }) // 200s
    expect(stallSecs(s, now)).toBe(200)
    expect(isStalled(s, now)).toBe(true)
  })

  it('平台 running 未越阈值（< 180s）：isStalled=false', () => {
    const s = mk({ origin: 'platform', state: 'running', lastActiveAt: now - 60_000 }) // 60s
    expect(stallSecs(s, now)).toBe(60)
    expect(isStalled(s, now)).toBe(false)
  })

  it('影子 running 不判卡住：一律 0 / false（90s 内必有写入，天然不停更）', () => {
    const s = mk({ origin: 'shadow', state: 'running', lastActiveAt: now - 999_000 })
    expect(stallSecs(s, now)).toBe(0)
    expect(isStalled(s, now)).toBe(false)
  })

  it('平台非 running（idle/waiting）不判卡住', () => {
    expect(isStalled(mk({ origin: 'platform', state: 'idle', lastActiveAt: now - 999_000 }), now)).toBe(false)
    expect(isStalled(mk({ origin: 'platform', state: 'waiting_input', lastActiveAt: now - 999_000 }), now)).toBe(false)
  })

  it('Codex 平台 running 同样纳入（引擎无关）', () => {
    const s = mk({ engine: 'codex', origin: 'platform', state: 'running', lastActiveAt: now - 300_000 })
    expect(isStalled(s, now)).toBe(true)
  })

  it('时钟早于 lastActiveAt（异常）：不为负', () => {
    expect(stallSecs(mk({ origin: 'platform', state: 'running', lastActiveAt: now + 5_000 }), now)).toBe(0)
  })

  it('阈值常量为 180s', () => { expect(STALL_HINT_SECS).toBe(180) })
})
