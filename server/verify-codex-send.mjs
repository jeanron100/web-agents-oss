// Real, isolated Codex check through the production hub. Never uses a project session.
import assert from 'node:assert/strict'
const value = (flag, fallback) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : fallback }
const base = value('--base', 'http://127.0.0.1:8787'), serverId = value('--server', 'srv-185-34')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function api(route, body) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(30000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  assert(response.ok, `${route}: ${response.status} ${result.error || ''}`)
  return result
}
async function waitFor(fn, limit = 110000) {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await pause(500) }
  throw new Error('Isolated Codex verification timed out')
}
const setup = await api('/api/exec', { serverId, cwd: '/tmp', cmd: 'mktemp -d /tmp/wa-codex-steering-XXXXXX' })
const cwd = setup.stdout?.trim()
assert(setup.code === 0 && /^\/tmp\/wa-codex-steering-[A-Za-z0-9]+$/.test(cwd), 'Temporary workspace creation failed')
let id
try {
  const created = await api('/api/session', { serverId, engine: 'codex', cwd, model: 'gpt-6.1-sol', effort: 'low',
    prompt: 'This is an isolated message-delivery test. Execute exactly one shell command sleep 12, then respond exactly FIRST_OUTPUT. Do not read or modify files or do anything else.' })
  id = created.id
  assert(/^[\w-]+$/.test(id), 'Missing test thread ID')
  console.log(JSON.stringify({ phase: 'created', id, serverId }))
  await waitFor(async () => (await api(`/api/session/${id}/events`)).events?.some(e => e.type === 'file_op' && /sleep\s+12/.test(e.path || '')))
  const sentAt = Date.now()
  const steer = await api(`/api/session/${id}/message`, { text: 'Additional information for the CURRENT task: when the current sleep finishes, replace FIRST_OUTPUT with exactly STEER_APPLIED. Do not start another command.' })
  assert.equal(steer.delivery, 'steered')
  assert.equal(steer.queued, false)
  console.log(JSON.stringify({ phase: 'steered', elapsedMs: Date.now() - sentAt, ...steer }))
  const queued = await api(`/api/session/${id}/message`, { behavior: 'queue', text: 'This is a separate NEW task. Do not run tools. Respond exactly QUEUE_TASK_DONE.' })
  assert.equal(queued.delivery, 'queued')
  assert.equal(queued.queueDepth, 1)
  console.log(JSON.stringify({ phase: 'queued', ...queued }))
  const events = await waitFor(async () => {
    const result = await api(`/api/session/${id}/events`)
    return result.events?.some(e => e.type === 'assistant' && !e.streaming && e.text?.trim() === 'QUEUE_TASK_DONE') ? result.events : null
  })
  const replies = events.filter(e => e.type === 'assistant' && !e.streaming).map(e => e.text?.trim())
  assert(replies.includes('STEER_APPLIED'), 'Supplement was not applied in the original task')
  assert(!replies.includes('FIRST_OUTPUT'), 'Original task finished before applying the supplement')
  assert(replies.indexOf('STEER_APPLIED') < replies.indexOf('QUEUE_TASK_DONE'), 'Queued task ran before the supplemented task')
  assert.equal(events.filter(e => e.type === 'user' && e.text?.includes('CURRENT task')).length, 1)
  assert.equal(events.filter(e => e.type === 'user' && e.text?.includes('separate NEW task')).length, 1)
  const latest = await api(`/api/session/${id}/events`)
  const taskEvent = latest.events.find(e => e.type === 'user' && e.text?.includes('separate NEW task'))
  const delta = await api(`/api/session/${id}/events?since=${encodeURIComponent(latest.lastSeq)}`)
  assert.equal(delta.messageReceipts?.[taskEvent.id]?.delivery, 'accepted', 'Queue processing receipt did not reach an incremental frame')
  assert.equal(delta.events.length, 0, 'Receipt update should not duplicate durable messages')
  const script = `from pathlib import Path\nimport json\nfiles=list((Path.home()/'.codex/sessions').rglob('*${id}*.jsonl'))\nassert files\nrows=[json.loads(line) for line in files[0].open() if line.strip()]\nstarts=sum(r.get('type')=='event_msg' and r.get('payload',{}).get('type')=='task_started' for r in rows)\nprint(json.dumps({'nativeTurnStarts':starts}))`
  const native = await api('/api/exec', { serverId, cwd: '/tmp', cmd: `python3 - <<'PY'\n${script}\nPY` })
  assert.equal(native.code, 0)
  const report = JSON.parse(native.stdout)
  assert.equal(report.nativeTurnStarts, 2, 'Steering created an extra native turn')
  console.log(JSON.stringify({ phase: 'verified', ...report, originalTurnReply: 'STEER_APPLIED', queuedTaskReply: 'QUEUE_TASK_DONE', duplicateMessages: 0 }))
} finally {
  if (id) { await api(`/api/session/${id}/release`, {}); console.log(JSON.stringify({ phase: 'released', id })) }
  await api('/api/exec', { serverId, cwd: '/tmp', cmd: `rm -rf -- ${cwd}` })
}
