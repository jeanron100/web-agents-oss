// server/mongo.js — MongoDB 历史投影连接层（db-redis-mongo-phase1 / P2）
//
// 部署：MongoDB 5.0 在 81.70(webagents-mongo 容器)，只绑 127.0.0.1；Hub(.232) 经 systemd SSH 隧道
// (127.0.0.1:27018，SSH 20022) 访问。见 docs/database_ops.md §4 与 §10 变更记录。
//
// 铁律：
// ① **Mongo 是投影、不是权威源**——内容全部可从 JSONL 重新投影。挂了 → 历史页回退扫 JSONL。
// ② **绝不在交互热路径上**：`/api/state`、会话/审批/终端一律不查 Mongo（保住 P95）。
// ③ 写失败**不抛、不阻塞**——落本地 spool，恢复后按 eventKey 幂等重放。

import os from 'node:os'
import { flags } from './flags.js'

let clientPromise = null
let client = null
let db = null
let lastError = null

// 2026-08-02：Mongo 已从 81.70(公网) **迁到 189.4**，与 hub/redis 同机 ⇒ 本地 127.0.0.1 直连，
// 隧道(web-agents-tunnel-mongo)已停用并 disable。迁移前它是五条隧道里唯一走公网的一条，
// 实测 minrtt 从 58ms 一路劣化到 336ms（同机内网隧道全是亚毫秒），拥塞时 ping 2.1s、查询 4.8s，
// 还把 spool 顶到 102MB 触发丢弃。迁移后：ping 1~2ms、hub 侧 health latency 16ms。
// · 不再需要 compressors=zlib（本地连接压缩纯属白烧 CPU）
// · ⚠️ mongod 必须**硬限内存**：189.4 是控制面所在机（hub+agent+终端会话都在上面），
//   容器 --memory=700m + --wiredTigerCacheSizeGB 0.25。MongoDB 默认缓存会吃 (RAM-1G)/2≈1.3GB，
//   在这台 3.6G 的机器上足以挤掉 hub —— 那就是「管控台挂了就再也管不了」的死循环。
//   实测稳定占用 305MB/700MB。
// · 旧库(81.70 容器)**暂不删**，留作回滚：把 URI 改回 127.0.0.1:27018 并 enable 隧道即可。
const DEFAULT_URI = 'mongodb://127.0.0.1:27017/webagents_v2?serverSelectionTimeoutMS=5000&maxPoolSize=10'

export function enabled() { return flags.mongoEnabled() }

// 单次 Mongo 操作的期限。2026-08-01：跨境隧道拥塞时 `d.command({ping:1})` **没有任何超时**
// （serverSelectionTimeoutMS 只管建连、不管已建连后的命令），于是 alerts.tick() 的 collect()
// 无限期挂在 health() 上 ⇒ 永远走不到 advance() ⇒ **告警再也不会恢复**（观察到 5 条
// agent.stale 在心跳明明正常的情况下一直挂着），/api/v2/stats 也一并返回空。
const DEADLINE_MS = Number(process.env.WA_MONGO_DEADLINE_MS) || 3000

/** 给 promise 套期限：超时/出错都回退到 fallback，**永不抛、永不挂**。迟到的结果不得改写已返回值。 */
export function withDeadline(p, ms = DEADLINE_MS, fallback = null) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => done(fallback), Math.max(0, ms))
    Promise.resolve(p).then(done, (e) => { lastError = e; done(fallback) })
  })
}

