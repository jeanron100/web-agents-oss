// node --test server/redis.test.mjs
//
// 两类用例：
//  A) 降级路径（flag=0）——**必须永远绿**：Redis 关着时所有 API 返回中性值、绝不抛，主流程可回退。
//  B) 真机路径（flag=1 且隧道可达）——SET NX 互斥 / Lua CAS 只有持有者能释放 / 幂等 / 心跳 TTL / 通知去重。
//     Redis 不可达时自动跳过（CI/离线环境不红）。
//
// ⚠️ 注意：`test(name,{skip:...})` 的 skip 在**注册时**求值（早于 before()），所以 liveness 探测必须
//    放在**模块顶层 await**里先做完，不能放 before()——否则真机用例会被永远跳过（踩过）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// 从 server/.env 载入连接信息（不入库）
try {
  for (const l of fs.readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
    const m = /^(WA_REDIS_URL|WA_REDIS_PASS)=(.*)$/.exec(l.trim())
    if (m) process.env[m[1]] = m[2]
  }
} catch { /* 没有 .env 就只跑降级用例 */ }

const R = await import('./redis.js')
const P = `wa:v2:__test__:${process.pid}:`

// 顶层探测：能连上真机吗？（必须在注册测试之前完成）
let live = false
if (process.env.WA_REDIS_URL) {
  process.env.WA_REDIS_ENABLED = '1'
  const h = await R.health()
  live = h.status === 'ok'
  if (!live) console.warn(`  (跳过真机用例：Redis 不可达 — ${h.error || h.status})`)
}
const needRedis = live ? false : '需要可达的 Redis（已跳过）'

// ---------- A) 降级路径 ----------
test('降级：Redis 关闭时所有 API 返回中性值且不抛（主流程可回退）', async () => {
  process.env.WA_REDIS_ENABLED = '0'   // flags 每次调用都现读 env，故可动态切
  assert.equal(R.enabled(), false)
  assert.equal(await R.getClient(), null)
  assert.deepEqual(await R.health(), { status: 'disabled' })
  assert.equal(await R.beatAgent('srv-x'), false)
  assert.equal(await R.isAgentAlive('srv-x'), null)      // null = 不知道 → 调用方回退直接轮询
  assert.equal(await R.cacheAgentState('srv-x', { a: 1 }), false)
  assert.equal(await R.getAgentState('srv-x'), null)
  assert.equal(await R.acquireLock('wa:v2:lock:deploy:x', 10), null)
  assert.equal(await R.releaseLock('wa:v2:lock:deploy:x', 'tok'), false)
  assert.equal(await R.claimOnce('req-1'), true)          // true = 不阻断（退化为无幂等）
  assert.equal(await R.claimNotify('act-1'), null)        // null = 回退进程内内存 Set
})

// ---------- B) 真机路径 ----------
const on = () => { process.env.WA_REDIS_ENABLED = '1' }

test('真机：心跳写入后在线，键带 TTL', { skip: needRedis }, async () => {
  on()
  const sid = `${P}srv-a`
  assert.equal(await R.beatAgent(sid), true)
  assert.equal(await R.isAgentAlive(sid), true)
  const c = await R.getClient()
  const ttl = await c.ttl(R.KEY.heartbeat(sid))
  assert.ok(ttl > 0 && ttl <= R.TTL.heartbeat, `TTL 应在 (0,30]，实际 ${ttl}`)
  await c.del(R.KEY.heartbeat(sid))
  assert.equal(await R.isAgentAlive(sid), false) // 键没了 = 离线（TTL 到点等价）
})

test('真机：SET NX 互斥——同一把锁只有一个人拿到', { skip: needRedis }, async () => {
  on()
  const key = `${P}lock:deploy`
  const t1 = await R.acquireLock(key, 30)
  const t2 = await R.acquireLock(key, 30)
  assert.ok(t1, '第一个应拿到锁')
  assert.equal(t2, null, '第二个必须拿不到')
  await R.releaseLock(key, t1)
  const t3 = await R.acquireLock(key, 30) // 释放后可再抢
  assert.ok(t3)
  await R.releaseLock(key, t3)
})

test('真机：Lua CAS——只有持有者能释放，别人删不掉', { skip: needRedis }, async () => {
  on()
  const key = `${P}lock:takeover`
  const mine = await R.acquireLock(key, 30)
  assert.ok(mine)
  assert.equal(await R.releaseLock(key, 'someone-elses-token'), false, '拿错 token 不能删')
  const c = await R.getClient()
  assert.equal(await c.exists(key), 1, '锁必须还在')
  assert.equal(await R.releaseLock(key, mine), true, '持有者能删')
  assert.equal(await c.exists(key), 0)
})

test('真机：幂等——同一 requestId 只放行一次', { skip: needRedis }, async () => {
  on()
  const id = `${P}req-1`
  assert.equal(await R.claimOnce(id, 60), true, '首次放行')
  assert.equal(await R.claimOnce(id, 60), false, '重复必须被拦')
})

test('真机：通知去重——同一 actionId 只推一次（Hub 重启后不再重复推的根据）', { skip: needRedis }, async () => {
  on()
  const id = `${P}act-1`
  assert.equal(await R.claimNotify(id), true, '首次可推')
  assert.equal(await R.claimNotify(id), false, '第二次必须拦住')
})

test('真机：状态缓存写读往返 + 清理', { skip: needRedis }, async () => {
  on()
  const sid = `${P}srv-b`
  assert.equal(await R.cacheAgentState(sid, { state: 'running', n: 3 }), true)
  const got = await R.getAgentState(sid)
  assert.equal(got.state, 'running')
  assert.equal(got.n, '3') // Hash 值都是字符串

  // 收尾：清掉本次测试键 + 关连接（否则 node --test 不退出）
  // ⚠️ node-redis v6 的 scanIterator 产出的是**批次数组**（不是单个 key），且可能是空批次；
  //    直接 `del(空数组)` = DEL 无参数 → Redis 报错。必须判空。（踩过）
  const c = await R.getClient()
  for await (const keys of c.scanIterator({ MATCH: 'wa:v2:*__test__*' })) {   // 前缀可能在键中间（如 agent:state:<P>），用通配兜住
    if (Array.isArray(keys) ? keys.length : keys) await c.del(keys)
  }
  await R.close()
})
