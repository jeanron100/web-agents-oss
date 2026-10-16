import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Engine } from '../types'
import { relTime } from '../lib/format'
import { EngineBadge } from '../components/EngineBadge'

interface SearchHit {
  sessionId: string
  serverId: string
  project: string
  engine: Engine
  title: string
  snippet: string
  lastActiveAt: number
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}

export default function Search() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) { setHits([]); setSearched(false); return }
    const mySeq = ++seq.current
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
        const data = await res.json()
        if (seq.current === mySeq) { setHits(data.hits ?? []); setSearched(true) }
      } catch { /* 忽略 */ } finally {
        if (seq.current === mySeq) setLoading(false)
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [q])

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <header className="page-head">
        <button className="icon-btn" onClick={() => navigate(-1)}>←</button>
        <input
          className="composer__input"
          style={{ flex: 1, minHeight: 38, padding: '7px 13px' }}
          placeholder="搜索全部服务器的会话标题与内容…"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
        />
      </header>

      {loading && <div className="empty-state" style={{ padding: '28px 0' }}>搜索中…</div>}

      {!loading && searched && hits.length === 0 && (
        <div className="empty-state">没有匹配的会话</div>
      )}

      {hits.map((h) => (
        <button key={h.sessionId} className="search-result" onClick={() => navigate(`/session/${h.sessionId}`)}>
          <div className="search-result__head">
            <EngineBadge engine={h.engine} />
            <b style={{ color: 'var(--text)' }}>{h.project}</b>
            <span>{h.serverId}</span>
            <span style={{ marginLeft: 'auto' }}>{relTime(h.lastActiveAt)}</span>
          </div>
          <div style={{ marginTop: 5, fontSize: 14, fontWeight: 600 }}>
            <Highlight text={h.title} q={q.trim()} />
          </div>
          {h.snippet && (
            <div className="search-result__snippet">
              <Highlight text={h.snippet} q={q.trim()} />
            </div>
          )}
        </button>
      ))}
    </div>
  )
}
