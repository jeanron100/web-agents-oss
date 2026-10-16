// server/redis.js — Redis 协调层（db-redis-mongo-phase1 / P1）
//
// 部署：Redis 在 189.4(10.7.0.17)，只绑 127.0.0.1；Hub(.232) 经 systemd SSH 隧道 127.0.0.1:16379 访问。
// 见 docs/database_ops.md §3 与 §10 变更记录。
//
// 三条铁律（违反任何一条都会出事）：
// ① **Redis 非权威源**。它丢了，心跳/状态由下一轮轮询重建、幂等/去重窗口重新累积，无长期数据永久丢失。
// ② **一切降级静默**：Redis 不可用时所有 API 返回「中性值」（null/false），调用方**必须**能回退到旧行为，
//    绝不让 Redis 故障拖垮 Hub 主流程（会话/审批/终端一律不受影响）。
// ③ **接管锁只做乐观加速**：真正防「双写 JSONL 损坏」的安全闸恒为 agent 侧活体判定；锁没了要退回它，
//    绝不因为"拿到锁"就跳过 agent 侧检查（spec: realtime-coordination）。

import crypto from 'node:crypto'
import { flags } from './flags.js'

let client = null
let connecting = null
let lastError = null

export const KEY = {
  heartbeat: (serverId) => `wa:v2:agent:heartbeat:${serverId}`,
  state: (serverId) => `wa:v2:agent:state:${serverId}`,
  lease: (sessionId) => `wa:v2:session:lease:${sessionId}`,
  lockDeploy: (serverId) => `wa:v2:lock:deploy:${serverId}`,
  lockTakeover: (sessionId) => `wa:v2:lock:takeover:${sessionId}`,
  idem: (requestId) => `wa:v2:idem:${requestId}`,
  notify: (actionId) => `wa:v2:notify:${actionId}`,
}

export const TTL = { heartbeat: 30, state: 60, lease: 60, lockDeploy: 300, lockTakeover: 60, idem: 86_400, notify: 86_400 }

export function enabled() { return flags.redisEnabled() }

/** 懒连接：仅在启用时动态 import 并连接；失败返回 null（静默降级）。 */
/** 单轮连接的重试上限。超过就让 connect() 失败收场，而不是无限期挂着。 */
const RECONNECT_GIVEUP = Number(process.env.WA_REDIS_RECONNECT_GIVEUP) || 6

export async function getClient() {
  if (!flags.redisEnabled()) return null
  if (client?.isOpen) return client
  if (connecting) return connecting
  connecting = (async () => {
    try {
      const { createClient } = await import('redis')
      const c = createClient({
        url: process.env.WA_REDIS_URL || 'redis://127.0.0.1:16379',
        password: process.env.WA_REDIS_PASS || undefined,
        socket: {
          connectTimeout: 3000,
          // ⚠️ **必须有放弃条件**（2026-09-08 实测：测试套件卡 600s 不退）。
          //   原实现永远返回一个延迟 = 永不放弃 ⇒ `connect()` 的 promise 永不 settle，
          //   调用方（health / hub 的两个 HTTP 端点 / alerts 告警循环）跟着一起挂死，
          //   而且定时器让进程都退不出去。`connectTimeout` 只管单次尝试，管不住整体。
          // ★ 返回 Error ⇒ 本轮连接失败并停表。**自愈能力不受影响**：所有调用都经
          //   `safe()` → `getClient()`，下一次调用会新建客户端重试。
          reconnectStrategy: (n) => (n > RECONNECT_GIVEUP
            ? new Error(`Redis 连接重试 ${n} 次仍失败，本轮放弃（下次调用会重试）`)
            : Math.min(n * 200, 3000)),
        },
      })
      c.on('error', (e) => { lastError = e }) // 必须挂，否则连接错误会抛成未捕获异常
      await c.connect()
      client = c
      lastError = null
      return client
    } catch (e) {
      lastError = e; client = null; return null
    } finally { connecting = null }
  })()
  return connecting
}

/** 所有 Redis 调用的统一包裹：不可用/出错一律返回 fallback，绝不抛。 */
async function safe(fn, fallback = null) {
  try {
    const c = await getClient()
    if (!c) return fallback
    return await fn(c)
  } catch (e) { lastError = e; return fallback }
}

// ---------- 心跳与在线判定（TTL 天然表达，零定时器） ----------

/** Hub 每次轮询完某 agent 调用；心跳 30s 后自动消失 = 离线。 */
export async function beatAgent(serverId) {
  return safe(async (c) => { await c.set(KEY.heartbeat(serverId), String(Date.now()), { EX: TTL.heartbeat }); return true }, false)
}

/** 该 agent 是否在线（心跳键还在）。Redis 不可用→null（调用方回退直接轮询判定）。 */
export async function isAgentAlive(serverId) {
  return safe(async (c) => (await c.exists(KEY.heartbeat(serverId))) === 1, null)
}

