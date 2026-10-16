import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

// 「执行历史」（WebAgents 2.0 / P3）：读 MongoDB 的执行事件投影。
//
// 与「对话流」的本质区别：对话流读的是 **JSONL 权威源**（完整正文，但只在那台 agent 的磁盘上）；
// 这里读的是 **Mongo 跨服务器历史投影**（脱敏摘要，但**跨 agent 重启持久、可按类型/时间聚合**）。
// Mongo 不可用时 available=false → 提示回退（对话流照常可用，不受任何影响）。
//
// ⚠️ 布局是**按回合(turn)分组**，不是平铺事件流——第一版就是平铺的，用户实测反馈：
// 「看不出交互的过程，感觉就是一行行的日志，上下文信息还看不太明白」。根因是没有语义锚点：
// 剥掉全部文本后，一屏「更新文件 console.html +3 −2」重复十几行，读者无从知道这串在干什么。
// 所以：**每个回合以「用户问了什么」开头**（payload.summary），工具步骤缩进挂在它下面，
// 助手回答作为该回合的落点。别改回平铺。

type Ev = {
  eventKey: string
  type: string
  occurredAt: string
  payload: {
    verb?: string; path?: string; cmdPreview?: string; summary?: string
    additions?: number; deletions?: number; status?: string
  }
}

