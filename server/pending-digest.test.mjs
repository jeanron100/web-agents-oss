// node --test server/pending-digest.test.mjs
//
// 纯函数单测：buildPendingDigest 把 buildState() 已经跨节点聚合好的 {sessions, pendingActions}
// 整理成「总工待处理」摘要——按 kind 分组、年龄倒序（最老最先看见）、超时(overdue)标记。
// 不发网络请求、不读文件、不依赖 buildState() 本身，用手搭的 state 夹具即可覆盖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPendingDigest } from './pending-digest.js'

const NOW = 1_700_000_000_000 // 固定基准时刻，年龄计算可复现

const sess = (over = {}) => ({
  id: 'ps-1', serverId: 'srv-178-232', project: 'web_agents', cwd: '/data/web_agents', ...over,
})
const act = (over = {}) => ({
  id: 'act-1', sessionId: 'ps-1', serverId: 'srv-178-232', kind: 'question',
  title: 't', detail: 'd', createdAt: NOW - 5 * 60_000, status: 'pending', ...over,
})

test('空积压：total=0，groups/byKind 皆空对象，oldestMin=0', () => {
  const out = buildPendingDigest({ sessions: [], pendingActions: [] }, { now: NOW })
  assert.equal(out.total, 0)
  assert.equal(out.overdueCount, 0)
  assert.equal(out.oldestMin, 0)
  assert.deepEqual(out.groups, {})
  assert.deepEqual(out.byKind, {})
  assert.deepEqual(out.items, [])
})

test('每条至少带 id/kind/ageMin/sessionId/cwd/title/detail（跨会话 join 出 cwd/project）', () => {
  const out = buildPendingDigest(
    { sessions: [sess()], pendingActions: [act({ createdAt: NOW - 616 * 60_000 })] },
    { now: NOW },
  )
  const [item] = out.items
  assert.equal(item.id, 'act-1')
  assert.equal(item.kind, 'question')
  assert.equal(item.ageMin, 616)
  assert.equal(item.sessionId, 'ps-1')
  assert.equal(item.serverId, 'srv-178-232')
  assert.equal(item.cwd, '/data/web_agents')
  assert.equal(item.project, 'web_agents')
  assert.equal(item.title, 't')
  assert.equal(item.detail, 'd')
})

test('★ 复现实测积压：616 分钟的 question 必须标 overdue（默认阈值 30min）', () => {
  const out = buildPendingDigest(
    { sessions: [sess()], pendingActions: [act({ kind: 'question', createdAt: NOW - 616 * 60_000 })] },
    { now: NOW },
  )
  assert.equal(out.items[0].ageMin, 616)
  assert.equal(out.items[0].overdue, true)
  assert.equal(out.overdueCount, 1)
  assert.equal(out.oldestMin, 616)
})

test('阈值边界：ageMin 恰好等于 thresholdMin 判定为 overdue（>=，不是 >）', () => {
  const out = buildPendingDigest(
    { sessions: [sess()], pendingActions: [act({ createdAt: NOW - 30 * 60_000 })] },
    { now: NOW, thresholdMin: 30 },
  )
  assert.equal(out.items[0].ageMin, 30)
  assert.equal(out.items[0].overdue, true)
})

test('阈值可配：thresholdMin=45 时，46 分钟的 approval overdue，44 分钟的不 overdue', () => {
  const out = buildPendingDigest(
    {
      sessions: [sess()],
      pendingActions: [
        act({ id: 'act-a', kind: 'approval', createdAt: NOW - 46 * 60_000 }),
        act({ id: 'act-b', kind: 'approval', createdAt: NOW - 44 * 60_000 }),
      ],
    },
    { now: NOW, thresholdMin: 45 },
  )
  const byId = Object.fromEntries(out.items.map((i) => [i.id, i]))
  assert.equal(byId['act-a'].overdue, true)
  assert.equal(byId['act-b'].overdue, false)
})

