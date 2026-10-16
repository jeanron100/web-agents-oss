import { ExecTrace } from '../components/ExecTrace'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { PermissionMode, Session, MessageBehavior } from '../types'
import { subscribeSessionEvents } from '../hub/client'
import { useAppStore, sessionsOfProject, projectEngineSession, projectHistoryList, sortSessions, snapshotSessionMeta, resolveReleaseTarget, pickSuccessorSession } from '../store/store'
import { duration, money, relTime, fmtTokens } from '../lib/format'
import { STALL_HINT_SECS } from '../lib/stall'
import { estCostOf } from '../lib/cost'
import { CLAUDE_MODELS, KIMI_MODELS } from '../lib/models'
import { EngineBadge, engineName } from '../components/EngineBadge'
import { ChatMessage } from '../components/ChatMessage'
import { DiffFile } from '../components/DiffView'
import { StatusDot, stateLabel } from '../components/StatusDot'
import { CodeTree } from '../components/CodeTree'
import { CodexReview } from '../components/CodexReview'
import { FileEditor } from '../components/FileEditor'
import { CodexSendMode } from '../components/CodexSendMode'

type TabKey = 'chat' | 'kimi' | 'diff' | 'todo' | 'info' | 'history' | 'code' | 'review' | 'trace'

const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'auto']
// Codex 三档审批模式（与 codex-driver CODEX_MODES 对齐，下一回合生效）
const CODEX_MODES_ORDER: PermissionMode[] = ['untrusted', 'on-request', 'never']
const CODEX_MODE_LABEL: Record<string, string> = { untrusted: '审批', 'on-request': '自动', never: '全权' }

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// Codex 现在**可切模型**（2026-07-15：gpt-5.6-sol 默认 + gpt-5.5/5.4/5.4-mini），模型与各自可选
// effort 档从 /api/usage/codex-models 拉取（app-server model/list）。此处仅作拉取前的兜底档位。
type CodexModel = { id: string; displayName: string; efforts: string[]; isDefault: boolean }
const CODEX_EFFORTS_FALLBACK = ['low', 'medium', 'high', 'xhigh']
// 长回合停更看门狗阈值（秒）：详情页对话流据此提示"可能仍在处理或已卡住"，看板卡片同源自 lib/stall。

