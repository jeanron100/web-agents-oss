import { useState } from 'react'

/** 0–100% 折线 path(纯函数,可测)。values 与 x 索引一一对应,null 断开重新起笔。 */
export function buildPctPath(
  values: Array<number | null>, W: number, H: number,
  padL: number, padR: number, padT: number, padB: number,
): string {
  const n = values.length
  const innerW = W - padL - padR, innerH = H - padT - padB
  const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (v: number) => padT + innerH - (Math.max(0, Math.min(100, v)) / 100) * innerH
  let d = '', penDown = false
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (v == null) { penDown = false; continue }
    d += `${d ? ' ' : ''}${penDown ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    penDown = true
  }
  return d
}

type Row = { date: string; week: number | null; sonnet: number | null }

/** Claude 周使用率双线趋势(本周全模型 % / 本周 Sonnet %),Y 轴固定 0–100%。 */
export function PctTrendChart({ data }: { data: Row[]; days: number }) {
  const [active, setActive] = useState<number | null>(null)
  const W = 700, H = 220, padL = 10, padR = 10, padT = 16, padB = 26
  const n = data.length
  const x = (i: number) => padL + (n <= 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR))
  const y = (v: number) => padT + (H - padT - padB) - (Math.max(0, Math.min(100, v)) / 100) * (H - padT - padB)
  const weekPath = buildPctPath(data.map((d) => d.week), W, H, padL, padR, padT, padB)
  const sonnetPath = buildPctPath(data.map((d) => d.sonnet), W, H, padL, padR, padT, padB)
  const labelIdx = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [0]
  const grid = [0, 25, 50, 75, 100]

  let tip = null
  if (active != null && data[active]) {
    const d = data[active]
    const text = `${d.date.slice(5)} · 本周 ${d.week ?? '—'}%${d.sonnet != null ? ` · Sonnet ${d.sonnet}%` : ''}`
    const tw = text.length * 8.4 + 16
    const tx = Math.max(padL, Math.min(W - padR - tw, x(active) - tw / 2))
    tip = (
      <g pointerEvents="none">
        <rect x={tx} y={2} width={tw} height={21} rx={6} className="usage-chart__tip-bg" />
        <text x={tx + tw / 2} y={16.5} textAnchor="middle" className="usage-chart__tip">{text}</text>
      </g>
    )
  }

  if (!n) return <div className="empty-state" style={{ fontSize: 12.5 }}>暂无周使用率数据</div>
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="usage-chart pct-trend" preserveAspectRatio="xMidYMid meet">
      {grid.map((g) => (
        <g key={g}>
          <line x1={padL} y1={y(g)} x2={W - padR} y2={y(g)} className="pct-trend__grid" />
          <text x={padL} y={y(g) - 2} className="usage-chart__xlabel">{g}%</text>
        </g>
      ))}
      {weekPath && <path d={weekPath} className="pct-trend__line pct-trend__line--week" fill="none" />}
      {sonnetPath && <path d={sonnetPath} className="pct-trend__line pct-trend__line--sonnet" fill="none" />}
      {data.map((d, i) => d.week != null && (
        <circle key={`w${i}`} cx={x(i)} cy={y(d.week)} r={i === active ? 5 : 2.5} className="pct-trend__dot pct-trend__dot--week" />
      ))}
      {data.map((_d, i) => (
        <circle key={`h${i}`} cx={x(i)} cy={y(data[i].week ?? 0)} r={14} fill="transparent" style={{ cursor: 'pointer' }}
          onClick={() => setActive((a) => (a === i ? null : i))} />
      ))}
      {labelIdx.map((i) => (
        <text key={i} x={x(i)} y={H - 7} className="usage-chart__xlabel"
          textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{data[i].date.slice(5)}</text>
      ))}
      {tip}
    </svg>
  )
}
