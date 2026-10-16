import { useNavigate, useParams } from 'react-router-dom'
import { useAppStore } from '../store/store'
import { relTime } from '../lib/format'
import { kindMeta } from '../components/InboxItemCard'
import { engineName } from '../components/EngineBadge'
import Inbox from './Inbox'

export default function ApprovalDetail() {
  const { actionId } = useParams()
  const navigate = useNavigate()
  const action = useAppStore((s) => s.pendingActions.find((a) => a.id === actionId))
  const session = useAppStore((st) => st.sessions.find((s) => s.id === action?.sessionId))
  const server = useAppStore((st) => st.servers.find((sv) => sv.id === session?.serverId))
  const resolveAction = useAppStore((s) => s.resolveAction)

  if (!action) {
    return (
      <div className="approval-root page">
        <div className="empty-state">待办不存在或已被清理</div>
      </div>
    )
  }

  const resolved = action.status !== 'pending'
  const act = (resolution: string) => {
    resolveAction(action.id, resolution)
    navigate(-1)
  }

  return (
    <>
      <div className="approval-bg"><Inbox /></div>
      <div className="approval-overlay" onClick={() => navigate(-1)} />
      <div className="approval-root page">
        <header className="page-head">
          <button className="icon-btn" onClick={() => navigate(-1)}>←</button>
          <h1 className="page-head__title" style={{ fontSize: 17 }}>审批详情</h1>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{relTime(action.createdAt)}</span>
        </header>

        <div className="inbox-card__head" style={{ marginTop: 6 }}>
          <span className={`kind-icon kind-icon--${action.kind}`}>{kindMeta[action.kind].icon}</span>
          <span className={`kind-tag kind-tag--${action.kind}`}>{kindMeta[action.kind].label}</span>
        </div>

        <h2 style={{ fontSize: 17, margin: '14px 0 4px' }}>
          {action.title} <span className="mono" style={{ color: 'var(--st-approval)' }}>{action.detail}</span>
        </h2>
        <div className="detail-kv">
          {session && (
            <>
              {session.serverId} / {session.project}
              <br />
              {engineName[session.engine]} · {session.model}
            </>
          )}
        </div>

        <div className="detail-section">
          <div className="detail-section__label">命令预览</div>
          <pre className="cmd-block">{action.detail}</pre>
        </div>

        {action.risk && (
          <div className="detail-section">
            <div className="detail-section__label">⚠️ 风险提示</div>
            <div className="risk-note">{action.risk}</div>
          </div>
        )}

        {action.context && (
          <div className="detail-section">
            <div className="detail-section__label">上下文</div>
            <div className="detail-kv">{action.context}</div>
          </div>
        )}

        <div className="detail-section">
          <div className="detail-section__label">影响范围</div>
          <div className="detail-kv">
            服务器：<b>{server ? `${server.name}（${server.region}）` : session?.serverId}</b>
            <br />
            项目：<b>{session?.project}</b>
          </div>
        </div>

        {resolved ? (
          <div className="approval-actions">
            <div className="empty-state" style={{ padding: '24px 0' }}>已处理：{action.resolution}</div>
          </div>
        ) : (
          <div className="approval-actions">
            <button className="btn btn--block btn--approve" onClick={() => act('允许一次')}>允许一次</button>
            <button className="btn btn--block btn--approve-outline" onClick={() => act('本会话始终允许')}>本会话始终允许</button>
            <button className="btn btn--block btn--danger-outline" onClick={() => act('拒绝')}>拒绝</button>
          </div>
        )}
      </div>
    </>
  )
}
