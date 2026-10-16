import { useMemo, useState } from 'react'
import type { Server, Session } from '../types'
import { sortSessions, projectHeadSession, useAppStore } from '../store/store'
import { fmtTokens, money } from '../lib/format'
import { SessionCard } from './SessionCard'

/**
 * 按项目聚合：每个项目一张卡（主会话），其余会话折叠在卡内。
 * 主会话跟随当前工作（待审批 / 运行中 / 最近活动），上次选择只用于同时间的并列项。
 */
export function groupByProject(
  sessions: Session[], lastOpened: Record<string, string> = {},
): Array<{ latest: Session; history: Session[] }> {
  const byProject = new Map<string, Session[]>()
  for (const s of sortSessions(sessions)) {
    const list = byProject.get(s.project) ?? []
    list.push(s)
    byProject.set(s.project, list)
  }
  return [...byProject.values()].map((list) => {
    const sorted = [...list].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    const latest = projectHeadSession(sorted, lastOpened)
    return { latest, history: sorted.filter((s) => s.id !== latest.id) }
  })
}

export function ServerGroup({ server, sessions, totals }: {
  server: Server
  sessions: Session[]
  totals?: { cost: number; tokens: number }
}) {
  const [open, setOpen] = useState(true)
  const lastSessions = useAppStore((s) => s.lastSessions)
  // sessions 引用稳定时（空轮询）分组结果不重算，history 数组引用稳定 → SessionCard.memo 生效。
  // lastSessions 只在用户真的切了会话时换引用（rememberSession 里同值直接返回原 state），不破坏这层缓存。
  const groups = useMemo(() => groupByProject(sessions, lastSessions), [sessions, lastSessions])

  return (
    <section className={`server-group ${server.online ? '' : 'server-group--offline'}`}>
      <button className="server-group__head" onClick={() => setOpen(!open)}>
        <span className="server-group__flag">{server.flag}</span>
        <span className="server-group__name">{server.name}</span>
        {totals && (totals.cost > 0 || totals.tokens > 0) && (
          <span className="server-group__totals">
            {totals.cost > 0 && <b>{money(totals.cost)}</b>}
            {totals.tokens > 0 && <span>{fmtTokens(totals.tokens)} tok</span>}
          </span>
        )}
        <span
          className={`server-group__status server-group__status--${server.online ? 'online' : 'offline'}`}
          style={server.stale ? { color: 'var(--st-approval)' } : undefined}
        >
          {server.online ? '在线' : server.stale ? '暂不可达 · 沿用上次' : '离线'}
        </span>
        <span className={`server-group__chev ${open ? 'server-group__chev--open' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="server-group__cards">
          {groups.map(({ latest, history }) => (
            <SessionCard key={latest.project} session={latest} history={history} />
          ))}
        </div>
      )}
    </section>
  )
}