/** 懒连接：仅在启用时动态 import 并连接；失败返回 null（静默降级）。 */
export async function getDb() {
  if (!flags.mongoEnabled()) return null
  if (db) return db
  if (clientPromise) return clientPromise
  clientPromise = (async () => {
    try {
      const { MongoClient } = await import('mongodb')
      const uri = process.env.WA_MONGO_URI || DEFAULT_URI
      const c = new MongoClient(uri, {
        // 单节点：w:1=主节点确认即返回；journal=确认前先落 journal（掉电不丢已确认写）。绝不用 w:0（静默丢）。
        writeConcern: { w: 1, journal: true },
      })
      await c.connect()
      client = c
      db = c.db(process.env.WA_MONGO_DB || 'webagents_v2')
      lastError = null
      return db
    } catch (e) {
      lastError = e; db = null; return null
    } finally { clientPromise = null }
  })()
  return clientPromise
}

/** 统一包裹：不可用/出错一律返回 fallback，绝不抛。 */
async function safe(fn, fallback = null) {
  try {
    const d = await getDb()
    if (!d) return fallback
    return await fn(d)
  } catch (e) { lastError = e; return fallback }
}

// ---------- 索引初始化（幂等；启动时跑一次） ----------
//
// 新手关键：**没有索引 = 全集合扫描**。下面每条索引都注明「它服务哪个查询」，不然日后没人敢删。
// 复合索引字段顺序遵循 ESR：Equality(精确匹配) → Sort(排序) → Range(范围)。

const DAY = 86_400

export async function ensureIndexes() {
  return safe(async (d) => {
    // execution_events：事件时间线（脱敏 payload）
    await d.collection('execution_events').createIndexes([
      { key: { eventKey: 1 }, name: 'uniq_eventKey', unique: true },       // 幂等去重（最重要，upsert 靠它）
      { key: { sessionId: 1, occurredAt: 1 }, name: 'session_timeline' },  // "某会话按时间正序的时间线"(ESR: E=sessionId, S=occurredAt)
      { key: { serverId: 1, occurredAt: -1 }, name: 'server_recent' },     // "这台服务器最近的事件"
      { key: { type: 1, occurredAt: -1 }, name: 'type_recent' },           // "最近所有 tool.failed"
      { key: { project: 1, occurredAt: -1 }, name: 'project_recent' },     // "这个项目最近的事件"
      { key: { ingestedAt: 1 }, name: 'ttl_180d', expireAfterSeconds: 180 * DAY }, // 180 天自动过期
    ])
    // execution_runs：每会话一条概要（**长期保留，绝不建 TTL**）
    await d.collection('execution_runs').createIndexes([
      { key: { sessionId: 1 }, name: 'uniq_sessionId', unique: true },
      { key: { serverId: 1, lastActiveAt: -1 }, name: 'server_recent' },
      { key: { project: 1, lastActiveAt: -1 }, name: 'project_recent' },
      { key: { status: 1, lastActiveAt: -1 }, name: 'status_recent' },     // "最近失败/运行中的会话"
      { key: { engine: 1, createdAt: -1 }, name: 'engine_recent' },
    ])
    // approvals：审批审计（365 天）
    await d.collection('approvals').createIndexes([
      { key: { actionId: 1 }, name: 'uniq_actionId', unique: true },
      { key: { sessionId: 1, createdAt: -1 }, name: 'session_recent' },
      { key: { createdAt: 1 }, name: 'ttl_365d', expireAfterSeconds: 365 * DAY },
    ])
    // agent_status_events：只存状态"跳变"，不存每次心跳（心跳在 Redis）
    await d.collection('agent_status_events').createIndexes([
      { key: { serverId: 1, ts: -1 }, name: 'server_recent' },
      { key: { ts: 1 }, name: 'ttl_180d', expireAfterSeconds: 180 * DAY },
    ])
    return true
  }, false)
}

