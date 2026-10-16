// server/repositories/run-repository.js — 会话概要投影（execution_runs）+ agent 状态跳变（agent_status_events）
//
// 为什么需要 execution_runs：会话的「存在过」这件事，今天只活在那台 agent 的 JSONL 与内存里——
// agent 一重启、文件一老化，会话就从看板上蒸发了。runs 是**跨服务器、跨重启持久**的会话账本：
// 哪台机、哪个项目、什么引擎、跑了多久、烧了多少、最后什么状态。**长期保留、绝不建 TTL**
// （每会话一条，总量受会话数约束，不是按事件量涨）。
//
// 为什么需要 agent_status_events：只存状态**跳变**，不存每次心跳（心跳在 Redis，TTL 自动过期）。
// 最关键的一类跳变是 **agent 重启**——那一刻它进程内的平台会话全部随 cgroup 被 SIGKILL，
// 正在跑的回合被拦腰截断。这是本项目最痛的一类事故，此前**完全没有记录**：出事后你既不知道
// 什么时候重启的，也不知道当时有哪些会话被杀。现在每次重启都留一条，带上"被波及的会话名单"。

import * as mongo from '../mongo.js'
import { restartDeleteFilter } from '../incident-filter.js' // 删除条件（纯函数+单测）：破坏性操作不内联写

const RUNS = 'execution_runs'
const STATUS = 'agent_status_events'

const ACTIVE = new Set(['running', 'waiting_approval', 'waiting_input'])

/** 会话 → runs 文档（只留结构化字段，不搬正文；summary 已是 agent 侧的短摘要） */
function toRun(s) {
  return {
    sessionId: s.id,
    serverId: s.serverId ?? null,
    project: s.project ?? null,
    engine: s.engine ?? null,
    realSessionId: s.realSessionId ?? null,
    origin: s.origin ?? null,
    status: s.state ?? null,
    cwd: s.cwd ?? null,
    model: s.model ?? null,
    createdAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
    lastActiveAt: s.lastActiveAt ? new Date(s.lastActiveAt).toISOString() : null,
    tokens: Number(s.tokens) || 0,
    cost: Number(s.cost) || 0,
    title: typeof s.summary === 'string' ? s.summary.slice(0, 120) : null,
  }
}

/** 幂等 upsert 会话概要。createdAt 只在首次写入时落（$setOnInsert），后续只更新可变字段。 */
export async function upsertRuns(sessions) {
  const list = (sessions || []).filter((s) => s?.id)
  if (!list.length) return { written: 0 }
  const c = await mongo.coll(RUNS)
  if (!c) return { written: 0 }          // Mongo 关着/不可达 → 静默降级，主链路不受影响
  try {
    const ops = list.map((s) => {
      const { sessionId, createdAt, ...mutable } = toRun(s)
      return {
        updateOne: {
          filter: { sessionId },
          update: {
            $set: { ...mutable, schemaVersion: 1 },
            $setOnInsert: { sessionId, createdAt, firstSeenAt: new Date().toISOString() },
          },
          upsert: true,
        },
      }
    })
    const r = await c.bulkWrite(ops, { ordered: false })
    return { written: (r.upsertedCount || 0) + (r.modifiedCount || 0) }
  } catch { return { written: 0 } }
}

/**
 * 记录 agent 重启：**必须带上被波及的会话名单**。
 * 事后复盘时"几点重启的"只解决一半问题，另一半是"当时谁在跑、谁被杀了"——
 * 那份名单只有重启**之前**那一拍轮询里有，事后再也拿不到。
 */
export async function recordAgentRestart({ serverId, prevBootAt, bootAt, activeSessions }) {
  const c = await mongo.coll(STATUS)
  if (!c) return false
  try {
    await c.insertOne({
      serverId,
      kind: 'agent.restart',
      ts: new Date(bootAt || Date.now()).toISOString(),
      prevBootAt: prevBootAt ? new Date(prevBootAt).toISOString() : null,
      // 被 SIGKILL 波及的平台会话（影子会话是独立进程，不受 agent 重启影响，故不计入）
      killedSessions: (activeSessions || [])
        .filter((s) => s.origin === 'platform' && ACTIVE.has(s.state))
        .map((s) => ({ sessionId: s.id, project: s.project, state: s.state, inflight: !!s.inflight })),
      schemaVersion: 1,
    })
    return true
  } catch { return false }
}

/** 记录在线/离线跳变（不记心跳——心跳在 Redis，写 Mongo 会把库撑爆） */
export async function recordOnlineChange({ serverId, online, ts }) {
  const c = await mongo.coll(STATUS)
  if (!c) return false
  try {
    await c.insertOne({
      serverId,
      kind: online ? 'agent.online' : 'agent.offline',
      ts: new Date(ts || Date.now()).toISOString(),
      schemaVersion: 1,
    })
    return true
  } catch { return false }
}

// ---------- 只读查询 ----------

export async function recentRuns({ serverId, project, status, limit = 50 } = {}) {
  const c = await mongo.coll(RUNS)
  if (!c) return null                    // null = Mongo 不可用 → 调用方标 available:false 并回退
  try {
    const q = {}
    if (serverId) q.serverId = serverId
    if (project) q.project = project
    if (status) q.status = status
    return await c.find(q).sort({ lastActiveAt: -1 }).limit(Math.min(Number(limit) || 50, 500)).toArray()
  } catch { return null }
}

export async function agentStatus({ serverId, limit = 100 } = {}) {
  const c = await mongo.coll(STATUS)
  if (!c) return null
  try {
    const q = serverId ? { serverId } : {}
    return await c.find(q).sort({ ts: -1 }).limit(Math.min(Number(limit) || 100, 500)).toArray()
  } catch { return null }
}

export async function restartIncidents({ limit = 50 } = {}) {
  const c = await mongo.coll(STATUS)
  if (!c) return null
  try {
    return await c.find({ kind: 'agent.restart' }).sort({ ts: -1 })
      .limit(Math.min(Number(limit) || 50, 200)).toArray()
  } catch { return null }
}

export async function runsSummary() {
  const c = await mongo.coll(RUNS)
  if (!c) return null
  try {
    const [total, byServer] = await Promise.all([
      c.countDocuments(),
      c.aggregate([{ $group: { _id: '$serverId', n: { $sum: 1 }, cost: { $sum: '$cost' } } }, { $sort: { n: -1 } }]).toArray(),
    ])
    return { total, byServer }
  } catch { return null }
}

/**
 * 清理重启事件簿。删除条件在 incident-filter.js（纯函数 + 单测）——**别在这里内联写条件**，
 * 写错就把真事故记录删了，而那份「被 SIGKILL 波及的会话名单」事后再也拿不到。
 * @param onlyEmpty true=只清「无会话受影响」的噪声；false=全清
 * @returns 删除条数；Mongo 不可用返回 null（调用方须区分「删了 0 条」与「没能删」）
 */
export async function purgeRestartIncidents({ onlyEmpty = true } = {}) {
  const c = await mongo.coll(STATUS)
  if (!c) return null
  try {
    const r = await c.deleteMany(restartDeleteFilter(onlyEmpty))
    return r?.deletedCount ?? 0
  } catch { return null }
}
