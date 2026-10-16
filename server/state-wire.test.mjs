// node --test server/state-wire.test.mjs
//
// /api/state 的**线协议裁剪**。
//
// 背景（2026-08-12 实测）：前端每 3 秒轮询 /api/state，跨境一次要 6~16 秒。
// payload 80KB（gzip 25KB），其中 sessions[] 占 88.4%。而按字段拆开一量：
//   firstPrompt 17.3KB(18.5%) / lastEvent 8.9KB(9.5%) / todoStats 2.6KB(2.7%)
//   —— 合计 28.8KB、**占 sessions 的 30.8%，而前端引用数为 0**（全仓库 grep 只有生产者）。
// 三成的会话载荷是没有任何消费方的字段，每 3 秒跨境传一次。
//
// 对应记忆里那条：**内部对象 ≠ 线协议；出口 toWire() 必须是纯函数。**
//
// ★ 最要命的一条性质是「不得改动入参」：firstPrompt 在服务端**内部仍要用于归属判断**
//   （agent.js:545「专供归属判断用」）。如果裁剪就地删字段，会静默破坏归属逻辑——
//   而且这种破坏不会报错，只会让会话归错项目。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stateToWire, DROPPED_SESSION_FIELDS } from './state-wire.js'

const sess = (over = {}) => ({
  id: 'ps-1', serverId: 'srv-a', project: 'p', engine: 'claude', state: 'idle',
  summary: '摘要', cwd: '/data/p', startedAt: 1, lastActiveAt: 2, tokens: 10, cost: 0.5,
  firstPrompt: '这是一段一百二十字上限的首个提问文本'.repeat(3),
  lastEvent: { ts: 9, verb: 'edit', path: 'a/b.ts' },
  todoStats: { total: 5, done: 2 },
  tokensBreakdown: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
  detachedReason: '已分离',
  ...over,
})

test('★ 三个无人消费的字段从线协议里消失', () => {
  const wire = stateToWire({ sessions: [sess()] })
  for (const f of DROPPED_SESSION_FIELDS) {
    assert.ok(!(f in wire.sessions[0]), `${f} 不应出现在线协议里`)
  }
})

test('★★ 绝不改动入参——firstPrompt 服务端内部还要用于归属判断', () => {
  const input = { sessions: [sess()] }
  const before = JSON.parse(JSON.stringify(input))
  stateToWire(input)
  assert.deepEqual(input, before, 'stateToWire 必须是纯函数，不得就地删字段')
})

test('前端真正在用的字段一个都不能少', () => {
  const wire = stateToWire({ sessions: [sess()] })
  const s = wire.sessions[0]
  // SessionCard.tsx 的 KEYS + cost.ts 用到的 tokensBreakdown
  for (const k of ['id', 'state', 'summary', 'engine', 'cost', 'tokens', 'lastActiveAt',
                   'serverId', 'project', 'cwd', 'startedAt', 'tokensBreakdown', 'detachedReason']) {
    assert.ok(k in s, `${k} 必须保留`)
  }
})

test('sessions 以外的顶层字段原样保留', () => {
  const st = { servers: [{ id: 'srv-a' }], sessions: [], pendingActions: [{ id: 'act-1' }], projectModels: { p: 'opus' } }
  const wire = stateToWire(st)
  assert.deepEqual(wire.servers, st.servers)
  assert.deepEqual(wire.pendingActions, st.pendingActions)
  assert.deepEqual(wire.projectModels, st.projectModels)
})

test('缺 sessions / 非数组 / 空 都不得抛', () => {
  assert.doesNotThrow(() => stateToWire({}))
  assert.doesNotThrow(() => stateToWire({ sessions: null }))
  assert.doesNotThrow(() => stateToWire({ sessions: [] }))
  assert.doesNotThrow(() => stateToWire(null))
})

test('裁剪确实减小了体积（回归护栏：有人把字段加回来就会红）', () => {
  const st = { sessions: Array.from({ length: 20 }, (_, i) => sess({ id: `ps-${i}` })) }
  const before = JSON.stringify(st).length
  const after = JSON.stringify(stateToWire(st)).length
  assert.ok(after < before * 0.75, `裁剪后应显著变小：${before} → ${after}`)
})
