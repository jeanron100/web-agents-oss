import type { PendingAction, Session } from '../types'

export const pendingApprovals = (actions: PendingAction[]) => actions.filter(a => a.kind === 'approval' && a.status === 'pending')

/** Pending requests override a lagging session snapshot for dashboard presentation only. */
export function withPendingApprovals(sessions: Session[], actions: PendingAction[]): Session[] {
  const ids = new Set(pendingApprovals(actions).map(a => a.sessionId))
  return sessions.map(s => ids.has(s.id) && s.state !== 'waiting_approval' ? { ...s, state: 'waiting_approval' } : s)
}

export function projectApprovals(actions: PendingAction[], session: Session, history: Session[]): PendingAction[] {
  const ids = new Set([session.id, ...history.map(s => s.id)])
  return pendingApprovals(actions).filter(a => ids.has(a.sessionId))
}
