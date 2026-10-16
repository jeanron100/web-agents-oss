import { memo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { Session } from '../types'
import { projectApprovals } from '../lib/pending-approvals'
import { starKey, useAppStore, projectTodayActiveMs } from '../store/store'
import { money, relTime, fmtDur } from '../lib/format'
import { isStalled, stallSecs } from '../lib/stall'
import { estCostOf } from '../lib/cost'
import { ActionSheet, SheetAction } from './ActionSheet'
import { EngineBadge } from './EngineBadge'
import { StateText, StatusDot } from './StatusDot'

function SessionCardImpl({ session, history = [], showServer = false, category, categories, onSetCategory, onAddCategory }: {
  session: Session
  history?: Session[]
  showServer?: boolean
  category?: string                       // 当前分类（应用视角传入）
  categories?: string[]                   // 可选分类列表
  onSetCategory?: (cat: string) => void   // 改分类回调；传入即在长按菜单出现「分类」
  onAddCategory?: (name: string) => void  // 新建分类回调
}) {
  const navigate = useNavigate()
  const [showHistory, setShowHistory] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [catSheetOpen, setCatSheetOpen] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = useRef(false)
  const starred = useAppStore((s) => s.starred.includes(starKey(session.serverId, session.project)))
  const toggleStar = useAppStore((s) => s.toggleStar)
  const toggleHideProject = useAppStore((s) => s.toggleHideProject)
  const interrupt = useAppStore((s) => s.interrupt)
  const resolveAction = useAppStore((s) => s.resolveAction)
  const pendingActions = useAppStore((s) => s.pendingActions)
  const approvals = projectApprovals(pendingActions, session, history)
  const approval = approvals[0]
  const approvalSession = [session, ...history].find(s => s.id === approval?.sessionId)
  const isApproval = !!approval || session.state === 'waiting_approval'
  const todayActiveMs = projectTodayActiveMs(session, history)
  // 订阅墙钟 tick：即便 session 本身未变（memo 判定相同），也每 ~30s 强制重渲染一次，
  // 让 relTime(session.lastActiveAt) 这类"N 分钟前"标签随时间推进，而不是冻结在上次数据到达时刻；
  // 同一 tick 也顺带重算下面的"可能卡住"看门狗（gap #5），无需额外计时器。
  useAppStore((s) => s.clockTick)
  // 平台 running 会话距上次活动超阈值 → 卡片打"可能卡住"软标（详情页有对应的可中断提示）
  const stalled = isStalled(session, Date.now())
  const stallMin = stalled ? Math.floor(stallSecs(session, Date.now()) / 60) : 0

  const sheetActions: SheetAction[] = [
    { label: starred ? '取消星标' : '星标项目', icon: starred ? '☆' : '★', onClick: () => toggleStar(session.serverId, session.project) },
    { label: '打开会话', icon: '💬', onClick: () => navigate(`/session/${session.id}`) },
    // 「隐藏 = 不加入项目纳管」：这台机器上这个项目会从看板、新建会话下拉、用量聚合全部消失。
    // ⚠️ 措辞要说清楚这不只是"眼不见"——用户以为只是折叠起来，结果新建会话时选不到，会来报 bug。
    // 恢复入口在「设置 → 已隐藏的项目」，隐藏时顺带告诉他去哪儿找回来。
    {
      label: '隐藏此项目（不再纳管）', icon: '🚫',
      onClick: () => {
        if (confirm(`隐藏「${session.project}」？\n\n它将不再出现在看板、新建会话列表和用量统计里，服务端也不再扫描。\n历史归档不受影响，可在「设置 → 已隐藏的项目」里恢复。`)) {
          toggleHideProject(session.serverId, session.project)
        }
      },
    },
  ]
  if (session.origin === 'platform' && !session.detached && (session.state === 'running' || session.state === 'waiting_approval')) {
    sheetActions.push({ label: '中断会话', icon: '⏻', danger: true, onClick: () => interrupt(session.id) })
  }
  // 影子会话或分离态平台会话（agent 重启后）均可恢复接管；detached 的 session.id 即原 psId，后端按 alias 解析
  if ((session.origin === 'shadow' || session.detached) && session.engine === 'claude' && ['idle', 'done', 'error'].includes(session.state)) {
    sheetActions.push({
      label: '恢复会话（接管）', icon: '↻',
      onClick: async () => {
        // 分离态走 reattach（同 psId，URL 不变）；普通影子走 takeover（新 id）
        const endpoint = session.detached ? 'reattach' : 'takeover'
        const res = await fetch(`/api/session/${session.id}/${endpoint}`, { method: 'POST' })
        const data = await res.json()
        if (res.ok && data.id) navigate(`/session/${data.id}`)
      },
    })
  }
  // 标签改由卡片上始终可见的「🏷」按钮一键打开（见 row2），不再塞进长按菜单。
  // 分类面板做成单层：选已有 / 移出 / 底部常驻输入框新建——无二次弹窗、不依赖 window.prompt，最稳。
  const addCat = () => {
    const n = newCatName.trim()
    if (n) { onAddCategory?.(n); onSetCategory?.(n) }
    setNewCatName(''); setCatSheetOpen(false)
  }

  const startPress = () => {
    longPressed.current = false
    pressTimer.current = setTimeout(() => {
      longPressed.current = true
      if (navigator.vibrate) navigator.vibrate(10)
      setSheetOpen(true)
    }, 480)
  }
  const cancelPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
  }

  return (
    <div
      className={`session-card ${isApproval ? 'session-card--approval' : ''} ${starred ? 'session-card--starred' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => { if (!longPressed.current) navigate(`/session/${session.id}`) }}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/session/${session.id}`)}
      onTouchStart={startPress}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onContextMenu={(e) => { e.preventDefault(); setSheetOpen(true) }}
    >
      <div className="session-card__row1">
        <button
          className={`star-btn ${starred ? 'star-btn--on' : ''}`}
          title={starred ? '取消星标' : '星标项目'}
          onClick={(e) => { e.stopPropagation(); toggleStar(session.serverId, session.project) }}
        >
          {starred ? '★' : '☆'}
        </button>
        <span className="session-card__project">{session.project}</span>
        <StateText state={isApproval ? 'waiting_approval' : session.state} />
      </div>
      <div className="session-card__row2">
        <EngineBadge engine={session.engine} model={session.model} />
        {[...new Set(history.map((h) => h.engine).filter((e) => e !== session.engine))]
          .map((engine) => <EngineBadge key={engine} engine={engine} />)}
        {showServer && <span>{session.serverId}</span>}
        {session.mode !== 'default' && <span>{session.mode}</span>}
        <span>·</span>
        <span>{relTime(session.lastActiveAt)}</span>
        {session.detached && <span className="detached-chip" title={session.detachedReason || '平台会话经 agent 重启已分离；历史只读，点开可恢复接管'}>{session.interrupted ? '⚠ 回合可能中断' : '⏏ 已分离'}</span>}
        {stalled && <span className="stall-chip" title="平台会话长时间无新输出，可能仍在处理或已卡住——点开可中断">⏳ {stallMin} 分钟无输出</span>}
        {estCostOf(session) > 0 && <span>· {money(estCostOf(session))}</span>}
        {todayActiveMs > 0 && <span>· 今日活跃 {fmtDur(todayActiveMs)}</span>}
        {onSetCategory ? (
          <button
            className={`cat-btn ${category ? 'cat-btn--set' : ''}`}
            title="点此设置/修改标签"
            onClick={(e) => { e.stopPropagation(); setCatSheetOpen(true) }}
          >
            🏷 {category || '添加标签'}
          </button>
        ) : category ? <span className="cat-chip">🏷 {category}</span> : null}
      </div>
      <div className="session-card__summary">
        {isApproval ? (
          <>
            {approvalSession && <EngineBadge engine={approvalSession.engine} />} 请求执行 <span className="mono">{approval?.detail ?? session.summary}</span>
          </>
        ) : (
          session.summary
        )}
      </div>
      {session.state === 'running' && session.progress != null && (
        <div className="session-card__progress">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${session.progress}%` }} />
          </div>
          <span className="session-card__pct">{Math.round(session.progress)}%</span>
          <span className="session-card__cost">{money(estCostOf(session))}</span>
        </div>
      )}
      {isApproval && approval && (
        <div className="session-card__actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <span>待审批 {approvals.length} 项</span>
          <button className="btn btn--sm btn--approve" onClick={() => resolveAction(approval.id, '允许一次')}>
            批准
          </button>
          <button className="btn btn--sm btn--danger-outline" onClick={() => resolveAction(approval.id, '拒绝')}>
            拒绝
          </button>
          <button className="btn btn--sm btn--ghost" onClick={() => navigate(`/inbox/${approval.id}`)}>
            查看详情
          </button>
          {approvals.length > 1 && <button className="btn btn--sm btn--ghost" onClick={() => navigate('/inbox')}>查看全部审批</button>}
        </div>
      )}
      {history.length > 0 && (
        <div onClick={(e) => e.stopPropagation()}>
          <button
            className="session-card__history-toggle"
            onClick={() => setShowHistory(!showHistory)}
          >
            {showHistory ? '收起' : `另有 ${history.length} 个历史会话`} {showHistory ? '▴' : '▾'}
          </button>
          {showHistory && history.map((h) => (
            <button key={h.id} className="session-card__history-row" onClick={() => navigate(`/session/${h.id}`)}>
              <StatusDot state={h.state} />
              <EngineBadge engine={h.engine} />
              <span className="session-card__history-summary">{h.summary}</span>
              <span className="session-card__history-time">{relTime(h.lastActiveAt)}</span>
            </button>
          ))}
        </div>
      )}
      {/* 弹层 portal 到 body：脱离卡片(overflow:hidden + :active transform)的子树，否则按 mousedown 时
          卡片 transform 会让 fixed 面板被裁剪/位移，导致按钮点不中（曾反复修不好的真因）。 */}
      {sheetOpen && createPortal(
        <div onClick={(e) => e.stopPropagation()}>
          <ActionSheet
            title={<><b>{session.project}</b> · {session.serverId}</>}
            actions={sheetActions}
            onClose={() => setSheetOpen(false)}
          />
        </div>, document.body)}
      {catSheetOpen && createPortal(
        <div onClick={(e) => e.stopPropagation()}>
          <div className="sheet-overlay" onClick={() => setCatSheetOpen(false)} />
          <div className="sheet-panel">
            <div className="sheet-title">分类 · <b>{session.project}</b></div>
            {(categories ?? []).map((c) => (
              <button key={c} className="sheet-action" onClick={() => { onSetCategory?.(c); setCatSheetOpen(false) }}>
                <span className="sheet-action__icon">{c === category ? '✓' : ''}</span>{c}
              </button>
            ))}
            {category && (
              <button className="sheet-action sheet-action--danger" onClick={() => { onSetCategory?.(''); setCatSheetOpen(false) }}>
                <span className="sheet-action__icon">✕</span>移出分类
              </button>
            )}
            {onAddCategory && (
              <div className="cat-new-row">
                <input
                  className="cat-input"
                  placeholder="新建分类，输入名称…"
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addCat() }}
                />
                <button className="btn btn--sm btn--primary" onClick={addCat}>添加</button>
              </div>
            )}
            <button className="sheet-action sheet-cancel" onClick={() => setCatSheetOpen(false)}>取消</button>
          </div>
        </div>, document.body)}
    </div>
  )
}

// 仅当影响渲染的字段变化时才重渲染：父组件每轮轮询传入的新 history 数组引用不再误伤
const KEYS: Array<keyof Session> = ['id', 'state', 'summary', 'mode', 'model', 'engine', 'cost', 'tokens', 'progress', 'lastActiveAt', 'origin', 'detached', 'interrupted', 'detachedReason', 'activeMsToday']
function sameSession(a: Session, b: Session): boolean {
  return KEYS.every((k) => a[k] === b[k])
}
function sameHistory(a: Session[] = [], b: Session[] = []): boolean {
  if (a.length !== b.length) return false
  return a.every((s, i) => s.id === b[i].id && s.state === b[i].state && s.summary === b[i].summary && s.activeMsToday === b[i].activeMsToday)
}

export const SessionCard = memo(
  SessionCardImpl,
  (a, b) =>
    a.showServer === b.showServer &&
    a.category === b.category &&
    (a.categories?.join() ?? '') === (b.categories?.join() ?? '') &&
    sameSession(a.session, b.session) &&
    sameHistory(a.history, b.history),
)
