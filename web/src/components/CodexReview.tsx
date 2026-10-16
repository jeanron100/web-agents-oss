import { useEffect, useRef, useState } from 'react'
import { subscribeSessionEvents } from '../hub/client'
import { useAppStore } from '../store/store'
import { ChatMessage } from './ChatMessage'
import type { PermissionMode, Session } from '../types'

// 「Codex 对话流」Tab（功能4 泛化，engine-split-session-streams → codexchat 对齐重构）：展示该项目的
// Codex 主会话（由 SessionDetail 用 projectEngineSession 选出，含影子会话），界面对齐「对话流」
// （chat 面板）——真实 Codex 对话（事件流+输入框+工具栏），不再是"审 git diff"的临时审核流程。
// 项目还没有 Codex 会话时，给「新建 Codex 对话」空态：填指令 + 选 effort（仅创建时可设，运行中不可
// 热切）直接拉起一个 Codex 会话；拉起后即成为该项目的 Codex 主会话（下一轮 /api/state 回写后
// SessionDetail 会把它选为 codexSession）。
//
// 后端能力约束（已核实）：Codex model 不可选（app-server 用配置模型，createSession 不收 model）→
// 只读展示；effort 仅创建时可设（setLlmEffort 运行中返回 false）→ 只在空态选择，运行中只读展示；
// 运行中可切的只有：审批模式（setMode）、中断、释放。
//
// D5 兼容：刚拉起、服务端 /api/state 尚未回写时，用 localStorage 兜底记住 id（旧键
// agent-console-review/<claudeId> 沿用），一旦项目里出现服务端确认的 codexSession 即让位给它。

const lsKey = (claudeId: string) => `agent-console-review/${claudeId}`

// Codex 三档审批模式（与 codex-driver CODEX_MODES 对齐，下一回合生效）。审批切换放在底部 composer 工具栏，
// 与「Claude 对话流」的模式切换同位置（顶栏只放模型/effort），保证两 Tab 布局一致。
const CODEX_MODES_ORDER: PermissionMode[] = ['untrusted', 'on-request', 'never']
const CODEX_MODE_LABEL: Record<string, string> = { untrusted: '审批', 'on-request': '自动', never: '全权' }
// effort 仅创建时可设，且 Codex 不支持 xhigh/max（与 Claude 的 5 档不同）
const CODEX_EFFORTS = ['low', 'medium', 'high'] as const

