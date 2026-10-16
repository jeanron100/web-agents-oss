import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Markdown } from '../components/Markdown'
import { EngineBadge } from '../components/EngineBadge'
import { StatusDot } from '../components/StatusDot'
import { relTime, money, fmtTokens } from '../lib/format'

// 今日复盘（功能1）：跨项目跨服务器，聚合某天有进展的会话 + haiku 生成的「卓有成效 / 进展不足 / 明日建议」。

type ReviewSession = { id: string; engine: 'claude' | 'codex' | 'kimi'; model: string; state: string; summary: string; lastActiveAt: number; tokens: number; cost: number }
type ReviewProject = { project: string; server: string; serverName: string; sessions: ReviewSession[] }
type ReviewData = { date: string; projects: ReviewProject[]; totalSessions: number; totalProjects: number }
type Turn = { seq: number; user: { text: string; imageCount: number }; abstract: string | null; hasReply: boolean }

const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const shiftDate = (s: string, days: number) => {
  const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function SessionRow({ s }: { s: ReviewSession }) {
  const navigate = useNavigate()
  const [turns, setTurns] = useState<Turn[] | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const refine = async () => {
    setOpen((v) => !v)
    if (turns || loading) return
    setLoading(true)
    try {
      // 先取缓存，没要点再触发精炼
      let r = await (await fetch(`/api/session/${s.id}/digest`)).json()
      if (!(r.turns ?? []).some((t: Turn) => t.abstract)) {
        r = await (await fetch(`/api/session/${s.id}/digest/build`, { method: 'POST' })).json()
      }
      setTurns(r.turns ?? [])
    } catch { setTurns([]) } finally { setLoading(false) }
  }

  return (
    <div className="rv-sess">
      <div className="rv-sess__row">
        <StatusDot state={s.state as never} />
        <EngineBadge engine={s.engine} model={s.model} />
        <button className="rv-sess__summary" onClick={() => navigate(`/session/${s.id}`)} title="打开会话">
          {s.summary || '（无摘要）'}
        </button>
        <span className="rv-sess__meta">{fmtTokens(s.tokens)}{s.cost > 0 ? ` · ${money(s.cost)}` : ''} · {relTime(s.lastActiveAt)}</span>
        <button className="rv-sess__refine" onClick={refine}>{open ? '收起' : '精炼 ▾'}</button>
      </div>
      {open && (
        <div className="rv-sess__turns">
          {loading && <div className="empty-state" style={{ padding: 10, fontSize: 12 }}>精炼中…</div>}
          {turns?.map((t) => (
            <div key={t.seq} className="rv-turn">
              <div className="rv-turn__q"><span className="rv-turn__seq">#{t.seq}</span> {t.user.text.slice(0, 120)}{t.user.imageCount ? ` 🖼${t.user.imageCount}` : ''}</div>
              {t.abstract && <div className="rv-turn__a">↳ {t.abstract}</div>}
            </div>
          ))}
          {turns && turns.length === 0 && <div className="empty-state" style={{ padding: 10, fontSize: 12 }}>无可精炼内容</div>}
        </div>
      )}
    </div>
  )
}

export default function Review() {
  const navigate = useNavigate()
  const [date, setDate] = useState(todayStr)
  const [data, setData] = useState<ReviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [reflectMd, setReflectMd] = useState<string>('')
  const [reflecting, setReflecting] = useState(false)

  const load = useCallback(async (d: string) => {
    setLoading(true); setReflectMd('')
    try {
      const r = await fetch(`/api/review?date=${d}`)
      setData(r.ok ? await r.json() : null)
    } catch { setData(null) } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(date) }, [date, load])

  const reflect = async () => {
    setReflecting(true)
    try {
      const r = await fetch('/api/review/reflect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }),
      })
      const j = await r.json()
      setReflectMd(j.markdown || '（未能生成复盘）')
    } catch { setReflectMd('生成复盘失败（可能超时）') } finally { setReflecting(false) }
  }

  const isToday = date === todayStr()

  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn" onClick={() => navigate('/')}>←</button>
        <h1 className="page-head__title">复盘</h1>
      </header>

      <div className="rv-datebar">
        <button className="select-pill" onClick={() => setDate((d) => shiftDate(d, -1))}>‹ 前一天</button>
        <span className="rv-date">{date}{isToday ? ' · 今天' : ''}</span>
        <button className="select-pill" disabled={isToday} onClick={() => setDate((d) => shiftDate(d, 1))}>后一天 ›</button>
      </div>

      <div className="rv-summary">
        {loading ? '加载中…' : data ? `${data.totalProjects} 个项目 · ${data.totalSessions} 个会话有进展` : '无数据'}
        <button className="btn btn--sm btn--primary" disabled={reflecting || !data || data.totalSessions === 0} onClick={reflect}>
          {reflecting ? '生成中…' : '✦ 生成今日复盘'}
        </button>
      </div>

      {reflectMd && (
        <div className="rv-reflect md">
          <Markdown text={reflectMd} />
        </div>
      )}

      {data?.projects.map((p) => (
        <section className="rv-proj" key={`${p.server}|${p.project}`}>
          <div className="rv-proj__head">
            <span className="rv-proj__name">{p.project}</span>
            <span className="rv-proj__server">{p.serverName}</span>
            <span className="rv-proj__count">{p.sessions.length} 会话</span>
          </div>
          {p.sessions.map((s) => <SessionRow key={s.id} s={s} />)}
        </section>
      ))}

      {data && data.totalSessions === 0 && !loading && (
        <div className="empty-state" style={{ paddingTop: 40 }}>这一天没有会话进展</div>
      )}
    </div>
  )
}
