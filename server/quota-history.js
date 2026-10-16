import { CODEX_HISTORY_ALIASES, CODEX_SHARED_SOURCES } from './codex-quota-sources.js'

// Subscription percentages are observations, never inferred from token totals.
const validPct = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
const validTs = (v, now) => Number.isSafeInteger(v) && v > 0 && v <= now + 60_000

export function codexQuotaSamples(accounts, now = Date.now()) {
  const out = []
  for (const a of accounts ?? []) {
    if (a.stale || a.error || !validTs(a.at, now)) continue
    const accountKey = a.accountId || a.sourceServerId
    if (!accountKey) continue // Unidentified accounts must not be merged together.
    for (const w of [a.primary, a.secondary]) {
      if (!w || !validPct(w.pct) || !Number.isInteger(w.windowMin) || w.windowMin < 1440) continue
      out.push({ engine: 'codex', accountKey, windowKey: String(w.windowMin),
        windowLabel: w.windowMin === 10080 ? '本周' : w.windowMin === 43200 ? '本月' : `${w.windowMin / 1440}天`,
        ts: a.at, pct: w.pct, resetAt: Number.isSafeInteger(w.resetsAt * 1000) && w.resetsAt > 0 ? w.resetsAt * 1000 : null })
    }
  }
  return out
}

export function kimiQuotaSamples(u, source, now = Date.now()) {
  if (!u || u.stale || u.error || u.disabled || !validTs(u.ts, now) || !validPct(u.week?.pct)) return []
  // Kimi's legacy "week" field can actually contain its monthly allowance.
  const label = u.week.label || 'Weekly'
  const monthly = /month|月/i.test(label), weekly = /week|周/i.test(label)
  return [{ engine: 'kimi', accountKey: source, windowKey: label.toLowerCase(),
    windowLabel: monthly ? '本月' : weekly ? '本周' : label, ts: u.ts, pct: u.week.pct, resetAt: null }]
}

export function quotaSeries(rows) {
  const groups = new Map()
  for (const r of rows) {
    const accountKey = r.engine === 'codex' ? CODEX_HISTORY_ALIASES[r.account_key] || r.account_key : r.account_key
    const id = JSON.stringify([r.engine, accountKey, r.window_key])
    if (!groups.has(id)) groups.set(id, { id, engine: r.engine, windowLabel: r.window_label,
      ...(accountKey.startsWith('historical:') ? { sourceLabel: `历史 ${accountKey.slice(11)}（账号未记录）` } : {}), buckets: new Map() })
    const ts = Number(r.ts_ms), bucket = Math.floor(ts / 10800000)
    const priority = r.account_key === accountKey ? 2 : r.account_key === `historical:${CODEX_SHARED_SOURCES[0]}` ? 1 : 0
    const buckets = groups.get(id).buckets, previous = buckets.get(bucket)
    if (!previous || ts > previous.ts || (ts === previous.ts && priority > previous.priority)) {
      buckets.set(bucket, { ts, pct: Number(r.pct), priority })
    }
  }
  return [...groups.values()].map(({ buckets, ...series }) => ({ ...series,
    points: [...buckets.values()].sort((a, b) => a.ts - b.ts).map(({ ts, pct }) => ({ ts, pct })),
  }))
}

/** The legacy table is Claude-only; its values cannot be attributed to Codex. */
export function legacyClaudeQuotaSeries(rows) {
  const points = rows.filter(r => r.week_pct != null && validPct(Number(r.week_pct)) && Number(r.ts_ms) > 0)
    .map(r => ({ ts: Number(r.ts_ms), pct: Number(r.week_pct) }))
  return points.length ? [{ id: 'claude-legacy-week', engine: 'claude', windowLabel: '本周', sourceLabel: '历史', points }] : []
}
