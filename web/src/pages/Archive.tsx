import { useCallback, useEffect, useRef, useState } from 'react'
import { relTime } from '../lib/format'
import { EngineBadge } from '../components/EngineBadge'
import { ProgressAssistant } from '../components/ProgressAssistant'
import type { Engine } from '../types'

// 执行历史检索页（openspec change: execution-history-archive，P1）。
//
// 目标（GOAL.md）：让「这类问题上次是怎么解的」从**翻不到**变成**十几秒查到并能溯源**。
//
// ⚠️ 两条与跨境链路直接相关的约束（GOAL C 表）：
//  ① **首屏 ≤ 15 KB gzip**——链路实测 ~11 KB/s、地板 ~2s。所以默认只取 30 条、
//     且服务端已保证结果里不含原文；原文点开才取。
//  ② **输入要防抖**。这页会被在手机上用，每敲一个字发一次请求，在 11 KB/s 的链路上
//     就是自己攻击自己——本仓库在 /api/state 轮询上栽过一次（请求堆叠打满 keepalive 池）。

interface Snippet { from: 'prompt' | 'command' | 'file' | 'text'; text: string; hits: string[] }

interface Hit {
  host: string
  project: string
  session: string
  engine: Engine
  startedAt: number
  lastAt: number
  model?: string
  tokens?: number
  firstPrompt?: string
  files?: string[]
  commands?: string[]
  snippets?: Snippet[]
}

const ENGINES: Array<{ v: string; label: string }> = [
  { v: '', label: '全部引擎' },
  { v: 'claude', label: 'Claude' },
  { v: 'codex', label: 'Codex' },
  { v: 'kimi', label: 'Kimi' },
]

const FROM_LABEL: Record<string, string> = { prompt: '提问', command: '命令', file: '文件', text: '正文' }

/**
 * 高亮匹配词。
 * ★★ 为什么这段是这个页面最重要的东西（2026-08-31 用户实测）：
 *   用户搜自己问过的一句话，界面显示「命中 1」，但卡片上是那条会话的**开场白**，
 *   跟搜索词毫无关系 ⇒ 看起来像匹配错了。**其实匹配是对的，只是没把命中处给他看。**
 *   **看不懂的命中，召回率再高也没用。**
 */
