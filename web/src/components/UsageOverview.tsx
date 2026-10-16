import { usageOverview } from '../lib/usage-overview'
import { engineName, usageEngines, type EngineDay } from '../lib/engine-trend'
import { fmtTokens, fmtYi } from '../lib/format'

export function UsageOverview({ days, target, loading }: { days: EngineDay[]; target: number; loading: boolean }) {
  // Use the API's calendar boundary so devices in different timezones agree.
  const date = days.at(-1)?.date ?? ''
  const u = usageOverview(days, date)
  const engines = usageEngines(days).map(engineName).join(' + ')
  const pct = u.today != null ? u.today / target * 100 : null
  const value = (n: number | null, recorded = 1) => n == null || !recorded ? '—' : fmtTokens(n)
  const coverage = (recorded: number, count: number) => recorded === count ? '含今日' : `已记录 ${recorded}/${count} 天`
  const comparison = !u.comparable ? '完整日记录不足，暂不比较周变化' : u.change != null
    ? `最近7个完整日较前7日${u.change >= 0 ? '增加' : '减少'} ${Math.abs(u.change).toFixed(0)}%`
    : u.recent.total === 0 ? '最近两个完整周均无用量' : '前7个完整日无用量，近期已开始使用'

  return <section className="usage-panel usage-overview" aria-label="整体用量总览" aria-busy={loading}>
    <div className="engine-trend__head"><div><h2>整体用量</h2><p>{engines || '有记录的引擎'} · 汇总纳管服务器的 CLI 会话 Token，含缓存读取</p></div></div>
    <div className="usage-overview__grid">
      <div className="usage-overview__metric usage-overview__today">
        <span>今日{date && ` · ${date.slice(5)}`}</span><strong className="mono" data-usage-metric="today">{value(u.today)}</strong>
        <small>日目标 {fmtYi(target)} · {pct == null ? '暂无记录' : `已完成 ${Math.round(pct)}%`}</small>
        {pct != null && <div className="usage-overview__progress" role="progressbar" aria-label="今日 Token 目标完成度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(pct))} aria-valuetext={`已完成 ${Math.round(pct)}%`}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>}
      </div>
      <div className="usage-overview__metric"><span>近7天累计</span><strong className="mono" data-usage-metric="week">{value(u.week.total, u.week.recorded)}</strong><small>日均 {value(u.week.average)} · {coverage(u.week.recorded, 7)}</small></div>
      <div className="usage-overview__metric"><span>近30天累计</span><strong className="mono" data-usage-metric="month">{value(u.month.total, u.month.recorded)}</strong><small>日均 {value(u.month.average)} · {coverage(u.month.recorded, 30)}</small></div>
      <div className="usage-overview__metric"><span>近30天峰值日</span><strong className="mono" data-usage-metric="peak">{value(u.peak?.tokens ?? null)}</strong><small>{u.peak ? `${u.peak.date} · 有记录的各引擎` : '暂无记录'}</small></div>
    </div>
    <div className="usage-overview__insight"><span>{loading && !days.length ? '正在汇总用量…' : comparison}</span><button type="button" className="btn-ghost" onClick={() => document.getElementById('project-usage')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>查看项目消耗 ↓</button></div>
    <p className="engine-trend__note">Token 目标用于跟踪工作量，订阅剩余额度见下方额度图。周变化比较完整日期，不把今天尚未结束的用量与完整一天混比。</p>
  </section>
}
