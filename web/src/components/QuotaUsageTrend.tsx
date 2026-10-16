import { useEffect, useState } from 'react'
import { buildPctPath } from './PctTrendChart'
import { quotaTrend, type QuotaSeries } from '../lib/quota-trend'
import { engineName } from '../lib/engine-trend'

const stamp = (ts: number) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

export function QuotaUsageTrend() {
  const [series, setSeries] = useState<QuotaSeries[]>([])
  const [days, setDays] = useState(14)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [available, setAvailable] = useState(true)
  const [now, setNow] = useState(Date.now())
  const [selected, setSelected] = useState<number | null>(null)

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
        const res = await fetch('/api/usage/quota-trend?days=30&history=1', { signal: request.signal })
        if (!res.ok) throw new Error('额度历史暂时不可用')
        const data = await res.json()
        if (alive && !request.signal.aborted) {
          if (data.available === false) { setAvailable(false); setError('额度历史存储暂时不可用，保留上次数据') }
          else { setSeries(data.series ?? []); setAvailable(true); setError('') }
          setNow(Date.now())
        }
      } catch { if (alive) setError('额度趋势刷新失败，保留上次数据') }
      finally { clearTimeout(timeout); busy = false; if (alive) setLoading(false) }
    }
    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => { alive = false; controller?.abort(); clearInterval(timer) }
  }, [])

  const { times, lines } = quotaTrend(series, days, now)
  const W = 700, H = 230, L = 46, R = 16, T = 18, B = 32
  const x = (i: number) => L + i / (times.length - 1) * (W - L - R)
  const y = (pct: number) => T + (100 - pct) / 100 * (H - T - B)
  let last = -1
  for (let i = 0; i < times.length; i++) if (lines.some(s => s.samples.has(times[i]))) last = i
  const active = selected != null && times.includes(selected) ? times.indexOf(selected) : last
  const label = (s: typeof lines[number]) => `${engineName(s.engine)} ${s.windowLabel}${s.sourceLabel ? ` · ${s.sourceLabel}` : lines.filter(l => l.engine === s.engine && l.windowLabel === s.windowLabel).length > 1 ? ` · 账号 ${lines.filter(l => l.engine === s.engine && l.windowLabel === s.windowLabel).findIndex(l => l.id === s.id) + 1}` : ''}`

  return <section className="usage-panel quota-trend" aria-label="订阅额度使用率变化">
    <div className="engine-trend__head">
      <div><h2>订阅额度使用率变化</h2><p>有历史采样的引擎自动显示 · 各账号与窗口独立统计</p></div>
      <div className="seg-tabs" aria-label="额度趋势时间范围">{[7, 14, 30].map(n => <button key={n} className={`seg-tab ${days === n ? 'active' : ''}`} aria-pressed={days === n} onClick={() => { setDays(n); setSelected(null) }}>{n}天</button>)}</div>
    </div>
    {error && <p role="status" className="engine-trend__note">{error}</p>}
    {!lines.length ? <div className="empty-state">{loading ? '正在加载额度历史…' : !available ? '额度历史存储暂时不可用' : '暂无该时段的额度采样，采集后将在这里显示'}</div> : <>
      <svg viewBox={`0 0 ${W} ${H}`} className="usage-chart engine-trend__chart" role="img" aria-label="额度使用率折线图，纵轴 0% 到 100%">
        {[0, 25, 50, 75, 100].map(p => <g key={p}><line x1={L} y1={y(p)} x2={W - R} y2={y(p)} className="pct-trend__grid" /><text x={L - 8} y={y(p) + 4} textAnchor="end" className="usage-chart__xlabel">{p}%</text></g>)}
        {lines.map(s => <g key={s.id} className={`engine-trend__series engine-trend__series--${s.engine}`}>
          <path d={buildPctPath(s.values, W, H, L, R, T, B)} className="usage-chart__line" fill="none" />
          {s.values.map((v, i) => v != null && <circle key={i} cx={x(i)} cy={y(v)} r={i === active ? 4 : 2.2} />)}
        </g>)}
        {times.map((t, i) => lines.some(s => s.samples.has(t)) && <rect key={t} x={Math.max(L, x(i) - (W - L - R) / (times.length - 1) / 2)} y={T} width={(W - L - R) / (times.length - 1)} height={H - T - B} fill="transparent" tabIndex={0} role="button"
          aria-label={`${stamp(t)} ${lines.map(s => `${label(s)} ${s.values[i] == null ? '未记录' : s.values[i] + '%'}`).join('，')}`}
          onClick={() => setSelected(t)} onMouseEnter={() => setSelected(t)} onFocus={() => setSelected(t)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(t) } }} />)}
        {[0, Math.floor((times.length - 1) / 2), times.length - 1].map(i => <text key={i} x={x(i)} y={H - 8} className="usage-chart__xlabel" textAnchor={i === 0 ? 'start' : i === times.length - 1 ? 'end' : 'middle'}>{new Date(times[i]).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</text>)}
      </svg>
      <div className="quota-trend__legend">{lines.map(s => <span key={s.id} className={`quota-trend__legend-item eng-${s.engine}`}><i />{label(s)} %</span>)}</div>
      {active >= 0 && <div className="engine-trend__detail" aria-live="polite"><span>{stamp(times[active])}</span>{lines.map(s => <span key={s.id} className={`eng-${s.engine}`}>{label(s)} <b>{s.values[active] == null ? '未记录' : `已用 ${s.values[active]}% · 剩余 ${Number((100 - s.values[active]!).toFixed(1))}%`}</b>{s.samples.get(times[active]) && <small>（{stamp(s.samples.get(times[active])!.ts)}采样）</small>}</span>)}</div>}
    </>}
    <p className="engine-trend__note">{lines.length > 0 && lines.every(s => s.samples.size === 1) && '额度历史已开始采集，后续会逐步形成趋势。'}按真实额度采样绘制，重置后使用率会下降。缺失记录留空，标注历史来源的记录不代表当前账号。</p>
  </section>
}
