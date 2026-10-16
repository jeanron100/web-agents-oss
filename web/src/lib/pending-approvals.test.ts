import { describe, expect, it } from 'vitest'
import type { PendingAction, Session } from '../types'
import { projectApprovals, withPendingApprovals } from './pending-approvals'
const session = (id: string, engine: Session['engine'] = 'codex') => ({ id, engine, state: 'idle', serverId: 's1', project: 'demo' } as Session)
const action = (id: string, sessionId: string, status: PendingAction['status'] = 'pending', kind: PendingAction['kind'] = 'approval') => ({ id, sessionId, status, kind } as PendingAction)

describe('看板项目审批汇总', () => {
  it('上次打开的主会话空闲时，折叠的其他引擎审批仍可见，操作保留真实 action ID', () => {
    const head = session('head', 'claude'), other = session('other', 'kimi')
    const actions = [action('a1', 'other'), action('a2', 'other'), action('outside', 'unrelated')]
    expect(projectApprovals(actions, head, [other]).map(a => a.id)).toEqual(['a1', 'a2'])
  })
  it('实际待审批覆盖滞后空闲状态，计数与筛选按会话去重且不改原始状态', () => {
    const original = [session('a'), session('b')]
    const projected = withPendingApprovals(original, [action('p1', 'a'), action('p2', 'a')])
    expect(projected.filter(s => s.state === 'waiting_approval').map(s => s.id)).toEqual(['a'])
    expect(original[0].state).toBe('idle')
    expect(projected[1]).toBe(original[1])
  })
  it('审批解决/过期后不再覆盖，计划与验收不冒充权限审批', () => {
    const s = session('a')
    const actions = [action('p1', 'a', 'resolved'), action('p2', 'a', 'expired'), action('p3', 'a', 'pending', 'review')]
    expect(projectApprovals(actions, s, [])).toEqual([])
    expect(withPendingApprovals([s], actions)[0]).toBe(s)
  })
})