export async function health() {
  if (!flags.mongoEnabled()) return { status: 'disabled' }
  try {
    // ⚠️ **连接这一步也必须套期限**（2026-09-08 实测）：原先只给下面的 ping 套了，
    //   而真正会永久挂起的是 `getDb()` —— 驱动连不上时无限重连，promise 永不 settle。
    //   同一条纪律只落实了一半，等于没落实：health() 长在 hub 的 HTTP 处理器和
    //   alerts 的告警循环上，它挂住 = 端点挂住 + **告警循环整个停摆**。
    const HUNG = Symbol('hung')
    const d = await withDeadline(getDb(), DEADLINE_MS, HUNG)
    if (d === HUNG) return { status: 'error', error: `连接超过 ${DEADLINE_MS}ms（链路不可达）` }
    if (!d) return { status: 'error', error: lastError?.message || '未连接' }
    const t0 = Date.now()
    // ⚠️ 必须套期限：命令级挂起会把整个看门狗卡死（见 withDeadline 上方注释）
    const r = await withDeadline(d.command({ ping: 1 }), DEADLINE_MS, null)
    if (!r) return { status: 'error', error: `ping 超过 ${DEADLINE_MS}ms（链路拥塞）` }
    return { status: 'ok', latencyMs: Date.now() - t0 }
  } catch (e) { return { status: 'error', error: e?.message || String(e) } }
}

/**
 * 关闭连接池。**测试必须调**：驱动的池会一直挂着 socket，进程永不退出——
 * `node --test server/mongo.test.mjs` 曾经用例全过却卡死在退出码 124，
 * 活动句柄一 dump 就是 `HANDLES: Socket,Socket,Socket,Socket`（无人关闭的 Mongo 池）。
 * 生产里 hub 是长驻进程，不需要主动调；但没有它，任何想干净退出的进程都会被吊住。
 */
export async function close() {
  const c = client
  client = null; db = null; clientPromise = null
  if (c) { try { await c.close() } catch { /* 关不掉也不能抛 */ } }
}

/** 集合句柄（repository 用）。不可用返回 null。 */
export async function coll(name) {
  return safe(async (d) => d.collection(name), null)
}

export { safe as _safe }

/**
 * 告警文案里的主机标签。**必须从实际连接推导，别硬编码**——
 * 2026-08-02 Mongo 从 81.70 迁到 189.4，而 alerts.js 里写死的「（81.70）」没人改，
 * 于是告警继续报一台**早已不承载数据库**的机器。数字是真的、名字是假的，
 * 比纯粹的假告警更坑：它会把人支到错误的机器上去查。
 */
export function hostLabel() {
  const uri = process.env.WA_MONGO_URI || DEFAULT_URI
  try {
    const h = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).hostname
    if (h && h !== '127.0.0.1' && h !== 'localhost') return h
  } catch { /* 连接串畸形则退回本机名 */ }
  return os.hostname() // 本地直连：真相是 hub 所在的这台机
}

/** Mongo 所在文件系统的使用率（告警用）：dbStats 会带 fsUsedSize/fsTotalSize。取不到返回 null。 */
export async function diskUsage() {
  return safe(async (d) => {
    // 用 command({dbStats:1}) 而非 d.stats()：两者在驱动 v7.5 上都可用（我一度误判
    // 「v6 已移除 d.stats」并据此改写——那个结论来自一次坏掉的测量，见下），
    // command 形式更贴近协议、不依赖驱动的便捷方法是否被弃用。
    // ⚠️ 排障教训：测这个函数时若用 `set -a; . ./.env` 加载环境，**连接串会被 shell 截断**
    // ——URI 里的 `&`（?serverSelectionTimeoutMS=5000&maxPoolSize=10）被当成后台执行符，
    // 凭据丢失 ⇒ dbStats 报 "requires authentication" ⇒ 返回 null ⇒ 看着像代码坏了。
    // 正确姿势：先 `await import('./env.js')` 再 import 本模块。
    const s = await withDeadline(d.command({ dbStats: 1 }), DEADLINE_MS, null)
    if (!s) return null
    if (!s?.fsTotalSize) return null
    return {
      usedBytes: s.fsUsedSize,
      totalBytes: s.fsTotalSize,
      pct: Math.round((s.fsUsedSize / s.fsTotalSize) * 100),
    }
  }, null)
}
