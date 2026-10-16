import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Markdown } from './Markdown'

type Task = { id: string; serverId: string; project: string; sessionId: string; engine: string; title: string; context: string; request: string; result: string; status: string; updatedAt: number; sourceTruncated: boolean; requestMissing?: boolean; detailsPartial?: boolean; sourceKind?: string; archiveProject?: string; causes?: string[]; lessons?: string[]; progress: Array<{ ts: number; text: string }>; actions: string[]; risks: string[] }
type ImportStatus = { total: number; imported: number; caughtUp?: number; failed: number; limitWarning?: string; error?: string }
type Result = { tasks: Task[]; total: number; answer: string; queryWindow?: { label: string }; answerSections?: Array<{ text: string; sources: string[] }>; answerSources?: Array<{ id: string; taskId?: string; label: string; observedAt: number }>; analysis?: { status: string; error?: string; observedAt: number }; historyExpanded?: boolean; live?: { observedAt: number; scope: string; serverCount: number; onlineCount: number; runningCount: number; pendingCount: number; note: string; retiredAgents?: Array<{ id: string; retiredAt: string }>; servers: Array<{ id: string; online: boolean; transport: string }>; tunnels?: { scope: string; units: Array<{ unit: string; active: boolean; description: string }>; error?: string } }; updatedAt: number; refreshing: boolean; error: string | null; projects: Array<{ project: string; serverId: string }>; coverage: { retainedTasks: number; durable?: { tasks: number }; knowledgeError?: string; backfill?: ImportStatus; nativeHistory?: ImportStatus; deferredSessions?: number; archive: { enabled: boolean }; sources: Array<{ error?: string; truncated?: boolean }> } }
const status: Record<string, string> = { reported_complete: '记录报告完成', in_progress: '有进展，待闭环', blocked: '存在阻塞', unconfirmed: '结果待确认' }
const date = (ts: number) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '时间未记录'