// 详情页内的可折叠区块（文件变更 / Todo 并入「详情」后使用）
function FoldSection({ id, title, badge, defaultOpen = true, children }: {
  id?: string; title: string; badge?: ReactNode; defaultOpen?: boolean; children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  // events 数据异步到达：defaultOpen 由 false→true（内容出现）时自动展开；
  // 但用户一旦手动折叠/展开过就尊重用户选择，不再自动跟随。
  const touched = useRef(false)
  useEffect(() => { if (!touched.current) setOpen(defaultOpen) }, [defaultOpen])
  return (
    <div className="fold-sec" id={id}>
      <button className="fold-sec__head" onClick={() => { touched.current = true; setOpen((v) => !v) }} aria-expanded={open}>
        <span className={`fold-sec__chev ${open ? 'fold-sec__chev--open' : ''}`}>▾</span>
        <span className="fold-sec__title">{title}</span>
        {badge != null && <span className="fold-sec__badge">{badge}</span>}
      </button>
      {open && <div className="fold-sec__body">{children}</div>}
    </div>
  )
}

// 对话流里的文件/相对路径链接 → 在会话内只读查看器打开（复用 /api/session/:id/file，限会话 cwd 内）。
// 弹层 portal 到 body，避开卡片 transform/overflow 的裁剪。
function FileViewerModal({ sessionId, href, running, onClose }: { sessionId: string; href: string; running: boolean; onClose: () => void }) {
  const [meta] = useState(() => {
    const [path, frag = ''] = href.split('#')
    const lm = /^L(\d+)/.exec(frag)
    return { path, line: lm ? Number(lm[1]) : null }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fv-overlay" onClick={onClose}>
      <div className="fv-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fv-head">
          <span className="fv-path mono">{meta.path}{meta.line ? `:${meta.line}` : ''}</span>
          <button className="icon-btn" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="fv-body">
          <FileEditor sessionId={sessionId} path={meta.path} sessionRunning={running} />
        </div>
      </div>
    </div>,
    document.body,
  )
}

// 深链命中的会话 id 已不在当前 state（agent 重启退回影子态换了新 id，或超出各项目扫描窗口老化掉）
// 时渲染的过渡页：从本地快照找回它曾属于哪个项目，引导改道到该项目当前会话，取代干巴巴的
// "会话不存在"（稳定性 #8）。独立成子组件持有自己的 useEffect，避免早退在父组件里造成条件 Hook。
function SessionNotFound({ sessionId, allSessions }: { sessionId?: string; allSessions: Session[] }) {
  const navigate = useNavigate()
  const meta = sessionId ? snapshotSessionMeta(sessionId) : null
  const sameProject = meta ? sortSessions(sessionsOfProject(allSessions, meta.serverId, meta.project)) : []
  // ⚠️ 必须跳过 error 态会话（2026-08-21 死循环的第二环，见 store.ts#pickSuccessorSession）：
  // 原来是 `sameProject.find(...) ?? sameProject[0]`，不看状态 ⇒ 把用户从一个死胡同自动送进
  // 另一条同样出错的会话，「清理此会话」按钮又出现，两条死会话互相踢皮球、永远清不掉。
  const successor = meta ? pickSuccessorSession(sameProject, meta.engine) : null

  // 有后继会话可去：短暂展示过渡文案后自动改道，给用户一眼看清"为什么跳走了"的机会
  useEffect(() => {
    if (!successor) return
    const t = setTimeout(() => navigate(`/session/${successor.id}`, { replace: true }), 1200)
    return () => clearTimeout(t)
  }, [successor?.id, navigate])

  if (!meta) {
    return (
      <div className="page">
        <div className="empty-state">会话不存在或已结束 —— 可能因 agent 重启退回影子态。请返回看板重新进入。</div>
        <div style={{ textAlign: 'center' }}>
          <button className="btn btn--sm btn--ghost" onClick={() => navigate('/')}>返回看板</button>
        </div>
      </div>
    )
  }

  if (!successor) {
    return (
      <div className="page">
        <div className="empty-state">「{meta.project}」的这个会话已结束或退回影子态，当前无同项目会话</div>
        <div style={{ textAlign: 'center' }}>
          <button className="btn btn--sm btn--ghost" onClick={() => navigate('/')}>返回看板</button>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="empty-state">
        该会话已退回影子态或已老化（可能因 agent 重启）· 正在前往「{meta.project}」的当前会话…
      </div>
      <div style={{ textAlign: 'center', display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button className="btn btn--sm btn--primary" onClick={() => navigate(`/session/${successor.id}`, { replace: true })}>立即前往</button>
        <button className="btn btn--sm btn--ghost" onClick={() => navigate('/')}>返回看板</button>
      </div>
    </div>
  )
}

export default function SessionDetail() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab')
  const allSessions = useAppStore((st) => st.sessions)
  const historySessions = useAppStore((st) => st.historySessions)
  const loadProjectHistory = useAppStore((st) => st.loadProjectHistory)
  // 会话可能只存在于冷路径历史里：用户在「会话历史」点开一条 15 天前的老会话后**刷新页面**，
  // 实时列表（被 MAX_PER_PROJECT=3 截断）里根本没有它 ⇒ 不兜底就落进 SessionNotFound、
  // 1.2 秒后被自动弹走，表现为"点开的会话刷新一下就没了"。
  const session = useAppStore((st) => st.sessions.find((s) => s.id === sessionId))
    ?? historySessions.find((s) => s.id === sessionId)
  // 「文件变更」「Todo」已并入「详情」(info)：旧深链 ?tab=diff/todo 归一到 info 渲染，
  // 但保留 rawTab 作为落地后自动滚到对应折叠区的信号（如收件箱「查看 diff」按钮）。
  // 未显式指定 tab 时，默认落地页跟随当前会话自身引擎：Claude→对话流、Codex→Codex 审核——
  // 两个 Tab 各自恒定绑定引擎（对称呈现），当前会话理应先看到"自己"那条流。
  // 落地默认 Tab 只算一次：setTab 编码非默认 Tab 时要跟它比较，两处必须用同一份计算，
  // 否则「对话流」在默认落地为 review 的 Codex 会话上会被 setParams({}) 打回默认（点了白点）。
  const defaultTab: TabKey = session?.engine === 'codex' ? 'review' : session?.engine === 'kimi' ? 'kimi' : 'chat'
  const tab: TabKey = rawTab === 'diff' || rawTab === 'todo'
    ? 'info'
    : ((rawTab as TabKey) ?? defaultTab)
  const [fileHref, setFileHref] = useState<string | null>(null) // 对话流文件链接 → 查看器
  const [codexSendMode, setCodexSendMode] = useState<MessageBehavior>('steer')
  useEffect(() => { setCodexSendMode('steer') }, [sessionId, tab])
  const [arch, setArch] = useState<{ busy?: boolean; ok?: boolean; url?: string; err?: string }>({}) // 归档到 KB
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]) // 可切 Codex 模型（含各自 effort 档）
  const [tkErr, setTkErr] = useState<string | null>(null) // 恢复/接管失败 → 会话内内联提示（替代刺眼的原生 alert）
  const [tkForce, setTkForce] = useState(false) // 后端提示 canForce：会话疑似挂起/僵尸，可强制接管
  const [forceArm, setForceArm] = useState(false) // 强制接管二次确认（内联，避免误点导致双写）
  useEffect(() => {
    if (rawTab !== 'diff' && rawTab !== 'todo') return
    const elId = rawTab === 'diff' ? 'fold-diff' : 'fold-todo'
    const t = setTimeout(() => document.getElementById(elId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
    return () => clearTimeout(t)
  }, [rawTab, sessionId])

  const source = useAppStore((st) => st.source)
  const extras = useAppStore((st) => st.extras[sessionId ?? ''])
  const sendMessage = useAppStore((st) => st.sendMessage)
  const interrupt = useAppStore((st) => st.interrupt)
  const setMode = useAppStore((st) => st.setMode)
  const resolveAction = useAppStore((st) => st.resolveAction)
  // 记住上次查看的会话，仅作为项目入口同优先级、同活动时间时的选择依据。
  const rememberSession = useAppStore((st) => st.rememberSession)
  useEffect(() => {
    if (session) rememberSession(session.serverId, session.project, session.id)
  }, [session?.id, session?.serverId, session?.project, rememberSession])

  // 本项目（同服务器 + 同项目）Claude / Codex 各自的"主会话"：当前会话若引擎匹配则用它，否则取
  // 该项目该引擎里最近活动的一个——「对话流」「Codex 审核」两个 Tab 对称展示的数据基础（D1/D2）。
  const projectSessions = session ? sessionsOfProject(allSessions, session.serverId, session.project) : []
  // 「会话历史」Tab 的列表：实时 ∪ 冷路径历史。**只给历史 Tab 用**，不参与下面的选主
  //（历史行会破坏「项目没有该引擎会话时不显示该 Tab」的不变量，见 projectHistoryList 注释）。
  const historyList = session ? projectHistoryList(allSessions, historySessions, session.serverId, session.project) : []
  // 进入会话详情页就拉一次冷路径历史（每项目一次，~8KB）。
  //
  // ⚠️ **别改回「只在 tab==='history' 时才拉」**（2026-08-03 用户实拍）：那样省下的是一次
  // 8KB 请求，代价却是 Tab 角标**撒谎**——角标在所有 Tab 上都渲染，用实时列表算出来就是
  // 「会话历史 2」（实时列表被 MAX_PER_PROJECT=3 截断），用户在别的 Tab 上永远看到 2，
  // 合理地认为"功能没生效"。宁可多发一个冷路径请求，也不能让界面显示一个已知错误的数字。
  // 这仍不是热路径：一次进页面一次，不是 3s 轮询。
  useEffect(() => {
    if (!session) return
    void loadProjectHistory(session.serverId, session.project)
  }, [session?.serverId, session?.project, loadProjectHistory])
  // 深链/刷新兜底：URL 指向的会话既不在实时列表也不在已拉的历史里 ⇒ 用本地快照找回它属于哪个
  // 项目，先拉一次历史再判定"会话不存在"。没有这步，刷新页面就把用户弹回别的会话。
  useEffect(() => {
    if (session || !sessionId) return
    const meta = snapshotSessionMeta(sessionId)
    if (meta) void loadProjectHistory(meta.serverId, meta.project)
  }, [session, sessionId, loadProjectHistory])
  const claudeSession = session
    ? projectEngineSession(projectSessions, session.serverId, session.project, 'claude', session.id)
    : null
  const codexSession = session
    ? projectEngineSession(projectSessions, session.serverId, session.project, 'codex', session.id)
    : null
  const kimiSession = session
    ? projectEngineSession(projectSessions, session.serverId, session.project, 'kimi', session.id)
    : null
  // 对话流展示的可能不是 URL 当前会话——分别取对应引擎的事件。
  const claudeEvents = useAppStore((st) => st.events[claudeSession?.id ?? ''] ?? [])
  const kimiEvents = useAppStore((st) => st.events[kimiSession?.id ?? ''] ?? [])
  const codexEvents = useAppStore((st) => st.events[codexSession?.id ?? ''] ?? [])
  // ⚠️ Codex 曾经自带一整套对话流+composer（CodexReview.tsx），是「审 git diff」时代的遗留：
  // 于是图片上传、排队徽标、文件链接、实时状态行、iOS 键盘避让、以及「跟随最新」那三道防线
  // 全都只落在 Claude 这一份上，Codex 侧一个都没有（用户实拍反馈「codex 明显差一些」）。
  // 现在三条流统一走 flowSession —— 不要再为某个引擎单开一份 composer。
  const flowSession = tab === 'kimi' ? kimiSession : tab === 'review' ? codexSession : claudeSession
  const flowEvents = tab === 'kimi' ? kimiEvents : tab === 'review' ? codexEvents : claudeEvents
  // ⚠️ 必须是**列表**不是 find()：Codex 一个回合可能同时挂多个审批（原 CodexReview 就是 map 渲染的），
  // 用 find 只画第一张 = 后面几个永远没有出口。选 store 的稳定引用再 useMemo 过滤，
  // 避免在 selector 里 filter 出新数组导致每拍都换引用、无限重渲染。
  const pendingActions = useAppStore((st) => st.pendingActions)
  const flowApprovals = useMemo(
    () => pendingActions.filter((a) => a.sessionId === flowSession?.id && a.status === 'pending' && a.kind === 'approval'),
    [pendingActions, flowSession?.id],
  )
  const flowApproval = flowApprovals[0]

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [attachments, setAttachments] = useState<Array<{ name: string; media_type: string; data: string; url: string }>>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const streamEndRef = useRef<HTMLDivElement>(null)
  const streaming = flowEvents.some((e) => e.type === 'assistant' && e.streaming)

  // 测量 composer 真实高度写入 CSS 变量 --composer-h，聊天区据此动态留白（加图片/安全区都不遮挡末条）
  const composerObs = useRef<ResizeObserver | null>(null)
  const setComposerRef = useCallback((node: HTMLDivElement | null) => {
    composerObs.current?.disconnect()
    if (!node) { document.documentElement.style.removeProperty('--composer-h'); return }
    const apply = () => document.documentElement.style.setProperty('--composer-h', `${node.offsetHeight}px`)
    apply()
    composerObs.current = new ResizeObserver(apply)
    composerObs.current.observe(node)
  }, [])
  useEffect(() => () => {
    composerObs.current?.disconnect()
    document.documentElement.style.removeProperty('--composer-h')
  }, [])

  // iOS 软键盘修复：fixed 定位的 composer 在 standalone PWA 里，键盘弹起会被顶到键盘上沿，
  // 收起后常「卡住」不回落（WebKit 不触发重排，停在键盘顶边那条线）。用 VisualViewport 把
  // 键盘遮挡高度实时写入 --kb-inset，composer 据此驱动 bottom——键盘起则浮在键盘上方、
  // 键盘落则干净回底，从根上消除卡顿。桌面端 vv 不变 → --kb-inset 恒 0，无副作用。
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const apply = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty('--kb-inset', `${Math.round(overlap)}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      document.documentElement.style.removeProperty('--kb-inset')
    }
  }, [])

  // live 模式：进入详情页订阅 SSE 实时事件流（逐字流式），不可用时内部回退轮询。
  // 依赖 source：首帧 source 可能还是 mock，待其翻为 live 后重新订阅（否则一次性订阅会永久 no-op）
  // 「对话流」Tab 展示的若是项目里另一个 Claude 会话（当前打开的是 Codex 会话）——额外只读订阅它，
  // 不触发接管、不对该会话双写（跨会话展示只读约束）。
  useEffect(() => {
    if (!sessionId || source !== 'live') return
    const unsubCurrent = subscribeSessionEvents(sessionId)
    if ((tab === 'chat' || tab === 'kimi' || tab === 'review') && flowSession && flowSession.id !== sessionId) {
      const unsubFlow = subscribeSessionEvents(flowSession.id)
      return () => { unsubCurrent(); unsubFlow() }
    }
    return unsubCurrent
  }, [sessionId, source, tab, flowSession?.id])

  // ── 跟随最新 ──
  // 进入会话就落在最新消息处；流式时持续跟随；用户上翻则暂停跟随，回到底部附近恢复。
  //
  // ⚠️ 这里曾经**自己把自己关掉**：判据是「离底 <120px ⇒ 还在跟随」，而**我们自己那次程序化滚动
  // 同样会触发 scroll 事件**。首屏时 markdown / 代码高亮 / 字体 / 图片还在陆续把页面撑高——
  // 我们滚到「当时的底」，下一帧内容又长高了，于是这次 onScroll 算出「离底很远」→ stick 置 false →
  // **从此不再跟随，永远停在半路**。用户看到的就是：打开对话流落在中间，还得自己一路刷到底。
  //
  // 两道修：① 程序化滚动不参与「用户是否上翻」的判定（selfScrollAt 时间窗）；
  //         ② ResizeObserver 盯内容高度——只要还在跟随，内容一长高就重新贴底（覆盖异步布局：
  //            图片懒加载、字体回流、Markdown 渲染完成，这些都发生在 events 到齐**之后**）。
  const stickRef = useRef(true)
  const selfScrollAt = useRef(0)
  const scrollToBottom = () => {
    selfScrollAt.current = Date.now()
    requestAnimationFrame(() => {
      selfScrollAt.current = Date.now()
      window.scrollTo({ top: document.documentElement.scrollHeight })
    })
  }
  // 进入 / 切换会话 / 切换对话流 Tab：重置为跟随并落到最新（组件不重挂载，必须显式重置）
  useEffect(() => {
    stickRef.current = true
    scrollToBottom()
  }, [sessionId, tab])
  // 事件变化：仍在跟随则滚到底
  useEffect(() => {
    if (stickRef.current) scrollToBottom()
  }, [flowEvents.length, streaming && flowEvents.at(-1)?.type === 'assistant' ? (flowEvents.at(-1) as { text: string }).text : ''])
  // 内容高度变化（异步布局到位）：仍在跟随则重新贴底。没有这条，首屏就会停在半路。
  useEffect(() => {
    const ro = new ResizeObserver(() => { if (stickRef.current) scrollToBottom() })
    ro.observe(document.body)
    return () => ro.disconnect()
  }, [])
  // 用户上翻 → 暂停跟随；回到底部附近 → 恢复
  const [atBottom, setAtBottom] = useState(true)
  useEffect(() => {
    const onScroll = () => {
      // 刚才那一下是我们自己滚的 → 不据此判断"用户上翻了"，否则会把跟随自己关掉（见上）
      if (Date.now() - selfScrollAt.current < 250) return
      const near = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120
      stickRef.current = near
      setAtBottom(near)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // 动态指示：会话运行中每秒刷新，驱动"思考中/执行中 + 已用秒数"的活体显示（#8 体感）
  const [nowTs, setNowTs] = useState(() => Date.now())
  useEffect(() => {
    if (flowSession?.state !== 'running') return
    const t = setInterval(() => setNowTs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [flowSession?.state])

  // 拉取可切的 Codex 模型（仅当当前是 Codex 平台会话时）。模型列表几乎不变，拉一次即可。
  // ⚠️ 必须放在下面 `if (!session) return` **之前**——所有 Hook 都要在任何提前返回前调用，
  // 否则 session 为 null 时这个 useEffect 被跳过 → hooks 数变化 → React error #310（见第 86 行注释）。
  useEffect(() => {
    if (codexSession?.origin !== 'platform') return
    let alive = true
    const q = codexSession.serverId ? `?server=${encodeURIComponent(codexSession.serverId)}` : ''
    fetch(`/api/usage/codex-models${q}`).then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d?.models)) setCodexModels(d.models) }).catch(() => {})
    return () => { alive = false }
  }, [codexSession?.origin, codexSession?.serverId])

  if (!session) {
    return <SessionNotFound sessionId={sessionId} allSessions={allSessions} />
  }

  const fileChanges = extras?.fileChanges ?? []
  const todos = extras?.todos ?? []
  const running = session.state === 'running'
  const flowRunning = flowSession?.state === 'running'
  // 动态指示内容：依据当前对话流最后一条事件判断「输出/执行/思考」+ 已用秒数
  const lastEv = flowEvents[flowEvents.length - 1]
  const liveSecs = lastEv?.ts ? Math.max(0, Math.round((nowTs - lastEv.ts) / 1000)) : 0
  let liveLabel = `${flowSession ? engineName[flowSession.engine] : 'Agent'} 思考中`
  let liveDetail = ''
  let liveHint = ''
  if (lastEv?.type === 'assistant' && lastEv.streaming) liveLabel = '正在输出'
  else if (lastEv?.type === 'file_op') { liveLabel = '正在执行'; liveDetail = `${lastEv.verb}${lastEv.path ? ' · ' + lastEv.path : ''}` }
  else if (lastEv?.type === 'user') {
    // 最后一条事件就是用户自己刚发的消息 = 模型还没吐出第一个字。
    // ⚠️ 这一段必须**明确告诉用户消息已经送达**：实测大上下文会话（5h+ / xhigh）首字要 30–90 秒，
    // 而此前这里只给一个往上跳的裸秒数，用户完全无法区分「没发出去」和「模型在想」——
    // 用户原话：「等待100多秒没有反应，这体验有些太不可思议了」。
    liveLabel = `已送达 · 等 ${flowSession ? engineName[flowSession.engine] : 'Agent'} 首个响应`
    if (lastEv.delivery === 'steered') liveLabel = '补充信息已追加 · 当前任务继续执行'
    else if (lastEv.delivery === 'queued') liveLabel = '新任务已排队 · 等待当前任务完成'
    else if (lastEv.delivery === 'sending') liveLabel = '正在发送消息…'
    else if (lastEv.delivery === 'unknown') liveLabel = '消息送达待确认 · 请勿重复发送'
    if (liveSecs > 20 && (!lastEv.delivery || lastEv.delivery === 'accepted')) liveHint = '大上下文会话（长会话 / 高 effort）首字通常 30–90 秒'
  }
  // 多条排队可见化：运行中、其后还没有 assistant 回复的用户消息（支持像 VS Code 连发多条）。
  // **最早那条不是"排队"，它就是 Claude 正在处理的那条**（消息 POST 后同一秒就进了 Claude 的输入队列，
  // 实测 JSONL 里 enqueue/dequeue 同毫秒配对）。此前一律标「排队中」，于是用户盯着一条写着"排队中"
  // 的消息看 75 秒，以为它根本没发出去。只有它**后面**还压着的才是真排队。
  let lastAssistantIdx = -1
  flowEvents.forEach((e, i) => { if (e.type === 'assistant') lastAssistantIdx = i })
  const pendingUsers = flowRunning ? flowEvents.filter((e, i) => e.type === 'user' && i > lastAssistantIdx) : []
  const processingId = pendingUsers[0]?.id ?? null
  const queuedIds = new Set(pendingUsers.slice(1).map((e) => e.id))
  // ⚠️⚠️ 这里**曾经**有个 `isFlowCurrent`（= flowSession.id === session.id）闸，
  //   注释写着「当前会话是 Claude 时恒真；否则为只读跨会话展示，不出实时指示/审批卡」。
  //   **那个"恒真"是个未被满足的假设**（2026-09-22 用户实拍）：
  //   URL 打开的是一个 6 天前的 **Kimi 影子会话**、Tab 停在「Claude 对话流」时它就是 false，
  //   于是 ① 审批卡 ② 「正在执行 N 秒」实时指示 ③ 「处理中/排队中」角标 **全被静默吞掉**。
  //   现场：ps-mttknv9v-5885 处于 waiting_approval、待办 act-muc44gxh-181 在 /api/state 里
  //   明明白白，而用户在页面上一个字都看不到，是别人告诉他才去查的；
  //   同时因为实时指示也没了，**一条正在跑的流和一条死流在屏幕上完全一样** ⇒ 他报「卡顿、不刷新」。
  //
  // ★ 判据本身就错了：`flowApprovals`/`flowRunning`/`liveSecs`/`processingId` **全部按 flowSession 算**，
  //   它们描述的正是屏幕上那条流，与「URL 会话是谁」无关。
  //   同一条教训下面的 composer 早就修过（「恒为当前流的会话……才能恒可操作而不是死胡同」），
  //   只是没推广到这几处 —— 又一次「只落实一半」。护栏在 SessionDetail.wiring.test.ts。
  //
  // ⚠️ 这个标志**本身没错，错的是拿它闸什么**。它仍有两个正当用途，都与「URL 会话是谁」真正相关：
  //   ① 发送后是否重置 Tab（跨会话展示时不该把用户弹去别的流）
  //   ② 顶部那条「展示本项目最近的 X 会话（只读）· 点此打开」提示
  //   **不要**再用它去闸任何按 flowSession 算出来的东西。
  const isFlowCurrent = !!flowSession && flowSession.id === session.id
  const queueStateOf = (id: string): 'processing' | 'queued' | undefined => {
    if (flowSession?.engine === 'codex') return undefined // Native receipts distinguish steering from queued tasks.
    if (id === processingId) return 'processing'
    return queuedIds.has(id) ? 'queued' : undefined
  }
  const nativeId = session.origin === 'shadow' ? session.id : session.realSessionId

  // Claude/Kimi 对话流底部 composer 的操作目标：恒为当前流的会话，即便 URL 打开的
  // 是另一会话（isFlowCurrent===false，跨会话只读展示场景）——发送/中断/切模式/接管/释放都要作用于
  // 它，composer 才能"恒可操作"而不是在跨会话展示时隐藏成死胡同。isFlowCurrent 为真时二者相同，
  // 行为与此前完全一致。用 session 兜底只为满足类型：claudeSession 为空时 chat 的 composer 本就不会
  // 渲染（见下方 hideComposer），兜底值不会被用到。
  const composerTarget = flowSession ?? session
  const composerRunning = composerTarget.state === 'running'
  const composerDetached = composerTarget.detached === true
  const composerReadonly = composerTarget.origin === 'shadow' || composerDetached
  // 终端中活跃的影子会话不可接管（双进程写同一会话会冲突）；Claude/Codex 均支持
  const composerCanTakeover = composerReadonly && ['idle', 'done', 'error'].includes(composerTarget.state)

  const takeover = async (force = false) => {
    if (busy) return
    setBusy(true); setTkErr(null); setForceArm(false)
    try {
      // 分离态走 reattach（复用同 psId，恢复后 URL 不变，Phase 1b）；普通影子走 takeover（生成新 id）
      const endpoint = composerDetached ? 'reattach' : 'takeover'
      const res = await fetch(`/api/session/${composerTarget.id}/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(force ? { force: true } : {}), // force=用户确认原会话已挂起/僵尸
      })
      const data = await res.json()
      // 只有在操作的就是当前 URL 会话时才跳转（正常场景）；跨会话（在别的流底部恢复该项目 Claude 会话）
      // 不把用户从当前视图弹走——恢复出的新会话由下一轮 /api/state 自动进入对应对话流。
      if (res.ok && data.id) { setTkErr(null); setTkForce(false); if (composerTarget.id === session.id) navigate(`/session/${data.id}`, { replace: true }) }
      else {
        setTkErr(data.error ?? '接管失败'); setTkForce(!!data.canForce)
        if (!data.canForce) setTimeout(() => setTkErr(null), 6000) // 可强制的保留(等用户决定),否则 6s 自消
      }
    } finally {
      setBusy(false)
    }
  }

  const changeModel = (model: string, id: string = session.id) => {
    void fetch(`/api/session/${id}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
  }

  const changeEffort = (effort: string, id: string = session.id) => {
    void fetch(`/api/session/${id}/effort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort }),
    })
  }

  const archive = async () => {
    if (arch.busy) return
    setArch({ busy: true })
    try {
      const res = await fetch(`/api/session/${session.id}/archive-to-kb`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.ok) setArch({ ok: true, url: d.url })
      else setArch({ err: d.error || `归档失败（${res.status}）` })
    } catch { setArch({ err: '归档失败（网络/超时）' }) }
  }

  const release = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/session/${composerTarget.id}/release`, { method: 'POST' })
      const data = await res.json()
      // 跨会话释放不跳转（不弹走用户）；仅当操作的是当前 URL 会话时按结果跳转。
      // ⚠️ **不得盲信 data.realId**（2026-08-21 死循环的第一环）：出错会话的 realId 其 JSONL
      // 在磁盘上存在，但既不在实时列表也不在冷路径历史里 ⇒ 跳过去必然「会话不存在」，
      // 再被自动改道弹到另一条 error 会话。判据只有一条：它在不在**当前可达**的会话集合里。
      if (composerTarget.id === session.id) {
        const reachable = res.ok ? [...allSessions, ...historySessions] : []
        navigate(resolveReleaseTarget(res.ok ? data.realId : null, reachable), { replace: true })
      }
    } finally {
      setBusy(false)
    }
  }

  const setTab = (t: TabKey) => setParams(t === defaultTab ? {} : { tab: t }, { replace: true })
  const sendBehavior = composerTarget.supportsSteering ? codexSendMode : 'queue'
  const send = () => {
    if (!draft.trim() && attachments.length === 0) return
    sendMessage(composerTarget.id, draft.trim(), attachments.map((a) => ({ media_type: a.media_type, data: a.data })), composerTarget.engine === 'codex' ? sendBehavior : undefined)
    setCodexSendMode('steer')
    setDraft('')
    setAttachments([])
    // 发送后跳到「当前会话自己」的那条流——仅当 composer 目标本就是 URL 打开的会话时才需要重置 tab
    // （清掉 ?tab=diff/todo 等深链残留）；跨会话展示（发到 claudeSession 而非当前打开的会话）时维持
    // 当前 Tab，不把用户弹去别的流。
    if (isFlowCurrent) setTab(defaultTab)
  }

  const addFiles = async (files: FileList | null) => {
    if (!files) return
    const next: typeof attachments = []
    for (const f of Array.from(files).slice(0, 6)) {
      if (!f.type.startsWith('image/') || f.size > 8_000_000) continue
      const data = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.readAsDataURL(f)
      })
      next.push({ name: f.name, media_type: f.type, data, url: URL.createObjectURL(f) })
    }
    setAttachments((prev) => [...prev, ...next].slice(0, 6))
    if (fileRef.current) fileRef.current.value = ''
  }

  // Kimi 严格按“开启了会话就显示”：项目存在 Kimi 会话时才出现对应对话流。
  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    ...(codexSession || session.engine === 'claude' ? [{ key: 'review' as TabKey, label: 'Codex 对话流' }] : []),
    ...(kimiSession ? [{ key: 'kimi' as TabKey, label: 'Kimi 对话流' }] : []),
    ...(claudeSession ? [{ key: 'chat' as TabKey, label: 'Claude 对话流' }] : []),
    { key: 'code', label: '代码' },
    { key: 'info', label: '详情', count: (fileChanges.length + todos.length) || undefined },
    { key: 'trace', label: '执行历史' },
    { key: 'history', label: '会话历史', count: historyList.length > 1 ? historyList.length : undefined },
  ]

  // 底部主输入框 = 「Claude 对话流」当前会话（claudeSession）的输入框/恢复入口，发送/接管/中断/释放目标
  // 恒为 composerTarget（=claudeSession）。恒可操作（platform→输入框 / shadow→恢复会话 / error→清理），
  // 不因"当前打开的是项目里另一会话"而隐藏成死胡同——只要项目里存在 Claude 会话（claudeSession truthy）
  // 就在对应对话流 Tab 出现；isFlowCurrent 只影响上方是否叠加实时指示/审批卡（那些属于 URL 会话本身），
  // 不影响 composer 本身是否可操作。
  //  · 代码 = 只读查看器，无需输入框；
  //  · 详情 / 会话历史 = 只读信息 / 会话切换列表，出现输入框会误导（用户报告"会话历史里竟有输入框"）；
  // Codex（review）已并入 flowSession，与 chat/kimi 共用这一份 composer——composerTarget 随 flowSession
  // 指向 codexSession，不会发错引擎。CodexReview 里那份独立输入框已删，不存在重复。
  const hideComposer = !((tab === 'chat' || tab === 'kimi' || tab === 'review') && flowSession)

  // 顶栏 row2 跟随「当前对话流 Tab」所展示的会话：Claude 对话流→claudeSession、Codex 对话流→codexSession，
  // 其它 Tab→URL 会话本身。让两个对话流 Tab 的「状态·时长·成本·模型/effort/审批」落在同一位置、同一风格，
  // Codex 不再单独挂一条子头部（CodexReview 已移除 review__head），两 Tab 结构对齐。
  const headSession =
    tab === 'review' ? (codexSession ?? session) :
    tab === 'chat' ? (claudeSession ?? session) :
    tab === 'kimi' ? (kimiSession ?? session) :
    session
  const headReadonly = headSession.origin === 'shadow' || headSession.detached === true

  return (
    <div className="page session-page">
      {fileHref && sessionId && <FileViewerModal sessionId={sessionId} href={fileHref} running={running} onClose={() => setFileHref(null)} />}
      <header className="session-head">
        <div className="session-head__row1">
          <button className="icon-btn" onClick={() => navigate(-1)}>←</button>
          <button className="session-head__title" onClick={() => setTab('history')} title="查看本项目会话历史">
            {session.project}
          </button>
          <button
            className="icon-btn"
            title="归档到知识库（KB）"
            onClick={archive}
            disabled={arch.busy}
          >
            {arch.busy ? <span className="icon-spin">⟳</span> : '📥'}
          </button>
          <button className="icon-btn" title="搜索">⌕</button>
        </div>
        {(arch.ok || arch.err) && (
          <div className={`archive-banner ${arch.err ? 'archive-banner--err' : ''}`} onClick={() => setArch({})}>
            {arch.ok
              ? <>已归档到知识库 · <a href={arch.url} target="_blank" rel="noreferrer">打开 KB ↗</a><span className="archive-banner__x">　点此关闭</span></>
              : <>归档失败：{arch.err}<span className="archive-banner__x">　点此关闭</span></>}
          </div>
        )}
        <div className="session-head__row2">
          <StatusDot state={headSession.state} />
          <span className={`state-text--${headSession.state}`}>{stateLabel[headSession.state]}</span>
          <span>· {duration(headSession.startedAt)}</span>
          {estCostOf(headSession) > 0 && <span>· {money(estCostOf(headSession))}</span>}
          {headReadonly && <span style={{ color: 'var(--text-3)' }}>· 影子</span>}
          {/* 模型/effort/审批 指示器：跟随当前对话流 Tab 的会话（headSession），三路对话流同位置同风格。
              平台 Claude=可切模型+effort；平台 Codex=模型+effort；平台 Kimi=官方模型；影子=只读文本。 */}
          {headSession.origin === 'platform' && headSession.engine === 'claude' ? (
            <span className="session-head__model">
              <select
                className="model-select"
                value=""
                onChange={(e) => { if (e.target.value !== '') changeModel(e.target.value, headSession.id) }}
                title="切换模型（下一回合生效）"
              >
                <option value="" disabled>Claude {headSession.model || ''} ▾</option>
                {CLAUDE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <select
                className="model-select"
                value={headSession.effort || 'xhigh'}
                onChange={(e) => changeEffort(e.target.value, headSession.id)}
                title="切换 effort 思考强度（下一回合生效）"
              >
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            </span>
          ) : headSession.origin === 'platform' && headSession.engine === 'codex' ? (
            // 顶栏与 Claude 对齐：模型 + effort，均下一回合生效（codex-driver setLlmModel/setLlmEffort
            // → thread/settings/update）。2026-07-15：Codex 现在**可切模型**（gpt-5.6-sol/5.5/5.4/…），
            // effort 档随所选模型而变（gpt-5.6-sol 独有 max/ultra）。审批切换在底部 composer 工具栏。
            (() => {
              // effort 选项取「当前模型」上报的档；模型列表还没到 / 匹配不到时用兜底档
              const curModelId = codexModels.find((m) => headSession.model?.includes(m.id))?.id
              const efforts = codexModels.find((m) => m.id === curModelId)?.efforts?.length
                ? codexModels.find((m) => m.id === curModelId)!.efforts
                : CODEX_EFFORTS_FALLBACK
              const curEffort = headSession.effort && efforts.includes(headSession.effort) ? headSession.effort : (efforts.includes('high') ? 'high' : efforts[0])
              return (
                <span className="session-head__model">
                  {codexModels.length ? (
                    <select
                      className="model-select"
                      value={curModelId ?? ''}
                      onChange={(e) => { if (e.target.value) changeModel(e.target.value, headSession.id) }}
                      title="切换 Codex 模型（下一回合生效）"
                    >
                      {!curModelId && <option value="" disabled>{headSession.model || 'Codex'} ▾</option>}
                      {codexModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.displayName}{m.isDefault ? ' ·默认' : ''}</option>
                      ))}
                    </select>
                  ) : (
                    <span style={{ color: 'var(--text-3)' }}>{headSession.model}</span>
                  )}
                  <select
                    className="model-select"
                    value={curEffort}
                    onChange={(e) => changeEffort(e.target.value, headSession.id)}
                    title="切换 Codex 推理强度（下一回合生效）"
                  >
                    {efforts.map((e) => (
                      <option key={e} value={e}>{e}</option>
                    ))}
                  </select>
                </span>
              )
            })()
          ) : headSession.origin === 'platform' && headSession.engine === 'kimi' ? (
            <span className="session-head__model">
              <select
                className="model-select"
                value={headSession.model.replace(/^kimi-code\//, '')}
                onChange={(e) => { if (e.target.value) changeModel(e.target.value, headSession.id) }}
                title="切换 Kimi 模型（下一回合生效；复用 CLI OAuth 登录态）"
              >
                {!KIMI_MODELS.some((m) => m.id === headSession.model.replace(/^kimi-code\//, '')) && (
                  <option value={headSession.model.replace(/^kimi-code\//, '')}>{headSession.model}</option>
                )}
                {KIMI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </span>
          ) : (
            <span className="session-head__model">
              {engineName[headSession.engine]} {headSession.model}
              {headSession.effort ? ` · ${headSession.effort}` : ''}
            </span>
          )}
        </div>
        <div className="tabs-row">
          {tabs.map((t) => (
            <button key={t.key} className={`tab-item ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.count != null && <span className="tab-item__count">{t.count}</span>}
            </button>
          ))}
        </div>
      </header>

      {(tab === 'chat' || tab === 'kimi' || (tab === 'review' && codexSession)) && (
        <div className="chat-stream">
          {!flowSession && <div className="empty-state">本项目暂无对应会话</div>}
          {flowSession && !isFlowCurrent && (
            <div className="history-hint" style={{ cursor: 'pointer' }} onClick={() => navigate(`/session/${flowSession.id}`)}>
              展示本项目最近的 {engineName[flowSession.engine]} 会话（只读）· {flowSession.summary} · 点此打开该会话
            </div>
          )}
          {flowEvents.map((e) => (
            <ChatMessage key={e.id} event={e} engine={flowSession?.engine ?? 'claude'} queueState={queueStateOf(e.id)} onFileLink={setFileHref} />
          ))}
          {flowRunning && !flowApproval && (
            <div className={`live-status live-status--${flowSession?.engine ?? 'claude'}`}>
              <span className="live-status__dot" />
              <span className="live-status__label">
                {liveLabel}
                {liveDetail && <span className="live-status__detail"> {liveDetail}</span>}
                <span className="live-status__ell">…</span>
              </span>
              <span className="live-status__time mono">{liveSecs}s</span>
            </div>
          )}
          {flowRunning && !flowApproval && liveHint && liveSecs <= STALL_HINT_SECS && (
            <div className="live-hint">{liveHint}</div>
          )}
          {flowRunning && !flowApproval && liveSecs > STALL_HINT_SECS && (
            <div
              className="live-stall-hint"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                margin: '4px 0 8px',
                padding: '6px 10px',
                fontSize: 12.5,
                color: 'var(--st-approval)',
                background: 'rgba(245,158,11,0.10)',
                border: '1px solid rgba(245,158,11,0.35)',
                borderRadius: 8,
              }}
            >
              <span>已 {Math.floor(liveSecs / 60)} 分钟无新输出，可能仍在处理或已卡住</span>
              <button
                className="btn btn--sm btn--danger-outline"
                style={{ marginLeft: 'auto' }}
                onClick={() => interrupt(composerTarget.id)}
              >
                中断
              </button>
            </div>
          )}
          {flowApprovals.map((ap) => (
            <div className="inbox-card" style={{ borderColor: 'rgba(245,158,11,0.55)' }} key={ap.id}>
              <div className="inbox-card__head">
                <span className="kind-icon kind-icon--approval">🛡</span>
                <span className="kind-tag kind-tag--approval">权限审批</span>
              </div>
              <div className="inbox-card__title">
                {ap.title} <span className="mono">{ap.detail}</span>
              </div>
              {/* flexWrap：4 个按钮在手机窄屏会挤成一行溢出（原 CodexReview 已踩过，带着 wrap 一起并过来） */}
              <div className="inbox-card__foot" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn--sm btn--approve" onClick={() => resolveAction(ap.id, '允许一次')}>允许一次</button>
                <button className="btn btn--sm btn--ghost" style={{ marginLeft: 0 }} onClick={() => resolveAction(ap.id, '本会话始终允许')}>本会话始终允许</button>
                <button className="btn btn--sm btn--danger-outline" style={{ marginLeft: 0 }} onClick={() => resolveAction(ap.id, '拒绝')}>拒绝</button>
                <button className="btn btn--sm btn--ghost" style={{ marginLeft: 0 }} onClick={() => navigate(`/inbox/${ap.id}`)}>详情</button>
              </div>
            </div>
          ))}
          <div ref={streamEndRef} />
        </div>
      )}

      {tab === 'info' && (
        <div className="tab-pane">
          <div className="todo-card detail-kv">
            会话 ID：<b className="mono">{session.id}</b><br />
            {nativeId && (
              <>
                终端接管命令：<b className="mono" style={{ userSelect: 'all' }}>
                  {session.engine === 'kimi' ? `kimi --session ${nativeId}` : session.engine === 'codex' ? `codex resume ${nativeId}` : `claude --resume ${nativeId}`}
                </b><br />
              </>
            )}
            服务器：<b>{session.serverId}</b><br />
            项目：<b>{session.project}</b> · 分支 <b className="mono">{session.branch}</b><br />
            引擎：<b>{engineName[session.engine]} · {session.model}</b><br />
            {session.engine === 'codex'
              ? <>审批模式：<b>{CODEX_MODE_LABEL[session.mode] ?? session.mode}</b>（审批=每条必审 / 自动=按需 / 全权=不审批，可在底部切换，下一回合生效）<br /></>
              : <>权限模式：<b>{session.mode}</b><br /></>}
            Tokens（真实总量，含 cache）：<b className="mono">{fmtTokens(session.tokens)}</b> · 费用（估算）：<b className="mono">{money(estCostOf(session))}</b>
            {session.origin === 'platform' && session.cost > 0 && (
              <span style={{ color: 'var(--text-3)' }}> · SDK 实报 <b className="mono">{money(session.cost)}</b></span>
            )}
            {session.tokensBreakdown && (
              <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.9 }}>
                输入 <b className="mono">{fmtTokens(session.tokensBreakdown.input)}</b> ·
                输出 <b className="mono">{fmtTokens(session.tokensBreakdown.output)}</b> ·
                缓存读 <b className="mono">{fmtTokens(session.tokensBreakdown.cacheRead)}</b> ·
                缓存写 <b className="mono">{fmtTokens(session.tokensBreakdown.cacheCreate)}</b>
              </div>
            )}
          </div>

          <FoldSection
            id="fold-diff"
            title="文件变更"
            badge={fileChanges.length
              ? `+${fileChanges.reduce((n, f) => n + f.additions, 0)} / -${fileChanges.reduce((n, f) => n + f.deletions, 0)}`
              : '无'}
            defaultOpen={fileChanges.length > 0}
          >
            {fileChanges.length === 0 ? (
              <div className="empty-state">本会话暂无文件变更</div>
            ) : (
              <>
                {fileChanges.map((f) => <DiffFile key={f.path} change={f} />)}
                <div className="diff-view-switch">
                  <button disabled>原始</button>
                  <button className="active">已修改</button>
                  <button disabled>并排</button>
                </div>
              </>
            )}
          </FoldSection>

          <FoldSection
            id="fold-todo"
            title="Todo"
            badge={todos.length ? `${todos.filter((t) => t.status === 'done').length}/${todos.length}` : '无'}
            defaultOpen={todos.length > 0}
          >
            {todos.length === 0 ? (
              <div className="empty-state">暂无 Todo</div>
            ) : (
              <div className="todo-card">
                {todos.map((t) => (
                  <div key={t.text} className={`todo-item ${t.status === 'done' ? 'todo-item--done' : ''}`}>
                    <span className={`todo-check ${t.status === 'done' ? 'todo-check--done' : t.status === 'active' ? 'todo-check--active' : ''}`}>
                      {t.status === 'done' ? '✓' : t.status === 'active' ? '›' : ''}
                    </span>
                    {t.text}
                  </div>
                ))}
              </div>
            )}
          </FoldSection>

          <div className="empty-state" style={{ padding: '20px 0 8px', fontSize: 12 }}>
            原生终端 Tab（tmux + xterm.js）将在 P3 提供
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="tab-pane">
          <div className="history-hint">本项目（{session.project}）的会话 · Claude + Codex + Kimi 合集 · 点击切换</div>
          <div className="session-switcher">
            {historyList.map((s) => {
              const isCurrent = s.id === session.id
              return (
                <button
                  key={s.id}
                  className={`session-switcher__row ${isCurrent ? 'session-switcher__row--current' : ''}`}
                  onClick={() => {
                    if (isCurrent) return
                    // 目标会话正在执行（终端/平台都可能在跑）：切走前二次确认，避免误触打断关注
                    if (['running', 'waiting_input', 'waiting_approval'].includes(s.state)) {
                      if (!window.confirm('该会话正在执行，确认切换到它？')) return
                    }
                    navigate(`/session/${s.id}`, { replace: true })
                  }}
                >
                  <StatusDot state={s.state} />
                  <EngineBadge engine={s.engine} model={s.model} />
                  <span className="session-switcher__summary">{s.summary}</span>
                  {isCurrent
                    ? <span className="history-row__cur">当前</span>
                    : <span className="history-row__origin">{s.origin === 'platform' ? '平台' : '影子'}</span>}
                  <span className="session-switcher__time">{relTime(s.lastActiveAt)}</span>
                </button>
              )
            })}
          </div>
          {historyList.length <= 1 && (
            <div className="empty-state" style={{ fontSize: 12.5, paddingTop: 18 }}>该项目暂无其它会话</div>
          )}
        </div>
      )}

      {tab === 'trace' && <ExecTrace sessionId={session.id} />}

      {tab === 'code' && (
        <div className="tab-pane">
          <CodeTree sessionId={session.id} />
        </div>
      )}

      {/* Codex 有会话时走上面那条统一的 chat-stream；CodexReview 只剩「项目内就地新建 Codex 会话」空态
          （这是 Codex 独有的，Claude/Kimi 走 /new 页，不能删）。 */}
      {tab === 'review' && !codexSession && (
        <div className="tab-pane">
          <CodexReview
            codexSession={codexSession}
            project={session.project}
            claudeSessionId={claudeSession?.id ?? session.id}
            serverId={session.serverId}
            cwd={session.cwd ?? ''}
          />
        </div>
      )}

      {/* 上翻后出现的「回到最新」浮标——暂停跟随时不必再手动刷到底。
          贴在 composer 上沿（--composer-h 是实测高度，见上面的 ResizeObserver）。 */}
      {!atBottom && (
        <button
          className="jump-latest"
          onClick={() => { stickRef.current = true; setAtBottom(true); scrollToBottom() }}
        >
          ↓ 回到最新
        </button>
      )}

      {hideComposer ? null : composerTarget.state === 'error' ? (
        <div className="composer" ref={setComposerRef}>
          <div className="error-banner">
            <div className="error-banner__title">⚠️ 会话出错</div>
            <div className="error-banner__msg mono">{composerTarget.error || composerTarget.summary}</div>
            <div className="composer__row" style={{ marginTop: 8 }}>
              <button className="btn btn--sm btn--ghost" onClick={() => navigate('/')}>返回看板</button>
              <button className="btn btn--sm btn--danger-outline" style={{ marginLeft: 0 }} disabled={busy} onClick={release}>清理此会话</button>
            </div>
          </div>
        </div>
      ) : composerReadonly ? (
        <div className="composer" ref={setComposerRef}>
          {/* 影子会话恒给「恢复会话」按钮，不再对活跃影子显示"提示不可用"死胡同（与 Codex 对话流对齐）。
              空闲/结束影子点了即接管；活跃影子（running/waiting_input，影子态不会有 waiting_approval）点了由后端
              409 拦回、takeover() 失败在下方内联提示（非模态，替代原生 alert）——按钮恒在、恒可点，不会因活跃就变成一段只读文案。 */}
          {tkErr && (
            <div className="composer__row" style={{ marginBottom: 6, alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--st-approval)', fontSize: 12.5, flex: 1 }}>⚠️ {tkErr}</span>
              {tkForce && (forceArm
                ? <button className="btn btn--sm btn--danger-outline" style={{ marginLeft: 0 }} disabled={busy} onClick={() => void takeover(true)}>确认强制(可能双写)</button>
                : <button className="btn btn--sm btn--ghost" style={{ marginLeft: 0, color: 'var(--st-error)' }} onClick={() => setForceArm(true)}>强制接管</button>
              )}
              <button className="btn btn--sm btn--ghost" style={{ marginLeft: 0 }} onClick={() => { setTkErr(null); setTkForce(false); setForceArm(false) }}>知道了</button>
            </div>
          )}
          <div className="composer__row" style={{ alignItems: 'center' }}>
            <span style={{ color: 'var(--text-3)', fontSize: 12.5, flex: 1 }}>
              {composerDetached
                ? <>
                    {composerTarget.detachedReason || '会话经 agent 重启已分离；历史只读，恢复后可继续对话'}
                    {composerTarget.lostPending && <span style={{ color: 'var(--st-approval)' }}>　·　重启前的待办已失效，请恢复后重新触发</span>}
                  </>
                : composerCanTakeover
                ? '影子会话 · 恢复后可直接对话、审批、中断'
                : composerTarget.state === 'waiting_input'
                ? '终端里等待输入中 · 活跃，恢复将在其空闲后生效'
                : composerTarget.state === 'waiting_approval'
                ? '终端里等待审批中 · 活跃，恢复将在其空闲后生效'
                : '终端中运行中 · 活跃，恢复将在其空闲后生效'}
            </span>
            <button className="btn btn--primary" disabled={busy} onClick={() => void takeover()}>
              {busy ? '恢复中…' : '↻ 恢复会话'}
            </button>
          </div>
        </div>
      ) : (
      <div className="composer" ref={setComposerRef}>
        {composerTarget.engine === 'codex' && <CodexSendMode value={sendBehavior} onChange={setCodexSendMode} steeringAvailable={!!composerTarget.supportsSteering} />}
        {attachments.length > 0 && (
          <div className="composer__thumbs">
            {attachments.map((a, i) => (
              <div key={i} className="composer__thumb">
                <img src={a.url} alt={a.name} />
                <button className="composer__thumb-x" onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
        )}
        <div className="composer__row">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => void addFiles(e.target.files)}
          />
          <button className="composer__attach" title="上传图片" onClick={() => fileRef.current?.click()}>＋</button>
          <textarea
            className="composer__input"
            rows={1}
            placeholder={composerRunning ? composerTarget.engine === 'codex' ? sendBehavior === 'queue' ? '输入独立任务，当前任务结束后处理…' : '补充信息将追加到当前任务…' : '运行中也可继续输入，多条按顺序排队处理…' : '输入指令…（可粘贴/上传图片）'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
              if (imgs.length) { e.preventDefault(); void addFiles(e.clipboardData.files) }
            }}
            onKeyDown={(e) => {
              // ⚠️ isComposing 必须判：中文/日文输入法里 Enter 是**确认候选词**，不是发送。
              // 少了这一条，打拼音时按 Enter 选词会直接触发 send() ⇒ setDraft('') 把没打完的
              // 内容清空发走（用户报「输入框的内容会被刷新」）。
              // 用 e.nativeEvent.isComposing：React 合成事件上没有这个字段。
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
          />
          {composerRunning && !draft.trim() && attachments.length === 0 ? (
            <button className="composer__send composer__send--stop" title="停止" onClick={() => interrupt(composerTarget.id)}>■</button>
          ) : (
            <button className="composer__send" title={composerTarget.engine === 'codex' && composerRunning ? sendBehavior === 'queue' ? '排队发送' : '追加补充' : '发送'} onClick={send}>➤</button>
          )}
        </div>
        <div className="composer__toolbar">
          <button className="composer__tool" onClick={() => interrupt(composerTarget.id)}>⏻ 中断</button>
          {composerTarget.engine !== 'codex' ? (
            <button
              className="composer__tool"
              onClick={() => setMode(composerTarget.id, modes[(modes.indexOf(composerTarget.mode) + 1) % modes.length])}
            >
              ⇄ 模式：{composerTarget.mode}
            </button>
          ) : (
            <button
              className="composer__tool"
              onClick={() => setMode(composerTarget.id, CODEX_MODES_ORDER[(CODEX_MODES_ORDER.indexOf(composerTarget.mode) + 1) % CODEX_MODES_ORDER.length])}
              title="Codex 审批模式（下一回合生效）：审批=每条非白名单命令必审 · 自动=模型按需审批 · 全权=不审批+完全访问"
            >
              ⇄ 审批：{CODEX_MODE_LABEL[composerTarget.mode] ?? composerTarget.mode}
            </button>
          )}
          <button className="composer__tool" disabled={busy} onClick={release} title="结束 Web 端进程，保留原生会话供终端继续">
            ⏏ 释放到终端
          </button>
        </div>
      </div>
      )}
    </div>
  )
}
