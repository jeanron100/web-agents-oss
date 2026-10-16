import { useState } from 'react'
import { fmtYi } from '../lib/format'

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const dateOf = (s: string) => { const d = new Date(`${s}T00:00:00`); return isNaN(d.getTime()) ? null : d }
const wdOf = (s: string) => { const d = dateOf(s); return d ? WD[d.getDay()] : '' }
const isWeekend = (s: string) => { const d = dateOf(s); return !!d && (d.getDay() === 0 || d.getDay() === 6) }

/** token 消耗折线图（手写 SVG，零依赖）+ 水平目标虚线。点击/悬停点位显示数值。每日或按小时通用。 */
export function UsageChart({ data, target, labelFmt, targetText, valueFmt, showWeekday }: {
  data: Array<{ date: string; tokens: number; cost?: number }>
  target: number
  labelFmt?: (s: string) => string  // x 轴标签格式（默认取 MM-DD）
  targetText?: string               // 目标线文字（默认「目标 X/天」）
  valueFmt?: (n: number) => string  // tooltip 数值格式（默认 fmtYi）
  showWeekday?: boolean             // 每日档：tooltip/x 轴标周几 + 周末点高亮
}) {
  const [active, setActive] = useState<number | null>(null)
  const W = 700, H = 230, padL = 10, padR = 10, padT = 18, padB = showWeekday ? 38 : 26
  const innerW = W - padL - padR, innerH = H - padT - padB
  const n = data.length
  const max = Math.max(target, ...data.map((d) => d.tokens), 1) * 1.1
  const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (v: number) => padT + innerH - (v / max) * innerH
  const pts = data.map((d, i) => [x(i), y(d.tokens)] as const)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = pts.length
    ? `${line} L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`
    : ''
  const ty = y(target)
  const xfmt = labelFmt ?? ((s: string) => s.slice(5))
  const vfmt = valueFmt ?? fmtYi
  const labelIdx = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [0]

  // tooltip：active 点位的数值气泡（日期/时段 · token · 成本）
  let tip = null
  if (active != null && data[active]) {
    const d = data[active], p = pts[active]
    const wd = showWeekday ? ` ${wdOf(d.date)}` : ''
    const text = `${xfmt(d.date)}${wd} · ${vfmt(d.tokens)}${d.cost != null && d.cost > 0 ? ` · $${d.cost < 100 ? d.cost.toFixed(1) : Math.round(d.cost)}` : ''}`
    const tw = text.length * 8.4 + 16
    const tx = Math.max(padL, Math.min(W - padR - tw, p[0] - tw / 2))
    const tyTop = Math.max(2, p[1] - 30)
    tip = (
      <g pointerEvents="none">
        <rect x={tx} y={tyTop} width={tw} height={21} rx={6} className="usage-chart__tip-bg" />
        <text x={tx + tw / 2} y={tyTop + 14.5} textAnchor="middle" className="usage-chart__tip">{text}</text>
      </g>
    )
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="usage-chart" preserveAspectRatio="xMidYMid meet">
      {area && <path d={area} className="usage-chart__area" />}
      <line x1={padL} y1={ty} x2={W - padR} y2={ty} className="usage-chart__target" />
      <text x={W - padR} y={ty - 6} className="usage-chart__target-label" textAnchor="end">
        {targetText ?? `目标 ${fmtYi(target)}/天`}
      </text>
      {line && <path d={line} className="usage-chart__line" />}
      {pts.map((p, i) => (
        <circle
          key={i} cx={p[0]} cy={p[1]} r={i === active ? 6 : i === n - 1 ? 5 : 3}
          className={
            `usage-chart__dot${data[i].tokens > target ? ' usage-chart__dot--over' : ''}` +
            (showWeekday && isWeekend(data[i].date) ? ' usage-chart__dot--weekend' : '') +
            (i === n - 1 ? ' usage-chart__dot--last' : '')
          }
        />
      ))}
      {/* 透明大热区，便于手机点中：点击切换显隐（同一点再点关闭） */}
      {pts.map((p, i) => (
        <circle
          key={`h${i}`} cx={p[0]} cy={p[1]} r={14} fill="transparent" style={{ cursor: 'pointer' }}
          onClick={() => setActive((a) => (a === i ? null : i))}
        />
      ))}
      {labelIdx.map((i) => {
        const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'
        return (
          <g key={i}>
            <text x={x(i)} y={showWeekday ? H - 20 : H - 7} className="usage-chart__xlabel" textAnchor={anchor}>{xfmt(data[i].date)}</text>
            {showWeekday && <text x={x(i)} y={H - 6} className="usage-chart__xsub" textAnchor={anchor}>{wdOf(data[i].date)}</text>}
          </g>
        )
      })}
      {tip}
    </svg>
  )
}