/** 缓存 agent 状态摘要（Hash，60s）。值必须是扁平字符串。 */
export async function cacheAgentState(serverId, obj) {
  return safe(async (c) => {
    const flat = {}
    for (const [k, v] of Object.entries(obj || {})) flat[k] = typeof v === 'string' ? v : JSON.stringify(v)
    if (!Object.keys(flat).length) return false
    await c.hSet(KEY.state(serverId), flat)
    await c.expire(KEY.state(serverId), TTL.state)
    return true
  }, false)
}

export async function getAgentState(serverId) {
  return safe(async (c) => {
    const h = await c.hGetAll(KEY.state(serverId))
    return h && Object.keys(h).length ? h : null
  }, null)
}

// ---------- 原子锁/租约：SET NX EX + Lua CAS 安全释放 ----------

// 释放锁必须「验证是自己的再删」，否则会误删别人的锁（你的锁过期了→别人拿到新锁→你把它删了）。
// Redis 单命令做不到「检查+删除」原子，故用 Lua。
const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`

/**
 * 加锁。成功返回 token（释放时必须带回），失败/不可用返回 null。
 * ⚠️ 返回 null 有两种含义：「别人持有」或「Redis 不可用」——调用方**不能**把 null 当作"可以安全跳过检查"。
 */
export async function acquireLock(key, ttlSec) {
  const token = crypto.randomBytes(16).toString('hex')
  return safe(async (c) => {
    const ok = await c.set(key, token, { NX: true, EX: ttlSec })
    return ok === 'OK' ? token : null
  }, null)
}

/** 释放锁：只有持有同一 token 的人才能删。返回是否真的删掉了。 */
export async function releaseLock(key, token) {
  if (!token) return false
  return safe(async (c) => (await c.eval(RELEASE_LUA, { keys: [key], arguments: [token] })) === 1, false)
}

// ---------- 幂等：同一 requestId 只执行一次 ----------

/** 首次见到该 requestId → true（可执行）；已见过 → false（跳过）。Redis 不可用→true（不阻断，退化为无幂等）。 */
export async function claimOnce(requestId, ttlSec = TTL.idem) {
  if (!requestId) return true
  return safe(async (c) => (await c.set(KEY.idem(requestId), '1', { NX: true, EX: ttlSec })) === 'OK', true)
}

// ---------- 通知去重（跨 Hub 重启保持） ----------

/** 该待办是否「尚未推送过」→ true 表示现在可以推。Redis 不可用→null（调用方回退进程内内存 Set）。 */
export async function claimNotify(actionId) {
  if (!actionId) return null
  return safe(async (c) => (await c.set(KEY.notify(actionId), '1', { NX: true, EX: TTL.notify })) === 'OK', null)
}

// ---------- 健康 ----------

/** 期限包装。⚠️ 见 health() 里的说明：不套期限的探活函数会把调用方一起挂死。 */
const HEALTH_DEADLINE_MS = Number(process.env.WA_REDIS_HEALTH_DEADLINE_MS) || 5000
function withDeadline(p, ms, fallback) {
  let t
  return Promise.race([
    Promise.resolve(p).then((v) => { clearTimeout(t); return v }, (e) => { clearTimeout(t); throw e }),
    new Promise((res) => { t = setTimeout(() => res(fallback), ms); t.unref?.() }),
  ])
}

export async function health() {
  if (!flags.redisEnabled()) return { status: 'disabled' }
  try {
    // ⚠️ **连接必须套期限**（2026-09-08 实测挂 600s）：node-redis 的 reconnectStrategy
    //   永远返回延迟、从不放弃 ⇒ 连不上时 `getClient()` 的 promise 永不 settle，
    //   而 `connectTimeout` 只管单次尝试。health() 长在 hub 的 HTTP 处理器与
    //   alerts 的告警循环上 ⇒ 它挂住 = 端点挂住 + **告警循环整个停摆**。
    //   ★ 探活函数能永久挂起，比它给出错误答案更糟——错误答案至少会被看见。
    const HUNG = Symbol('hung')
    const c = await withDeadline(getClient(), HEALTH_DEADLINE_MS, HUNG)
    if (c === HUNG) return { status: 'error', error: `连接超过 ${HEALTH_DEADLINE_MS}ms（链路不可达）` }
    if (!c) return { status: 'error', error: lastError?.message || '未连接' }
    const t0 = Date.now()
    await c.ping()
    return { status: 'ok', latencyMs: Date.now() - t0 }
  } catch (e) { return { status: 'error', error: e?.message || String(e) } }
}

export async function close() {
  try { if (client?.isOpen) await client.quit() } catch { /* 尽力而为 */ }
  client = null
}

/** 内存用量（告警用）：{ used, maxmemory }。取不到返回 null（调用方跳过该项，不假装正常）。 */
export async function memory() {
  return safe(async (c) => {
    const info = await c.info('memory')
    const g = (k) => {
      const m = new RegExp(`^${k}:(\\d+)`, 'm').exec(info)
      return m ? Number(m[1]) : 0
    }
    return { used: g('used_memory'), maxmemory: g('maxmemory') }
  }, null)
}
