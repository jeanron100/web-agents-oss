#!/usr/bin/env node
// Strict validator for agent /api/state. The deploy script consumes its exit code:
//   0 = valid and idle, 10 = active platform sessions, 2 = malformed/incomplete payload.
import { pathToFileURL } from 'node:url'

const ACTIVE_STATES = new Set(['running', 'waiting_approval', 'waiting_input'])

export function checkDeployState(text, field = 'sessions') {
  let payload
  try { payload = JSON.parse(text) } catch { return { code: 2, error: '/api/state 不是有效 JSON' } }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload[field])) {
    return { code: 2, error: `响应缺少 ${field} 数组` }
  }

  const rows = []
  for (const session of payload[field]) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      return { code: 2, error: '/api/state.sessions 含非对象条目' }
    }
    // drain 响应(--field=active)已是筛过的 blocker，直接计入。/api/state 的 sessions 则优先看
    // 精确的 inflight 布尔（回合真在飞才阻塞），无该字段（老 agent）时回退粗粒度 state（CR-006 P1-b）。
    const blocks = field === 'active'
      ? ACTIVE_STATES.has(session.state)
      : (session.origin === 'platform' && !(session.engine === 'codex' && session.restartSafe === true && !session.queuedMessages)
        && (typeof session.inflight === 'boolean' ? session.inflight : ACTIVE_STATES.has(session.state)))
    if (blocks) {
      const summary = String(session.summary || '').slice(0, 36)
      rows.push(`  · ${String(session.id || '')}  [${String(session.state || '')}]  ${String(session.project || '')}  ${summary}`)
    }
  }
  return rows.length ? { code: 10, output: rows.join('\n') } : { code: 0, output: '' }
}

async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const fieldArg = process.argv.find((arg) => arg.startsWith('--field='))
  const result = checkDeployState(input, fieldArg ? fieldArg.slice('--field='.length) : 'sessions')
  if (result.output) process.stdout.write(result.output + '\n')
  if (result.error) process.stderr.write(result.error + '\n')
  process.exitCode = result.code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
