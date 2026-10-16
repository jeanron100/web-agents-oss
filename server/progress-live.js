import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { redactString } from './event-redaction.js'
const run = promisify(execFile)

// Fixed command, no question text, host or shell argument can enter this probe.
// Services on the Hub are explicitly NOT an inventory of every server's tunnels.
export function createTunnelProbe() {
  let cached, pending
  return async () => {
    if (cached && Date.now() - cached.observedAt < 30000) return cached
    if (pending) return pending
    pending = (async () => {
      try {
        const { stdout } = await run('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain'], { timeout: 2500, maxBuffer: 128 * 1024 })
        const units = stdout.split('\n').map(line => line.trim().match(/^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/)).filter(m => m && /tunnel|reverse/i.test(m[1]) && !/check|probe/i.test(m[1])).slice(0, 40).map(m => ({ unit: m[1], active: m[3] === 'active', description: redactString(m[5]) }))
        return cached = { observedAt: Date.now(), scope: '仅Hub所在服务器的隧道相关systemd服务；服务活跃不等于应用可达，也不是全服务器隧道总量', units }
      } catch { return { observedAt: Date.now(), error: 'Hub隧道服务读取失败，不能确认服务数量', units: [] } }
    })().finally(() => { pending = null })
    return pending
  }
}

export function liveProgress(state, agents, { host = '', project = '', retiredAgents = [], now = Date.now(), tunnels } = {}) {
  const configured = agents.filter(a => !host || a.id === host)
  const servers = configured.map(a => {
    const s = state.servers?.find(s => s.id === a.id)
    return { id: a.id, online: !!s?.online && !s?.stale, stale: !!s?.stale, transport: a.transport || 'unknown', sessionsTruncated: !!s?.sessionsTruncated }
  })
  const sessions = (state.sessions || []).filter(s => configured.some(a => a.id === s.serverId) && (!project || s.project === project))
  const pending = (state.pendingActions || []).filter(a => a.status === 'pending' && sessions.some(s => s.id === a.sessionId))
  const running = sessions.filter(s => s.state === 'running')
  return { available: !state.unavailable, observedAt: now, scope: host ? `纳管节点 ${host}` : 'web_agents当前纳管节点（不含退役节点及其他未纳管服务器）',
    servers, retiredAgents:retiredAgents.map(a=>({id:a.id,retiredAt:a.retiredAt,alias:a.id.replace(/^srv-/,'').replace(/-/g,'.')})),serverCount: servers.length, onlineCount: servers.filter(s => s.online).length,
    projectCount: new Set(sessions.map(s => `${s.serverId}/${s.project}`)).size,
    runningCount: running.length, pendingCount: pending.length,
    running: running.map(s => ({ serverId: s.serverId, project: s.project, engine: s.engine, sessionId: s.id })),
    pending: pending.map(a => ({ serverId: a.serverId, project: sessions.find(s => s.id === a.sessionId)?.project, kind: a.kind })),
    ...(tunnels ? { tunnels } : {}),
    note: '在线仅代表agent应用接口可达；运行中仅代表CLI状态，不证明业务任务已完成。未采集全服务器SSH进程/转发表，无法确认全局隧道总量。' }
}
