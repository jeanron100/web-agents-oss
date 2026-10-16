import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activePlatformSessions, createActivityCounter, createMaintenanceLease, restartBlockers } from './maintenance.js'

test('independent persisted Codex stays running without blocking restart; queue and other engines still block', () => {
  const daemon = { id: 'daemon', engine: 'codex', origin: 'platform', state: 'running', inflight: true, restartSafe: true }
  const sessions = [daemon,
    {...daemon,id:'queued',queuedMessages:1},
    {...daemon,id:'owned',restartSafe:false},
    {...daemon,id:'kimi',engine:'kimi'},
    {...daemon,id:'unknown',restartSafe:undefined},
  ]
  assert.deepEqual(restartBlockers({sessionLists:[sessions]}).map(s=>s.id),['queued','owned','kimi','unknown'])
  assert.equal(daemon.inflight,true)
})

test('activePlatformSessions only returns work that restart would interrupt', () => {
  const active = activePlatformSessions([
    { id: 'a', origin: 'platform', state: 'running' },
    { id: 'b', origin: 'platform', state: 'idle' },
    { id: 'c', origin: 'shadow', state: 'running' },
    { id: 'd', origin: 'platform', state: 'waiting_approval' },
  ])
  assert.deepEqual(active.map((s) => s.id), ['a', 'd'])
})

test('inflight 布尔优先于粗粒度 state（CR-006 P1-b）', () => {
  const active = activePlatformSessions([
    // codex 回合后 review 待办：state 显示 waiting_approval 但 inflight=false → 不该阻塞
    { id: 'review-todo', origin: 'platform', state: 'waiting_approval', inflight: false },
    // 真在飞回合：inflight=true → 阻塞（哪怕 state 是别的）
    { id: 'live-turn', origin: 'platform', state: 'running', inflight: true },
    // 分离态：state=running 但 inflight=false（原生进程独立，agent 重启不截断）→ 不阻塞
    { id: 'detached', origin: 'platform', state: 'running', inflight: false },
    // 无 inflight 字段（老 agent）→ 回退按 state
    { id: 'legacy-active', origin: 'platform', state: 'waiting_input' },
  ])
  assert.deepEqual(active.map((s) => s.id), ['live-turn', 'legacy-active'])
})

test('restartBlockers 豁免"发起本次重启的会话"，否则排空等自己→死锁（CR-008）', () => {
  const self = { id: 'ps-self', origin: 'platform', state: 'running', inflight: true }
  const other = { id: 'ps-other', origin: 'platform', state: 'running', inflight: true }
  // 不豁免：两个都算 blocker（这正是 232 上死等 120s 的成因）
  assert.deepEqual(restartBlockers({ sessionLists: [[self, other]] }).map((b) => b.id), ['ps-self', 'ps-other'])
  // 豁免自己：只剩真正该等的别人
  assert.deepEqual(
    restartBlockers({ sessionLists: [[self, other]], excludeIds: new Set(['ps-self']) }).map((b) => b.id),
    ['ps-other'],
  )
  // 只有自己在跑 → 无 blocker → 可立即干净退出
  assert.deepEqual(restartBlockers({ sessionLists: [[self]], excludeIds: new Set(['ps-self']) }), [])
  // 豁免不该掩盖在途写请求/webshell
  assert.deepEqual(
    restartBlockers({ sessionLists: [[self]], excludeIds: new Set(['ps-self']), mutationCount: 1 }).map((b) => b.id),
    ['inflight-mutation'],
  )
})

test('maintenance lease locks atomically when idle and expires', () => {
  let ts = 100
  const lease = createMaintenanceLease({ ttlMs: 50, now: () => ts })
  assert.deepEqual(lease.enter(() => []), { ok: true, active: [], until: 150 })
  assert.equal(lease.isActive(), true)
  ts = 151
  assert.equal(lease.isActive(), false)
})

test('maintenance lease unlocks immediately when active work exists', () => {
  const lease = createMaintenanceLease({ now: () => 100 })
  const result = lease.enter(() => [{ id: 'busy' }])
  assert.equal(result.ok, false)
  assert.equal(lease.isActive(), false)
})

test('activity counter spans awaits and release is idempotent', () => {
  const counter = createActivityCounter()
  const releaseA = counter.begin()
  const releaseB = counter.begin()
  assert.equal(counter.count(), 2)
  releaseA(); releaseA()
  assert.equal(counter.count(), 1)
  releaseB()
  assert.equal(counter.count(), 0)
})

test('lease refuses while a previously accepted mutation is still in flight', () => {
  const counter = createActivityCounter()
  const lease = createMaintenanceLease({ now: () => 100 })
  const release = counter.begin()
  assert.equal(lease.enter(() => counter.count() ? [{ id: 'inflight' }] : []).ok, false)
  release()
  assert.equal(lease.enter(() => counter.count() ? [{ id: 'inflight' }] : []).ok, true)
})

test('restart blockers include live sessions, accepted mutations and detached exec children', () => {
  const blockers = restartBlockers({
    sessionLists: [[{ id: 'session', origin: 'platform', state: 'running' }]],
    mutationCount: 2,
    execCount: 1,
  })
  assert.deepEqual(blockers.map((x) => x.id), ['session', 'inflight-mutation', 'webshell-exec'])
})
