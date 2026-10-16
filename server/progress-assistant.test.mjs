import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { progressEvents, tasksFromEvents, queryProgress, reportedStatus } from './progress-evidence.js'
import { createProgressAssistant } from './progress-assistant.js'

const at = Date.parse('2026-10-15T11:06:00Z')
const source = { serverId: 'srv-178-232', project: 'claude_manager', sessionId: 'session-a', engine: 'codex' }
const msg = (role, text, timestamp = at) => JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } })
const fixture = [msg('user', '排查 .120 的磁盘空间', at - 60000), msg('assistant', '已删除 .120 的67张 __droppable 表，释放2.85GiB。', at - 50000), msg('user', '保留1个星期以内就可以', at - 20000), msg('assistant', '已改为保留7天，每日04:20清理。\n当前磁盘90%，可用8.8G。\n主从复制正常，延迟0秒。')].join('\n')

test('modern Codex visible dialogue, latest follow-up, host context, and remaining risk', () => {
  const events = progressEvents(fixture, 'codex'), tasks = tasksFromEvents(events, source)
  const result = queryProgress(tasks, { q: 'claude_manager 120解决了吗', now: at + 1000 })
  assert.equal(result.tasks.length, 2)
  assert.match(result.tasks[0].result, /8.8G/)
  assert.equal(result.tasks[0].status, 'reported_complete')
  assert.match(result.tasks[0].risks.join('\n'), /90%/)
  assert(!result.tasks[0].risks.join('\n').includes('复制正常'))
})

test('no result or a later negative reply cannot become completed from session idle', () => {
  assert.equal(reportedStatus(''), 'unconfirmed')
  assert.equal(reportedStatus('已修复部分问题，但尚未完成'), 'unconfirmed')
  assert.equal(reportedStatus('已完成修改，但还需上线验证'), 'unconfirmed')
  assert.equal(reportedStatus('执行失败，无法继续'), 'blocked')
  const t = tasksFromEvents([{ type: 'user', text: '查磁盘', ts: at }], { ...source, state: 'idle' })
  assert.equal(t[0].status, 'unconfirmed')
})

test('a clipped answer cannot be silently promoted to a completed task', () => {
  const events = progressEvents([msg('user', '检查磁盘'), msg('assistant', '已完成清理。' + '很长的说明'.repeat(1500) + '但尚未解决')].join('\n'), 'codex')
  const task = tasksFromEvents(events, source)[0]
  assert.match(task.result, /已截断/)
  assert.equal(task.status, 'unconfirmed')
})

test('system instructions and private reasoning are excluded; credentials are redacted', () => {
  const rows = [msg('user', '<environment_context>injected</environment_context>'), msg('user', '检查磁盘'), msg('assistant', 'password=secretvalue 已清理'), JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private reasoning' }] } })]
  const events = progressEvents(rows.join('\n'), 'codex')
  assert.equal(events.length, 2)
  assert(!JSON.stringify(events).includes('secretvalue'))
  assert(!JSON.stringify(events).includes('private reasoning'))
})

test('Claude content blocks and Kimi loop events retain visible answers only', () => {
  const claude = [JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: '检查磁盘' } }), JSON.stringify({ type: 'assistant', timestamp: at + 1, message: { role: 'assistant', content: [{ type: 'text', text: '已完成清理' }, { type: 'tool_use', name: 'Bash', input: { command: 'df -h' } }] } })].join('\n')
  assert.equal(tasksFromEvents(progressEvents(claude, 'claude'), source)[0].status, 'reported_complete')
  const kimi = [JSON.stringify({ time: at, type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '检查空间' }] } }), JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', text: 'hidden' } } }), JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '已完成清理' } } })].join('\n')
  const events = progressEvents(kimi, 'kimi')
  assert(!JSON.stringify(events).includes('hidden'))
  assert.equal(tasksFromEvents(events, source)[0].status, 'reported_complete')
})

test('server/project isolation, unknown host, time window and overview grouping', () => {
  const tasks = tasksFromEvents(progressEvents(fixture, 'codex'), source)
  assert.equal(queryProgress(tasks, { q: '999磁盘', now: at + 1 }).total, 0)
  assert.equal(queryProgress(tasks, { host: 'other', now: at + 1 }).total, 0)
  assert.equal(queryProgress(tasks, { now: at + 10 * 86400000, days: 1 }).total, 0)
  assert.equal(queryProgress(tasks, { now: at + 1 }).tasks.length, 1)
})

test('a short explicit new host request replaces unrelated older long instructions', () => {
  const tasks = tasksFromEvents([
    { type: 'user', text: '/root旧编辑器缓存需要清理，另一个节点上的旧日志和镜像也需要检查', ts: at - 5000 },
    { type: 'user', text: '120数据库空间满了？', ts: at - 4000 },
    { type: 'assistant', text: '.120磁盘高水位', ts: at - 3000 },
    { type: 'user', text: '保留1个星期以内就可以', ts: at - 2000 },
    { type: 'assistant', text: '已改为7天，磁盘90%', ts: at },
  ], source)
  assert.equal(tasks.at(-1).context, '120数据库空间满了？')
})

test('truncated tail with only replies retains progress but never invents an original request', () => {
  const tasks = tasksFromEvents([{ type: 'assistant', text: '已完成上线，仍有磁盘告警', ts: at }], { ...source, sourceTruncated: true })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].requestMissing, true)
  assert.equal(tasks[0].request, '')
  assert.equal(tasks[0].status, 'unconfirmed')
  assert.match(tasks[0].result, /已完成上线/)
})

test('refresh is single flight, read only, deduplicated and durable; offline source retains evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-progress-test-'))
  let offline = false, reads = 0
  const opts = { file: path.join(dir, 'progress.json'), agents: [{ id: source.serverId, url: 'http://agent' }], now: () => at + 1000,
    getState: async () => ({ sessions: [{ ...source, id: source.sessionId, cwd: '/workspace/claude_manager', lastActiveAt: at }] }),
    archiveStatus: () => ({ enabled: false }),
    fetchJson: async url => {
      if (offline) throw new Error('offline')
      if (url.includes('/inventory')) return { files: [{ engine: 'codex', path: '/sessions/session-a.jsonl', st: { size: fixture.length, mtimeMs: at } }] }
      assert(url.includes('/api/archive/read?')); reads++; return { text: fixture }
    } }
  try {
    const assistant = createProgressAssistant(opts)
    const first = assistant.refresh()
    assert.equal(first, assistant.refresh())
    await first; await assistant.refresh()
    assert.equal(reads, 1)
    const d = await assistant.query({ q: '120磁盘' })
    assert.equal(d.total, 2); assert.equal(d.coverage.archive.enabled, false)
    const restored = createProgressAssistant(opts)
    assert.equal((await restored.query({ q: '120磁盘' })).total, 2)
    await restored.refresh()
    offline = true; await assistant.refresh()
    const stale = await assistant.query({ q: '120磁盘' })
    assert.equal(stale.total, 2); assert(stale.coverage.sources.some(s => s.error))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a focused refresh does not mark all other projects as fresh', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-progress-scope-'))
  let requests = 0
  const assistant = createProgressAssistant({ file: path.join(dir, 'cache.json'), agents: [], now: () => at,
    archiveStatus: () => ({ enabled: false }), fetchJson: async () => ({}), getState: async () => { requests++; return { sessions: [] } } })
  try {
    await assistant.refresh({ project: 'focused' })
    assert.equal(requests, 1)
    const all = await assistant.query()
    assert.equal(all.refreshing, true)
    await assistant.refresh()
    assert.equal(requests, 3) // refresh plus the independent current-state read
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
