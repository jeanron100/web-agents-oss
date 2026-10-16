import { useId, useState } from 'react'
import { engineTrend, tokenPath, type EngineDay, type UsageEngine, usageEngines, engineName } from '../lib/engine-trend'
import { fmtTokens } from '../lib/format'

export function EngineUsageTrend({ days, loading, error }: { days: EngineDay[]; loading: boolean; error: string }) {
  const [window, setWindow] = useState<7 | 14 | 30>(14)
  const [selected, setSelected] = useState<string | null>(null)
  const title = useId()
  const points = engineTrend(days, window)
  const engines = usageEngines(days.slice(-window))
  const total = (engine: UsageEngine) => points.reduce((sum, p) => sum + (p[engine] ?? 0), 0)
  const combined = engines.reduce((n, e) => n + total(e), 0)
  const known = engines.length > 0
  const max = Math.max(1, ...points.flatMap(p => engines.map(e => p[e] ?? 0))) * 1.15
  const active = points.find(p => p.date === selected) ?? points.at(-1)
  const x = (i: number) => 64 + (points.length <= 1 ? 304 : i / (points.length - 1) * 608)
  const y = (v: number) => 194 - v / max * 160
  const labels = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter(i => i >= 0)

  return <section className="usage-panel engine-trend" aria-labelledby={title}>
    <div className="engine-trend__head">
      <div><h2 id={title}>各引擎用量趋势</h2><p>有历史记录的引擎自动显示 · 每日 Token，含缓存读取</p></div>
      <div className="usage-panel__win" aria-label="用量趋势时段">
        {([7, 14, 30] as const).map(n => <button key={n} className={`seg-tab ${window === n ? 'active' : ''}`} aria-pressed={window === n} onClick={() => { setWindow(n); setSelected(null) }}>{n}天</button>)}
      </div>
    </div>
    <div className={`engine-trend__totals ${engines.length === 3 ? 'engine-trend__totals--three' : ''}`} style={engines.length === 1 ? { gridTemplateColumns: '1fr' } : undefined}>
      {engines.map(engine => <div key={engine} className={`engine-trend__total engine-trend__total--${engine}`}>
        <span><i />{engineName(engine)}</span>
        <strong className="mono">{known ? fmtTokens(total(engine)) : '—'}</strong>
        <small>近 {window} 天累计</small>
      </div>)}
    </div>
    {loading && !days.length ? <div className="empty-state" role="status">正在加载用量趋势…</div> : !known ?
      <div className="empty-state">{error ? '用量暂时无法加载，请稍后重试' : '暂无可归属引擎的历史用量'}</div> : <>
      <svg viewBox="0 0 700 232" className="usage-chart engine-trend__chart" role="group" aria-label="各引擎每日 Token 对比，选择日期查看明细">
        {[0, .5, 1].map(r => <g key={r}>
          <line x1={64} x2={672} y1={y(max * r)} y2={y(max * r)} className="pct-trend__grid" />
          <text x={54} y={y(max * r) + 4} textAnchor="end" className="usage-chart__xlabel">{fmtTokens(max * r)}</text>
        </g>)}
        {engines.map(engine => <g key={engine} className={`engine-trend__series engine-trend__series--${engine}`}>
          <path d={tokenPath(points.map(p => p[engine]), max)} className="usage-chart__line" />
          {points.map((p, i) => p[engine] != null && <circle key={p.date} cx={x(i)} cy={y(p[engine]!)} r={p.date === active?.date ? 4.5 : 2.5} />)}
        </g>)}
        {points.map((p, i) => <rect key={p.date} x={Math.max(58, x(i) - 608 / Math.max(1, points.length - 1) / 2)} y={24}
          width={points.length === 1 ? 608 : 608 / (points.length - 1)} height={180} fill="transparent" tabIndex={0} role="button"
          aria-label={`${p.date} ${engines.map(e => `${engineName(e)} ${p[e] == null ? '未记录' : fmtTokens(p[e]!)}`).join('，')}`}
          onClick={() => setSelected(p.date)} onFocus={() => setSelected(p.date)} onMouseEnter={() => setSelected(p.date)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(p.date) } }} />)}
        {labels.map(i => <text key={i} x={x(i)} y={225} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} className="usage-chart__xlabel">{points[i].date.slice(5)}</text>)}
      </svg>
      {active && <div className="engine-trend__detail" aria-live="polite"><span>{active.date}</span>{engines.map(e => <span key={e} className={`eng-${e}`}>{engineName(e)} <b>{active[e] == null ? '未记录' : fmtTokens(active[e]!)}</b></span>)}</div>}
      <div className="engine-trend__mix" aria-label="所选时段用量占比">
        <div className="engine-trend__mixbar">{engines.map(e => <i key={e} style={{ width: `${combined ? total(e) / combined * 100 : 0}%`, background: `var(--engine-${e})` }} />)}</div>
        <span>{combined ? engines.map(e => `${engineName(e)} ${Math.round(total(e) / combined * 100)}%`).join(' · ') : '所选时段暂无用量'}</span>
      </div>
    </>}
    <p className="engine-trend__note">Token 用量不等于订阅额度；额度以账号当前窗口为准。历史未记录的日期留空，不按 0 补算。</p>
  </section>
}