type Turn = {
  key: string
  ask: Ev | null          // 这一轮的用户提问（语义锚点；开场轮可能没有）
  steps: Ev[]             // 工具步骤
  replies: Ev[]           // 助手回答
  startedAt: number
  endedAt: number
}

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(+d)) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtDur = (ms: number) => {
  if (!ms || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`
}

// 动作 → 单字标识（左侧轨道），比 emoji 更贴合本项目的排版语言
const glyphOf = (verb?: string) => {
  if (!verb) return '·'
  if (verb.includes('执行')) return '›'
  if (verb.includes('读')) return '◦'
  if (verb.includes('更新') || verb.includes('写') || verb.includes('创建')) return '✎'
  return '·'
}

// 一页多少条。首屏原为 800——实测中位会话才 100~200 条，800 条 ≈ 240KB 首包，多数人白等；
// 而真正长的会话（实测 1811 条）800 也不够，得能往前翻。故改成小页 + 「加载更早」。
export const PAGE_SIZE = 300

/**
 * 把「更早的一页」并到已有事件前面，按 eventKey 去重。
 *
 * 去重是**第二道保险**：后端的复合游标 (occurredAt, eventKey) 已保证不漏不重，但同毫秒事件
 * 是这条链路上最容易出错的地方（见 server/timeline-cursor.js），多一道幂等合并不亏。
 * 不重新排序：两页各自已是时间正序，且 older 整页都早于 existing；重排反而可能把同毫秒事件
 * 的次序搅得与游标序不一致。
 */
export function mergeEarlier<T extends { eventKey: string }>(existing: T[], older: T[]): T[] {
  const seen = new Set(existing.map((e) => e.eventKey))
  return [...older.filter((e) => !seen.has(e.eventKey)), ...existing]
}

/** 事件流 → 回合。每遇到一条用户提问就开一个新回合；提问前的散件归入「开场」。 */
function toTurns(events: Ev[]): Turn[] {
  const turns: Turn[] = []
  let cur: Turn | null = null
  const open = (ask: Ev | null, at: number, i: number) => {
    cur = { key: ask?.eventKey ?? `t-${i}`, ask, steps: [], replies: [], startedAt: at, endedAt: at }
    turns.push(cur)
  }
  events.forEach((e, i) => {
    const at = +new Date(e.occurredAt) || 0
    if (e.type === 'user.message') open(e, at, i)
    else {
      if (!cur) open(null, at, i)
      if (e.type === 'assistant.message') cur!.replies.push(e)
      else cur!.steps.push(e)
      if (at) cur!.endedAt = at
    }
  })
  return turns
}

function StepRow({ e }: { e: Ev }) {
  const p = e.payload ?? {}
  const isCmd = !!p.cmdPreview
  return (
    <div className="turn__step">
      <span className="turn__glyph">{glyphOf(p.verb)}</span>
      <span className="turn__verb">{p.verb ?? e.type}</span>
      {(p.path || p.cmdPreview) && (
        <span className={`turn__target mono ${isCmd ? 'turn__target--cmd' : ''}`}>{p.cmdPreview ?? p.path}</span>
      )}
      {(p.additions || p.deletions) && (
        <span className="turn__diff mono">
          {p.additions ? <span className="turn__add">+{p.additions}</span> : null}
          {p.deletions ? <span className="turn__del">−{p.deletions}</span> : null}
        </span>
      )}
    </div>
  )
}

function TurnCard({ t, defaultOpen }: { t: Turn; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const nSteps = t.steps.length
  const files = new Set(t.steps.map((s) => s.payload?.path).filter(Boolean)).size
  const dur = fmtDur(t.endedAt - t.startedAt)

  return (
    <div className={`turn ${open ? 'turn--open' : ''}`}>
      <button className="turn__head" onClick={() => setOpen((v) => !v)}>
        <span className="turn__caret">{open ? '▾' : '▸'}</span>
        <span className="turn__who">你</span>
        <span className="turn__ask">
          {t.ask?.payload?.summary
            ?? <i className="turn__ask--none">（这一段没有用户提问——多为接管前的既有上下文）</i>}
        </span>
        <span className="turn__time mono">{fmtTime((t.ask ?? t.steps[0] ?? t.replies[0])?.occurredAt ?? '')}</span>
      </button>

      {open && (
        <div className="turn__body">
          {t.steps.map((e) => <StepRow key={e.eventKey} e={e} />)}
          {t.replies.map((e) => (
            <div key={e.eventKey} className="turn__reply">
              <span className="turn__glyph turn__glyph--say">↳</span>
              <span className="turn__reply-text">{e.payload?.summary ?? '（本条回答无摘要）'}</span>
            </div>
          ))}
          {!nSteps && !t.replies.length && <div className="turn__none">这一轮没有留下工具动作</div>}
        </div>
      )}

      <div className="turn__meta">
        {nSteps ? `${nSteps} 个动作` : '无动作'}
        {files ? ` · 涉及 ${files} 个文件` : ''}
        {dur ? ` · 耗时 ${dur}` : ''}
      </div>
    </div>
  )
}

export function ExecTrace({ sessionId }: { sessionId: string }) {
  const [events, setEvents] = useState<Ev[] | null>(null)
  const [available, setAvailable] = useState(true)
  const [asOf, setAsOf] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)   // 上面还有更早的没加载（后端多取一条判出来的）
  const [oldest, setOldest] = useState<string | null>(null) // 本地最老一条的游标，翻页用
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreErr, setMoreErr] = useState(false)

  useEffect(() => {
    let alive = true
    setEvents(null); setHasMore(false); setOldest(null); setMoreErr(false)
    fetch(`/api/v2/runs/${sessionId}/timeline?limit=${PAGE_SIZE}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        setAvailable(!!d.available)
        setEvents(d.events ?? [])
        setAsOf(d.asOf ?? null)
        setHasMore(!!d.hasMore)
        setOldest(d.oldest ?? null)
      })
      .catch(() => { if (alive) { setAvailable(false); setEvents([]) } })
    return () => { alive = false }
  }, [sessionId])

  // ⚠️ 往列表**顶部**插内容必须锚定滚动位置。不做的话，新增的几百条把你正在读的那段整体
  // 往下推，视线当场跳走——本仓库在滚动上已经栽过两次（「跟随最新」自己把自己关掉、
  // PullRefresh 因换了滚动容器而误触发），别再添第三次。
  // 会话详情页是**刻意保留 body 滚动模型**的（见 CLAUDE.md），所以量的是 documentElement。
  const anchorRef = useRef<number | null>(null) // 插入前的 scrollHeight
  useLayoutEffect(() => {
    if (anchorRef.current == null) return
    const delta = document.documentElement.scrollHeight - anchorRef.current
    anchorRef.current = null
    if (delta > 0) window.scrollBy(0, delta) // 补回被顶下去的高度 = 视线不动
  }, [events])

  const loadEarlier = useCallback(async () => {
    if (!oldest || loadingMore) return
    setLoadingMore(true); setMoreErr(false)
    anchorRef.current = document.documentElement.scrollHeight // 先量，再改 state
    try {
      const qs = `limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest)}`
      const d = await (await fetch(`/api/v2/runs/${sessionId}/timeline?${qs}`)).json()
      const older: Ev[] = d.events ?? []
      setEvents((prev) => mergeEarlier(prev ?? [], older))
      setHasMore(!!d.hasMore)
      // 后端没给新游标（理论上只在空页时）就别再翻，避免原地打转
      if (d.oldest) setOldest(d.oldest); else setHasMore(false)
    } catch {
      anchorRef.current = null // 没插入成功就别补偿，否则平白滚一段
      setMoreErr(true)
    } finally { setLoadingMore(false) }
  }, [sessionId, oldest, loadingMore])

  const turns = useMemo(() => toTurns(events ?? []), [events])

  if (events === null) return <div className="trace-empty">加载执行历史…</div>

  if (!available) {
    return (
      <div className="trace-empty">
        MongoDB 当前不可用，执行历史暂不可查。
        <div className="trace-empty__sub">对话流不受影响（它读的是 JSONL 权威源）。历史恢复后会自动补齐——事件已暂存本地 spool。</div>
      </div>
    )
  }
  if (!events.length) {
    return (
      <div className="trace-empty">
        这个会话还没有投影到历史库的事件。
        <div className="trace-empty__sub">历史是异步投影（Hub 轮询增量写入），新活动稍后出现。</div>
      </div>
    )
  }

  const steps = events.filter((e) => e.type === 'tool.used').length

  return (
    <div className="trace">
      {/* 计数必须诚实：hasMore 时这些数字只是**已加载**的部分，不是全集。
          旧版把截断后的「93 个回合」当全集显示，用户完全无从知道前面还有 1000 条事件——
          与 session-allocate.js 记录的「截断不能是静默的」是同一个错误。 */}
      <div className="trace__head">
        <span className="trace__count mono">{turns.length}</span>
        <span className="trace__hint">
          {hasMore ? '个回合（已加载）· ' : '个回合 · '}{steps} 个动作 · 来自 MongoDB 跨服务器历史投影
        </span>
        {asOf && <span className="trace__asof">截至 {fmtTime(new Date(asOf).toISOString())}</span>}
      </div>

      <div className="trace__turns">
        {hasMore && (
          <div className="trace__earlier">
            <button className="btn btn--sm btn--ghost" onClick={loadEarlier} disabled={loadingMore}>
              {loadingMore ? '加载中…' : `加载更早的 ${PAGE_SIZE} 条`}
            </button>
            <span className="trace__earlier-hint">
              {moreErr ? '加载失败，请重试' : '上面还有更早的执行记录'}
            </span>
          </div>
        )}
        {/* 越靠后的回合越可能是用户当下关心的 → 最后 3 轮默认展开，早期折叠 */}
        {turns.map((t, i) => <TurnCard key={t.key} t={t} defaultOpen={i >= turns.length - 3} />)}
      </div>

      <div className="trace__foot">
        这里是<b>脱敏摘要</b>（提问/回答各截前 140 字，工具名与路径，命令只留短预览）——
        完整正文请看「对话流」。Prompt 全文、终端输出、密钥一律不入库。
      </div>
    </div>
  )
}
