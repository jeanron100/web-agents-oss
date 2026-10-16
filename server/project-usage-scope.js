// Scope historical rollups before SUM: retired nodes must not contribute new days.
// An offline configured node remains valid; removal from today's live sessions is
// not evidence that its historical usage should disappear.
export function projectUsageScope({ activeServerIds, retiredServers = [] } = {}) {
  if (activeServerIds === undefined) return { sql: '1=1', params: [] }
  const active = [...new Set(activeServerIds)]
  const clauses = [], params = []
  if (active.length) {
    clauses.push(`server_id IN (${active.map(() => '?').join(', ')})`)
    params.push(...active)
  }
  for (const { id, retiredAt } of retiredServers) {
    if (active.includes(id)) throw new Error(`Server is both active and retired: ${id}`)
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(retiredAt)) throw new Error('Invalid server retirement policy')
    clauses.push('(server_id = ? AND day < ?)')
    params.push(id, retiredAt)
  }
  return { sql: clauses.length ? `(${clauses.join(' OR ')})` : '1=0', params }
}
