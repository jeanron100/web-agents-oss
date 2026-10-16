import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ActionKind, PendingAction } from '../types'
import { useAppStore } from '../store/store'
import { relTime } from '../lib/format'
import { EngineBadge } from './EngineBadge'

export const kindMeta: Record<ActionKind, { icon: string; label: string }> = {
  approval: { icon: '🛡', label: '权限审批' },
  question: { icon: '?', label: '提问待答' },
  plan: { icon: '✦', label: '计划待确认' },
  review: { icon: '✓', label: '完成待验收' },
}

export function InboxItemCard({ action }: { action: PendingAction }) {
  const navigate = useNavigate()
  const resolveAction = useAppStore((s) => s.resolveAction)
  const session = useAppStore((st) => st.sessions.find((s) => s.id === action.sessionId))
  const [answer, setAnswer] = useState('')
  const [expanded, setExpanded] = useState(false)
  const resolved = action.status !== 'pending'
  const meta = kindMeta[action.kind]

  const crumb = session ? `${session.serverId} / ${session.project}` : action.sessionId

  return (
    <div className={`inbox-card ${resolved ? 'inbox-card--resolved' : ''}`}>
      <div className="inbox-card__head">
        <span className={`kind-icon kind-icon--${action.kind}`}>{meta.icon}</span>
        <span className={`kind-tag kind-tag--${action.kind}`}>{meta.label}</span>
        <span className="inbox-card__time">{relTime(action.createdAt)}</span>
      </div>

      <div className="inbox-card__title">
        {action.kind === 'approval' ? (
          <>{action.title} <span className="mono">{action.detail}</span></>
        ) : (
          action.title
        )}
      </div>

      {action.kind === 'plan' && (
        <div style={{ marginTop: 6 }}>
          {expanded && <pre className="cmd-block" style={{ color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>{action.detail}</pre>}
          <button className="quick-chip" onClick={() => setExpanded(!expanded)}>
            {expanded ? '收起计划' : '展开计划全文'}
          </button>
        </div>
      )}
      {action.kind === 'review' && (
        <div className="inbox-card__crumb">{action.detail}</div>
      )}

      <div className="inbox-card__crumb">
        {crumb}
        {session && <span style={{ marginLeft: 8 }}><EngineBadge engine={session.engine} model={session.model} /></span>}
      </div>

      {resolved ? (
        <div className="inbox-card__foot">
          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>已处理：{action.resolution}</span>
        </div>
      ) : (
        <>
          {action.kind === 'question' && action.quickReplies && (
            <div className="inbox-card__foot" style={{ flexWrap: 'wrap' }}>
              <div className="quick-chips">
                {action.quickReplies.map((q) => (
                  <button key={q} className="quick-chip" onClick={() => resolveAction(action.id, q)}>{q}</button>
                ))}
              </div>
            </div>
          )}
          <div className="inbox-card__foot">
            {action.kind === 'question' && (
              <input
                className="composer__input"
                style={{ minHeight: 34, padding: '6px 12px' }}
                placeholder="输入回复…"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && answer.trim()) resolveAction(action.id, answer.trim()) }}
              />
            )}
            {action.kind === 'approval' && (
              <button className="btn btn--approve" onClick={() => navigate(`/inbox/${action.id}`)}>审批</button>
            )}
            {action.kind === 'question' && (
              <button className="btn btn--question" disabled={!answer.trim()} onClick={() => resolveAction(action.id, answer.trim())}>回答</button>
            )}
            {action.kind === 'plan' && (
              <>
                <button className="btn btn--ghost" onClick={() => resolveAction(action.id, '打回修改')}>打回修改</button>
                <button className="btn btn--plan" style={{ marginLeft: 0 }} onClick={() => resolveAction(action.id, '批准执行')}>批准执行</button>
              </>
            )}
            {action.kind === 'review' && (
              <>
                <button className="btn btn--ghost" onClick={() => navigate(`/session/${action.sessionId}?tab=diff`)}>查看 diff</button>
                <button className="btn btn--review" style={{ marginLeft: 0 }} onClick={() => resolveAction(action.id, '标记完成')}>验收</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
