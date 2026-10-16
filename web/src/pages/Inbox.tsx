import { useState } from 'react'
import type { ActionKind } from '../types'
import { Link } from 'react-router-dom'
import { pendingCount, useAppStore } from '../store/store'
import { InboxItemCard } from '../components/InboxItemCard'
import { PullRefresh } from '../components/PullRefresh'

const segs: Array<{ key: ActionKind | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'approval', label: '审批' },
  { key: 'question', label: '提问' },
  { key: 'plan', label: '计划' },
  { key: 'review', label: '验收' },
]

export default function Inbox() {
  const actions = useAppStore((s) => s.pendingActions)
  // 数据层告警（看门狗）。曾经做成顶部常驻横幅，但它会盖住页头、且每页都跟着走——
  // 告警本质上就是「一条需要你处理的事」，归属收件箱，不该霸占全局顶栏。
  const alerts = useAppStore((s) => s.alerts)
  const [seg, setSeg] = useState<ActionKind | 'all'>('all')

  const pending = actions.filter((a) => a.status === 'pending')
  const countOf = (k: ActionKind | 'all') =>
    k === 'all' ? pending.length : pending.filter((a) => a.kind === k).length

  const shown = actions
    .filter((a) => seg === 'all' || a.kind === seg)
    .filter((a) => a.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
  // 审批类置顶
  shown.sort((a, b) => (a.kind === 'approval' ? -1 : 0) - (b.kind === 'approval' ? -1 : 0))

  return (
    <PullRefresh>
    <div className="page">
      <header className="page-head">
        <h1 className="page-head__title">
          收件箱
          {pendingCount(actions) > 0 && <span className="badge">{pendingCount(actions)}</span>}
        </h1>
        <button className="icon-btn" title="筛选">⚲</button>
      </header>

      {alerts && alerts.firing.length > 0 && (
        <div className="alert-card" role="alert">
          <div className="alert-card__head">
            <span className="alert-card__tag">⚠ 数据层告警 {alerts.firing.length}</span>
            {!alerts.channel.deliverable && (
              <Link className="alert-card__link" to="/settings">开启推送 →</Link>
            )}
          </div>
          {alerts.firing.map((f) => (
            <div key={f.key} className="alert-card__item">{f.text || f.key}</div>
          ))}
        </div>
      )}

      <div className="seg-tabs">
        {segs.map((s) => (
          <button key={s.key} className={`seg-tab ${seg === s.key ? 'active' : ''}`} onClick={() => setSeg(s.key)}>
            {s.label}
            {countOf(s.key) > 0 && <span className="seg-tab__count">{countOf(s.key)}</span>}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state__icon">🎉</div>
          <div>全部处理完毕</div>
        </div>
      ) : (
        <div className="inbox-list">
          {shown.map((a) => (
            <InboxItemCard key={a.id} action={a} />
          ))}
        </div>
      )}
    </div>
    </PullRefresh>
  )
}
