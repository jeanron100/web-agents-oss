import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getStats, useAppStore } from '../store/store'
import { StatusDot } from './StatusDot'
import type { Session } from '../types'

// 看板"消耗"= 今日成本（跨天零点清零）。每日成本由后端按模型单价逐条消息估算。

export function StatChips({ projects }: { projects: Session[] }) {
  const navigate = useNavigate()
  const stats = getStats(projects)
  const refreshSeq = useAppStore((s) => s.refreshSeq)
  const [costSince, setCostSince] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    const load = () =>
      fetch('/api/usage/daily?days=30')
        .then((r) => r.json())
        .then((d: { days?: Array<{ date: string; cost?: number }> }) => {
          if (!alive) return
          const days = d.days ?? []
          setCostSince(days.length ? (days[days.length - 1].cost ?? 0) : 0)
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [refreshSeq])

  const chips = [
    { label: '运行中', value: stats.running, state: 'running' as const },
    { label: '等待输入', value: stats.waitingInput, state: 'waiting_input' as const },
    { label: '等待审批', value: stats.waitingApproval, state: 'waiting_approval' as const },
    { label: '已完成', value: stats.done, state: 'done' as const },
  ]
  return (
    <div className="stat-chips">
      {chips.map((c) => (
        <div
          key={c.label}
          className="stat-chip"
          role="button"
          title={`${c.label}项目，按当前服务器和时间范围统计`}
          aria-label={`${c.label}项目：${c.value}`}
          style={{ cursor: 'pointer' }}
          onClick={() => navigate(`/?state=${c.state}`)}
        >
          <div className="stat-chip__label">{c.label}</div>
          <div className="stat-chip__value">
            <StatusDot state={c.state} />
            {c.value}
          </div>
        </div>
      ))}
      <div className="stat-chip" role="button" style={{ cursor: 'pointer' }} onClick={() => navigate('/stats')}>
        <div className="stat-chip__label">消耗 · 今日 ↗</div>
        <div className="stat-chip__value mono">{costSince != null && costSince > 0 ? `$${costSince.toFixed(2)}` : '统计'}</div>
      </div>
    </div>
  )
}