export function CodexReview({ codexSession, project, claudeSessionId, serverId, cwd }: {
  /** 项目的 Codex 主会话（服务端 /api/state 确认，含影子）；无则空态 */
  codexSession: Session | null
  project: string
  /** 用于新拉起会话的本地兜底指针归属锚点（项目的 Claude 主会话 id，或当前会话自身） */
  claudeSessionId: string
  /** 新建 Codex 会话的目标服务器/目录（取当前打开会话的 serverId/cwd） */
  serverId: string
  cwd: string
}) {
  const [pendingId, setPendingId] = useState<string | null>(() => localStorage.getItem(lsKey(claudeSessionId)))
  // 「释放到终端」后强制视图回到空态，直到一个新会话 id 到来（服务端把它转成影子会话，id 会变）
  const [releasedId, setReleasedId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [effort, setEffort] = useState<string>('high')
  const [draft, setDraft] = useState('')
  // 影子会话「恢复会话」失败时的可读提示（409=终端中活跃/其他错误）；按钮始终保留可重试，不折叠成死胡同
  const [takeoverErr, setTakeoverErr] = useState<string | null>(null)

  // 服务端已确认的项目 Codex 会话一旦出现（或变更），本地兜底指针即可清理，避免和真实会话打架
  useEffect(() => {
    if (codexSession && pendingId && codexSession.id !== pendingId) {
      localStorage.removeItem(lsKey(claudeSessionId))
      setPendingId(null)
    }
  }, [codexSession?.id, pendingId, claudeSessionId])

  const forcedEmpty = !!(codexSession && releasedId && codexSession.id === releasedId)
  const reviewId = forcedEmpty ? null : (codexSession?.id ?? pendingId)
  // 刚创建、pendingId 尚未进入 /api/state 时回退到全局查找；正常情况优先使用项目选出的主会话。
  const foundSession = useAppStore((st) => st.sessions.find((s) => s.id === reviewId))
  const reviewSession = codexSession && codexSession.id === reviewId ? codexSession : foundSession
  const events = useAppStore((st) => (reviewId ? st.events[reviewId] ?? [] : []))
  const pendingActions = useAppStore((st) => st.pendingActions)
  const approvals = pendingActions.filter((a) =>
    a.sessionId === reviewId && a.status === 'pending' && a.kind === 'approval',
  )
  const source = useAppStore((st) => st.source)
  const sendMessage = useAppStore((st) => st.sendMessage)
  const interrupt = useAppStore((st) => st.interrupt)
  const setMode = useAppStore((st) => st.setMode)
  const resolveAction = useAppStore((st) => st.resolveAction)
  const endRef = useRef<HTMLDivElement>(null)

  // 只读订阅该 Codex 会话事件——无论它是不是当前打开的会话（跨会话展示只读约束），不触发接管
  useEffect(() => {
    if (!reviewId || source !== 'live') return
    return subscribeSessionEvents(reviewId)
  }, [reviewId, source])

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [events.length, approvals.length])

  // 切到另一个会话时清掉上一个会话遗留的「恢复失败」提示，避免串会话误导
  useEffect(() => { setTakeoverErr(null) }, [reviewId])

  const start = async () => {
    if (starting || !prompt.trim()) return
    setStarting(true); setErr(null)
    try {
      const res = await fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId, cwd, engine: 'codex', prompt: prompt.trim(), effort }),
      })
      const data = await res.json()
      if (!res.ok || !data.id) { setErr(data.error || '创建 Codex 对话失败'); return }
      localStorage.setItem(lsKey(claudeSessionId), data.id)
      setPendingId(data.id)
      setReleasedId(null)
    } catch { setErr('请求失败') } finally { setStarting(false) }
  }

  const send = () => {
    if (!draft.trim() || !reviewId) return
    sendMessage(reviewId, draft.trim())
    setDraft('')
  }

  const release = async () => {
    if (!reviewId || busy) return
    setBusy(true)
    try {
      await fetch(`/api/session/${reviewId}/release`, { method: 'POST' })
      localStorage.removeItem(lsKey(claudeSessionId))
      setPendingId(null)
      setReleasedId(reviewId)
    } finally { setBusy(false) }
  }

  // 恢复终端里的 Codex 影子会话。按钮恒可点——活跃态（running/waiting_input）由后端 409 拦截（避免与
  // 终端双写），此时给可读提示但按钮仍留着可重试；成功后服务端补出同 id 的平台记录，下一轮 /api/state
  // 回写即让位给可交互的输入框。
  const takeover = async () => {
    if (!reviewId || busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/session/${reviewId}/takeover`, { method: 'POST' })
      if (res.ok) { setTakeoverErr(null); return }
      let msg = res.status === 409 ? '该会话正在终端中活跃，待其空闲后再恢复' : '恢复会话失败'
      try {
        const data = await res.json()
        if (data?.error) msg = data.error
      } catch { /* 无 JSON body，用默认提示 */ }
      setTakeoverErr(msg)
    } catch { setTakeoverErr('请求失败') } finally { setBusy(false) }
  }

  if (!reviewId) {
    return (
      <div className="review">
        <div className="review__intro">
          <div className="review__intro-h">✕ 新建 Codex 对话</div>
          <p className="review__intro-p">为 <b>{project}</b> 起一个 Codex 会话，像对话流一样直接交流——不限于审 git diff。</p>
          <textarea
            className="review__focus"
            style={{ minHeight: 88, resize: 'vertical' }}
            placeholder="给 Codex 的指令…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="detail-section__label" style={{ marginBottom: 6 }}>Effort（思考强度，仅创建时可设）</div>
          <select
            className="review__focus"
            style={{ width: 160 }}
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
          >
            {CODEX_EFFORTS.map((ef) => <option key={ef} value={ef}>{ef}</option>)}
          </select>
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
            模型由 Codex 配置决定，不可在此选择
          </p>
          <button className="btn btn--primary" disabled={starting || !prompt.trim()} onClick={start}>
            {starting ? '正在创建…' : '▶ 新建 Codex 对话'}
          </button>
          {err && <div className="review__err">{err}</div>}
        </div>
      </div>
    )
  }

  // 影子 Codex 会话（终端里跑的，非 Web 端拉起）：底部恒给「恢复会话」按钮，不放可发送的输入框/工具栏
  const isShadow = reviewSession?.origin === 'shadow'

  // 注意：不再在此渲染 review__head 子头部——会话状态/模型/effort/审批 已上移到详情页顶栏（headSession），
  // 与「Claude 对话流」Tab 同位置同风格，避免"Codex 多挂一条子头部、模型信息位置不一致"的布局割裂。
  return (
    <div className="review">
      <div className="review__chat">
        {events.length === 0 && <div className="empty-state">暂无消息…</div>}
        {events.map((e) => <ChatMessage key={e.id} event={e} engine="codex" />)}
        {approvals.map((approval) => (
          <div className="inbox-card" style={{ borderColor: 'rgba(245,158,11,0.55)' }} key={approval.id}>
            <div className="inbox-card__head">
              <span className="kind-icon kind-icon--approval">🛡</span>
              <span className="kind-tag kind-tag--approval">Codex 等待权限审批</span>
            </div>
            <div className="inbox-card__title">
              {approval.title} <span className="mono">{approval.detail}</span>
            </div>
            <div className="inbox-card__foot" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn--sm btn--approve" onClick={() => resolveAction(approval.id, '允许一次')}>允许一次</button>
              <button className="btn btn--sm btn--ghost" style={{ marginLeft: 0 }} onClick={() => resolveAction(approval.id, '本会话始终允许')}>本会话始终允许</button>
              <button className="btn btn--sm btn--danger-outline" style={{ marginLeft: 0 }} onClick={() => resolveAction(approval.id, '拒绝')}>拒绝</button>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {isShadow ? (
        <div className="review__composer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div className="composer__row" style={{ maxWidth: 'none', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-3)', fontSize: 12.5, flex: 1 }}>
              终端里的 Codex 影子会话 · 恢复后可在此直接对话
            </span>
            <button className="btn btn--primary" disabled={busy} onClick={takeover}>
              {busy ? '恢复中…' : '↻ 恢复会话'}
            </button>
          </div>
          {takeoverErr && <div className="review__err">{takeoverErr}</div>}
        </div>
      ) : (
        <div className="review__composer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div className="composer__row" style={{ maxWidth: 'none' }}>
            <textarea
              className="composer__input"
              rows={1}
              placeholder={approvals.length ? `等待 ${approvals.length} 个审批；继续发送的消息会排队…` : '给 Codex 发消息…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            />
            <button className="composer__send" title="发送" onClick={send}>➤</button>
          </div>
          <div className="composer__toolbar">
            <button className="composer__tool" onClick={() => interrupt(reviewId)}>⏻ 中断</button>
            {reviewSession && (
              <button
                className="composer__tool"
                onClick={() => setMode(reviewId, CODEX_MODES_ORDER[(CODEX_MODES_ORDER.indexOf(reviewSession.mode) + 1) % CODEX_MODES_ORDER.length])}
                title="Codex 审批模式（下一回合生效）：审批=每条非白名单命令必审 · 自动=模型按需审批 · 全权=不审批+完全访问"
              >
                ⇄ 审批：{CODEX_MODE_LABEL[reviewSession.mode] ?? reviewSession.mode}
              </button>
            )}
            <button className="composer__tool" disabled={busy} onClick={release} title="结束 Web 端进程，可在终端接走">
              ⏏ 释放到终端
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
