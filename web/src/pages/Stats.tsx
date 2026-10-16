import { useEffect, useState } from 'react'
import { useAppStore } from '../store/store'
import { EngineBadge } from '../components/EngineBadge'
import { EngineUsageTrend } from '../components/EngineUsageTrend'
import { QuotaUsageTrend } from '../components/QuotaUsageTrend'
import { UsageOverview } from '../components/UsageOverview'
import { usageEngines, engineName } from '../lib/engine-trend'
import { fmtTokens, money, fmtDur } from '../lib/format'
import { quantifyWorkload } from '../lib/workload'
import type { Tok } from '../lib/cost'

// 每日目标 token（用户设定）。2026-09-14 由 10 亿下调到 5 亿。
// ⚠️ 旧的 10 亿是在 token 去重修复（2026-09-05）**之前**定的——那时同一条 assistant 消息
//    按 content block 拆行被重复累加，看板数字虚高 52.8%。去重后真实值约为原来的一半，
//    目标跟着减半才可比。今日百分比、时均目标线（/24）、超标标红都从这里派生。
const DAILY_TARGET = 5e8

type Range = 'today' | 'week' | 'all'
const ranges: Array<{ key: Range; label: string }> = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '近7天' },
  { key: 'all', label: '近30天' },
]
type DayRow = { byEngine?: Record<string, number>; date: string; tokens: number; cost: number; tok: Tok; costc: Tok }
const sum4 = (rows: Array<{ tok?: Tok }>, k: keyof Tok) => rows.reduce((n, r) => n + (r.tok?.[k] ?? 0), 0)
const sumC = (rows: Array<{ costc?: Tok }>, k: keyof Tok) => rows.reduce((n, r) => n + (r.costc?.[k] ?? 0), 0)

