// node --test server/session-gate.test.mjs
// AM-260718-401：会话派生并发信号量。根因是 .232 一天两次内存硬重启——
// 会话派生**无任何上限**，重启后积压重放曾「10 分钟内瞬间新增 27 个会话」，
// 每个 claude 子进程 ~120-265M，8 个就把 3.6G 的机器吃满。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionGate, createSpawnGate } from './session-gate.js'

const tick = (ms) => new Promise((r) => setTimeout(r, ms))
/** 探测一个 promise 此刻是否已敲定（用于断言"仍在排队"） */
const settled = async (p) => {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  await tick(0); await tick(0)
  return done
}

test('未达上限时立即放行，不排队', async () => {
  const g = createSessionGate({ max: 2, minIntervalMs: 0 })
  const a = await g.acquire()
  const b = await g.acquire()
  assert.equal(g.stats().active, 2)
  assert.equal(g.stats().queued, 0)
  a.release(); b.release()
})

test('★ 超上限的第 9 个请求进入【排队】而非直接派生（AM-260718-401 核心验收）', async () => {
  const g = createSessionGate({ max: 8, minIntervalMs: 0, queueWaitMs: 5_000 })
  const held = []
  for (let i = 0; i < 8; i++) held.push(await g.acquire())
  assert.equal(g.stats().active, 8, '前 8 个应全部立即派生')

  const ninth = g.acquire()
  assert.equal(await settled(ninth), false, '第 9 个必须挂起排队，不得立刻派生')
  assert.equal(g.stats().active, 8, '排队期间活跃数不得突破上限')
  assert.equal(g.stats().queued, 1, '第 9 个应记在队列里')

  held[0].release()                       // 腾出一个槽位
  const slot = await ninth                // 排队者被放行 —— 是排队不是拒绝
  assert.equal(g.stats().active, 8)
  assert.equal(g.stats().queued, 0)
  slot.release()
  for (const h of held.slice(1)) h.release()
})

test('排队按 FIFO 放行，先到先得', async () => {
  const g = createSessionGate({ max: 1, minIntervalMs: 0, queueWaitMs: 5_000 })
  const first = await g.acquire()
  const order = []
  const p1 = g.acquire().then((s) => { order.push(1); return s })
  const p2 = g.acquire().then((s) => { order.push(2); return s })
  const p3 = g.acquire().then((s) => { order.push(3); return s })

  first.release()
  ;(await p1).release()
  ;(await p2).release()
  ;(await p3).release()
  assert.deepEqual(order, [1, 2, 3])
})

test('★ 限速：即使有空槽也不瞬间连发（防重启后积压重放 27 个）', async () => {
  const g = createSessionGate({ max: 50, minIntervalMs: 60, queueWaitMs: 5_000 })
  const t0 = Date.now()
  const a = await g.acquire()   // 首个不等待
  const b = await g.acquire()   // 至少隔 60ms
  const c = await g.acquire()   // 再隔 60ms
  const spent = Date.now() - t0
  assert.ok(spent >= 110, `三次派生应被限速拉开到 ≥120ms，实测 ${spent}ms`)
  assert.equal(g.stats().active, 3, '限速只推迟派生，不丢弃请求')
  a.release(); b.release(); c.release()
})

test('排队等待超时 → 抛可识别错误，且不占用槽位', async () => {
  const g = createSessionGate({ max: 1, minIntervalMs: 0, queueWaitMs: 40 })
  const held = await g.acquire()
  await assert.rejects(() => g.acquire(), (e) => {
    assert.equal(e.code, 'QUEUE_TIMEOUT')
    assert.equal(typeof e.position, 'number')
    return true
  })
  assert.equal(g.stats().active, 1, '超时者不得留下幽灵槽位')
  assert.equal(g.stats().queued, 0, '超时者必须从队列摘除')
  held.release()
})

test('★ 超时错误里的 position 是【入队时】的排队位次，不是超时那一刻的', async () => {
  // 曾经在超时回调里现算 indexOf：前面的等待者先超时被摘掉后，后面每个都变成 0，
  // 于是三个排队者全报 pos=0 —— 调用方拿它做退避完全没意义。
  const g = createSessionGate({ max: 1, minIntervalMs: 0, queueWaitMs: 40 })
  const held = await g.acquire()
  const positions = await Promise.all([0, 1, 2].map(() =>
    g.acquire().then(() => -1, (e) => e.position)))
  assert.deepEqual(positions, [0, 1, 2], `三个排队者应分别报 0/1/2，实测 ${positions}`)
  held.release()
})