test('非法/缺省 thresholdMin（0、负数、NaN、未传）一律回退默认 30', () => {
  for (const bad of [0, -5, NaN, undefined]) {
    const out = buildPendingDigest({ sessions: [], pendingActions: [] }, { now: NOW, thresholdMin: bad })
    assert.equal(out.thresholdMin, 30, `thresholdMin=${bad} 应回退 30`)
  }
})

test('按 kind 分组，组内按年龄倒序（最老的排最前）', () => {
  const out = buildPendingDigest(
    {
      sessions: [sess()],
      pendingActions: [
        act({ id: 'r-old', kind: 'review', createdAt: NOW - 100 * 60_000 }),
        act({ id: 'r-new', kind: 'review', createdAt: NOW - 10 * 60_000 }),
        act({ id: 'q-1', kind: 'question', createdAt: NOW - 616 * 60_000 }),
        act({ id: 'a-1', kind: 'approval', createdAt: NOW - 46 * 60_000 }),
        act({ id: 'p-1', kind: 'plan', createdAt: NOW - 5 * 60_000 }),
      ],
    },
    { now: NOW },
  )
  assert.deepEqual(Object.keys(out.groups), ['question', 'review', 'approval', 'plan'])
  assert.deepEqual(out.groups.review.map((i) => i.id), ['r-old', 'r-new'])
  assert.deepEqual(out.byKind, { question: 1, review: 2, approval: 1, plan: 1 })
})

test('跨节点：不同 serverId 的待办都进同一份聚合结果（这是本任务的核心诉求）', () => {
  const out = buildPendingDigest(
    {
      sessions: [sess({ id: 'ps-a', serverId: 'srv-178-232' }), sess({ id: 'ps-b', serverId: 'srv-177-188' })],
      pendingActions: [
        act({ id: 'act-a', sessionId: 'ps-a', serverId: 'srv-178-232' }),
        act({ id: 'act-b', sessionId: 'ps-b', serverId: 'srv-177-188' }),
      ],
    },
    { now: NOW },
  )
  assert.equal(out.total, 2)
  const servers = new Set(out.items.map((i) => i.serverId))
  assert.deepEqual([...servers].sort(), ['srv-177-188', 'srv-178-232'])
})

test('顶层 items 跨 kind 按年龄倒序排列（总工一眼看最老的在最上面）', () => {
  const out = buildPendingDigest(
    {
      sessions: [sess()],
      pendingActions: [
        act({ id: 'a-1', kind: 'approval', createdAt: NOW - 46 * 60_000 }),
        act({ id: 'q-1', kind: 'question', createdAt: NOW - 616 * 60_000 }),
        act({ id: 'r-1', kind: 'review', createdAt: NOW - 90 * 60_000 }),
      ],
    },
    { now: NOW },
  )
  assert.deepEqual(out.items.map((i) => i.id), ['q-1', 'r-1', 'a-1'])
})

test('会话查无对应（sess 未找到，如影子会话被清理）→ cwd/project 为 null，不抛异常', () => {
  const out = buildPendingDigest(
    { sessions: [], pendingActions: [act({ sessionId: 'ps-gone' })] },
    { now: NOW },
  )
  assert.equal(out.items[0].cwd, null)
  assert.equal(out.items[0].project, null)
  assert.equal(out.items[0].sessionId, 'ps-gone')
})

test('detail 截断到 300 字（待办摘要，别把整段计划/审批上下文糊一脸）', () => {
  const long = 'x'.repeat(500)
  const out = buildPendingDigest(
    { sessions: [sess()], pendingActions: [act({ detail: long })] },
    { now: NOW },
  )
  assert.equal(out.items[0].detail.length, 300)
})

test('未知 kind 不丢数据：仍进 items/groups，排在已知四类之后（按字母序）', () => {
  const out = buildPendingDigest(
    { sessions: [sess()], pendingActions: [act({ id: 'z-1', kind: 'zzz-mystery' })] },
    { now: NOW },
  )
  assert.equal(out.total, 1)
  assert.deepEqual(out.groups['zzz-mystery'].map((i) => i.id), ['z-1'])
})