export function ProgressAssistant() {
  const navigate = useNavigate()
  const [question, setQuestion] = useState('')
  const [q, setQ] = useState('')
  const [questionId, setQuestionId] = useState('')
  const [scope, setScope] = useState('')
  const [days, setDays] = useState('7')
  const [data, setData] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const requestId = useRef(0)
  const fullEvidence = useRef(new Map<string, Task>())
  const [host = '', project = ''] = scope.split('/')
  useEffect(() => { const timer = setInterval(() => setRevision(n => n + 1), 60000); return () => clearInterval(timer) }, [])

  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController(), mine = ++requestId.current
    const load = async () => {
      const timeout = setTimeout(() => controller.abort(), 20000)
      setBusy(true)
      try {
        const p = new URLSearchParams({ q, questionId, host, project, days })
        const r = await fetch(`/api/assistant/progress?${p}`, { signal: controller.signal })
        if (!r.ok) throw new Error('小助理记录暂时不可用')
        const d = await r.json() as Result
        if (!alive || mine !== requestId.current) return
        d.tasks = d.tasks.map(t => {
          const full = fullEvidence.current.get(t.id)
          return full && full.updatedAt >= t.updatedAt ? { ...full, detailsPartial: false } : t
        })
        setData(d); setError('')
        if (d.refreshing || ['retrieving', 'planning', 'answering'].includes(d.analysis?.status || '')) timer = setTimeout(() => void load(), 2500)
      } catch (e) { if (alive && mine === requestId.current) setError((e as Error).message) }
      finally { clearTimeout(timeout); if (alive) setBusy(false) }
    }
    void load()
    return () => { alive = false; controller.abort(); clearTimeout(timer) }
  }, [q, questionId, host, project, days, revision])

  const refresh = async () => {
    setBusy(true); setError('')
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000)
    try {
      const r = await fetch('/api/assistant/refresh', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, project }) })
      if (!r.ok) throw new Error('刷新未成功，请稍后重试')
      setQuestionId(String(Date.now()))
      setRevision(n => n + 1)
    } catch (e) { setError((e as Error).message) }
    finally { clearTimeout(timeout); setBusy(false) }
  }
  const loadEvidence = async (task: Task) => {
    if (!task.detailsPartial) return
    try {
      const r = await fetch(`/api/assistant/evidence?${new URLSearchParams({ id: task.id })}`, { signal: AbortSignal.timeout(15000) })
      if (!r.ok) throw new Error('完整证据暂时不可用，请打开原始来源核对')
      const { task: full } = await r.json() as { task: Task }
      fullEvidence.current.set(task.id, full)
      while (fullEvidence.current.size > 50) fullEvidence.current.delete(fullEvidence.current.keys().next().value!)
      setData(previous => previous ? { ...previous, tasks: previous.tasks.map(t => t.id === task.id ? { ...full, detailsPartial: false } : t) } : previous)
    } catch (e) { setError((e as Error).message) }
  }

  return <section className="progress-assistant" aria-label="项目小助理">
    <div className="progress-assistant__head"><div><h2>项目小助理</h2><p className="muted">交办与进展 · 问题原因 · 解决办法 · 风险与经验</p></div><button className="btn" onClick={() => void refresh()} disabled={busy || data?.refreshing}>{data?.refreshing ? '正在读取记录…' : '刷新进展'}</button></div>
    <form className="progress-assistant__ask" onSubmit={e => { e.preventDefault(); setQ(question.trim()); setQuestionId(String(Date.now())); setRevision(n => n + 1) }}>
      <input aria-label="向小助理提问" className="input" value={question} maxLength={500} onChange={e => setQuestion(e.target.value)} placeholder="例如：claude_manager 排查120服务器磁盘，最后怎么解决的？" />
      <button className="btn btn--primary" type="submit" disabled={busy}>查看进展</button>
    </form>
    <div className="progress-assistant__filters">
      <select aria-label="小助理项目范围" className="input" value={scope} onChange={e => setScope(e.target.value)}><option value="">全部服务器 / 项目</option>{data?.projects.map(p => <option key={`${p.serverId}/${p.project}`} value={`${p.serverId}/${p.project}`}>{p.project} · {p.serverId}</option>)}</select>
      <select aria-label="小助理时间范围" className="input" value={days} onChange={e => setDays(e.target.value)}><option value="1">近24小时</option><option value="7">近7天</option><option value="30">近30天</option><option value="90">近90天已采记录</option><option value="36500">全部已沉淀历史</option></select>
    </div>
    {error && <p role="alert">{error}，已显示的记录仍保留。</p>}
    {data?.analysis && ['retrieving', 'planning', 'answering'].includes(data.analysis.status) && <p role="status">{data.analysis.status === 'retrieving' ? '正在检索已沉淀的历史记录…' : data.analysis.status === 'planning' ? '正在理解问题，选择相关项目与记录…' : '正在结合执行记录归纳回答…'} 已取得的证据先显示在下方。</p>}
    {data?.analysis?.error && <p role="alert">{data.analysis.error}</p>}
    {data?.queryWindow && <p className="muted">本次历史检索范围：{data.queryWindow.label}{data.historyExpanded ? '，另补充近90天相关记录' : ''} · 当前状态另行采样</p>}
    {data && <div className="progress-assistant__answer">
      {data.answerSections?.length ? data.answerSections.map((s, i) => {
        const lines=s.text.split('\n'),metadata=/^历史(?:记录报告|索引摘录)/.test(lines[0])&&lines.length>1?lines.shift():''
        const previous=data.answerSections?.[i-1]?.text.split('\n')[0]
        return <div key={i}>{metadata&&metadata!==previous&&<p className="progress-assistant__metadata muted">{metadata}{'\n'}</p>}<p>{metadata?lines.join('\n'):s.text}</p><div className="progress-assistant__citations">{s.sources.map(id => {
        const source = data.answerSources?.find(s => s.id === id)
        const target=id==='LIVE'?'progress-live':id==='SEARCH'?'progress-coverage':`progress-task-${source?.taskId}`
        return <a key={id} href={`#${target}`} onClick={()=>{const el=document.getElementById(target);if(el instanceof HTMLDetailsElement)el.open=true}}>{source?.label || id} · {date(source?.observedAt || 0)}</a>
      })}</div></div>}) : <p>{data.answer}</p>}
      {data.historyExpanded && <p className="muted">为补充处理经过，以下包含近90天的相关历史；记录时间不代表当前状态。</p>}
    </div>}
    {data?.live && <details id="progress-live" className="progress-assistant__coverage"><summary>查看当前状态来源 · {date(data.live.observedAt)}</summary>
      <p>{data.live.scope} · {data.live.serverCount} 台 / 在线 {data.live.onlineCount} 台 · 运行会话 {data.live.runningCount} 个 · 待办 {data.live.pendingCount} 项</p>
      {data.live.servers.map(s => <p key={s.id}>{s.id} · {s.online ? '应用接口可达' : '当前不可达或状态陈旧'} · {s.transport === 'ssh-tunnel' ? 'agent经SSH转发' : s.transport === 'local-direct' ? '本机直连' : '连接方式未标注'}</p>)}
      {!!data.live.retiredAgents?.length&&<p>已退役节点：{data.live.retiredAgents.map(s=>`${s.id}（${s.retiredAt}）`).join('、')}。用于识别旧记录，不计入当前节点或探测范围。</p>}
      {data.live.tunnels && <><p>{data.live.tunnels.scope || data.live.tunnels.error}</p>{data.live.tunnels.units.map(u => <p key={u.unit}>{u.active ? '服务活跃' : '服务未活跃'} · {u.unit} · {u.description}</p>)}</>}
      <p>{data.live.note}</p>
    </details>}
    {data && <details id="progress-coverage" className="progress-assistant__coverage">
      <summary>资料覆盖 · 已沉淀 {data.coverage.durable?.tasks ?? data.coverage.retainedTasks} 条任务证据{data.coverage.backfill ? ` · 归档已读 ${data.coverage.backfill.imported}/${data.coverage.backfill.total} 个会话` : ''}</summary>
      <p>{data.updatedAt ? `最近读取 ${date(data.updatedAt)} · 已留存 ${data.coverage.retainedTasks} 条任务记录` : '正在建立项目进展记录…'}</p>
      {data.coverage.knowledgeError && <p>{data.coverage.knowledgeError}</p>}
      {data.coverage.backfill?.error && <p>{data.coverage.backfill.error}</p>}
      {data.coverage.backfill?.limitWarning && <p>{data.coverage.backfill.limitWarning}</p>}
      {data.coverage.nativeHistory && <p>现役会话补读：已追平 {data.coverage.nativeHistory.caughtUp ?? data.coverage.nativeHistory.imported}/{data.coverage.nativeHistory.total} 个会话，完整覆盖 {data.coverage.nativeHistory.imported} 个。长会话分批处理，新增内容继续按检查点读取。{data.coverage.nativeHistory.limitWarning}{data.coverage.nativeHistory.error}</p>}
      {!data.coverage.archive.enabled && <p>中心历史采集当前关闭；已有归档仍可检索，现役会话正在逐步补读，尚不能代表全部历史。</p>}
      {data.coverage.sources.some(s => s.truncated) && <p>长会话按尾部读取，较早交办可能未覆盖；结论以卡片时间和原文为准。</p>}
      {data.coverage.sources.some(s => s.error) && <p>部分来源暂未取得可用记录，已保留旧证据。可选择具体项目后刷新。</p>}
      {!!data.coverage.deferredSessions && <p>本轮另有 {data.coverage.deferredSessions} 个会话等待下轮读取；可选具体项目优先刷新。</p>}
      {data.error && <p>本次更新未完成：{data.error}</p>}
    </details>}
    {!data && !error && <p role="status">正在加载小助理…</p>}
    <div className="progress-assistant__tasks">{data?.tasks.map(t => <article className="progress-task" id={`progress-task-${t.id}`} key={t.id}>
      <div className="progress-task__head"><strong>{t.project}</strong><span className={`progress-task__status progress-task__status--${t.status}`}>{status[t.status] || '结果待确认'}</span></div>
      <p className="muted">{t.serverId} · {t.engine} · {date(t.updatedAt)}</p>
      <h3>{t.title}</h3>
      {t.context !== t.request && <p className="muted">前文交办：{t.context}</p>}
      {!!t.causes?.length && <div className="progress-task__knowledge"><strong>记录中的问题原因</strong>{t.causes.map((c, i) => <p key={i}>{c}</p>)}</div>}
      {!!t.lessons?.length && <div className="progress-task__knowledge"><strong>可复用的经验</strong>{t.lessons.map((c, i) => <p key={i}>{c}</p>)}</div>}
      <div className="progress-task__result"><Markdown text={t.result || '尚无可见结果回复，不能确认任务完成。'} onFileLink={() => navigate(`/session/${encodeURIComponent(t.sessionId)}`)} /></div>
      {t.risks.length > 0 && <div className="progress-task__risk"><strong>需要关注</strong>{t.risks.map((r, i) => <p key={i}>{r}</p>)}</div>}
      <details onToggle={e => { if (e.currentTarget.open) void loadEvidence(t) }}><summary>查看交办与处理证据</summary>{t.detailsPartial && <p className="muted">正在按需读取完整证据，以下先显示预览。</p>}<p className="progress-task__quote">{t.requestMissing ? '原始交办不在本次读取范围内，以下仅是已取得的处理回复。' : `交办原文：${t.request}`} </p>{t.progress.map((p, i) => <div key={i} className="progress-task__quote"><small>{date(p.ts)} · 当时回复</small><p>{p.text}</p></div>)}{t.actions.length > 0 && <div className="progress-task__quote"><strong>记录中的操作</strong>{t.actions.map((a, i) => <pre key={i}>{a}</pre>)}</div>}{t.sourceTruncated && <p className="muted">当前证据仅覆盖来源的一部分，未包含的步骤需要核对原文。</p>}</details>
      {t.sourceKind?.startsWith('archive') ? <a href={`/api/archive/session?${new URLSearchParams({ host: t.serverId, project: t.archiveProject || t.project, session: t.sessionId, limit: '200' })}`} target="_blank" rel="noreferrer">查看归档原文 →</a> : <Link to={`/session/${encodeURIComponent(t.sessionId)}`}>打开原会话 →</Link>}
    </article>)}</div>
    {data && data.total > data.tasks.length && <p className="muted">显示最近 {data.tasks.length} 条相关记录，共 {data.total} 条。选择具体项目或关键词缩小范围。</p>}
  </section>
}