test('队列自身有上限，排满后立即拒绝（内存兜底，不能无限堆积）', async () => {
  const g = createSessionGate({ max: 1, minIntervalMs: 0, queueWaitMs: 5_000, maxQueue: 2 })
  const held = await g.acquire()
  const q1 = g.acquire(); const q2 = g.acquire()
  q1.catch(() => {}); q2.catch(() => {})
  await assert.rejects(() => g.acquire(), (e) => e.code === 'QUEUE_FULL')
  held.release()
})

test('release 幂等：重复调用不虚增槽位（否则上限会被悄悄突破）', async () => {
  const g = createSessionGate({ max: 2, minIntervalMs: 0 })
  const a = await g.acquire()
  a.release(); a.release(); a.release()
  assert.equal(g.stats().active, 0, '重复 release 只应减一次')
})

// ---- createSpawnGate：会话派生的唯一入口，槽位与会话 id 绑定，会话活着就一直攥着 ----

test('★★ 验收场景：上限 8，并发提交 12 个 → 前 8 个立即派生，第 9 个起进入排队', async () => {
  const g = createSpawnGate({ max: 8, minIntervalMs: 0, queueWaitMs: 5_000 })
  const spawned = []
  const gate = []           // 每个 create 都挂住，模拟"会话起来了还活着"
  const submit = (n) => g.spawn(() => new Promise((resolve) => {
    spawned.push(n)
    gate.push(() => resolve({ id: `ps-${n}` }))
  }))

  const all = Array.from({ length: 12 }, (_, i) => submit(i + 1))
  all.forEach((p) => p.catch(() => {}))
  await tick(10)

  assert.equal(spawned.length, 8, `只有前 8 个应真的派生，实测 ${spawned.length}`)
  assert.deepEqual(spawned, [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(g.stats().queued, 4, '第 9~12 个应在排队')
  assert.equal(g.stats().active, 8)

  gate.forEach((fn) => fn())          // 8 个都创建完成（仍存活、仍占槽）
  await tick(10)
  assert.equal(spawned.length, 8, '会话还活着 → 槽位不该释放 → 排队者仍不得派生')
  assert.equal(g.stats().queued, 4)

  g.free('ps-1')                      // 释放一个会话
  await tick(10)
  assert.equal(spawned.length, 9, '腾出槽位后，排队的第 9 个才被派生')
  assert.equal(g.stats().queued, 3)
  gate.forEach((fn) => fn())
})

test('★ 派生失败必须归还槽位（否则失败一次就永久漏一个名额，上限被慢慢磨没）', async () => {
  const g = createSpawnGate({ max: 2, minIntervalMs: 0 })
  await assert.rejects(() => g.spawn(() => { throw new Error('目录不存在') }))
  assert.equal(g.stats().active, 0, '失败的派生不得留下幽灵槽位')
  assert.equal(g.stats().held, 0)
})

test('★ 幂等返回既有会话时归还槽位（reattach 点多次不该把闸门堵死）', async () => {
  const g = createSpawnGate({ max: 2, minIntervalMs: 0 })
  await g.spawn(() => ({ id: 'ps-same' }))
  await g.spawn(() => ({ id: 'ps-same' }))   // driver 幂等：没有真的新起进程
  await g.spawn(() => ({ id: 'ps-same' }))
  assert.equal(g.stats().active, 1, '同一会话只应占一个槽位')
  assert.equal(g.stats().held, 1)
})

test('free 未知 id 是安全的空操作，不会凭空造出槽位', async () => {
  const g = createSpawnGate({ max: 1, minIntervalMs: 0 })
  await g.spawn(() => ({ id: 'ps-a' }))
  g.free('ps-nonexistent'); g.free('ps-nonexistent')
  assert.equal(g.stats().active, 1)
})

test('超时者已出队 → 后续 release 不会把槽位喂给死等待者', async () => {
  const g = createSessionGate({ max: 1, minIntervalMs: 0, queueWaitMs: 30 })
  const held = await g.acquire()
  const doomed = g.acquire()
  await assert.rejects(() => doomed, (e) => e.code === 'QUEUE_TIMEOUT')
  held.release()
  assert.equal(g.stats().active, 0, '槽位应真正归还，而不是发给已超时的等待者')
  const fresh = await g.acquire()
  assert.equal(g.stats().active, 1)
  fresh.release()
})

// ---- 可观测性（2026-07-19 事故收尾）----
// 闸门满了 45s 才回 503，而 hub 只等 15s → 用户永远只看到「超时」，看板上也看不出闸门满了。
// 两个缺口：① 闸门不报自己的 queueWaitMs，没法跟 hub 的转发超时核对漂移；
//          ② 排队是**静默**的，日志里一条都没有，事后无从复盘。
test('★ stats() 必须报出 queueWaitMs，便于跟 hub 转发超时核对漂移', () => {
  const g = createSessionGate({ max: 1, queueWaitMs: 45_000 })
  assert.equal(g.stats().queueWaitMs, 45_000)
})

test('★ createSpawnGate 也要透出 queueWaitMs（/api/state 走的是它）', () => {
  const g = createSpawnGate({ max: 1, queueWaitMs: 45_000 })
  assert.equal(g.stats().queueWaitMs, 45_000)
})

// ---- 运行时可调上限（设置页可配，2026-07-21）----
// 上限原本在 agent 启动时定死（WA_MAX_SESSIONS），改一次要重启 agent —— 而重启会杀掉
// 该机所有平台会话。于是「调个数字」的代价是「中断所有人的活」，实际上没人敢调。
// 关键语义：**调低绝不驱逐正在跑的会话**，只拦住新派生，等 active 自然降下来。
test('★ setMax 调高：立即多出槽位，排队者马上被放行', async () => {
  const g = createSessionGate({ max: 1, queueWaitMs: 2000 })
  await g.acquire()
  let granted = false
  const waiting = g.acquire().then((s) => { granted = true; return s })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(granted, false, '上限 1 时第二个必须还在排队')
  g.setMax(3)
  await waiting
  assert.equal(granted, true, '调高后排队者应立即放行')
  assert.equal(g.stats().max, 3)
})

test('★★ setMax 调低：绝不驱逐在跑的会话，只拦新派生', async () => {
  const g = createSessionGate({ max: 5, queueWaitMs: 100 })
  for (let i = 0; i < 4; i++) await g.acquire()
  g.setMax(2)                                  // 当前 4 个在跑，上限降到 2
  assert.equal(g.stats().active, 4, '已在跑的 4 个必须原样活着，一个都不能被驱逐')
  assert.equal(g.stats().max, 2)
  await assert.rejects(() => g.acquire(), /QUEUE_TIMEOUT|超时/, 'active(4) >= max(2) 时新派生必须被拦')
})

test('★ setMax 钳制到 [1,16]：防手滑把机器打爆 / 防设成 0 全锁死', () => {
  const g = createSessionGate({ max: 8 })
  g.setMax(1000); assert.equal(g.stats().max, 16, '上界钳到 16')
  g.setMax(0);    assert.equal(g.stats().max, 1, '下界钳到 1，0 会让所有派生永久失败')
  g.setMax(-5);   assert.equal(g.stats().max, 1)
  g.setMax(10);   assert.equal(g.stats().max, 10, '合法值原样生效')
})

test('★ setMax 收到非法值（NaN/字符串/undefined）→ 保持原值不变，别被脏输入锁死闸门', () => {
  const g = createSessionGate({ max: 8 })
  for (const bad of [NaN, 'abc', undefined, null, Infinity]) {
    g.setMax(bad)
    assert.equal(g.stats().max, 8, `非法值 ${String(bad)} 不该改动上限`)
  }
})

test('★ createSpawnGate 也要透出 setMax（agent 用的是它，不是内层 gate）', () => {
  const g = createSpawnGate({ max: 8 })
  assert.equal(typeof g.setMax, 'function', 'agent 侧拿不到 setMax 就等于这功能没接上')
  g.setMax(12)
  assert.equal(g.stats().max, 12)
  g.setMax(999)
  assert.equal(g.stats().max, 16, '钳制同样要生效')
})
