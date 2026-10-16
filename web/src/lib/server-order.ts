export function orderServers<T extends { id: string }>(servers: T[], sessions: Array<{ serverId: string }>): T[] {
  const occupied = new Set(sessions.map((s) => s.serverId))
  const priority = ['srv-178-232', 'srv-185-34']
  const rank = (id: string) => priority.includes(id) ? priority.indexOf(id) : priority.length
  return [...servers].sort((a, b) => Number(occupied.has(b.id)) - Number(occupied.has(a.id)) || rank(a.id) - rank(b.id))
}
