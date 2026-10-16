import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../store/store'
import { relTime } from '../lib/format'

type ConnStatus = 'connecting' | 'connected' | 'disconnected'

const STATUS_LABEL: Record<ConnStatus, string> = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
}

// 服务端 /api/term/list 的会话条目
type TermInfo = {
  termId: string
  label: string
  created: number
  activity: number
  cwd: string
  command: string
  running: boolean
  viewers: number
  keep: boolean
}

const TERM_THEME_STORAGE_KEY = 'agent-console-term-theme'

const TERM_THEMES: Array<{ id: string; label: string; theme: Record<string, string> }> = [
  { id: 'dark',      label: '深黑',       theme: { background: '#0b0e14', foreground: '#c9d1d9', cursor: '#58a6ff', selectionBackground: '#264f78' } },
  { id: 'night',     label: '暗夜蓝',     theme: { background: '#1a1b26', foreground: '#c0caf5', cursor: '#7aa2f7', selectionBackground: '#33467c' } },
  { id: 'solarized', label: 'Solarized', theme: { background: '#002b36', foreground: '#93a1a1', cursor: '#2aa198', selectionBackground: '#073642' } },
  { id: 'light',     label: '浅色',       theme: { background: '#ffffff', foreground: '#24292e', cursor: '#0969da', selectionBackground: '#b6d3f7' } },
  { id: 'sepia',     label: '护眼',       theme: { background: '#f4ecd8', foreground: '#5b4636', cursor: '#5b4636', selectionBackground: '#e0d3b0' } },
]

function loadStoredThemeId() {
  try {
    const saved = localStorage.getItem(TERM_THEME_STORAGE_KEY)
    if (saved && TERM_THEMES.some((t) => t.id === saved)) return saved
  } catch { /* localStorage 不可用时静默回退默认主题 */ }
  return 'dark'
}

const TERM_FONTSIZE_STORAGE_KEY = 'agent-console-term-fontsize'

// 字号越小屏幕能容下的列数越多——手机上 13px 常挤不下 top/htop 的表头，给「小」选项
const TERM_FONT_SIZES: Array<{ id: number; label: string }> = [
  { id: 11, label: '小' },
  { id: 13, label: '中' },
  { id: 15, label: '大' },
]

function loadStoredFontSize() {
  try {
    const saved = Number(localStorage.getItem(TERM_FONTSIZE_STORAGE_KEY))
    if (TERM_FONT_SIZES.some((f) => f.id === saved)) return saved
  } catch { /* localStorage 不可用时静默回退默认字号 */ }
  return 13
}

// 每台服务器「上次用的会话」记忆键：进页面/换服务器自动复用上次那个会话（若仍存在）。
const lastTermKey = (serverId: string) => `agent-console-term-last/${serverId}`

