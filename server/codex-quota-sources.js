// Explicit account mappings are operator configuration. Fresh installs never
// assume two machines share a login or bind history to the current account.
export const CODEX_SHARED_SOURCES = []
export const CODEX_HISTORY_ALIASES = {}
let configuredGroups = []
export function configureQuotaSources({groups=[],historyAliases={}}={}) {
  configuredGroups=groups.filter(g=>typeof g.accountId==='string'&&Array.isArray(g.serverIds)).map(g=>({accountId:g.accountId,serverIds:[...g.serverIds]}))
  CODEX_SHARED_SOURCES.splice(0,CODEX_SHARED_SOURCES.length,...configuredGroups.flatMap(g=>g.serverIds))
  for(const key of Object.keys(CODEX_HISTORY_ALIASES))delete CODEX_HISTORY_ALIASES[key]
  Object.assign(CODEX_HISTORY_ALIASES,historyAliases)
}

const usable = (r) => r && !r.error && !r.stale && Number.isSafeInteger(r.at) && r.at > 0
  && r.at <= Date.now() + 60_000 && [r.primary, r.secondary].some(w => w
    && typeof w.pct === 'number' && Number.isFinite(w.pct) && w.pct >= 0 && w.pct <= 100
    && Number.isInteger(w.windowMin) && w.windowMin > 0)

/** One preferred probe for a confirmed shared account; fail over without hiding other accounts. */
export async function probeCodexAccounts(agents, fetchLimits) {
  const shared = configuredGroups.map(g=>({...g,agents:g.serverIds.map(id=>agents.find(a=>a.id===id)).filter(Boolean)}))
  const covered=new Set(shared.flatMap(g=>g.serverIds))
  const groups=[...shared,...agents.filter(a=>!covered.has(a.id)).map(a=>({agents:[a]}))]
  const observations = (await Promise.all(groups.map(async group => {
    const out = []
    for (const a of group.agents) {
      const r = await fetchLimits(a).catch(() => null)
      if (!usable(r)) continue
      out.push({ ...r, sourceServerId: a.id })
      // If a node changes login, keep that account and still look for the confirmed account.
      if (!group.accountId || r.accountId === group.accountId) break
    }
    return out
  }))).flat()
  const byAccount = new Map()
  for (const r of observations) {
    const key = r.accountId || r.sourceServerId
    const prev = byAccount.get(key)
    if (!prev || r.at > prev.at) byAccount.set(key, r)
  }
  return [...byAccount.values()].sort((a, b) => b.at - a.at)
}
