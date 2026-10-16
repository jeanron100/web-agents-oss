// node --test server/event-envelope.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeEventKey, normalizeEvent, SCHEMA_VERSION } from './event-envelope.js'

test('computeEventKey：同一原生事件 eventKey 稳定（可重算）', () => {
  const a = computeEventKey({ serverId: 'srv-178-232', engine: 'claude', seq: '1848024c:197:2820:0' })
  const b = computeEventKey({ serverId: 'srv-178-232', engine: 'claude', seq: '1848024c:197:2820:0' })
  assert.equal(a, b)
  assert.equal(a, 'srv-178-232:claude:1848024c:197:2820:0')
})

test('computeEventKey：Claude 与 Codex 命名空间不冲突（即便 seq 偶然相同）', () => {
  const seq = 'X:1'
  const c = computeEventKey({ serverId: 's', engine: 'claude', seq })
  const x = computeEventKey({ serverId: 's', engine: 'codex', seq })
  assert.notEqual(c, x)
  assert.ok(c.includes(':claude:') && x.includes(':codex:'))
})

test('computeEventKey：缺字段抛错（不静默产坏键）', () => {
  assert.throws(() => computeEventKey({ serverId: 's', engine: 'claude', seq: '' }))
  assert.throws(() => computeEventKey({ serverId: '', engine: 'claude', seq: '1' }))
  assert.throws(() => computeEventKey({ serverId: 's', seq: '1' }))
})

test('normalizeEvent：产出统一信封 + _id=eventKey + 不搬正文', () => {
  const raw = { type: 'file_op', verb: '更新文件', path: 'src/a.ts', additions: 3, ts: 1783219122253, seq: 'r:1:2:0', text: '不该出现的正文' }
  const env = normalizeEvent(raw, { serverId: 'srv', engine: 'claude', project: 'web_agents', sessionId: 'ps-x', realSessionId: 'r' })
  assert.equal(env.schemaVersion, SCHEMA_VERSION)
  assert.equal(env._id, env.eventKey)
  assert.equal(env.eventKey, 'srv:claude:r:1:2:0')
  assert.equal(env.type, 'tool.used')
  assert.equal(env.payload.verb, '更新文件')
  assert.equal(env.payload.path, 'src/a.ts')
  assert.equal(env.payload.additions, 3)
  // 正文不进 payload（safePayload 只挑结构化字段）
  assert.equal('text' in env.payload, false)
  assert.equal(env.occurredAt, new Date(1783219122253).toISOString())
})

test('normalizeEvent：kind 优先作为已归一 type', () => {
  const env = normalizeEvent({ kind: 'approval.resolved', ts: 1, seq: 'a:1' }, { serverId: 's', engine: 'claude' })
  assert.equal(env.type, 'approval.resolved')
})

test('摘要：只对用户/助手取，且截断——历史需要语义锚点，但红线是「完整正文」不入库', () => {
  const long = '帮我重构持仓页'.repeat(50)
  const u = normalizeEvent({ type: 'user', text: long, ts: 1, seq: 'r:1:1:0' }, { serverId: 's', engine: 'claude' })
  assert.ok(u.payload.summary.length <= 141, '摘要必须截断（140 + 省略号）')
  assert.ok(u.payload.summary.length < long.length, '不得整段搬运正文')
  assert.ok(u.payload.summary.startsWith('帮我重构持仓页'), '截断后仍要能认出这一轮在问什么')

  // 工具事件不碰文本：否则 Read/Bash 的文件内容、终端输出会顺着 text 溜进库
  const t = normalizeEvent({ type: 'file_op', verb: '读取文件', path: 'a.ts', text: '文件全文', ts: 1, seq: 'r:1:2:0' },
    { serverId: 's', engine: 'claude' })
  assert.equal('summary' in t.payload, false, '非 user/assistant 一律不产摘要')
})

test('执行命令：只留极短预览，绝不留完整 Bash 参数（spec 红线）', () => {
  const longCmd = 'curl -H "Authorization: Bearer SUPERSECRETTOKEN123456" https://x/api && rm -rf /tmp/foo && echo done'
  const env = normalizeEvent({ type: 'file_op', verb: '执行命令', path: longCmd, ts: 1, seq: 'r:1:1:0' },
    { serverId: 's', engine: 'claude' })
  assert.equal('path' in env.payload, false, '命令不得落在 path 字段（会绕过 command 黑名单）')
  assert.ok(env.payload.cmdPreview.length <= 50, '只能是极短预览')
  assert.ok(!env.payload.cmdPreview.includes('SUPERSECRETTOKEN123456'), '完整参数/密钥不得入库')
  assert.ok(env.payload.cmdPreview.startsWith('curl'), '预览应仍能认出跑了什么')
})