export default function Stats() {
  const sessions = useAppStore((s) => s.sessions)
  const [range, setRange] = useState<Range>('today')
  const [daily, setDaily] = useState<DayRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [projRows, setProjRows] = useState<Array<{ serverId: string; project: string; activeMs: number; cost: number; tokens: number }>>([])
  const [activeSeries, setActiveSeries] = useState<Array<{ date: string; activeMs: number; projects: number }>>([])
  const [projLoading, setProjLoading] = useState(true)
  const [projError, setProjError] = useState('')

  useEffect(() => {
    let alive = true
    let controller: AbortController | null = null
    let busy = false
    const load = async () => {
      if (busy) return
      busy = true
      const request = new AbortController()
      controller = request
      const timeout = setTimeout(() => request.abort(), 20_000)
      try {
        const read = async (url: string) => {
          const res = await fetch(url, { signal: request.signal })
          if (!res.ok) throw new Error('统计数据暂时不可用')
          return res.json()
        }
        const days = await read('/api/usage/daily?days=30')
        if (alive && !request.signal.aborted) { setDaily(days.days ?? []); setLoadError('') }
      } catch { if (alive) setLoadError('统计刷新失败，保留上次数据') }
      finally { clearTimeout(timeout); busy = false; if (alive) setLoading(false) }
    }
    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => { alive = false; controller?.abort(); clearInterval(timer) }
  }, [])

  useEffect(() => {
    let alive = true
    let busy = false
    let controller: AbortController | null = null
    const days = range === 'today' ? 1 : range === 'week' ? 7 : 30
    setProjRows([]); setActiveSeries([]); setProjLoading(true); setProjError('')
    const load = async () => {
      if (busy) return
      busy = true
      const request = new AbortController()
      controller = request
      const timeout = setTimeout(() => request.abort(), 20_000)
      try {
        const res = await fetch(`/api/usage/projects-daily?days=${days}`, { signal: request.signal })
        if (!res.ok) throw new Error('项目统计不可用')
        const d = await res.json()
        if (alive && !request.signal.aborted) { setProjRows(d.rows ?? []); setActiveSeries(d.series ?? []); setProjError('') }
      } catch { if (alive) setProjError('项目统计刷新失败，已保留该时段上次数据，稍后自动重试') }
      finally { clearTimeout(timeout); busy = false; if (alive) setProjLoading(false) }
    }
    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => { alive = false; controller?.abort(); clearInterval(timer) }
  }, [range])

  const todayRow = daily.length ? daily[daily.length - 1] : null
  const todayTokens = todayRow?.tokens ?? 0

  // 选定时段的每日行（与图表/看板同源，保证自洽）
  const selDays = range === 'today' ? daily.slice(-1) : range === 'week' ? daily.slice(-7) : daily
  const totalTokens = selDays.reduce((n, r) => n + r.tokens, 0)
  // 引擎拆分（2026-08-03）：cost 只含 Claude（Codex 无单价），tokens 却是全引擎合计。
  // 两个格子并排摆着、分母却不同 ⇒ 用户按它算出 $0.148/百万 的荒谬单价来问「是不是不成正比」。
  // 实测 08-02：claude 160.7M / codex 1078.9M，$183.82 ÷ 160.7M = $1.14/M 才是真实水平。
  // 所以这里不做「统一口径」（那会丢掉 Codex 的用量信息），而是把口径显式写在界面上。
  const byEngine = selDays.reduce((acc: Record<string, number>, r) => {
    for (const [e, v] of Object.entries((r as { byEngine?: Record<string, number> }).byEngine ?? {})) {
      acc[e] = (acc[e] ?? 0) + (Number(v) || 0)
    }
    return acc
  }, {})
  const engineRows = Object.entries(byEngine).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const tokBd: Tok = { input: sum4(selDays, 'input'), output: sum4(selDays, 'output'), cacheRead: sum4(selDays, 'cacheRead'), cacheCreate: sum4(selDays, 'cacheCreate') }
  const costBd: Tok = { input: sumC(selDays, 'input'), output: sumC(selDays, 'output'), cacheRead: sumC(selDays, 'cacheRead'), cacheCreate: sumC(selDays, 'cacheCreate') }
  const costBdTotal = costBd.input + costBd.output + costBd.cacheRead + costBd.cacheCreate
  const cacheReadPct = totalTokens > 0 ? Math.round((tokBd.cacheRead / totalTokens) * 100) : 0
  const rangeLabel = ranges.find((r) => r.key === range)?.label

  // 今日平均用量：今日成本 ÷ 今日已过小时（$/h）
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
  const hoursToday = Math.max(0.1, (Date.now() - dayStart.getTime()) / 3_600_000)
  const burnToday = todayTokens / hoursToday

  // 项目消耗按所选时段：成本/tokens/活跃来自后端每日聚合(projRows)；引擎徽章与会话数取自 live sessions(总数)
  const liveMeta = new Map<string, { engines: Set<string>; sessions: number }>()
  for (const s of sessions) {
    const key = `${s.serverId}/${s.project}`
    const g = liveMeta.get(key) ?? { engines: new Set<string>(), sessions: 0 }
    g.engines.add(s.engine); g.sessions += 1
    liveMeta.set(key, g)
  }
  const rows = projRows
    .map((r) => { const key = `${r.serverId}/${r.project}`; const m = liveMeta.get(key); return { ...r, key, engines: m?.engines ?? new Set<string>(), sessions: m?.sessions ?? 0 } })
    .sort((a, b) => (b.tokens - a.tokens) || (b.activeMs - a.activeMs))
  const maxTokens = Math.max(1, ...rows.map((r) => r.tokens))
  const totalActiveMs = rows.reduce((n, r) => n + r.activeMs, 0)
  const projectTokens = rows.reduce((n, r) => n + r.tokens, 0)

  return (
    <div className="page stats-page" style={{ maxWidth: 720 }}>
      <header className="page-head"><h1 className="page-head__title">用量与消耗</h1></header>

      {loadError && <p role="status">{loadError}</p>}
      <UsageOverview days={daily} target={DAILY_TARGET} loading={loading} />
      <EngineUsageTrend days={daily} loading={loading} error={loadError} />
      <QuotaUsageTrend />

      <div className="seg-tabs">
        {ranges.map((r) => (
          <button key={r.key} className={`seg-tab ${range === r.key ? 'active' : ''}`} onClick={() => setRange(r.key)}>{r.label}</button>
        ))}
      </div>

      <div className="stat-chips">
        {usageEngines(selDays).map((engine) => (
          <div className={`stat-chip eng-${engine}`} key={engine}>
            <div className="stat-chip__label">{engineName(engine)} · {rangeLabel}</div>
            <div className="stat-chip__value mono">{fmtTokens(byEngine[engine] ?? 0)}</div>
            <div className="stat-chip__hint">Token · 会话实际记录</div>
          </div>
        ))}
        <div className="stat-chip stat-chip--total">
          <div className="stat-chip__label">{rangeLabel} Tokens<span className="stat-chip__scope">全引擎 · 不等于配额</span></div>
          <div className="stat-chip__value mono">{fmtTokens(totalTokens)}</div>
          {/* ★ 实测近 30 天 cacheRead 占总 token **97.5%**、output 只占 0.25%。
              不把这个占比标出来，这个数会被当成"烧了多少配额"读，而它其实主要在说
              "重读了多少上下文"。另外 Codex/Kimi 的 token 根本不消耗 Claude 配额。 */}
          {cacheReadPct > 0 && (
            <div className="stat-chip__hint">其中缓存读 {cacheReadPct}%</div>
          )}
          {engineRows.length > 1 && (
            <div className="stat-chip__split">
              {engineRows.map(([e, v]) => (
                <span key={e} className={`stat-chip__split-item eng-${e}`}>{e} {fmtTokens(v)}</span>
              ))}
            </div>
          )}
        </div>
        <div className="stat-chip">
          <div className="stat-chip__label">今日平均用量 · 全引擎</div>
          <div className="stat-chip__value mono">{burnToday > 0 ? `${fmtTokens(burnToday)}/h` : '—'}</div>
        </div>
        <div className="stat-chip">
          <div className="stat-chip__label">活跃 · {rangeLabel}</div>
          <div className="stat-chip__value mono">{totalActiveMs > 0 ? fmtDur(totalActiveMs) : '—'}</div>
        </div>
      </div>

      <div className="token-bd">
        <div className="token-bd__title">Token 构成（{rangeLabel}）</div>
        <div className="token-bd__grid">
          <div className="token-bd__item"><span>输入</span><b className="mono">{fmtTokens(tokBd.input)}</b></div>
          <div className="token-bd__item"><span>输出</span><b className="mono">{fmtTokens(tokBd.output)}</b></div>
          <div className="token-bd__item"><span>缓存读</span><b className="mono">{fmtTokens(tokBd.cacheRead)}</b><i>{cacheReadPct}%</i></div>
          <div className="token-bd__item"><span>缓存写</span><b className="mono">{fmtTokens(tokBd.cacheCreate)}</b></div>
        </div>
      </div>

      <details className="token-bd">
        <summary>历史 Claude 费用估算</summary>
        <div className="token-bd__title">成本构成（{rangeLabel} · 估算 {money(costBdTotal)}）</div>
        <div className="token-bd__grid">
          <div className="token-bd__item"><span>输入</span><b className="mono">{money(costBd.input)}</b></div>
          <div className="token-bd__item"><span>输出</span><b className="mono">{money(costBd.output)}</b></div>
          <div className="token-bd__item"><span>缓存读</span><b className="mono">{money(costBd.cacheRead)}</b></div>
          <div className="token-bd__item"><span>缓存写</span><b className="mono">{money(costBd.cacheCreate)}</b></div>
        </div>
      </details>

      {/* AI 工作量：把各项目累计活跃时长换算成人能体感的"几天"。
          活跃时长是保守口径（回合间隔>5min 不计），故脚注标清，不当精确工时卖。 */}
      {(() => {
        const totalActive = projRows.reduce((n, r) => n + (r.activeMs || 0), 0)
        const w = quantifyWorkload(totalActive)
        const maxDay = Math.max(1, ...activeSeries.map((d) => d.activeMs))
        return (
          <div className="workload">
            <div className="workload__head">
              <div>
                <div className="workload__label">AI 工作量 · {rangeLabel}</div>
                <div className="workload__big mono">{w.hours}<span className="workload__unit"> 活跃小时</span></div>
              </div>
              <div className="workload__equiv">
                <div className="workload__eq"><b className="mono">{w.fullDays}</b><span>满负荷天<i>÷24h 不间断</i></span></div>
                <div className="workload__eq"><b className="mono">{w.personDays}</b><span>人力工作日<i>÷8h/天</i></span></div>
              </div>
            </div>
            {activeSeries.length > 1 && (
              <div className="workload__spark" title="每日活跃小时">
                {activeSeries.map((d) => (
                  <div key={d.date} className="workload__bar" title={`${d.date}：${(d.activeMs / 3600000).toFixed(1)}h · ${d.projects} 个项目`}>
                    <div className="workload__bar-fill" style={{ height: `${Math.max(4, (d.activeMs / maxDay) * 100)}%` }} />
                  </div>
                ))}
              </div>
            )}
            <div className="workload__foot">
              「活跃」= agent 密集干活的墙钟时长（相邻动作间隔&gt;5 分钟不计），保守估算；多个 agent 并行时合计可超 24h/天。
            </div>
          </div>
        )
      })()}

      <div id="project-usage" className="token-bd__title" style={{ padding: '4px 2px' }}>项目消耗 · {rangeLabel} · 全引擎</div>
      {projError && <p role="status" className="engine-trend__note">{projError}</p>}
      {rows.length === 0 ? (
        <div className="empty-state">{projLoading ? '正在汇总项目消耗…' : projError ? '该时段项目数据暂时不可用' : '暂无消耗数据'}</div>
      ) : (
        rows.map((r, i) => (
          <div key={r.key} className="stats-row">
            <span className="stats-row__rank">{i + 1}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="stats-row__name">
                {r.project}
                <span style={{ marginLeft: 8 }}>{[...r.engines].map((e) => <EngineBadge key={e} engine={e as 'claude' | 'codex' | 'kimi'} />)}</span>
              </div>
              <div className="stats-row__meta">{r.serverId} · {r.sessions} 个当前可见会话{r.activeMs > 0 ? ` · 活跃 ${fmtDur(r.activeMs)}` : ''}</div>
              <div className="stats-bar"><div className="stats-bar__fill" style={{ width: `${(r.tokens / maxTokens) * 100}%` }} /></div>
            </div>
            <div className="stats-row__value">
              {r.cost > 0 && <div style={{ fontSize: 11 }}>Claude 估算 {money(r.cost)}</div>}
              <div style={{ color: 'var(--text-3)' }}>{fmtTokens(r.tokens)} tok</div>
              <div className="stats-row__share">占项目总量 {projectTokens > 0 ? (r.tokens / projectTokens * 100).toFixed(1) : '0.0'}%</div>
            </div>
          </div>
        ))
      )}
      <p style={{ color: 'var(--text-3)', fontSize: 12 }}>
        用量趋势图显示有记录引擎的每日 Token，额度图展示各自历史窗口使用率；下方统计按独立选择的今日、近7天或近30天汇总。
        「项目消耗」按所选时段（今日/近7天/近30天）汇总每项目 成本 / tokens / 活跃时长，数据来自后端每日落库；项目排名按 Token 排序，包含历史 Claude；会话数仅为当前看板可见会话数。
      </p>
    </div>
  )
}
