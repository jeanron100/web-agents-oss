// Persist only connection identities. Prompts/queued input remain in the driver;
// their presence must block restart until delivered to the independent daemon.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { atomicWriteFile, loadStore } from './session-store.js'

function parseRegistry(text) {
  const data = JSON.parse(text)
  if (data.version !== 1 || !Array.isArray(data.sessions)
    || data.sessions.some(s => !s || typeof s.id !== 'string' || typeof s.cwd !== 'string' || !path.isAbsolute(s.cwd))) {
    throw new Error('invalid Codex reconnect registry')
  }
  return data.sessions
}

export function createReconnectRegistry(file = process.env.WA_CODEX_RECONNECT_FILE
  || path.join(os.homedir(), '.web-agents', 'codex-reconnect.json')) {
  const loaded = loadStore(file, { parseWith: parseRegistry })
  const records = new Map((Array.isArray(loaded) ? loaded : []).map(s => [s.id, s]))
  let synced = true
  const save = () => {
    try {
      atomicWriteFile(file, JSON.stringify({ version: 1, sessions: [...records.values()] }), { validate: parseRegistry })
      synced = true
    } catch (error) { synced = false; console.error('[codex-reconnect] identity write failed:', error.message) }
  }
  return {
    list: () => [...records.values()],
    has: id => synced && records.has(id),
    remember: s => { records.set(s.id, { id: s.id, cwd: s.cwd, mode: s.mode, startedAt: s.startedAt }); save() },
    forget: id => { records.delete(id); save() },
  }
}

// Match the actual listening socket owner, not merely a process named codex.
// An unreadable /proc or a daemon inside the agent cgroup fails closed.
export function independentDaemon(socketPath, { procRoot = '/proc', agentPid = 'self', daemonPid } = {}) {
  try {
    const socket = fs.realpathSync(socketPath)
    const inode = fs.readFileSync(path.join(procRoot, 'net/unix'), 'utf8').split('\n')
      .map(line => line.trim().split(/\s+/)).find(parts => parts[7] === socket && parts[3] === '00010000')?.[6]
    if (!inode) return null
    const group = pid => fs.readFileSync(path.join(procRoot, String(pid), 'cgroup'), 'utf8').trim().split('\n')
    const agentGroups = group(agentPid)
    const candidates = daemonPid ? [String(daemonPid)] : fs.readdirSync(procRoot).filter(p => /^\d+$/.test(p))
    for (const pid of candidates) {
      try {
        const args = fs.readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8').split('\0')
        if (!args.includes('app-server') || !args.includes('--managed-daemon')) continue
        const fdDir = path.join(procRoot, pid, 'fd')
        if (!fs.readdirSync(fdDir).some(fd => {
          try { return fs.readlinkSync(path.join(fdDir, fd)) === `socket:[${inode}]` } catch { return false }
        })) continue
        const daemonGroups = group(pid)
        if (agentGroups.some(a => daemonGroups.some(d => d === a || d.startsWith(a.endsWith('/') ? a : a + '/')))) return null
        return { pid: Number(pid), cgroup: daemonGroups.join('\n') }
      } catch { /* process exited during inspection */ }
    }
  } catch { /* cannot prove independent ownership */ }
  return null
}
