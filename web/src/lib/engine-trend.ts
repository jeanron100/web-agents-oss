export type EngineDay = { date: string; byEngine?: Record<string, number> }
export const USAGE_ENGINES = ['codex', 'kimi', 'claude'] as const
export type UsageEngine = typeof USAGE_ENGINES[number]
export const engineName = (engine: UsageEngine) => ({ codex: 'Codex', kimi: 'Kimi', claude: 'Claude' })[engine]
export function usageEngines(days: EngineDay[]) {
  return USAGE_ENGINES.filter(e => days.some(d => d.byEngine && Object.hasOwn(d.byEngine, e) && Number.isFinite(d.byEngine[e]) && d.byEngine[e] >= 0))
}
export function engineTrend(days: EngineDay[], window: number) {
  return days.slice(-window).map(d => ({
    date: d.date,
    codex: d.byEngine ? Math.max(0, Number(d.byEngine.codex) || 0) : null,
    kimi: d.byEngine ? Math.max(0, Number(d.byEngine.kimi) || 0) : null,
    claude: d.byEngine ? Math.max(0, Number(d.byEngine.claude) || 0) : null,
  }))
}

export function tokenPath(values: Array<number | null>, max: number) {
  let drawing = false
  return values.map((v, i) => {
    if (v == null) { drawing = false; return '' }
    const x = 64 + (values.length <= 1 ? 304 : i / (values.length - 1) * 608)
    const y = 194 - v / max * 160
    const command = drawing ? 'L' : 'M'
    drawing = true
    return `${command}${x.toFixed(1)},${y.toFixed(1)}`
  }).filter(Boolean).join(' ')
}