function Mark({ text, hits }: { text: string; hits: string[] }) {
  if (!hits?.length) return <>{text}</>
  const re = new RegExp(`(${hits.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return <>{text.split(re).map((part, i) => (re.test(part) && (re.lastIndex = 0, true)
    ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}</>
}

/** 项目名在归档里是编码过的 cwd（`-data-web-agents`），显示时还原成人看的样子。 */
const projName = (p: string) => String(p ?? '').replace(/^-/, '').replace(/-/g, '/')

export default function Archive() {
  const [q, setQ] = useState('')
  const [engine, setEngine] = useState('')
  const [cmd, setCmd] = useState('')
  const [file, setFile] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [total, setTotal] = useState(0)
  const [indexSize, setIndexSize] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const seq = useRef(0)

  const run = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true); setErr(null)
    const p = new URLSearchParams()
    if (q.trim()) p.set('q', q.trim())
    if (engine) p.set('engine', engine)
    if (cmd.trim()) p.set('cmd', cmd.trim())
    if (file.trim()) p.set('file', file.trim())
    p.set('limit', '30')
    try {
      const res = await fetch(`/api/archive/search?${p}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      if (mine !== seq.current) return          // 迟到的响应不得覆盖新结果
      setHits(d.hits ?? []); setTotal(d.total ?? 0); setIndexSize(d.indexSize ?? null)
    } catch (e) {
      if (mine === seq.current) setErr(String((e as Error)?.message ?? e))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [q, engine, cmd, file])

  // 防抖 400ms：跨境链路只有 ~11 KB/s，每敲一个字发一次就是自己攻击自己
  useEffect(() => {
    const t = setTimeout(() => { void run() }, 400)
    return () => clearTimeout(t)
  }, [run])

  const openDetail = async (h: Hit) => {
    const id = `${h.host}/${h.project}/${h.session}`
    if (open === id) { setOpen(null); setDetail(null); return }
    setOpen(id); setDetail(null)
    // ★ 把检索词一起送过去 —— 服务端据此定位到**匹配处**的对话，而不是会话开头
    const p = new URLSearchParams({ host: h.host, project: h.project, session: h.session, limit: '80', q: q.trim() })
    try {
      const res = await fetch(`/api/archive/session?${p}`)
      setDetail(res.ok ? await res.json() : { error: `HTTP ${res.status}` })
    } catch (e) { setDetail({ error: String((e as Error)?.message ?? e) }) }
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1>执行历史</h1>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {indexSize != null ? `已归档 ${indexSize.toLocaleString()} 个会话` : '…'}
          {total > 0 && ` · 命中 ${total.toLocaleString()}`}
        </span>
      </div>

      <ProgressAssistant />
      <h2 style={{ fontSize: 17, marginTop: 28 }}>原始执行记录检索</h2>
      <div className="archive__filters">
        <input
          className="input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="关键词：提问 / 项目 / 命令 / 文件都能搜，多个词用空格（全部命中才算）"
          autoFocus
        />
        <div className="archive__row">
          <select className="input input--sm" value={engine} onChange={(e) => setEngine(e.target.value)}>
            {ENGINES.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
          </select>
          <input className="input input--sm" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="跑过的命令，如 docker" />
          <input className="input input--sm" value={file} onChange={(e) => setFile(e.target.value)} placeholder="改过的文件，如 hub.js" />
        </div>
      </div>

      {err && <div className="empty-state">检索失败：{err}</div>}
      {!err && !loading && hits.length === 0 && (
        <div className="empty-state">
          {q || cmd || file || engine ? '没有命中。换个词试试——关键词会同时匹配提问、项目、命令与文件。' : '输入关键词开始检索。'}
        </div>
      )}

      <div className="archive__list">
        {hits.map((h) => {
          const id = `${h.host}/${h.project}/${h.session}`
          return (
            <div key={id} className={`archive__item ${open === id ? 'archive__item--open' : ''}`}>
              <button className="archive__head" onClick={() => void openDetail(h)}>
                <EngineBadge engine={h.engine} model={h.model} />
                <span className="archive__proj">{projName(h.project)}</span>
                <span className="archive__prompt">{h.firstPrompt || '(无提问)'}</span>
                <span className="archive__time">{relTime(h.lastAt)}</span>
              </button>
              {/* ★ 溯源坐标常驻可见：GOAL 的硬指标是「可溯源率 100%」，
                  藏在展开里就等于没有——用户扫一眼列表就该知道这条来自哪台机、哪个项目。 */}
              {/* ★ 匹配片段紧跟标题，是这张卡片上最重要的信息 —— 用户要靠它判断"是不是我要找的" */}
              {!!h.snippets?.length && (
                <div className="archive__snips">
                  {h.snippets.map((sn, i) => (
                    <div key={i} className="archive__snip">
                      <span className="archive__snipfrom">{FROM_LABEL[sn.from] ?? sn.from}</span>
                      <span className="archive__sniptext"><Mark text={sn.text} hits={sn.hits} /></span>
                    </div>
                  ))}
                </div>
              )}
              <div className="archive__meta">
                <code>{h.host}</code>
                <code title={h.session}>{h.session.slice(0, 12)}</code>
                {(h.files ?? []).slice(0, 3).map((f) => <span key={f} className="archive__tag">{f}</span>)}
                {(h.commands ?? []).slice(0, 2).map((c) => <span key={c} className="archive__tag archive__tag--cmd">{c}</span>)}
              </div>
              {open === id && (
                <div className="archive__detail">
                  {!detail && <span className="muted">加载中…</span>}
                  {detail?.error != null && <span className="muted">取原文失败：{String(detail.error)}</span>}
                  {detail && !detail.error && <Detail d={detail} />}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface Msg { role: string; text: string; ts?: string | number | null; matched?: boolean }

function Detail({ d }: { d: Record<string, unknown> }) {
  const det = (d.detail ?? {}) as { commands?: Array<{ cmd: string; n: number }>; files?: string[]; texts?: string[] }
  const lines = (d.lines ?? []) as string[]
  const ctx = (d.context ?? {}) as { messages?: Msg[]; total?: number }
  return (
    <>
      <div className="archive__stat">原文 {String(d.total ?? 0)} 行 · 对话 {ctx.total ?? 0} 条 · 命令 {det.commands?.length ?? 0} · 文件 {det.files?.length ?? 0}</div>
      {/* ★★ 对话上下文排在**最前面**：用户搜自己的提问，是想看「当时怎么回答的」。
          命令清单是辅助信息，不该挡在答案前面（2026-08-31 用户实测反馈）。 */}
      {!!ctx.messages?.length && (
        <div className="archive__block">
          <div className="archive__blockhead">命中处的对话</div>
          <div className="archive__conv">
            {ctx.messages.map((m, i) => (
              <div key={i} className={`archive__msg archive__msg--${m.role} ${m.matched ? 'archive__msg--hit' : ''}`}>
                <span className="archive__role">{m.role === 'user' ? '你' : 'Claude'}</span>
                <span className="archive__msgtext">{m.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!!det.commands?.length && (
        <div className="archive__block">
          <div className="archive__blockhead">跑过的命令</div>
          {det.commands.slice(0, 12).map((c) => (
            <div key={c.cmd} className="archive__cmd"><code>{c.cmd}</code>{c.n > 1 && <em> ×{c.n}</em>}</div>
          ))}
        </div>
      )}
      {!!det.files?.length && (
        <div className="archive__block">
          <div className="archive__blockhead">改过的文件</div>
          <div className="archive__files">{det.files.slice(0, 20).map((f) => <code key={f}>{f}</code>)}</div>
        </div>
      )}
      {!!lines.length && (
        <div className="archive__block">
          <div className="archive__blockhead">原文片段（前 {Math.min(lines.length, 8)} 行）</div>
          <pre className="archive__raw">{lines.slice(0, 8).map((l) => l.slice(0, 300)).join('\n')}</pre>
        </div>
      )}
    </>
  )
}
