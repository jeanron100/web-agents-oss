import { useEffect, useState } from 'react'
import { fmtTokens, fmtYi } from '../lib/format'
import { useAppStore } from '../store/store'

// #2 真实订阅用量（看板）：官方 /usage 的 5h 会话窗口 % + 本周 %（与 VS Code 同源）。
// 探测由 hub 委派给已登录 claude 的机器（默认 .232）代跑，见 server/usage-limits.js。
// 辅以本机自扫的近5h/本周 token 量。官方 % 拿不到时优雅降级为只显示 token。
//
// ⚠️ stale 必须显示出来。2026-07-26 事故：取数机 claude 未登录，后端把上次的值永久留着，
// 界面自信地挂了 18 小时前的 16%（真实 29%）——**修了后端却不显示，等于错误送不到人眼前**。
type Lim = {
  session: { pct: number; resets: string } | null
  week: { pct: number; resets: string } | null
  weekSonnet: { pct: number; model?: string } | null
  ts?: number
  stale?: boolean
  error?: string
}
const shortReset = (s?: string) => (s ? s.replace(/\s*\([^)]*\)\s*$/, '') : '')
const pctCls = (p?: number) => (p == null ? '' : p >= 90 ? 'usage-sum__val--warn' : '')
/** 「N 分钟前」——只在真有旧值时才说得出口 */
const agoText = (ts?: number) => {
  if (!ts) return ''
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`
}

export function UsageSummary() {
  const [lim, setLim] = useState<Lim | null>(null)
  const [tok, setTok] = useState<{ last5h: number; last7d: number } | null>(null)
  const refreshSeq = useAppStore((s) => s.refreshSeq)
  useEffect(() => {
    let alive = true
    const load = () => {
      fetch('/api/usage/limits').then((r) => r.json()).then((d) => { if (alive) setLim(d) }).catch(() => {})
      fetch('/api/usage/daily?days=7').then((r) => r.json()).then((d) => {
        if (alive) setTok({ last5h: d.last5h ?? 0, last7d: d.last7d ?? 0 })
      }).catch(() => {})
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [refreshSeq])
  if (!lim && !tok) return null
  const hasReal = !!(lim && (lim.session || lim.week))
  const stale = !!lim?.stale
  // 两种失败态分开说：有旧值才谈「N 分钟前」，从没探到过就只报原因
  const staleNote = !stale ? '' : hasReal
    ? `额度取数失败 · 显示${agoText(lim?.ts) ? ` ${agoText(lim?.ts)}的` : '上次的'}值`
    : `额度取数失败：${lim?.error ?? '原因未知'}`

  return (
    <>
    <div className="usage-cap usage-cap--claude">
      Claude 额度
      {stale && <span className="usage-cap__err" title={lim?.error ?? ''}>⚠ {staleNote}</span>}
    </div>
    <section className={`usage-sum${stale ? ' usage-sum--dim' : ''}`}>
      <div className="usage-sum__item" title={`会话窗口 (5h)${lim?.session ? ` · 重置 ${shortReset(lim.session.resets)}` : ''}${tok ? ` · 近5h ${fmtTokens(tok.last5h)}` : ''}`}>
        <div className="usage-sum__label">会话 5h</div>
        <div className={`usage-sum__val mono ${pctCls(lim?.session?.pct)}`}>{lim?.session ? `${lim.session.pct}%` : '—'}</div>
      </div>
      <div className="usage-sum__item" title={`本周 全模型${lim?.week ? ` · 重置 ${shortReset(lim.week.resets)}` : ''}${tok ? ` · 本周 ${fmtYi(tok.last7d)}` : ''}`}>
        <div className="usage-sum__label">本周</div>
        <div className={`usage-sum__val mono ${pctCls(lim?.week?.pct)}`}>{lim?.week ? `${lim.week.pct}%` : '—'}</div>
      </div>
      <div className="usage-sum__item" title={hasReal ? `本周 ${lim?.weekSonnet?.model ?? '次级模型'} 用量` : '官方用量不可用'}>
        {/* 标签跟着官方输出走：曾写死 Sonnet，官方改成 Fable 后这一格恒空了 */}
        <div className="usage-sum__label">{hasReal ? (lim?.weekSonnet?.model ?? 'Sonnet') : '官方'}</div>
        <div className="usage-sum__val mono">{lim?.weekSonnet ? `${lim.weekSonnet.pct}%` : (hasReal ? '0%' : '—')}</div>
      </div>
    </section>
    </>
  )
}