function genTermId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// 移动端键盘没有 Ctrl/Esc/方向键 → 屏幕控制键：点一下就把对应控制字节发进终端。
const CTRL_KEYS: Array<{ label: string; seq: string }> = [
  { label: 'Ctrl C', seq: '\x03' },
  { label: 'Ctrl D', seq: '\x04' },
  { label: 'Ctrl Z', seq: '\x1a' },
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\x09' },
  { label: 'Clear', seq: '\x0c' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
]

export default function Terminal() {
  const servers = useAppStore((s) => s.servers)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const retryRef = useRef(0)
  const lastReceiveRef = useRef(0)
  const connectRef = useRef<(fresh?: boolean) => void>(() => {})
  const [latency, setLatency] = useState<number | null>(null)
  // 新建会话时置 true → 建连后补发 Ctrl-L 干净重绘；复用已有会话时 false（不清用户已有画面）
  const freshRef = useRef(false)
  // 当前服务器（同步 ref）：挡住「切服务器后，旧服务器的 refreshSessions 迟到回来把列表写脏」的竞态
  const serverIdRef = useRef('')
  // 用户已新建/选择终端后，迟到的列表加载不得再自动切回旧会话或选择器。
  const selectionRevision = useRef(0)

  const [serverId, setServerId] = useState('')
  const [termId, setTermId] = useState('') // 当前挂载的会话；'' = 未选（显示选择器）
  const [cwd, setCwd] = useState('')
  const [cwdDraft, setCwdDraft] = useState('')
  const [status, setStatus] = useState<ConnStatus>('connecting')
  const [themeId, setThemeId] = useState(() => loadStoredThemeId())
  const [fontSize, setFontSize] = useState(() => loadStoredFontSize())
  const [sessions, setSessions] = useState<TermInfo[]>([])
  const [pickerBusy, setPickerBusy] = useState(false)

  const activeTheme = TERM_THEMES.find((t) => t.id === themeId) ?? TERM_THEMES[0]
  const current = sessions.find((s) => s.termId === termId) ?? null

  const handleThemeChange = (id: string) => {
    setThemeId(id)
    try { localStorage.setItem(TERM_THEME_STORAGE_KEY, id) } catch { /* 存储失败不影响当次切换 */ }
    const next = TERM_THEMES.find((t) => t.id === id)
    if (next && termRef.current) termRef.current.options.theme = next.theme
  }

  const handleFontSizeChange = (size: number) => {
    setFontSize(size)
    try { localStorage.setItem(TERM_FONTSIZE_STORAGE_KEY, String(size)) } catch { /* 存储失败不影响当次切换 */ }
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = size
    fit.fit()
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(`r${term.cols},${term.rows}`)
  }

  // 拉取某服务器上「可复用」的终端会话列表（tmux wt-*）
  const refreshSessions = useCallback(async (sid: string): Promise<TermInfo[]> => {
    if (!sid) return []
    try {
      const res = await fetch(`/api/term/list?server=${encodeURIComponent(sid)}`)
      if (!res.ok) return []
      const data = await res.json()
      const list: TermInfo[] = Array.isArray(data.sessions) ? data.sessions : []
      // 只有当这份结果仍对应「当前」服务器时才写入，避免迟到的旧服务器结果覆盖新服务器列表
      if (sid === serverIdRef.current) setSessions(list)
      return list
    } catch { return [] }
  }, [])

  // 默认选中第一个在线服务器
  useEffect(() => {
    if (!serverId && servers.length) setServerId(servers.find((sv) => sv.online)?.id ?? servers[0].id)
  }, [servers, serverId])

  // 换服务器：拉列表 → 若「上次用的会话」仍在则自动复用，否则清空 termId 显示选择器
  useEffect(() => {
    if (!serverId) return
    serverIdRef.current = serverId
    setTermId('') // 先同步清空——否则 xterm effect 会用「新服务器 + 旧 termId」误连一个不属于该机的会话
    setSessions([]) // 清掉上个服务器的列表，避免闪现旧数据
    const revision = ++selectionRevision.current
    let alive = true
    ;(async () => {
      const list = await refreshSessions(serverId)
      if (!alive || selectionRevision.current !== revision) return
      let last = ''
      try { last = localStorage.getItem(lastTermKey(serverId)) || '' } catch { /* ignore */ }
      if (last && list.some((s) => s.termId === last)) {
        freshRef.current = false
        setTermId(last)
      } else {
        setTermId('') // 显示选择器，用户选复用或新建
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId])

  const rememberTerm = (sid: string, tid: string) => {
    try { localStorage.setItem(lastTermKey(sid), tid) } catch { /* ignore */ }
  }

  // 复用一个已存在的会话
  const attachSession = (tid: string) => {
    if (tid === termId) return
    selectionRevision.current++
    freshRef.current = false
    rememberTerm(serverId, tid)
    setTermId(tid)
  }

  // 新建会话（可带名字）：生成新 termId，建连后写 @label
  const newSession = (label?: string) => {
    selectionRevision.current++
    const tid = genTermId()
    freshRef.current = true
    rememberTerm(serverId, tid)
    if (label?.trim()) {
      // 会话建好后再写 label（建连异步；稍等片刻确保 tmux 会话已存在）
      const name = label.trim()
      window.setTimeout(() => {
        void fetch('/api/term/meta', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server: serverId, termId: tid, label: name }),
        }).then(() => refreshSessions(serverId))
      }, 800)
    }
    setTermId(tid)
  }

  const setMeta = async (tid: string, patch: { label?: string; keep?: boolean }) => {
    setPickerBusy(true)
    try {
      await fetch('/api/term/meta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: serverId, termId: tid, ...patch }),
      })
      await refreshSessions(serverId)
    } finally { setPickerBusy(false) }
  }

  const killSession = async (tid: string) => {
    if (!window.confirm('删除该会话？里面正在跑的进程会一并结束。')) return
    setPickerBusy(true)
    try {
      await fetch('/api/term/kill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: serverId, termId: tid }),
      })
      if (tid === termId) { selectionRevision.current++; setTermId('') }
      await refreshSessions(serverId)
    } finally { setPickerBusy(false) }
  }

  // 只负责 WS 生命周期：复用当前 xterm 实例 + termId，供「初次连接」与「手动重连」共用。
  const connect = useCallback((nudgeFresh = false) => {
    const term = termRef.current
    if (!term || !serverId || !termId) return
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    if (heartbeatTimer.current) clearInterval(heartbeatTimer.current)
    const previous = wsRef.current
    wsRef.current = null
    previous?.close()
    setLatency(null)
    setStatus('connecting')
    term.options.disableStdin = true
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${proto}://${location.host}/api/term/ws?server=${encodeURIComponent(serverId)}&term=${termId}&cols=${term.cols}&rows=${term.rows}&cwd=${encodeURIComponent(cwd)}`,
    )
    ws.binaryType = 'arraybuffer'
    let lastReceive = Date.now(), pongSeen = false
    ws.onopen = () => {
      if (wsRef.current !== ws) return
      setStatus('connected')
      term.options.disableStdin = false
      lastReceiveRef.current = Date.now()
      retryRef.current = 0
      ws.send('p' + Date.now())
      heartbeatTimer.current = setInterval(() => {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return
        if (pongSeen && Date.now() - lastReceive > 45_000) { ws.close(); return }
        ws.send('p' + Date.now())
      }, 10_000)
      if (nudgeFresh) window.setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('i\x0c')
      }, 300)
    }
    ws.onmessage = (e) => {
      if (wsRef.current !== ws) return
      lastReceive = Date.now()
      lastReceiveRef.current = lastReceive
      if (typeof e.data === 'string') {
        if (/^p\d+$/.test(e.data)) { pongSeen = true; setLatency(Math.max(0, Date.now() - Number(e.data.slice(1)))) }
        return
      }
      term.write(new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = () => {
      if (wsRef.current !== ws) return
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current)
      setStatus('disconnected')
      term.options.disableStdin = true
      reconnectTimer.current = setTimeout(() => connectRef.current(), Math.min(30_000, 1000 * 2 ** retryRef.current++))
    }
    wsRef.current = ws
  }, [serverId, cwd, termId])
  connectRef.current = connect

  // termId 变化（选了会话/新建/切换服务器）= 新挂载：新建 xterm 实例并连接；卸载或再次切换时清理旧实例。
  // termId 为空则不建 xterm（显示选择器）。
  useEffect(() => {
    if (!hostRef.current || !serverId || !termId) return
    const wantFresh = freshRef.current
    freshRef.current = false

    const term = new XTerm({ fontSize, cursorBlink: true, theme: activeTheme.theme, disableStdin: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    termRef.current = term
    fitRef.current = fit

    const dataSub = term.onData((d) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send('i' + d)
    })

    // 只有当尺寸「真的变化」时才把 r 帧下发给 tmux（无谓 resize 会让 tmux 重排+shell 重绘）
    let lastSent = ''
    const refit = () => {
      fit.fit()
      const dim = `${term.cols},${term.rows}`
      if (dim !== lastSent && wsRef.current?.readyState === WebSocket.OPEN) {
        lastSent = dim
        wsRef.current.send('r' + dim)
      }
    }

    const ro = new ResizeObserver(refit)
    ro.observe(hostRef.current)

    // 首次 fit 推迟到布局稳定后（双 rAF）再建连，保证 tmux 一次性按最终尺寸创建
    let raf1 = 0, raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        fit.fit()
        lastSent = `${term.cols},${term.rows}`
        connect(wantFresh) // 新建会话补发 Ctrl-L；复用已有会话不清屏
      })
    })

    const deferredTimers = [window.setTimeout(refit, 250), window.setTimeout(refit, 650)]
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      refit()
      if (wsRef.current?.readyState !== WebSocket.OPEN || Date.now() - lastReceiveRef.current > 10_000) connectRef.current()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onVisibility)
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) onVisibility() }
    window.addEventListener('pageshow', onPageShow)

    return () => {
      cancelAnimationFrame(raf1); cancelAnimationFrame(raf2)
      deferredTimers.forEach((id) => window.clearTimeout(id))
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      dataSub.dispose()
      ro.disconnect()
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current)
      const old = wsRef.current
      wsRef.current = null
      old?.close()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // fontSize/theme 仅作创建初值，切换走各自 handler 直接改活实例；不重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, termId])

  const commitCwd = () => {
    const next = cwdDraft.trim()
    setCwdDraft(next)
    if (next !== cwd) setCwd(next)
  }

  const sendSeq = (seq: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send('i' + seq)
    termRef.current?.focus()
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-head__title">终端</h1>
      </header>

      <div className="term-toolbar">
        <select
          className="term-toolbar__select composer__input"
          value={serverId}
          onChange={(e) => setServerId(e.target.value)}
        >
          {servers.map((sv) => (
            <option key={sv.id} value={sv.id} disabled={!sv.online}>
              {sv.name}{sv.online ? '' : '（离线）'}
            </option>
          ))}
        </select>
        {termId && (
          <button className="term-toolbar__pick" onClick={() => { selectionRevision.current++; setTermId('') }} title="切换 / 新建会话">
            ⇄ 会话：{current?.label || termId.slice(0, 10)}
          </button>
        )}
        <select
          className="term-toolbar__select term-toolbar__theme composer__input"
          value={themeId}
          onChange={(e) => handleThemeChange(e.target.value)}
          aria-label="终端配色主题"
        >
          {TERM_THEMES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <select
          className="term-toolbar__select term-toolbar__fontsize composer__input"
          value={fontSize}
          onChange={(e) => handleFontSizeChange(Number(e.target.value))}
          aria-label="终端字号"
        >
          {TERM_FONT_SIZES.map((f) => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
        </select>
        {termId && (
          <div className="term-status">
            <span className={`dot term-status__dot term-status__dot--${status}`} />
            <span>{STATUS_LABEL[status]}{status === 'connected' && latency != null ? ` · ${latency}ms` : ''}</span>
            {status === 'disconnected' && (
              <button className="term-status__reconnect" onClick={() => connect(false)}>重连</button>
            )}
          </div>
        )}
      </div>

      {termId ? (
        <>
          <div className="term-keybar">
            {CTRL_KEYS.map((k) => (
              <button key={k.label} className="term-keybar__key" onMouseDown={(e) => e.preventDefault()} onClick={() => sendSeq(k.seq)}>
                {k.label}
              </button>
            ))}
          </div>
          <div className="term-host" ref={hostRef} style={{ background: activeTheme.theme.background }} />
        </>
      ) : (
        <TermPicker
          sessions={sessions}
          busy={pickerBusy}
          cwdDraft={cwdDraft}
          onCwdChange={setCwdDraft}
          onCommitCwd={commitCwd}
          onRefresh={() => refreshSessions(serverId)}
          onAttach={attachSession}
          onNew={newSession}
          onToggleKeep={(tid, keep) => setMeta(tid, { keep })}
          onRename={(tid, label) => setMeta(tid, { label })}
          onKill={killSession}
        />
      )}
    </div>
  )
}

// 会话选择器：列出可复用的会话（复用/保留/改名/删除）+ 新建
function TermPicker(props: {
  sessions: TermInfo[]
  busy: boolean
  cwdDraft: string
  onCwdChange: (v: string) => void
  onCommitCwd: () => void
  onRefresh: () => void
  onAttach: (tid: string) => void
  onNew: (label?: string) => void
  onToggleKeep: (tid: string, keep: boolean) => void
  onRename: (tid: string, label: string) => void
  onKill: (tid: string) => void
}) {
  const { sessions, busy } = props
  const [newLabel, setNewLabel] = useState('')

  return (
    <div className="term-picker">
      <div className="term-picker__head">
        <span>会话（可复用后台长跑的终端；保留的不会被空闲回收）</span>
        <button className="term-status__reconnect" disabled={busy} onClick={props.onRefresh}>↻ 刷新</button>
      </div>

      <div className="term-picker__new">
        <input
          className="composer__input"
          style={{ flex: '1 1 160px', minWidth: 120, fontFamily: 'var(--mono)' }}
          value={props.cwdDraft}
          onChange={(e) => props.onCwdChange(e.target.value)}
          onBlur={props.onCommitCwd}
          placeholder="留空使用节点用户主目录"
          spellCheck={false}
        />
        <input
          className="composer__input"
          style={{ flex: '1 1 140px', minWidth: 100 }}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="会话名（可选）"
          maxLength={40}
        />
        <button className="btn btn--primary" disabled={busy} onClick={() => { props.onCommitCwd(); props.onNew(newLabel); setNewLabel('') }}>
          ▶ 新建会话
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="empty-state" style={{ padding: '28px 0' }}>该服务器暂无可复用会话 · 新建一个开始</div>
      ) : (
        <div className="term-picker__list">
          {sessions.map((s) => (
            <div key={s.termId} className="term-picker__row">
              <button className="term-picker__attach" disabled={busy} onClick={() => props.onAttach(s.termId)} title="复用该会话">
                <span className="term-picker__name">
                  {s.running && <span className="term-picker__run" title="有程序在前台运行">▶</span>}
                  {s.keep && <span className="term-picker__pin" title="已保留（不被空闲回收）">📌</span>}
                  {s.label || <span className="mono">{s.termId.slice(0, 12)}</span>}
                </span>
                <span className="term-picker__meta mono">
                  {s.cwd || '用户主目录'} · {s.running ? s.command : 'shell'}
                  {s.viewers > 0 ? ` · 👁${s.viewers}` : ''} · {relTime(s.activity)}
                </span>
              </button>
              <div className="term-picker__ops">
                <button className="term-picker__op" disabled={busy} title={s.keep ? '取消保留' : '保留（不被空闲回收）'} onClick={() => props.onToggleKeep(s.termId, !s.keep)}>
                  {s.keep ? '📌' : '📍'}
                </button>
                <button className="term-picker__op" disabled={busy} title="改名" onClick={() => {
                  const name = window.prompt('会话名', s.label || '')
                  if (name != null) props.onRename(s.termId, name)
                }}>✎</button>
                <button className="term-picker__op term-picker__op--danger" disabled={busy} title="删除会话" onClick={() => props.onKill(s.termId)}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
